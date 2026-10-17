/**
 * WG11 lane IQ bench (measure only, not CI): main-thread cost of the capture tap feed and the
 * replay queue drain rate.
 *
 * 1. Event-loop delay p99 (perf_hooks.monitorEventLoopDelay) while a fake engine emits CU8 at
 *    2.048 Msps in 16 384-sample chunks, without and with the capture bridge feeding the real
 *    `wavekit-iqcap run` (native/wavekit-chan/target/release) or, when absent, an in-process
 *    draining consumer. Also reports dropped bytes (counted gaps) and process RSS.
 * 2. Replay queue drain rate with fake decoders: zero-latency probes (queue overhead) and 8
 *    trials of a simulated 50 ms each.
 *
 *   pnpm exec esbuild scripts/bench/iq-capture.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=output/bench/iq-capture.mjs
 *   node output/bench/iq-capture.mjs [--seconds 10]
 */
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import process from "node:process"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import pino from "pino"
import {
	IqToolProcess,
	realTimers,
	type SpawnFn,
} from "../../src/core/iq-capture/process.js"
import {
	createIqReplayQueue,
	type IqReplayProbeAnswer,
	type IqReplayQueuePort,
} from "../../src/core/iq-capture/replay-queue.js"
import type {
	IqCaptureDiscardReason,
	IqCaptureView,
} from "../../src/core/scanner/iq-capture-contract.js"

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v > 0 ? v : fallback
}
const SECONDS = arg("seconds", 10)
const FS = 2_048_000
const CHUNK = 16_384
const BINARY = fileURLToPath(
	new URL(
		"../../native/wavekit-chan/target/release/wavekit-iqcap",
		import.meta.url,
	),
)
const logger = pino({ level: "silent" })

/** Emits CU8 chunks at the real-time rate; calls `sink` with each. */
function runEngine(
	seconds: number,
	sink: ((start: number, bytes: Uint8Array) => void) | null,
): Promise<{ p50: number; p99: number; max: number }> {
	const h = monitorEventLoopDelay({ resolution: 1 })
	h.enable()
	const chunkMs = (CHUNK / FS) * 1000
	let sample = 0
	const t0 = performance.now()
	return new Promise(resolve => {
		const tick = () => {
			const due = Math.floor(((performance.now() - t0) / 1000) * FS)
			while (sample + CHUNK <= due) {
				// A fresh buffer per chunk, like socket reads.
				const b = new Uint8Array(CHUNK * 2)
				sink?.(sample, b)
				sample += CHUNK
			}
			if (performance.now() - t0 < seconds * 1000) setTimeout(tick, chunkMs / 2)
			else {
				h.disable()
				resolve({
					p50: h.percentile(50) / 1e6,
					p99: h.percentile(99) / 1e6,
					max: h.max / 1e6,
				})
			}
		}
		tick()
	})
}

async function tapFeed(): Promise<void> {
	const real = fs.existsSync(BINARY)
	const dir = fs.realpathSync(
		await fsp.mkdtemp(path.join(os.tmpdir(), "iqcap-bench-")),
	)
	await fsp.chmod(dir, 0o700)
	let spawnFn: SpawnFn | undefined
	if (!real) {
		// In-process consumer: drains stdin, answers ready.
		spawnFn = (() => {
			const stdin = new PassThrough()
			stdin.resume()
			const stdout = new PassThrough()
			const control = new PassThrough()
			control.resume()
			const child = Object.assign(new EventEmitter(), {
				stdin,
				stdout,
				stderr: new PassThrough(),
				stdio: [stdin, stdout, null, control],
				pid: undefined,
			})
			control.on("finish", () => child.emit("close", 0, null))
			queueMicrotask(() => stdout.write('{"type":"ready"}\n'))
			return child
		}) as unknown as SpawnFn
	}
	const { spawn } = await import("node:child_process")
	const proc = new IqToolProcess({
		binaryPath: BINARY,
		sampleRateHz: FS,
		ringMs: 2000,
		outDir: dir,
		anchor: dir,
		maxMs: 4000,
		bandwidthHz: 12_500,
		spawn: spawnFn ?? (spawn as SpawnFn),
		env: process.env,
		timers: realTimers,
	})
	proc.start()
	await new Promise<void>(resolve => {
		if (proc.ready) resolve()
		else proc.once("ready", () => resolve())
	})
	const without = await runEngine(SECONDS, null)
	const rssBefore = process.memoryUsage().rss
	const withFeed = await runEngine(SECONDS, (s, b) => proc.feed(s, b))
	const rssAfter = process.memoryUsage().rss
	console.log(
		`tap feed (${real ? "real wavekit-iqcap" : "in-process consumer"}, ${SECONDS} s at 2.048 Msps):`,
	)
	console.log(
		`  event-loop delay without feed: p50 ${without.p50.toFixed(2)} ms, p99 ${without.p99.toFixed(2)} ms, max ${without.max.toFixed(2)} ms`,
	)
	console.log(
		`  event-loop delay with feed:    p50 ${withFeed.p50.toFixed(2)} ms, p99 ${withFeed.p99.toFixed(2)} ms, max ${withFeed.max.toFixed(2)} ms`,
	)
	console.log(
		`  dropped bytes ${proc.counters.droppedBytes}, gap commands ${proc.counters.gapCommands}, rss ${(rssBefore / 1e6).toFixed(1)} → ${(rssAfter / 1e6).toFixed(1)} MB`,
	)
	await proc.stop()
	await fsp.rm(dir, { recursive: true, force: true })
}

class BenchPort implements IqReplayQueuePort {
	private readonly held = new Map<string, string | null>()
	private readonly views = new Map<string, IqCaptureView>()
	private listener: ((v: IqCaptureView) => void) | null = null
	discarded = 0
	add(n: number): void {
		const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
		const v: IqCaptureView = {
			captureId: id,
			sourceId: "s",
			observationId: null,
			epoch: 1,
			rfHz: 1e8,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 4000,
			gapSamples: 0,
		}
		this.views.set(id, v)
		this.held.set(id, null)
		this.listener?.(v)
	}
	onFinished(l: (v: IqCaptureView) => void) {
		this.listener = l
		return () => {
			this.listener = null
		}
	}
	view(id: string) {
		return this.views.get(id) ?? null
	}
	holderOf(id: string) {
		return this.held.has(id) ? (this.held.get(id) ?? null) : undefined
	}
	claim(id: string, h: string) {
		if (this.held.get(id) !== null) return false
		this.held.set(id, h)
		return true
	}
	settle(id: string) {
		this.views.delete(id)
		this.held.delete(id)
		this.discarded++
	}
	discard(id: string, _r: IqCaptureDiscardReason) {
		this.settle(id)
		return true
	}
}

async function drain(count: number, trialMs: number): Promise<number> {
	const port = new BenchPort()
	const q = createIqReplayQueue({
		port,
		probes: {
			request: () => ({
				run: {
					result: new Promise<IqReplayProbeAnswer>(resolve => {
						const done = () => resolve({ outcome: "no-sync", decoded: null })
						if (trialMs === 0) queueMicrotask(done)
						else setTimeout(done, trialMs)
					}),
					cancel: () => {},
				},
			}),
			onSlotRelease: () => () => {},
		},
		planner: () =>
			Array.from({ length: 8 }, (_, i) => ({
				protocol: "dmr" as const,
				mode: {
					decoderType: "dsd-fme" as const,
					protocol: "dmr" as const,
					covers: ["dmr" as const],
					options: {},
					holdMs: 1000,
				},
				known: i === 0,
			})),
		sink: () => {},
		planInput: capture => ({
			capture,
			track: null,
			knownProtocol: null,
			priors: {},
			narrowRaster: false,
		}),
		logger,
	})
	q.start()
	const t0 = performance.now()
	for (let i = 0; i < count; i++) port.add(i)
	await q.idle()
	const s = (performance.now() - t0) / 1000
	await q.stop()
	return count / s
}

async function main(): Promise<void> {
	await tapFeed()
	const fast = await drain(5000, 0)
	const slow = await drain(10, 50)
	console.log("replay queue drain (8 trials per capture, no decode):")
	console.log(
		`  zero-latency fake probes: ${fast.toFixed(0)} captures/s (queue overhead)`,
	)
	console.log(
		`  50 ms fake probes: ${slow.toFixed(2)} captures/s (ideal ${(1000 / (8 * 50)).toFixed(2)})`,
	)
	console.log(
		`load average ${os
			.loadavg()
			.map(v => v.toFixed(2))
			.join(" ")}, ${os.cpus().length} cpus`,
	)
}

void main().catch((err: unknown) => {
	process.exitCode = 1
	console.error(err)
})
