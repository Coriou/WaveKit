/**
 * Tuner Relay - RTL-TCP compatible server for local tuner clients (e.g., SDR++).
 *
 * Exposes internal IQ stream via TCP while forwarding control commands upstream
 * to the configured RTL-TCP source.
 */

import { EventEmitter } from "node:events"
import * as net from "node:net"
import type { Readable } from "node:stream"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import type { BranchConfig, FanoutManager } from "./fanout-manager.js"
import type {
	RtlTcpHeaderInfo,
	SourceCaps,
	SourceManager,
} from "./source-manager.js"

export type TunerRelayControlPolicy = "exclusive" | "shared"

export interface TunerRelayConfig {
	enabled: boolean
	host: string
	port: number
	sourceId?: string | undefined
	controlPolicy: TunerRelayControlPolicy
	maxClients?: number | undefined
	commandHistoryLimit?: number | undefined
}

export interface TunerRelayCommandStat {
	id: number
	name: string
	count: number
	lastValue: number
	lastSeenAt: string
}

export interface TunerRelayCommandHistoryEntry {
	id: number
	name: string
	value: number
	at: string
	clientId?: string
	clientRemote?: string
}

export interface TunerRelayStatus {
	enabled: boolean
	listening: boolean
	host: string
	port: number
	sourceId?: string
	sourceConnected?: boolean
	sourceKind?: SourceCaps["kind"]
	sourceFormat?: SourceCaps["format"]
	compatibility?:
		| "ok"
		| "missing-source"
		| "unsupported-kind"
		| "unsupported-format"
	compatibilityMessage?: string
	clientsConnected: number
	controlClientId?: string
	controlClientRemote?: string
	controlPolicy: TunerRelayControlPolicy
	maxClients?: number
	bytesSent: number
	bytesReceived: number
	lastCommand?: string
	lastCommandAt?: string
	lastCommandValue?: number
	lastFrequency?: number
	lastSampleRate?: number
	lastGain?: number
	lastPpm?: number
	commandHistoryLimit?: number
	commandStats?: TunerRelayCommandStat[]
	commandHistory?: TunerRelayCommandHistoryEntry[]
	lastError?: string
	rtlTcpHeader?: RtlTcpHeaderInfo
}

export interface TunerRelayEvents {
	"client-connected": (clientId: string) => void
	"client-disconnected": (clientId: string) => void
	"control-changed": (clientId: string | null) => void
	"sample-rate-changed": (sourceId: string, sampleRate: number) => void
	started: (port: number) => void
	stopped: () => void
	error: (error: Error) => void
}

interface ClientState {
	socket: net.Socket
	id: string
	remoteAddress: string
	connectedAt: Date
	bytesWritten: number
	bytesRead: number
	commandBuffer: Buffer
}

const DEFAULT_TUNER_TYPE = 5
const DEFAULT_GAIN_COUNT = 29
const COMMAND_SIZE = 5
const DEFAULT_COMMAND_HISTORY_LIMIT = 200

const COMMAND_NAMES: Record<number, string> = {
	0x01: "set-frequency",
	0x02: "set-sample-rate",
	0x03: "set-gain-mode",
	0x04: "set-gain",
	0x05: "set-freq-correction",
	0x06: "set-if-gain",
	0x07: "set-test-mode",
	0x08: "set-agc-mode",
	0x09: "set-direct-sampling",
	0x0a: "set-offset-tuning",
	0x0b: "set-rtl-xtal",
	0x0c: "set-tuner-xtal",
	0x0d: "set-tuner-gain-index",
	0x0e: "set-bias-tee",
	0x0f: "set-tuner-if-gain",
}

export class TunerRelay extends EventEmitter {
	private readonly log: Logger
	private readonly sourceManager: SourceManager
	private readonly fanoutManager: FanoutManager
	private readonly config: TunerRelayConfig
	private server: net.Server | null = null
	private branchStream: Readable | null = null
	private branchId: string | null = null
	private dataHandler: ((chunk: Buffer) => void) | null = null
	private clients: Map<string, ClientState> = new Map()
	private clientIdCounter = 0
	private controlClientId: string | null = null
	private bytesSent = 0
	private bytesReceived = 0
	private lastCommand: string | null = null
	private lastCommandAt: string | null = null
	private lastCommandValue: number | null = null
	private lastFrequency: number | null = null
	private lastSampleRate: number | null = null
	private lastGain: number | null = null
	private lastPpm: number | null = null
	private lastError: string | null = null
	private readonly commandHistoryLimit: number
	private commandHistory: TunerRelayCommandHistoryEntry[] = []
	private commandStats: Map<number, TunerRelayCommandStat> = new Map()

	constructor(
		logger: Logger,
		sourceManager: SourceManager,
		fanoutManager: FanoutManager,
		config: TunerRelayConfig,
	) {
		super()
		this.log = createComponentLogger(logger, "TunerRelay")
		this.sourceManager = sourceManager
		this.fanoutManager = fanoutManager
		this.config = config
		this.commandHistoryLimit = Math.max(
			0,
			config.commandHistoryLimit ?? DEFAULT_COMMAND_HISTORY_LIMIT,
		)
	}

	async start(): Promise<void> {
		if (!this.config.enabled) {
			this.log.info("Tuner relay disabled, skipping start")
			return
		}
		if (this.server) {
			this.log.warn("Tuner relay already running")
			return
		}
		if (!this.config.sourceId) {
			this.log.warn(
				"Tuner relay enabled without sourceId; upstream control will be disabled",
			)
		}

		this.attachBranch()

		return new Promise((resolve, reject) => {
			this.server = net.createServer(socket =>
				this.handleClientConnection(socket),
			)

			this.server.on("error", err => {
				this.log.error({ err }, "Tuner relay server error")
				this.emit("error", err)
				reject(err)
			})

			this.server.listen(this.config.port, this.config.host, () => {
				this.log.info(
					{
						host: this.config.host,
						port: this.config.port,
						sourceId: this.config.sourceId,
						controlPolicy: this.config.controlPolicy,
					},
					"Tuner relay started",
				)
				this.emit("started", this.config.port)
				resolve()
			})
		})
	}

	async stop(): Promise<void> {
		if (!this.server) {
			this.log.warn("Tuner relay not running")
			return
		}

		this.detachBranch()

		for (const [clientId, client] of this.clients) {
			this.log.debug({ clientId }, "Closing tuner relay client")
			client.socket.destroy()
		}
		this.clients.clear()
		this.controlClientId = null

		return new Promise((resolve, reject) => {
			this.server!.close(err => {
				if (err) {
					this.log.error({ err }, "Error closing tuner relay server")
					reject(err)
					return
				}
				this.server = null
				this.log.info("Tuner relay stopped")
				this.emit("stopped")
				resolve()
			})
		})
	}

	getStatus(): TunerRelayStatus {
		const status: TunerRelayStatus = {
			enabled: this.config.enabled,
			listening: this.server !== null,
			host: this.config.host,
			port: this.config.port,
			clientsConnected: this.clients.size,
			controlPolicy: this.config.controlPolicy,
			bytesSent: this.bytesSent,
			bytesReceived: this.bytesReceived,
		}

		if (this.config.sourceId) status.sourceId = this.config.sourceId
		if (this.controlClientId) status.controlClientId = this.controlClientId
		if (this.config.maxClients !== undefined)
			status.maxClients = this.config.maxClients
		if (this.lastCommand) status.lastCommand = this.lastCommand
		if (this.lastCommandAt) status.lastCommandAt = this.lastCommandAt
		if (this.lastCommandValue !== null)
			status.lastCommandValue = this.lastCommandValue
		if (this.lastFrequency !== null) status.lastFrequency = this.lastFrequency
		if (this.lastSampleRate !== null)
			status.lastSampleRate = this.lastSampleRate
		if (this.lastGain !== null) status.lastGain = this.lastGain
		if (this.lastPpm !== null) status.lastPpm = this.lastPpm
		if (this.commandHistoryLimit >= 0)
			status.commandHistoryLimit = this.commandHistoryLimit
		if (this.commandHistory.length > 0)
			status.commandHistory = [...this.commandHistory]
		if (this.commandStats.size > 0) {
			status.commandStats = Array.from(this.commandStats.values()).sort(
				(a, b) => a.id - b.id,
			)
		}
		if (this.lastError) status.lastError = this.lastError

		if (this.controlClientId) {
			const controlClient = this.clients.get(this.controlClientId)
			if (controlClient)
				status.controlClientRemote = controlClient.remoteAddress
		}

		if (this.config.sourceId) {
			const sourceStatus = this.sourceManager.getStatus(this.config.sourceId)
			const sourceCaps = this.sourceManager.getCaps(this.config.sourceId)
			const headerInfo = this.sourceManager.getRtlTcpInfo(this.config.sourceId)

			if (sourceStatus) {
				status.sourceConnected = sourceStatus.connected
				status.sourceKind = sourceStatus.caps.kind
				status.sourceFormat = sourceStatus.caps.format
			}

			if (!sourceCaps) {
				status.compatibility = "missing-source"
				status.compatibilityMessage = "Source not found"
			} else if (sourceCaps.kind !== "iq") {
				status.compatibility = "unsupported-kind"
				status.compatibilityMessage = `Source kind '${sourceCaps.kind}' is not IQ`
			} else if (sourceCaps.format !== "U8_IQ") {
				status.compatibility = "unsupported-format"
				status.compatibilityMessage = `Source format '${sourceCaps.format}' is not U8_IQ`
			} else {
				status.compatibility = "ok"
			}

			if (headerInfo) status.rtlTcpHeader = headerInfo
		}

		return status
	}

	private attachBranch(): void {
		if (this.branchStream) return

		const branchId = this.config.sourceId
			? `tuner-relay-${this.config.sourceId}`
			: "tuner-relay"

		this.branchId = branchId
		const branchConfig: BranchConfig = { id: branchId }
		if (this.config.sourceId) {
			branchConfig.sourceId = this.config.sourceId
		}
		this.branchStream = this.fanoutManager.addBranch(branchConfig)

		this.dataHandler = (chunk: Buffer) => this.distributeToClients(chunk)
		this.branchStream.on("data", this.dataHandler)
		this.branchStream.on("error", err => {
			this.log.error({ err }, "Tuner relay branch stream error")
		})

		this.log.info({ branchId }, "Tuner relay branch attached")
	}

	private detachBranch(): void {
		if (this.branchStream && this.dataHandler) {
			this.branchStream.removeListener("data", this.dataHandler)
			this.dataHandler = null
		}

		if (this.branchId) {
			this.fanoutManager.removeBranch(this.branchId)
			this.branchId = null
		}

		this.branchStream = null
	}

	private handleClientConnection(socket: net.Socket): void {
		if (
			this.config.maxClients !== undefined &&
			this.clients.size >= this.config.maxClients
		) {
			this.log.warn(
				{ maxClients: this.config.maxClients },
				"Client rejected (max clients reached)",
			)
			socket.destroy()
			return
		}

		const clientId = `client-${++this.clientIdCounter}`
		const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`

		socket.setNoDelay(true)

		const clientState: ClientState = {
			socket,
			id: clientId,
			remoteAddress,
			connectedAt: new Date(),
			bytesWritten: 0,
			bytesRead: 0,
			commandBuffer: Buffer.alloc(0),
		}

		this.clients.set(clientId, clientState)

		if (this.config.controlPolicy === "exclusive" && !this.controlClientId) {
			this.controlClientId = clientId
			this.emit("control-changed", clientId)
		}

		this.log.info(
			{ clientId, remoteAddress, totalClients: this.clients.size },
			"Tuner relay client connected",
		)
		this.emit("client-connected", clientId)

		this.sendRtlTcpHeader(clientState)

		socket.on("data", data => {
			this.handleClientData(clientState, data)
		})

		socket.on("error", err => {
			if (
				(err as NodeJS.ErrnoException).code === "ECONNRESET" ||
				(err as NodeJS.ErrnoException).code === "EPIPE"
			) {
				this.log.debug({ clientId, err: err.message }, "Client reset")
			} else {
				this.log.error({ clientId, err }, "Tuner relay client error")
			}
		})

		socket.on("close", () => {
			this.cleanupClient(clientId)
		})

		socket.on("end", () => {
			this.log.debug({ clientId }, "Tuner relay client ended connection")
		})
	}

	private cleanupClient(clientId: string): void {
		const client = this.clients.get(clientId)
		if (!client) return

		this.clients.delete(clientId)

		this.log.info(
			{
				clientId,
				bytesWritten: client.bytesWritten,
				bytesRead: client.bytesRead,
			},
			"Tuner relay client disconnected",
		)
		this.emit("client-disconnected", clientId)

		if (this.controlClientId === clientId) {
			this.controlClientId = this.selectNextControlClient()
			this.emit("control-changed", this.controlClientId)
		}
	}

	private selectNextControlClient(): string | null {
		if (this.config.controlPolicy !== "exclusive") {
			return null
		}
		const next = this.clients.values().next()
		if (next.done) return null
		return next.value.id
	}

	private handleClientData(client: ClientState, data: Buffer | string): void {
		const payload =
			typeof data === "string" ? Buffer.from(data, "binary") : data
		client.bytesRead += payload.length
		this.bytesReceived += payload.length

		if (!this.isControlClient(client.id)) {
			return
		}

		this.parseCommands(client, payload)

		if (!this.config.sourceId) {
			this.lastError = "No source configured for tuner relay"
			return
		}
		const sourceStatus = this.sourceManager.getStatus(this.config.sourceId)
		if (sourceStatus?.type && sourceStatus.type !== "rtl_tcp") {
			this.lastError = `Source '${this.config.sourceId}' does not support RTL-TCP control`
			return
		}

		try {
			this.sourceManager.writeToSource(this.config.sourceId, payload)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			this.lastError = message
			this.log.warn(
				{ err: message },
				"Failed to forward tuner command upstream",
			)
		}
	}

	private parseCommands(client: ClientState, data: Buffer): void {
		if (data.length === 0) return
		client.commandBuffer = Buffer.concat([client.commandBuffer, data])

		while (client.commandBuffer.length >= COMMAND_SIZE) {
			const cmd = client.commandBuffer.readUInt8(0)
			const value = client.commandBuffer.readUInt32BE(1)
			this.updateCommandState(cmd, value, client)
			client.commandBuffer = client.commandBuffer.subarray(COMMAND_SIZE)
		}
	}

	private updateCommandState(
		cmd: number,
		value: number,
		client: ClientState,
	): void {
		const name = COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`
		const now = new Date().toISOString()
		this.lastCommand = name
		this.lastCommandAt = now
		this.lastCommandValue = value
		this.recordCommandStats(cmd, name, value, now)
		this.recordCommandHistory(cmd, name, value, now, client)

		switch (cmd) {
			case 0x01:
				this.lastFrequency = value
				break
			case 0x02:
				this.lastSampleRate = value
				// Emit sample rate changed event for dynamic pipeline adaptation
				if (this.config.sourceId) {
					this.emit("sample-rate-changed", this.config.sourceId, value)
					this.log.info(
						{ sourceId: this.config.sourceId, sampleRate: value },
						"Sample rate changed via tuner relay",
					)
				}
				break
			case 0x04:
				this.lastGain = value
				break
			case 0x05:
				this.lastPpm = value
				break
			default:
				break
		}
	}

	private recordCommandStats(
		cmd: number,
		name: string,
		value: number,
		timestamp: string,
	): void {
		const existing = this.commandStats.get(cmd)
		if (existing) {
			existing.count += 1
			existing.lastValue = value
			existing.lastSeenAt = timestamp
			return
		}
		this.commandStats.set(cmd, {
			id: cmd,
			name,
			count: 1,
			lastValue: value,
			lastSeenAt: timestamp,
		})
	}

	private recordCommandHistory(
		cmd: number,
		name: string,
		value: number,
		timestamp: string,
		client: ClientState,
	): void {
		if (this.commandHistoryLimit <= 0) return

		this.commandHistory.push({
			id: cmd,
			name,
			value,
			at: timestamp,
			clientId: client.id,
			clientRemote: client.remoteAddress,
		})

		if (this.commandHistory.length > this.commandHistoryLimit) {
			this.commandHistory.splice(
				0,
				this.commandHistory.length - this.commandHistoryLimit,
			)
		}
	}

	private isControlClient(clientId: string): boolean {
		if (this.config.controlPolicy === "shared") {
			return true
		}
		return this.controlClientId === clientId
	}

	private sendRtlTcpHeader(client: ClientState): void {
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, 4, "ascii")

		const headerInfo = this.config.sourceId
			? this.sourceManager.getRtlTcpInfo(this.config.sourceId)
			: undefined
		const tunerType = headerInfo?.tunerType ?? DEFAULT_TUNER_TYPE
		const gainCount = headerInfo?.gainCount ?? DEFAULT_GAIN_COUNT

		header.writeUInt32BE(tunerType, 4)
		header.writeUInt32BE(gainCount, 8)

		try {
			client.socket.write(header)
		} catch (err) {
			this.log.warn({ err }, "Failed to send RTL-TCP header to client")
		}
	}

	private distributeToClients(chunk: Buffer): void {
		for (const [clientId, client] of this.clients) {
			if (!client.socket.writable) {
				this.log.debug({ clientId }, "Client socket not writable, skipping")
				continue
			}

			const canWrite = client.socket.write(chunk)
			client.bytesWritten += chunk.length
			this.bytesSent += chunk.length

			if (!canWrite) {
				this.log.debug({ clientId }, "Client backpressure detected")
			}
		}
	}
}
