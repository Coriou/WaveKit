/**
 * Live Demodulator - Real-time IQ demodulation with HTTP audio streaming
 *
 * Streams demodulated audio from IQ sources via an embedded HTTP server.
 *
 * Pipeline (see live-demod-pipeline.ts): a "front" CSDR process turns capture
 * IQ into channel IQ (optional shift, channel-matched decimation), Node gates
 * that IQ with a channel-power squelch, and a "back" CSDR process demodulates
 * it to audio. Each process runs in its own process group so stop/restart
 * signals reach every CSDR stage, not only /bin/sh.
 *
 * Streams:
 * - GET /stream      raw PCM (s16le or f32le, mono), described by the
 *                    X-Audio-Format / X-Sample-Rate / X-Channels headers.
 * - GET /stream.wav  the same audio behind a streaming WAV header, so players
 *                    need no format flags.
 * Clients are disconnected when the stream's rate or format changes, so they
 * reconnect with correct parameters. A slow client keeps at most about one
 * second of queued audio; older audio is dropped (latency beats completeness).
 */

import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import * as http from "node:http"
import type { Readable, Transform } from "node:stream"
import {
	LiveDemodConfigSchema,
	type LiveDemodConfig,
	type SourceCaps,
} from "../config.js"
import type { Logger } from "../utils/logger.js"
import { createComponentLogger } from "../utils/logger.js"
import { WaveKitError } from "../utils/errors.js"
import { liveAudioClientQueueLimit } from "./client-buffer.js"
import { csdrChildEnv } from "../decoders/csdr-buffers.js"
import { signalDecoder } from "../decoders/process-tools.js"
import {
	ChannelSquelch,
	createChannelSquelchTransform,
} from "./channel-squelch.js"
import {
	DEFAULT_IQ_SAMPLE_RATE,
	liveDemodRates,
	planLiveDemodPipeline,
	type DemodRateInfo,
} from "./live-demod-pipeline.js"
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
	/** Same audio with a streaming WAV header (self-describing). */
	wavUrl: string
	clientCount: number
	bytesStreamed: number
	pipelineHealth: "running" | "starting" | "stopped" | "error"
	/** Automatic pipeline restarts since the last manual start. */
	pipelineRestarts: number
	/** Smoothed channel power before demodulation (dBFS), while running. */
	channelPowerDbfs?: number
	/** Squelch gate state, while running (always true with squelch off). */
	squelchOpen?: boolean
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

export interface LiveDemodulatorOptions {
	/** First automatic restart delay; doubles per consecutive failure. */
	restartBaseDelayMs?: number
	restartMaxDelayMs?: number
	/** Consecutive failed runs before giving up (until start/reconfigure). */
	maxRestartAttempts?: number
	/** A run at least this long resets the failure count. */
	stableRunMs?: number
	/** SIGTERM → SIGKILL escalation for the CSDR process groups. */
	stopTimeoutMs?: number
	/** A client that accepts nothing for this long is disconnected. */
	clientStallTimeoutMs?: number
}

type AudioFormat = LiveDemodConfig["audioFormat"]

interface StreamFormat {
	rate: number
	format: AudioFormat
}

interface HttpClientState {
	id: string
	response: http.ServerResponse
	remoteAddress: string
	connectedAt: Date
	bytesWritten: number
	stream: StreamFormat
	queue: Buffer[]
	queuedBytes: number
	droppedBytes: number
	waitingDrain: boolean
	lastProgressAt: number
}

interface PipelineRun {
	front: ChildProcess
	back: ChildProcess
	squelch: ChannelSquelch
	squelchStream: Transform
	startedAt: number
	sourceSampleRate: number
	sourceFormat: SourceCaps["format"] | undefined
	stream: StreamFormat
	stopping: boolean
	failed: boolean
}

/** Config keys that only affect Node-side behaviour (no CSDR restart). */
const NODE_ONLY_KEYS = new Set<keyof LiveDemodConfig>([
	"enabled",
	"httpPort",
	"squelch",
])

const DEFAULTS: Required<LiveDemodulatorOptions> = {
	restartBaseDelayMs: 1000,
	restartMaxDelayMs: 30_000,
	maxRestartAttempts: 10,
	stableRunMs: 30_000,
	stopTimeoutMs: 3000,
	clientStallTimeoutMs: 30_000,
}

function frameBytes(format: AudioFormat): number {
	return format === "s16le" ? 2 : 4
}

/** 44-byte WAV header for an unbounded stream (sizes set to 0xFFFFFFFF). */
export function wavStreamHeader(stream: StreamFormat): Buffer {
	const bytesPerSample = frameBytes(stream.format)
	const rate = Math.max(1, Math.round(stream.rate))
	const header = Buffer.alloc(44)
	header.write("RIFF", 0, "ascii")
	header.writeUInt32LE(0xffffffff, 4)
	header.write("WAVE", 8, "ascii")
	header.write("fmt ", 12, "ascii")
	header.writeUInt32LE(16, 16)
	header.writeUInt16LE(stream.format === "s16le" ? 1 : 3, 20)
	header.writeUInt16LE(1, 22)
	header.writeUInt32LE(rate, 24)
	header.writeUInt32LE(rate * bytesPerSample, 28)
	header.writeUInt16LE(bytesPerSample, 32)
	header.writeUInt16LE(bytesPerSample * 8, 34)
	header.write("data", 36, "ascii")
	header.writeUInt32LE(0xffffffff, 40)
	return header
}

/** Headers describing the raw stream, sent on both endpoints. */
export function streamHeaders(stream: StreamFormat): Record<string, string> {
	return {
		"X-Audio-Format": stream.format,
		"X-Sample-Rate": String(stream.rate),
		"X-Channels": "1",
		"Cache-Control": "no-cache, no-store",
		"Access-Control-Expose-Headers":
			"X-Audio-Format, X-Sample-Rate, X-Channels",
	}
}

export class LiveDemodulator extends EventEmitter {
	private readonly log: Logger
	private readonly sourceManager: SourceManager
	private readonly fanoutManager: FanoutManager
	private readonly options: Required<LiveDemodulatorOptions>
	private config: LiveDemodConfig
	private httpServer: http.Server | null = null
	private run: PipelineRun | null = null
	private branchId: string | null = null
	private branchStream: Readable | null = null
	private branchErrorHandler: ((err: Error) => void) | null = null
	private clients: Map<string, HttpClientState> = new Map()
	private clientIdCounter = 0
	private bytesStreamed = 0
	private pipelineHealth: LiveDemodStatus["pipelineHealth"] = "stopped"
	private lastError: string | null = null
	private activeSourceId: string | null = null
	private audioRemainder: Buffer = Buffer.alloc(0)
	private audioFrameBytes: number
	private clientQueueLimit: number
	private consecutiveFailures = 0
	private pipelineRestarts = 0
	private restartTimer: ReturnType<typeof setTimeout> | null = null
	private capsChangedHandler:
		| ((sourceId: string, caps: SourceCaps) => void)
		| null = null
	private capsChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null
	private static readonly CAPS_CHANGE_DEBOUNCE_MS = 300

	constructor(
		logger: Logger,
		sourceManager: SourceManager,
		fanoutManager: FanoutManager,
		config: LiveDemodConfig,
		options: LiveDemodulatorOptions = {},
	) {
		super()
		this.log = createComponentLogger(logger, "LiveDemodulator")
		this.sourceManager = sourceManager
		this.fanoutManager = fanoutManager
		this.config = config
		this.options = { ...DEFAULTS, ...options }
		this.audioFrameBytes = frameBytes(config.audioFormat)
		this.clientQueueLimit = liveAudioClientQueueLimit(
			this.plannedStream().rate,
			this.audioFrameBytes,
		)
	}

	async start(): Promise<void> {
		if (this.httpServer) {
			if (this.run) {
				this.log.warn("Live demodulator already running")
				return
			}
			// The HTTP server is up but the pipeline died (or gave up): restart it.
			this.clearRestartTimer()
			this.consecutiveFailures = 0
			this.pipelineRestarts = 0
			if (!this.branchStream) {
				const sourceId = this.resolveSourceId()
				if (!sourceId) throw this.noSourceError()
				this.activeSourceId = sourceId
				this.attachBranch(sourceId)
			}
			await this.startPipelineOrFail()
			this.emit("started")
			this.log.info("Live demodulation pipeline restarted on request")
			return
		}

		const sourceId = this.resolveSourceId()
		if (!sourceId) throw this.noSourceError()

		this.activeSourceId = sourceId
		this.consecutiveFailures = 0
		this.pipelineRestarts = 0
		this.attachBranch(sourceId)
		await this.startPipelineOrFail()
		await this.startHttpServer()
		this.subscribeToSourceCapsChanges()
		this.emit("started")
		this.log.info(
			{ httpPort: this.config.httpPort, sourceId },
			"Live demodulator started",
		)
	}

	async stop(): Promise<void> {
		if (!this.httpServer && !this.run) {
			this.log.warn("Live demodulator not running")
			return
		}

		this.clearRestartTimer()
		this.unsubscribeFromSourceCapsChanges()
		if (this.run) await this.stopRun(this.run)
		this.pipelineHealth = "stopped"
		this.detachBranch()
		this.activeSourceId = null
		this.closeAllClients("stop", true)
		await this.closeHttpServer()
		// A failure that was still being cleaned up may have scheduled a restart.
		this.clearRestartTimer()

		this.emit("stopped")
		this.log.info("Live demodulator stopped")
	}

	async reconfigure(newConfig: Partial<LiveDemodConfig>): Promise<void> {
		const validated = LiveDemodConfigSchema.parse({
			...this.config,
			...newConfig,
		})
		const previous = this.config
		const portChanged = validated.httpPort !== previous.httpPort
		const sourceChanged = validated.sourceId !== previous.sourceId
		const pipelineChanged = (
			Object.keys(validated) as Array<keyof LiveDemodConfig>
		).some(key => !NODE_ONLY_KEYS.has(key) && validated[key] !== previous[key])
		const active = this.httpServer !== null || this.run !== null

		// Fail before touching the running pipeline if the new plan is invalid.
		if (active && pipelineChanged && !sourceChanged && this.activeSourceId) {
			this.planFor(this.activeSourceId, validated)
		}

		this.config = validated
		this.run?.squelch.setThreshold(validated.squelch)

		if (sourceChanged && this.activeSourceId) {
			this.detachBranch()
			const sourceId = this.resolveSourceId()
			if (sourceId) {
				this.activeSourceId = sourceId
				this.attachBranch(sourceId)
			}
		}

		if (active && (pipelineChanged || sourceChanged)) {
			this.consecutiveFailures = 0
			await this.restartPipeline("configuration changed")
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
			wavUrl: `http://localhost:${this.config.httpPort}/stream.wav`,
			clientCount: this.clients.size,
			bytesStreamed: this.bytesStreamed,
			pipelineHealth: this.pipelineHealth,
			pipelineRestarts: this.pipelineRestarts,
		}

		const run = this.run
		if (run) {
			status.squelchOpen = run.squelch.open
			const power = run.squelch.powerDbfs
			if (power !== null) status.channelPowerDbfs = Math.round(power * 10) / 10
		}
		if (this.lastError) status.lastError = this.lastError

		return status
	}

	private noSourceError(): WaveKitError {
		const err = new WaveKitError(
			"No IQ source available for live demodulator",
			"LIVE_DEMOD_NO_SOURCE",
		)
		this.lastError = err.message
		this.pipelineHealth = "error"
		this.log.error({ err }, "Cannot start live demodulator")
		this.emitError(err)
		return err
	}

	private emitError(err: Error): void {
		if (this.listenerCount("error") > 0) this.emit("error", err)
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

	/**
	 * Restarts the pipeline only when the IQ the pipeline was built for
	 * changes (sample rate, format, kind). A centre-frequency retune keeps the
	 * running pipeline: the audio continues without a gap.
	 */
	private subscribeToSourceCapsChanges(): void {
		if (this.capsChangedHandler) return

		this.capsChangedHandler = (sourceId: string, caps: SourceCaps) => {
			if (sourceId !== this.activeSourceId) return
			if (!this.capsNeedRestart(caps)) {
				this.log.debug(
					{ sourceId, centerFreq: caps.centerFreq },
					"Source tuning changed; live pipeline kept running",
				)
				return
			}

			if (this.capsChangeDebounceTimer) {
				clearTimeout(this.capsChangeDebounceTimer)
			}
			this.capsChangeDebounceTimer = setTimeout(() => {
				this.capsChangeDebounceTimer = null
				void this.handleCapsChange(sourceId, caps)
			}, LiveDemodulator.CAPS_CHANGE_DEBOUNCE_MS)
		}

		this.sourceManager.on("caps-changed", this.capsChangedHandler)
	}

	private capsNeedRestart(caps: SourceCaps): boolean {
		const run = this.run
		if (!run) return true
		return (
			caps.kind !== "iq" ||
			caps.sampleRate !== run.sourceSampleRate ||
			caps.format !== run.sourceFormat
		)
	}

	private async handleCapsChange(
		sourceId: string,
		caps: SourceCaps,
	): Promise<void> {
		if (!this.httpServer || !this.capsNeedRestart(caps)) return
		this.log.info(
			{ sourceId, newSampleRate: caps.sampleRate, format: caps.format },
			"Source sample rate or format changed, restarting pipeline",
		)

		try {
			this.consecutiveFailures = 0
			await this.restartPipeline("source caps changed")
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.log.error(
				{ err: error },
				"Failed to restart pipeline after sample rate change",
			)
			this.lastError = error.message
			this.pipelineHealth = "error"
			this.emitError(error)
		}
	}

	private unsubscribeFromSourceCapsChanges(): void {
		if (this.capsChangeDebounceTimer) {
			clearTimeout(this.capsChangeDebounceTimer)
			this.capsChangeDebounceTimer = null
		}
		if (this.capsChangedHandler) {
			this.sourceManager.off("caps-changed", this.capsChangedHandler)
			this.capsChangedHandler = null
		}
	}

	private calculateRates(
		sourceId: string,
		config: LiveDemodConfig,
	): DemodRateInfo {
		const caps = this.sourceManager.getCaps(sourceId)
		return liveDemodRates(caps?.sampleRate ?? DEFAULT_IQ_SAMPLE_RATE, config)
	}

	/** Stream format a new client is told about (current run, else planned). */
	private plannedStream(): StreamFormat {
		if (this.run) return this.run.stream
		const sourceId = this.activeSourceId ?? this.config.sourceId
		const rate = sourceId
			? this.calculateRates(sourceId, this.config).effectiveSampleRate
			: liveDemodRates(DEFAULT_IQ_SAMPLE_RATE, this.config).effectiveSampleRate
		return { rate, format: this.config.audioFormat }
	}

	private planFor(sourceId: string, config: LiveDemodConfig) {
		const caps = this.sourceManager.getCaps(sourceId)
		if (caps?.kind !== "iq") {
			throw new WaveKitError(
				`Source ${sourceId} is not IQ-capable (kind=${caps?.kind ?? "unknown"})`,
				"LIVE_DEMOD_SOURCE_NOT_IQ",
			)
		}
		const rateInfo = liveDemodRates(caps.sampleRate, config)
		const plan = planLiveDemodPipeline({
			config,
			iqSampleRate: rateInfo.iqSampleRate,
			iqFormat: caps.format,
			decimation: rateInfo.decimation,
			logger: this.log,
		})
		return { caps, rateInfo, plan }
	}

	private async startPipelineOrFail(): Promise<void> {
		try {
			await this.startPipeline()
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.lastError = error.message
			this.pipelineHealth = "error"
			if (!this.httpServer) this.detachBranch()
			this.emitError(error)
			throw error
		}
	}

	private async startPipeline(): Promise<void> {
		if (this.run) {
			this.log.warn("Live demodulation pipeline already running")
			return
		}
		if (!this.branchStream || !this.activeSourceId) {
			throw new WaveKitError(
				"Live demodulator branch not initialized",
				"LIVE_DEMOD_NO_BRANCH",
			)
		}

		const { caps, rateInfo, plan } = this.planFor(
			this.activeSourceId,
			this.config,
		)
		for (const warning of plan.warnings) this.log.warn(warning)

		this.pipelineHealth = "starting"
		this.lastError = null
		this.log.info(
			{
				sourceId: this.activeSourceId,
				decimation: rateInfo.decimation,
				effectiveSampleRate: rateInfo.effectiveSampleRate,
				offsetHz: this.config.offsetHz,
				front: plan.front,
				back: plan.back,
			},
			"Starting live demodulation pipeline",
		)

		const stream: StreamFormat = {
			rate: plan.channelSampleRate,
			format: this.config.audioFormat,
		}
		const squelch = new ChannelSquelch({
			sampleRate: plan.channelSampleRate,
			thresholdDbfs: this.config.squelch,
		})
		const run: PipelineRun = {
			front: this.spawnStage(plan.front),
			back: this.spawnStage(plan.back),
			squelch,
			squelchStream: createChannelSquelchTransform(squelch),
			startedAt: Date.now(),
			sourceSampleRate: caps.sampleRate,
			sourceFormat: caps.format,
			stream,
			stopping: false,
			failed: false,
		}
		this.run = run
		this.audioRemainder = Buffer.alloc(0)
		this.audioFrameBytes = frameBytes(stream.format)
		this.clientQueueLimit = liveAudioClientQueueLimit(
			stream.rate,
			this.audioFrameBytes,
		)

		this.wireRun(run)
		this.pipelineHealth = "running"
	}

	private spawnStage(command: string): ChildProcess {
		return spawn("/bin/sh", ["-c", command], {
			env: csdrChildEnv(),
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		})
	}

	private wireRun(run: PipelineRun): void {
		const { front, back, squelchStream } = run
		const ignore = (role: string) => (err: Error) =>
			this.log.debug({ err, role }, "Live demodulation stream error")

		for (const [role, proc] of [
			["front", front],
			["back", back],
		] as const) {
			proc.on("error", err => {
				this.log.error({ err, role }, "Live demodulation process error")
				this.handleRunFailure(run, `${role} process error: ${err.message}`)
			})
			proc.once("exit", (code, signal) => {
				if (run.stopping) return
				this.handleRunFailure(
					run,
					`Live demodulation ${role} process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
				)
			})
			proc.stdin?.on("error", ignore(`${role}.stdin`))
			proc.stdout?.on("error", ignore(`${role}.stdout`))
			proc.stderr?.on("error", ignore(`${role}.stderr`))
			proc.stderr?.on("data", (data: Buffer) => {
				const message = data.toString().trim()
				if (!message) return
				this.lastError = message
				this.log.warn({ message, role }, "Live demodulation stderr")
			})
		}
		squelchStream.on("error", ignore("squelch"))

		if (this.branchStream && front.stdin) this.branchStream.pipe(front.stdin)
		if (front.stdout && back.stdin) {
			front.stdout.pipe(squelchStream).pipe(back.stdin)
		}
		back.stdout?.on("data", (chunk: Buffer) => {
			if (this.run === run) this.handleAudioData(chunk)
		})
	}

	private handleRunFailure(run: PipelineRun, reason: string): void {
		if (this.run !== run || run.stopping || run.failed) return
		run.failed = true
		this.run = null
		this.pipelineHealth = "error"
		this.lastError = reason
		this.log.error({ reason }, "Live demodulation pipeline failed")
		this.emitError(new WaveKitError(reason, "LIVE_DEMOD_PIPELINE_EXIT"))
		const runtimeMs = Date.now() - run.startedAt
		void this.stopRun(run).finally(() => this.scheduleRestart(runtimeMs))
	}

	private scheduleRestart(lastRunMs: number): void {
		if (!this.httpServer || this.run || this.restartTimer) return
		if (lastRunMs >= this.options.stableRunMs) this.consecutiveFailures = 0
		this.consecutiveFailures++
		if (this.consecutiveFailures > this.options.maxRestartAttempts) {
			this.lastError = `Live demodulation pipeline gave up after ${this.options.maxRestartAttempts} restart attempts; POST /api/live-audio/start to retry`
			this.log.error(
				{ attempts: this.options.maxRestartAttempts },
				"Live demodulation pipeline restart limit reached",
			)
			return
		}
		const delay = Math.min(
			this.options.restartMaxDelayMs,
			this.options.restartBaseDelayMs * 2 ** (this.consecutiveFailures - 1),
		)
		this.log.warn(
			{ delayMs: delay, attempt: this.consecutiveFailures },
			"Scheduling live demodulation pipeline restart",
		)
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null
			void this.restartAfterFailure()
		}, delay)
	}

	private async restartAfterFailure(): Promise<void> {
		if (!this.httpServer || this.run) return
		this.pipelineRestarts++
		try {
			await this.restartPipeline("automatic restart")
			this.log.info(
				{ restarts: this.pipelineRestarts },
				"Live demodulation pipeline restarted",
			)
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.lastError = error.message
			this.pipelineHealth = "error"
			this.log.error({ err: error }, "Live demodulation restart failed")
			this.scheduleRestart(0)
		}
	}

	private clearRestartTimer(): void {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer)
			this.restartTimer = null
		}
	}

	/** Stops the current run (if any), starts a new one, and disconnects
	 * clients whose advertised rate/format no longer matches. */
	private async restartPipeline(reason: string): Promise<void> {
		this.clearRestartTimer()
		this.log.info({ reason }, "Restarting live demodulation pipeline")
		if (this.run) await this.stopRun(this.run)
		await this.startPipeline()
		const stream = this.plannedStream()
		for (const client of [...this.clients.values()]) {
			if (
				client.stream.rate !== stream.rate ||
				client.stream.format !== stream.format
			) {
				this.closeClient(client, "stream format changed", false)
			}
		}
	}

	/**
	 * Stops one run: unpipes, destroys every pipe handle, SIGTERMs both
	 * process groups and escalates to SIGKILL for any group still alive.
	 */
	private async stopRun(run: PipelineRun): Promise<void> {
		run.stopping = true
		if (this.run === run) this.run = null
		if (this.branchStream && run.front.stdin) {
			this.branchStream.unpipe(run.front.stdin)
		}
		run.front.stdout?.unpipe()
		run.squelchStream.unpipe()
		for (const stream of [
			run.front.stdin,
			run.front.stdout,
			run.front.stderr,
			run.back.stdin,
			run.back.stdout,
			run.back.stderr,
		]) {
			stream?.destroy()
		}
		run.squelchStream.destroy()

		await Promise.all([run.front, run.back].map(proc => this.killGroup(proc)))
		if (!this.run && !run.failed) this.pipelineHealth = "stopped"
	}

	private killGroup(proc: ChildProcess): Promise<void> {
		const exited = () => proc.exitCode !== null || proc.signalCode !== null
		if (exited() || proc.pid === undefined) return Promise.resolve()
		return new Promise<void>(resolve => {
			let settled = false
			const finish = () => {
				if (settled) return
				settled = true
				clearTimeout(escalate)
				clearTimeout(giveUp)
				resolve()
			}
			proc.once("exit", finish)
			const send = (signal: NodeJS.Signals) => {
				try {
					signalDecoder(proc, signal)
				} catch (err) {
					this.log.warn(
						{ err, pid: proc.pid, signal },
						"Failed to signal live demodulation process group",
					)
				}
			}
			const escalate = setTimeout(() => {
				if (exited()) return
				this.log.warn(
					{ pid: proc.pid },
					"Live demodulation process group ignored SIGTERM, sending SIGKILL",
				)
				send("SIGKILL")
			}, this.options.stopTimeoutMs)
			const giveUp = setTimeout(finish, this.options.stopTimeoutMs + 2000)
			send("SIGTERM")
		})
	}

	private async startHttpServer(): Promise<void> {
		const server = http.createServer((req, res) =>
			this.handleHttpRequest(req, res),
		)
		this.httpServer = server

		server.on("error", err => {
			this.log.error({ err }, "Live demodulator HTTP server error")
			this.emitError(err)
		})

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(this.config.httpPort, "0.0.0.0", () => {
				server.off("error", reject)
				resolve()
			})
		})
	}

	/** Closes the server without waiting on streaming clients (they are destroyed). */
	private async closeHttpServer(): Promise<void> {
		const server = this.httpServer
		if (!server) return
		this.closeAllClients("server closing", true)
		server.closeAllConnections()
		await new Promise<void>(resolve => {
			server.close(err => {
				if (err) {
					this.log.warn({ err }, "Error closing live demodulator server")
				}
				resolve()
			})
		})
		if (this.httpServer === server) this.httpServer = null
	}

	private async restartHttpServer(): Promise<void> {
		if (!this.httpServer) return
		await this.closeHttpServer()
		await this.startHttpServer()
	}

	private handleHttpRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): void {
		const path = (req.url ?? "").split("?")[0]
		if (
			req.method !== "GET" ||
			(path !== "/stream" && path !== "/stream.wav")
		) {
			res.statusCode = 404
			res.end("Not Found")
			return
		}

		const stream = this.plannedStream()
		const wav = path === "/stream.wav"
		res.writeHead(200, {
			"Content-Type": wav ? "audio/wav" : "application/octet-stream",
			Connection: "keep-alive",
			...streamHeaders(stream),
		})
		req.socket.setNoDelay(true)
		if (wav) res.write(wavStreamHeader(stream))
		else res.flushHeaders()

		const remoteAddress = `${req.socket.remoteAddress ?? "unknown"}:${req.socket.remotePort ?? "?"}`
		this.registerClient(res, remoteAddress, stream)
	}

	private registerClient(
		response: http.ServerResponse,
		remoteAddress: string,
		stream: StreamFormat = this.plannedStream(),
	): HttpClientState {
		const clientId = `client-${++this.clientIdCounter}`
		const client: HttpClientState = {
			id: clientId,
			response,
			remoteAddress,
			connectedAt: new Date(),
			bytesWritten: 0,
			stream,
			queue: [],
			queuedBytes: 0,
			droppedBytes: 0,
			waitingDrain: false,
			lastProgressAt: Date.now(),
		}
		this.clients.set(clientId, client)
		this.emit("client-connected", clientId)
		this.log.info(
			{ clientId, remoteAddress, totalClients: this.clients.size, stream },
			"Live audio client connected",
		)

		response.on("close", () => this.cleanupClient(clientId))
		response.on("error", err => {
			this.log.debug({ clientId, err }, "Live audio client error")
		})
		return client
	}

	private cleanupClient(clientId: string): void {
		const client = this.clients.get(clientId)
		if (!client) return
		this.clients.delete(clientId)
		client.queue = []
		client.queuedBytes = 0
		this.emit("client-disconnected", clientId)
		this.log.info(
			{
				clientId,
				bytesWritten: client.bytesWritten,
				droppedBytes: client.droppedBytes,
				totalClients: this.clients.size,
			},
			"Live audio client disconnected",
		)
	}

	private closeClient(
		client: HttpClientState,
		reason: string,
		destroy: boolean,
	): void {
		this.log.debug({ clientId: client.id, reason }, "Closing live audio client")
		try {
			if (destroy) client.response.destroy()
			else client.response.end()
		} catch {
			// Ignore
		}
		this.cleanupClient(client.id)
	}

	private closeAllClients(reason: string, destroy: boolean): void {
		for (const client of [...this.clients.values()]) {
			this.closeClient(client, reason, destroy)
		}
	}

	/** Keeps every dispatched chunk a whole number of samples. */
	private alignAudio(chunk: Buffer): Buffer | null {
		const frame = this.audioFrameBytes
		const data =
			this.audioRemainder.length > 0
				? Buffer.concat([this.audioRemainder, chunk])
				: chunk
		const usable = data.length - (data.length % frame)
		this.audioRemainder =
			usable === data.length
				? Buffer.alloc(0)
				: Buffer.from(data.subarray(usable))
		return usable > 0 ? data.subarray(0, usable) : null
	}

	private handleAudioData(chunk: Buffer): void {
		const aligned = this.alignAudio(chunk)
		if (!aligned || this.clients.size === 0) return
		for (const client of [...this.clients.values()]) {
			this.enqueueClient(client, aligned)
		}
	}

	private enqueueClient(client: HttpClientState, payload: Buffer): void {
		const response = client.response
		if (response.writableEnded || response.destroyed) {
			this.cleanupClient(client.id)
			return
		}
		if (
			client.waitingDrain &&
			Date.now() - client.lastProgressAt > this.options.clientStallTimeoutMs
		) {
			this.log.warn(
				{ clientId: client.id, droppedBytes: client.droppedBytes },
				"Disconnecting stalled live audio client",
			)
			this.closeClient(client, "stalled", true)
			return
		}
		client.queue.push(payload)
		client.queuedBytes += payload.length
		this.flushClient(client)
		this.trimClientQueue(client)
	}

	/** Drops the oldest queued audio beyond about one second. */
	private trimClientQueue(client: HttpClientState): void {
		let excess = client.queuedBytes - this.clientQueueLimit
		if (excess <= 0) return
		const frame = this.audioFrameBytes
		excess = Math.ceil(excess / frame) * frame
		if (client.droppedBytes === 0) {
			this.log.warn(
				{ clientId: client.id, limitBytes: this.clientQueueLimit },
				"Live audio client is slow; dropping its oldest audio",
			)
		}
		while (excess > 0 && client.queue.length > 0) {
			const head = client.queue[0]!
			if (head.length <= excess) {
				client.queue.shift()
				excess -= head.length
				client.queuedBytes -= head.length
				client.droppedBytes += head.length
			} else {
				client.queue[0] = head.subarray(excess)
				client.queuedBytes -= excess
				client.droppedBytes += excess
				excess = 0
			}
		}
	}

	private flushClient(client: HttpClientState): void {
		const response = client.response
		while (!client.waitingDrain && client.queue.length > 0) {
			const next = client.queue.shift()!
			client.queuedBytes -= next.length
			let accepted: boolean
			try {
				accepted = response.write(next)
			} catch (err) {
				this.log.debug(
					{ clientId: client.id, err },
					"Error writing live audio chunk",
				)
				this.cleanupClient(client.id)
				return
			}
			client.bytesWritten += next.length
			this.bytesStreamed += next.length
			if (accepted) {
				client.lastProgressAt = Date.now()
			} else {
				client.waitingDrain = true
				response.once("drain", () => {
					client.waitingDrain = false
					client.lastProgressAt = Date.now()
					if (this.clients.get(client.id) === client) this.flushClient(client)
				})
			}
		}
	}
}
