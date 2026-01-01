/**
 * Audio Output - TCP server for streaming decoded audio to host players
 *
 * Requirements:
 * - 11.1: Listen on configured TCP port when started
 * - 11.2: Stream decoded audio in configured format when client connects
 * - 11.3: Stream to all connected clients (multi-client fanout)
 * - 11.4: Clean up resources when client disconnects
 * - 11.5: Support S16LE format at 48kHz sample rate
 */

import { EventEmitter } from "node:events"
import * as net from "node:net"
import type { Readable } from "node:stream"
import { createComponentLogger, type Logger } from "../utils/logger.js"

export interface AudioOutputConfig {
	port: number
	format: "S16LE" | "FLOAT32LE"
	sampleRate: number
}

export interface AudioOutputEvents {
	"client-connected": (clientId: string) => void
	"client-disconnected": (clientId: string) => void
	started: (port: number) => void
	stopped: () => void
	error: (error: Error) => void
}

interface ClientState {
	socket: net.Socket
	id: string
	connectedAt: Date
	bytesWritten: number
}

export class AudioOutput extends EventEmitter {
	private readonly log: Logger
	private readonly config: AudioOutputConfig
	private server: net.Server | null = null
	private clients: Map<string, ClientState> = new Map()
	private source: Readable | null = null
	private dataHandler: ((chunk: Buffer) => void) | null = null
	private clientIdCounter = 0

	constructor(logger: Logger, config: AudioOutputConfig) {
		super()
		this.log = createComponentLogger(logger, "AudioOutput")
		this.config = config
	}

	/**
	 * Start the TCP server and begin listening for client connections.
	 * Requirement 11.1: Listen on configured TCP port when started
	 */
	async start(): Promise<void> {
		if (this.server) {
			this.log.warn("Audio output server already running")
			return
		}

		return new Promise((resolve, reject) => {
			this.server = net.createServer(socket =>
				this.handleClientConnection(socket),
			)

			this.server.on("error", err => {
				this.log.error({ err }, "Server error")
				this.emit("error", err)
				reject(err)
			})

			this.server.listen(this.config.port, () => {
				this.log.info(
					{
						port: this.config.port,
						format: this.config.format,
						sampleRate: this.config.sampleRate,
					},
					"Audio output server started",
				)
				this.emit("started", this.config.port)
				resolve()
			})
		})
	}

	/**
	 * Stop the TCP server and disconnect all clients.
	 */
	async stop(): Promise<void> {
		if (!this.server) {
			this.log.warn("Audio output server not running")
			return
		}

		// Detach source first to stop data flow
		this.detachSource()

		// Close all client connections
		for (const [clientId, client] of this.clients) {
			this.log.debug({ clientId }, "Closing client connection on shutdown")
			client.socket.destroy()
		}
		this.clients.clear()

		return new Promise((resolve, reject) => {
			this.server!.close(err => {
				if (err) {
					this.log.error({ err }, "Error closing server")
					reject(err)
					return
				}

				this.server = null
				this.log.info("Audio output server stopped")
				this.emit("stopped")
				resolve()
			})
		})
	}

	/**
	 * Attach a source stream to distribute audio from.
	 * Requirement 11.2: Stream decoded audio when client connects
	 */
	attachSource(stream: Readable): void {
		if (this.source) {
			this.detachSource()
		}

		this.source = stream
		this.dataHandler = (chunk: Buffer) => this.distributeToClients(chunk)

		stream.on("data", this.dataHandler)
		stream.on("error", err => {
			this.log.error({ err }, "Source stream error")
		})
		stream.on("end", () => {
			this.log.info("Source stream ended")
		})

		this.log.info("Audio source attached")
	}

	/**
	 * Detach the current source stream.
	 */
	detachSource(): void {
		if (this.source && this.dataHandler) {
			this.source.removeListener("data", this.dataHandler)
			this.dataHandler = null
			this.source = null
			this.log.info("Audio source detached")
		}
	}

	/**
	 * Get the number of currently connected clients.
	 */
	getConnectedClients(): number {
		return this.clients.size
	}

	/**
	 * Get the configured port.
	 */
	getPort(): number {
		return this.config.port
	}

	/**
	 * Handle a new client connection.
	 * Requirement 11.2: Stream decoded audio in configured format
	 * Requirement 11.4: Clean up resources when client disconnects
	 */
	private handleClientConnection(socket: net.Socket): void {
		const clientId = `client-${++this.clientIdCounter}`
		const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`

		const clientState: ClientState = {
			socket,
			id: clientId,
			connectedAt: new Date(),
			bytesWritten: 0,
		}

		this.clients.set(clientId, clientState)
		this.log.info(
			{ clientId, remoteAddress, totalClients: this.clients.size },
			"Client connected",
		)
		this.emit("client-connected", clientId)

		// Handle client errors gracefully
		socket.on("error", err => {
			// ECONNRESET and EPIPE are expected when clients disconnect abruptly
			if (
				(err as NodeJS.ErrnoException).code === "ECONNRESET" ||
				(err as NodeJS.ErrnoException).code === "EPIPE"
			) {
				this.log.debug(
					{ clientId, err: err.message },
					"Client connection reset",
				)
			} else {
				this.log.error({ clientId, err }, "Client socket error")
			}
		})

		// Requirement 11.4: Clean up resources when client disconnects
		socket.on("close", () => {
			this.cleanupClient(clientId)
		})

		// Handle client end (graceful disconnect)
		socket.on("end", () => {
			this.log.debug({ clientId }, "Client ended connection")
		})
	}

	/**
	 * Clean up resources for a disconnected client.
	 * Requirement 11.4: Clean up resources when client disconnects
	 */
	private cleanupClient(clientId: string): void {
		const client = this.clients.get(clientId)
		if (!client) {
			return
		}

		this.clients.delete(clientId)
		this.log.info(
			{
				clientId,
				bytesWritten: client.bytesWritten,
				totalClients: this.clients.size,
			},
			"Client disconnected",
		)
		this.emit("client-disconnected", clientId)
	}

	/**
	 * Distribute audio data to all connected clients.
	 * Requirement 11.3: Stream to all connected clients (multi-client fanout)
	 */
	private distributeToClients(chunk: Buffer): void {
		for (const [clientId, client] of this.clients) {
			// Check if socket is still writable
			if (!client.socket.writable) {
				this.log.debug({ clientId }, "Client socket not writable, skipping")
				continue
			}

			// Write data to client - don't wait for drain (real-time priority)
			const canWrite = client.socket.write(chunk)
			client.bytesWritten += chunk.length

			if (!canWrite) {
				// Client is slow, but we continue (real-time audio priority)
				// The socket will buffer and eventually catch up or disconnect
				this.log.debug({ clientId }, "Client backpressure detected")
			}
		}
	}

	/**
	 * Destroy the audio output and clean up all resources.
	 */
	destroy(): void {
		this.stop().catch(err => {
			this.log.error({ err }, "Error during destroy")
		})
	}
}
