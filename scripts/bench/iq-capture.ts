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
 * 3. `--drain` skips the tap (no native binary, no receiver) and times the WG12 design ceilings
 *    with fake decoders: unknown digital (one analog trial plus seven probes) and known-first.
 *
 *   pnpm exec esbuild scripts/bench/iq-capture.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=output/bench/iq-capture.mjs
 *   node output/bench/iq-capture.mjs [--seconds 10] [--drain]
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
	IqReplayTrial,
} from "../../src/core/scanner/iq-capture-contract.js"
import type { AnalogTrialResult } from "../../src/core/scanner/scanner-redesign-contract.js"
import type { ScannerProtocol } from "../../src/core/scanner/types.js"

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

/**
 * Design ceilings (replay pipeline): analog 200 ms, one probe 1500 ms (replay ≤ 1 s plus
 * start ≈ 0.5 s). Unknown digital is one analog trial plus seven probes
 * (200 + 7×1500 = 10 700 ms ⇒ 5.6 captures/min). Known-first is one 1500 ms decode
 * (≈ 40/min; the plan records ≈ 37).
 */
const DRAIN_ANALOG_MS = 200
const DRAIN_PROBE_MS = 1500
const DRAIN_KNOWN_MS = 1500
const WORST_DIGITAL: readonly ScannerProtocol[] = [
	"dmr",
	"p25p1",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
]

function later<T>(ms: number, value: T): Promise<T> {
	return new Promise(resolve => {
		setTimeout(() => resolve(value), ms)
	})
}

function probeTrial(protocol: ScannerProtocol, known: boolean): IqReplayTrial {
	return {
		protocol,
		known,
		mode: {
			decoderType: protocol === "pocsag" ? "multimon-ng" : "dsd-fme",
			protocol,
			covers: [protocol],
			options: { mode: protocol },
			holdMs: 1000,
		},
	}
}

function analogNfmTrial(): IqReplayTrial {
	return {
		protocol: "analog-fm",
		known: false,
		kind: "analog",
		analogMode: "nfm",
		mode: {
			decoderType: "dsd-fme",
			protocol: "analog-fm",
			covers: ["analog-fm"],
			options: { analogTrial: "nfm" },
			holdMs: 0,
		},
	}
}

function analogDataLike(mode: AnalogTrialResult["mode"]): AnalogTrialResult {
	return {
		outcome: "data-like",
		mode,
		voice: false,
		tones: { ctcssHz: null, dcs: null, audioSeconds: DRAIN_ANALOG_MS / 1000 },
		stats: null,
	}
}

/** Captures per minute for one scripted plan. Throws when the stop rule did not hold. */
async function drainPlanned(opts: {
	count: number
	trials: readonly IqReplayTrial[]
	analogMs: number
	probeMs: number
	knownFirst: boolean
}): Promise<number> {
	const port = new BenchPort()
	const seen = new Set<string>()
	let probes = 0
	let analogRuns = 0
	const q = createIqReplayQueue({
		port,
		probes: {
			request: req => {
				probes++
				const first = !seen.has(req.captureId)
				seen.add(req.captureId)
				const decode = opts.knownFirst && first
				return {
					run: {
						result: later(
							opts.probeMs,
							decode
								? {
										outcome: "decoded" as const,
										decoded: {
											protocol: "dmr" as const,
											identity: { kind: "dmr-cc" as const, value: "1" },
										},
									}
								: { outcome: "no-sync" as const, decoded: null },
						),
						cancel: () => {},
					},
				}
			},
			onSlotRelease: () => () => {},
		},
		planner: () => opts.trials,
		sink: () => {},
		planInput: capture => ({
			capture,
			track: null,
			knownProtocol: null,
			priors: {},
			narrowRaster: false,
		}),
		logger,
		analog: {
			run: (_id, mode) => {
				analogRuns++
				return later(opts.analogMs, analogDataLike(mode))
			},
		},
	})
	q.start()
	const t0 = performance.now()
	for (let i = 0; i < opts.count; i++) port.add(i)
	await q.idle()
	const seconds = (performance.now() - t0) / 1000
	await q.stop()
	const expectedProbes = opts.knownFirst ? opts.count : opts.count * 7
	const expectedAnalog = opts.knownFirst ? 0 : opts.count
	if (probes !== expectedProbes || analogRuns !== expectedAnalog)
		throw new Error(
			`drain stop rule: probes ${probes} (expected ${expectedProbes}), analog ${analogRuns} (expected ${expectedAnalog})`,
		)
	return (opts.count / seconds) * 60
}

async function designDrain(): Promise<void> {
	const worst = await drainPlanned({
		count: 2,
		trials: [analogNfmTrial(), ...WORST_DIGITAL.map(p => probeTrial(p, false))],
		analogMs: DRAIN_ANALOG_MS,
		probeMs: DRAIN_PROBE_MS,
		knownFirst: false,
	})
	const known = await drainPlanned({
		count: 4,
		trials: [
			probeTrial("dmr", true),
			analogNfmTrial(),
			...WORST_DIGITAL.filter(p => p !== "dmr").map(p => probeTrial(p, false)),
		],
		analogMs: DRAIN_ANALOG_MS,
		probeMs: DRAIN_KNOWN_MS,
		knownFirst: true,
	})
	console.log(
		"replay drain (design timings, fake decoders, no tap, no receiver):",
	)
	console.log(
		`  worst case (analog ${DRAIN_ANALOG_MS} ms + 7 probes × ${DRAIN_PROBE_MS} ms, unknown digital): ${worst.toFixed(2)} captures/min (floor 5.6)`,
	)
	console.log(
		`  known-first (decode at ${DRAIN_KNOWN_MS} ms, later trials not run): ${known.toFixed(2)} captures/min (about 37)`,
	)
	console.log(
		`load average ${os
			.loadavg()
			.map(v => v.toFixed(2))
			.join(
				" ",
			)}, ${os.cpus().length} cpus, uptime ${Math.round(os.uptime())}s`,
	)
}

async function main(): Promise<void> {
	if (process.argv.includes("--drain")) {
		await designDrain()
		return
	}
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
			.join(
				" ",
			)}, ${os.cpus().length} cpus, uptime ${Math.round(os.uptime())}s`,
	)
}

void main().catch((err: unknown) => {
	process.exitCode = 1
	console.error(err)
})
