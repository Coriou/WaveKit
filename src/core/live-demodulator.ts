/**
 * Live Demodulator - Real-time IQ demodulation with HTTP audio streaming
 *
 * Streams demodulated audio from IQ sources via an embedded HTTP server.
 */

import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import * as http from "node:http"
import type { Readable } from "node:stream"
import { PassThrough } from "node:stream"
import { LiveDemodConfigSchema, type LiveDemodConfig } from "../config.js"
import type { Logger } from "../utils/logger.js"
import { createComponentLogger } from "../utils/logger.js"
import type { FanoutManager } from "./fanout-manager.js"
import type { SourceManager } from "./source-manager.js"

export type { LiveDemodConfig } from "../config.js"

export interface LiveDemodStatus {
	enabled: boolean
	running: boolean
	sourceId: string
	sourceConnected: boolean
	sourceIqSampleRate: number
	config: LiveDemodConfig
	effectiveSampleRate: number
	decimationFactor: number
	httpUrl: string
	clientCount: number
	bytesStreamed: number
	pipelineHealth: "running" | "starting" | "stopped" | "error"
	lastError?: string
}

export interface LiveDemodEvents {
	started: () => void
	stopped: () => void
	error: (error: Error) => void
	"config-changed": (config: LiveDemodConfig) => void
	"client-connected": (clientId: string) => void
	"client-disconnected": (clientId: string) => void
}

interface HttpClientState {
	id: string
	response: http.ServerResponse
	remoteAddress: string
	connectedAt: Date
	bytesWritten: number
}

interface DemodRateInfo {
	iqSampleRate: number
	decimation: number
	effectiveSampleRate: number
}

interface FilterSettings {
	lowPass: number
	highPass: number
}

const DEFAULT_IQ_SAMPLE_RATE = 2_400_000
const DEFAULT_FILTER_TRANSITION = 0.05

const NOISE_REDUCTION_PRESETS: Record<
	LiveDemodConfig["noiseReduction"],
	FilterSettings
> = {
	off: { lowPass: 0, highPass: 0 },
	voice: { lowPass: 3000, highPass: 300 },
	"noaa-apt": { lowPass: 2400, highPass: 0 },
	"narrow-band": { lowPass: 2000, highPass: 300 },
}

export class LiveDemodulator extends EventEmitter {
	private readonly log: Logger
	private readonly sourceManager: SourceManager
	private readonly fanoutManager: FanoutManager
	private config: LiveDemodConfig
	private httpServer: http.Server | null = null
	private csdrProcess: ChildProcess | null = null
	private branchId: string | null = null
	private branchStream: Readable | null = null
	private branchErrorHandler: ((err: Error) => void) | null = null
	private readonly audioStream: PassThrough
	private clients: Map<string, HttpClientState> = new Map()
	private clientIdCounter = 0
	private bytesStreamed = 0
	private pipelineHealth: LiveDemodStatus["pipelineHealth"] = "stopped"
	private lastError: string | null = null
	private activeSourceId: string | null = null
	private sourceIqSampleRate = DEFAULT_IQ_SAMPLE_RATE
	private effectiveSampleRate = 0
	private decimationFactor = 1
	private stoppingPipeline = false
	private squelchThreshold: number | null = null

	constructor(
		logger: Logger,
		sourceManager: SourceManager,
		fanoutManager: FanoutManager,
		config: LiveDemodConfig,
	) {
		super()
		this.log = createComponentLogger(logger, "LiveDemodulator")
		this.sourceManager = sourceManager
		this.fanoutManager = fanoutManager
		this.config = config
		this.audioStream = new PassThrough({ highWaterMark: 256 * 1024 })

		this.audioStream.on("data", chunk => this.handleAudioData(chunk))
		this.audioStream.on("error", err => {
			this.log.error({ err }, "Audio stream error")
		})

		this.updateSquelchThreshold()
	}

	async start(): Promise<void> {
		if (this.httpServer) {
			this.log.warn("Live demodulator already running")
			return
		}

		const sourceId = this.resolveSourceId()
		if (!sourceId) {
			const err = new Error("No IQ source available for live demodulator")
			this.lastError = err.message
			this.pipelineHealth = "error"
			this.log.error({ err }, "Cannot start live demodulator")
			this.emit("error", err)
			throw err
		}

		this.activeSourceId = sourceId
		this.attachBranch(sourceId)

		try {
			await this.startPipeline()
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.lastError = error.message
			this.pipelineHealth = "error"
			this.detachBranch()
			this.emit("error", error)
			throw error
		}

		await this.startHttpServer()
		this.emit("started")
		this.log.info(
			{ httpPort: this.config.httpPort, sourceId },
			"Live demodulator started",
		)
	}

	async stop(): Promise<void> {
		if (!this.httpServer && !this.csdrProcess) {
			this.log.warn("Live demodulator not running")
			return
		}

		await this.stopPipeline({ keepBranch: false })
		this.detachBranch()
		this.closeAllClients()

		if (!this.httpServer) {
			this.emit("stopped")
			this.log.info("Live demodulator stopped")
			return
		}

		await new Promise<void>((resolve, reject) => {
			this.httpServer!.close(err => {
				if (err) {
					this.log.error({ err }, "Error closing live demodulator server")
					reject(err)
					return
				}
				this.httpServer = null
				resolve()
			})
		})

		this.emit("stopped")
		this.log.info("Live demodulator stopped")
	}

	async reconfigure(newConfig: Partial<LiveDemodConfig>): Promise<void> {
		const merged = { ...this.config, ...newConfig }
		const validated = LiveDemodConfigSchema.parse(merged)
		const portChanged = validated.httpPort !== this.config.httpPort
		const sourceChanged = validated.sourceId !== this.config.sourceId

		this.config = validated
		this.updateSquelchThreshold()

		if (sourceChanged && this.activeSourceId) {
			this.detachBranch()
			const sourceId = this.resolveSourceId()
			if (sourceId) {
				this.activeSourceId = sourceId
				this.attachBranch(sourceId)
			}
		}

		if (this.httpServer || this.csdrProcess) {
			await this.stopPipeline({ keepBranch: true })
			await this.startPipeline()
		}

		if (portChanged && this.httpServer) {
			await this.restartHttpServer()
		}

		this.emit("config-changed", this.config)
	}

	getStatus(): LiveDemodStatus {
		const sourceId = this.activeSourceId ?? this.config.sourceId ?? ""
		const sourceStatus = sourceId
			? this.sourceManager.getStatus(sourceId)
			: undefined
		const rateInfo = sourceId
			? this.calculateRates(sourceId, this.config)
			: {
					iqSampleRate: DEFAULT_IQ_SAMPLE_RATE,
					decimation: 1,
					effectiveSampleRate: 0,
				}

		const status: LiveDemodStatus = {
			enabled: this.config.enabled,
			running: this.httpServer !== null,
			sourceId,
			sourceConnected: sourceStatus?.connected ?? false,
			sourceIqSampleRate: rateInfo.iqSampleRate,
			config: this.config,
			effectiveSampleRate: rateInfo.effectiveSampleRate,
			decimationFactor: rateInfo.decimation,
			httpUrl: `http://localhost:${this.config.httpPort}/stream`,
			clientCount: this.clients.size,
			bytesStreamed: this.bytesStreamed,
			pipelineHealth: this.pipelineHealth,
		}

		if (this.lastError) {
			return { ...status, lastError: this.lastError }
		}

		return status
	}

	private resolveSourceId(): string | null {
		if (this.config.sourceId) {
			return this.config.sourceId
		}

		const sources = this.sourceManager.getAllStatus()
		return sources[0]?.id ?? null
	}

	private attachBranch(sourceId: string): void {
		const branchId = `live-demod-${sourceId}`
		this.branchId = branchId
		this.branchStream = this.fanoutManager.addBranch({
			id: branchId,
			sourceId,
		})
		this.branchErrorHandler = err => {
			this.log.warn({ err }, "Live demodulation branch error")
		}
		this.branchStream.on("error", this.branchErrorHandler)
	}

	private detachBranch(): void {
		if (!this.branchId || !this.branchStream) return
		if (this.branchErrorHandler) {
			this.branchStream.removeListener("error", this.branchErrorHandler)
		}
		this.fanoutManager.removeBranch(this.branchId)
		this.branchId = null
		this.branchStream = null
		this.branchErrorHandler = null
	}

	private updateSquelchThreshold(): void {
		if (this.config.squelch >= 0) {
			this.squelchThreshold = null
			return
		}
		this.squelchThreshold = Math.pow(10, this.config.squelch / 20)
	}

	private calculateRates(
		sourceId: string,
		config: LiveDemodConfig,
	): DemodRateInfo {
		const caps = this.sourceManager.getCaps(sourceId)
		const iqSampleRate = caps?.sampleRate ?? DEFAULT_IQ_SAMPLE_RATE
		const bandwidth =
			config.bandwidth > 0 ? config.bandwidth : Math.max(1, iqSampleRate / 2)
		const nyquistRate = Math.max(1, bandwidth * 2)
		let decimation = Math.round(iqSampleRate / nyquistRate)
		if (decimation < 1) decimation = 1
		return {
			iqSampleRate,
			decimation,
			effectiveSampleRate: iqSampleRate / decimation,
		}
	}

	private resolveFilters(effectiveSampleRate: number): FilterSettings {
		let lowPass = this.config.lowPass
		let highPass = this.config.highPass

		if (this.config.noiseReduction !== "off") {
			const preset = NOISE_REDUCTION_PRESETS[this.config.noiseReduction]
			if (lowPass <= 0) lowPass = preset.lowPass
			if (highPass <= 0) highPass = preset.highPass
		}

		const nyquist = effectiveSampleRate / 2
		if (lowPass > 0) lowPass = Math.min(lowPass, Math.max(0, nyquist - 1))
		if (highPass > 0) highPass = Math.min(highPass, Math.max(0, nyquist - 1))

		if (lowPass > 0 && highPass > 0 && highPass >= lowPass) {
			highPass = 0
		}

		return { lowPass, highPass }
	}

	private buildPipelineCommand(
		sourceId: string,
		rateInfo: DemodRateInfo,
	): string {
		const caps = this.sourceManager.getCaps(sourceId)
		if (caps?.kind !== "iq") {
			throw new Error(
				`Source ${sourceId} is not IQ-capable (kind=${caps?.kind ?? "unknown"})`,
			)
		}

		const inputFormat =
			caps?.format === "S16_IQ"
				? "s16"
				: caps?.format === "U8_IQ" || !caps?.format
					? "char"
					: "char"

		if (caps?.format && caps.format !== "U8_IQ" && caps.format !== "S16_IQ") {
			this.log.warn(
				{ sourceId, format: caps.format },
				"Unsupported IQ format, defaulting to U8",
			)
		}

		const { decimation, effectiveSampleRate, iqSampleRate } = rateInfo
		const filters = this.resolveFilters(effectiveSampleRate)
		const transition = DEFAULT_FILTER_TRANSITION
		const csdrStages: string[] = [`csdr convert -i ${inputFormat} -o float`]

		if (this.config.iqDcBlock) {
			csdrStages.push("csdr dcblock")
		}

		csdrStages.push(`csdr firdecimate ${decimation} ${transition}`)

		switch (this.config.modulation) {
			case "am":
			case "cw":
			case "dsb":
				csdrStages.push("csdr amdemod", "csdr agc -f float -p fast -r 0.8")
				break
			case "usb":
			case "lsb": {
				const sidebandWidth = Math.min(
					0.5,
					Math.max(0.01, this.config.bandwidth / effectiveSampleRate),
				)
				const low = this.config.modulation === "lsb" ? -sidebandWidth : 0
				const high = this.config.modulation === "lsb" ? 0 : sidebandWidth
				csdrStages.push(
					`csdr bandpass --fft --low ${low.toFixed(4)} --high ${high.toFixed(4)} ${transition}`,
					"csdr realpart",
					"csdr agc -f float -p fast -r 0.8",
				)
				break
			}
			case "raw":
				csdrStages.push("csdr realpart")
				break
			case "wfm":
			case "nfm":
			default:
				csdrStages.push("csdr fmdemod")
				break
		}

		const useSox = filters.highPass > 0

		if (!useSox && filters.lowPass > 0) {
			const normalizedCutoff = filters.lowPass / effectiveSampleRate
			csdrStages.push(`csdr lowpass -f float ${normalizedCutoff.toFixed(4)}`)
		}

		csdrStages.push(
			"csdr dcblock",
			`csdr gain ${this.config.gain}`,
			"csdr limit",
		)

		if (this.config.deEmphasis) {
			if (this.config.modulation === "wfm") {
				const tauSeconds = (this.config.deEmphasisTau ?? 50) / 1_000_000
				csdrStages.push(
					`csdr deemphasis --wfm ${effectiveSampleRate} ${tauSeconds}`,
				)
			} else if (this.config.modulation === "nfm") {
				csdrStages.push(`csdr deemphasis --nfm ${effectiveSampleRate}`)
			}
		}

		if (!useSox && this.config.audioFormat === "s16le") {
			csdrStages.push("csdr convert -i float -o s16")
		}

		let pipeline = csdrStages.join(" | ")

		if (useSox) {
			const outputFormat =
				this.config.audioFormat === "s16le"
					? "-e signed -b 16"
					: "-e floating-point -b 32"
			const effects: string[] = []
			if (filters.highPass > 0) effects.push(`highpass ${filters.highPass}`)
			if (filters.lowPass > 0) effects.push(`lowpass ${filters.lowPass}`)
			const effectsStr = effects.join(" ")
			const sox = [
				"sox",
				"-t raw",
				`-r ${effectiveSampleRate}`,
				"-e floating-point -b 32 -c 1",
				"-",
				"-t raw",
				`-r ${effectiveSampleRate}`,
				`${outputFormat} -c 1`,
				"-",
				effectsStr,
			]
				.filter(Boolean)
				.join(" ")

			pipeline = `${pipeline} | ${sox}`
		}

		this.log.debug(
			{
				sourceId,
				iqSampleRate,
				effectiveSampleRate,
				decimation,
				modulation: this.config.modulation,
				audioFormat: this.config.audioFormat,
				filters,
				pipeline,
			},
			"Built live demodulator pipeline",
		)

		return pipeline
	}

	private async startPipeline(): Promise<void> {
		if (this.csdrProcess) {
			this.log.warn("Live demodulation pipeline already running")
			return
		}

		if (!this.branchStream || !this.activeSourceId) {
			throw new Error("Live demodulator branch not initialized")
		}

		const rateInfo = this.calculateRates(this.activeSourceId, this.config)
		this.sourceIqSampleRate = rateInfo.iqSampleRate
		this.effectiveSampleRate = rateInfo.effectiveSampleRate
		this.decimationFactor = rateInfo.decimation

		const pipeline = this.buildPipelineCommand(this.activeSourceId, rateInfo)

		this.pipelineHealth = "starting"
		this.lastError = null

		this.log.info(
			{
				sourceId: this.activeSourceId,
				decimation: rateInfo.decimation,
				effectiveSampleRate: rateInfo.effectiveSampleRate,
			},
			"Starting live demodulation pipeline",
		)

		this.csdrProcess = spawn("/bin/sh", ["-c", pipeline], {
			stdio: ["pipe", "pipe", "pipe"],
		})

		this.csdrProcess.on("error", err => {
			this.log.error({ err }, "Live demodulation process error")
			this.lastError = err.message
			this.pipelineHealth = "error"
			this.emit("error", err)
		})

		this.csdrProcess.on("exit", (code, signal) => {
			this.csdrProcess = null
			if (this.stoppingPipeline) {
				this.pipelineHealth = "stopped"
				return
			}
			this.pipelineHealth = "error"
			const err = new Error(
				`Live demodulation process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			)
			this.lastError = err.message
			this.emit("error", err)
			this.log.error({ code, signal }, "Live demodulation process exited")
		})

		if (this.csdrProcess.stdout) {
			this.csdrProcess.stdout.pipe(this.audioStream, { end: false })
		}

		if (this.csdrProcess.stderr) {
			this.csdrProcess.stderr.on("data", data => {
				const message = data.toString().trim()
				if (!message) return
				this.lastError = message
				this.log.warn({ message }, "Live demodulation stderr")
			})
		}

		if (this.csdrProcess.stdin) {
			this.branchStream.pipe(this.csdrProcess.stdin)

			this.csdrProcess.stdin.on("error", err => {
				this.log.debug({ err }, "Live demodulation stdin error")
			})
		}

		this.pipelineHealth = "running"
	}

	private async stopPipeline(options: { keepBranch: boolean }): Promise<void> {
		if (!this.csdrProcess) {
			this.pipelineHealth = "stopped"
			return
		}

		const proc = this.csdrProcess
		this.stoppingPipeline = true

		if (this.branchStream && proc.stdin) {
			this.branchStream.unpipe(proc.stdin)
		}
		if (proc.stdout) {
			proc.stdout.unpipe(this.audioStream)
		}

		await new Promise<void>(resolve => {
			const timeout = setTimeout(() => {
				if (!proc.killed) {
					proc.kill("SIGKILL")
				}
			}, 5000)

			proc.once("exit", () => {
				clearTimeout(timeout)
				resolve()
			})

			proc.kill("SIGTERM")
		})

		this.csdrProcess = null
		this.pipelineHealth = "stopped"
		this.stoppingPipeline = false

		if (!options.keepBranch) {
			this.activeSourceId = null
		}
	}

	private async startHttpServer(): Promise<void> {
		this.httpServer = http.createServer((req, res) =>
			this.handleHttpRequest(req, res),
		)

		this.httpServer.on("error", err => {
			this.log.error({ err }, "Live demodulator HTTP server error")
			this.emit("error", err)
		})

		await new Promise<void>((resolve, reject) => {
			this.httpServer!.listen(this.config.httpPort, "0.0.0.0", () => resolve())
			this.httpServer!.once("error", err => reject(err))
		})
	}

	private async restartHttpServer(): Promise<void> {
		if (!this.httpServer) return
		await new Promise<void>(resolve => {
			this.httpServer!.close(() => resolve())
		})
		this.httpServer = null
		await this.startHttpServer()
	}

	private handleHttpRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): void {
		if (req.method !== "GET" || req.url !== "/stream") {
			res.statusCode = 404
			res.end("Not Found")
			return
		}

		const clientId = `client-${++this.clientIdCounter}`
		const remoteAddress = `${req.socket.remoteAddress ?? "unknown"}:${req.socket.remotePort ?? "?"}`
		const contentType =
			this.config.audioFormat === "s16le"
				? `audio/L16;rate=${Math.round(this.effectiveSampleRate)};channels=1`
				: `audio/L32;rate=${Math.round(this.effectiveSampleRate)};channels=1`

		res.writeHead(200, {
			"Content-Type": contentType,
			"Transfer-Encoding": "chunked",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		})

		const clientState: HttpClientState = {
			id: clientId,
			response: res,
			remoteAddress,
			connectedAt: new Date(),
			bytesWritten: 0,
		}

		this.clients.set(clientId, clientState)
		this.emit("client-connected", clientId)
		this.log.info(
			{ clientId, remoteAddress, totalClients: this.clients.size },
			"Live audio client connected",
		)

		res.on("close", () => this.cleanupClient(clientId))
		res.on("error", err => {
			this.log.debug({ clientId, err }, "Live audio client error")
		})
	}

	private cleanupClient(clientId: string): void {
		const client = this.clients.get(clientId)
		if (!client) return
		this.clients.delete(clientId)
		this.emit("client-disconnected", clientId)
		this.log.info(
			{
				clientId,
				bytesWritten: client.bytesWritten,
				totalClients: this.clients.size,
			},
			"Live audio client disconnected",
		)
	}

	private closeAllClients(): void {
		for (const [clientId, client] of this.clients) {
			this.log.debug({ clientId }, "Closing live audio client")
			try {
				client.response.end()
			} catch {
				// Ignore
			}
		}
		this.clients.clear()
	}

	private handleAudioData(chunk: Buffer): void {
		if (this.clients.size === 0) return

		const payload = this.applySquelch(chunk)

		for (const [clientId, client] of this.clients) {
			if (client.response.writableEnded) {
				this.cleanupClient(clientId)
				continue
			}
			try {
				client.response.write(payload)
				client.bytesWritten += payload.length
				this.bytesStreamed += payload.length
			} catch (err) {
				this.log.debug({ clientId, err }, "Error writing live audio chunk")
				this.cleanupClient(clientId)
			}
		}
	}

	private applySquelch(chunk: Buffer): Buffer {
		if (!this.squelchThreshold) return chunk

		const rms = this.calculateChunkRms(chunk)
		if (rms >= this.squelchThreshold) return chunk
		return Buffer.alloc(chunk.length)
	}

	private calculateChunkRms(chunk: Buffer): number {
		if (this.config.audioFormat === "s16le") {
			const sampleCount = Math.floor(chunk.length / 2)
			if (sampleCount <= 0) return 0
			const view = new Int16Array(chunk.buffer, chunk.byteOffset, sampleCount)
			let sumSquares = 0
			for (let i = 0; i < view.length; i++) {
				const normalized = view[i]! / 32768
				sumSquares += normalized * normalized
			}
			return Math.sqrt(sumSquares / sampleCount)
		}

		const sampleCount = Math.floor(chunk.length / 4)
		if (sampleCount <= 0) return 0
		const view = new Float32Array(chunk.buffer, chunk.byteOffset, sampleCount)
		let sumSquares = 0
		for (let i = 0; i < view.length; i++) {
			const normalized = view[i] ?? 0
			sumSquares += normalized * normalized
		}
		return Math.sqrt(sumSquares / sampleCount)
	}
}
