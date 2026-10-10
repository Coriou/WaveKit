/**
 * Shared scanner types (plan contracts C1b and C2). Every scanner module imports
 * its cross-file types from here, and the spectrum-layer types (epochs, tracks,
 * pipeline I/O) from src/core/spectrum/types.ts, never through this file.
 * Nothing in this file has runtime behaviour except CONFIDENCE_RANK.
 *
 * Conventions: frequencies in Hz, powers in dBFS (10·log10 of mean |z|² with
 * full scale |z| = 1), sample indices are absolute per source stream (§ 4.1),
 * stored records (Discovery, Observation) carry ISO-8601 timestamps.
 */
import type {
	DetectionSettings,
	FreqRange,
	ObservationEndReason,
	Raster,
	TrackSnapshot,
	TuningTrust,
} from "../spectrum/types.js"

// ---------------------------------------------------------------- vocabulary (§ 6.1)

export type ScannerProtocol =
	| "analog-fm"
	| "analog-am"
	| "dmr"
	| "p25p1"
	| "p25p2"
	| "nxdn48"
	| "nxdn96"
	| "ysf"
	| "dstar"
	| "dpmr"
	| "pocsag"
	| "flex"
	| "aprs"
	| "ism"
	| "digital-unknown"
	| "carrier"
	| "unknown"

export type ScannerClass =
	| "fsk4-12k5"
	| "fsk4-6k25"
	| "tdma-ms"
	| "fsk2-wide"
	| "gmsk-narrow"
	| "afsk-fm"
	| "analog-fm"
	| "ook-burst"
	| "carrier"
	| "wideband"
	| "unknown"

export type ProtocolFamily =
	| "analog"
	| "digital-voice"
	| "pager"
	| "packet"
	| "ism"
	| "carrier"
	| "unknown"

export type ScannerConfidence =
	| "activity"
	| "candidate"
	| "classified"
	| "decoded"

/** Ladder order of § 7.3; compare ranks, never strings. */
export const CONFIDENCE_RANK: Readonly<Record<ScannerConfidence, number>> =
	Object.freeze({
		activity: 0,
		candidate: 1,
		classified: 2,
		decoded: 3,
	})

export type IdentityKind =
	| "dmr-cc"
	| "p25-nac"
	| "nxdn-ran"
	| "ysf-dgid"
	| "dstar-call"
	| "dpmr-cc"
	| "pocsag-capcode"
	| "aprs-call"
	| "ism-model"

export interface Identity {
	kind: IdentityKind
	value: string
}

// ---------------------------------------------------------------- ranges (§ 5.1)

export interface ScanRange extends FreqRange {
	/** Empty or undefined = free range. */
	rasters?: Raster[]
	/** Expected OBW classes; the first is the planning default. */
	obwHz?: number[]
	protocols?: ScannerProtocol[]
	bandplanId?: string
}

export interface ScanExclusion extends FreqRange {
	reason?: string
}

// ---------------------------------------------------------------- classification and evidence (§ 6)

export interface Hypothesis {
	protocol: ScannerProtocol
	score: number
}

/** Leak/intermod cap (spec § 6.2): the discovery stays at most `candidate`. */
export type ConfidenceCap = "adjacent-leak" | "suspected-intermod"

export interface Classification {
	class: ScannerClass
	/** Sorted desc, scores in [0, 1]. */
	hypotheses: Hypothesis[]
	cap?: ConfidenceCap
	tier: "spectral" | "channel"
}

export interface DiscoveryMetadataInput {
	talkgroups: string[]
	sources: string[]
	slots: number[]
	callsigns: string[]
	capcodes: string[]
	ctcssHz: number
	ismModels: string[]
}

export interface DecodeEvidence {
	protocol: ScannerProtocol
	identity?: Identity
	metadata: Partial<DiscoveryMetadataInput>
	crcClean: boolean
	encrypted?: boolean
	callId?: string
	/** Epoch ms. */
	at: number
	epoch: number
	origin: "probe" | "ambient"
	probeId?: string
	decoderId?: string
}

export interface ObservationInput {
	id: string
	sourceId: string
	jobIds: string[]
	track: TrackSnapshot
	classification: Classification
	startedAt: number
	endedAt?: number
	endReason?: ObservationEndReason
	hopIndex?: number
	/** Sweep mode (§ 7.2 (b)). */
	singleBlockSurfacingAllowed: boolean
}

// ---------------------------------------------------------------- stored records (§ 7.1)

export interface SignalStats {
	peakDbfs: number
	meanDbfs: number
	snrDb: number
	floorDbfs: number
}

/** Each list ≤ 64 entries, least recently seen evicted first. */
export interface DiscoveryMetadata {
	talkgroups: string[]
	sources: string[]
	slots: number[]
	callsigns: string[]
	capcodes: string[]
	ismModels: string[]
	ctcssHz?: number
}

export type UndecodedReason =
	| "no-sync"
	| "crc-errors"
	| "timeout"
	| "no-probe-transport"
	| "budget"
	| "unsupported-format"

export interface Discovery {
	/** "d_" + ULID */
	id: string
	/** Raster channel, or the median measured centre. */
	frequencyHz: number
	/** § 5.2 */
	frequencyKey: string
	/** median(measured − frequencyHz) over observations */
	measuredOffsetHz: number
	/** Median OBW. */
	bandwidthHz: number
	protocol: ScannerProtocol
	family: ProtocolFamily
	class: ScannerClass
	confidence: ScannerConfidence
	confidenceCap?: ConfidenceCap
	identity?: Identity
	/** Sticky once accepted (H2). */
	encrypted: boolean
	undecodedReason?: UndecodedReason
	/** Other discoveries on the same frequency key. */
	coChannel: string[]
	firstSeenAt: string
	lastSeenAt: string
	observationCount: number
	airtimeMs: number
	signal: { best: SignalStats; last: SignalStats }
	metadata: DiscoveryMetadata
	sourceIds: string[]
	jobIds: string[]
	tuningTrust: TuningTrust
	operator?: {
		label?: string
		notes?: string
		lockout?: boolean
		keep?: boolean
	}
	evidence: { recordings: number; psd: boolean; iq: boolean }
}

export interface Observation {
	id: string
	discoveryId: string
	startedAt: string
	endedAt?: string
	endReason?: ObservationEndReason
	sampleRange: { stream: number; epoch: number; start: number; end?: number }
	centerHz: number
	obwHz: number
	obwMethod: "-20dB" | "on-bins"
	peakDbfs: number
	meanDbfs: number
	snrDb: number
	floorDbfs: number
	thresholdDb: number
	dutyCycle: number
	acf30?: number
	acf60?: number
	hypotheses: Hypothesis[]
	/** Accepted values only. */
	decode?: DecodeEvidence[]
	recordingIds: string[]
	recording?: "linked" | "cut" | "encrypted-dropped" | "none"
	flags: {
		overload: boolean
		gap: boolean
		offRaster: boolean
		obwBiased: boolean
		adjacentLeak: boolean
		suspectedIntermod: boolean
		edge: boolean
	}
	sourceId: string
	/** Every active job whose scope covers it. */
	jobIds: string[]
	hopIndex?: number
	tuningTrust: TuningTrust
}

// ---------------------------------------------------------------- jobs and plans (§ 10, § 5)

export type ScanMode = "in-window" | "sweep"
export type JobState =
	| "pending"
	| "starting"
	| "running"
	| "holding"
	| "paused"
	| "completed"
	| "cancelled"
	| "failed"
export type PauseReason =
	| "operator"
	| "preempted-operator"
	| "preempted-relay"
	| "preempted-job"
	| "source-down"
	| "core-restart"
	| "resume-blocked"
export type FailReason = "source-removed" | "tuner-unavailable" | "invalid"

/** § 10.6; exactly one of `channels` / `fromDiscoveries` (enforced by the REST schema). */
export interface MonitorChannelSpec {
	/** Exactly one of frequencyHz / discoveryId. */
	frequencyHz?: number
	discoveryId?: string
	priority?: number
	mode?: "auto" | "analog" | "digital"
	squelchDb?: number
}

export interface MonitorSpec {
	channels?: MonitorChannelSpec[]
	fromDiscoveries?: {
		jobId?: string
		minConfidence: ScannerConfidence
		protocols?: ScannerProtocol[]
	}
	priorityChannels?: string[]
	/** Default 2000. */
	hangMs?: number
	lockouts?: string[]
}

/** Operator-facing job spec, exactly § 10.1. */
export interface ScanJobSpec {
	name?: string
	/** Default source when unset. */
	sourceId?: string
	/** Default auto (§ 5.4). */
	mode?: "in-window" | "sweep" | "auto"
	/** monitor = listen-scan (§ 10.6), post-channelizer; identify = § 10.8 (created only by POST /api/scanner/identify, Task 35a). */
	kind?: "discover" | "monitor" | "identify"
	ranges?: ScanRange[]
	bandplans?: string[]
	exclusions?: ScanExclusion[]
	/** Empty = all; sets priors (§ 6.2). */
	protocols?: ScannerProtocol[]
	sensitivity?: "low" | "normal" | "high"
	thresholdDb?: number
	fftSize?: number
	integrationMs?: number
	dwellMs?: number
	settleMs?: number
	hold?: {
		policy: "hold" | "confirm" | "never"
		confirmHoldMs?: number
		maxHoldMs?: number
		hangMs?: number
	}
	revisit?: { share?: number; maxIntervalMs?: number }
	/** Default true / true / true. */
	record?: { voice?: boolean; analog?: boolean; data?: boolean }
	/** Default true / false. */
	evidence?: { psd?: boolean; iq?: boolean }
	tuner?: {
		sampleRateHz?: number
		gainTenthsDb?: number
		agc?: boolean
		overload?: "flag" | "reduce-gain"
	}
	stop?: { afterSweeps?: number; afterMs?: number; onFirstDecoded?: boolean }
	/** 0–100, default 50; among scanner jobs only. */
	priority?: number
	/** Consent to disturb other consumers (§ 10.4). */
	takeover?: boolean
	/** Default 60000 / false (passive: true). */
	resume?: { autoAfterIdleMs?: number | null; onBoot?: boolean }
	/** For POI warnings; default 5000. */
	txDurationHintMs?: number
	monitor?: MonitorSpec
}

export interface NormalisedJobSpec extends Required<
	Pick<ScanJobSpec, "sourceId" | "sensitivity" | "priority">
> {
	mode: ScanMode
	kind: "discover" | "monitor" | "identify"
	ranges: ScanRange[]
	exclusions: ScanExclusion[]
	/** [] = all */
	protocols: ScannerProtocol[]
	fftSize: number
	integrationMs: number
	thresholdDb: number | null
	dwellMs: number
	settleMs: number
	hold: {
		policy: "hold" | "confirm" | "never"
		confirmHoldMs: Partial<Record<ScannerClass, number>>
		maxHoldMs: number
		hangMs: number
	}
	revisit: { share: number; maxIntervalMs: number | null }
	record: { voice: boolean; analog: boolean; data: boolean }
	evidence: { psd: boolean; iq: boolean }
	tuner: {
		sampleRateHz: number | null
		gainTenthsDb: number | null
		agc: boolean | null
		overload: "flag" | "reduce-gain"
	}
	stop: {
		afterSweeps: number | null
		afterMs: number | null
		onFirstDecoded: boolean
	}
	takeover: boolean
	resume: { autoAfterIdleMs: number | null; onBoot: boolean }
	txDurationHintMs: number
	provenance: Record<
		string,
		"operator" | "bandplan" | "measured" | "config" | "default"
	>
}

export interface Hop {
	index: number
	centreHz: number
	covered: FreqRange
	channelCount: number
	dcAdjacentChannelsHz: number[]
	excluded: FreqRange[]
	dcMinEdgeHz: number
}

export interface HopPlan {
	hops: Hop[]
	usableHalfSpanHz: number
	dcGuardHz: number
	ppmMarginHz: number
}

export type IssueSeverity = "error" | "warning"

export type PlanIssueCode =
	| "range-empty"
	| "range-outside-tuner"
	| "all-excluded"
	| "plan-empty"
	| "not-in-window"
	| "no-tuner-control"
	| "source-busy"
	| "dwell-too-short"
	| "hold-inconsistent"
	| "channel-too-wide"
	| "source-not-iq"
	| "no-probe-transport"
	| "poi-low"
	| "rbw-coarse"
	| "rbw-fine"
	| "settle-timer"
	| "settle-unmeasured"
	| "budget-cpu"
	| "budget-disk"
	| "dc-adjacent-channels"
	| "dedicated-available"
	| "unrestorable"
	| "probe-unavailable"

export interface PlanIssue {
	code: PlanIssueCode
	severity: IssueSeverity
	message: string
	details?: Record<string, unknown>
}

export interface Impact {
	liveAudioClients: number
	digitalVoiceListeners: number
	runningDecoders: string[]
	pinnedDecoders: string[]
	scannerJobs: string[]
	unrestorable: string[]
}

export interface PlanPreview {
	spec: NormalisedJobSpec
	plan: HopPlan
	sweepPeriodMs: number | null
	poi: { hopIndex: number; detection: number; decode: number }[]
	estimates: { cpuCores: number; diskMbPerHour: number; probes: number }
	impact: Impact
	issues: PlanIssue[]
}

// ---------------------------------------------------------------- settings (§ 12.3, decision D4)

/**
 * Fully resolved scanner settings (config merged with runtime overrides). The
 * Zod schema in src/config.ts (Task 24) produces exactly this shape; every
 * component receives it instead of reading config. `storage.dir: null` means
 * `<stateDir>/scanner`, resolved by ScannerService.
 */
export interface ScannerSettings {
	enabled: boolean
	passive: { enabled: boolean; offsetProbes: boolean }
	cpuBudgetCores: number
	cpuGuardPercent: number
	maxProbes: { offset: number; channel: number }
	ringSeconds: number
	/** Includes shortIntegrationMs (default 5) and overlap (default 0), § 12.3. */
	detection: DetectionSettings
	sweep: {
		markers: boolean
		markerTimeoutMs: number
		pllSettleMs: number
		settleMs: { local: number; network: number }
		revisitShare: number
	}
	hold: { maxHoldMs: number; hangMs: number; preRollMs: number }
	storage: {
		dir: string | null
		maxRecordingsMb: number
		maxEvidenceMb: number
		maxJournalMb: number
		maxAgeDays: number
		discoveryMaxAgeDays: number
		minFreeDiskMb: number
		maxDiscoveries: number
		/** Burst IQ captures cap (Task 34a), default 256. */
		maxCapturesMb: number
	}
	/**
	 * spectrumHz default 10 (0.5–25), spectrumBins default 512 (128–2048).
	 * spectrumSummaryBins 2048 (512–2048, provisional) and spectrumMaxProfiles 4 (1–16) are config-only.
	 */
	ws: {
		maxMessagesPerSecond: number
		spectrumHz: number
		spectrumBins: number
		spectrumSummaryBins: number
		spectrumMaxProfiles: number
	}
}
