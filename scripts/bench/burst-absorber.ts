/**
 * Absorber/recorder per-chunk cost over simulated CU8 arrivals (no sleeping).
 * Each 10 s has 100 ms steady input, a 600 ms source stall, then 600 ms at 2x.
 * Three fake branches block together during catch-up, then drain together.
 * Core fractions are measured hold/release time divided by stream duration.
 * loopP99AddedMs is a synchronous blocking-cost estimate above direct fanout,
 * including drain calls; it is not a live event-loop histogram or a CPU gate.
 *
 *   pnpm exec esbuild scripts/bench/burst-absorber.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/burst-absorber.mjs
 *   node output/bench/burst-absorber.mjs --rate 2048000 --seconds 30
 *   node output/bench/burst-absorber.mjs --rate 2400000 --seconds 30
 */
import { EventEmitter } from "node:events"
import { performance } from "node:perf_hooks"
import process from "node:process"
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
	loopP99AddedMs: number
	ringBytes: number
	ingestedBytes: number
	deliveredBytes: number
	overflowBytes: number
}

/** Isolated synchronous workload; only execution timings vary between calls. */
export function runBench(opts: { rate: number; seconds: number }): BenchResult {
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
	const delays: number[] = []
	const drain = () => {
		blocked = false
		const start = performance.now()
		for (const id of ids) events.emit("drain", id)
		const elapsed = performance.now() - start
		releaseMs += elapsed
		delays.push(elapsed)
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
		recorder.observeChunk(chunk.length, now)
		const record = performance.now() - start
		recorderMs += record
		start = performance.now()
		absorber.ingest(chunk)
		const elapsed = performance.now() - start
		if (blocked) holdMs += elapsed
		else passMs += elapsed
		delays.push(Math.max(0, elapsed + record - direct))
		if (!blocked) passChunks++
		ingestedBytes += chunk.length
		chunks++
	}
	now = Math.max(now, seconds * 1000) + 1
	drain()
	const counters = absorber.counters()
	absorber.dispose()
	delays.sort((a, b) => a - b)
	return {
		rate,
		passThroughNsPerChunk:
			Math.max(0, passMs / Math.max(1, passChunks) - baselineMs / chunks) * 1e6,
		recorderNsPerChunk: (recorderMs / chunks) * 1e6,
		holdCoreFraction: holdMs / (seconds * 1000),
		releaseCoreFraction: releaseMs / (seconds * 1000),
		loopP99AddedMs:
			delays[Math.max(0, Math.ceil(delays.length * 0.99) - 1)] ?? 0,
		ringBytes: counters.capacityBytes,
		ingestedBytes,
		deliveredBytes: branches[0]!,
		overflowBytes: counters.overflowBytesTotal,
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
	process.stdout.write(`${JSON.stringify(result)}\n`)
}
