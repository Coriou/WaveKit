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
	DCS_STANDARD_CODES,
	LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS,
	LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS,
	LIVE_AUDIO_NOISE_QUIETING_DB,
	LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS,
	LIVE_AUDIO_SQUELCH_MODES,
	type AnalogTransmissionDcs,
	type LiveAudioAutoRoute,
	type LiveAudioAutoRouteLevel,
	type LiveAudioAutoSquelch,
	type LiveAudioSquelchMode,
} from "@wavekit/api-types"
import {
	LiveDemodRuntimeBaseSchema,
	type LiveDemodRuntimeBaseConfig as BaseLiveDemodConfig,
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
import { isCtcssToneHz } from "./audio-tones/ctcss.js"
import {
	ToneSquelchGate,
	type ToneSquelchTone,
} from "./audio-tones/tone-squelch.js"
import { CarrierBlockLog } from "./analog-transmission.js"
import { liveDemodTransmissionConfigChanged } from "./live-demod-activity.js"
import {
	DEFAULT_IQ_SAMPLE_RATE,
	liveDemodRates,
	effectiveAgc,
	backChainDrainSamples,
	backChainPcmLeadSamples,
	planLiveDemodPipeline,
	type DemodRateInfo,
} from "./live-demod-pipeline.js"
import {
	RustLiveRun,
	metricsQuieted,
	rustEngineRequested,
} from "./live-demod/rust-run.js"
import type { FramedMarker } from "./evidence-squelch/framed-audio-parser.js"
import type { EngineFallbackReason } from "./live-demod/index.js"
import type { RustEngine } from "./live-demod/rust-engine.js"
import {
	EVIDENCE_NOTE_DISCARD,
	evidenceDeviationHz,
	evidenceGateApplies,
	pcmSampleBytes,
	type EvidenceSquelchFactory,
	type PreRollTag,
} from "./evidence-squelch/contract.js"
import { EvidenceGate } from "./evidence-squelch/evidence-gate.js"
import {
	applyFramedMarker,
	processEvidenceChunk,
	type EvidencePreRollTap,
	type EvidenceWiring,
} from "./evidence-squelch/wiring.js"
import { PreRoll } from "./evidence-squelch/pre-roll.js"
import { AutoListenRouter } from "./auto-listen/router.js"
import { AUTO_ROUTE_STREAM } from "./auto-listen/contract.js"
import type {
	AutoRouteClock,
	VoiceCoveragePort,
	VoiceTapSource,
} from "./auto-listen/contract.js"
import { PreRollShadow } from "./auto-listen/preroll-shadow.js"
import { ANALOG_TRIAL_AM_CARRIER_DB } from "./scanner/scanner-redesign-contract.js"
import {
	DEFAULT_BRANCH_BUFFER_MS,
	type FanoutManager,
} from "./fanout-manager.js"
import { frameBytesFor } from "./link-burst/contract.js"
import type { SourceFanoutRouter } from "./source-fanout-router.js"
import type { SourceManager } from "./source-manager.js"

/**
 * Runtime schema: the startup schema without the config-only `publicOrigin`
 * (with its WG7 refinements: noise squelch only on nfm/wfm, tone squelch only
 * on nfm with a standard tone) plus the runtime defaults of the squelch keys.
 */
export const LiveDemodRuntimeConfigSchema = LiveDemodRuntimeBaseSchema.and(
	z.object({
		squelchMode: z
			.enum(LIVE_AUDIO_SQUELCH_MODES as [LiveAudioSquelchMode])
			.default("auto"),
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
	/** Evidence squelch gate state (a fresh object per level). */
	autoSquelch?: LiveAudioAutoSquelch
	/** Auto listen route selection while `/auto` has a client (a fresh object per level). */
	autoRoute?: LiveAudioAutoRouteLevel
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
	/** Evidence squelch gate state, while running (`off` when not evidence-gated). */
	autoSquelch?: LiveAudioAutoSquelch
	/**
	 * WG12 req 6.4: current or last closed transmission's tone, while running.
	 * Absent until one is reported; cleared on retune and stop.
	 */
	tone?: {
		ctcssHz: number | null
		dcs: AnalogTransmissionDcs | null
		at: string
	}
	/** Auto listen route (`/auto`), present whenever the HTTP server listens. */
	autoRoute?: LiveAudioAutoRoute
}

/** Who changed the live config: a reconfigure() call, or an automatic path. */
export type LiveDemodConfigOrigin = "user" | "other"

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
	/**
	 * `origin` is "user" for a reconfigure() write (REST, scanner listen) and
	 * "other" for an automatic change (a rejected Rust retune rolling back).
	 */
	"config-changed": (
		config: LiveDemodConfig,
		origin: LiveDemodConfigOrigin,
	) => void
	"client-connected": (clientId: string) => void
	"client-disconnected": (clientId: string) => void
	/** Auto listen route: once per change of the active source or digital decoder. */
	"auto-route-changed": (level: LiveAudioAutoRouteLevel) => void
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
	/**
	 * Evidence squelch ports (A5). Absent: the real `EvidenceGate` and `PreRoll`
	 * (`DEFAULT_EVIDENCE_SQUELCH`); tests inject fakes.
	 */
	evidenceSquelch?: EvidenceSquelchFactory
	/** Auto listen route pacer clock (tests inject one; default monotonic). */
	autoRouteClock?: AutoRouteClock
}

type InjectedOptionKeys =
	| "evidenceSquelch"
	| "autoRouteClock"
	| "httpAccess"
	| "publicOrigin"
	| "httpHost"
	| "spawnStage"
	| "clock"
type ResolvedOptions = Required<
	Omit<LiveDemodulatorOptions, InjectedOptionKeys>
> &
	Pick<LiveDemodulatorOptions, InjectedOptionKeys>

/** Evidence squelch state of one run (streams in `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS` only). */
interface RunEvidence extends EvidenceWiring {
	/**
	 * Tag-only replay of `preRoll` for `/auto` qualification (auto-listen-route 3.6, 3.7),
	 * built, cleared and dropped with it; null when it could not be built (analog on `/auto`
	 * stays silent on the evidence path: fail closed).
	 */
	shadow: PreRollShadow | null
	/** Mirrors every wiring pre-roll call on `shadow` and feeds `/auto` (set at build). */
	tap: EvidencePreRollTap | null
	/** `evidenceAppliesTo` when last synced; a flip resets the gate and clears the pre-roll. */
	active: boolean
}

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
	/** Evidence squelch A19: PCM bytes received this run (csdr runs with `muteZeros`). */
	pcmBytes?: number
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
	/**
	 * Evidence squelch gate and pre-roll, built at run start for streams whose modulation is in
	 * `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS` (NFM only, amendment A8) in every squelch mode when a factory is configured; null otherwise or when the factory failed.
	 * Absent until first synced (a Rust run is built by its controller).
	 */
	evidence?: RunEvidence | null
	/** Modulation and gain `evidence` was built for (rebuilt when either changes in place). */
	evidenceModulation?: LiveDemodConfig["modulation"]
	evidenceGain?: number
	/** Channel bandwidth `evidence` was built for (A13: sets the voice meter's reference). */
	evidenceBandwidth?: number
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
	private readonly carrierLog = new CarrierBlockLog()
	/**
	 * Set only while `stop()` or a transmission-closing `reconfigure()` is in
	 * progress. `stopRun` emits `squelch-changed(false)` before `stopped` or
	 * `config-changed`; the tracker reads this during that synchronous emit.
	 */
	private closeOverride: "stopped" | "config" | null = null
	/**
	 * WG12 req 6.4: tone of the current or last closed transmission. Shown by
	 * getStatus() only while HTTP is listening. Cleared on retune and stop.
	 * `channelGeneration` starts at 0 and increments on each clear.
	 * `channelSinceMs` is that clear's time (0 before the first clear).
	 */
	private channelTone: {
		ctcssHz: number | null
		dcs: AnalogTransmissionDcs | null
		at: string
	} | null = null
	private channelGeneration = 0
	private channelSinceMs = 0
	/** Centre frequency of the channel the remembered tone belongs to. */
	private toneCentreHz: number | undefined
	/**
	 * `stop()` won over an in-flight `start()`. The handshake must not adopt a
	 * run or bring HTTP up after `stop()` has begun.
	 */
	private stopRequested = false
	private config: LiveDemodConfig
	private readonly http: AudioHttpServer
	private readonly audio: AudioClientRegistry
	/** `/auto`: one stream that plays the analog over or covering digital voice. */
	private readonly autoRoute: AutoListenRouter
	private autoShadowMismatchLogged = false
	/** Stream byte phase (mod 4) of the chunk being handled, for `/auto` sample alignment. */
	private autoPhase = 0
	/**
	 * False after a connect from zero clients or an analog reset: the next `/auto` span is cut
	 * to the run's next sample boundary, so the router never starts mid-sample.
	 */
	private autoAligned = false
	private run: PipelineRun | null = null
	private branchId: string | null = null
	/** Source byte rate (caps) the attached branch was added at; null when unknown. */
	private branchByteRate: number | null = null
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
		this.autoRoute = new AutoListenRouter(this.log, {
			stallTimeoutMs: this.options.clientStallTimeoutMs,
			...(options.autoRouteClock !== undefined
				? { clock: options.autoRouteClock }
				: {}),
		})
		// A first client (connect or reconnect) re-aligns the next analog span.
		this.autoRoute.registry.on("client-connected", () => {
			if (this.autoRoute.registry.size === 1) this.autoAligned = false
		})
		this.autoRoute.on("auto-route-changed", (level: LiveAudioAutoRouteLevel) =>
			this.emit("auto-route-changed", level),
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
			handleAudioMarker: (run, marker, stage1Open) =>
				this.handleFramedMarker(run, marker, stage1Open),
			handleAudioFault: run => {
				// A18 fail safe: `framing` is "failed", so the predicate flips; drop held audio now.
				this.resetEvidence(run)
			},
			publishSquelchChange: () => this.publishSquelchChange(),
			handleRunFailure: (run, reason) => this.handleRunFailure(run, reason),
			measureRun: (run, sample) => this.measureRun(run, sample),
			noteDiscontinuity: (run, sampleIndex, dropped, cause) => {
				if (this.run === run && run.squelch.hasCarrierEvidence)
					this.carrierLog.noteDiscontinuity(
						run,
						run.stream.rate,
						sampleIndex,
						dropped,
						cause,
					)
			},
			resetFloorForRetune: run => {
				this.resetFloorForRetune(run)
				this.resetEvidence(run)
				this.resetAutoAnalog()
			},
			clearCloseOverride: () => {
				this.closeOverride = null
			},
			rollbackConfig: (candidate, acked) => {
				// The partial rollback keeps edits made while the retune was in flight.
				// When that mix breaks a squelch dependency (noise or tone squelch on a
				// restored modulation that does not allow it), only the squelch mode and
				// tone go back too, so unrelated edits (httpPort, squelch level) stay.
				this.config = repairedRollback(candidate, acked)
				if (this.run) {
					this.applySquelchConfig(this.run)
					this.applySquelchThreshold(this.run)
					this.applyToneSquelch(this.run)
					this.syncEvidence(this.run)
				}
				this.publishSquelchChange()
				this.emit("config-changed", this.config, "other")
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
		this.clearChannelTone()
		this.stopAdmission()
		if (!this.http.listening && !this.run && !this.rustRuns.hasPendingStart()) {
			this.log.warn("Live demodulator not running")
			return
		}

		this.closeOverride = "stopped"
		try {
			if (this.run) this.resetEvidence(this.run)
			this.resetAutoAnalog()
			this.silence.disarm("stop")
			this.clearRestartTimer()
			this.unsubscribeFromSourceCapsChanges()
			await this.rustRuns.cancelPendingStart()
			if (this.run) await this.stopRun(this.run)
			this.pipelineHealth = "stopped"
			this.detachBranch()
			this.activeSourceId = null
			this.audio.closeAll("stop", true)
			this.autoRoute.registry.closeAll("stop", true)
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
		this.rustRuns.noteEngineSelection(validated)
		// WG12 req 6.4: a centre move (offset) or a source change leaves the channel.
		// Squelch-only changes keep the tone of the transmission still on frequency.
		if (sourceChanged || changedPipelineKeys.includes("offsetHz"))
			this.clearChannelTone()
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
				// A restarted run builds its own evidence path at start.
				if (!restarting) this.syncEvidence(this.run)
			}
			this.publishSquelchChange()

			if (sourceChanged && this.activeSourceId) {
				this.detachBranch()
				const sourceId = this.resolveSourceId()
				if (sourceId) {
					this.activeSourceId = sourceId
					this.toneCentreHz = this.sourceManager.getCaps(sourceId)?.centerFreq
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
					this.syncEvidence(run)
				} else if (
					swapPlan !== null &&
					run !== null &&
					(!rustEngineRequested(this.config) ||
						(!run.rust &&
							!this.rustRuns.wouldStartRust(this.config, run.sourceFormat)))
				) {
					// The transmission closes as "config", as on a full restart.
					run.gateHeld = true
					this.publishSquelchChange()
					// Requirement 2.9: the swap start clears the gate and the pre-roll.
					this.resetEvidence(run)
					this.resetAutoAnalog()
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

			this.emit("config-changed", this.config, "user")
		} finally {
			this.closeOverride = null
		}
	}

	/**
	 * `diagnostics` (DIAGNOSTIC AND UNSTABLE, 2026-10-24) adds the evidence gate's current voice
	 * window to `autoSquelch`; computed on demand, never on level events.
	 */
	getStatus(options: { diagnostics?: boolean } = {}): LiveDemodStatus {
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
		if (run) {
			status.toneSquelch = { state: toneSquelchState(run) }
			status.autoSquelch = this.autoSquelchState(
				run,
				options.diagnostics === true,
			)
		}
		if (this.http.listening && this.channelTone !== null)
			status.tone = copyChannelTone(this.channelTone)
		if (this.http.listening) {
			const origin =
				this.options.publicOrigin ?? `http://localhost:${this.config.httpPort}`
			status.autoRoute = this.autoRoute.status({
				httpUrl: `${origin}/auto`,
				wavUrl: `${origin}/auto.wav`,
			})
		}

		return status
	}

	/**
	 * WG12 req 6.4: remember the current or last closed transmission's tone.
	 * Off-table CTCSS or DCS becomes null. An empty, over-long, or non-time `at` is ignored.
	 * `null` clears the remembered tone and does not start a new channel.
	 * Stop, a centre retune, and an offset or source change do both.
	 *
	 * A note from the previous channel is ignored. Pass `startedAt` (ISO time
	 * the transmission opened): a start strictly before the latest clear is
	 * the old channel. Or pass `generation`, the value of the channel
	 * generation when that transmission opened: any other generation is the
	 * old channel. When both are passed, either one is enough to ignore the
	 * note. A note with neither applies to the current channel. getStatus()
	 * omits the tone until running.
	 */
	noteTransmissionTone(
		tone: {
			ctcssHz: number | null
			dcs: AnalogTransmissionDcs | null
			at: string
			startedAt?: string
			generation?: number
		} | null,
	): void {
		if (tone === null) {
			this.channelTone = null
			return
		}
		if (
			typeof tone.at !== "string" ||
			tone.at.length === 0 ||
			tone.at.length > 64 ||
			!isCanonicalIsoTime(tone.at)
		)
			return
		if (!this.toneOnCurrentChannel(tone)) return
		this.channelTone = {
			ctcssHz:
				typeof tone.ctcssHz === "number" && isCtcssToneHz(tone.ctcssHz)
					? tone.ctcssHz
					: null,
			dcs: standardDcs(tone.dcs),
			at: tone.at,
		}
	}

	/** Drop the tone and open a new channel generation (WG12 req 6.4). */
	private clearChannelTone(): void {
		this.channelGeneration += 1
		this.channelSinceMs = Date.now()
		this.channelTone = null
	}

	/**
	 * True when the note is for the channel since the latest clear. A start
	 * time is compared in milliseconds; a transmission that opened in the
	 * same millisecond as the clear is kept.
	 */
	private toneOnCurrentChannel(tone: {
		startedAt?: string
		generation?: number
	}): boolean {
		const generation: unknown = tone.generation
		if (generation !== undefined) {
			if (
				typeof generation !== "number" ||
				!Number.isInteger(generation) ||
				generation !== this.channelGeneration
			)
				return false
		}
		const startedAt: unknown = tone.startedAt
		if (startedAt === undefined) return true
		if (typeof startedAt !== "string") return false
		const started = Date.parse(startedAt)
		if (!Number.isFinite(started)) return false
		return started >= this.channelSinceMs
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

	/** WG10 req 3.8.1: the per-block carrier log; null exactly when `carrierBlocks()` is. */
	carrierBlockLog(): CarrierBlockLog | null {
		return this.carrierBlocks() === null ? null : this.carrierLog
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
		// A close before a latch discards the over's evidence and its held audio. A held gate
		// (offset swap, Rust identity retune) is cleared by whoever held it.
		const run = this.run
		// A18 (9.12): on a framed Rust run only the in-band markers write evidence state.
		if (
			!open &&
			run !== null &&
			!run.gateHeld &&
			run.rust?.framing !== "active"
		) {
			const evidence = this.activeEvidence(run)
			if (evidence !== null && evidence.gate.state === "waiting") {
				evidence.gate.reset()
				evidence.preRoll.abandon()
				evidence.shadow?.abandon()
			}
		}
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
			blockIndex?: number
			gateOpen?: boolean
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
		// Evidence squelch: one measured block while stage 1 is open (A4: a held gate is closed).
		// A18: a framed Rust run notes its blocks from the in-band BLOCK markers instead.
		const evidence =
			run.rust?.framing === "active" ? null : this.activeEvidence(run)
		if (evidence !== null && runGateOpen(run) && !run.gateHeld) {
			// A carrier onset while waiting reset the gate's voice window: the held noise lead-in
			// stage 1 was open on is not the over (amendment 2026-10-23; the gate decides).
			const flags = evidence.gate.noteBlock(
				this.evidenceCarrier(run, power, sample),
			)
			if ((flags & EVIDENCE_NOTE_DISCARD) !== 0) {
				evidence.preRoll.abandon()
				evidence.shadow?.abandon()
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
		const carried = sampled
			? this.sampledBlockCarrier(run, sample.quietingDb ?? null)
			: run.squelch.blockCarrier()
		if (carried) this.carrierBlockCount += 1
		// WG10 req 3.8.1: the per-block record the transmission tracker consumes in order.
		if (run.squelch.hasCarrierEvidence)
			this.carrierLog.note(
				run,
				run.stream.rate,
				// A held gate (unacknowledged retune, offset swap) is closed whatever native says.
				(sample?.gateOpen ?? this.reportedSquelchOpen) &&
					!run.gateHeld &&
					!run.stopping,
				carried,
				sample?.blockIndex,
			)
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
			level.autoSquelch = this.autoSquelchState(run)
			if (this.autoRoute.wanted) level.autoRoute = this.autoRoute.level()
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
		this.branchByteRate = this.byteRateOf(sourceId)
		this.branchStream = this.branchFanout.addBranch({
			id: branchId,
			sourceId,
			highWaterMarkMs: DEFAULT_BRANCH_BUFFER_MS,
		})
		this.branchErrorHandler = err => {
			this.log.warn({ err }, "Live demodulation branch error")
		}
		this.branchStream.on("error", this.branchErrorHandler)
	}

	/**
	 * The branch mark is DEFAULT_BRANCH_BUFFER_MS of signal at the fanout's
	 * byte rate, which the source router sets from the caps (1 200 000 bytes
	 * at 2.4 Msps CU8, not a fixed 256 KiB, 54.6 ms there) and resizes on a
	 * rate change. A fanout with no rate keeps the 256 KiB floor. This is the
	 * caps' byte rate, only to tell when the source rate changed.
	 */
	private byteRateOf(sourceId: string): number | null {
		const caps = this.sourceManager.getCaps(sourceId)
		const frame = caps ? frameBytesFor(caps.format) : null
		return caps && frame !== null ? caps.sampleRate * frame : null
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
		const sourceId = this.activeSourceId
		this.toneCentreHz = sourceId
			? this.sourceManager.getCaps(sourceId)?.centerFreq
			: undefined

		this.capsChangedHandler = (sourceId: string, caps: SourceCaps) => {
			if (sourceId !== this.activeSourceId) return
			// WG12 req 6.4: a centre retune leaves the channel even when the DSP stays up.
			// Gain, rate and format updates keep the tone of the transmission still on frequency.
			if (caps.centerFreq !== this.toneCentreHz) {
				this.toneCentreHz = caps.centerFreq
				this.clearChannelTone()
			}
			// Retunes can retain the DSP pipeline but invalidate its floor estimate.
			// WG9 req 5.6: the reset stays; the floor it drops is remembered so the
			// first block after it seeds from the lower of that and the new power.
			// A second retune before any block keeps the first remembered floor.
			// Auto squelch only (its threshold derives from the floor); manual and
			// noise modes reset as before.
			if (this.run) {
				this.resetFloorForRetune(this.run)
				this.resetEvidence(this.run)
			}
			this.resetAutoAnalog()
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
		this.syncEvidence(run)
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
			// Evidence squelch A19: closed envelope-demodulator runs are silent at any rate.
			...(ENVELOPE_MUTE_MODULATIONS.has(this.config.modulation)
				? {
						muteZeros: true,
						pcmLeadSamples: backChainPcmLeadSamples(plan.back),
					}
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
		this.syncEvidence(run)
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
		// The fanout resizes the branch mark itself (setByteRate). The branch is
		// still replaced on a rate change: it may hold samples at the old rate,
		// which the new run must not read.
		const sourceId = this.activeSourceId
		if (
			sourceId &&
			this.branchStream &&
			this.byteRateOf(sourceId) !== this.branchByteRate
		) {
			this.detachBranch()
			this.attachBranch(sourceId)
		}
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
			this.resetAutoAnalog()
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
		this.autoRoute.registry.closeAll("server closing", true)
		await this.http.close()
	}

	private async restartHttpServer(): Promise<void> {
		if (!this.http.listening) return
		await this.closeHttpServer()
		await this.startHttpServer()
	}

	private resolveRoute(req: http.IncomingMessage): AudioRoute | null {
		const { base, wav } = parseStreamPath(req.url)
		// auto-listen-route 1.1, 1.2: same server, access adapter, leases and CORS as /stream.
		if (base === "/auto")
			return {
				registry: this.autoRoute.registry,
				stream: AUTO_ROUTE_STREAM,
				wav,
			}
		if (base !== "/stream") return null
		return { registry: this.audio, stream: this.plannedStream(), wav }
	}

	/**
	 * Digital voice for `/auto` (auto-listen-route 3.3, 3.4): the voice taps and the coverage
	 * port (its `generation` bumps on every event that can change coverage; `covers` is called
	 * only on a generation change). Without it `/auto` is analog only.
	 */
	attachAutoRouteVoice(
		source: VoiceTapSource,
		coverage: VoiceCoveragePort,
	): void {
		this.autoRoute.attachVoice(source, coverage)
	}

	/** One sample-aligned `/auto` span of the client bytes (requirement 3.6). */
	private pushAuto(
		chunk: Buffer,
		start: number,
		end: number,
		audible: boolean,
		stream: StreamFormat,
	): void {
		if (end <= start) return
		if (!this.autoAligned) {
			// Bytes finishing a sample the router never saw the start of are skipped.
			const width = pcmSampleBytes(stream.format)
			const skip = (width - ((this.autoPhase + start) % width)) % width
			if (end - start <= skip) {
				if (end - start === skip) this.autoAligned = true
				return
			}
			start += skip
			this.autoAligned = true
		}
		this.autoRoute.pushAnalog(chunk, start, end, audible, stream)
	}

	/** Clears `/auto` analog (FIFO, resampler, split sample) and re-aligns the next span. */
	private resetAutoAnalog(): void {
		this.autoRoute.resetAnalog()
		this.autoAligned = false
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
		// Evidence squelch A19: PCM from closed channel samples is exact zeros (csdr AM family).
		if (run !== null && run.squelch.mutesClosedPcm) {
			const at = run.pcmBytes ?? 0
			run.squelch.muteClosedPcm(
				chunk,
				at,
				run.stream.format === "s16le" ? 2 : 4,
			)
			run.pcmBytes = at + chunk.length
		}
		// WG10 req 3.8.1: output-sample position of the run's PCM for the tracker.
		if (run !== null)
			this.carrierLog.notePcm(run, run.stream.rate, chunk.length)
		// WG10 req 2.2: the new run's first audio ends the silence fill.
		if (run !== null) this.silence.disarm("audio")
		const phase = run?.pcmPhase ?? 0
		this.autoPhase = phase
		if (!this.autoRoute.wanted) this.autoAligned = false
		if (run !== null) run.pcmPhase = (phase + chunk.length) % 4
		const tone = run?.tone ?? null
		const evidence =
			run !== null && tone === null ? this.syncEvidence(run) : null
		if (run !== null && evidence !== null) {
			run.pcmTailMuted = false
			// Decode regardless of listening: pcm listeners see the chunk before any rewrite.
			this.emitPcm(chunk)
			this.processEvidence(run, evidence, chunk, phase)
			this.audio.write(chunk)
			return
		}
		if (run === null || tone === null) {
			if (run !== null) {
				run.pcmTailMuted = false
				if (this.autoRoute.wanted)
					this.pushAuto(chunk, 0, chunk.length, runGateOpen(run), run.stream)
			}
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
			if (this.autoRoute.wanted) {
				// The lead keeps its sample's decision (an unmuted lead is the end of an open slice).
				this.pushAuto(chunk, 0, lead, !leadMuted, run.stream)
				this.pushAuto(chunk, lead, chunk.length, false, run.stream)
			}
		} else {
			const wanted = this.autoRoute.wanted
			// The gate's state applies per slice of at most TONE_SLICE_MS that
			// starts on a sample boundary, so a large chunk is not passed or
			// muted whole by its final state.
			if (lead > 0) {
				gate.push(chunk, format, 0, lead)
				if (leadMuted) chunk.fill(0, 0, lead)
				if (wanted) this.pushAuto(chunk, 0, lead, !leadMuted, run.stream)
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
				if (wanted) this.pushAuto(chunk, start, end, !muted, run.stream)
			}
		}
		this.audio.write(chunk)
	}

	/**
	 * Builds the run's evidence path when missing or stale (modulation or gain changed in
	 * place), resets it on any flip of `evidenceAppliesTo`, and returns it while it governs
	 * client audio (csdr engine, no tone squelch), else null.
	 */
	private syncEvidence(run: PipelineRun): RunEvidence | null {
		const factory = this.options.evidenceSquelch ?? DEFAULT_EVIDENCE_SQUELCH
		const { modulation, gain, bandwidth } = this.config
		if (
			run.evidenceModulation !== modulation ||
			run.evidenceGain !== gain ||
			run.evidenceBandwidth !== bandwidth
		) {
			run.evidenceModulation = modulation
			run.evidenceGain = gain
			run.evidenceBandwidth = bandwidth
			run.evidence = this.buildEvidence(factory, run)
		}
		const evidence = run.evidence ?? null
		if (evidence === null) return null
		const applies = this.evidenceAppliesTo(run)
		if (applies !== evidence.active) {
			evidence.active = applies
			this.resetEvidence(run)
		}
		return applies ? evidence : null
	}

	private buildEvidence(
		factory: EvidenceSquelchFactory,
		run: PipelineRun,
	): RunEvidence | null {
		const modulation = this.config.modulation
		// Amendment A8: no instances outside the evidence modulations (AM included).
		// Amendment A12: none on an unframed Rust run (stage-1 auto squelch only); A18: framed
		// Rust runs build it.
		if (
			(run.rust !== undefined && run.rust.framing !== "active") ||
			!LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS.includes(modulation) ||
			(modulation !== "nfm" && modulation !== "am")
		)
			return null
		const { rate, format } = run.stream
		try {
			// A13: the voice meter's audio reference follows the channel plan (NFM only).
			const gate = factory.createGate({
				rate,
				modulation,
				gain: this.config.gain,
				// A16 revision: the guard is the back chain's lag plus one 10 ms block.
				// A18: on Rust, the Rust chain's own lag in output samples.
				drainLagSamples:
					run.rust !== undefined
						? run.rust.groupDelaySamples
						: backChainDrainSamples(run.backCommand),
				...(modulation === "nfm"
					? { deviationHz: evidenceDeviationHz(this.config.bandwidth) }
					: {}),
			})
			const preRoll = factory.createPreRoll({ rate, format })
			let shadow: PreRollShadow | null = null
			try {
				shadow = new PreRollShadow({ rate, format })
			} catch {
				// Fail closed: evidence-path analog never qualifies on /auto for this run.
				shadow = null
			}
			const evidence: RunEvidence = {
				gate,
				preRoll,
				shadow,
				tap: null,
				tailTag: "drop",
				active: this.evidenceAppliesTo(run),
				// Resolved against the next chunk's phase (processEvidence).
				aligned: false,
			}
			evidence.tap = this.autoTap(run, evidence)
			return evidence
		} catch (err) {
			// A5: the run keeps the frozen stage-1 path.
			this.log.warn(
				{ err: safeErrorFields(err), rate, modulation },
				"Evidence squelch unavailable for this pipeline; stage-1 squelch only",
			)
			return null
		}
	}

	/** The evidence path when it governs client audio now (no build, no reset). */
	private activeEvidence(run: PipelineRun): RunEvidence | null {
		const evidence = run.evidence ?? null
		if (evidence === null || !evidence.active) return null
		return this.evidenceAppliesTo(run) ? evidence : null
	}

	/**
	 * True when the evidence gate governs this run's client audio: `evidenceGateApplies` for
	 * the config, no tone squelch, and the csdr engine or a framed Rust run (A18: stage 1 rides
	 * in-band with the audio). Amendment A12 stands for unframed and failed-safe Rust runs: they
	 * keep the stage-1 auto squelch.
	 */
	private evidenceAppliesTo(run: PipelineRun): boolean {
		return (
			(run.rust === undefined || run.rust.framing === "active") &&
			run.tone === null &&
			evidenceGateApplies(this.config)
		)
	}

	/**
	 * A18: one in-band marker of a framed Rust run, at its exact sample boundary
	 * (`applyFramedMarker`): gate close, block carrier evidence, and the full clear on RESET
	 * and DROP (9.13).
	 */
	private handleFramedMarker(
		run: PipelineRun,
		marker: FramedMarker,
		stage1Open: boolean,
	): void {
		if (this.run !== run || run.stopping || run.tone !== null) return
		const evidence = this.syncEvidence(run)
		if (evidence === null) return
		applyFramedMarker(
			evidence,
			marker,
			stage1Open,
			run.gateHeld,
			block => {
				const power = Number.isFinite(block.powerDbfs) ? block.powerDbfs : null
				const quieting = Number.isNaN(block.quietingDb)
					? null
					: block.quietingDb
				return this.evidenceCarrier(run, power, {
					quieted: metricsQuieted(this.config, quieting),
				})
			},
			() => this.resetEvidence(run),
		)
	}

	/** Drops evidence, the latch and every held byte (flip, swap start, retune, stop). */
	private resetEvidence(run: PipelineRun): void {
		const evidence = run.evidence ?? null
		if (evidence === null) return
		evidence.gate.reset()
		evidence.preRoll.clear()
		evidence.shadow?.clear()
		evidence.tailTag = "drop"
		evidence.aligned = false
	}

	/** Requirement 4.1: present while the pipeline runs; `off` outside the evidence path. */
	private autoSquelchState(
		run: PipelineRun,
		diagnostics = false,
	): LiveAudioAutoSquelch {
		const evidence = this.activeEvidence(run)
		if (evidence === null) return { state: "off" }
		const { state, evidence: kind } = evidence.gate
		const out: LiveAudioAutoSquelch =
			kind !== null ? { state, evidence: kind } : { state }
		if (diagnostics && evidence.gate.diagnostics !== undefined)
			out.diagnostics = evidence.gate.diagnostics()
		return out
	}

	/**
	 * Per-block carrier evidence for the gate's quieting window. Only framed Rust BLOCK markers
	 * pass a `sample` (A18); csdr measures its own blocks.
	 */
	private evidenceCarrier(
		run: PipelineRun,
		power: number | null,
		sample: { quieted: boolean } | undefined,
	): boolean {
		if (this.config.modulation === "am")
			return (
				power !== null &&
				run.noiseFloorDbfs !== null &&
				power >= run.noiseFloorDbfs + ANALOG_TRIAL_AM_CARRIER_DB
			)
		return sample !== undefined ? sample.quieted : run.squelch.blockQuieted()
	}

	/**
	 * Tags the chunk for the pre-roll (`processEvidenceChunk`, evidence-squelch/wiring.ts) with
	 * stage 1 as reported (A4: a held gate is closed), sampled at chunk arrival.
	 */
	private processEvidence(
		run: PipelineRun,
		evidence: RunEvidence,
		chunk: Buffer,
		phase: number,
	): void {
		// A18: a framed Rust run takes stage 1 from the markers before this PCM (the parser's
		// state), never from stdout timing; views are cut at every marker.
		const stage1 =
			run.rust?.framing === "active"
				? run.rust.audioStage1Open
				: runGateOpen(run)
		processEvidenceChunk(
			evidence,
			chunk,
			phase,
			stage1 && !run.gateHeld,
			run.stream.format,
			run.stream.rate,
		)
	}

	/**
	 * The run's wiring tap (auto-listen-route 3.6, 3.7): every pre-roll call of
	 * `processEvidenceChunk` (tags, latch, abandon, the A17 retroactive `muteTail`) is mirrored
	 * on the shadow, tracked with or without `/auto` clients. Built once per evidence path.
	 */
	private autoTap(run: PipelineRun, evidence: RunEvidence): EvidencePreRollTap {
		return {
			processed: (chunk, start, end, tag) =>
				this.mirrorPreRoll(evidence, chunk, start, end, tag, run.stream),
			latched: () => evidence.shadow?.latch(),
			abandoned: () => evidence.shadow?.abandon(),
			mutedTail: samples => evidence.shadow?.muteTail(samples),
			skipped: (chunk, start, end) => {
				if (this.autoRoute.wanted)
					this.pushAuto(chunk, start, end, false, run.stream)
			},
		}
	}

	/**
	 * After one real pre-roll call (`chunk[start, end)` holds its output, fades included): the
	 * same call on the shadow, then the shadow's output runs as `/auto` spans: a byte qualifies
	 * only when the pre-roll plays it (3.1 a). Out of sync (a defect): silent until it resyncs.
	 */
	private mirrorPreRoll(
		evidence: RunEvidence,
		chunk: Buffer,
		start: number,
		end: number,
		tag: PreRollTag,
		stream: StreamFormat,
	): void {
		const shadow = evidence.shadow
		let inSync = false
		if (shadow !== null) {
			const failedBefore = shadow.failed
			shadow.process(end - start, tag)
			inSync = shadow.sync(evidence.preRoll.delaySamples)
			// A new mismatch drops queued /auto analog (it may be wrongly qualified) and a resync
			// starts clean, so no audio decided while out of sync ever plays (fail closed).
			if ((!failedBefore && !inSync) || (failedBefore && !shadow.failed))
				this.resetAutoAnalog()
			if (!inSync && !this.autoShadowMismatchLogged && shadow.mismatches > 0) {
				this.autoShadowMismatchLogged = true
				this.log.warn(
					"Auto listen pre-roll shadow out of sync; analog on /auto muted until it resyncs",
				)
			}
		}
		if (!this.autoRoute.wanted) return
		if (shadow === null || !inSync) {
			this.pushAuto(chunk, start, end, false, stream)
			return
		}
		let at = start
		const runs = shadow.runCountOut
		for (let i = 0; i < runs && at < end; i++) {
			const next = Math.min(end, at + shadow.runBytes(i))
			this.pushAuto(chunk, at, next, shadow.runPlays(i), stream)
			at = next
		}
		this.pushAuto(chunk, at, end, false, stream)
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

/** The production evidence squelch ports (A5, plan W.3). */
const DEFAULT_EVIDENCE_SQUELCH: EvidenceSquelchFactory = {
	createGate: options => new EvidenceGate(options),
	createPreRoll: options => new PreRoll(options),
}

/**
 * Evidence squelch A19: modulations whose csdr back chain starts with `csdr amdemod`. A closed
 * gate feeds them exact zeros and their closed PCM is zeroed (no AGC limit-cycle hum).
 */
const ENVELOPE_MUTE_MODULATIONS: ReadonlySet<LiveDemodConfig["modulation"]> =
	new Set(["am", "dsb", "cw"])

/** Tone gate decisions apply to PCM slices of at most this length (WG7 req 3.2). */
const TONE_SLICE_MS = 10
const DCS_STANDARD: ReadonlySet<string> = new Set(DCS_STANDARD_CODES)

function copyChannelTone(tone: {
	ctcssHz: number | null
	dcs: AnalogTransmissionDcs | null
	at: string
}): {
	ctcssHz: number | null
	dcs: AnalogTransmissionDcs | null
	at: string
} {
	return {
		ctcssHz: tone.ctcssHz,
		dcs:
			tone.dcs === null
				? null
				: { code: tone.dcs.code, polarity: tone.dcs.polarity },
		at: tone.at,
	}
}

/** A canonical `toISOString()` time: rejects non-ISO input and impossible calendar dates. */
function isCanonicalIsoTime(at: string): boolean {
	const ms = Date.parse(at)
	return Number.isFinite(ms) && new Date(ms).toISOString() === at
}

/** An off-table or malformed DCS code is no tone (WG12 req 6.4). */
function standardDcs(
	dcs: AnalogTransmissionDcs | null,
): AnalogTransmissionDcs | null {
	if (dcs === null || typeof dcs !== "object") return null
	if (dcs.polarity !== "normal" && dcs.polarity !== "inverted") return null
	if (typeof dcs.code !== "string" || !DCS_STANDARD.has(dcs.code)) return null
	return { code: dcs.code, polarity: dcs.polarity }
}

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

/** The rollback candidate, with the squelch mode and tone from `acked` when it is invalid. */
function repairedRollback(
	candidate: LiveDemodConfig,
	acked: LiveDemodConfig,
): LiveDemodConfig {
	if (LiveDemodRuntimeConfigSchema.safeParse(candidate).success)
		return candidate
	const repaired: LiveDemodConfig = { ...candidate }
	for (const key of ["squelchMode", "toneSquelch"] as const) {
		if (acked[key] === undefined) delete repaired[key]
		else Object.assign(repaired, { [key]: acked[key] })
	}
	return LiveDemodRuntimeConfigSchema.safeParse(repaired).success
		? repaired
		: acked
}

function toneSquelchState(run: PipelineRun): "off" | "waiting" | "open" {
	if (run.tone === null) return "off"
	if (!runGateOpen(run) || run.tone.gate === null) return "waiting"
	return run.tone.gate.state
}
