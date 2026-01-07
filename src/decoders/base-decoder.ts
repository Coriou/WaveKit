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

import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
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
import { createComponentLogger } from "../utils/logger.js"

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
	readonly id: string
	readonly type: string

	protected process: ChildProcess | null = null
	protected inputStream: Readable | null = null
	protected outputStream: PassThrough
	protected audioOutputStream: PassThrough | null = null
	protected stats: DecoderStats = { bytesIn: 0, eventsOut: 0, errors: 0 }
	protected startTime: number = 0
	protected lastOutputAt: Date | null = null
	protected _health: DecoderHealth = "running"
	protected restartCount: number = 0
	protected version: string | undefined = undefined
	protected logger: Logger
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

	constructor(config: DecoderConfig, logger: Logger) {
		super()
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

		this.logger.info({ command, args }, "Starting decoder process")

		try {
			this.process = spawn(command, args, {
				stdio: ["pipe", "pipe", "pipe"],
			})
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			throw new DecoderSpawnError(this.id, command, error)
		}

		// Handle spawn errors (e.g., command not found)
		this.process.on("error", (err: Error) => {
			this.logger.error({ err }, "Decoder process error")
			this.stats.errors++
			this.emit("error", new DecoderSpawnError(this.id, command, err))
		})

		// Handle process exit (Requirement 4.6)
		this.process.on("exit", (code, signal) => {
			this.logger.info({ code, signal }, "Decoder process exited")
			this.process = null
			this.emit("exit", code, signal)
		})

		// Parse stdout line by line (Requirement 4.4)
		if (this.process.stdout) {
			if (this.parseStdout) {
				const stdoutReader = createInterface({
					input: this.process.stdout,
					crlfDelay: Infinity,
				})

				stdoutReader.on("line", (line: string) => {
					this.handleOutputLine(line)
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

				stderrReader.on("line", (line: string) => {
					this.handleOutputLine(line)
				})
			} else {
				// Drain stderr if not parsing
				this.process.stderr.resume()
			}
		}

		// Pipe input stream to process stdin if attached
		if (this.inputStream && this.process.stdin) {
			this.inputStream.pipe(this.process.stdin)
			
			// Handle stdin errors (e.g. EPIPE when process exits)
			// Verified this code is running via log
			this.logger.debug("Attached error handler to decoder process stdin")
			
			this.process.stdin.on("error", (err) => {
				this.logger.warn({ err }, "Decoder stdin error (process likely exited) - Caught by handler")
				// Don't rethrow
			})
			
			// Also catch errors on the input stream itself to be safe
			this.inputStream.on("error", (err) => {
				this.logger.warn({ err }, "Decoder input stream error")
			})

			this.inputStream.on("data", (chunk: Buffer) => {
				this.stats.bytesIn += chunk.length
			})
		}

		this.startTime = Date.now()
		this.emit("started")
		this.logger.info({ pid: this.process.pid }, "Decoder started")
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

			// Set up timeout for SIGKILL
			const killTimeout = setTimeout(() => {
				if (proc.killed) return
				this.logger.warn({ pid }, "Graceful stop timeout, sending SIGKILL")
				proc.kill("SIGKILL")
			}, GRACEFUL_STOP_TIMEOUT)

			// Listen for exit to clean up
			proc.once("exit", () => {
				clearTimeout(killTimeout)
				this.process = null
				this.emit("stopped")
				this.logger.info({ pid }, "Decoder stopped")
				resolve()
			})

			// Send SIGTERM for graceful shutdown
			proc.kill("SIGTERM")
		})
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
	 * Attaches an input stream to feed audio data to the decoder.
	 * If the decoder is already running, pipes the stream to stdin.
	 *
	 * @param stream - Readable stream of audio data
	 */
	attachInput(stream: Readable): void {
		this.detachInput()
		this.inputStream = stream

		// Track bytes received
		stream.on("data", (chunk: Buffer) => {
			this.stats.bytesIn += chunk.length
		})

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
		if (this.inputStream) {
			// Unpipe from process stdin if connected
			if (this.process?.stdin) {
				this.inputStream.unpipe(this.process.stdin)
			}
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
			lastOutputAt: this.lastOutputAt ?? undefined,
			restartCount: this.restartCount,
			version: this.version,
		}
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
			if (output) {
				this.stats.eventsOut++
				this.lastOutputAt = new Date()
				this.outputStream.write(output)
				this.emit("output", output)

				// Update health to running when we receive output (Requirement 20.1)
				if (this._health === "idle") {
					this.setHealth("running")
				}
			}
		} catch (err) {
			this.logger.warn({ line, err }, "Failed to parse decoder output")
			this.stats.errors++
		}
	}
}
