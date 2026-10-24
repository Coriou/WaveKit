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
export const RUST_METRIC_BLOCK_SAMPLES = RUST_AUDIO_RATE_HZ / 100
/**
 * WG10 req 3.8.1: gate changes remembered by output position. Native sends at most one change
 * per block, so 256 entries cover at least 256 blocks (2.56 s): more than the downstream
 * startup buffer (8 batches, 80 blocks) plus one batch of metrics lag. An evicted change
 * becomes the base state of the window.
 */
export const GATE_HISTORY_MAX = 256
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
	/**
	 * One metrics batch. WG10 req 3.8.1: `atOutputSample` is the first block's output sample and
	 * `gateOpen[i]` the gate state block `i` was decided with (from the gate history).
	 */
	onMetrics: (
		powerDbfs: Array<number | null>,
		quietingDb: ReadonlyArray<QuietingDb>,
		atOutputSample: number,
		gateOpen: ReadonlyArray<boolean>,
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
	private gateHistory: Array<{ at: number; open: boolean }> = []
	/** Gate state before the oldest remembered change (native starts closed). */
	private gateBase = false
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
		this.gateHistory = []
		this.gateBase = false
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
			this.rememberGate(event.atOutputSample, event.open)
			this.handlers?.onGate(event.open)
			return
		}
		if (event.type === "metrics" && event.id === DEMOD_CHANNEL_ID) {
			this.handlers?.onMetrics(
				event.powerDbfs,
				event.quietingDb,
				event.atOutputSample,
				this.gatesFor(
					event.atOutputSample,
					Math.max(event.powerDbfs.length, event.quietingDb.length),
				),
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

	private rememberGate(at: number, open: boolean): void {
		this.gateHistory.push({ at, open })
		if (this.gateHistory.length > GATE_HISTORY_MAX) {
			const evicted = this.gateHistory.shift()
			if (evicted !== undefined) this.gateBase = evicted.open
		}
	}

	/**
	 * Gate state of each block of a batch: native stamps a change with the end of the block that
	 * decided it, so block `i` takes the latest change at or before its end.
	 */
	private gatesFor(at: number, count: number): boolean[] {
		const gates = new Array<boolean>(count)
		const history = this.gateHistory
		let state = this.gateBase
		let next = 0
		for (let i = 0; i < count; i++) {
			const end = at + (i + 1) * RUST_METRIC_BLOCK_SAMPLES
			while (next < history.length) {
				const change = history[next]
				if (change === undefined || change.at > end) break
				state = change.open
				next += 1
			}
			gates[i] = state
		}
		return gates
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
