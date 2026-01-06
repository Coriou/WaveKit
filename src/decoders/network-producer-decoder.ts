/**
 * Network Producer Decoder - Abstract base class for decoders with network outputs
 *
 * Requirements:
 * - 18.1: WHEN a network producer decoder is started, THE Decoder_Manager SHALL spawn the process and connect to its output port
 * - 18.2: WHEN the decoder produces output on its network port, THE Decoder_Manager SHALL parse it into structured DecoderOutput objects
 * - 18.3: WHEN the network connection is lost, THE Decoder_Manager SHALL attempt reconnection with exponential backoff
 * - 18.4: THE Decoder_Manager SHALL support output protocols: TCP, UDP
 * - 17.1: Decoder capabilities declaration
 * - 20.1: Report health as "running" when producing output
 * - 20.2: Report health as "degraded" when no output for configured timeout
 * - 20.3: Report health as "faulted" when crashed and exceeded restart limits
 * - 20.4: Emit health events when health changes
 */

import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import { createConnection, type Socket } from "node:net"
import { createSocket, type Socket as UdpSocket } from "node:dgram"
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
import { DecoderSpawnError, NetworkConnectionError } from "../utils/errors.js"
import { createComponentLogger } from "../utils/logger.js"

/** Timeout in ms to wait for graceful shutdown before SIGKILL */
const GRACEFUL_STOP_TIMEOUT = 5000

/** Base delay for exponential backoff (ms) */
const BASE_RECONNECT_DELAY = 2000

/** Maximum delay for exponential backoff (ms) */
const MAX_RECONNECT_DELAY = 30000

/**
 * Extended configuration for network producer decoders.
 */
export interface NetworkProducerConfig extends DecoderConfig {
	/** Host to connect to for network output */
	outputHost: string
	/** Port to connect to for network output */
	outputPort: number
	/** Protocol for network output (tcp or udp) */
	outputProtocol: "tcp" | "udp"
}

/**
 * NetworkProducerDecoder - Abstract base class for decoders that run as network services.
 *
 * This pattern is used for decoders like readsb (ADS-B) and AIS-catcher that:
 * - Run as standalone processes
 * - Expose their output via TCP or UDP ports
 * - Don't receive audio input via stdin
 *
 * Uses the Template Method pattern where subclasses implement:
 * - getCommand(): The executable command to spawn
 * - getArgs(): Command line arguments for the process
 * - parseNetworkData(data): Parse network data into DecoderOutput objects
 * - getCaps(): Return the decoder's capabilities
 *
 * Handles:
 * - Process spawning
 * - TCP/UDP client connection to output port (Requirement 18.4)
 * - Reconnection with exponential backoff (Requirement 18.3)
 * - Output stream in object mode for DecoderOutput
 * - Statistics tracking (bytesIn, eventsOut, errors)
 * - Status reporting (running, pid, uptime, health)
 * - Health state tracking (running, degraded, faulted)
 */
export abstract class NetworkProducerDecoder
	extends EventEmitter
	implements Decoder
{
	readonly id: string
	readonly type: string

	protected process: ChildProcess | null = null
	protected tcpClient: Socket | null = null
	protected udpClient: UdpSocket | null = null
	protected inputStream: Readable | null = null
	protected outputStream: PassThrough
	protected stats: DecoderStats = { bytesIn: 0, eventsOut: 0, errors: 0 }
	protected startTime: number = 0
	protected lastOutputAt: Date | null = null
	protected _health: DecoderHealth = "running"
	protected restartCount: number = 0
	protected version: string | undefined = undefined
	protected logger: Logger
	protected config: NetworkProducerConfig

	// Reconnection state
	protected reconnectAttempts: number = 0
	protected reconnectTimer: ReturnType<typeof setTimeout> | null = null
	protected isReconnecting: boolean = false
	protected isStopping: boolean = false

	/**
	 * Gets the decoder's capabilities (Requirement 17.1).
	 * Delegates to the abstract getCaps() method implemented by subclasses.
	 */
	get caps(): DecoderCaps {
		return this.getCaps()
	}

	constructor(config: NetworkProducerConfig, logger: Logger) {
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
	 * Template method: Parses network data into DecoderOutput objects.
	 * Subclasses must implement this to parse decoder-specific output formats.
	 *
	 * @param data - Buffer of data received from the network
	 * @returns Array of DecoderOutput objects parsed from the data
	 */
	protected abstract parseNetworkData(data: Buffer): DecoderOutput[]

	/**
	 * Template method: Returns the decoder's capabilities (Requirement 17.1).
	 * Subclasses must implement this to declare their input/output capabilities.
	 *
	 * @returns DecoderCaps describing the decoder's capabilities
	 */
	protected abstract getCaps(): DecoderCaps

	/**
	 * Starts the decoder process and connects to its output port (Requirement 18.1).
	 *
	 * @throws DecoderSpawnError if the process fails to start
	 */
	async start(): Promise<void> {
		if (this.process) {
			this.logger.warn("Decoder already running, ignoring start request")
			return
		}

		this.isStopping = false
		const command = this.getCommand()
		const args = this.getArgs()

		this.logger.info({ command, args }, "Starting network producer decoder")

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

		// Handle process exit
		this.process.on("exit", (code, signal) => {
			this.logger.info({ code, signal }, "Decoder process exited")
			this.process = null
			this.disconnectFromOutput()
			this.emit("exit", code, signal)
		})

		// Log stdout/stderr for debugging (some decoders output status info)
		if (this.process.stdout) {
			this.process.stdout.on("data", (data: Buffer) => {
				this.logger.debug({ output: data.toString().trim() }, "Process stdout")
			})
		}

		if (this.process.stderr) {
			this.process.stderr.on("data", (data: Buffer) => {
				this.logger.debug({ output: data.toString().trim() }, "Process stderr")
			})
		}

		// Pipe input stream to process stdin if attached
		if (this.inputStream && this.process.stdin) {
			this.inputStream.pipe(this.process.stdin)
			this.inputStream.on("data", (chunk: Buffer) => {
				this.stats.bytesIn += chunk.length
			})
		}

		this.startTime = Date.now()

		// Connect to the output port after a short delay to let the process start
		await this.connectToOutput()

		this.emit("started")
		this.logger.info(
			{ pid: this.process?.pid },
			"Network producer decoder started",
		)
	}

	/**
	 * Stops the decoder process gracefully.
	 * Sends SIGTERM first, waits 5 seconds, then SIGKILL if needed.
	 */
	async stop(): Promise<void> {
		this.isStopping = true

		// Cancel any pending reconnection
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}

		// Disconnect from output
		this.disconnectFromOutput()

		if (!this.process) {
			this.logger.debug("Decoder not running, ignoring stop request")
			return
		}

		const pid = this.process.pid
		this.logger.info({ pid }, "Stopping network producer decoder")

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
				this.logger.info({ pid }, "Network producer decoder stopped")
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
		this.logger.info("Restarting network producer decoder")
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

		this.logger.debug("Input stream attached to network producer decoder")
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
			this.logger.debug("Input stream detached from network producer decoder")
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
	 * Network producer decoders typically don't produce audio output.
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
	 * Connects to the decoder's output port (Requirements 18.1, 18.4).
	 * Supports both TCP and UDP protocols.
	 */
	protected async connectToOutput(): Promise<void> {
		const { outputHost, outputPort, outputProtocol } = this.config

		this.logger.info(
			{ host: outputHost, port: outputPort, protocol: outputProtocol },
			"Connecting to decoder output",
		)

		if (outputProtocol === "udp") {
			await this.connectUdp()
		} else {
			await this.connectTcp()
		}
	}

	/**
	 * Connects to the decoder's TCP output port.
	 */
	private async connectTcp(): Promise<void> {
		const { outputHost, outputPort } = this.config

		return new Promise<void>((resolve, reject) => {
			this.tcpClient = createConnection(
				{ host: outputHost, port: outputPort },
				() => {
					this.logger.info(
						{ host: outputHost, port: outputPort },
						"Connected to TCP output",
					)
					this.reconnectAttempts = 0
					this.isReconnecting = false
					resolve()
				},
			)

			this.tcpClient.on("data", (data: Buffer) => {
				this.handleNetworkData(data)
			})

			this.tcpClient.on("error", (err: Error) => {
				this.logger.error({ err }, "TCP connection error")
				this.stats.errors++

				// Only reject if this is the initial connection
				if (!this.isReconnecting && this.reconnectAttempts === 0) {
					reject(new NetworkConnectionError(outputHost, outputPort, "tcp", err))
				}
			})

			this.tcpClient.on("close", () => {
				this.logger.info("TCP connection closed")
				this.tcpClient = null

				// Attempt reconnection if not stopping (Requirement 18.3)
				if (!this.isStopping && this.process) {
					this.scheduleReconnect()
				}
			})
		})
	}

	/**
	 * Connects to the decoder's UDP output port.
	 */
	private async connectUdp(): Promise<void> {
		const { outputHost, outputPort } = this.config

		return new Promise<void>((resolve, reject) => {
			try {
				this.udpClient = createSocket("udp4")

				this.udpClient.on("message", (data: Buffer) => {
					this.handleNetworkData(data)
				})

				this.udpClient.on("error", (err: Error) => {
					this.logger.error({ err }, "UDP socket error")
					this.stats.errors++
					this.emit(
						"error",
						new NetworkConnectionError(outputHost, outputPort, "udp", err),
					)
				})

				// Bind to receive messages
				this.udpClient.bind(outputPort, () => {
					this.logger.info(
						{ port: outputPort },
						"UDP socket bound for receiving",
					)
					this.reconnectAttempts = 0
					this.isReconnecting = false
					resolve()
				})
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err))
				reject(new NetworkConnectionError(outputHost, outputPort, "udp", error))
			}
		})
	}

	/**
	 * Disconnects from the output port.
	 */
	protected disconnectFromOutput(): void {
		if (this.tcpClient) {
			this.tcpClient.destroy()
			this.tcpClient = null
		}

		if (this.udpClient) {
			this.udpClient.close()
			this.udpClient = null
		}
	}

	/**
	 * Schedules a reconnection attempt with exponential backoff (Requirement 18.3).
	 */
	protected scheduleReconnect(): void {
		if (this.isStopping || this.isReconnecting) {
			return
		}

		this.isReconnecting = true
		this.reconnectAttempts++

		// Calculate delay with exponential backoff
		const delay = Math.min(
			BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
			MAX_RECONNECT_DELAY,
		)

		this.logger.info(
			{ attempt: this.reconnectAttempts, delayMs: delay },
			"Scheduling reconnection to output",
		)

		this.reconnectTimer = setTimeout(() => {
			void this.attemptReconnect()
		}, delay)
	}

	/**
	 * Attempts to reconnect to the output port.
	 * Called by the reconnect timer.
	 */
	private async attemptReconnect(): Promise<void> {
		this.reconnectTimer = null

		if (this.isStopping) {
			return
		}

		try {
			await this.connectToOutput()
		} catch (err) {
			this.logger.error({ err }, "Reconnection failed")
			// Schedule another attempt
			this.isReconnecting = false
			this.scheduleReconnect()
		}
	}

	/**
	 * Handles data received from the network (Requirement 18.2).
	 * Calls the subclass parseNetworkData method and emits the results.
	 *
	 * @param data - Buffer of data received from the network
	 */
	private handleNetworkData(data: Buffer): void {
		this.stats.bytesIn += data.length

		try {
			const outputs = this.parseNetworkData(data)

			for (const output of outputs) {
				this.stats.eventsOut++
				this.lastOutputAt = new Date()
				this.outputStream.write(output)
				this.emit("output", output)

				// Update health to running when we receive output (Requirement 20.1)
				if (this._health === "degraded") {
					this.setHealth("running")
				}
			}
		} catch (err) {
			this.logger.warn(
				{ err, dataLength: data.length },
				"Failed to parse network data",
			)
			this.stats.errors++
		}
	}

	/**
	 * Gets the number of reconnection attempts.
	 * Useful for testing and monitoring.
	 */
	getReconnectAttempts(): number {
		return this.reconnectAttempts
	}

	/**
	 * Checks if the decoder is currently reconnecting.
	 * Useful for testing and monitoring.
	 */
	isCurrentlyReconnecting(): boolean {
		return this.isReconnecting
	}
}
