/**
 * One `wavekit-iqcap run` process for one IQ source (WG11 req 6.2). Mirrors the channelizer's
 * conventions: CU8 on stdin, JSON-line commands on fd 3, JSON-line events on stdout, free-text
 * diagnostics on stderr (never logged verbatim), spawned detached so a stop signal reaches its
 * whole process group. If WaveKit dies the pipes close and the tool exits on its own.
 *
 * The tap feed never blocks and never copies: each tap chunk is written as a Buffer view of the
 * engine's chunk; when more than IQ_TOOL_MAX_QUEUED_BYTES (1 MiB) are queued in stdin, chunks are
 * dropped, counted and declared to the tool with one `gap` command before the next accepted
 * chunk, so the tool's sample count stays aligned with the engine's.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import type { Readable, Writable } from "node:stream"
import {
	IQ_CAPTURE_CONTROL_LINE_MAX_BYTES,
	IQ_CAPTURE_RATE_HZ,
} from "../scanner/iq-capture-contract.js"
import {
	BoundedLineReader,
	encodeToolCommand,
	IQ_TOOL_MAX_GAP_SAMPLES,
	parseToolEvent,
	type IqToolCommand,
	type IqToolEvent,
} from "./protocol.js"

/** Queued stdin bytes above which tap chunks are dropped as a counted gap (1 MiB). */
export const IQ_TOOL_MAX_QUEUED_BYTES = 1024 * 1024
export const IQ_TOOL_READY_TIMEOUT_MS = 5_000
export const IQ_TOOL_STOP_TIMEOUT_MS = 2_000
export const IQ_TOOL_KILL_AFTER_MS = 3_000
/** Inspect at most 4 KiB per spawn; all subsequent stderr bytes are drained only. */
export const IQ_TOOL_STDERR_MAX_BYTES = 4 * 1024
export interface IqToolFailure {
	exitCode: number | null
	signal: NodeJS.Signals | null
	phase:
		| "spawn-error"
		| "ready-timeout"
		| "exit-before-ready"
		| "exit-after-ready"
	reason:
		| "usage"
		| "sample-rate"
		| "bandwidth"
		| "anchor"
		| "out-dir"
		| "control-fd"
		| "other"
}
const CONTROL_FD = 3
/** CU8: one I and one Q byte per sample. */
const CU8_BYTES_PER_SAMPLE = 2

export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess

export interface IqToolTimers {
	setTimeout(fn: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

export const realTimers: IqToolTimers = {
	setTimeout: (fn, ms) => {
		const t = setTimeout(fn, ms)
		t.unref()
		return t
	},
	clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
}

export interface IqToolProcessOptions {
	binaryPath: string
	sampleRateHz: number
	ringMs: number
	outDir: string
	/** The canonical anchor above outDir (the tool proves the whole chain from it). */
	anchor: string
	maxMs: number
	bandwidthHz: number
	spawn: SpawnFn
	env: NodeJS.ProcessEnv
	timers: IqToolTimers
}

export interface IqToolCounters {
	/** Tap bytes dropped above the queue bound. */
	droppedBytes: number
	gapCommands: number
	oversizeLines: number
	invalidLines: number
	/** Commands that could not be written (no control pipe, oversized). */
	unsentCommands: number
}

export function buildRunArgs(o: IqToolProcessOptions): string[] {
	return [
		"run",
		"--sample-rate",
		String(o.sampleRateHz),
		"--ring-ms",
		String(o.ringMs),
		"--out-dir",
		o.outDir,
		"--max-ms",
		String(o.maxMs),
		"--bandwidth",
		String(o.bandwidthHz),
		"--anchor",
		o.anchor,
	]
}

/**
 * Events: "ready", "event" (IqToolEvent other than ready), "gap" (samples were lost before the
 * tool: declared with the next accepted chunk), "exit" (failed: boolean, errno code or null)
 * exactly once after a spawn attempt, whether the child ran or not.
 */
export class IqToolProcess extends EventEmitter {
	readonly counters: IqToolCounters = {
		droppedBytes: 0,
		gapCommands: 0,
		oversizeLines: 0,
		invalidLines: 0,
		unsentCommands: 0,
	}
	lastFailure: IqToolFailure | null = null
	private readonly stderrPrefix = Buffer.alloc(IQ_TOOL_STDERR_MAX_BYTES)
	private stderrBytes = 0
	private child: ChildProcess | null = null
	private control: Writable | null = null
	private stdin: Writable | null = null
	private isReady = false
	private exited = false
	private stopping = false
	private timedOut = false
	private readyTimer: unknown = null
	private killTimers: unknown[] = []
	/** Tool sample count: samples written to stdin plus samples declared by `gap`. */
	private toolCount = 0
	private pendingGapSamples = 0
	/** Engine sample matching tool count 0; null until the first chunk after spawn or flush. */
	private base: number | null = null
	private expectedEngine = 0
	/** Oldest tool sample the tool's ring can hold: a gap clears its ring, so it moves to the gap's end. */
	private ringStart = 0

	constructor(private readonly o: IqToolProcessOptions) {
		super()
	}

	/** Output rates the tool advertised in `ready` (48 kHz always; an older tool lists none). */
	private rates: ReadonlySet<number> = new Set([IQ_CAPTURE_RATE_HZ])

	/** Whether the running tool acknowledged `rateHz` (advertised in its `ready` event). */
	supportsRate(rateHz: number): boolean {
		return this.rates.has(rateHz)
	}

	get ready(): boolean {
		return this.isReady && !this.exited && !this.stopping
	}

	/** Engine sample → tool sample; null before the first chunk. */
	toTool(engineSample: number): number | null {
		return this.base === null ? null : engineSample - this.base
	}

	/** The tool's sample count as far as the bridge knows (an upper bound of what it read). */
	submittedSamples(): number {
		return this.toolCount + this.pendingGapSamples
	}

	/** The oldest tool sample still in the tool's ring (0, or the end of the latest gap). */
	oldestSample(): number {
		return this.ringStart
	}

	queuedBytes(): number {
		return this.stdin?.writableLength ?? 0
	}

	start(): void {
		let child: ChildProcess
		try {
			child = this.o.spawn(this.o.binaryPath, buildRunArgs(this.o), {
				env: this.o.env,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe", "pipe"],
			})
		} catch (err: unknown) {
			this.finish(true, errnoCode(err), null, null, true)
			return
		}
		this.child = child
		this.stdin = child.stdin
		this.control = (child.stdio[CONTROL_FD] as Writable | null) ?? null
		child.stdin?.on("error", () => {})
		this.control?.on("error", () => {})
		child.stdout?.on("error", () => {})
		child.stderr?.on("error", () => {})
		// Diagnostics are free text from a native tool: drained, never echoed.
		child.stderr?.on("data", (chunk: Buffer) => {
			const n = Math.min(
				chunk.length,
				IQ_TOOL_STDERR_MAX_BYTES - this.stderrBytes,
			)
			if (n > 0) {
				chunk.copy(this.stderrPrefix, this.stderrBytes, 0, n)
				this.stderrBytes += n
			}
		})
		const reader = new BoundedLineReader(
			IQ_CAPTURE_CONTROL_LINE_MAX_BYTES,
			line => this.onLine(line),
			() => this.counters.oversizeLines++,
		)
		const stdout: Readable | null = child.stdout
		stdout?.on("data", (chunk: Buffer) => reader.push(chunk))
		child.on("error", (err: Error) => {
			if (child.pid === undefined)
				this.finish(true, errnoCode(err), null, null, true)
		})
		child.once(
			"close",
			(code: number | null, signal: NodeJS.Signals | null) => {
				this.finish(
					this.timedOut || !(this.stopping && (code === 0 || code === null)),
					null,
					code,
					signal,
				)
			},
		)
		this.readyTimer = this.o.timers.setTimeout(() => {
			this.readyTimer = null
			if (this.isReady) return
			this.timedOut = true
			void this.stop()
		}, IQ_TOOL_READY_TIMEOUT_MS)
	}

	/** Feeds one engine tap chunk (CU8, absolute engine sample numbers). Never throws. */
	feed(startSample: number, bytes: Uint8Array): void {
		if (!this.ready || !this.stdin) return
		let start = startSample
		let data = bytes
		if (this.base === null) {
			this.base = start
			this.expectedEngine = start
		}
		if (start < this.expectedEngine) {
			// Overlap: keep only the new part (a reset is the scanner's flush on an epoch change).
			const skip = (this.expectedEngine - start) * CU8_BYTES_PER_SAMPLE
			if (skip >= data.length) return
			data = data.subarray(skip)
			start = this.expectedEngine
		}
		if (start > this.expectedEngine) this.addGap(start - this.expectedEngine)
		const samples = Math.floor(data.length / CU8_BYTES_PER_SAMPLE)
		this.expectedEngine = start + samples
		if (samples === 0) return
		if (this.stdin.writableLength > IQ_TOOL_MAX_QUEUED_BYTES) {
			this.counters.droppedBytes += samples * CU8_BYTES_PER_SAMPLE
			this.addGap(samples)
			return
		}
		this.sendPendingGap()
		// Zero-copy: relies on the engine never reusing or mutating a tap chunk after delivering it.
		const view = Buffer.from(
			data.buffer,
			data.byteOffset,
			samples * CU8_BYTES_PER_SAMPLE,
		)
		this.stdin.write(view)
		this.toolCount += samples
	}

	send(cmd: IqToolCommand): boolean {
		if (!this.control || this.exited || this.control.destroyed) {
			this.counters.unsentCommands++
			return false
		}
		const line = encodeToolCommand(cmd)
		if (line === null) {
			this.counters.unsentCommands++
			return false
		}
		this.control.write(line)
		return true
	}

	/** shutdown → end input → 2 s → SIGTERM → 3 s → SIGKILL. Resolves at exit. */
	stop(): Promise<void> {
		if (this.exited) return Promise.resolve()
		const done = new Promise<void>(resolve =>
			this.once("exit", () => resolve()),
		)
		if (this.stopping) return done
		this.stopping = true
		if (this.readyTimer !== null) this.o.timers.clearTimeout(this.readyTimer)
		this.readyTimer = null
		this.send({ type: "shutdown" })
		this.control?.end()
		this.stdin?.end()
		this.killTimers.push(
			this.o.timers.setTimeout(() => {
				this.signal("SIGTERM")
				this.killTimers.push(
					this.o.timers.setTimeout(
						() => this.signal("SIGKILL"),
						IQ_TOOL_KILL_AFTER_MS,
					),
				)
			}, IQ_TOOL_STOP_TIMEOUT_MS),
		)
		return done
	}

	private addGap(samples: number): void {
		this.pendingGapSamples += samples
		this.ringStart = this.submittedSamples()
		// Review m1: the gap line on fd 3 may overtake samples still queued on stdin, so the tool
		// cannot place it exactly inside an open capture: the service aborts those captures.
		this.emit("gap")
	}

	private sendPendingGap(): void {
		while (this.pendingGapSamples > 0) {
			const n = Math.min(this.pendingGapSamples, IQ_TOOL_MAX_GAP_SAMPLES)
			this.pendingGapSamples -= n
			if (this.send({ type: "gap", samples: n })) this.counters.gapCommands++
			this.toolCount += n
		}
	}

	private onLine(line: string): void {
		const ev: IqToolEvent | null = parseToolEvent(line)
		if (!ev) {
			this.counters.invalidLines++
			return
		}
		if (ev.type === "ready") {
			if (this.isReady) {
				this.counters.invalidLines++
				return
			}
			this.isReady = true
			this.rates = new Set([IQ_CAPTURE_RATE_HZ, ...(ev.rates ?? [])])
			if (this.readyTimer !== null) this.o.timers.clearTimeout(this.readyTimer)
			this.readyTimer = null
			this.emit("ready")
			return
		}
		if (!this.isReady) {
			this.counters.invalidLines++
			return
		}
		this.emit("event", ev)
	}

	private signal(sig: NodeJS.Signals): void {
		const pid = this.child?.pid
		if (this.exited || pid === undefined || pid <= 1) return
		try {
			if (process.platform !== "win32") process.kill(-pid, sig)
			else this.child?.kill(sig)
		} catch {
			try {
				this.child?.kill(sig)
			} catch {
				// gone
			}
		}
	}

	private finish(
		failed: boolean,
		code: string | null,
		exitCode: number | null = null,
		signal: NodeJS.Signals | null = null,
		spawnError = false,
	): void {
		if (this.exited) return
		this.exited = true
		if (failed) {
			const prefix = this.stderrPrefix
				.toString("utf8", 0, this.stderrBytes)
				.toLowerCase()
			// Only the first diagnostic counts; the usage footer names every flag.
			const diagnostic = (prefix.split("\n", 1)[0] ?? "").replace(
				/^wavekit-iqcap: /,
				"",
			)
			const argumentError =
				/^(usage:|unknown command$|unknown flag$|--(?:ring-ms|max-ms)\b|(?:ring-ms|max-ms) must be within )/.test(
					diagnostic,
				)
			const reason: IqToolFailure["reason"] = diagnostic.startsWith(
				"control fd 3 is not open",
			)
				? "control-fd"
				: /^(--sample-rate\b|sample rate must be within )/.test(diagnostic)
					? "sample-rate"
					: /^(--bandwidth\b|bandwidth\b)/.test(diagnostic)
						? "bandwidth"
						: /^(--out-dir\b|out-dir\b)/.test(diagnostic)
							? "out-dir"
							: /^(--anchor\b|anchor\b)/.test(diagnostic)
								? "anchor"
								: argumentError
									? "usage"
									: "other"
			this.lastFailure = {
				exitCode,
				signal: signal ?? null,
				phase: spawnError
					? "spawn-error"
					: this.timedOut
						? "ready-timeout"
						: this.isReady
							? "exit-after-ready"
							: "exit-before-ready",
				reason,
			}
		}
		this.isReady = false
		if (this.readyTimer !== null) this.o.timers.clearTimeout(this.readyTimer)
		for (const t of this.killTimers) this.o.timers.clearTimeout(t)
		this.killTimers = []
		this.stdin?.destroy()
		this.control?.destroy()
		this.emit("exit", failed, code)
	}
}

function errnoCode(err: unknown): string | null {
	const code = (err as { code?: unknown } | null)?.code
	return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
		? code
		: null
}
