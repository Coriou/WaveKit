import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { signalDecoder } from "../../decoders/process-tools.js"
import { WaveKitError } from "../../utils/errors.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import {
	encodeRequest,
	parseEventLine,
	type ChannelizerRequest,
} from "./protocol.js"

/**
 * One supervised `wavekit-chan` process (addendum §4, §11; A1): IQ on stdin, JSON-lines control on
 * fd 3, events on stdout, logs on stderr. Spawned detached so `signalDecoder` reaches its whole
 * process group. If WaveKit dies, the control pipe closes and the process shuts itself down.
 */
export interface ChannelizerProcessOptions {
	binaryPath: string
	generation: number
	inputRateHz: number
	inputCenterHz: number
	usableFraction: number
	blockSamples: number
	socketDir: string
	readyTimeoutMs?: number
	stopTimeoutMs?: number
}

/**
 * Events: "event" (ChannelizerEvent), "protocol-error" (line, error; for a line longer than
 * `MAX_EVENT_LINE_BYTES` it carries the line's start, and the process is stopped), and "exit" (code, signal),
 * emitted on the child's `close`, so after its last stdout line has been parsed. "exit" is emitted
 * only for a process that was actually spawned: a spawn failure (ENOENT, EACCES) rejects `start()`
 * and emits no "exit". A process that started but never sent `ready` does emit one, after the rejection.
 */
export interface ChannelizerProcessLike extends EventEmitter {
	readonly generation: number
	readonly input: Writable
	/** Resolves on `ready`; rejects with `CHANNELIZER_UNAVAILABLE`. */
	start(): Promise<void>
	send(req: ChannelizerRequest): void
	/**
	 * shutdown → end input → stopTimeout → SIGTERM → 5 s → SIGKILL. The process sees whichever of
	 * shutdown and input EOF arrives first, so a stop ends with either `closed` lines or `input-eof`.
	 */
	stop(): Promise<void>
}

/** Longest event line accepted; a child that writes more without a newline is stopped, so it cannot grow memory. */
export const MAX_EVENT_LINE_BYTES = 64 * 1024
/** How much of a runaway line "protocol-error" carries. */
const RUNAWAY_PREFIX_CHARS = 256
const CONTROL_FD = 3
const DEFAULT_READY_TIMEOUT_MS = 5000
const DEFAULT_STOP_TIMEOUT_MS = 5000
const KILL_AFTER_MS = 5000

/**
 * Splits the child's stdout into `\n`-terminated lines (a trailing `\r` dropped, an unterminated last
 * line delivered at the end), like readline but bounded: past `MAX_EVENT_LINE_BYTES` without a newline it
 * calls `onRunaway` once with the line's start and discards everything after it.
 */
function splitEventLines(
	stdout: Readable,
	onLine: (line: string) => void,
	onRunaway: (prefix: string) => void,
): void {
	let pending: Buffer[] = []
	let pendingBytes = 0
	let runaway = false
	const take = (tail: Buffer) => {
		const line = Buffer.concat([...pending, tail]).toString("utf8")
		pending = []
		pendingBytes = 0
		return line.endsWith("\r") ? line.slice(0, -1) : line
	}
	stdout.on("data", (chunk: Buffer) => {
		// Still drained after a runaway, so the child is never blocked on a full pipe while it stops.
		if (runaway) return
		let start = 0
		for (let nl = chunk.indexOf(0x0a); ; nl = chunk.indexOf(0x0a, start)) {
			const end = nl === -1 ? chunk.length : nl
			if (pendingBytes + end - start > MAX_EVENT_LINE_BYTES) {
				runaway = true
				const prefix = take(chunk.subarray(start, end)).slice(
					0,
					RUNAWAY_PREFIX_CHARS,
				)
				onRunaway(prefix)
				return
			}
			if (nl === -1) break
			onLine(take(chunk.subarray(start, nl)))
			start = nl + 1
		}
		if (start < chunk.length) {
			pending.push(chunk.subarray(start))
			pendingBytes += chunk.length - start
		}
	})
	stdout.on("end", () => {
		if (!runaway && pendingBytes > 0) onLine(take(Buffer.alloc(0)))
	})
}

export function buildChannelizerArgs(o: ChannelizerProcessOptions): string[] {
	return [
		"--generation",
		String(o.generation),
		"--input-format",
		"cu8",
		"--input-rate",
		String(o.inputRateHz),
		"--input-center",
		String(o.inputCenterHz),
		"--usable-fraction",
		String(o.usableFraction),
		"--block-samples",
		String(o.blockSamples),
		"--socket-dir",
		o.socketDir,
		"--control-fd",
		String(CONTROL_FD),
	]
}

export class ChannelizerProcess
	extends EventEmitter
	implements ChannelizerProcessLike
{
	readonly generation: number
	private readonly log: Logger
	private child: ChildProcess | null = null
	private control: Writable | null = null
	private exited = false
	private stopping: Promise<void> | null = null

	constructor(
		private readonly options: ChannelizerProcessOptions,
		logger: Logger,
	) {
		super()
		this.generation = options.generation
		this.log = createComponentLogger(logger, "ChannelizerProcess")
	}

	get input(): Writable {
		const stdin = this.child?.stdin
		if (!stdin)
			throw new WaveKitError(
				"channelizer not started",
				"CHANNELIZER_UNAVAILABLE",
			)
		return stdin
	}

	start(): Promise<void> {
		if (this.child)
			return Promise.reject(
				new WaveKitError(
					"channelizer already started",
					"CHANNELIZER_UNAVAILABLE",
				),
			)
		const readyTimeoutMs =
			this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
		return new Promise((resolve, reject) => {
			let settled = false
			let lastStderr = ""
			const settle = (error?: WaveKitError) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				if (error) reject(error)
				else resolve()
			}
			const unavailable = (message: string, cause?: Error) =>
				settle(new WaveKitError(message, "CHANNELIZER_UNAVAILABLE", cause))
			const timer = setTimeout(() => {
				unavailable(`wavekit-chan not ready within ${readyTimeoutMs} ms`)
				this.stop().catch((err: unknown) =>
					this.log.warn({ err }, "Stopping a never-ready wavekit-chan failed"),
				)
			}, readyTimeoutMs)

			let child: ChildProcess
			try {
				child = spawn(
					this.options.binaryPath,
					buildChannelizerArgs(this.options),
					{
						detached: process.platform !== "win32",
						stdio: ["pipe", "pipe", "pipe", "pipe"],
					},
				)
			} catch (err: unknown) {
				const cause = err instanceof Error ? err : undefined
				unavailable(
					`spawn ${this.options.binaryPath} failed: ${String(err)}`,
					cause,
				)
				return
			}
			this.child = child
			this.control = child.stdio[CONTROL_FD] as Writable | null

			// After the child dies, writes fail with EPIPE: expected, and reported through "exit".
			child.stdin?.on("error", (err: Error) =>
				this.log.debug({ err }, "Input pipe error"),
			)
			this.control?.on("error", (err: Error) =>
				this.log.debug({ err }, "Control pipe error"),
			)
			child.stdout?.on("error", (err: Error) =>
				this.log.warn({ err }, "Event pipe error"),
			)
			child.stderr?.on("error", (err: Error) =>
				this.log.warn({ err }, "Log pipe error"),
			)

			// `on`, not `once`: a failed kill also emits `error`, and an unhandled one would crash WaveKit.
			child.on("error", (err: Error) => {
				// A spawn failure leaves no process behind (its `close` still follows, with a negative errno).
				if (child.pid === undefined) this.exited = true
				else
					this.log.warn({ err, pid: child.pid }, "wavekit-chan process error")
				unavailable(
					`spawn ${this.options.binaryPath} failed: ${err.message}`,
					err,
				)
			})
			// `close`, not `exit`: it fires after stdout has ended, so every event line (notably `input-eof`) is parsed
			// before the exit is reported. Task 21 relies on that order to tell an end-of-recording exit 0 from a crash.
			child.once("close", (code: number | null, signal: string | null) => {
				this.exited = true
				child.stdin?.destroy()
				this.control?.destroy()
				this.log.debug({ pid: child.pid, code, signal }, "wavekit-chan exited")
				// Node closes a never-spawned child too (code -2); there was no process to report.
				if (child.pid !== undefined) this.emit("exit", code, signal)
				unavailable(
					`wavekit-chan exited before ready (code ${String(code)}, signal ${String(signal)})${lastStderr ? `: ${lastStderr}` : ""}`,
				)
			})

			if (child.stderr)
				// wavekit-chan writes only errors to stderr.
				createInterface({ input: child.stderr }).on("line", line => {
					lastStderr = line
					this.log.warn({ line }, "wavekit-chan stderr")
				})
			if (child.stdout)
				splitEventLines(
					child.stdout,
					line => {
						const parsed = parseEventLine(line)
						if (!parsed.ok) {
							this.log.warn(
								{ line, error: parsed.error },
								"Invalid channelizer event line",
							)
							this.emit("protocol-error", line, parsed.error)
							return
						}
						if (parsed.event.type === "ready") settle()
						this.emit("event", parsed.event)
					},
					prefix => {
						const error = `no newline within ${MAX_EVENT_LINE_BYTES} bytes`
						this.log.warn(
							{ pid: child.pid, prefix },
							"Runaway channelizer event line, stopping wavekit-chan",
						)
						this.emit("protocol-error", prefix, error)
						this.stop().catch((err: unknown) =>
							this.log.warn({ err }, "Stopping a runaway wavekit-chan failed"),
						)
					},
				)
		})
	}

	/** Drops the request once the process has exited or is stopping; never throws on a dead pipe. */
	send(req: ChannelizerRequest): void {
		const line = encodeRequest(req)
		const control = this.control
		if (!control || this.exited || control.writableEnded || control.destroyed) {
			this.log.debug({ type: req.type }, "Control closed, request dropped")
			return
		}
		control.write(line)
	}

	stop(): Promise<void> {
		if (!this.child || this.exited) return Promise.resolve()
		this.stopping ??= this.terminate(this.child)
		return this.stopping
	}

	private async terminate(child: ChildProcess): Promise<void> {
		// Our own "exit" (emitted on the child's close): a child that already exited but has not closed yet still resolves it.
		const exited = new Promise<void>(resolve =>
			this.once("exit", () => resolve()),
		)
		const exitedWithin = (ms: number) =>
			new Promise<boolean>(resolve => {
				const timer = setTimeout(() => resolve(false), ms)
				void exited.then(() => {
					clearTimeout(timer)
					resolve(true)
				})
			})
		this.send({ v: 1, type: "shutdown" })
		child.stdin?.end()
		this.control?.end()
		if (
			await exitedWithin(this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
		)
			return
		this.log.warn(
			{ pid: child.pid },
			"wavekit-chan ignored shutdown, sending SIGTERM",
		)
		signalDecoder(child, "SIGTERM")
		if (await exitedWithin(KILL_AFTER_MS)) return
		this.log.warn(
			{ pid: child.pid },
			"wavekit-chan ignored SIGTERM, sending SIGKILL",
		)
		signalDecoder(child, "SIGKILL")
		await exited
	}
}
