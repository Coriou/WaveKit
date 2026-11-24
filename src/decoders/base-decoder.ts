import type { DecoderReach } from "./enablement/contract.js"
/**
 * Base Decoder - Abstract base class for decoder implementations
 *
 * Requirements:
 * - 4.1: WHEN a decoder is started, THE Decoder_Manager SHALL spawn the decoder process with appropriate arguments
 * - 4.3: WHEN a decoder is stopped, THE Decoder_Manager SHALL send SIGTERM and wait, then SIGKILL if needed
 * - 4.4: WHEN a decoder produces output, THE Decoder_Manager SHALL parse it into structured DecoderOutput objects
 * - 4.5: WHEN requested, THE Decoder_Manager SHALL return status for all managed decoders including PID, uptime, and statistics
 * - 4.6: THE Decoder_Manager SHALL emit events for decoder output, errors, and exit conditions
 * - 17.1: Decoder capabilities declaration
 * - 20.1: Report health as "running" when producing output
 * - 20.2: Report health as "degraded" when no output for configured timeout
 * - 20.3: Report health as "faulted" when crashed and exceeded restart limits
 * - 20.4: Emit health events when health changes
 */

import { signalDecoder } from "./process-tools.js"
import { csdrChildEnv } from "./csdr-buffers.js"
import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import { DecoderObservability } from "./decoder-observability.js"
import { DecoderCounterReporter } from "./decoder-counters.js"
import { createInterface } from "node:readline"
import { PassThrough, type Readable } from "node:stream"
import type {
	Decoder,
	DecoderCaps,
	DecoderConfig,
	DecoderHealth,
	DecoderOutput,
	DecoderStats,
	DecoderStatus,
} from "./types.js"
import type { Logger } from "../utils/logger.js"
import { DecoderSpawnError } from "../utils/errors.js"
import { createComponentLogger, LogRateLimiter } from "../utils/logger.js"
import { safeErrorFields } from "./safe-error-fields.js"
import type { DirectChannelSocket } from "../core/channelizer/types.js"
import { directInputLost, directStep } from "./direct-channel-input.js"

/** Timeout in ms to wait for graceful shutdown before SIGKILL */
const GRACEFUL_STOP_TIMEOUT = 5000

/**
 * BaseDecoder - Abstract base class implementing common decoder functionality.
 *
 * Uses the Template Method pattern where subclasses implement:
 * - getCommand(): The executable command to spawn
 * - getArgs(): Command line arguments for the process
 * - parseOutput(line): Parse stdout/stderr lines into DecoderOutput objects
 * - getCaps(): Return the decoder's capabilities
 *
 * Handles:
 * - Process spawning with stdio piping
 * - Graceful stop with SIGTERM/SIGKILL
 * - Output stream in object mode for DecoderOutput
 * - Statistics tracking (bytesIn, eventsOut, errors)
 * - Status reporting (running, pid, uptime, health)
 * - Health state tracking (running, idle, faulted)
 */
export abstract class BaseDecoder extends EventEmitter implements Decoder {
	reach(): DecoderReach {
		return "raw"
	}

	readonly id: string
	readonly type: string

	private readonly observability: DecoderObservability

	/**
	 * Frame counters (decoder-counters.ts): adapters report the counters their
	 * tool prints (`counters.cumulative()` / `counters.delta()`) or count lines
	 * they already parse (`counters.count()`); each accepted report is emitted as
	 * a "counters" event (DecoderCounterEvent) the manager folds into
	 * totals. Names outside DECODER_COUNTER_NAMES are refused.
	 */
	protected readonly counters = new DecoderCounterReporter(event => {
		this.emit("counters", event)
	})

	/**
	 * Sends the locally counted increments now: the manager calls it before a
	 * move or a worker's teardown, so they land in the listening period they
	 * were heard in.
	 */
	flushCounters(): void {
		this.counters.flush()
	}

	protected process: ChildProcess | null = null
	protected inputStream: Readable | null = null
	/**
	 * A channel socket the next spawn takes as stdin (direct channel input). Node never reads it: no `data`
	 * listener, pipe, read() or resume(); it destroys its own copy as soon as `spawn` has returned. It is also the
	 * grant's identity: a detach destroys the socket but keeps it here, so the start it was granted for refuses to
	 * spawn without it (lost-before-start) instead of spawning with an unfed pipe. Only a new input or a start clears it.
	 */
	private directInput: DirectChannelSocket | null = null
	/**
	 * Settles when the last spawned child's stdout and stderr have both ended or closed: every line they carried has
	 * been parsed by then. Recorded for every run and awaited only by a caller that must act after a run's last line
	 * (outputDrained); it never rejects.
	 */
	private outputDrain: Promise<void> = Promise.resolve()
	/** The last spawned child's stdout and stderr, kept so a caller that gives up on their drain can close them. */
	private outputStreams: Readable[] = []
	private readonly trackInputBytes = (chunk: Buffer): void => {
		this.stats.bytesIn += chunk.length
	}
	private readonly handleInputError = (err: Error): void => {
		this.logger.warn(
			{ err: safeErrorFields(err) },
			"Decoder input stream error",
		)
	}
	protected outputStream: PassThrough
	protected audioOutputStream: PassThrough | null = null
	protected stats: DecoderStats = { bytesIn: 0, eventsOut: 0, errors: 0 }
	protected startTime: number = 0
	protected lastOutputAt: Date | null = null
	protected _health: DecoderHealth = "running"
	protected restartCount: number = 0
	protected version: string | undefined = undefined
	protected logger: Logger
	private readonly parseWarnLimit = new LogRateLimiter()
	protected config: DecoderConfig
	protected parseStdout: boolean = true
	protected parseStderr: boolean = true

	/**
	 * Gets the decoder's capabilities (Requirement 17.1).
	 * Delegates to the abstract getCaps() method implemented by subclasses.
	 */
	get caps(): DecoderCaps {
		return this.getCaps()
	}

	constructor(
		config: DecoderConfig,
		logger: Logger,
		wallClock: () => number = Date.now,
	) {
		super()
		this.observability = new DecoderObservability(wallClock)
		this.id = config.id
		this.type = config.type
		this.config = config
		this.logger = createComponentLogger(logger, `Decoder:${config.id}`)

		// Output stream in object mode for DecoderOutput objects
		this.outputStream = new PassThrough({ objectMode: true })
	}

	/**
	 * Template method: Returns the command to execute.
	 * Subclasses must implement this to return the decoder executable name.
	 */
	protected abstract getCommand(): string

	/**
	 * Template method: Returns command line arguments.
	 * Subclasses must implement this to return decoder-specific arguments.
	 */
	protected abstract getArgs(): string[]

	/**
	 * Template method: Parses a line of output into a DecoderOutput object.
	 * Subclasses must implement this to parse decoder-specific output formats.
	 *
	 * @param line - A line of text from stdout or stderr
	 * @returns DecoderOutput object if the line was parsed, null to skip
	 */
	protected abstract parseOutput(line: string): DecoderOutput | null

	/**
	 * Template method: Returns the decoder's capabilities (Requirement 17.1).
	 * Subclasses must implement this to declare their input/output capabilities.
	 *
	 * @returns DecoderCaps describing the decoder's capabilities
	 */
	protected abstract getCaps(): DecoderCaps

	/**
	 * Starts the decoder process (Requirement 4.1).
	 * Spawns the process with stdio piping and sets up output parsing.
	 *
	 * @throws DecoderSpawnError if the process fails to start
	 */
	async start(): Promise<void> {
		if (this.process) {
			this.logger.warn("Decoder already running, ignoring start request")
			return
		}

		const command = this.getCommand()
		const args = this.getArgs()

		// argv carries option text: count only (WG7 HW fix).
		this.logger.info(
			{ command, argCount: args.length },
			"Starting decoder process",
		)

		const direct = this.takeDirectInput(command)

		// The new child's counters start at 0; lines of the old one count nothing.
		const counterGeneration = this.counters.restart()
		try {
			this.process = spawn(command, args, {
				env: csdrChildEnv(),
				stdio: [direct ?? "pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			})
		} catch (err) {
			direct?.destroy()
			const error = err instanceof Error ? err : new Error(String(err))
			throw new DecoderSpawnError(this.id, command, error)
		}
		// The child has its own descriptor now (or none: a failed spawn reports `error` next). Node's copy closes
		// here, so the child is the socket's only reader and its exit gives the channelizer a failed write.
		direct?.destroy()

		// Keep the spawned process reference stable across exit/error callbacks.
		const proc = this.process
		const spawned = new Promise<void>((resolve, reject) => {
			proc.once("spawn", resolve)
			proc.once("error", err => {
				if (proc.pid === undefined && this.process === proc) {
					this.process = null
				}
				reject(new DecoderSpawnError(this.id, command, err))
			})
		})

		// Handle spawn errors (e.g., command not found)
		this.process.on("error", (err: Error) => {
			this.logger.error({ err: safeErrorFields(err) }, "Decoder process error")
			this.stats.errors++
			if (this.listenerCount("error") > 0) {
				this.emit("error", new DecoderSpawnError(this.id, command, err))
			}
		})

		// Handle process exit (Requirement 4.6)
		this.process.on("exit", (code, signal) => {
			try {
				signalDecoder(proc, "SIGKILL")
			} catch (err) {
				this.logger.error(
					{ err: safeErrorFields(err), pid: proc.pid },
					"Failed to clean up decoder process group",
				)
			}
			this.logger.info({ code, signal }, "Decoder process exited")
			this.counters.flush()
			if (this.process === proc) this.process = null
			this.emit("exit", code, signal)
		})

		if (this.process.stdout)
			this.observability.captureLog(this.process.stdout, "stdout")
		if (this.process.stderr)
			this.observability.captureLog(this.process.stderr, "stderr")
		// A pipe error (e.g. ECONNRESET when the child dies mid-write) on an output stream, or the
		// same error re-emitted by a readline interface, would crash the process unhandled.
		const onOutputError =
			(source: "stdout" | "stderr") =>
			(err: unknown): void => {
				this.logger.warn(
					{ err: safeErrorFields(err), source },
					"Decoder output stream error",
				)
			}
		this.process.stdout?.on("error", onOutputError("stdout"))
		this.process.stderr?.on("error", onOutputError("stderr"))

		// Parse stdout line by line (Requirement 4.4)
		if (this.process.stdout) {
			if (this.parseStdout) {
				const stdoutReader = createInterface({
					input: this.process.stdout,
					crlfDelay: Infinity,
				})

				stdoutReader.on("error", onOutputError("stdout"))
				stdoutReader.on("line", (line: string) => {
					this.counters.scope(counterGeneration, () => {
						this.handleOutputLine(line)
					})
				})
			} else {
				// Drain stdout if not parsing to prevent buffer filling
				this.process.stdout.resume()
			}
		}

		// Parse stderr line by line (some decoders output to stderr)
		if (this.process.stderr) {
			if (this.parseStderr) {
				const stderrReader = createInterface({
					input: this.process.stderr,
					crlfDelay: Infinity,
				})

				stderrReader.on("error", onOutputError("stderr"))
				stderrReader.on("line", (line: string) => {
					this.counters.scope(counterGeneration, () => {
						this.handleOutputLine(line)
					})
				})
			} else {
				// Drain stderr if not parsing
				this.process.stderr.resume()
			}
		}

		// Registered after the readers: on `end`, a reader parses its last line before these listeners run.
		this.outputDrain = streamsEnded(this.process.stdout, this.process.stderr)
		this.outputStreams = [this.process.stdout, this.process.stderr].filter(
			(stream): stream is Readable => stream !== null,
		)

		// Pipe input stream to process stdin if attached
		if (this.inputStream && this.process.stdin) {
			this.inputStream.pipe(this.process.stdin)
		}

		// Input can be attached after start; stdin errors must always be handled.
		this.process.stdin?.on("error", err => {
			if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
				this.logger.warn({ err: safeErrorFields(err) }, "Decoder stdin error")
			}
		})

		await spawned
		this.startTime = Date.now()
		this.emit("started")
		this.logger.info({ pid: this.process.pid }, "Decoder started")
	}

	/**
	 * SIGKILL this long after SIGTERM when a stop has not finished (a manager
	 * may shorten it). Read when a stop arms its kill timer; a stop already
	 * pending follows a shorter value through shortenStopKill.
	 */
	stopKillAfterMs = GRACEFUL_STOP_TIMEOUT
	/** The armed SIGKILL of a pending stop: its SIGTERM time and due time (performance clock). */
	private pendingKill: {
		termAtMs: number
		dueAtMs: number
		timer: ReturnType<typeof setTimeout>
		fire: () => void
	} | null = null

	/**
	 * Sets the SIGKILL delay to `ms` for later stops, and re-arms the kill of a
	 * stop already pending to `ms` after its SIGTERM when that is sooner (at
	 * once when that time has passed). It never delays a pending kill.
	 */
	shortenStopKill(ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) return
		this.stopKillAfterMs = ms
		const pending = this.pendingKill
		if (!pending) return
		const due = pending.termAtMs + ms
		if (due >= pending.dueAtMs) return
		clearTimeout(pending.timer)
		pending.dueAtMs = due
		pending.timer = setTimeout(
			pending.fire,
			Math.max(0, due - performance.now()),
		)
	}

	/**
	 * Stops the decoder process gracefully (Requirement 4.3).
	 * Sends SIGTERM first, waits 5 seconds, then SIGKILL if needed.
	 */
	async stop(): Promise<void> {
		if (!this.process) {
			this.logger.debug("Decoder not running, ignoring stop request")
			return
		}

		const pid = this.process.pid
		this.logger.info({ pid }, "Stopping decoder process")

		return new Promise<void>(resolve => {
			const proc = this.process
			if (!proc) {
				resolve()
				return
			}

			// Set up timeout for SIGKILL (the delay as of now; shortenStopKill
			// may bring it forward).
			const fire = (): void => {
				if (this.pendingKill === kill) this.pendingKill = null
				if (proc.exitCode !== null || proc.signalCode !== null) return
				this.logger.warn({ pid }, "Graceful stop timeout, sending SIGKILL")
				signalDecoder(proc, "SIGKILL")
			}
			const termAtMs = performance.now()
			const kill = {
				termAtMs,
				dueAtMs: termAtMs + this.stopKillAfterMs,
				timer: setTimeout(fire, this.stopKillAfterMs),
				fire,
			}
			// A second stop of the same run arms its own timer; the earlier one
			// still fires (each checks for an exit first).
			this.pendingKill = kill

			// Failed spawns emit close without exit; running processes emit exit
			// before inherited pipeline stdio necessarily closes.
			const finish = (): void => {
				clearTimeout(kill.timer)
				if (this.pendingKill === kill) this.pendingKill = null
				proc.off("exit", finish)
				proc.off("close", finish)
				if (this.process === proc) this.process = null
				this.emit("stopped")
				this.logger.info({ pid }, "Decoder stopped")
				resolve()
			}
			proc.once("exit", finish)
			proc.once("close", finish)

			// Send SIGTERM for graceful shutdown
			if (!proc.killed) signalDecoder(proc, "SIGTERM")
		})
	}

	/**
	 * Settles when the output of the last spawned child has been read to its end (stdout and stderr ended or closed),
	 * at once if none was spawned. The process `exit` can come before that, while lines are still being parsed; a
	 * caller that must act after the run's last line waits for this. Never rejects.
	 */
	outputDrained(): Promise<void> {
		return this.outputDrain
	}

	/**
	 * Gives up on the last spawned child's output: its stdout and stderr are destroyed, so no further line of that run
	 * is parsed and its drain (outputDrained) settles. Only for a run whose process has already exited; idempotent.
	 */
	abandonOutput(): void {
		for (const stream of this.outputStreams)
			if (!stream.destroyed) stream.destroy()
		this.outputStreams = []
	}

	/**
	 * Restarts the decoder process.
	 * Equivalent to stop() followed by start().
	 */
	async restart(): Promise<void> {
		this.logger.info("Restarting decoder")
		await this.stop()
		await this.start()
	}

	/**
	 * Holds a paused channel socket for the next start, which spawns the child with it as stdin. Replaces any
	 * attached input. Bytes are counted from the channelizer's reports instead (addInputBytes).
	 */
	attachDirectInput(socket: DirectChannelSocket): void {
		this.detachInput()
		this.directInput = socket
		this.logger.debug("Direct channel input attached")
	}

	/** Bytes the channelizer reports it wrote to this decoder's channel socket. */
	addInputBytes(bytes: number): void {
		if (Number.isSafeInteger(bytes) && bytes > 0) this.stats.bytesIn += bytes
	}

	/**
	 * Takes the held socket for this spawn. A socket that closed since the grant (the channel ended or was released
	 * while startup awaited) is the table's lost-before-start: no spawn, and a WaveKitError with DIRECT_INPUT_LOST
	 * that the manager turns into the channel-loss hold. One that has read a byte, or is not paused, is refused: those
	 * bytes would never reach the child, and only a programming error gets there.
	 */
	private takeDirectInput(command: string): DirectChannelSocket | null {
		const direct = this.directInput
		this.directInput = null
		if (!direct) return null
		const verdict = directStep(
			{ phase: "wired" },
			{ type: "start", acquired: true, socketDestroyed: direct.destroyed },
		)
		if (verdict.action === "lost-before-start") {
			this.logger.debug("Direct channel input closed before the spawn")
			throw directInputLost(this.id)
		}
		if (
			direct.bytesRead !== 0 ||
			!direct.isPaused() ||
			direct.listenerCount("data") > 0
		) {
			direct.destroy()
			throw new DecoderSpawnError(
				this.id,
				command,
				new Error("direct channel input was read before the hand-over"),
			)
		}
		return direct
	}

	/**
	 * Attaches an input stream to feed audio data to the decoder.
	 * If the decoder is already running, pipes the stream to stdin.
	 *
	 * @param stream - Readable stream of audio data
	 */
	attachInput(stream: Readable): void {
		this.detachInput()
		// Another input replaces a direct grant this decoder no longer starts with.
		this.directInput = null
		this.inputStream = stream

		// Track bytes received
		stream.on("data", this.trackInputBytes)
		stream.on("error", this.handleInputError)

		// If process is already running, pipe to stdin
		if (this.process?.stdin) {
			stream.pipe(this.process.stdin)
		}

		this.logger.debug("Input stream attached")
	}

	/**
	 * Detaches the current input stream.
	 */
	detachInput(): void {
		// A held socket no spawn took is abandoned: Node's copy is the only one, so it closes here. The closed socket
		// stays held as the grant's identity (takeDirectInput).
		this.directInput?.destroy()
		if (this.inputStream) {
			// Unpipe from process stdin if connected
			if (this.process?.stdin) {
				this.inputStream.unpipe(this.process.stdin)
			}
			this.inputStream.off("data", this.trackInputBytes)
			this.inputStream.off("error", this.handleInputError)
			this.inputStream = null
			this.logger.debug("Input stream detached")
		}
	}

	/**
	 * Gets the output stream for decoder events.
	 * @returns Object mode Readable stream of DecoderOutput objects
	 */
	getOutput(): Readable {
		return this.outputStream
	}

	/**
	 * Gets the audio output stream if the decoder produces audio.
	 * Base implementation returns null; subclasses can override.
	 *
	 * @returns Readable stream of audio data, or null if not available
	 */
	getAudioOutput(): Readable | null {
		return this.audioOutputStream
	}

	/**
	 * Gets the current status of the decoder (Requirements 4.5, 20.1, 20.2, 20.3).
	 * @returns DecoderStatus with running state, PID, uptime, health, and statistics
	 */
	getStatus(): DecoderStatus {
		const running = this.process !== null
		const uptime = running
			? Math.floor((Date.now() - this.startTime) / 1000)
			: 0

		return {
			id: this.id,
			type: this.type,
			running,
			health: this._health,
			pid: this.process?.pid,
			uptime,
			stats: { ...this.stats },
			rateHistory: this.observability.getRateHistory(),
			lastOutputAt: this.lastOutputAt ?? undefined,
			restartCount: this.restartCount,
			version: this.version,
		}
	}

	getLog(lines = 200): Array<{ stream: "stdout" | "stderr"; line: string }> {
		return this.observability.getLog(lines)
	}

	/**
	 * Gets the current health state of the decoder (Requirements 20.1, 20.2, 20.3).
	 * @returns Current health state
	 */
	getHealth(): DecoderHealth {
		return this._health
	}

	/**
	 * Sets the health state and emits a health event if changed (Requirement 20.4).
	 * @param health - New health state
	 */
	protected setHealth(health: DecoderHealth): void {
		if (this._health !== health) {
			const previousHealth = this._health
			this._health = health
			this.logger.info(
				{ previousHealth, newHealth: health },
				"Decoder health changed",
			)
			this.emit("health", health)
		}
	}

	/**
	 * Increments the restart count.
	 * Called by DecoderManager when restarting the decoder.
	 */
	incrementRestartCount(): void {
		this.restartCount++
	}

	/**
	 * Resets the restart count.
	 * Called when the decoder is manually started.
	 */
	resetRestartCount(): void {
		this.restartCount = 0
	}

	/**
	 * Updates decoder options at runtime.
	 * Used for dynamic sample rate changes before restart.
	 *
	 * Subclasses that cache parsed options should override onOptionsUpdated()
	 * to re-parse their typed options from this.config.options.
	 *
	 * @param updates - Partial options to merge with existing
	 */
	updateOptions(updates: Record<string, unknown>): void {
		this.config.options = { ...this.config.options, ...updates }
		// Count only: keys and values are option text (WG7 HW fix).
		this.logger.debug(
			{ updateCount: Object.keys(updates).length },
			"Decoder options updated",
		)
		this.onOptionsUpdated()
	}

	/**
	 * Hook called after options are updated via updateOptions().
	 * Subclasses should override this to re-parse typed options.
	 *
	 * Default implementation is a no-op.
	 */
	protected onOptionsUpdated(): void {
		// No-op in base class. Subclasses override to re-parse options.
	}

	/**
	 * Publishes one decoder output: counts it in stats.eventsOut, stamps
	 * lastOutputAt, writes the output stream and emits "output". Subclasses
	 * that produce events outside parseOutput (timers, async lookups) must use
	 * this instead of emitting "output" directly, or REST status never moves.
	 */
	protected emitOutput(output: DecoderOutput): void {
		this.stats.eventsOut++
		this.lastOutputAt = this.observability.countOutput()
		this.outputStream.write(output)
		this.emit("output", output)

		// Update health to running when we receive output (Requirement 20.1)
		if (this._health === "idle") {
			this.setHealth("running")
		}
	}

	/**
	 * Handles a line of output from stdout or stderr.
	 * Calls the subclass parseOutput method and emits the result.
	 * Updates lastOutputAt and health state on successful output.
	 *
	 * @param line - A line of text from the decoder process
	 */
	private handleOutputLine(line: string): void {
		if (!line.trim()) return

		try {
			const output = this.parseOutput(line)
			if (output) this.emitOutput(output)
		} catch (err) {
			// Decoder output line: documented diagnostic exception to the no-option-text log rule (Main, WG7 HW R2).
			// One line per minute at most (hot-path log policy); `suppressed` counts the rest.
			const suppressed = this.parseWarnLimit.take("parse")
			if (suppressed !== null)
				this.logger.warn(
					{ line, err: safeErrorFields(err), suppressed },
					"Failed to parse decoder output",
				)
			this.stats.errors++
		}
	}
}

/** Settles when every given stream has ended or closed (a destroyed stream closes without ending). */
function streamsEnded(...streams: Array<Readable | null>): Promise<void> {
	return Promise.all(
		streams.map(stream =>
			stream === null
				? Promise.resolve()
				: new Promise<void>(resolve => {
						stream.once("end", resolve)
						stream.once("close", resolve)
					}),
		),
	).then(() => undefined)
}

/**
 * The drain of a decoder's last run (BaseDecoder.outputDrained); settled at once for a decoder that is not a
 * BaseDecoder, whose output the manager cannot see the end of.
 */
export function decoderOutputDrained(decoder: object): Promise<void> {
	return decoder instanceof BaseDecoder
		? decoder.outputDrained()
		: Promise.resolve()
}

/** BaseDecoder.abandonOutput on a BaseDecoder; nothing for another decoder, whose output the manager cannot see. */
export function abandonDecoderOutput(decoder: object): void {
	if (decoder instanceof BaseDecoder) decoder.abandonOutput()
}

/** BaseDecoder.shortenStopKill for a manager-held decoder (a no-op for others). */
export function shortenDecoderStopKill(decoder: object, ms: number): void {
	if (decoder instanceof BaseDecoder) decoder.shortenStopKill(ms)
}

/** Restores the default SIGKILL delay for later stops (a pending stop keeps its timer). */
export function resetDecoderStopKill(decoder: object): void {
	if (decoder instanceof BaseDecoder)
		decoder.stopKillAfterMs = GRACEFUL_STOP_TIMEOUT
}
