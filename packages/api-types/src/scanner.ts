/**
 * Signal discovery scanner DTOs (docs/superpowers/specs/2026-10-09-signal-discovery-scanner-design.md
 * § 7.1, § 10, § 12). Copies of src/core/scanner/types.ts; the contract test
 * tests/unit/api/scanner-dto-contract.test.ts keeps them identical.
 */
import type { BandRegion } from "./decoders.js"

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
	/** WG7 (web-gaps-7 req 1): named only from evidence of decoders already running (no probe). */
	| "ais"
	| "acars"
	| "vdl2"
	| "lora"
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
export type TuningTrust = "commanded" | "relay" | "unverified"
export type SettleMode = "marker" | "timer" | "none"
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
	/** WG7 req 1.1: AIS MMSI, ACARS registration, VDL2 source address, Meshtastic node id. */
	| "ais-mmsi"
	| "acars-reg"
	| "vdl2-addr"
	| "lora-node"
export interface Identity {
	kind: IdentityKind
	value: string
}
export interface FreqRange {
	startHz: number
	endHz: number
}
export interface Raster {
	spacingHz: number
	firstChannelHz: number
}
export interface ScanRange extends FreqRange {
	rasters?: Raster[]
	obwHz?: number[]
	protocols?: ScannerProtocol[]
	bandplanId?: string
	/**
	 * Scanner follow-ups (SF1, docs/specs/scanner-followups): `false` keeps the range in the
	 * job (index and fields stay) but it is not planned, swept, masked or matched for
	 * protocols. Absent = enabled. Live-editable.
	 */
	enabled?: boolean
	/** SF1: operator label, 1 to 100 characters. Live-editable. */
	name?: string
	/**
	 * SF1: dwell (ms) of every hop overlapping this range; same bounds as the job's
	 * `dwellMs`; the job's value applies when absent. Live-editable.
	 */
	dwellMs?: number
	/**
	 * SF1: CFAR false-alarm target of this range (low, normal, high as the job-level
	 * mapping); integration stays job-level. The job's sensitivity applies when absent.
	 * Live-editable.
	 */
	sensitivity?: "low" | "normal" | "high"
}
export interface ScanExclusion extends FreqRange {
	reason?: string
}
/**
 * WG2 (requirement 12): a runtime exclusion derived from a locked-out discovery. Never part of
 * the stored job spec. `applied` is false past the 256 cap or when applying would empty the plan.
 */
export interface LockoutExclusion extends FreqRange {
	discoveryId: string
	applied: boolean
}
/**
 * WG6 (web-gaps-6 requirement 1): a frequency range a running decoder on another source (or an
 * external-input decoder on its own device) is proven to cover. Reported on plan previews and
 * jobs; it becomes an exclusion only when the job sets `skipDecodedElsewhere: true` (`applied`).
 * Ranges are merged per `sourceId` and clipped to the job's enabled ranges.
 */
export interface DecodedElsewhereRange extends FreqRange {
	/** The WaveKit source of the covering decoders; null = external-input decoders (own device). */
	sourceId: string | null
	/** Covering decoder ids, sorted, deduplicated. */
	decoderIds: string[]
	/** True when the range is an exclusion of this plan (flag set, within the cap, plan not emptied). */
	applied: boolean
}
/** WG6 req 1.3: half-width around a decoder target frequency when it declares no band range. */
export const DECODED_ELSEWHERE_TARGET_HALF_WIDTH_HZ = 6_250
/** WG6 req 1.5: decoders examined per plan; more are ignored (counted in the issue). */
export const DECODED_ELSEWHERE_MAX_DECODERS = 64
/** WG6 req 1.5: targets plus ranges examined per decoder; more are ignored. */
export const DECODED_ELSEWHERE_MAX_TARGETS = 32
/** WG6 req 1.5: merged ranges reported per plan; past it the rest are dropped (sorted by start). */
export const DECODED_ELSEWHERE_MAX_RANGES = 256
/** WG7 req 7.1: trailing debounce after the last decoder change before decoded-elsewhere is recomputed. */
export const DECODED_ELSEWHERE_REFRESH_DEBOUNCE_MS = 2_000
/** WG7 req 7.1: at most one decoder-change refresh per interval (a later change refreshes at its end). */
export const DECODED_ELSEWHERE_REFRESH_MIN_INTERVAL_MS = 30_000
/**
 * WG7 (web-gaps-7 requirement 6): a frequency range the resolved band plans mark `skip`. Reported
 * on plan previews and jobs; it becomes an exclusion only when the job sets
 * `skipBandPlanSkips: true` (`applied`). Merged and clipped to the job's enabled ranges.
 */
export interface BandPlanSkipRange extends FreqRange {
	/** Resolved band keys (`<packId>/<bandId>`) of the skip-marked bands, sorted, deduplicated. */
	bandKeys: string[]
	/** True when the range is an exclusion of this plan (flag set, sweep, plan not emptied). */
	applied: boolean
}
/** WG7 req 6.2: resolved skip segments examined per plan (view order); more are ignored. */
export const BANDPLAN_SKIP_MAX_SOURCES = 1_024
/** WG7 req 6.3: merged skip ranges reported per plan (lowest start first). */
export const BANDPLAN_SKIP_MAX_RANGES = 256
export type ObservationEndReason =
	| "quiet"
	| "retune"
	| "hop"
	| "job-end"
	| "max-duration"
	| "gap"

export interface SignalStats {
	peakDbfs: number
	meanDbfs: number
	snrDb: number
	floorDbfs: number
}
export interface DiscoveryMetadata {
	talkgroups: string[]
	sources: string[]
	slots: number[]
	callsigns: string[]
	capcodes: string[]
	ismModels: string[]
	ctcssHz?: number
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
	at: number
	epoch: number
	origin: "probe" | "ambient"
	probeId?: string
	decoderId?: string
}

/** Spec § 7.1; timestamps ISO 8601. */
export interface Discovery {
	id: string
	frequencyHz: number
	frequencyKey: string
	measuredOffsetHz: number
	bandwidthHz: number
	protocol: ScannerProtocol
	family: ProtocolFamily
	class: ScannerClass
	confidence: ScannerConfidence
	confidenceCap?: "adjacent-leak" | "suspected-intermod"
	identity?: Identity
	encrypted: boolean
	undecodedReason?:
		| "no-sync"
		| "crc-errors"
		| "timeout"
		| "no-probe-transport"
		| "budget"
		| "unsupported-format"
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
	hypotheses: { protocol: ScannerProtocol; score: number }[]
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
	jobIds: string[]
	hopIndex?: number
	tuningTrust: TuningTrust
}

// --- Jobs and plans (spec § 10.1, § 5.4) ---

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

export interface MonitorChannelSpec {
	frequencyHz?: number
	discoveryId?: string
	priority?: number
	mode?: "auto" | "analog" | "digital"
	squelchDb?: number
}
export interface MonitorSpec {
	channels?: MonitorChannelSpec[]
	priorityChannels?: string[]
	hangMs?: number
	lockouts?: string[]
	fromDiscoveries?: {
		jobId?: string
		minConfidence: ScannerConfidence
		protocols?: ScannerProtocol[]
	}
}

export interface ScanJobSpec {
	name?: string
	sourceId?: string
	mode?: "in-window" | "sweep" | "auto"
	kind?: "discover" | "monitor" | "identify"
	ranges?: ScanRange[]
	bandplans?: string[]
	exclusions?: ScanExclusion[]
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
	record?: { voice?: boolean; analog?: boolean; data?: boolean }
	evidence?: { psd?: boolean; iq?: boolean }
	tuner?: {
		sampleRateHz?: number
		gainTenthsDb?: number
		agc?: boolean
		overload?: "flag" | "reduce-gain"
	}
	stop?: { afterSweeps?: number; afterMs?: number; onFirstDecoded?: boolean }
	priority?: number
	takeover?: boolean
	resume?: { autoAfterIdleMs?: number | null; onBoot?: boolean }
	txDurationHintMs?: number
	monitor?: MonitorSpec
	capture?: Partial<CaptureSpec> & { enabled: boolean }
	/**
	 * SF1: find signals, never decode them. The job requests no decoder trials (confirm or
	 * follow probes) of its own; detection, classification, discoveries, captures and
	 * ambient or other jobs' evidence are unchanged. Discover jobs only. Live-editable.
	 */
	signalsOnly?: boolean
	/**
	 * WG6 (web-gaps-6 req 1.6): exclude the frequency ranges decoders elsewhere are proven to
	 * cover (`decodedElsewhere`). Sweep jobs only. Absent = false (today's plans). Live-editable.
	 */
	skipDecodedElsewhere?: boolean
	/**
	 * WG7 (web-gaps-7 req 6.1): exclude the band-plan ranges marked `skip` (`bandPlanSkips`).
	 * Sweep jobs only. Absent = false (today's plans). Live-editable.
	 */
	skipBandPlanSkips?: boolean
}

export interface CaptureSpec {
	enabled: boolean
	mode: "wideband" | "channel"
	preMs: number
	postMs: number
	onlyDecoded: boolean
	maxPerHour: number
}

export interface NormalisedJobSpec {
	sourceId: string
	sensitivity: "low" | "normal" | "high"
	priority: number
	mode: ScanMode
	kind: "discover" | "monitor" | "identify"
	ranges: ScanRange[]
	exclusions: ScanExclusion[]
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
	capture: CaptureSpec
	/** SF1: present only when the operator set it (absent = false, today's behaviour). */
	signalsOnly?: boolean
	/** WG6: present only when the operator set it (absent = false, today's behaviour). */
	skipDecodedElsewhere?: boolean
	/** WG7: present only when the operator set it (absent = false, today's behaviour). */
	skipBandPlanSkips?: boolean
	/**
	 * Field key → where its value came from:
	 * - `operator`: set in the job spec.
	 * - `bandplan`: from the bandplan.
	 * - `measured`: measured by the engine.
	 * - `config`: an explicit value from the effective scanner settings (config file or
	 *   runtime PATCH); today only `fftSize`.
	 * - `default`: a built-in default, or a value derived from the effective settings.
	 */
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
	/** SF1: present only when an enabled range overlapping the hop sets `dwellMs` (max of the overlapping ranges' dwell, the job's for ranges without one). */
	dwellMs?: number
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
	| "range-locked"
	| "signals-only-unsupported"
	| "decoded-elsewhere-truncated"
	| "decoded-elsewhere-not-applied"
	| "bandplan-skips-truncated"
	| "bandplan-skips-not-applied"
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
	/** WG2: lockout exclusions for the spec's source (sweep plans only). */
	lockoutExclusions?: LockoutExclusion[]
	/** WG6 req 1.2: ranges decoded elsewhere; absent when there are none (or no decoder view). */
	decodedElsewhere?: DecodedElsewhereRange[]
	/** WG7 req 6.3: band-plan skip ranges; absent when there are none (or no band-plan view). */
	bandPlanSkips?: BandPlanSkipRange[]
}

export interface ScanJobProbe {
	probeId: string
	decoderId: string
	trackId: string
	targetHz: number
	protocol: ScannerProtocol
	transport: "offset" | "channel"
	state: "confirming" | "following" | "stopping"
	startedAt: string
}
export interface ScanJobProgress {
	sweepIndex: number
	hopIndex: number
	hopCount: number
	sweepPeriodMs: number | null
	coverage: number
	holdingOn: string | null
	settleMode: SettleMode | null
	probes: ScanJobProbe[]
	counts: {
		observations: number
		transients: number
		discoveries: Record<ScannerConfidence, number>
	}
	/** WG2: per-job hit statistics since the job started. */
	hitStats?: ScanJobHitStats
}

/** WG2 (requirement 13): one discovery's hits in one job (in memory; reset on job start). */
export interface ScanJobHit {
	jobId: string
	discoveryId: string
	/** Observations attributed to the job. */
	hits: number
	firstHitAt: string
	lastHitAt: string
	/** The discovery was created by an observation of this job. */
	firstSeenInJob: boolean
	/**
	 * WG6 req 2.1: duration in ms of the most recent ended observation credited to this
	 * discovery in the job; null until one has ended. Always sent by WG6 cores.
	 */
	lastDurationMs?: number | null
}

export interface ScanJobHitStats {
	/** Distinct discoveries hit (tracked or not). */
	discoveries: number
	/** Total hits. */
	hits: number
	/** Discoveries first seen in this job. */
	newDiscoveries: number
	/** More than 2000 discoveries: the rest count in `hits` only. */
	truncated: boolean
}

/** WG2: GET /api/scanner/jobs/:id/hits?limit=n (1–500, default 100), most recent first. */
export interface ScanJobHitsResponse {
	jobId: string
	stats: ScanJobHitStats
	hits: ScanJobHit[]
}
/** GET /api/scanner/jobs/:id and the `scanner:job` WS message. */
export interface ScanJob {
	resumeAt: string | null
	resumeHeldBy: "audio" | "identify" | "recording" | null
	id: string
	name: string | null
	state: JobState
	reason?: PauseReason | FailReason
	passive: boolean
	spec: NormalisedJobSpec
	plan: HopPlan
	issues: PlanIssue[]
	impact: Impact | null
	unrestorable: string[]
	progress: ScanJobProgress
	createdAt: string
	updatedAt: string
	startedAt?: string
	endedAt?: string
	/** Identify jobs only (spec § 10.8, Task 35a): the request and one entry per target. */
	identify?: ScannerIdentifyView
	/**
	 * SF1: on `paused(preempted-job)` only, the job that holds this job's source lease now;
	 * absent otherwise (and when no other job holds it).
	 */
	preemptedBy?: { jobId: string; name: string | null }
	/** WG2: lockout exclusions in force for this sweep job (runtime only). */
	lockoutExclusions?: LockoutExclusion[]
	/** WG6: ranges decoded elsewhere at the job's last plan (runtime only). */
	decodedElsewhere?: DecodedElsewhereRange[]
	/** WG7: band-plan skip ranges at the job's last plan (runtime only). */
	bandPlanSkips?: BandPlanSkipRange[]
}

// --- Status, settings, bandplans (spec § 12.1) ---

export interface ScannerEngineStatus {
	sourceId: string
	state: "idle" | "running" | "stopped" | "error"
	rbwHz: number | null
	fftSize: number | null
	kByRange: { startHz: number; endHz: number; k: number; faPerMhzMin: number }[]
	floorDbfs: number | null
	floorOccupied: boolean
	overload: boolean
	settleMode: SettleMode | null
	settleMs: number
	settleMeasured: boolean
	markerSupported: boolean | null
	stuckTestMode: boolean
	staleAfterSettle: number
	/** Frames blanked as broadband impulses (spec § 4.9). */
	blankedFrames: number
	/** Periodic broadband RFI (`broadband-rfi`, § 4.9) while active. */
	broadbandRfi: { periodMs: number } | null
	passive: { enabled: boolean; disabledReason?: string }
	frequencyError: { hz: number; ppm: number; discoveries: number } | null
	lastError?: string
}
export interface ScannerStatus {
	enabled: boolean
	channelizerAvailable: boolean
	engines: ScannerEngineStatus[]
	budgets: {
		cpuBudgetCores: number
		cpuCoresInUse: number
		maxProbes: { offset: number; channel: number }
		probesInUse: { offset: number; channel: number }
	}
	cpuGuard: {
		percent: number | null
		limitPercent: number
		source: "os" | "cgroup"
	}
	disk: "ok" | "disk-low"
	jobs: { active: number; total: number }
}

/** The bare settings object (core `ScannerSettings`). */
export interface ScannerSettingsValues {
	enabled: boolean
	passive: { enabled: boolean; offsetProbes: boolean }
	cpuBudgetCores: number
	cpuGuardPercent: number
	maxProbes: { offset: number; channel: number }
	ringSeconds: number
	detection: {
		fftSize: number | "auto"
		integrationMs: number
		sensitivity: "low" | "normal" | "high"
		faTargetPerMhzMin: number
		dcGuardHz: number
		ppmMargin: number
		clipFraction: number
		hysteresisDb: number
		minSurfaceBlocks: number
		shortIntegrationMs: number | null
		overlap: 0 | 0.5
	}
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
		maxCapturesMb: number
	}
	ws: {
		maxMessagesPerSecond: number
		spectrumHz: number
		spectrumBins: number
		spectrumSummaryBins: number
		spectrumMaxProfiles: number
		/** WG8 req 5.2: config only; absent means "auto". */
		spectrumBinsCap?: "auto" | 2048 | 4096 | 8192 | undefined
	}
}
export type ScannerSettingProvenance = "config" | "runtime" | "default"
export interface ScannerSettingBounds {
	type: "number" | "integer" | "boolean" | "string"
	min?: number
	max?: number
	enum?: string[]
}
/** GET /api/scanner/settings body. */
export interface ScannerSettingsView {
	effective: ScannerSettingsValues
	passiveBySource: Record<string, boolean>
	/**
	 * Dotted leaf path ("detection.integrationMs") → origin. Per-source passive is keyed
	 * "passiveBySource.<sourceId>", so a source id never collides with "passive.enabled".
	 */
	provenance: Record<string, ScannerSettingProvenance>
	/**
	 * Keyed by PATCH path ("detection.integrationMs"). Per-source passive has one entry,
	 * the literal key "passive.<sourceId>", which applies to every source id.
	 */
	bounds: Record<string, ScannerSettingBounds>
}

export interface Bandplan {
	id: string
	region: "all" | BandRegion
	name: string
	ranges: ScanRange[]
}

// --- WebSocket payloads (spec § 12.2) ---

export type ScannerJobEventData = ScanJob
export type ScannerStatusEventData = ScannerStatus
export interface ScannerProgressEventData {
	jobId: string
	state: JobState
	sweepIndex: number
	hopIndex: number
	hopCount: number
	centerHz: number
	holdingOn?: string
	coverage: number
	probes: number
	/** WG2: total hits and discoveries first seen in this job. */
	hits?: number
	newDiscoveries?: number
}
export interface ScannerDiscoveryEventData {
	change: "created" | "updated" | "upgraded" | "merged" | "deleted"
	discovery: Discovery
	/** WG2: present when a job's observation caused the event; one entry per such job. */
	jobHits?: ScanJobHit[]
}
export interface ScannerActivityEventData {
	sourceId: string
	observationId: string
	discoveryId?: string
	jobIds: string[]
	frequencyHz: number
	active: boolean
	peakDbfs: number
	hypothesis?: { protocol: ScannerProtocol; score: number }
}
// --- Identify mode (spec § 10.8; Task 35a) ---

export type ScannerIdentifyTarget =
	| { frequencyHz: number; bandwidthHz?: number }
	| { all: true }
/** POST /api/scanner/identify body. */
export interface ScannerIdentifyRequest {
	sourceId?: string
	target: ScannerIdentifyTarget
	/** Wait for the target to transmit; default 15000, 1000–120000. */
	timeoutMs?: number
	/** Only these protocols are tried (default: every plausible one). */
	protocols?: ScannerProtocol[]
	/** Keep trying after the first accepted decode; default false. */
	exhaustive?: boolean
	/** Keep the trials' voice, analog and data recordings; default true. */
	record?: boolean
}
export type ScannerIdentifyState =
	| "waiting-for-signal"
	| "trying"
	| "identified"
	| "candidate"
	| "unidentified"
export type ScannerTrialOutcome =
	| "pending"
	| "running"
	| "decoded"
	| "no-sync"
	| "crc-errors"
	| "timeout"
	| "skipped-budget"
	| "unsupported"
	| "not-needed"
	| "cancelled"
export interface ScannerIdentifyTrial {
	protocol: ScannerProtocol
	/** The decoder that runs the trial or, for an `unsupported` one, would run it; null when none exists (`no-decoder`). */
	decoder:
		| "dsd-fme"
		| "multimon-ng"
		| "direwolf"
		| "rtl433"
		| ScannerAmbientDecoderType
		| null
	/** dsd-fme mode (`auto`, `nxdn`, `nxdn48`, `dpmr`) or the decoder name; null for an `unsupported` trial. */
	mode: string | null
	/** WG7: `ambient` = evidence of a decoder already running there (no probe). */
	transport: "offset" | "channel" | "ambient" | null
	outcome: ScannerTrialOutcome
	/**
	 * Why an `unsupported` trial cannot run. WG7: `no-ambient-decoder` for an ambient-only protocol
	 * nobody decodes there. WG9: `decoder-unavailable` when the trial's decoder program could not
	 * run (missing or not executable) before it produced any output; the outcome stays
	 * `unsupported` so clients with a closed outcome list keep parsing.
	 */
	reason?:
		| "no-decoder"
		| "needs-channelizer"
		| "unsupported-format"
		| "no-ambient-decoder"
		| "decoder-unavailable"
}
/** WG7 req 1.2: decoder types whose running instances name ambient-only protocols. */
export type ScannerAmbientDecoderType =
	| "ais-catcher"
	| "acarsdec"
	| "dumpvdl2"
	| "lora-meshtastic"
/** WG7 req 1.1: protocols identify names only from ambient evidence (no probe decoder). */
export const SCANNER_AMBIENT_PROTOCOLS: readonly ScannerProtocol[] =
	Object.freeze(["ais", "acars", "vdl2", "lora"])
/** WG7 req 1.2: the ambient-only protocol each decoder type names. */
export const SCANNER_AMBIENT_DECODER_PROTOCOL: Readonly<
	Record<ScannerAmbientDecoderType, ScannerProtocol>
> = Object.freeze({
	"ais-catcher": "ais",
	acarsdec: "acars",
	dumpvdl2: "vdl2",
	"lora-meshtastic": "lora",
})
/** WG7 req 1.3: AIS channel A and B (ITU-R M.1371 channels 87B and 88B). */
export const SCANNER_AIS_CHANNEL_HZ: Readonly<Record<"A" | "B", number>> =
	Object.freeze({ A: 161_975_000, B: 162_025_000 })
/** WG7 req 1.3: an ambient decode's frequency must lie this close to one of the decoder's targets. */
export const SCANNER_AMBIENT_TARGET_TOLERANCE_HZ = 1_000
/** WG7 req 1.8: ambient trials planned per identify target at most. */
export const IDENTIFY_AMBIENT_MAX_TRIALS = 8
export interface ScannerIdentifyMeasurements {
	/** `track`: the resolved emission; `spectrum`: the last block summary at the target (no track resolved). */
	source: "track" | "spectrum"
	centreHz: number
	obwHz: number | null
	peakDbfs: number | null
	snrDb: number | null
	floorDbfs: number | null
	dutyCycle: number | null
	acf30?: number
	acf60?: number
	class: ScannerClass
}
export type ScannerArtefactKind = "dc" | "spur" | "image" | "rfi"
export interface ScannerIdentifyResult {
	protocol?: ScannerProtocol
	confidence: ScannerConfidence
	identity?: Identity
	metadata: DiscoveryMetadata
	discoveryId?: string
	observationId?: string
	measurements: ScannerIdentifyMeasurements
	artefact?: ScannerArtefactKind
	/** The target ended early: the tuned window moved off it (retune, sweep takeover); open trials are `cancelled`. */
	ended?: "window-moved"
}
/** `scanner:identify` (one stream per target; `all: true` gives one per surfaced emission). */
export interface ScannerIdentifyEventData {
	jobId: string
	targetHz: number
	state: ScannerIdentifyState
	trials: ScannerIdentifyTrial[]
	result?: ScannerIdentifyResult
}
export interface ScannerIdentifyView {
	target: ScannerIdentifyTarget
	timeoutMs: number
	protocols: ScannerProtocol[]
	exhaustive: boolean
	record: boolean
	targets: ScannerIdentifyEventData[]
}
export interface ScannerMonitorEventData {
	jobId: string
	channel: string
	mode: "analog" | "digital"
	discoveryId?: string
	talkgroup?: string
	source?: string
	slot?: number
	encrypted: boolean
	active: boolean
}

/** A burst IQ capture (Task 34a): the scanner extras beside its manifest v2 entry. */
export interface ScannerCapture {
	id: string
	createdAt: string
	jobId: string
	sourceId: string
	observationId: string
	discoveryId: string | null
	mode: "wideband" | "channel"
	role: "channelizer-golden" | "tail-golden"
	protocol: ScannerProtocol
	identity?: { kind: IdentityKind; value: string }
	decoded: boolean
	encrypted: boolean
	tuningTrust: TuningTrust
	sampleRateHz: number
	centreHz: number
	targetHz: number
	stream: number
	epoch: number
	/** Input sample range [startSample, endSample) of the source stream. */
	startSample: number
	endSample: number
	preRollClippedMs: number
	postTruncated: boolean
	durationS: number
	bytes: number
	files: { iq: string; manifest: string }
}
