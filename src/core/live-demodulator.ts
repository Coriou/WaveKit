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

import type { NodeHttpAccessOptions } from "../access/node-http-adapter.js"
import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import type * as http from "node:http"
import { Transform, type Readable } from "node:stream"
import { z } from "zod"
import {
	LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS,
	LIVE_AUDIO_NOISE_QUIETING_DB,
	LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS,
	LIVE_AUDIO_SQUELCH_MODES,
	type LiveAudioSquelchMode,
} from "@wavekit/api-types"
import {
	LiveDemodConfigSchema,
	type LiveDemodConfig as BaseLiveDemodConfig,
	type SourceCaps,
} from "../config.js"
import type { Logger } from "../utils/logger.js"
import { createComponentLogger } from "../utils/logger.js"
import { WaveKitError } from "../utils/errors.js"
import {
	AudioClientRegistry,
	AudioHttpServer,
	parseStreamPath,
	type AudioClient,
	type AudioRoute,
	type StreamFormat,
} from "./audio-stream-server.js"
import { csdrChildEnv } from "../decoders/csdr-buffers.js"
import { signalDecoder } from "../decoders/process-tools.js"
import { safeErrorFields } from "../decoders/safe-error-fields.js"
import { ChannelSquelch } from "./channel-squelch.js"
import { ComplexSampleAligner, FrontSwapFeed } from "./live-audio-aligner.js"
import {
	SilenceFill,
	systemSilenceClock,
	type SilenceFillClock,
} from "./live-audio-silence.js"
import {
	ToneSquelchGate,
	type ToneSquelchTone,
} from "./audio-tones/tone-squelch.js"
import { liveDemodTransmissionConfigChanged } from "./live-demod-activity.js"
import {
	DEFAULT_IQ_SAMPLE_RATE,
	liveDemodRates,
	effectiveAgc,
	planLiveDemodPipeline,
	type DemodRateInfo,
} from "./live-demod-pipeline.js"
import { RustLiveRun, rustEngineRequested } from "./live-demod/rust-run.js"
import type { EngineFallbackReason } from "./live-demod/index.js"
import type { RustEngine } from "./live-demod/rust-engine.js"
import type { FanoutManager } from "./fanout-manager.js"
import type { SourceFanoutRouter } from "./source-fanout-router.js"
import type { SourceManager } from "./source-manager.js"

/**
 * Runtime schema: the startup schema (with its WG7 refinements: noise squelch
 * only on nfm/wfm, tone squelch only on nfm with a standard tone) plus the
 * runtime defaults of the squelch keys.
 */
export const LiveDemodRuntimeConfigSchema = LiveDemodConfigSchema.and(
	z.object({
		squelchMode: z
			.enum(LIVE_AUDIO_SQUELCH_MODES as [LiveAudioSquelchMode])
			.default("manual"),
		autoMarginDb: z.number().finite().min(0).max(40).default(6),
		noiseQuietingDb: z
			.number()
			.finite()
			.min(LIVE_AUDIO_NOISE_QUIETING_DB.min)
			.max(LIVE_AUDIO_NOISE_QUIETING_DB.max)
			.default(LIVE_AUDIO_NOISE_QUIETING_DB.default),
	}),
)
export type LiveDemodConfig = BaseLiveDemodConfig & {
	squelchMode?: "manual" | "auto" | "noise" | undefined
	autoMarginDb?: number | undefined
	noiseQuietingDb?: number | undefined
}
export interface LiveAudioLevel {
	sourceId: string
	channelPowerDbfs: number | null
	/** Lower-envelope estimate of channel power, not an RF calibration. */
	noiseFloorDbfs: number | null
	squelchOpen: boolean
	thresholdDbfs: number
}

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
	/** Demodulator that produced this run. `csdr` when Rust fell back or was not asked. */
	engine?: "csdr" | "rust"
	/** Why a requested Rust engine is not the one running. */
	engineFallback?: EngineFallbackReason
	/** Smoothed channel power before demodulation (dBFS), while running. */
	channelPowerDbfs?: number
	/** Squelch gate state, while running (always true with squelch off). */
	squelchOpen?: boolean
	noiseFloorDbfs?: number
	thresholdDbfs?: number
	lastError?: string
	/** WG4: AGC in the running chain after the modulation default. */
	agc?: "off" | "slow" | "fast"
	/** WG7 req 3.4: tone squelch gate state, while running. */
	toneSquelch?: { state: "off" | "waiting" | "open" }
}

/** reconfigure() input; `agc: null` deletes the key (modulation default). */
export type LiveDemodReconfigureUpdates = Omit<
	Partial<LiveDemodConfig>,
	"agc"
> & { agc?: "off" | "slow" | "fast" | null | undefined }

export interface LiveDemodEvents {
	level: (level: LiveAudioLevel) => void
	"squelch-changed": (open: boolean) => void
	started: () => void
	stopped: () => void
	error: (error: Error) => void
	"config-changed": (config: LiveDemodConfig) => void
	"client-connected": (clientId: string) => void
	"client-disconnected": (clientId: string) => void
	/**
	 * Demodulated PCM, only while something is listening (WG2 req 7.6).
	 * The chunk is the buffer written to audio clients; with a tone squelch
	 * gate (WG7 req 3.3) it is emitted unmuted, before the gate may zero it
	 * in place, so listeners must consume it synchronously.
	 */
	pcm: (
		chunk: Buffer,
		format: { rate: number; format: "s16le" | "f32le" },
	) => void
}

export interface LiveDemodulatorOptions {
	/** Level publication frequency, integer 10–20 Hz (default 10). */
	levelHz?: number
	/** Borrowed shared protected policy/session/lease authority. */
	httpAccess?: NodeHttpAccessOptions
	/** Canonical configured public origin; never inferred from listener binding. */
	publicOrigin?: string
	httpHost?: string
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
	/** Test/bench seam: spawns one CSDR stage (default: /bin/sh -c in its own group). */
	spawnStage?: (command: string) => ChildProcess
	/** WG10: clock and timers of the silence fill and the front swap timeout. */
	clock?: SilenceFillClock
}

type InjectedOptionKeys =
	| "httpAccess"
	| "publicOrigin"
	| "httpHost"
	| "spawnStage"
	| "clock"
type ResolvedOptions = Required<
	Omit<LiveDemodulatorOptions, InjectedOptionKeys>
> &
	Pick<LiveDemodulatorOptions, InjectedOptionKeys>

/** WG10 req 2.3: a new front started by an offset change, not yet switched in. */
interface PendingFrontSwap {
	front: ChildProcess
	aligner: ComplexSampleAligner
	command: string
	finish: (outcome: FrontSwapOutcome) => void
}

type FrontSwapOutcome =
	| "first"
	| "swapped"
	| "timeout"
	| "failed"
	| "superseded"
	| "aborted"

export interface PipelineRun {
	front: ChildProcess
	back: ChildProcess
	/**
	 * WG10 req 2.3: whole complex samples from a swapped-in front to the
	 * squelch; null for the run's first front (piped directly, as before).
	 */
	frontAligner: ComplexSampleAligner | null
	frontCommand: string
	backCommand: string
	/** Removes the current front's run-failure handlers (before a swap kills it). */
	detachFront: () => void
	swap: PendingFrontSwap | null
	/**
	 * WG10 req 2.3: the reported gate is held closed while an offset swap is
	 * pending, so the transmission closes as "config" as on a full restart and
	 * a carrier on the new offset opens a new one at the switch.
	 */
	gateHeld: boolean
	squelch: ChannelSquelch
	squelchStream: Transform
	startedAt: number
	sourceSampleRate: number
	sourceFormat: SourceCaps["format"] | undefined
	stream: StreamFormat
	/**
	 * WG7 tone squelch: null without a tone; `gate` null when the gate could
	 * not be built for this run (audio stays muted: an unproven tone is absent).
	 */
	tone: { gate: ToneSquelchGate | null; key: string } | null
	/**
	 * PCM bytes delivered this run, mod 4 (a multiple of every sample width):
	 * a gate built mid-stream starts at the stream's sample framing.
	 */
	pcmPhase: number
	/**
	 * Tone gate decision for the sample straddling the last chunk's end (true:
	 * muted), so its remaining bytes in the next chunk get the same decision
	 * and muting only ever zeroes whole samples.
	 */
	pcmTailMuted: boolean
	noiseFloorDbfs: number | null
	/**
	 * WG9 req 5.6: the floor held before a retained-pipeline retune reset it.
	 * The first measured block after the reset seeds min(this, power), then it
	 * is cleared; null on cold start, so that path seeds from power alone.
	 */
	retuneFloorDbfs: number | null
	stopping: boolean
	failed: boolean
	/**
	 * Rust demod engine for this run. Absent on the csdr path, which keeps
	 * gating on `squelch` alone.
	 */
	rust?: RustEngine
	/** Gate mirrored from Rust `gate` events. Absent on the csdr path. */
	externalGate?: boolean
	/** Latest Rust metrics power. Absent on the csdr path. */
	externalPowerDbfs?: number | null
}

/**
 * WG10 req 2.3: written to the measured squelch stream at a front switch
 * (identity-compared, never forwarded): an explicit alignment reset that runs
 * after the old front's queued bytes and before the new front's first byte.
 */
const SQUELCH_ALIGNMENT_RESET = Buffer.alloc(0)

// Each measurement advances one 10 ms block of stream time.
const LEVEL_BLOCK_SECONDS = 0.01
/**
 * Hang passed to ChannelSquelch. 250 ms is that class's default; it is set
 * explicitly so `squelchHangMs()` reports the hang the gate actually uses.
 */
const SQUELCH_HANG_MS = 250
const AUTO_FLOOR_CLOSED_RISE_DB_PER_SECOND = 1
const AUTO_FLOOR_OPEN_RISE_DB_PER_SECOND = 0.4

/** Config keys that only affect Node-side behaviour (no CSDR restart). */
const NODE_ONLY_KEYS = new Set<keyof LiveDemodConfig>([
	"enabled",
	"httpPort",
	"squelch",
	"squelchMode",
	"autoMarginDb",
	"noiseQuietingDb",
	"toneSquelch",
	"iqDcBlock",
])

const DEFAULTS: ResolvedOptions = {
	levelHz: 10,
	restartBaseDelayMs: 1000,
	restartMaxDelayMs: 30_000,
	maxRestartAttempts: 10,
	stableRunMs: 30_000,
	stopTimeoutMs: 3000,
	clientStallTimeoutMs: 30_000,
}

export { streamHeaders, wavStreamHeader } from "./audio-stream-server.js"

export class LiveDemodulator extends EventEmitter {
	private readonly log: Logger
	private readonly sourceManager: SourceManager
	private readonly fanoutManager: FanoutManager | SourceFanoutRouter
	private branchFanout: FanoutManager | null = null
	private legacySourceId: string | null = null
	private readonly options: ResolvedOptions
	private readonly clock: SilenceFillClock
	private readonly silence: SilenceFill
	/** Stream format of the last run started (a restart after failure compares it). */
	private lastRunStream: StreamFormat | null = null
	private levelTimer: ReturnType<typeof setInterval> | null = null
	private reportedSquelchOpen = false
	/** WG10 activity hygiene: blocks with carrier evidence, monotonic (see carrierBlocks()). */
	private carrierBlockCount = 0
	/**
	 * Set only while `stop()` or a transmission-closing `reconfigure()` is in
	 * progress. `stopRun` emits `squelch-changed(false)` before `stopped` or
	 * `config-changed`; the tracker reads this during that synchronous emit.
	 */
	private closeOverride: "stopped" | "config" | null = null
	/**
	 * `stop()` won over an in-flight `start()`. The handshake must not adopt a
	 * run or bring HTTP up after `stop()` has begun.
	 */
	private stopRequested = false
	private config: LiveDemodConfig
	private readonly http: AudioHttpServer
	private readonly audio: AudioClientRegistry
	private run: PipelineRun | null = null
	private branchId: string | null = null
	private branchStream: Readable | null = null
	private branchErrorHandler: ((err: Error) => void) | null = null
	private pipelineHealth: LiveDemodStatus["pipelineHealth"] = "stopped"
	private lastError: string | null = null
	private activeSourceId: string | null = null
	private consecutiveFailures = 0
	private pipelineRestarts = 0
	private readonly rustRuns: RustLiveRun
	private restartTimer: ReturnType<typeof setTimeout> | null = null
	private capsChangedHandler:
		| ((sourceId: string, caps: SourceCaps) => void)
		| null = null
	private capsChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null
	/** Reused pcm announcement so a listener does not allocate per chunk. */
	private pcmFormat: { rate: number; format: "s16le" | "f32le" } | null = null
	private static readonly CAPS_CHANGE_DEBOUNCE_MS = 300

	constructor(
		logger: Logger,
		sourceManager: SourceManager,
		fanoutManager: FanoutManager | SourceFanoutRouter,
		config: LiveDemodConfig,
		options: LiveDemodulatorOptions = {},
	) {
		super()
		this.log = createComponentLogger(logger, "LiveDemodulator")
		this.sourceManager = sourceManager
		this.fanoutManager = fanoutManager
		this.config = LiveDemodRuntimeConfigSchema.parse(config)
		this.options = { ...DEFAULTS, ...options }
		z.number().int().min(10).max(20).parse(this.options.levelHz)
		this.audio = new AudioClientRegistry(this.log, {
			stallTimeoutMs: this.options.clientStallTimeoutMs,
			label: "Live audio",
			stream: this.plannedStream(),
		})
		this.audio.on("client-connected", (id: string) =>
			this.emit("client-connected", id),
		)
		this.audio.on("client-disconnected", (id: string) =>
			this.emit("client-disconnected", id),
		)
		this.clock = options.clock ?? systemSilenceClock
		this.silence = new SilenceFill(this.audio, this.clock)
		this.http = new AudioHttpServer(
			this.log,
			"Live demodulator",
			req => this.resolveRoute(req),
			err => this.emitError(err),
			options.httpAccess,
		)
		this.rustRuns = new RustLiveRun({
			log: this.log,
			clock: this.clock,
			config: () => this.config,
			branchStream: () => this.branchStream,
			httpListening: () => this.http.listening,
			stableRunMs: () => this.options.stableRunMs,
			activeSourceId: () => this.activeSourceId,
			squelchHangMs: () => SQUELCH_HANG_MS,
			effectiveThreshold: run => this.effectiveThreshold(run),
			currentRun: () => this.run,
			handleAudioData: chunk => this.handleAudioData(chunk),
			publishSquelchChange: () => this.publishSquelchChange(),
			handleRunFailure: (run, reason) => this.handleRunFailure(run, reason),
			measureRun: (run, sample) => this.measureRun(run, sample),
			resetFloorForRetune: run => this.resetFloorForRetune(run),
			clearCloseOverride: () => {
				this.closeOverride = null
			},
			rollbackConfig: config => {
				this.config = config
			},
			adoptRun: run => this.adoptRustRun(run),
			markStartError: reason => {
				this.lastError = reason
				this.pipelineHealth = "error"
			},
			emitError: err => this.emitError(err),
			scheduleRestart: lastRunMs => this.scheduleRestart(lastRunMs),
		})
	}

	async start(): Promise<void> {
		this.stopRequested = false
		if (this.http.listening) {
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
				this.planFor(sourceId, this.config)
				this.activeSourceId = sourceId
				this.attachBranch(sourceId)
			}
			await this.startPipelineOrFail()
			if (this.stopRequested) return
			this.emit("started")
			this.log.info("Live demodulation pipeline restarted on request")
			return
		}

		const sourceId = this.resolveSourceId()
		if (!sourceId) throw this.noSourceError()
		this.planFor(sourceId, this.config)

		this.activeSourceId = sourceId
		this.consecutiveFailures = 0
		this.pipelineRestarts = 0
		this.attachBranch(sourceId)
		await this.startPipelineOrFail()
		if (this.stopRequested) return
		await this.startHttpServer()
		if (this.stopRequested) {
			await this.closeHttpServer()
			return
		}
		this.rustRuns.flushDeferredRestart()
		if (this.stopRequested) return
		this.subscribeToSourceCapsChanges()
		this.emit("started")
		this.log.info(
			{ httpPort: this.config.httpPort, sourceId },
			"Live demodulator started",
		)
	}

	/** Stop HTTP admission immediately, before global route draining. */
	shutdownAdmission(): void {
		this.http.shutdownAdmission()
	}

	stopAdmission(): void {
		this.http.stopAdmission()
	}

	async stop(): Promise<void> {
		this.stopRequested = true
		this.stopAdmission()
		if (!this.http.listening && !this.run && !this.rustRuns.hasPendingStart()) {
			this.log.warn("Live demodulator not running")
			return
		}

		this.closeOverride = "stopped"
		try {
			this.silence.disarm("stop")
			this.clearRestartTimer()
			this.unsubscribeFromSourceCapsChanges()
			await this.rustRuns.cancelPendingStart()
			if (this.run) await this.stopRun(this.run)
			this.pipelineHealth = "stopped"
			this.detachBranch()
			this.activeSourceId = null
			this.audio.closeAll("stop", true)
			await this.closeHttpServer()
			// A failure that was still being cleaned up may have scheduled a restart.
			this.clearRestartTimer()

			this.emit("stopped")
			this.log.info("Live demodulator stopped")
		} finally {
			this.closeOverride = null
		}
	}

	async reconfigure(newConfig: LiveDemodReconfigureUpdates): Promise<void> {
		const { agc: agcUpdate, ...rest } = newConfig
		const merged: Record<string, unknown> = { ...this.config, ...rest }
		if (agcUpdate === null) delete merged["agc"]
		else if (agcUpdate !== undefined) merged["agc"] = agcUpdate
		const validated = LiveDemodRuntimeConfigSchema.parse(merged)
		const previous = this.config
		const portChanged = validated.httpPort !== previous.httpPort
		if (portChanged && this.options.httpAccess)
			throw new WaveKitError(
				"Protected audio port changes require deployment reconfiguration",
				"ACCESS_CONFIG_INVALID",
			)
		// WG2 req 7.7 (WG1 n2): compare the resolved source, so an absent id and an explicit id
		// that resolve to the same source neither restart nor close the transmission. Both absent
		// keeps today's behaviour (no change).
		const resolvedAfter = this.resolveSourceId(validated)
		const resolvedBefore = this.activeSourceId ?? this.resolveSourceId(previous)
		const sourceChanged =
			validated.sourceId !== previous.sourceId &&
			resolvedBefore !== resolvedAfter
		// Union of both key sets: `agc: null` deletes a key, which must still count as a change.
		const changedPipelineKeys = (
			[
				...new Set([...Object.keys(previous), ...Object.keys(validated)]),
			] as Array<keyof LiveDemodConfig>
		).filter(key => {
			if (NODE_ONLY_KEYS.has(key)) return false
			if (key === "sourceId") return sourceChanged
			return validated[key] !== previous[key]
		})
		const pipelineChanged = changedPipelineKeys.length > 0
		const active = this.http.listening || this.run !== null

		// Validate the new source and RF plan before detaching the current stream.
		let swapPlan: { front: string } | null = null
		if (sourceChanged || (active && pipelineChanged)) {
			const sourceId = sourceChanged ? resolvedAfter : this.activeSourceId
			if (!sourceId) throw this.noSourceError()
			const planned = this.planFor(sourceId, validated)
			// WG10 req 2.3: an offset-only change keeps the back stage and clients.
			const run = this.run
			if (
				!sourceChanged &&
				run !== null &&
				!run.stopping &&
				changedPipelineKeys.length === 1 &&
				changedPipelineKeys[0] === "offsetHz" &&
				planned.plan.channelSampleRate === run.stream.rate &&
				planned.plan.back === run.backCommand &&
				planned.caps.sampleRate === run.sourceSampleRate &&
				planned.caps.format === run.sourceFormat
			)
				swapPlan = { front: planned.plan.front }
		}

		this.config = validated
		// WG1 req 3.6: any change that restarts the pipeline, or changes one of
		// the transmission identity fields, closes an open transmission as "config".
		const restarting = active && (pipelineChanged || sourceChanged)
		// The source side is `sourceChanged` (resolved before vs after); the helper compares
		// the other identity fields only.
		if (
			restarting ||
			sourceChanged ||
			liveDemodTransmissionConfigChanged(
				{ ...previous, sourceId: undefined },
				{ ...validated, sourceId: undefined },
			)
		)
			this.closeOverride = "config"
		try {
			if (this.run && validated.squelchMode !== previous.squelchMode) {
				this.run.noiseFloorDbfs = null
				this.run.retuneFloorDbfs = null
			}
			if (this.run) {
				this.applySquelchConfig(this.run)
				this.applySquelchThreshold(this.run)
				this.applyToneSquelch(this.run)
			}
			this.publishSquelchChange()

			if (sourceChanged && this.activeSourceId) {
				this.detachBranch()
				const sourceId = this.resolveSourceId()
				if (sourceId) {
					this.activeSourceId = sourceId
					this.attachBranch(sourceId)
				}
			}

			// The hint covers only the synchronous teardown edge above (and the
			// one stopRun emits before its first await). A transmission that
			// opens on the replacement pipeline is a new squelch edge.
			if (!restarting) this.closeOverride = null

			if (restarting) {
				this.consecutiveFailures = 0
				const run = this.run
				if (
					run?.rust &&
					this.rustRuns.canRetune(changedPipelineKeys, validated)
				) {
					this.rustRuns.retune(run, previous, validated)
				} else if (
					swapPlan !== null &&
					run !== null &&
					!rustEngineRequested(this.config)
				) {
					// The transmission closes as "config", as on a full restart.
					run.gateHeld = true
					this.publishSquelchChange()
					this.closeOverride = null
					const outcome = await this.swapFront(run, swapPlan.front)
					if (outcome === "timeout" || outcome === "failed") {
						this.log.warn(
							{ outcome },
							"Live demodulation front swap failed; restarting pipeline",
						)
						if (this.run === run)
							await this.restartPipeline("front swap failed")
					}
				} else {
					if (rustEngineRequested(this.config)) this.rustRuns.clearLatch()
					await this.restartPipeline("configuration changed")
				}
			}
			if (!restarting && this.run?.rust) this.rustRuns.pushSquelch(this.run)

			if (portChanged && this.http.listening) {
				await this.restartHttpServer()
			}

			this.emit("config-changed", this.config)
		} finally {
			this.closeOverride = null
		}
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

		const engineFallback = this.rustRuns.fallback()
		const status: LiveDemodStatus = {
			enabled: this.config.enabled,
			running: this.http.listening,
			sourceId,
			sourceConnected: sourceStatus?.connected ?? false,
			sourceIqSampleRate: rateInfo.iqSampleRate,
			config: this.config,
			effectiveSampleRate:
				this.rustRuns.audioRateHz() ?? rateInfo.effectiveSampleRate,
			decimationFactor: rateInfo.decimation,
			httpUrl: `${this.options.publicOrigin ?? `http://localhost:${this.config.httpPort}`}/stream`,
			wavUrl: `${this.options.publicOrigin ?? `http://localhost:${this.config.httpPort}`}/stream.wav`,
			clientCount: this.audio.size,
			bytesStreamed: this.audio.bytesStreamed,
			pipelineHealth: this.pipelineHealth,
			pipelineRestarts: this.pipelineRestarts,
			engine: this.run?.rust ? "rust" : "csdr",
			...(engineFallback !== null ? { engineFallback } : {}),
		}

		const run = this.run
		if (run) {
			status.squelchOpen = runGateOpen(run)
			status.thresholdDbfs = this.effectiveThreshold(run)
			if (run.noiseFloorDbfs !== null)
				status.noiseFloorDbfs = run.noiseFloorDbfs
			const power = run.rust
				? (run.externalPowerDbfs ?? null)
				: run.squelch.powerDbfs
			if (power !== null) status.channelPowerDbfs = Math.round(power * 10) / 10
		}
		if (this.lastError) status.lastError = this.lastError
		status.agc = effectiveAgc(this.config.modulation, this.config.agc)
		if (run) status.toneSquelch = { state: toneSquelchState(run) }

		return status
	}

	/** Scanner activity adapter: running gate only; stopped/failed is closed. */
	isSquelchOpen(): boolean {
		return (
			this.run !== null &&
			!this.run.stopping &&
			!this.run.gateHeld &&
			runGateOpen(this.run)
		)
	}

	/**
	 * WG10 activity hygiene: monotonic count of measured blocks that carried an FM carrier
	 * (`ChannelSquelch.blockCarrier`), or null when the running pipeline has no carrier
	 * evidence (not nfm/wfm, or not running). The analog transmission tracker takes the
	 * difference across a transmission; the count never affects audio.
	 */
	carrierBlocks(): number | null {
		const run = this.run
		if (run === null || run.stopping || !run.squelch.hasCarrierEvidence)
			return null
		return this.carrierBlockCount
	}

	/** Channel-squelch hang in use, in milliseconds. */
	squelchHangMs(): number {
		return SQUELCH_HANG_MS
	}

	/**
	 * When a `squelch-changed(false)` is the pipeline being torn down by
	 * `stop()` or by a config change that ends a transmission, the close
	 * reason that teardown stands for. Null on a real gate close.
	 */
	transmissionCloseOverride(): "stopped" | "config" | null {
		return this.closeOverride
	}

	private publishSquelchChange(): void {
		const open = this.isSquelchOpen()
		if (open === this.reportedSquelchOpen) return
		this.reportedSquelchOpen = open
		// WG7 req 3.2: the tone gate closes at once with the squelch.
		if (!open) this.run?.tone?.gate?.reset()
		this.emit("squelch-changed", open)
	}

	private effectiveThreshold(run: PipelineRun): number {
		if (this.config.squelchMode !== "auto") return this.config.squelch
		return Math.min(
			-0.001,
			Math.max(
				-160,
				(run.noiseFloorDbfs ?? -0.001) + (this.config.autoMarginDb ?? 6),
			),
		)
	}

	private applySquelchThreshold(run: PipelineRun): void {
		run.squelch.setThreshold(this.effectiveThreshold(run))
	}

	/** WG7 req 2.1: gate source and quieting threshold (Node-only, no restart). */
	private applySquelchConfig(run: PipelineRun): void {
		run.squelch.setNoiseQuietingDb(
			this.config.noiseQuietingDb ?? LIVE_AUDIO_NOISE_QUIETING_DB.default,
		)
		run.squelch.setMode(this.config.squelchMode === "noise" ? "noise" : "power")
		// WG10 req 2.6: squelchMode changes without a restart (modulation restarts).
		run.squelch.setCarrierObserver(
			this.config.squelchMode === "auto" &&
				LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS.includes(this.config.modulation),
		)
		// WG10 activity hygiene: carrier evidence for transmissions, every squelch mode.
		run.squelch.setCarrierEvidence(
			LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS.includes(this.config.modulation),
		)
	}

	/** WG7 req 3.1: (re)builds the tone gate when the configured tone changes. */
	private applyToneSquelch(run: PipelineRun): void {
		const tone = configuredTone(this.config)
		if (tone === null) {
			run.tone = null
			return
		}
		const key = JSON.stringify(tone)
		if (run.tone?.key === key) return
		const gate = this.buildToneGate(tone, run.stream.rate)
		// Align the new gate with the byte stream it joins mid-way.
		gate?.skip(run.pcmPhase, run.stream.format)
		run.tone = { gate, key }
	}

	private buildToneGate(
		tone: ToneSquelchTone,
		rate: number,
	): ToneSquelchGate | null {
		try {
			return new ToneSquelchGate(tone, rate)
		} catch (err) {
			this.log.warn(
				{ err, rate },
				"Tone squelch gate unavailable for this pipeline; live audio stays muted",
			)
			return null
		}
	}

	private measureRun(
		run: PipelineRun,
		sample?: {
			powerDbfs: number | null
			quieted: boolean
			quietingDb?: number | null
		},
	): void {
		if (this.run !== run || run.stopping) return
		const sampled = sample !== undefined
		const power = sampled ? sample.powerDbfs : run.squelch.powerDbfs
		// WG10 req 2.6: a block whose FM quieting shows a carrier never seeds or
		// raises the floor (always false without the auto nfm/wfm observer).
		// A runtime switch out of auto keeps the run's observer: gate on the mode.
		const quieted = sampled
			? sample.quieted
			: this.config.squelchMode === "auto" && run.squelch.blockQuieted()
		if (power !== null) {
			// Constant-memory lower envelope: falls are immediate; a slower open
			// rise preserves calls but eventually recovers from sustained noise steps.
			if (run.noiseFloorDbfs === null) {
				// A quieted block leaves the floor absent; the remembered retune
				// floor waits for the first unquieted block.
				if (!quieted) {
					// WG9 req 5.6: after a retune, a carrier already present must not
					// become its own floor; the previous floor bounds the seed once.
					// Auto squelch only: manual and noise modes seed from power alone.
					const previous =
						this.config.squelchMode === "auto" ? run.retuneFloorDbfs : null
					run.retuneFloorDbfs = null
					run.noiseFloorDbfs =
						previous !== null && previous < power ? previous : power
				}
			} else if (power < run.noiseFloorDbfs) run.noiseFloorDbfs = power
			else if (!quieted) {
				const riseRate = (sampled ? runGateOpen(run) : run.squelch.open)
					? AUTO_FLOOR_OPEN_RISE_DB_PER_SECOND
					: AUTO_FLOOR_CLOSED_RISE_DB_PER_SECOND
				run.noiseFloorDbfs = Math.min(
					power,
					run.noiseFloorDbfs + riseRate * LEVEL_BLOCK_SECONDS,
				)
			}
		}
		// WG7 req 4.1: keeps the hysteresis hold band out of the channel noise.
		// The squelch samples this estimate only while closed (it rises while
		// open), so a held carrier is never judged against its own level.
		run.squelch.setNoiseFloorDbfs(run.noiseFloorDbfs)
		this.applySquelchThreshold(run)
		this.publishSquelchChange()
		// WG10 activity hygiene: counted after the edge, so a transmission opened by this
		// block (its tracker snapshot taken inside publishSquelchChange) includes it.
		// Rust reports quieting directly, so the sampled path uses the same rule as
		// ChannelSquelch.blockCarrier instead of the IQ meter.
		if (sampled) {
			if (this.sampledBlockCarrier(run, sample.quietingDb ?? null))
				this.carrierBlockCount += 1
		} else if (run.squelch.blockCarrier()) this.carrierBlockCount += 1
	}

	/**
	 * `ChannelSquelch.blockCarrier` for one Rust metrics point. Evidence is on
	 * for nfm/wfm. Noise mode compares quieting with the configured threshold;
	 * power mode compares it with `LIVE_AUDIO_NOISE_QUIETING_DB.default`.
	 */
	private sampledBlockCarrier(
		run: PipelineRun,
		quietingDb: number | null,
	): boolean {
		if (!run.squelch.hasCarrierEvidence) return false
		if (quietingDb === null) return false
		// The Rust bridge maps the silent-discriminator token to +∞.
		if (quietingDb === Number.POSITIVE_INFINITY) return true
		const threshold =
			run.squelch.mode === "noise"
				? run.squelch.noiseQuietingDb
				: LIVE_AUDIO_NOISE_QUIETING_DB.default
		return quietingDb >= threshold
	}

	private measuredSquelchStream(
		squelch: ChannelSquelch,
		sampleRate: number,
		measured: () => void,
		frontMeasured: () => void,
	): Transform {
		const blockBytes = Math.max(1, Math.round(sampleRate * 0.01)) * 8
		let remainder = Buffer.alloc(0)
		let awaitingFront = false
		return new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				if (chunk === SQUELCH_ALIGNMENT_RESET) {
					// WG10 req 2.3: drop the old front's partial complex sample.
					const whole = remainder.length - (remainder.length % 8)
					if (whole !== remainder.length)
						remainder = Buffer.from(remainder.subarray(0, whole))
					// WG10 R1 m1: in stream order (after the old front's last bytes), the gate,
					// hang and carrier observer start afresh for the new channel.
					squelch.resetGate()
					awaitingFront = true
					callback()
					return
				}
				const data = remainder.length
					? Buffer.concat([remainder, chunk])
					: chunk
				let offset = 0
				while (data.length - offset >= blockBytes) {
					const output = squelch.process(
						data.subarray(offset, offset + blockBytes),
					)
					offset += blockBytes
					measured()
					if (awaitingFront) {
						awaitingFront = false
						frontMeasured()
					}
					for (const block of output) this.push(block)
				}
				remainder = Buffer.from(data.subarray(offset))
				callback()
			},
			flush(callback) {
				for (const block of squelch.process(remainder)) this.push(block)
				for (const block of squelch.flush()) this.push(block)
				remainder = Buffer.alloc(0)
				callback()
			},
		})
	}

	private startLevelPublishing(): void {
		this.stopLevelPublishing()
		this.levelTimer = setInterval(() => {
			const run = this.run
			if (!run || run.stopping) return
			const level: LiveAudioLevel = {
				sourceId: this.activeSourceId ?? "",
				channelPowerDbfs: run.rust
					? (run.externalPowerDbfs ?? null)
					: run.squelch.powerDbfs,
				noiseFloorDbfs: run.noiseFloorDbfs,
				squelchOpen: runGateOpen(run),
				thresholdDbfs: this.effectiveThreshold(run),
			}
			this.emit("level", level)
		}, 1000 / this.options.levelHz)
		this.levelTimer.unref()
	}

	private stopLevelPublishing(): void {
		if (this.levelTimer) clearInterval(this.levelTimer)
		this.levelTimer = null
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

	private resolveSourceId(config = this.config): string | null {
		if (config.sourceId) {
			return config.sourceId
		}
		if ("getDefaultSourceId" in this.fanoutManager) {
			return this.fanoutManager.getDefaultSourceId() ?? null
		}

		const sources = this.sourceManager.getAllStatus()
		return sources[0]?.id ?? null
	}

	private attachBranch(sourceId: string): void {
		// A legacy single fanout cannot switch radios; retain its initial identity.
		if (!("getFanout" in this.fanoutManager)) this.legacySourceId = sourceId
		this.branchFanout =
			"getFanout" in this.fanoutManager
				? this.fanoutManager.getFanout(sourceId)
				: this.fanoutManager
		const branchId = `live-demod-${sourceId}`
		this.branchId = branchId
		this.branchStream = this.branchFanout.addBranch({
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
		this.branchFanout?.removeBranch(this.branchId)
		this.branchFanout = null
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
			// Retunes can retain the DSP pipeline but invalidate its floor estimate.
			// WG9 req 5.6: the reset stays; the floor it drops is remembered so the
			// first block after it seeds from the lower of that and the new power.
			// A second retune before any block keeps the first remembered floor.
			// Auto squelch only (its threshold derives from the floor); manual and
			// noise modes reset as before.
			if (this.run) this.resetFloorForRetune(this.run)
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

	/** WG9 req 5.6 retune floor handling (also applied by a front swap, WG10 2.3). */
	private resetFloorForRetune(run: PipelineRun): void {
		if (this.config.squelchMode === "auto" && run.noiseFloorDbfs !== null)
			run.retuneFloorDbfs = run.noiseFloorDbfs
		run.noiseFloorDbfs = null
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
		if (!this.http.listening || !this.capsNeedRestart(caps)) return
		if (this.restartTimer) {
			// A crashed pipeline is backing off; that restart reads the new caps.
			this.log.info(
				{ sourceId, newSampleRate: caps.sampleRate, format: caps.format },
				"Source caps changed during restart backoff; the pending restart will use them",
			)
			return
		}
		this.log.info(
			{ sourceId, newSampleRate: caps.sampleRate, format: caps.format },
			"Source sample rate or format changed, restarting pipeline",
		)

		try {
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
		// Rust has no run during the initial crash backoff. Advertise 48 kHz
		// until it recovers. A csdr fallback still closes mismatched clients
		// in restartPipeline ("stream format changed").
		const pending = this.rustRuns?.pendingStream()
		if (pending) return pending
		const sourceId = this.activeSourceId ?? this.config.sourceId
		const rate = sourceId
			? this.calculateRates(sourceId, this.config).effectiveSampleRate
			: liveDemodRates(DEFAULT_IQ_SAMPLE_RATE, this.config).effectiveSampleRate
		return { rate, format: this.config.audioFormat }
	}

	private planFor(sourceId: string, config: LiveDemodConfig) {
		if (this.legacySourceId && sourceId !== this.legacySourceId) {
			throw new WaveKitError(
				"Changing live audio sources requires a source fanout router",
				"LIVE_DEMOD_SOURCE_ROUTING_UNAVAILABLE",
			)
		}
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
			if (!this.http.listening) this.detachBranch()
			this.emitError(error)
			throw error
		}
	}

	/** Installs a Rust run the controller already built. */
	private adoptRustRun(run: PipelineRun): void {
		this.run = run
		this.lastRunStream = run.stream
		this.applyToneSquelch(run)
		this.audio.configure(run.stream)
		this.pipelineHealth = "running"
		this.lastError = null
		this.startLevelPublishing()
		this.publishSquelchChange()
	}

	private async startPipeline(): Promise<void> {
		if (this.stopRequested) return
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

		const planned = this.planFor(this.activeSourceId, this.config)
		if (await this.rustRuns.tryStart(planned)) return
		if (this.stopRequested) return
		const { caps, rateInfo, plan } = planned
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
			thresholdDbfs:
				this.config.squelchMode === "auto" ? -0.001 : this.config.squelch,
			hangMs: SQUELCH_HANG_MS,
			mode: this.config.squelchMode === "noise" ? "noise" : "power",
			noiseQuietingDb:
				this.config.noiseQuietingDb ?? LIVE_AUDIO_NOISE_QUIETING_DB.default,
			...(this.config.bandwidth > 0
				? { bandwidthHz: this.config.bandwidth }
				: {}),
			// WG10 req 2.6: the FM quieting observer exists only in auto nfm/wfm.
			...(this.config.squelchMode === "auto" &&
			LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS.includes(this.config.modulation)
				? { carrierObserver: true }
				: {}),
			// WG10 activity hygiene: carrier evidence for transmissions (never gates).
			...(LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS.includes(this.config.modulation)
				? { carrierEvidence: true }
				: {}),
		})
		const run: PipelineRun = {
			front: this.spawnStage(plan.front),
			back: this.spawnStage(plan.back),
			frontAligner: null,
			frontCommand: plan.front,
			backCommand: plan.back,
			detachFront: () => undefined,
			swap: null,
			gateHeld: false,
			squelch,
			squelchStream: this.measuredSquelchStream(
				squelch,
				plan.channelSampleRate,
				() => this.measureRun(run),
				() => this.releaseSwapHold(run),
			),
			noiseFloorDbfs: null,
			retuneFloorDbfs: null,
			startedAt: Date.now(),
			sourceSampleRate: caps.sampleRate,
			sourceFormat: caps.format,
			stream,
			tone: null,
			pcmPhase: 0,
			pcmTailMuted: false,
			stopping: false,
			failed: false,
		}
		this.run = run
		this.lastRunStream = stream
		this.applyToneSquelch(run)
		this.audio.configure(stream)

		this.wireRun(run)
		this.pipelineHealth = "running"
		this.startLevelPublishing()
		this.publishSquelchChange()
	}

	private spawnStage(command: string): ChildProcess {
		if (this.options.spawnStage) return this.options.spawnStage(command)
		return spawn("/bin/sh", ["-c", command], {
			env: csdrChildEnv(),
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		})
	}

	private ignoreStreamError(role: string): (err: Error) => void {
		return (err: Error) =>
			this.log.debug({ err, role }, "Live demodulation stream error")
	}

	/** Pipe error handlers and the stderr log of one stage. */
	private wireStageIo(role: "front" | "back", proc: ChildProcess): void {
		proc.stdin?.on("error", this.ignoreStreamError(`${role}.stdin`))
		proc.stdout?.on("error", this.ignoreStreamError(`${role}.stdout`))
		proc.stderr?.on("error", this.ignoreStreamError(`${role}.stderr`))
		proc.stderr?.on("data", (data: Buffer) => {
			const message = data.toString().trim()
			if (!message) return
			this.lastError = message
			this.log.warn({ message, role }, "Live demodulation stderr")
		})
	}

	/**
	 * Run-failure handlers of one stage; the returned function removes them
	 * (a swapped-out front's exit is not a run failure, WG10 req 2.3).
	 */
	private wireStageLifecycle(
		run: PipelineRun,
		role: "front" | "back",
		proc: ChildProcess,
	): () => void {
		const onError = (err: Error) => {
			this.log.error({ err, role }, "Live demodulation process error")
			this.handleRunFailure(run, `${role} process error: ${err.message}`)
		}
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			if (run.stopping) return
			this.handleRunFailure(
				run,
				`Live demodulation ${role} process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			)
		}
		proc.on("error", onError)
		proc.once("exit", onExit)
		return () => {
			proc.off("error", onError)
			proc.off("exit", onExit)
			// A late error of a stage being discarded must not throw.
			proc.on("error", this.ignoreStreamError(`${role}.process`))
		}
	}

	private wireRun(run: PipelineRun): void {
		const { front, back, squelchStream } = run
		run.detachFront = this.wireStageLifecycle(run, "front", front)
		this.wireStageLifecycle(run, "back", back)
		this.wireStageIo("front", front)
		this.wireStageIo("back", back)
		squelchStream.on("error", this.ignoreStreamError("squelch"))

		if (this.branchStream && front.stdin) this.branchStream.pipe(front.stdin)
		if (front.stdout && back.stdin) {
			front.stdout.pipe(squelchStream).pipe(back.stdin)
		}
		back.stdout?.on("data", (chunk: Buffer) => {
			if (this.run === run) this.handleAudioData(chunk)
		})
	}

	/**
	 * WG10 req 2.3: make-before-break of the front stage. The branch feeds
	 * both fronts until the new one's first channel IQ (or the timeout, an
	 * error or an exit); the back process, its stdin and every client stay.
	 */
	private swapFront(
		run: PipelineRun,
		command: string,
	): Promise<FrontSwapOutcome> {
		run.swap?.finish("superseded")
		const front = this.spawnStage(command)
		const branch = front.stdin ? this.branchStream : null
		const feed = front.stdin ? new FrontSwapFeed(front.stdin) : null
		const feedListener = (chunk: Buffer) => feed?.push(chunk)
		return new Promise<FrontSwapOutcome>(resolve => {
			let settled = false
			const aligner = new ComplexSampleAligner(() => finish("first"))
			const onError = (err: Error) => {
				this.log.warn(
					{ err: safeErrorFields(err) },
					"Live demodulation swap front process error",
				)
				finish("failed")
			}
			const onExit = () => finish("failed")
			const timer = this.clock.setTimer(
				() => finish("timeout"),
				LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS,
			)
			const swap: PendingFrontSwap = {
				front,
				aligner,
				command,
				finish: outcome => finish(outcome),
			}
			const finish = (outcome: FrontSwapOutcome) => {
				if (settled) return
				settled = true
				this.clock.clearTimer(timer)
				front.off("error", onError)
				front.off("exit", onExit)
				front.on("error", this.ignoreStreamError("front.process"))
				branch?.off("data", feedListener)
				if (run.swap === swap) run.swap = null
				if (outcome === "first" && this.run === run && !run.stopping) {
					this.switchFront(run, swap)
					resolve("swapped")
					return
				}
				this.discardFront(front, aligner)
				resolve(outcome === "first" ? "aborted" : outcome)
			}
			run.swap = swap
			front.on("error", onError)
			front.once("exit", onExit)
			this.wireStageIo("front", front)
			aligner.on("error", this.ignoreStreamError("front.align"))
			if (front.stdout) front.stdout.pipe(aligner)
			// No backpressure from the starting front on the running one (bounded).
			branch?.on("data", feedListener)
		})
	}

	/** Switches the squelch input to the new front at a whole complex sample. */
	private switchFront(run: PipelineRun, swap: PendingFrontSwap): void {
		const old = run.front
		const oldAligner = run.frontAligner
		run.detachFront()
		if (oldAligner !== null) {
			oldAligner.unpipe(run.squelchStream)
			oldAligner.resetAlignment()
		} else old.stdout?.unpipe(run.squelchStream)
		// Sequenced after the old front's last queued bytes: the squelch drops
		// a partial complex sample there, so the new front starts aligned.
		run.squelchStream.write(SQUELCH_ALIGNMENT_RESET)
		run.front = swap.front
		run.frontAligner = swap.aligner
		run.frontCommand = swap.command
		run.detachFront = this.wireStageLifecycle(run, "front", swap.front)
		if (this.branchStream && swap.front.stdin)
			this.branchStream.pipe(swap.front.stdin)
		swap.aligner.pipe(run.squelchStream)
		this.resetFloorForRetune(run)
		this.discardFront(old, oldAligner)
		// WG10 R1 m1: the gate stays held until the squelch has measured the first block of
		// the new front (releaseSwapHold), so the old channel's open gate or hang never
		// publishes a transmission on the new offset.
		this.log.debug("Live demodulation front swapped")
	}

	/** WG10 R1 m1: the first block of the new front was measured; the gate is live again. */
	private releaseSwapHold(run: PipelineRun): void {
		if (this.run !== run || run.stopping || run.swap !== null) return
		if (!run.gateHeld) return
		run.gateHeld = false
		this.publishSquelchChange()
	}

	/** Unpipes and stops a front that no run uses. */
	private discardFront(
		front: ChildProcess,
		aligner: ComplexSampleAligner | null,
	): void {
		if (this.branchStream && front.stdin) this.branchStream.unpipe(front.stdin)
		front.stdout?.unpipe()
		aligner?.unpipe()
		for (const stream of [front.stdin, front.stdout, front.stderr])
			stream?.destroy()
		aligner?.destroy()
		void this.killGroup(front)
	}

	private handleRunFailure(run: PipelineRun, reason: string): void {
		if (this.run !== run || run.stopping || run.failed) return
		run.failed = true
		this.run = null
		this.silence.disarm("failure")
		this.stopLevelPublishing()
		this.publishSquelchChange()
		this.pipelineHealth = "error"
		this.lastError = reason
		this.log.error({ reason }, "Live demodulation pipeline failed")
		this.emitError(new WaveKitError(reason, "LIVE_DEMOD_PIPELINE_EXIT"))
		const runtimeMs = Date.now() - run.startedAt
		if (run.rust) this.rustRuns.noteCrash(runtimeMs)
		void this.stopRun(run).finally(() => this.scheduleRestart(runtimeMs))
	}

	private scheduleRestart(lastRunMs: number): void {
		if (!this.http.listening || this.run || this.restartTimer) return
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
		if (!this.http.listening || this.run) return
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
		const previousStream = this.run?.stream ?? this.lastRunStream
		const stopping = this.run ? this.stopRun(this.run) : null
		// stopRun emits squelch-changed(false) before it waits on the processes.
		this.closeOverride = null
		// WG10 req 2.2: attached clients hear silence until the new run's audio
		// when the restart keeps the stream format.
		const planned = this.plannedStream()
		if (
			this.audio.size > 0 &&
			previousStream !== null &&
			previousStream.rate === planned.rate &&
			previousStream.format === planned.format
		) {
			this.silence.arm(planned)
			this.log.debug(
				{ clients: this.audio.size },
				"Live audio silence fill armed",
			)
		}
		if (stopping) await stopping
		try {
			await this.startPipeline()
		} catch (err) {
			this.silence.disarm("failure")
			throw err
		}
		const stream = this.plannedStream()
		this.audio.closeWhere(
			client =>
				client.stream.rate !== stream.rate ||
				client.stream.format !== stream.format,
			"stream format changed",
			false,
		)
	}

	/**
	 * Stops one run: unpipes, destroys every pipe handle, SIGTERMs both
	 * process groups and escalates to SIGKILL for any group still alive.
	 */
	private async stopRun(run: PipelineRun): Promise<void> {
		run.stopping = true
		if (this.run === run) {
			this.run = null
			this.stopLevelPublishing()
			this.publishSquelchChange()
		}
		const pending = run.swap
		run.swap = null
		pending?.finish("aborted")
		if (run.rust) {
			run.squelchStream.destroy()
			await run.rust.stop()
			if (!this.run && !run.failed) this.pipelineHealth = "stopped"
			return
		}
		if (this.branchStream && run.front.stdin) {
			this.branchStream.unpipe(run.front.stdin)
		}
		run.front.stdout?.unpipe()
		run.frontAligner?.unpipe()
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
		run.frontAligner?.destroy()
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
		await this.http.start(this.config.httpPort, this.options.httpHost)
	}

	/** Closes the server without waiting on streaming clients (they are destroyed). */
	private async closeHttpServer(): Promise<void> {
		if (!this.http.listening) return
		this.audio.closeAll("server closing", true)
		await this.http.close()
	}

	private async restartHttpServer(): Promise<void> {
		if (!this.http.listening) return
		await this.closeHttpServer()
		await this.startHttpServer()
	}

	private resolveRoute(req: http.IncomingMessage): AudioRoute | null {
		const { base, wav } = parseStreamPath(req.url)
		if (base !== "/stream") return null
		return { registry: this.audio, stream: this.plannedStream(), wav }
	}

	/** Registers a streaming response (also used by tests with a stand-in). */
	private registerClient(
		response: http.ServerResponse,
		remoteAddress: string,
		stream: StreamFormat = this.plannedStream(),
	): AudioClient {
		return this.audio.register(response, remoteAddress, stream)
	}

	private get clients(): Map<string, AudioClient> {
		return this.audio.clients
	}

	private handleAudioData(chunk: Buffer): void {
		const run = this.run
		// WG10 req 2.2: the new run's first audio ends the silence fill.
		if (run !== null) this.silence.disarm("audio")
		const phase = run?.pcmPhase ?? 0
		if (run !== null) run.pcmPhase = (phase + chunk.length) % 4
		const tone = run?.tone ?? null
		if (run === null || tone === null) {
			if (run !== null) run.pcmTailMuted = false
			this.audio.write(chunk)
			this.emitPcm(chunk)
			return
		}
		// WG7 req 3.2, 3.3: the pcm listeners (transmission tone detection)
		// see the unmuted audio; only what clients hear is muted.
		this.emitPcm(chunk)
		const format = run.stream.format
		const width = format === "s16le" ? 2 : 4
		// Bytes completing the sample split by the previous chunk: they take
		// that sample's decision, so muting zeroes whole samples only.
		const lead = Math.min(chunk.length, (width - (phase % width)) % width)
		const leadMuted = run.pcmTailMuted
		const gate = tone.gate
		if (gate === null || !runGateOpen(run)) {
			// Without a gate, or while the squelch is closed, clients hear
			// silence. Evidence accumulates only while the squelch is open:
			// PCM still draining from the back chain after a close must not
			// re-arm the gate (req 3.5). Skipped bytes still advance the framing.
			if (gate !== null) gate.skip(chunk.length, format)
			if (leadMuted) chunk.fill(0, 0, lead)
			if (chunk.length > lead) {
				chunk.fill(0, lead)
				run.pcmTailMuted = true
			}
		} else {
			// The gate's state applies per slice of at most TONE_SLICE_MS that
			// starts on a sample boundary, so a large chunk is not passed or
			// muted whole by its final state.
			if (lead > 0) {
				gate.push(chunk, format, 0, lead)
				if (leadMuted) chunk.fill(0, 0, lead)
			}
			const slice =
				Math.max(1, Math.round((run.stream.rate * TONE_SLICE_MS) / 1000)) *
				width
			for (let start = lead; start < chunk.length; start += slice) {
				const end = Math.min(chunk.length, start + slice)
				gate.push(chunk, format, start, end)
				const muted = !gate.open()
				if (muted) chunk.fill(0, start, end)
				run.pcmTailMuted = muted
			}
		}
		this.audio.write(chunk)
	}

	private emitPcm(chunk: Buffer): void {
		if (this.listenerCount("pcm") === 0) return
		const stream = this.run?.stream ?? this.plannedStream()
		let announced = this.pcmFormat
		if (
			announced === null ||
			announced.rate !== stream.rate ||
			announced.format !== stream.format
		) {
			announced = { rate: stream.rate, format: stream.format }
			this.pcmFormat = announced
		}
		this.emit("pcm", chunk, announced)
	}
}

/** Tone gate decisions apply to PCM slices of at most this length (WG7 req 3.2). */
const TONE_SLICE_MS = 10

/** The configured tone of a tone squelch gate, or null (absent, `none` or not NFM). */
function configuredTone(config: LiveDemodConfig): ToneSquelchTone | null {
	const tone = config.toneSquelch
	if (tone === undefined || tone.kind === "none") return null
	if (config.modulation !== "nfm") return null
	return tone
}

function runGateOpen(run: PipelineRun): boolean {
	return run.externalGate ?? run.squelch.open
}

function toneSquelchState(run: PipelineRun): "off" | "waiting" | "open" {
	if (run.tone === null) return "off"
	if (!runGateOpen(run) || run.tone.gate === null) return "waiting"
	return run.tone.gate.state
}
