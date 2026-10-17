/**
 * Zoom sustained workload benchmark (web-gaps-9 §4, lane ZM). Measures the
 * sustained cost of a genuine viewed-slice FFT over contiguous raw CU8 on top
 * of a detector proxy, fed in real-time paced 50 ms chunks.
 *
 *   node output/bench/zoom-workload.mjs --fs 2048000 --fft 8192..262144 \
 *     --rate 5,10 --slices 1,2,4 --duration 60 [--variant fft,ddc] \
 *     [--no-detector] [--smoke] [--out dir]
 *
 * Writes samples.jsonl, summary.json and meta.json, then prints a table.
 */
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import { join, resolve } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import process from "node:process"
import { pathToFileURL } from "node:url"
import {
	CHUNK_MS,
	DEADLINE_MS,
	DetectorProxy,
	ZoomSlice,
	evaluateCell,
	makeCu8Signal,
	parseArgs,
	percentile,
	sliceOffsets,
} from "./zoom-workload-core.js"
import type { BenchOptions, Variant } from "./zoom-workload-core.js"

export interface CellSpec {
	kind: "baseline" | "zoom"
	fs: number
	fft: number | null
	rate: number | null
	slices: number | null
	variant: Variant | null
}

export interface CellResult extends CellSpec {
	id: string
	durationS: number
	wallS: number
	coreFraction: number
	incrementalCore: number | null
	transforms: number
	transformMs: { p50: number; p95: number; p99: number; max: number } | null
	eventLoopP99Ms: number
	eventLoopP99IncreaseMs: number | null
	rssHighWaterBytes: number
	heapUsedHighWaterBytes: number
	rssGrowthSecondHalfBytes: number
	missedDeadlines: number
	missedChunks: number
	missedTransforms: number
	sliceSpanBins: number | null
	binHz: number | null
	supportMs: number | null
	pass: boolean | null
	reasons: string[]
}

export interface BenchSummary {
	outDir: string
	cells: CellResult[]
}

export function planCells(o: BenchOptions): CellSpec[] {
	const cells: CellSpec[] = []
	for (const fs of o.fs) {
		cells.push({
			kind: "baseline",
			fs,
			fft: null,
			rate: null,
			slices: null,
			variant: null,
		})
		for (const variant of o.variant)
			for (const fft of o.fft)
				for (const rate of o.rate)
					for (const slices of o.slices)
						cells.push({ kind: "zoom", fs, fft, rate, slices, variant })
	}
	return cells
}

function cellId(c: CellSpec): string {
	return c.kind === "baseline"
		? `baseline-fs${c.fs}`
		: `${c.variant}-fs${c.fs}-n${c.fft}-r${c.rate}-s${c.slices}`
}

const sleep = (ms: number): Promise<void> =>
	new Promise(r => setTimeout(r, Math.max(0, ms)))
const tick = (): Promise<void> => new Promise(r => setImmediate(r))

interface RunCellArgs {
	spec: CellSpec
	o: BenchOptions
	signal: Uint8Array
	baseline: CellResult | undefined
	samplesPath: string
}

async function runCell(a: RunCellArgs): Promise<CellResult> {
	const { spec, o, signal } = a
	const id = cellId(spec)
	const chunkSamples = Math.round((spec.fs * CHUNK_MS) / 1000)
	const chunkBytes = 2 * chunkSamples
	const totalChunks = Math.max(1, Math.round((o.durationS * 1000) / CHUNK_MS))
	const detector = o.detector ? new DetectorProxy() : null
	const slices: ZoomSlice[] = []
	if (spec.kind === "zoom") {
		for (const offsetHz of sliceOffsets(spec.slices!, spec.fs)) {
			slices.push(
				new ZoomSlice({
					n: spec.fft!,
					fs: spec.fs,
					offsetHz,
					spanHz: o.spanHz,
					variant: spec.variant!,
				}),
			)
		}
	}
	const rate = spec.rate ?? 0
	const transformTimes: number[] = []
	let missedChunks = 0
	let missedTransforms = 0
	let nextSlot = 0
	let rssHw = 0
	let heapHw = 0
	let rssHwFirstHalf = 0
	let sink = 0
	let readPos = 0
	const chunk = new Uint8Array(chunkBytes)

	// Unmeasured warm-up so JIT compilation does not land in the measured window.
	for (let w = 0; w < 4; w++) {
		chunk.set(signal.subarray(0, Math.min(chunkBytes, signal.length)))
		detector?.feed(chunk)
		for (const s of slices) {
			s.feed(chunk)
			sink += s.transform()[0] ?? 0
		}
	}

	const eld = monitorEventLoopDelay({ resolution: 10 })
	eld.enable()
	const cpu0 = process.cpuUsage()
	const t0 = performance.now()
	let sampleCpu = cpu0
	let sampleT = t0
	let nextSampleT = t0 + 1000

	for (let k = 0; k < totalChunks; k++) {
		const due = t0 + (k + 1) * CHUNK_MS
		const wait = due - performance.now()
		if (wait > 0) await sleep(wait)
		else await tick() // late: catch up one chunk per tick, never a burst
		const start = performance.now()
		if (start > due + DEADLINE_MS) missedChunks++
		for (let off = 0; off < chunkBytes; ) {
			const n = Math.min(chunkBytes - off, signal.length - readPos)
			chunk.set(signal.subarray(readPos, readPos + n), off)
			off += n
			readPos = (readPos + n) % signal.length
		}
		detector?.feed(chunk)
		for (const s of slices) s.feed(chunk)
		// Slot j is at j/rate s; data up to (k+1)·50 ms is available now.
		if (rate > 0) {
			const dataMs = (k + 1) * CHUNK_MS
			while ((nextSlot * 1000) / rate <= dataMs) {
				const slotT = t0 + (nextSlot * 1000) / rate
				for (const s of slices) {
					const ts = performance.now()
					const out = s.transform()
					const te = performance.now()
					sink += out[0] ?? 0
					transformTimes.push(te - ts)
					if (te > slotT + DEADLINE_MS) missedTransforms++
				}
				nextSlot++
			}
		}
		const mem = process.memoryUsage()
		if (mem.rss > rssHw) rssHw = mem.rss
		if (mem.heapUsed > heapHw) heapHw = mem.heapUsed
		if (k < totalChunks / 2) rssHwFirstHalf = rssHw
		const now = performance.now()
		if (now >= nextSampleT || k === totalChunks - 1) {
			const c = process.cpuUsage(sampleCpu)
			const line = {
				cell: id,
				tS: (now - t0) / 1000,
				coreFraction: (c.user + c.system) / 1000 / (now - sampleT),
				rss: mem.rss,
				heapUsed: mem.heapUsed,
				transforms: transformTimes.length,
				missedChunks,
				missedTransforms,
			}
			appendFileSync(a.samplesPath, `${JSON.stringify(line)}\n`)
			sampleCpu = process.cpuUsage()
			sampleT = now
			nextSampleT += 1000
		}
	}
	const wallMs = performance.now() - t0
	const cpu = process.cpuUsage(cpu0)
	eld.disable()
	const coreFraction = (cpu.user + cpu.system) / 1000 / wallMs
	const eventLoopP99Ms = eld.percentile(99) / 1e6
	if (Number.isNaN(sink)) process.stdout.write("")

	const sorted = transformTimes.slice().sort((x, y) => x - y)
	const missedDeadlines = missedChunks + missedTransforms
	const rssGrowth = Math.max(0, rssHw - rssHwFirstHalf)
	const base = a.baseline
	const incrementalCore = base ? coreFraction - base.coreFraction : null
	const eventLoopP99IncreaseMs = base
		? eventLoopP99Ms - base.eventLoopP99Ms
		: null
	const first = slices[0]
	const binFs =
		spec.kind === "zoom" && spec.variant === "ddc"
			? Math.round(spec.fs / Math.floor(spec.fs / o.spanHz))
			: spec.fs
	let pass: boolean | null = null
	let reasons: string[] = []
	if (spec.kind === "zoom") {
		const ev = evaluateCell({
			incrementalCore: incrementalCore ?? Number.NaN,
			eventLoopP99IncreaseMs: eventLoopP99IncreaseMs ?? Number.NaN,
			missedDeadlines,
			rssGrowthBytes: rssGrowth,
		})
		pass = ev.pass
		reasons = ev.reasons
	} else if (missedDeadlines > 0) {
		reasons = [`baseline missed ${missedDeadlines} deadlines`]
	}
	return {
		...spec,
		id,
		durationS: o.durationS,
		wallS: wallMs / 1000,
		coreFraction,
		incrementalCore,
		transforms: transformTimes.length,
		transformMs:
			sorted.length > 0
				? {
						p50: percentile(sorted, 50),
						p95: percentile(sorted, 95),
						p99: percentile(sorted, 99),
						max: sorted[sorted.length - 1]!,
					}
				: null,
		eventLoopP99Ms,
		eventLoopP99IncreaseMs,
		rssHighWaterBytes: rssHw,
		heapUsedHighWaterBytes: heapHw,
		rssGrowthSecondHalfBytes: rssGrowth,
		missedDeadlines,
		missedChunks,
		missedTransforms,
		sliceSpanBins: first ? first.bins.end - first.bins.start : null,
		binHz: spec.fft ? binFs / spec.fft : null,
		supportMs: spec.fft ? (spec.fft / binFs) * 1000 : null,
		pass,
		reasons,
	}
}

function gitHead(): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		})
			.toString()
			.trim()
	} catch {
		return null
	}
}

const f = (v: number | null | undefined, d: number): string =>
	v === null || v === undefined || Number.isNaN(v) ? "-" : v.toFixed(d)

export function formatTable(cells: readonly CellResult[]): string {
	const rows = [
		"| cell | core | incr | p50 ms | p99 ms | ELD p99 ms | ELD +ms | RSS MiB | missed | pass |",
		"|---|---|---|---|---|---|---|---|---|---|",
	]
	for (const c of cells) {
		rows.push(
			`| ${c.id} | ${f(c.coreFraction, 3)} | ${f(c.incrementalCore, 3)} | ${f(c.transformMs?.p50, 2)} | ${f(c.transformMs?.p99, 2)} | ${f(c.eventLoopP99Ms, 2)} | ${f(c.eventLoopP99IncreaseMs, 2)} | ${f(c.rssHighWaterBytes / 1048576, 0)} | ${c.missedDeadlines} | ${c.pass === null ? "base" : c.pass ? "yes" : "NO"} |`,
		)
	}
	return `${rows.join("\n")}\n`
}

export async function runBenchmark(
	o: BenchOptions,
	io: { write: (s: string) => void; argv?: readonly string[] } = {
		write: s => void process.stdout.write(s),
	},
): Promise<BenchSummary> {
	const outDir = resolve(
		o.out ??
			join(
				"output",
				"bench",
				`zoom-${new Date().toISOString().replace(/[:.]/g, "-")}`,
			),
	)
	mkdirSync(outDir, { recursive: true })
	const samplesPath = join(outDir, "samples.jsonl")
	writeFileSync(samplesPath, "")
	const meta = {
		node: process.version,
		cpuModel: os.cpus()[0]?.model ?? null,
		cores: os.cpus().length,
		platform: `${os.platform()} ${os.release()} ${os.arch()}`,
		loadavgStart: os.loadavg(),
		loadavgEnd: null as number[] | null,
		gitHead: gitHead(),
		argv: io.argv ?? null,
		options: o,
		startedAt: new Date().toISOString(),
		finishedAt: null as string | null,
	}
	writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2))
	const signals = new Map<number, Uint8Array>()
	const baselines = new Map<number, CellResult>()
	const cells: CellResult[] = []
	const plan = planCells(o)
	for (let i = 0; i < plan.length; i++) {
		const spec = plan[i]!
		let signal = signals.get(spec.fs)
		if (!signal) {
			signal = makeCu8Signal(o.seed, spec.fs, 1)
			signals.set(spec.fs, signal)
		}
		if (i > 0) await sleep(o.gapS * 1000)
		io.write(`cell ${i + 1}/${plan.length} ${cellId(spec)}\n`)
		const r = await runCell({
			spec,
			o,
			signal,
			baseline: baselines.get(spec.fs),
			samplesPath,
		})
		if (spec.kind === "baseline") baselines.set(spec.fs, r)
		cells.push(r)
		writeFileSync(
			join(outDir, "summary.json"),
			JSON.stringify({ cells }, null, 2),
		)
	}
	meta.loadavgEnd = os.loadavg()
	meta.finishedAt = new Date().toISOString()
	writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2))
	io.write(formatTable(cells))
	io.write(`out: ${outDir}\n`)
	return { outDir, cells }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
	const argv = process.argv.slice(2)
	let options: BenchOptions | null = null
	try {
		options = parseArgs(argv)
	} catch (err: unknown) {
		process.stderr.write(
			`zoom-workload: ${err instanceof Error ? err.message : String(err)}\n`,
		)
		process.exitCode = 2
	}
	if (options) {
		runBenchmark(options, {
			write: s => void process.stdout.write(s),
			argv,
		}).catch((err: unknown) => {
			process.stderr.write(
				`zoom-workload failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
			)
			process.exitCode = 1
		})
	}
}
