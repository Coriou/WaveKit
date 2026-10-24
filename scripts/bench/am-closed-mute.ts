/**
 * Evidence squelch A19 cost: the closed-AM mute (`muteZeros`: exact-zero IQ plus
 * `muteClosedPcm`) against the hold-vector squelch it replaces. Worst toggle rate: 10 ms blocks
 * alternating open and closed at 25 kHz (50 closes per second), one 4 096-byte s16le PCM chunk
 * (8.2 blocks) per step. A step is that chunk's `process` calls plus one `muteClosedPcm`; the
 * mute call is also timed alone. Backlog cases hold the PCM `lag` chunks behind the IQ (about
 * 4 spans per chunk: 244 chunks ~ 1 000 spans in flight, 300 chunks past the 1 024 cap, where
 * the two oldest spans merge). Reports p50 and p99 per step in µs (performance.now()) and the
 * host load average (os.loadavg()); informational only, nothing passes or fails.
 *
 *   pnpm exec esbuild scripts/bench/am-closed-mute.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/am-closed-mute.mjs
 *   node output/bench/am-closed-mute.mjs [--steps 4000] [--repeats 3] [--json]
 */
import os from "node:os"
import { performance } from "node:perf_hooks"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { ChannelSquelch } from "../../src/core/channel-squelch.js"

const RATE = 25_000
const BLOCK_SAMPLES = 250
const PCM_BYTES = 4_096
const BLOCKS_PER_STEP = PCM_BYTES / 2 / BLOCK_SAMPLES

export interface MuteBenchRow {
	variant: string
	lagSteps: number
	stepP50Us: number
	stepP99Us: number
	muteP50Us: number | null
	muteP99Us: number | null
	loadAverage: number[]
}

function quantile(sorted: number[], q: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

function runCase(
	variant: string,
	muteZeros: boolean,
	lagSteps: number,
	steps: number,
): MuteBenchRow {
	const squelch = new ChannelSquelch({
		sampleRate: RATE,
		thresholdDbfs: -45,
		hysteresisDb: 0,
		hangMs: 0,
		muteZeros,
	})
	const open = Buffer.alloc(BLOCK_SAMPLES * 8)
	for (let n = 0; n < BLOCK_SAMPLES; n++) open.writeFloatLE(0.5, n * 8)
	const closed = Buffer.alloc(BLOCK_SAMPLES * 8)
	const pcm = Buffer.alloc(PCM_BYTES)
	const step: number[] = []
	const mute: number[] = []
	let blocks = 0
	let pcmAt = 0
	for (let s = 0; s < steps + lagSteps; s++) {
		const t0 = performance.now()
		const target = Math.ceil((s + 1) * BLOCKS_PER_STEP)
		while (blocks < target) {
			squelch.process(blocks % 2 === 1 ? closed : open)
			blocks++
		}
		const t1 = performance.now()
		if (muteZeros && s >= lagSteps) {
			squelch.muteClosedPcm(pcm, pcmAt, 2)
			pcmAt += PCM_BYTES
		}
		const t2 = performance.now()
		if (s >= lagSteps) {
			step.push((t2 - t0) * 1000)
			mute.push((t2 - t1) * 1000)
		}
	}
	step.sort((a, b) => a - b)
	mute.sort((a, b) => a - b)
	return {
		variant,
		lagSteps,
		stepP50Us: quantile(step, 0.5),
		stepP99Us: quantile(step, 0.99),
		muteP50Us: muteZeros ? quantile(mute, 0.5) : null,
		muteP99Us: muteZeros ? quantile(mute, 0.99) : null,
		loadAverage: os.loadavg(),
	}
}

export function runMuteBench(options: {
	steps: number
	repeats: number
}): MuteBenchRow[] {
	const rows: MuteBenchRow[] = []
	for (let r = 0; r < options.repeats; r++) {
		rows.push(runCase("hold vector (no mute)", false, 0, options.steps))
		rows.push(runCase("muteZeros", true, 0, options.steps))
		rows.push(runCase("muteZeros, ~1 000 spans", true, 244, options.steps))
		rows.push(runCase("muteZeros, past the cap", true, 300, options.steps))
	}
	return rows
}

function formatTable(rows: MuteBenchRow[]): string {
	const us = (v: number | null) => (v === null ? "-" : v.toFixed(2))
	const lines = [
		"| Variant | Lag (steps) | Step p50 / p99 (µs) | muteClosedPcm p50 / p99 (µs) | Load avg (1/5/15 min) |",
		"| --- | --- | --- | --- | --- |",
	]
	for (const r of rows)
		lines.push(
			`| ${r.variant} | ${r.lagSteps} | ${us(r.stepP50Us)} / ${us(r.stepP99Us)} | ${us(r.muteP50Us)} / ${us(r.muteP99Us)} | ${r.loadAverage.map(v => v.toFixed(1)).join(" / ")} |`,
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
	const rows = runMuteBench({
		steps: arg("steps", 4_000),
		repeats: arg("repeats", 3),
	})
	if (process.argv.includes("--json"))
		process.stdout.write(`${JSON.stringify(rows)}\n`)
	else process.stdout.write(`${formatTable(rows)}\n`)
}
