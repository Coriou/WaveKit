/**
 * External SDR Decoder - Abstract base class for decoders managing own SDR hardware
 *
 * Requirements:
 * - 19.1: WHEN an external SDR decoder is started, THE Decoder_Manager SHALL spawn it with SDR device configuration (serial, frequency, gain)
 * - 19.2: WHEN the decoder is running, THE Decoder_Manager SHALL NOT attempt to pipe audio to it
 * - 19.3: WHEN the decoder produces output, THE Decoder_Manager SHALL parse it into structured DecoderOutput objects
 * - 19.4: THE Decoder_Manager SHALL pass device serial numbers to external decoders for multi-dongle setups
 * - 17.1: Decoder capabilities declaration
 * - 20.1: Report health as "running" when producing output
 * - 20.2: Report health as "idle" when no output for configured timeout
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
 * Extended configuration for external SDR decoders (Requirement 19.1, 19.4).
 */
export interface ExternalSdrConfig extends DecoderConfig {
	/** Device serial number for multi-dongle setups (Requirement 19.4) */
	deviceSerial: string
	/** Frequencies to monitor in Hz */
	frequencies: number[]
	/** Gain setting for the SDR device */
	gain?: number
	/** PPM correction for the SDR device */
	ppm?: number
}

/**
 * ExternalSdrDecoder - Abstract base class for decoders that manage their own SDR hardware.
 *
 * This pattern is used for decoders like acarsdec and dumpvdl2 that:
 * - Require direct control of an RTL-SDR device
 * - Cannot share the SDR with other decoders
 * - Don't receive audio input via stdin (Requirement 19.2)
 *
 * Uses the Template Method pattern where subclasses implement:
 * - getCommand(): The executable command to spawn
 * - getArgs(): Command line arguments including device serial and frequencies (Requirement 19.1)
 * - parseOutput(line): Parse stdout/stderr lines into DecoderOutput objects (Requirement 19.3)
 * - getCaps(): Return the decoder's capabilities
 *
 * Handles:
 * - Process spawning with device configuration (Requirement 19.1)
 * - Device serial passing for multi-dongle setups (Requirement 19.4)
 * - Output stream in object mode for DecoderOutput
 * - Statistics tracking (bytesIn, eventsOut, errors)
 * - Status reporting (running, pid, uptime, health)
 * - Health state tracking (running, idle, faulted)
 */
export abstract class ExternalSdrDecoder
	extends EventEmitter
	implements Decoder
{
	readonly id: string
	readonly type: string

	protected process: ChildProcess | null = null
	protected outputStream: PassThrough
	protected stats: DecoderStats = { bytesIn: 0, eventsOut: 0, errors: 0 }
	protected startTime: number = 0
	protected lastOutputAt: Date | null = null
	protected _health: DecoderHealth = "running"
	protected restartCount: number = 0
	protected version: string | undefined = undefined
	protected logger: Logger
	protected config: ExternalSdrConfig

	/**
	 * Gets the decoder's capabilities (Requirement 17.1).
	 * Delegates to the abstract getCaps() method implemented by subclasses.
	 */
	get caps(): DecoderCaps {
		return this.getCaps()
	}

	constructor(config: ExternalSdrConfig, logger: Logger) {
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
	 * Subclasses must implement this to return decoder-specific arguments
	 * including device serial and frequencies (Requirement 19.1).
	 */
	protected abstract getArgs(): string[]

	/**
	 * Template method: Parses a line of output into a DecoderOutput object.
	 * Subclasses must implement this to parse decoder-specific output formats
	 * (Requirement 19.3).
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
	 * Gets the device serial number for this decoder (Requirement 19.4).
	 * @returns The configured device serial number
	 */
	getDeviceSerial(): string {
		return this.config.deviceSerial
	}

	/**
	 * Gets the frequencies this decoder is monitoring.
	 * @returns Array of frequencies in Hz
	 */
	getFrequencies(): number[] {
		return [...this.config.frequencies]
	}

	/**
	 * Starts the decoder process with SDR device configuration (Requirement 19.1).
	 * Spawns the process with device serial, frequencies, and gain settings.
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

		this.logger.info(
			{
				command,
				args,
				deviceSerial: this.config.deviceSerial,
				frequencies: this.config.frequencies,
			},
			"Starting external SDR decoder",
		)

		try {
			// External SDR decoders don't receive stdin input (Requirement 19.2)
			this.process = spawn(command, args, {
				stdio: ["ignore", "pipe", "pipe"],
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

		// Handle process exit
		this.process.on("exit", (code, signal) => {
			this.logger.info({ code, signal }, "Decoder process exited")
			this.process = null
			this.emit("exit", code, signal)
		})

		// Parse stdout line by line (Requirement 19.3)
		if (this.process.stdout) {
			const stdoutReader = createInterface({
				input: this.process.stdout,
				crlfDelay: Infinity,
			})

			stdoutReader.on("line", (line: string) => {
				this.handleOutputLine(line)
			})
		}

		// Parse stderr line by line (some decoders output to stderr)
		if (this.process.stderr) {
			const stderrReader = createInterface({
				input: this.process.stderr,
				crlfDelay: Infinity,
			})

			stderrReader.on("line", (line: string) => {
				this.handleOutputLine(line)
			})
		}

		this.startTime = Date.now()
		this.emit("started")
		this.logger.info(
			{ pid: this.process.pid, deviceSerial: this.config.deviceSerial },
			"External SDR decoder started",
		)
	}

	/**
	 * Stops the decoder process gracefully.
	 * Sends SIGTERM first, waits 5 seconds, then SIGKILL if needed.
	 */
	async stop(): Promise<void> {
		if (!this.process) {
			this.logger.debug("Decoder not running, ignoring stop request")
			return
		}

		const pid = this.process.pid
		this.logger.info({ pid }, "Stopping external SDR decoder")

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
				this.logger.info({ pid }, "External SDR decoder stopped")
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
		this.logger.info("Restarting external SDR decoder")
		await this.stop()
		await this.start()
	}

	/**
	 * External SDR decoders don't use stdin input - this is a no-op (Requirement 19.2).
	 * @param _stream - Ignored
	 */
	attachInput(_stream: Readable): void {
		// External SDR decoders don't receive audio via stdin (Requirement 19.2)
		this.logger.debug("attachInput called on external SDR decoder (no-op)")
	}

	/**
	 * External SDR decoders don't use stdin input - this is a no-op (Requirement 19.2).
	 */
	detachInput(): void {
		// External SDR decoders don't receive audio via stdin (Requirement 19.2)
		this.logger.debug("detachInput called on external SDR decoder (no-op)")
	}

	/**
	 * Gets the output stream for decoder events.
	 * @returns Object mode Readable stream of DecoderOutput objects
	 */
	getOutput(): Readable {
		return this.outputStream
	}

	/**
	 * External SDR decoders typically don't produce audio output.
	 * @returns null (subclasses can override if they produce audio)
	 */
	getAudioOutput(): Readable | null {
		return null
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
	 * Updates decoder options at runtime.
	 * External SDR decoders don't typically use inputSampleRate since they manage
	 * their own SDR, but this method is required for Decoder interface compliance.
	 *
	 * @param updates - Partial options to merge with existing
	 */
	updateOptions(updates: Record<string, unknown>): void {
		this.config.options = { ...this.config.options, ...updates }
		this.logger.debug({ updates }, "Decoder options updated")
		this.onOptionsUpdated()
	}

	/**
	 * Hook called after options are updated.
	 * Subclasses can override to re-parse typed options.
	 */
	protected onOptionsUpdated(): void {
		// No-op in base class. Subclasses override if needed.
	}

	/**
	 * Handles a line of output from stdout or stderr (Requirement 19.3).
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
