import { createServer, createConnection, Socket, Server } from "node:net"
import { EventEmitter } from "node:events"
import { type Readable } from "node:stream"
import { type Logger } from "../utils/logger.js"

/**
 * PassiveRtlProxy - A TCP proxy/server for RTL-TCP clients.
 *
 * Modes:
 * 1. Proxy Mode: Proxies to a real upstream RTL-TCP server.
 *    - Strips upstream control commands.
 *    - Forwards downstream IQ data.
 * 2. Stream Mode: serves IQ data provided via a Readable stream (internal fanout).
 *    - Synthesizes RTL-TCP header (magic, tuner type, gain count).
 *    - Pipes internal stream to client.
 *    - Ignores client control commands.
 */
export class PassiveRtlProxy extends EventEmitter {
	private server: Server
	private realHost?: string
	private realPort?: number
	private inputStream?: Readable
	private logger: Logger
	private port: number = 0 // Assigned ephemeral port

	constructor(
		target: { host: string; port: number } | { stream: Readable },
		logger: Logger,
	) {
		super()
		this.logger = logger

		if ("stream" in target) {
			this.inputStream = target.stream
		} else {
			this.realHost = target.host
			this.realPort = target.port
		}

		this.server = createServer(clientSocket => {
			this.handleConnection(clientSocket)
		})
	}

	/**
	 * Starts the proxy server on an ephemeral port.
	 * @returns The port number the proxy is listening on.
	 */
	async listen(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server.listen(0, "127.0.0.1", () => {
				const addr = this.server.address()
				if (addr && typeof addr !== "string") {
					this.port = addr.port
					this.logger.info(
						{
							port: this.port,
							mode: this.inputStream ? "stream" : "proxy",
							upstream: this.inputStream
								? "internal"
								: `${this.realHost}:${this.realPort}`,
						},
						"Passive RTL Proxy started",
					)
					resolve(this.port)
				} else {
					reject(new Error("Failed to get proxy port"))
				}
			})

			this.server.on("error", err => {
				reject(err)
			})
		})
	}

	/**
	 * Stops the proxy server.
	 */
	close(): void {
		this.server.close()
		this.logger.info("Passive RTL Proxy stopped")
	}

	private handleConnection(clientSocket: Socket) {
		this.logger.debug("Decoder connected to Passive Proxy")

		if (this.inputStream) {
			this.handleStreamMode(clientSocket, this.inputStream)
		} else if (this.realHost && this.realPort) {
			this.handleProxyMode(clientSocket, this.realHost, this.realPort)
		}
	}

	/**
	 * Handles connection in Stream Mode (Internal IQ Source).
	 */
	private handleStreamMode(clientSocket: Socket, stream: Readable) {
		// 1. Send RTL-TCP Header (12 bytes)
		// Magic "RTL0" (4 bytes)
		// Tuner Type (4 bytes) - 5 (R820T)
		// Gain Count (4 bytes) - 29 (Standard)
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, 4, "ascii")
		header.writeUInt32BE(5, 4) // Tuner Type 5
		header.writeUInt32BE(29, 8) // Gain Count 29

		clientSocket.write(header)

		// 2. Pipe internal stream to client
		stream.pipe(clientSocket)

		// 3. Handle upstream data (ignore/drop)
		clientSocket.on("data", data => {
			// Drop control commands
		})

		clientSocket.on("error", err => {
			this.logger.error({ err }, "Client connection error (Stream Mode)")
			// Don't destroy input stream! It's shared.
			stream.unpipe(clientSocket)
		})

		clientSocket.on("close", () => {
			stream.unpipe(clientSocket)
		})
	}

	/**
	 * Handles connection in Proxy Mode (Upstream RTL-TCP).
	 */
	private handleProxyMode(clientSocket: Socket, host: string, port: number) {
		// Connect to the real RTL-TCP server
		const upstreamSocket = createConnection({ host, port }, () => {
			this.logger.debug("Proxy connected to upstream RTL-TCP")
		})

		// Downstream: Server -> Client (Forward everything)
		upstreamSocket.pipe(clientSocket)

		// Upstream: Client -> Server (Dropping control commands)
		clientSocket.on("data", data => {
			this.logger.debug(
				{ length: data.length },
				"Blocked upstream control packet",
			)
		})

		upstreamSocket.on("error", err => {
			this.logger.error({ err }, "Upstream connection error")
			clientSocket.destroy()
		})

		clientSocket.on("error", err => {
			this.logger.error({ err }, "Client connection error")
			upstreamSocket.destroy()
		})

		clientSocket.on("close", () => {
			upstreamSocket.destroy()
		})

		upstreamSocket.on("close", () => {
			clientSocket.destroy()
		})
	}
}
