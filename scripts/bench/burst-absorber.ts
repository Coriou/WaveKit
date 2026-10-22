/**
 * Absorber/recorder cost over simulated CU8 arrivals and paced CLI arrivals.
 * Each 10 s has 100 ms steady input, a 600 ms source stall, then 600 ms at 2x.
 * Three fake branches block together during catch-up, then drain together.
 * Active core fractions use the scripted holding/catch-up wall time; Avg fields
 * use the whole stream duration. The CLI measures event-loop p99 against a paced
 * direct-fanout baseline (10 ms histogram resolution); runBench leaves it at 0.
 * Per-chunk costs are medians of five passes after a discarded warmup pass.
 *
 *   pnpm exec esbuild scripts/bench/burst-absorber.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/burst-absorber.mjs
 *   node output/bench/burst-absorber.mjs --rate 2048000 --seconds 30
 *   node output/bench/burst-absorber.mjs --rate 2400000 --seconds 30
 */
import { EventEmitter } from "node:events"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import pino from "pino"
import { createBurstAbsorber } from "../../src/core/link-burst/absorber.js"
import type { AbsorberFanoutPort } from "../../src/core/link-burst/contract.js"
import { createIngestRecorder } from "../../src/core/link-burst/recorder.js"
import { WaveKitError } from "../../src/utils/errors.js"

export interface BenchResult {
	rate: number
	passThroughNsPerChunk: number
	recorderNsPerChunk: number
	holdCoreFraction: number
	releaseCoreFraction: number
	holdCoreFractionAvg: number
	releaseCoreFractionAvg: number
	holdPeriodMs: number
	catchupPeriodMs: number
	maxDrainMs: number
	loopP99AddedMs: number
	ringBytes: number
	ingestedBytes: number
	deliveredBytes: number
	overflowBytes: number
}

type BenchOptions = { rate: number; seconds: number }

/** Each yield precedes an arrival, letting the CLI pace the same workload. */
function* pass(
	opts: BenchOptions,
	directOnly = false,
): Generator<number, BenchResult, void> {
	const { rate, seconds } = opts
	if (
		!Number.isSafeInteger(rate) ||
		rate <= 0 ||
		!Number.isFinite(seconds) ||
		seconds <= 0
	)
		throw new WaveKitError(
			"Expected a positive integer rate and positive seconds",
			"INVALID_BENCH_OPTIONS",
		)
	const buffers = [4096, 16384, 65536].map(size => Buffer.alloc(size))
	const branches = [0, 0, 0]
	const ids = ["0", "1", "2"]
	const events = new EventEmitter()
	let blocked = false
	let now = 0
	const fanout: AbsorberFanoutPort = {
		distribute(chunk) {
			for (let i = 0; i < branches.length; i++)
				branches[i] = branches[i]! + chunk.length
		},
		activeBranchIds(out) {
			out.clear()
			for (const id of ids) out.add(id)
		},
		congestedBranchIds(out) {
			out.clear()
			if (blocked) for (const id of ids) out.add(id)
		},
		on: (event, fn) => {
			events.on(event, fn)
		},
		off: (event, fn) => {
			events.off(event, fn)
		},
	}
	const recorder = createIngestRecorder()
	recorder.configure(rate, 2)
	const absorber = createBurstAbsorber({
		fanout,
		recorder,
		monoNow: () => now,
		frameBytes: 2,
		log: pino({ enabled: false }),
	})
	absorber.configure(2 * rate * 2)
	const target = Math.floor(rate * seconds) * 2
	let ingestedBytes = 0
	let chunks = 0
	let passMs = 0
	let passChunks = 0
	let recorderMs = 0
	let holdMs = 0
	let releaseMs = 0
	let baselineMs = 0
	let maxDrainMs = 0
	let activePeriodMs = 0
	for (let cycle = 0; cycle < seconds * 1000; cycle += 10000)
		activePeriodMs +=
			Math.max(0, Math.min(1200, seconds * 1000 - cycle - 100)) / 2
	const drain = () => {
		blocked = false
		const start = performance.now()
		for (const id of ids) {
			const start = performance.now()
			if (!directOnly) events.emit("drain", id)
			maxDrainMs = Math.max(maxDrainMs, performance.now() - start)
		}
		const elapsed = performance.now() - start
		releaseMs += elapsed
	}
	while (ingestedBytes < target) {
		const buffer = buffers[chunks % buffers.length]!
		const chunk = buffer.subarray(
			0,
			Math.min(buffer.length, target - ingestedBytes),
		)
		const productionMs = (ingestedBytes / (rate * 2)) * 1000
		const cycle = Math.floor(productionMs / 10000) * 10000
		const phase = productionMs - cycle
		now =
			cycle + (phase < 100 || phase >= 1300 ? phase : 700 + (phase - 100) / 2)
		yield now
		if (blocked && phase >= 1300) drain()
		blocked = phase >= 100 && phase < 1300
		// Direct fanout baseline uses the same buffers and three branch writes.
		let start = performance.now()
		fanout.distribute(chunk)
		const direct = performance.now() - start
		baselineMs += direct
		for (let i = 0; i < branches.length; i++)
			branches[i] = branches[i]! - chunk.length
		start = performance.now()
		if (!directOnly) recorder.observeChunk(chunk.length, now)
		const record = performance.now() - start
		recorderMs += record
		start = performance.now()
		if (directOnly) fanout.distribute(chunk)
		else absorber.ingest(chunk)
		const elapsed = performance.now() - start
		if (blocked) holdMs += elapsed
		else passMs += elapsed
		if (!blocked) passChunks++
		ingestedBytes += chunk.length
		chunks++
	}
	now = Math.max(now, seconds * 1000)
	yield now
	drain()
	const counters = absorber.counters()
	absorber.dispose()
	return {
		rate,
		passThroughNsPerChunk:
			Math.max(0, passMs / Math.max(1, passChunks) - baselineMs / chunks) * 1e6,
		recorderNsPerChunk: (recorderMs / chunks) * 1e6,
		holdCoreFraction: activePeriodMs > 0 ? holdMs / activePeriodMs : 0,
		releaseCoreFraction: activePeriodMs > 0 ? releaseMs / activePeriodMs : 0,
		holdCoreFractionAvg: holdMs / (seconds * 1000),
		releaseCoreFractionAvg: releaseMs / (seconds * 1000),
		holdPeriodMs: activePeriodMs,
		catchupPeriodMs: activePeriodMs,
		maxDrainMs,
		loopP99AddedMs: 0,
		ringBytes: counters.capacityBytes,
		ingestedBytes,
		deliveredBytes: branches[0]!,
		overflowBytes: counters.overflowBytesTotal,
	}
}

/** Isolated synchronous workload; no timers or event-loop histogram. */
export function runBench(opts: BenchOptions): BenchResult {
	const run = () => {
		const workload = pass(opts)
		let step = workload.next()
		while (!step.done) step = workload.next()
		return step.value
	}
	run() // Discard JIT/allocation warmup.
	const results = Array.from({ length: 5 }, run)
	const median = (key: "passThroughNsPerChunk" | "recorderNsPerChunk") =>
		results.map(result => result[key]).sort((a, b) => a - b)[2]!
	return {
		...results[2]!,
		passThroughNsPerChunk: median("passThroughNsPerChunk"),
		recorderNsPerChunk: median("recorderNsPerChunk"),
		maxDrainMs: Math.max(...results.map(result => result.maxDrainMs)),
	}
}

async function loopPhase(opts: BenchOptions, directOnly: boolean) {
	const workload = pass(opts, directOnly)
	// Allocate and configure before sampling, identically for both phases.
	let step = workload.next()
	const histogram = monitorEventLoopDelay({ resolution: 10 })
	histogram.enable()
	await sleep(20)
	histogram.reset()
	const start = performance.now()
	try {
		while (!step.done) {
			const deadline = start + step.value
			while (performance.now() < deadline)
				await sleep(Math.max(1, deadline - performance.now()))
			step = workload.next()
		}
		// Let the histogram observe the final synchronous drain too.
		await sleep(20)
		return { p99Ms: histogram.percentile(99) / 1e6, result: step.value }
	} finally {
		histogram.disable()
		workload.return(undefined as never)
	}
}

const arg = (name: string, fallback: number): number => {
	const index = process.argv.indexOf(`--${name}`)
	return index < 0 ? fallback : Number(process.argv[index + 1])
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const {
		ingestedBytes: _ingested,
		deliveredBytes: _delivered,
		overflowBytes: _overflow,
		...result
	} = runBench({ rate: arg("rate", 2_048_000), seconds: arg("seconds", 30) })
	const opts = { rate: result.rate, seconds: arg("seconds", 30) }
	const baseline = await loopPhase(opts, true)
	const workload = await loopPhase(opts, false)
	result.loopP99AddedMs = Math.max(0, workload.p99Ms - baseline.p99Ms)
	result.maxDrainMs = Math.max(result.maxDrainMs, workload.result.maxDrainMs)
	process.stdout.write(`${JSON.stringify(result)}\n`)
}
