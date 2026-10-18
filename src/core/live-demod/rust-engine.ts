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
} from "./rust-protocol.js"

const CONTROL_FD = 3
const USABLE_FRACTION = 0.8
const BLOCK_SAMPLES = 1024
const VERSION_LIMIT_BYTES = 4096
const DEFAULT_PROBE_MS = 2000
const DEFAULT_OPEN_MS = 2000
const DEFAULT_STOP_KILL_MS = 2000

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
		quietingDb: Array<number | null>,
	) => void
	onDown: (reason: string) => void
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
		this.pendingMatch = undefined
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
		if (this.stopping && this.exited) return
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
		const center = input.caps.centerFreq ?? 0
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
			await this.stop()
			return this.childDied(child)
				? { ok: false, crashed: true }
				: { ok: false, fallback: "binary-unavailable" }
		}
		if (this.stopping) return { ok: false, crashed: true }
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
		if (opened === undefined || opened.type === "rejected") {
			await this.stop()
			if (opened === undefined && this.childDied(child))
				return { ok: false, crashed: true }
			return { ok: false, fallback: "open-rejected" }
		}
		if (opened.outputRateHz !== RUST_AUDIO_RATE_HZ) {
			await this.stop()
			return { ok: false, fallback: "protocol-unsupported" }
		}
		this.attachAudio(opened)
		this.opened = true
		return { ok: true, format: opened.format, rate: RUST_AUDIO_RATE_HZ }
	}

	private childDied(child: ChildProcess): boolean {
		return child.exitCode !== null || child.signalCode !== null || this.exited
	}

	private watchChild(child: ChildProcess): void {
		child.once("error", (error: Error) => {
			if (child.pid === undefined) this.exited = true
			this.log.debug(
				{ err: safeErrorFields(error) },
				"Live demodulation Rust engine process error",
			)
			this.fail("Live demodulation Rust engine exited")
		})
		child.once("exit", (code, signal) => {
			this.exited = true
			if (this.stopping) return
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
		if (
			event.type === "ready" ||
			event.type === "opened" ||
			event.type === "rejected" ||
			event.type === "retuned"
		)
			this.early.push(event)
	}

	private applyRuntime(event: DemodEvent): void {
		if (event.type === "gate" && event.id === DEMOD_CHANNEL_ID) {
			this.handlers?.onGate(event.open)
			return
		}
		if (event.type === "metrics" && event.id === DEMOD_CHANNEL_ID) {
			this.handlers?.onMetrics(event.powerDbfs, event.quietingDb)
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
				if (settled) this.early.push(event)
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

function writableFd(child: ChildProcess, fd: number): Writable | null {
	const pipe = child.stdio[fd]
	if (pipe === null || pipe === undefined || typeof pipe === "number")
		return null
	if (!("write" in pipe)) return null
	return pipe
}

export const RUST_ENGINE_PROTOCOL = DEMOD_PROTOCOL
