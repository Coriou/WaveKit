/**
 * Reverse-burst tracker cost (evidence squelch amendment A20): `EvidenceGate.push` over a
 * CTCSS-toned over (100 Hz tone plus seeded speech-shaped audio, latched on the tone so the
 * tracker is armed) with the tracker off (before) and on (after), at 25 kHz and 50 kHz s16le,
 * plus the tracker alone at 8 kHz. Work is sliced into 10 ms blocks inside 64 KiB chunks, as the
 * live wiring does. Core fraction is process CPU time (process.cpuUsage() user + system) per
 * second of audio; before and after passes are interleaved and each figure is the median of
 * seven passes after a discarded warmup. The 1, 5 and 15 minute load averages are printed
 * before and after, since a loaded host moves these numbers.
 *
 *   pnpm exec esbuild scripts/bench/reverse-burst.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/reverse-burst.mjs
 *   node output/bench/reverse-burst.mjs --seconds 30 [--json]
 */
import { loadavg } from "node:os"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { EvidenceGate } from "../../src/core/evidence-squelch/evidence-gate.js"
import { ReverseBurstTracker } from "../../src/core/evidence-squelch/reverse-burst.js"
import { WaveKitError } from "../../src/utils/errors.js"
import {
	toPcm,
	voiceLike,
} from "../../tests/unit/core/evidence-squelch/synthetic.js"

const CHUNK_BYTES = 64 * 1024
const BLOCK_MS = 10
const PASSES = 7
/** A tone latch needs 0.75 s; a 64 KiB s16le chunk at 25 kHz is 1.31 s. */
export const MIN_SECONDS = 2

export interface ReverseBenchRow {
	path: string
	stage: "before" | "after"
	rate: number
	coreFraction: number
	/** The gate was latched on the tone (tracker armed) at the end of the pass. */
	armed: boolean
}

function source(rate: number, seconds: number): Buffer {
	const voice = voiceLike({ rate, seconds, seed: 7, level: 0.3 })
	for (let i = 0; i < voice.length; i++)
		voice[i] = (voice[i] ?? 0) + 0.15 * Math.sin((2 * Math.PI * 100 * i) / rate)
	return toPcm(voice, "s16le")
}

function gatePass(
	data: Buffer,
	scratch: Buffer,
	rate: number,
	reverseBurst: boolean,
): { cpuUs: number; armed: boolean } {
	const gate = new EvidenceGate({
		rate,
		modulation: "nfm",
		gain: 2,
		reverseBurst,
	})
	const blockBytes = Math.ceil((rate * BLOCK_MS) / 1_000) * 2
	let cpuUs = 0
	for (let base = 0; base < data.length; base += CHUNK_BYTES) {
		const n = Math.min(CHUNK_BYTES, data.length - base)
		data.copy(scratch, 0, base, base + n)
		const c0 = process.cpuUsage()
		for (let s = 0; s < n; s += blockBytes) {
			gate.noteBlock(true)
			gate.push(scratch, "s16le", s, Math.min(n, s + blockBytes))
		}
		const c = process.cpuUsage(c0)
		cpuUs += c.user + c.system
	}
	return {
		cpuUs,
		armed: reverseBurst ? gate.reverseToneHz > 0 : gate.evidence === "ctcss",
	}
}

function trackerPass(seconds: number): number {
	const t = new ReverseBurstTracker()
	t.arm(100)
	const n = Math.round(8_000 * seconds)
	const w = (2 * Math.PI * 100) / 8_000
	const c0 = process.cpuUsage()
	for (let i = 0; i < n; i++) if (t.push(0.15 * Math.sin(w * i), i)) t.arm(100)
	const c = process.cpuUsage(c0)
	return c.user + c.system
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)] ?? 0
}

export function runBench(opts: { seconds: number }): ReverseBenchRow[] {
	const { seconds } = opts
	if (!Number.isFinite(seconds) || seconds < MIN_SECONDS)
		throw new WaveKitError(
			`Expected at least ${MIN_SECONDS} seconds (a tone latch and a full chunk)`,
			"INVALID_BENCH_OPTIONS",
		)
	const rows: ReverseBenchRow[] = []
	const scratch = Buffer.alloc(CHUNK_BYTES)
	for (const rate of [25_000, 50_000]) {
		const data = source(rate, seconds)
		gatePass(data, scratch, rate, false)
		gatePass(data, scratch, rate, true)
		const off: number[] = []
		const on: number[] = []
		let armedOff = true
		let armedOn = true
		for (let p = 0; p < PASSES; p++) {
			const a = gatePass(data, scratch, rate, false)
			const b = gatePass(data, scratch, rate, true)
			off.push(a.cpuUs)
			on.push(b.cpuUs)
			armedOff &&= a.armed
			armedOn &&= b.armed
		}
		rows.push({
			path: "EvidenceGate.push, A20 tracker off",
			stage: "before",
			rate,
			coreFraction: median(off) / (seconds * 1e6),
			armed: armedOff,
		})
		rows.push({
			path: "EvidenceGate.push, A20 tracker on",
			stage: "after",
			rate,
			coreFraction: median(on) / (seconds * 1e6),
			armed: armedOn,
		})
	}
	trackerPass(seconds)
	rows.push({
		path: "ReverseBurstTracker.push alone",
		stage: "after",
		rate: 8_000,
		coreFraction:
			median(Array.from({ length: PASSES }, () => trackerPass(seconds))) /
			(seconds * 1e6),
		armed: true,
	})
	return rows
}

export function formatTable(rows: ReverseBenchRow[]): string {
	const lines = [
		"| Stage | Path | Rate | CPU core fraction | Tone latched |",
		"| --- | --- | --- | --- | --- |",
	]
	for (const r of rows)
		lines.push(
			`| ${r.stage} | ${r.path} | ${r.rate / 1000} kHz | ${r.coreFraction.toFixed(6)} | ${r.armed ? "yes" : "NO"} |`,
		)
	return lines.join("\n")
}

function arg(name: string, fallback: number): number {
	const index = process.argv.indexOf(`--${name}`)
	return index < 0 ? fallback : Number(process.argv[index + 1])
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const load = (): string =>
		loadavg()
			.map(v => v.toFixed(2))
			.join(" ")
	const before = load()
	const rows = runBench({ seconds: arg("seconds", 30) })
	const after = load()
	if (process.argv.includes("--json"))
		process.stdout.write(
			`${JSON.stringify({ loadBefore: before, loadAfter: after, rows })}\n`,
		)
	else
		process.stdout.write(
			`load average before: ${before}\n${formatTable(rows)}\nload average after: ${after}\n`,
		)
}
