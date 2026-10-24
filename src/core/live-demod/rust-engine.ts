import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection, type Socket } from "node:net"
import type { Readable, Writable } from "node:stream"
import { buildChannelizerArgs } from "../channelizer/channelizer-process.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { signalDecoder } from "../../decoders/process-tools.js"
import { childAccessEnvironment } from "../../access/runtime-hygiene.js"
import {
	systemSilenceClock,
	type SilenceFillClock,
} from "../live-audio-silence.js"
import type { Logger } from "../../utils/logger.js"
import type { LiveDemodConfig, SourceCaps } from "../../config.js"
import type { DemodRetune, DemodSquelch, LiveDemodEngine } from "./engine.js"
import {
	DEMOD_PROTOCOL,
	RUST_AUDIO_RATE_HZ,
	type EngineFallbackReason,
	type EngineProbe,
	selectEngine,
} from "./select-engine.js"
import {
	DEMOD_CHANNEL_ID,
	createDemodEventPump,
	encodeOpen,
	encodeRetune,
	encodeShutdown,
	encodeSquelch,
	parseProtocolLine,
	type DemodEvent,
	type OpenedDemodEvent,
	type QuietingDb,
} from "./rust-protocol.js"

const CONTROL_FD = 3
/** Native measures 10 ms blocks of output audio (480 samples at 48 kHz). */
const METRIC_BLOCK_SAMPLES = RUST_AUDIO_RATE_HZ / 100
/** Pre-open metrics merged into one startup batch, at most (60 s). */
const PRE_OPEN_METRIC_BLOCKS = 6000
/** A gate held for a metrics batch that never comes is released after this. */
const GATE_HOLD_MAX_MS = 250
const USABLE_FRACTION = 0.8
const BLOCK_SAMPLES = 1024
const VERSION_LIMIT_BYTES = 4096
const DEFAULT_PROBE_MS = 2000
const DEFAULT_OPEN_MS = 2000
const DEFAULT_STOP_KILL_MS = 2000
/**
 * Handshake events queued before their waiter (`ready`, `opened`, `rejected`,
 * `retuned`). A legitimate handshake is one or two lines; the cap stops a
 * flood from growing the queue. After the channel is open the queue is
 * discarded and later handshake events are not retained. `retuned` is
 * delivered to the handler instead.
 */
export const HANDSHAKE_EARLY_MAX = 8

export interface RustEngineOptions {
	binaryPath: string
	logger: Logger
	clock?: SilenceFillClock
	spawnProcess?: typeof spawn
	probeTimeoutMs?: number
	openTimeoutMs?: number
	stopKillMs?: number
}

export interface RustEngineHandlers {
	onAudio: (chunk: Buffer) => void
	onGate: (open: boolean) => void
	onMetrics: (
		powerDbfs: Array<number | null>,
		quietingDb: ReadonlyArray<QuietingDb>,
	) => void
	onDown: (reason: string) => void
	/** First output sample of an applied retune (`retuned.atOutputSample`). */
	onRetuned?: (atOutputSample: number) => void
	/** Control line the process refused (`rejected.reasonCode`). */
	onRejected?: (reasonCode: string) => void
}

export interface RustEngineStart {
	config: LiveDemodConfig
	caps: SourceCaps
	input: Readable
	/** Squelch carried by `open`. The caller owns later threshold updates. */
	squelch: DemodSquelch
	handlers: RustEngineHandlers
}

export type RustStartResult =
	| { ok: true; format: "s16le" | "f32le"; rate: number }
	| { ok: false; fallback: EngineFallbackReason; error?: unknown }
	| { ok: false; crashed: true }

interface ProbeOutcome extends EngineProbe {
	error?: unknown
}

/**
 * One `wavekit-chan` process for a live demodulator: cu8 on stdin, control on
 * fd 3, events on stdout, audio on the channel socket. Spawned detached so
 * `stop` can signal the whole group.
 */
export class RustEngine implements LiveDemodEngine {
	private readonly binaryPath: string
	private readonly log: Logger
	private readonly clock: SilenceFillClock
	private readonly spawnProcess: typeof spawn
	private readonly probeTimeoutMs: number
	private readonly openTimeoutMs: number
	private readonly stopKillMs: number
	private child: ChildProcess | null = null
	private control: Writable | null = null
	private audio: Socket | null = null
	private input: Readable | null = null
	private socketDir: string | null = null
	private handlers: RustEngineHandlers | null = null
	private opened = false
	private stopping = false
	private exited = false
	private down = false
	private dropCount = 0
	private probeChild: ChildProcess | null = null
	private pendingMatch: ((event: DemodEvent) => void) | undefined
	/** Handshake events that arrived before their waiter was installed. */
	private early: DemodEvent[] = []
	// WG10 req 3.8.1: gate and metrics in output-sample order.
	private nextMetricAt = 0
	private metricsSeen = false
	private heldGates: Array<{ open: boolean; at: number }> = []
	private gateHoldTimer: unknown = null
	private preOpenGates: Array<{ open: boolean; at: number }> = []
	private preOpenPower: Array<number | null> = []
	private preOpenQuiet: QuietingDb[] = []
	private preOpenAt: number | null = null
	/** Async spawn failure (ENOENT / EACCES / no pid). Not an unexpected crash. */
	private spawnFailure: unknown = undefined
	/** Child exited on its own before start finished. */
	private unexpectedExit = false
	/** `input_center` passed to native at spawn. Null before the channel spawn. */
	private capturedInputCenterHz: number | null = null

	constructor(options: RustEngineOptions) {
		this.binaryPath = options.binaryPath
		this.log = options.logger
		this.clock = options.clock ?? systemSilenceClock
		this.spawnProcess = options.spawnProcess ?? spawn
		this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_MS
		this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_MS
		this.stopKillMs = options.stopKillMs ?? DEFAULT_STOP_KILL_MS
	}

	get droppedEvents(): number {
		return this.dropCount
	}

	/** Demod process, once the channel spawn has returned it. */
	get childProcess(): ChildProcess | null {
		return this.child
	}

	/**
	 * Centre native was started with (`--input-center`). Retune `centerHz`
	 * stays in this frame: native mixes `centerHz - input_center` and never
	 * updates `input_center`.
	 */
	get inputCenterHz(): number | null {
		return this.capturedInputCenterHz
	}

	/** Handshake events waiting for a matcher. Zero once the channel is open. */
	get bufferedHandshake(): number {
		return this.early.length
	}

	status(): { engine: "rust"; engineFallback?: EngineFallbackReason } {
		return { engine: "rust" }
	}

	async start(input: RustEngineStart): Promise<RustStartResult> {
		this.handlers = input.handlers
		this.stopping = false
		this.down = false
		this.opened = false
		this.exited = false
		this.dropCount = 0
		this.early = []
		this.resetSampleOrder()
		this.pendingMatch = undefined
		this.spawnFailure = undefined
		this.unexpectedExit = false
		this.capturedInputCenterHz = null
		const selectionConfig = {
			engine: "rust" as const,
			modulation: input.config.modulation,
			bandwidth: input.config.bandwidth,
		}
		// Cheap checks before the version spawn: format, modulation, bandwidth.
		const blocked = selectEngine({
			config: selectionConfig,
			caps: { format: input.caps.format },
			probe: { available: true, protocol: DEMOD_PROTOCOL },
		})
		if (blocked.engine !== "rust") {
			return {
				ok: false,
				fallback: blocked.fallback ?? "open-rejected",
			}
		}
		const probe = await this.probe()
		if (this.stopping) return { ok: false, crashed: true }
		const selected = selectEngine({
			config: selectionConfig,
			caps: { format: input.caps.format },
			probe,
		})
		if (selected.engine !== "rust") {
			return {
				ok: false,
				fallback: selected.fallback ?? "binary-unavailable",
				...(probe.error !== undefined ? { error: probe.error } : {}),
			}
		}
		return this.spawnChannel(input)
	}

	applyRetune(update: DemodRetune): void {
		if (!this.opened || this.stopping) return
		if (
			update.centerHz === undefined &&
			update.bandwidthHz === undefined &&
			update.modulation === undefined &&
			update.audio === undefined
		)
			return
		this.send(encodeRetune(update))
	}

	applySquelch(update: DemodSquelch): void {
		if (!this.opened || this.stopping) return
		this.send(encodeSquelch(update))
	}

	async stop(): Promise<void> {
		this.clearGateHold()
		if (this.stopping && this.exited) {
			this.audio?.destroy()
			this.audio = null
			return
		}
		this.stopping = true
		this.killProbe()
		const child = this.child
		this.detachInput()
		this.audio?.destroy()
		this.audio = null
		if (child && !this.exited) {
			this.send(encodeShutdown())
			const gone = await this.waitExit(child, this.stopKillMs)
			if (!gone) {
				this.log.debug(
					{ pid: child.pid },
					"Live demodulation Rust engine ignored shutdown, sending SIGKILL",
				)
				this.killGroup(child, "SIGKILL")
				await this.waitExit(child, this.stopKillMs)
			}
		}
		this.control?.destroy()
		this.control = null
		await this.removeSocketDir()
	}

	private async probe(): Promise<ProbeOutcome> {
		return await new Promise(resolve => {
			let settled = false
			let output = ""
			let spawnError: unknown
			let timer: unknown
			const finish = (outcome: ProbeOutcome) => {
				if (settled) return
				settled = true
				this.clock.clearTimer(timer)
				resolve(outcome)
			}
			let child: ChildProcess
			try {
				child = this.spawnProcess(this.binaryPath, ["--version"], {
					env: childAccessEnvironment(process.env),
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "ignore"],
				})
			} catch (error: unknown) {
				finish({ available: false, protocol: null, error })
				return
			}
			this.probeChild = child
			timer = this.clock.setTimer(() => {
				this.killGroup(child, "SIGKILL")
				finish({ available: false, protocol: null, error: spawnError })
			}, this.probeTimeoutMs)
			child.stdout?.on("data", (chunk: Buffer) => {
				if (output.length >= VERSION_LIMIT_BYTES) return
				output += chunk.toString("utf8", 0, VERSION_LIMIT_BYTES - output.length)
			})
			child.stdout?.on("error", () => undefined)
			child.once("error", (error: Error) => {
				spawnError = error
				this.exitedProbe(child)
				finish({ available: false, protocol: null, error })
			})
			child.once("close", () => {
				this.exitedProbe(child)
				if (spawnError !== undefined) {
					finish({ available: false, protocol: null, error: spawnError })
					return
				}
				finish({ available: true, protocol: parseProtocolLine(output) })
			})
		})
	}

	private exitedProbe(child: ChildProcess): void {
		if (this.probeChild === child) this.probeChild = null
	}

	private killProbe(): void {
		const child = this.probeChild
		this.probeChild = null
		if (child && child.exitCode === null && child.signalCode === null)
			this.killGroup(child, "SIGKILL")
	}

	private async spawnChannel(input: RustEngineStart): Promise<RustStartResult> {
		let socketDir: string
		try {
			// Short prefix: macOS rejects unix socket paths longer than 104 bytes.
			const root = process.platform === "win32" ? tmpdir() : "/tmp"
			socketDir = await mkdtemp(join(root, "wkdm-"))
		} catch (error: unknown) {
			return { ok: false, fallback: "binary-unavailable", error }
		}
		this.socketDir = socketDir
		if (this.stopping) {
			await this.removeSocketDir()
			return { ok: false, crashed: true }
		}
		const center = input.caps.centerFreq ?? 0
		this.capturedInputCenterHz = center
		const args = buildChannelizerArgs({
			binaryPath: this.binaryPath,
			generation: 1,
			inputRateHz: input.caps.sampleRate,
			inputCenterHz: center,
			usableFraction: USABLE_FRACTION,
			blockSamples: BLOCK_SAMPLES,
			socketDir,
		})
		let child: ChildProcess
		try {
			child = this.spawnProcess(this.binaryPath, args, {
				env: childAccessEnvironment(process.env),
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe", "pipe"],
			})
		} catch (error: unknown) {
			await this.removeSocketDir()
			return { ok: false, fallback: "binary-unavailable", error }
		}
		this.child = child
		this.control = writableFd(child, CONTROL_FD)
		this.watchChild(child)
		this.input = input.input
		if (child.stdin) {
			child.stdin.on("error", (error: Error) => {
				this.log.debug(
					{ err: safeErrorFields(error) },
					"Live demodulation Rust engine input error",
				)
			})
			input.input.pipe(child.stdin)
		}
		child.stderr?.on("error", () => undefined)
		child.stderr?.resume()
		const pump = createDemodEventPump(
			event => {
				this.dispatch(event)
			},
			() => {
				this.dropCount += 1
			},
		)
		child.stdout?.on("data", (chunk: Buffer) => pump(chunk))
		child.stdout?.on("error", () => undefined)
		this.control?.on("error", () => undefined)

		const ready = await this.waitEvent(child, this.openTimeoutMs, event =>
			event.type === "ready" ? event : undefined,
		)
		if (ready === undefined) {
			// Classify before stop(): cleanup kills the child, and that death
			// is not an unexpected crash. An async ENOENT is binary-unavailable.
			const failure = this.startupFailure(child)
			await this.stop()
			return failure
		}
		if (this.stopping) {
			await this.stop()
			return { ok: false, crashed: true }
		}
		this.send(
			encodeOpen({
				config: input.config,
				centerHz: center + (input.config.offsetHz ?? 0),
				squelch: input.squelch,
			}),
		)
		const opened = await this.waitEvent(child, this.openTimeoutMs, event => {
			if (event.type === "rejected") return event
			if (event.type === "opened" && event.id === DEMOD_CHANNEL_ID) return event
			return undefined
		})
		if (this.stopping) {
			await this.stop()
			return { ok: false, crashed: true }
		}
		if (opened === undefined || opened.type === "rejected") {
			const failure = opened === undefined ? this.startupFailure(child) : null
			await this.stop()
			if (failure && ("crashed" in failure || this.spawnFailure !== undefined))
				return failure
			return { ok: false, fallback: "open-rejected" }
		}
		if (opened.outputRateHz !== RUST_AUDIO_RATE_HZ) {
			await this.stop()
			return { ok: false, fallback: "protocol-unsupported" }
		}
		this.attachAudio(opened)
		this.opened = true
		this.early = []
		this.flushPreOpen()
		return { ok: true, format: opened.format, rate: RUST_AUDIO_RATE_HZ }
	}

	/**
	 * Why start did not see the event it was waiting for. A spawn error and a
	 * child this start is about to kill (ready/open timeout) are
	 * `binary-unavailable`. An exit we did not cause is `crashed`. Call this
	 * before `stop()`, which terminates a live child.
	 */
	private startupFailure(child: ChildProcess): RustStartResult {
		if (this.spawnFailure !== undefined) {
			return {
				ok: false,
				fallback: "binary-unavailable",
				error: this.spawnFailure,
			}
		}
		if (this.unexpectedExit) return { ok: false, crashed: true }
		if (
			!this.stopping &&
			(child.exitCode !== null || child.signalCode !== null || this.exited)
		)
			return { ok: false, crashed: true }
		if (this.stopping) return { ok: false, crashed: true }
		return { ok: false, fallback: "binary-unavailable" }
	}

	private watchChild(child: ChildProcess): void {
		child.once("error", (error: Error) => {
			// Node reports a failed spawn asynchronously, after spawn() returned.
			if (isSpawnFailure(child, error)) {
				this.spawnFailure = error
				this.exited = true
			}
			this.log.debug(
				{ err: safeErrorFields(error) },
				"Live demodulation Rust engine process error",
			)
			this.fail("Live demodulation Rust engine exited")
		})
		child.once("exit", (code, signal) => {
			this.exited = true
			if (this.stopping || this.spawnFailure !== undefined) return
			this.unexpectedExit = true
			this.fail(
				`Live demodulation Rust engine exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			)
		})
	}

	private dispatch(event: DemodEvent): void {
		this.applyRuntime(event)
		if (this.pendingMatch) {
			this.pendingMatch(event)
			return
		}
		this.rememberEarly(event)
	}

	/** Retains a pre-open handshake event, dropping it once the queue is full. */
	private rememberEarly(event: DemodEvent): void {
		if (this.opened) return
		if (
			event.type !== "ready" &&
			event.type !== "opened" &&
			event.type !== "rejected" &&
			event.type !== "retuned"
		)
			return
		if (this.early.length >= HANDSHAKE_EARLY_MAX) {
			this.dropCount += 1
			return
		}
		this.early.push(event)
	}

	private applyRuntime(event: DemodEvent): void {
		if (event.type === "rejected" && event.id === DEMOD_CHANNEL_ID) {
			this.handlers?.onRejected?.(event.reasonCode)
			return
		}
		if (event.type === "retuned" && event.id === DEMOD_CHANNEL_ID) {
			this.handlers?.onRetuned?.(event.atOutputSample)
			return
		}
		if (event.type === "gate" && event.id === DEMOD_CHANNEL_ID) {
			this.onGateEvent(event.open, event.atOutputSample)
			return
		}
		if (event.type === "metrics" && event.id === DEMOD_CHANNEL_ID) {
			this.onMetricsEvent(
				event.atOutputSample,
				event.powerDbfs,
				event.quietingDb,
			)
			return
		}
		if (
			event.type === "input-eof" ||
			(event.type === "closed" && event.id === DEMOD_CHANNEL_ID)
		)
			this.fail("Live demodulation Rust engine socket closed")
	}

	private attachAudio(opened: OpenedDemodEvent): void {
		const socket = createConnection(opened.socket)
		this.audio = socket
		socket.on("data", (chunk: Buffer) => {
			if (!this.stopping) this.handlers?.onAudio(chunk)
		})
		socket.on("error", (error: Error) => {
			this.log.debug(
				{ err: safeErrorFields(error) },
				"Live demodulation Rust engine audio socket error",
			)
			this.fail("Live demodulation Rust engine socket closed")
		})
		socket.on("close", () => {
			this.fail("Live demodulation Rust engine socket closed")
		})
	}

	private resetSampleOrder(): void {
		this.nextMetricAt = 0
		this.metricsSeen = false
		this.heldGates = []
		this.clearGateHold()
		this.preOpenGates = []
		this.preOpenPower = []
		this.preOpenQuiet = []
		this.preOpenAt = null
	}

	/**
	 * WG10 req 3.8.1: native sends a gate change at once (`atOutputSample` = the end of the block
	 * that decided it) and metrics in batches of ten blocks later. A gate whose block is not yet
	 * reported waits, so handlers see each block's metrics after the gate state it was decided
	 * with. Before any metrics, or once a batch is overdue, gates pass at once.
	 */
	private onGateEvent(open: boolean, at: number): void {
		if (!this.opened) {
			this.preOpenGates.push({ open, at })
			return
		}
		if (
			this.metricsSeen &&
			(this.heldGates.length > 0 ||
				at - METRIC_BLOCK_SAMPLES >= this.nextMetricAt)
		) {
			this.heldGates.push({ open, at })
			if (this.gateHoldTimer === null)
				this.gateHoldTimer = this.clock.setTimer(() => {
					this.gateHoldTimer = null
					this.releaseHeldGates(Number.POSITIVE_INFINITY)
				}, GATE_HOLD_MAX_MS)
			return
		}
		this.handlers?.onGate(open)
	}

	private onMetricsEvent(
		at: number,
		power: Array<number | null>,
		quiet: ReadonlyArray<QuietingDb>,
	): void {
		if (!this.opened) {
			// Startup: one merged, gap-filled batch, so no block is lost downstream.
			// Positions count from the first output sample, like the audio.
			if (this.preOpenAt === null) this.preOpenAt = 0
			const expected =
				this.preOpenAt + this.preOpenPower.length * METRIC_BLOCK_SAMPLES
			const gap = Math.round((at - expected) / METRIC_BLOCK_SAMPLES)
			for (let i = 0; i < gap; i++) {
				this.preOpenPower.push(null)
				this.preOpenQuiet.push(null)
			}
			const count = Math.max(power.length, quiet.length)
			for (let i = 0; i < count; i++) {
				this.preOpenPower.push(power[i] ?? null)
				this.preOpenQuiet.push(quiet[i] ?? null)
			}
			const over = this.preOpenPower.length - PRE_OPEN_METRIC_BLOCKS
			if (over > 0) {
				this.preOpenPower.splice(0, over)
				this.preOpenQuiet.splice(0, over)
				this.preOpenAt += over * METRIC_BLOCK_SAMPLES
			}
			return
		}
		this.metricsSeen = true
		// Blocks native reported nowhere (dropped lines) keep their place as empty metrics.
		const gap = Math.round((at - this.nextMetricAt) / METRIC_BLOCK_SAMPLES)
		if (gap > 0) {
			// One batch, so downstream sees one update (allocates only on a gap).
			const empty = new Array<null>(gap).fill(null)
			this.deliverMetrics(
				this.nextMetricAt,
				[...empty, ...power],
				[...empty, ...quiet],
			)
			return
		}
		this.deliverMetrics(at, power, quiet)
	}

	/** One batch, split before each held gate that its blocks reach. */
	private deliverMetrics(
		at: number,
		power: Array<number | null>,
		quiet: ReadonlyArray<QuietingDb>,
	): void {
		const count = Math.max(power.length, quiet.length)
		let start = 0
		for (let i = 0; i < count; i++) {
			const head = this.heldGates[0]
			if (head === undefined) break
			if (head.at > at + (i + 1) * METRIC_BLOCK_SAMPLES) continue
			if (i > start)
				this.handlers?.onMetrics(power.slice(start, i), quiet.slice(start, i))
			start = i
			this.releaseHeldGates(at + (i + 1) * METRIC_BLOCK_SAMPLES)
		}
		if (start === 0) this.handlers?.onMetrics(power, quiet)
		else if (start < count)
			this.handlers?.onMetrics(power.slice(start), quiet.slice(start))
		this.nextMetricAt = Math.max(
			this.nextMetricAt,
			at + count * METRIC_BLOCK_SAMPLES,
		)
		this.releaseHeldGates(this.nextMetricAt)
	}

	private releaseHeldGates(upTo: number): void {
		while (this.heldGates.length > 0) {
			const head = this.heldGates[0]
			if (head === undefined || head.at > upTo) break
			this.heldGates.shift()
			this.handlers?.onGate(head.open)
		}
		if (this.heldGates.length === 0) this.clearGateHold()
	}

	private clearGateHold(): void {
		if (this.gateHoldTimer === null) return
		this.clock.clearTimer(this.gateHoldTimer)
		this.gateHoldTimer = null
	}

	/** Delivers the startup gates and the merged startup metrics once the channel is open. */
	private flushPreOpen(): void {
		// Startup gates keep their positions: replayed between the merged batch's blocks.
		const gates = this.preOpenGates
		this.preOpenGates = []
		const power = this.preOpenPower
		const quiet = this.preOpenQuiet
		this.preOpenPower = []
		this.preOpenQuiet = []
		this.preOpenAt = null
		// Metrics always flow (the open command asks for them): gates wait for their block.
		this.metricsSeen = true
		this.heldGates = gates
		if (power.length > 0) this.deliverMetrics(0, power, quiet)
		else this.releaseHeldGates(0)
		if (this.heldGates.length > 0 && this.gateHoldTimer === null)
			this.gateHoldTimer = this.clock.setTimer(() => {
				this.gateHoldTimer = null
				this.releaseHeldGates(Number.POSITIVE_INFINITY)
			}, GATE_HOLD_MAX_MS)
	}

	private fail(reason: string): void {
		if (this.stopping || this.down || !this.opened) return
		this.down = true
		this.handlers?.onDown(reason)
	}

	private send(payload: string): void {
		const control = this.control
		if (!control || this.exited || control.destroyed || control.writableEnded)
			return
		control.write(payload)
	}

	private detachInput(): void {
		const input = this.input
		const stdin = this.child?.stdin
		if (input && stdin) input.unpipe(stdin)
		stdin?.destroy()
		this.input = null
	}

	private waitEvent<T>(
		child: ChildProcess,
		ms: number,
		match: (event: DemodEvent) => T | undefined,
	): Promise<T | undefined> {
		return new Promise(resolve => {
			let settled = false
			let timer: unknown
			const finish = (value: T | undefined) => {
				if (settled) return
				settled = true
				this.clock.clearTimer(timer)
				child.off("exit", onExit)
				if (this.pendingMatch === onMatch) this.pendingMatch = undefined
				resolve(value)
			}
			const onMatch = (event: DemodEvent) => {
				if (settled) return
				const matched = match(event)
				if (matched !== undefined) finish(matched)
			}
			const onExit = () => finish(undefined)
			this.pendingMatch = onMatch
			const queued = this.early
			this.early = []
			for (const event of queued) {
				if (settled) this.rememberEarly(event)
				else onMatch(event)
			}
			if (settled) return
			child.once("exit", onExit)
			timer = this.clock.setTimer(() => finish(undefined), ms)
		})
	}

	private waitExit(child: ChildProcess, ms: number): Promise<boolean> {
		if (child.exitCode !== null || child.signalCode !== null || this.exited)
			return Promise.resolve(true)
		return new Promise(resolve => {
			let settled = false
			const finish = (exited: boolean) => {
				if (settled) return
				settled = true
				this.clock.clearTimer(timer)
				child.off("exit", onExit)
				resolve(exited)
			}
			const onExit = () => finish(true)
			child.once("exit", onExit)
			const timer = this.clock.setTimer(() => finish(false), ms)
		})
	}

	private killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
		try {
			signalDecoder(child, signal)
		} catch (error: unknown) {
			this.log.debug(
				{ err: safeErrorFields(error) },
				"Live demodulation Rust engine signal failed",
			)
		}
	}

	private async removeSocketDir(): Promise<void> {
		const dir = this.socketDir
		this.socketDir = null
		if (!dir) return
		await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
			this.log.debug(
				{ err: safeErrorFields(error) },
				"Live demodulation Rust engine socket directory cleanup failed",
			)
		})
	}
}

function isSpawnFailure(child: ChildProcess, error: Error): boolean {
	const code =
		"code" in error && typeof error.code === "string" ? error.code : undefined
	return child.pid === undefined || code === "ENOENT" || code === "EACCES"
}

function writableFd(child: ChildProcess, fd: number): Writable | null {
	const pipe = child.stdio[fd]
	if (pipe === null || pipe === undefined || typeof pipe === "number")
		return null
	if (!("write" in pipe)) return null
	return pipe
}

export const RUST_ENGINE_PROTOCOL = DEMOD_PROTOCOL
