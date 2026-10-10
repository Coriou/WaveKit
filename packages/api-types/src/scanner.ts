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
}
export interface ScanExclusion extends FreqRange {
	reason?: string
}
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
}
/** GET /api/scanner/jobs/:id and the `scanner:job` WS message. */
export interface ScanJob {
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
}
export interface ScannerDiscoveryEventData {
	change: "created" | "updated" | "upgraded" | "merged" | "deleted"
	discovery: Discovery
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
	decoder: "dsd-fme" | "multimon-ng" | "direwolf" | "rtl433" | null
	/** dsd-fme mode (`auto`, `nxdn`, `nxdn48`, `dpmr`) or the decoder name; null for an `unsupported` trial. */
	mode: string | null
	transport: "offset" | "channel" | null
	outcome: ScannerTrialOutcome
	/** Why an `unsupported` trial cannot run. */
	reason?: "no-decoder" | "needs-channelizer" | "unsupported-format"
}
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
