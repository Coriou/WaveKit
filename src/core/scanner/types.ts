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
import type {
	DiscoveryCoverage,
	DiscoveryTrialMemory,
} from "@wavekit/api-types"

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
	/** WG7 (web-gaps-7 req 1): named only from evidence of decoders already running (no probe). */
	| "ais"
	| "acars"
	| "vdl2"
	| "lora"
	/** Mode S / ADS-B at 1090 MHz, named only from a running readsb. */
	| "adsb"

export type ScannerClass =
	| "fsk4-12k5"
	| "fsk4-6k25"
	| "tdma-ms"
	| "fsk2-wide"
	| "gmsk-narrow"
	| "afsk-fm"
	| "analog-fm"
	| "analog-am"
	| "ook-burst"
	| "carrier"
	| "wideband"
	| "unknown"

/** Scanner-redesign 3.11: a display-only likely kind of a weak discovery; never a label. */
export type ScannerHint = ScannerClass | "ism-device" | "analog-voice" | "lora"

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
	/** WG7 req 1.1: AIS MMSI, ACARS registration, VDL2 source address, Meshtastic node id. */
	| "ais-mmsi"
	| "acars-reg"
	| "vdl2-addr"
	| "lora-node"
	/** Mode S 24-bit ICAO aircraft address (6 lowercase hex digits). */
	| "icao"

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
	/**
	 * How a persisted probe decode was produced. Absent on a legacy journal
	 * row, and absent means live. Ambient origin still wins over this field.
	 */
	transport?: "live" | "replay"
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
	/**
	 * (DQ 1.15): the track centre lies within `DQ_DC_ADMIT_HZ` of the tuned centre of
	 * its epoch. Such an evidence-less observation never creates a record.
	 */
	dcCentred?: boolean
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

/** WG12: how a proof was established. Rank is decoded > analog-tone > analog-voice > digital-undecoded > carrier-only. */
export type ScannerProofKind =
	| "decoded"
	| "analog-tone"
	| "analog-voice"
	| "digital-undecoded"
	| "carrier-only"
export type ScannerProofTransport = "live" | "replay" | "ambient"
export interface ScannerProof {
	kind: ScannerProofKind
	protocol: ScannerProtocol
	transport: ScannerProofTransport
	at: string
	observationId: string
	identity?: Identity
	talkgroup?: string
	tone?: {
		ctcssHz: number | null
		dcs: { code: string; polarity: "normal" | "inverted" } | null
	}
	voice?: boolean
	tried: ScannerProtocol[]
	unavailable: (
		| "dsd-fme"
		| "multimon-ng"
		| "direwolf"
		| "rtl433"
		| "acarsdec"
	)[]
	encrypted: boolean
	summary: string
}
/** WG12: `proven` is a discovery with a proof; `weak` is one without. */
export type ScannerEvidenceLevel = "proven" | "weak"

export type UndecodedReason =
	| "no-sync"
	| "crc-errors"
	| "timeout"
	| "no-probe-transport"
	| "budget"
	| "unsupported-format"

export interface Discovery {
	anchor?: "decode"
	aircraftCount?: number
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
	/** WG12: derived from stored evidence. Absent on cores before the redesign and when nothing is proven. */
	proof?: ScannerProof
	/** WG12: `proven` when `proof` is set, otherwise `weak`. Absent on cores before the redesign. */
	evidenceLevel?: ScannerEvidenceLevel
	/** Scanner-redesign 3.11: weak discoveries only, computed on read, never stored. */
	hint?: ScannerClass | "ism-device" | "analog-voice" | "lora"
	/** Band inspection UX req 1.4: projected at read time by the routes, never stored. */
	coverage?: DiscoveryCoverage[]
	/** Detail reads only: the remembered replay trials, projected by the routes (never stored). */
	trialMemory?: DiscoveryTrialMemory[]
	/** Band inspection UX req 3.1: detail read by an absorbed id (never stored). */
	absorbedInto?: string
	requestedId?: string
	/**
	 * Band inspection UX req 3.3: the store revision of this record's last change, set on every
	 * read and event (never stored). Strictly increases on each change within one `storeEpoch`.
	 */
	revision?: number
	/** Band inspection UX req 3.3: single-record answers only (DiscoveryStoreMeta in api-types). */
	storeEpoch?: string
	storeRevision?: number
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
	/** WG12: derived from this observation's evidence. Absent when nothing is proven. */
	proof?: ScannerProof
}

/**
 * WG15 DQ 3.4: the store's persisted and journaled observation form. `classVote` is the class the
 * observation voted with; absent means no vote (edge, or written before DQ). Core only: the DTO
 * (`Observation`) never carries it.
 */
export interface StoredObservation extends Observation {
	classVote?: ScannerClass
	/** Scanner-redesign 3.11: the track was a burst or at most 4 blocks (the hint's `short`). */
	short?: boolean
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
	/** Burst IQ capture (Task 34a); default off. */
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

/**
 * Ambient evidence pairs with an observation from 2 s before its start to 2 s after its end
 * (§ 6.3); an `onlyDecoded` burst capture waits as long after the close for a late decode.
 */
export const AMBIENT_PAIR_MS = 2000

export interface CaptureSpec {
	enabled: boolean
	mode: "wideband" | "channel"
	preMs: number
	postMs: number
	onlyDecoded: boolean
	maxPerHour: number
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

/**
 * WG6 req 1.1: what the plan reads about one decoder (Main maps DecoderManager statuses to it in
 * the scanner service's preview context). Coverage is only ever derived from these fields.
 */
export interface DecoderCoverageView {
	id: string
	/** The process (or in-process decoder) is running. */
	running: boolean
	health: "running" | "idle" | "restarting" | "faulted"
	suspended: boolean
	/** Scanner probes ("scanner") never count. */
	owner: "config" | "scanner"
	/** WaveKit source the decoder reads (default source resolved); null = external input. */
	sourceId: string | null
	inputKind: "iq" | "audio_pcm" | "external"
	/** The decoder's band assessment; null when it has none. */
	band: {
		verdict: "in-band" | "out-of-band" | "unknown"
		basis:
			| "configured"
			| "protocol"
			| "decoder-default"
			| "region-default"
			| "override"
			| null
		targetsHz: readonly number[]
		rangesHz: readonly { minHz: number; maxHz: number }[]
		captureCenterHz: number | null
		windowHalfWidthHz: number | null
	} | null
}

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

/**
 * WG7 req 6.2: what the plan reads about one skip-marked band segment (Main maps the resolved
 * band-plan view to it in the scanner service's preview context). Inclusive edges in Hz.
 */
export interface BandPlanSkipSource {
	/** Resolved band key `<packId>/<bandId>`. */
	key: string
	startHz: number
	endHz: number
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
	passive: {
		enabled: boolean
		offsetProbes: boolean
		/** WG11 req 2.1: config only; absent means 0.25 (PASSIVE_COST_LIMIT_DEFAULT). */
		maxEngineUtilization?: number | undefined
	}
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
	 * spectrumSummaryBins 2048 (512–8192, `SPECTRUM_SUMMARY_BINS_MAX`; served bins ≤ min(cap, budget)) and spectrumMaxProfiles 4 (1–16) are config-only.
	 */
	ws: {
		maxMessagesPerSecond: number
		spectrumHz: number
		spectrumBins: number
		spectrumSummaryBins: number
		spectrumMaxProfiles: number
		/** WG8 req 5.2: config only; absent means "auto" (the bins cap; see SpectrumBinsCapSetting). */
		spectrumBinsCap?: "auto" | 2048 | 4096 | 8192 | undefined
	}
	/** WG11 req 6.1: config only, protected access mode only; absent means no IQ capture. */
	iqCapture?: ScannerIqCaptureConfig | undefined
}

/** WG11 req 6.1: `scanner.iqCapture` (bounds in src/config.ts and iq-capture-contract.ts). */
export interface ScannerIqCaptureConfig {
	enabled: boolean
	maxTotalMb: number
	maxCaptureMs: number
	preRollMs: number
	binaryPath: string
}
