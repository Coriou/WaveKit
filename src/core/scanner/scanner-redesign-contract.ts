/**
 * WG12 frozen contract (docs/specs/scanner-redesign, task 0.1): channel gate,
 * analog replay trial, job phase, and the in-memory evidence sink. Lanes import
 * these names. Constants and types only; no runtime behaviour.
 */
import type {
	AnalogTransmissionDcs,
	ScannerProbeDecoderType,
	ScannerProofTransport,
	ScannerTrialOutcome,
} from "@wavekit/api-types"
import type { TuningTrust } from "../spectrum/types.js"
import type { Discovery, Identity, ScannerProtocol } from "./types.js"

/** Channel width used when a range names neither an OBW nor a raster. */
export const CHANNEL_GATE_DEFAULT_WIDTH_HZ = 12_500
export const CHANNEL_GATE_MIN_WIDTH_HZ = 6_250
export const CHANNEL_GATE_MAX_WIDTH_HZ = 200_000
/** Per-channel CFAR threshold above the noise floor (kCh). */
export const CHANNEL_GATE_K_DB = 3.0
export const CHANNEL_GATE_HYSTERESIS_DB = 1.5
/** Added to kCh before a slot may pass. kCh + margin = 6 dB. */
export const CHANNEL_GATE_MARGIN_DB = 3.0
/** A passing run must last this long (6 blocks of 50 ms). */
export const CHANNEL_GATE_MIN_DURATION_MS = 300
/** Burst ranges pass after 2 blocks of 50 ms. */
export const CHANNEL_GATE_BURST_MIN_DURATION_MS = 100
/** Added to kCh for a burst range. kCh + burst margin = 9 dB. */
export const CHANNEL_GATE_BURST_MARGIN_DB = 6.0
/** A slot whose masked-bin fraction is above this is skipped. */
export const CHANNEL_GATE_MAX_MASKED_FRACTION = 0.5
/** Past this many slots the grid coarsens. */
export const CHANNEL_GATE_MAX_SLOTS = 4_096

export type ChannelGateState = "pending" | "passed" | "below"

export interface ChannelPlanEntry {
	startHz: number
	endHz: number
	widthHz: number
	rasterHz: number | null
	firstChannelHz: number | null
	burst: boolean
	rangeKey: string
}

export interface ChannelPlan {
	sourceId: string
	entries: ChannelPlanEntry[]
	defaultWidthHz: number
}

/** CPU budget of one analog replay trial (cores). */
export const ANALOG_TRIAL_CORES = 0.05
/** One statistics frame. ANALOG_TRIAL_MAX_FRAMES of these equal IQ_CAPTURE_MAX_MS. */
export const ANALOG_TRIAL_FRAME_MS = 50
export const ANALOG_TRIAL_MAX_FRAMES = 80
export const ANALOG_TRIAL_QUIETING_DB = 8
export const ANALOG_TRIAL_MIN_QUIET_FRACTION = 0.5
export const ANALOG_TRIAL_VOICE_INDEX = 0.3
export const ANALOG_TRIAL_AUDIO_MIN_DB = -30
export const ANALOG_TRIAL_DATA_SCORE = 0.6
/** AM carrier steadiness above the capture floor, used in place of quieting. */
export const ANALOG_TRIAL_AM_CARRIER_DB = 6

export type AnalogTrialMode = "nfm" | "am"

export interface AnalogTrialFrame {
	carrierDb: number
	hfNoiseDb: number
	audioDb: number
	syllabic: number
	cluster: number
}

export interface AnalogTrialStats {
	mode: AnalogTrialMode
	frames: readonly AnalogTrialFrame[]
	gapSamples: number
	floorDb: number
}

export interface AnalogTrialTones {
	ctcssHz: number | null
	dcs: AnalogTransmissionDcs | null
	audioSeconds: number
}

export type AnalogTrialOutcome =
	| "decoded"
	| "heard"
	| "data-like"
	| "carrier-only"
	| "no-sync"

export interface AnalogTrialResult {
	outcome: AnalogTrialOutcome
	mode: AnalogTrialMode
	voice: boolean
	tones: AnalogTrialTones
	stats: AnalogTrialStats | null
	error?: "capture-gone" | "analyze-failed" | "cancelled" | "unavailable"
}

export interface AnalogTrialRunner {
	run(
		captureId: string,
		mode: AnalogTrialMode,
		signal: AbortSignal,
	): Promise<AnalogTrialResult>
}

export interface JobActivityView {
	capturing: number
	replaying: {
		protocol: ScannerProtocol
		decoder: string
		discoveryId: string | null
	} | null
	replayQueueDepth: number
}

export interface JobPhaseInput {
	schedulerPhase: "tuning" | "settling" | "hold" | "dwell" | null
	parked: boolean
	liveProbe: {
		protocol: ScannerProtocol
		decoder: string
		transport: "offset" | "channel"
		discoveryId: string | null
		frequencyHz: number
		trackId: string
	} | null
	hold: {
		discoveryId: string | null
		frequencyHz: number
		trackId: string
	} | null
	activity: JobActivityView
}

export interface ProofDecodeInput {
	protocol: ScannerProtocol
	transport: ScannerProofTransport
	at: number
	identity?: Identity
	talkgroup?: string
	encrypted: boolean
}

export interface ProofTrialInput {
	protocol: ScannerProtocol
	decoder: string
	outcome: ScannerTrialOutcome
	order: number
	at: number
}

export interface ProofAnalogInput {
	outcome: AnalogTrialOutcome
	mode: AnalogTrialMode
	voice: boolean
	tone: { ctcssHz: number | null; dcs: AnalogTransmissionDcs | null }
	transport: ScannerProofTransport
	at: number
}

export interface ProofInput {
	observationId: string
	decodes: readonly ProofDecodeInput[]
	trials: readonly ProofTrialInput[]
	analog: readonly ProofAnalogInput[]
	unavailable: readonly ScannerProbeDecoderType[]
	trust: TuningTrust
	digitalPlanComplete: boolean
}

/**
 * The only way trial, analog and unavailable evidence reaches an observation's
 * ProofInput. DiscoveryStore implements it. The evidence lives only in
 * memory: not on the Observation record, not in the snapshot, the journal or
 * any persistence payload.
 */
export const PROOF_TRIALS_MAX_PER_OBSERVATION = 32
export const PROOF_ANALOG_MAX_PER_OBSERVATION = 8

export interface ObservationEvidenceSink {
	/** Monotonic per store instance, starting at 1; callers take one value when a trial starts. */
	nextTrialOrder(): number
	/** Upsert keyed by (protocol, decoder, order): a later outcome for the same key replaces the earlier one. */
	recordTrial(observationId: string, trial: ProofTrialInput): boolean
	/** Appends; exact duplicates (same outcome, mode, transport, at) are ignored. */
	recordAnalog(observationId: string, analog: ProofAnalogInput): boolean
	/** Set semantics; kept sorted. */
	recordUnavailable(
		observationId: string,
		type: ScannerProbeDecoderType,
	): boolean
}

/** Discoveries within toleranceHz of hz (inclusive), sorted by |Δf| then id. Implemented by DiscoveryStore. */
export interface DiscoveryNearQuery {
	near(hz: number, toleranceHz: number, sourceId?: string): Discovery[]
}

/** Error `code` values on one `wavekit-iqcap analyze` event (fd 4). */
type AnalyzeErrorCode =
	| "bad-args"
	| "open-failed"
	| "bad-file"
	| "kernel-config"
	| "io"

export type AnalyzeEvent =
	| { event: "analysis"; frames: AnalogTrialFrame[]; gapSamples: number }
	| { event: "error"; code: AnalyzeErrorCode }

/**
 * One JSON event line on fd 4 of `wavekit-iqcap analyze`, validated both sides. Worst case:
 * 80 frames x 107 B (five quoted keys 50 B, five numbers of at most 9 characters at 0.1
 * rounding 45 B, colons, commas and braces 12 B) = 8 560 B plus about 60 B of envelope;
 * 16 KiB leaves headroom.
 */
export const ANALYZE_EVENT_MAX_BYTES = 16_384

/**
 * Live job slot fairness from a ready holder: one slot, eight candidates,
 * 500 ms handoff/launch allowance. Both holds below count from decoder readiness.
 * An already-starting holder adds its remaining startup latency to these bounds.
 */
export const JOB_PROBE_TURN_CAP_MS = 6_000
export const JOB_PROBE_MIN_RUN_MS = 1_800
export const JOB_PROBE_FRESH_MS = 2_000
export const JOB_PROBE_STRONG_SNR_DB = 20
export const JOB_PROBE_STRONG_DELTA_DB = 10
export const JOB_PROBE_START_ALLOWANCE_MS = 500
export const JOB_PROBE_MAX_WAIT_MS =
	7 * (JOB_PROBE_TURN_CAP_MS + JOB_PROBE_START_ALLOWANCE_MS)
export const JOB_PROBE_STRONG_WAIT_MS =
	JOB_PROBE_MIN_RUN_MS + JOB_PROBE_START_ALLOWANCE_MS
