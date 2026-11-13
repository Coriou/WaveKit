/**
 * Signal discovery scanner DTOs (docs/superpowers/specs/2026-10-09-signal-discovery-scanner-design.md
 * § 7.1, § 10, § 12). Copies of src/core/scanner/types.ts; the contract test
 * tests/unit/api/scanner-dto-contract.test.ts keeps them identical.
 */
import type { ScannerPassiveReason } from "./agent-status.js"
import type { BandRegion, DecoderSuspensionReasonCode } from "./decoders.js"
import type { AnalogTransmissionDcs } from "./live-audio.js"

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
	/** Mode S / ADS-B at 1090 MHz, named only from a running readsb (ambient evidence). */
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
	/** Mode S 24-bit ICAO aircraft address, 6 lowercase hex digits. */
	| "icao"
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
	/** Explicit checked-content provenance; absent means unverified. */
	contentVerified?: boolean
	/** Most frequent sync-only DMR CC; never an identity. */
	unverifiedCc?: number
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
	/**
	 * How a persisted probe decode was produced. Absent on a legacy journal
	 * row, and absent means live. Ambient origin still wins over this field.
	 */
	transport?: "live" | "replay"
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
	unverifiedCc?: number
	/** Checked DMR TG/SRC without an accepted CC identity; still weak. */
	tgSrcVerified?: boolean
	kind: ScannerProofKind
	protocol: ScannerProtocol
	transport: ScannerProofTransport
	at: string
	observationId: string
	identity?: Identity
	talkgroup?: string
	tone?: { ctcssHz: number | null; dcs: AnalogTransmissionDcs | null }
	voice?: boolean
	tried: ScannerProtocol[]
	unavailable: ScannerProbeDecoderType[]
	encrypted: boolean
	summary: string
}
/** Valid proofs are `proven`, except dsd-fme sync-only and TG/SRC-verified CC-unknown proofs, which stay `weak`. */
export type ScannerEvidenceLevel = "proven" | "weak"
/**
 * WG12: the new discovery-list query fields only. `evidence` absent means both.
 * `toleranceHz` is refused without `nearHz`.
 */
export interface ScannerDiscoveryQueryParams {
	evidence?: "proven" | "weak" | "all"
	nearHz?: number
	toleranceHz?: number
}
/** WG12: how long identify waits for a gated transmission when `waitUntilSignal` is set. */
export const IDENTIFY_WAIT_DEFAULT_MS = 300_000
export const IDENTIFY_WAIT_MAX_MS = 600_000
export const IDENTIFY_WAIT_MIN_MS = 1_000
/** WG12: default and maximum `|Δf|` of `nearHz`. */
export const DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ = 6_250
export const DISCOVERY_NEAR_MAX_TOLERANCE_HZ = 1_000_000
/** WG12: `ScannerProof.summary` is at most this many characters. */
export const SCANNER_PROOF_SUMMARY_MAX_CHARS = 160
/** WG12: `ScannerProof.tried` keeps at most this many protocols. */
export const SCANNER_PROOF_TRIED_MAX = 16
/** WG12: a merge event lists at most this many absorbed discovery ids. */
export const DISCOVERY_MERGED_IDS_MAX = 64
/** WG12: fixed English labels for proof summaries. `nxdn48` and `nxdn96` share NXDN. */
export const SCANNER_PROOF_PROTOCOL_LABEL: Readonly<
	Record<ScannerProtocol, string>
> = Object.freeze({
	"analog-fm": "Analog FM",
	"analog-am": "Analog AM",
	dmr: "DMR",
	p25p1: "P25",
	p25p2: "P25 Phase 2",
	nxdn48: "NXDN",
	nxdn96: "NXDN",
	ysf: "YSF",
	dstar: "D-STAR",
	dpmr: "dPMR",
	pocsag: "POCSAG",
	flex: "FLEX",
	aprs: "APRS",
	ism: "ISM",
	"digital-unknown": "Digital",
	carrier: "Carrier",
	unknown: "Unknown",
	ais: "AIS",
	acars: "ACARS",
	vdl2: "VDL2",
	lora: "LoRa",
	adsb: "ADS-B",
})

/** Why a discovery is flagged as a receiver spur (`Discovery.receiverSpur`). */
export interface DiscoveryReceiverSpur {
	/** The spur's offset from the tuned centre (Hz). */
	offsetHz: number
	/** Sample rate the offset was learned at (Hz). */
	sampleRateHz: number
	/** Distinct tuned centres the line was seen from when flagged (0: an offset learned earlier). */
	centres: number
	/** When the flag was last confirmed (epoch ms). */
	lastAtMs: number
}

/** Spec § 7.1; timestamps ISO 8601. */
export interface Discovery {
	/** Decodes locate this emission; RF fields are unmeasured zero placeholders. */
	anchor?: "decode"
	/** Distinct confirmed ICAOs in the last 60 seconds, capped at 4096. */
	aircraftCount?: number
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
	/** WG12: derived from stored evidence. Absent on cores before the redesign and when nothing is proven. */
	proof?: ScannerProof
	/** WG12: `proven` when `proof` is set, otherwise `weak`. Absent on cores before the redesign. */
	evidenceLevel?: ScannerEvidenceLevel
	/** Weak discoveries only: a display hint of the likely kind, never a label or filter. */
	hint?: ScannerClass | "ism-device" | "analog-voice" | "lora"
	/**
	 * Set when the scanner judged this record a receiver spur (a steady narrow line at one offset
	 * from the tuned centre, seen from several tuned centres). Such records are hidden from the
	 * discovery list by default (`includeReceiverSpurs=true` lists them) and are never deleted for
	 * it. Never set on a record with a proof, decode, identity, recording or operator mark; one that
	 * gains any is unflagged for good. Persisted: after a restart it stays set, and holds if the
	 * scanner learns the same offset again within 10 min; else it lifts then (published like any
	 * change). Absent on older cores.
	 */
	receiverSpur?: DiscoveryReceiverSpur
	/**
	 * The latest Activity event attributed to this discovery: `eventId` names it for
	 * `GET /api/activity/:eventId`, `producedAt` is its ISO time. Optional and additive: absent when
	 * none is attributed, and on cores that do not attribute Activity events to discoveries yet
	 * (clients then filter Activity by the discovery's frequency). The event may have expired.
	 */
	lastActivity?: { eventId: string; producedAt: string }
	/**
	 * Band inspection UX req 1.4: decoders whose placements cover `frequencyHz` on one of
	 * `sourceIds`, projected at read time (never stored). Absent: unknown (no claim). `[]`:
	 * verified no placement covers it. At most DISCOVERY_COVERAGE_MAX, running first.
	 */
	coverage?: DiscoveryCoverage[]
	/**
	 * Detail reads (`GET /api/scanner/discoveries/:id`) only: the replay trials remembered for this
	 * discovery, at most DISCOVERY_TRIAL_MEMORY_MAX. Absent when nothing is remembered or on cores
	 * without a trial memory.
	 */
	trialMemory?: DiscoveryTrialMemory[]
	/**
	 * Detail reads only: the wideband analog recorder's decisions for this discovery's
	 * observations (ScannerRecorderDiscovery). Absent when the recorder decided nothing about it
	 * (or forgot: it remembers RECORDER_MAX_OBSERVATIONS observations) and on older cores.
	 */
	recorder?: ScannerRecorderDiscovery
	/**
	 * Band inspection UX req 3.1: set on a detail read by an id a merge absorbed; this record is
	 * the survivor, `requestedId` the id asked for.
	 */
	absorbedInto?: string
	requestedId?: string
	/**
	 * Band inspection UX req 3.3: the store revision of this record's last change. Every change to
	 * a record (an observation, an operator edit, a merge into it) gives it a new revision from
	 * one store-wide counter, so within one `storeEpoch` a record's revision strictly increases.
	 * Present on every read and event of a current core; absent on older cores.
	 */
	revision?: number
	/** Band inspection UX req 3.3: on single-record answers (GET, PATCH): the store's epoch. */
	storeEpoch?: string
	/**
	 * Band inspection UX req 3.3: on single-record answers: the store-wide revision when the answer
	 * was taken (at least `revision`).
	 */
	storeRevision?: number
}

/**
 * Band inspection UX req 3.3: on a discovery list answer (`GET /api/scanner/discoveries`). The
 * epoch is new each time the core starts (revisions restart with it); the revision is the
 * store-wide revision when the page was taken, so no record on it has a newer one.
 */
export interface DiscoveryStoreMeta {
	storeEpoch: string
	storeRevision: number
}

/** Band inspection UX req 3.3: headers of a successful DELETE of a discovery (204, no body). */
export const DISCOVERY_STORE_EPOCH_HEADER = "x-wavekit-store-epoch"
export const DISCOVERY_STORE_REVISION_HEADER = "x-wavekit-store-revision"

/** Band inspection UX req 1.4: at most this many coverage entries per discovery. */
export const DISCOVERY_COVERAGE_MAX = 3
/** Band inspection UX req 1.4: decoder ids longer than this are never reported. */
export const DISCOVERY_COVERAGE_DECODER_ID_MAX = 64
/** Band inspection UX req 1.4: channel width when a decoder declares none. */
export const DISCOVERY_COVERAGE_DEFAULT_CHANNEL_WIDTH_HZ = 12_500

/** At most this many remembered replay trials per discovery. */
export const DISCOVERY_TRIAL_MEMORY_MAX = 16

/** One remembered replay trial (protocol + decoder) of a discovery. */
export interface DiscoveryTrialMemory {
	protocol: ScannerProtocol
	/** Decoder type that ran the trial (`analog-demod` for an analog trial). */
	decoder: string
	attempts: number
	decoded: number
	/** Failed attempts since the last success. */
	consecutiveFailures: number
	lastOutcome:
		| "decoded"
		| "heard"
		| "no-sync"
		| "crc-errors"
		| "timeout"
		| "data-like"
		| "carrier-only"
	/** ISO 8601. */
	lastAt: string
	/** ISO 8601; absent when the trial never succeeded. */
	lastDecodedAt?: string
}

export interface DiscoveryCoverage {
	/** 1-64 chars. */
	decoderId: string
	state: "running" | "suspended" | "stopped"
	suspensionReason?: DecoderSuspensionReasonCode
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
	/** WG12: derived from this observation's evidence. Absent when nothing is proven. */
	proof?: ScannerProof
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
	/** The receiver feed was resumed without retuning: the sweep hops again only on resume. */
	| "resumed-without-retune"
export type FailReason = "source-removed" | "tuner-unavailable" | "invalid"
/** Why a job was cancelled by the core rather than the operator: the receiver feed was paused. */
export type CancelReason = "source-paused"

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

/** WG12: what a scan job is doing, at the progress cadence. */
export type ScanJobPhase =
	| "settling"
	| "holding"
	| "trialing"
	| "replaying"
	| "capturing"
	| "watching"
export interface ScanJobProbe {
	probeId: string
	decoderId: string
	trackId: string
	targetHz: number
	protocol: ScannerProtocol
	/** WG11 req 6.5: `replay` = a probe fed from an IQ capture, not the live stream. */
	transport: "offset" | "channel" | "replay"
	state: "confirming" | "following" | "stopping"
	startedAt: string
}
export interface ScanJobProgress {
	/** Per planned hop, including the current visit. Absent without a sweep scheduler. */
	hops?: {
		hopIndex: number
		visits: number
		/** Wall ms from tune to leave, pauses excluded. The phases below and `holdMs` sum to it. */
		timeMs: number
		holdMs: number
		lastVisitAgeMs: number | null
		/**
		 * Measured, unlike the planned `spec.settleMs`: from the tune's answer to the first block of its
		 * epoch, that block's own length left out. Includes the tune's latency when the epoch opened
		 * before the answer.
		 */
		measuredSettleMs?: number
		/** Measured: blocks of the previous hop's IQ discarded after settling. */
		measuredStaleMs?: number
		/** Measured, unlike the planned `spec.dwellMs`: heard blocks, at most the wall time they took. */
		measuredDwellMs?: number
		/** Measured: heard blocks past the planned dwell (a gate's or class's answer, a carrier's gap). */
		measuredQualifyMs?: number
		/** The rest of `timeMs`: tune command and queue latency, a dwell's stream arriving late. */
		overheadMs?: number
	}[]
	sweepIndex: number
	hopIndex: number
	hopCount: number
	sweepPeriodMs: number | null
	/**
	 * Sweep: the share of planned hops visited in the last full sweep (the current one before that);
	 * no measure of time or of the spectrum heard. In-window: settled samples over observed samples.
	 */
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
	/** WG12: absent on cores before the redesign. */
	phase?: ScanJobPhase
	parked?: boolean
	holding?: {
		discoveryId: string | null
		frequencyHz: number
		trackId: string
	}
	trial?: {
		protocol: ScannerProtocol
		decoder: string
		transport: "offset" | "channel" | "replay"
		discoveryId: string | null
	}
	replayQueueDepth?: number
	/**
	 * Hops the sweep left without hearing them, by reason; absent while none. `unproven`: the hop's
	 * tuning never proved (a standing doubt) within 4 × the larger of its dwell and its settle (at least 15 s).
	 */
	hopSkips?: { unproven: number }
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
	reason?: PauseReason | FailReason | CancelReason
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
	/**
	 * What the operator agreed to (`takeover: true`, at creation or on a resume); null when no
	 * consent was given. `impact` is what the job would disturb as last reported: at creation,
	 * and again when a resume is refused or an auto-resume finds it grew. A job auto-resumes only
	 * while the current impact fits this one. Absent from older cores.
	 */
	consentedImpact?: Impact | null
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
	passive: {
		enabled: boolean
		disabledReason?: string
		/** `disabledReason` as a closed code; absent while the cost guard does not hold it off. */
		reasonCode?: ScannerPassiveReason
		/** When the cost guard turned it off (not set for a measuring window). */
		disabledAt?: string
	}
	frequencyError: { hz: number; ppm: number; discoveries: number } | null
	lastError?: string
	/**
	 * R3: broadband blanking keeps rising while the gain is manual, so the front end may be
	 * overloaded at this gain (`gain`, tenths of a dB). `blankedPercent` is the share of frames
	 * blanked over the last ~30 s. A hint only: absent when not shown, in AGC, when the gain is
	 * unknown, and from older cores.
	 */
	overloadHint?: {
		reason: "front end may be overloaded at this gain"
		gain: number
		blankedPercent: number
	}
	/**
	 * Why the passive job last failed to start; removed by its next successful start. `code` is
	 * a closed error code (`UNKNOWN` for anything else), never an error's text.
	 */
	lastPassiveStartFailure?: { code: string; at: string }
	/** The last lease step the core tried on its own and was refused; kept until the next one. */
	lastLeaseRefusal?: ScannerLeaseRefusal
}
/**
 * `kind`: `arbitration` picking the next lease holder failed; `hand-back` a preempted job did not
 * take the lease back; `boot-resume` a job could not resume after a restart. `code` as above.
 */
export interface ScannerLeaseRefusal {
	kind: "arbitration" | "hand-back" | "boot-resume"
	code: string
	at: string
	/** The job holding the lease, when the refusal names one. */
	holderJobId?: string
}
export interface ScannerIqCaptureStatus {
	trialCaptures?: {
		started: number
		completed: number
		failed: number
		swept: number
	}
	toolFailures: number
	/**
	 * Captures asked for at a rate the running tool did not acknowledge (an older tool), made at
	 * 48 kHz instead. Absent from older cores.
	 */
	rateFallbacks?: number
	lastToolFailure: {
		exitCode: number | null
		signal: string | null
		phase:
			| "spawn-error"
			| "ready-timeout"
			| "exit-before-ready"
			| "exit-after-ready"
		reason:
			| "usage"
			| "sample-rate"
			| "bandwidth"
			| "anchor"
			| "out-dir"
			| "control-fd"
			| "other"
	} | null
}

/**
 * Decisions of the wideband analog voice recorder (docs/SCANNER.md, Recorder decisions). A
 * `refused:*` code means the observation is not recorded now: `refused:slots`, `refused:cpu`,
 * `refused:not-analog`, `refused:tuning`, `refused:no-iq` and `refused:channel-owned` are
 * retried on its next snapshot. `refused:encrypted`, `refused:record-disabled` and
 * `refused:unclean` given before any recording started are retried too (a later clear, opted-in,
 * clean snapshot may start one); given to a recording in progress they end it and the
 * observation. `refused:store` is retried once (a second one is final; a finishing or waiting
 * file's store failure refuses that file only). `refused:unsupported` and `refused:start-failed`
 * are final. `refused:close-only`: the observation was classed analog-fm only by a snapshot that
 * closed it while no recording ran for it (nothing is left to record). A `discarded:*` code means audio was held and dropped without a file. Every
 * recording that started ends with exactly one terminal decision per file: `finalized`,
 * `evicted`, `refused:*` or `discarded:*`.
 */
export const SCANNER_RECORDER_DECISIONS = [
	"started",
	"shadow",
	"classed",
	"voiced",
	"evicted",
	"finalized",
	"refused:channel-owned",
	"refused:no-iq",
	"refused:tuning",
	"refused:not-analog",
	"refused:unsupported",
	"refused:slots",
	"refused:cpu",
	"refused:start-failed",
	"refused:encrypted",
	"refused:record-disabled",
	"refused:unclean",
	"refused:store",
	"refused:close-only",
	"discarded:not-analog",
	"discarded:unclassed",
	"discarded:no-discovery",
	"discarded:unvoiced",
	"discarded:too-short",
	"discarded:source-lost",
	"discarded:empty",
	"discarded:buffer-full",
	"discarded:store-backlog",
	"discarded:write-failed",
	"discarded:park-expired",
	"discarded:aborted",
	"discarded:error",
] as const
export type ScannerRecorderDecision =
	(typeof SCANNER_RECORDER_DECISIONS)[number]
/**
 * Session decisions kept in `ScannerRecorderStatus.recent` (newest last): a recording costs 3 to 5
 * (started or shadow, classed, voiced, one terminal decision per file), so 64 keep the last 12 to
 * 20 recordings whatever the snapshot refusals do.
 */
export const RECORDER_RECENT_DECISIONS = 64
/**
 * Snapshot refusals kept in `ScannerRecorderStatus.recentRefusals` (newest last), apart from the
 * session decisions: a snapshot refused before any session (`refused:not-analog`,
 * `refused:tuning`, `refused:slots`, …; one entry per observation and code in a row) can come
 * every few seconds per track, so they get their own 32 and never push a session decision out.
 */
export const RECORDER_RECENT_REFUSALS = 32
/** Observations whose decisions the recorder remembers for discovery reads (oldest dropped). */
export const RECORDER_MAX_OBSERVATIONS = 256

/**
 * Why a track snapshot was unclean (docs/SCANNER.md, Recorder decisions): `spur` (a baseband
 * spur line), `iq-image` (the mirror of a stronger signal), `edge` (touches the usable span),
 * `truncated`, `wide` (occupied bandwidth over the recorder's limit, or not finite) or `tuning`
 * (the tuning is not trusted).
 */
export const SCANNER_RECORDER_FLAGS = [
	"spur",
	"iq-image",
	"edge",
	"truncated",
	"wide",
	"tuning",
] as const
export type ScannerRecorderFlag = (typeof SCANNER_RECORDER_FLAGS)[number]
/**
 * Which snapshot raised the flag: `snapshot` (an update of the session's own observation),
 * `joined` (another observation merged into the session: a track joining the same channel, or
 * an update of one), `close` (the snapshot that closed an observation).
 */
export const SCANNER_RECORDER_FLAG_SOURCES = [
	"snapshot",
	"joined",
	"close",
] as const
export type ScannerRecorderFlagSource =
	(typeof SCANNER_RECORDER_FLAG_SOURCES)[number]

/** The first unclean snapshot of a recording session and how many of its snapshots were. */
export interface ScannerRecorderFlagDetail {
	flag: ScannerRecorderFlag
	raisedBy: ScannerRecorderFlagSource
	/** Signal time from the session's onset to the end of the snapshot that raised it, ms. */
	atMs: number
	/** Unclean snapshots of the session so far. */
	flagged: number
	/** Snapshots of the session so far (its start, updates and closes of joined observations). */
	snapshots: number
	/**
	 * The session was kept (no veto): the flag (spur or iq-image only) was first seen after the
	 * session was classed and voiced, and stayed on fewer than half of its snapshots. Its files are
	 * written, but give no tone evidence.
	 */
	kept: boolean
}

export const SCANNER_RECORDER_ERRORS = [
	"admission-denied",
	"disk-unavailable",
	"disk-low",
	"storage-cap",
	"write-failed",
	"close-failed",
	"header-invalid",
	"rename-failed",
	"metadata-failed",
	"cleanup-failed",
	"recovery-incomplete",
	"invalid-binding",
	"recovery-ambiguous",
] as const

/** The end a recording's store operation was given (`ScannerRecorderReceiptDetail.cutReason`). */
export const SCANNER_RECORDER_CUTS = [
	"completed",
	"duration-limit",
	"track-ended",
	"cancelled",
	"discovery-deleted",
	"source-lost",
	"epoch-changed",
	"stream-changed",
	"channel-invalidated",
	"engine-failed",
	"shutdown",
] as const

/**
 * Which check refused a store operation whose error is `admission-denied` or `invalid-binding`
 * (`ScannerRecorderReceiptDetail.failure`).
 */
export const SCANNER_RECORDER_FAILURES = [
	"cancelled",
	"authority-unhealthy",
	"discovery-removed",
	"association-lost",
	"binding-unusable",
	"binding-not-live",
	"commit-plan-stale",
] as const

export interface ScannerRecorderReceiptDetail {
	outcome: "finalized" | "aborted" | "failed"
	errorCode: (typeof SCANNER_RECORDER_ERRORS)[number] | null
	/** Why a recording ended; absent on older cores. */
	cutReason?: (typeof SCANNER_RECORDER_CUTS)[number] | null
	/** Which check refused it, null when none did; absent on older cores. */
	failure?: (typeof SCANNER_RECORDER_FAILURES)[number] | null
}

export interface ScannerRecorderDecisionEntry {
	receipt?: ScannerRecorderReceiptDetail

	code: ScannerRecorderDecision
	/** ISO time of the decision. */
	at: string
	sourceId: string
	observationId: string
	/** Null while the observation has no discovery yet (a shadow). */
	discoveryId: string | null
	/**
	 * Set on the decisions of a session once one of its snapshots was unclean (the refusal that
	 * ended it, or the later decisions of a session kept over a late minority flag). Absent on
	 * older cores and on sessions with only clean snapshots.
	 */
	unclean?: ScannerRecorderFlagDetail | undefined
}

/** One live recorder session (one channel being demodulated). */
export interface ScannerRecorderSession {
	sourceId: string
	/** The observation that started the session. */
	observationId: string
	discoveryId: string | null
	/** shadow: not classed analog yet; classed: classed, not voiced yet; voiced: both. */
	state: "shadow" | "classed" | "voiced"
	/** A store operation (a WAV file) is open. */
	writing: boolean
	/** How far the demodulator is behind the live edge, in ms of signal. */
	backlogMs: number
}

export interface ScannerRecorderStatus {
	sessions: ScannerRecorderSession[]
	/** Retune-ended sessions waiting for their close. */
	parked: number
	/**
	 * The last RECORDER_RECENT_DECISIONS session decisions (a session's start, class, voice,
	 * eviction, terminal decision, or the refusal or discard that ended it), newest last.
	 */
	recent: ScannerRecorderDecisionEntry[]
	/**
	 * The last RECORDER_RECENT_REFUSALS snapshot refusals (an observation refused before any session
	 * started for it), newest last. Absent on older cores, whose `recent` held both.
	 */
	recentRefusals?: ScannerRecorderDecisionEntry[] | undefined
	/** Decisions since the core started, per code (codes never seen are absent). */
	counts: Partial<Record<ScannerRecorderDecision, number>>
	/**
	 * Session decision lines left out by the info log's rate limit since the core started (snapshot
	 * refusals are logged at debug, outside the limit).
	 */
	logsSuppressed: number
}

/** `Discovery.recorder`: the recorder's decisions for one discovery's observations. */
export interface ScannerRecorderDiscovery {
	last: ScannerRecorderDecisionEntry
	counts: Partial<Record<ScannerRecorderDecision, number>>
}

/** `ScannerStatus.folders`: the load-time migration of folders without an owner. */
export interface ScannerFolderMigrationStatus {
	reattached: number
	unresolved: number
	/**
	 * Why the `unresolved` folders were not traced (they add up to it): `noAlias`, no merge alias
	 * names the folder; `aliasWithoutOwner`, its alias chain ends at no live discovery. Either way
	 * no observation listing its recordings named a single owner. Absent on older cores.
	 */
	unresolvedBy?: { noAlias: number; aliasWithoutOwner: number } | undefined
}

/** `ScannerStatus.stateBackup`: the start's pre-migration backup outcome. */
export interface ScannerStateBackupStatus {
	outcome: "taken" | "skipped" | "none"
	reason?:
		| "unreadable"
		| "low-disk"
		| "disk-unknown"
		| "too-many-files"
		| "copy-failed"
		| "same-format"
		| "fresh"
		| undefined
	/** The format label on disk before this start (absent for `none`). */
	fromFormat?: string | undefined
	/** This build's format label. */
	toFormat: string
	/** `.backups/pre-<from>.<ms>`, relative to the scanner directory (`taken` only). */
	path?: string | undefined
}

export interface ScannerStatus {
	/** The wideband analog recorder's sessions and decisions. Absent on older cores. */
	recorder?: ScannerRecorderStatus | undefined
	iqCapture?: ScannerIqCaptureStatus | undefined
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
	/**
	 * Recording and evidence folders the load re-attached to their discovery after a merge
	 * released them (`reattached`), and folders no discovery could be traced to, kept in place
	 * (`unresolved`). Absent on older cores and before the scanner state loaded.
	 */
	folders?: ScannerFolderMigrationStatus | undefined
	/**
	 * This start's pre-migration backup of the scanner state (taken when the format on disk
	 * differs from this build's): `taken` with its `path` (relative to the scanner directory),
	 * `skipped` with a fixed `reason` (`unreadable`, `low-disk`, `disk-unknown`,
	 * `too-many-files`, `copy-failed`), or `none` (`same-format`, `fresh`). Absent before the
	 * scanner state loaded and on older cores.
	 */
	stateBackup?: ScannerStateBackupStatus | undefined
	/**
	 * Present while the last retention pass left the recordings quota (`maxRecordingsMb`) exceeded
	 * after removing every file its rules allow: everything left is protected. Analog recordings
	 * are refused (`storage-cap`) until it clears. Absent within the quota and on older cores.
	 */
	recordingsQuota?: ScannerRecordingsQuotaStatus | undefined
	/**
	 * Incomplete analog recording operation folders (crash residue holding no media) the core set
	 * aside instead of refusing recordings: `setAside` held now (at most 32 evictable ones, oldest
	 * deleted past it; one that cannot be proven media-free is kept and counted, so it can exceed
	 * 32), `lastReason` of the last one this run. Absent while none is held and on older cores.
	 */
	analogOperations?: {
		setAside: number
		lastReason?: "staging-residue" | "missing-intent" | "invalid-intent"
	}
	jobs: { active: number; total: number }
}

/** `ScannerStatus.recordingsQuota`: the recordings quota exceeded with nothing removable. */
export interface ScannerRecordingsQuotaStatus {
	state: "exceeded"
	/** The refusal analog admission gives meanwhile. */
	reason: "storage-cap"
	capBytes: number
	usedBytes: number
	/** `usedBytes - capBytes`. */
	overBytes: number
}

/** The bare settings object (core `ScannerSettings`). */
export interface ScannerSettingsValues {
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
	/** WG11 req 6.1: config only; absent means no IQ capture. */
	iqCapture?: ScannerIqCaptureSettings | undefined
}
/** WG11 req 6.1: narrowband IQ capture on detection (protected access mode only; off by default). */
export interface ScannerIqCaptureSettings {
	enabled: boolean
	/** Total capture storage, at most 256 MiB. */
	maxTotalMb: number
	/** One capture, pre-roll included, at most 4000 ms. */
	maxCaptureMs: number
	/** Pre-roll before the track start, at most 2000 ms (the native ring). */
	preRollMs: number
	/** The native capture tool (`wavekit-iqcap`). */
	binaryPath: string
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
	/** WG12: absent on cores before the redesign. */
	phase?: ScanJobPhase
	parked?: boolean
	holding?: {
		discoveryId: string | null
		frequencyHz: number
		trackId: string
	}
	trial?: {
		protocol: ScannerProtocol
		decoder: string
		transport: "offset" | "channel" | "replay"
		discoveryId: string | null
	}
	replayQueueDepth?: number
}
export interface ScannerDiscoveryEventData {
	change: "created" | "updated" | "upgraded" | "merged" | "deleted"
	discovery: Discovery
	/** WG2: present when a job's observation caused the event; one entry per such job. */
	jobHits?: ScanJobHit[]
	/**
	 * Discovery ids absorbed by a merge. Present on `merged`; band inspection UX req 3.2: a
	 * `deleted` may carry it too (a merge into the deleted survivor was coalesced into this event),
	 * and clients drop those ids as well. Absent on every other change.
	 */
	mergedIds?: string[]
	/**
	 * Band inspection UX req 3.2: `mergedIds` was cut at 64; refetch the survivor (unless
	 * `deleted`) and the discovery list.
	 */
	mergedTruncated?: true
	/**
	 * Band inspection UX req 3.3: the store revision of this change: the record's new revision,
	 * or for `deleted` the revision of the removal. For `merged`, every id in `mergedIds` was
	 * removed at this same revision.
	 */
	revision?: number
	/** Band inspection UX req 3.3: the store's epoch; a new one means the core restarted. */
	storeEpoch?: string
}
/**
 * Band inspection UX req 3.2: `scanner:discoveries-resync` payload. Sent instead of per-group
 * `merged` events when a start applies more than SCANNER_CONSOLIDATION_EVENT_GROUPS_MAX groups;
 * clients refetch the discovery list.
 */
export interface ScannerDiscoveriesResyncEventData {
	reason: "consolidation"
	groups: number
}
export const SCANNER_CONSOLIDATION_EVENT_GROUPS_MAX = 256
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
	/**
	 * WG12: stay `waiting-for-signal` until a gated transmission, then count `timeoutMs`
	 * from its start. Absent keeps today's path.
	 */
	waitUntilSignal?: boolean
	/** WG12: give up the wait after this many ms. Refused without `waitUntilSignal`. */
	waitMs?: number
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
	/**
	 * WG11 req 1.1: a `live-audio` trial whose matching transmission carried no CTCSS tone or
	 * DCS code (a squelch opening was heard; nothing was decoded).
	 */
	| "heard"
	/** WG12: the analog replay trial heard a data-like signal and no digital trial decoded. */
	| "data-like"
	/** WG12: the analog replay trial heard a carrier and neither voice nor data. */
	| "carrier-only"
export interface ScannerIdentifyTrial {
	protocol: ScannerProtocol
	/** The decoder that runs the trial or, for an `unsupported` one, would run it; null when none exists (`no-decoder`). */
	decoder:
		| "dsd-fme"
		| "multimon-ng"
		| "direwolf"
		| "rtl433"
		| ScannerAmbientDecoderType
		/** WG10 req 3.2: analog evidence from the live demodulator's closed transmissions. */
		| "live-audio"
		/** WG12: the analog replay trial (`wavekit-iqcap analyze` plus CTCSS/DCS). */
		| "analog-demod"
		| null
	/** dsd-fme mode (`auto`, `nxdn`, `nxdn48`, `dpmr`) or the decoder name; null for an `unsupported` trial. */
	mode: string | null
	/**
	 * WG7: `ambient` = evidence of a decoder already running there (no probe). WG11 req 6.6:
	 * `replay` = a probe decoder fed from a narrowband IQ capture of the target.
	 */
	transport: "offset" | "channel" | "ambient" | "replay" | null
	outcome: ScannerTrialOutcome
	/**
	 * Why an `unsupported` trial cannot run. WG7: `no-ambient-decoder` for an ambient-only protocol
	 * nobody decodes there. WG9: `decoder-unavailable` when the trial's decoder program could not
	 * run (missing or not executable) before it produced any output; the outcome stays
	 * `unsupported` so clients with a closed outcome list keep parsing. WG10: `no-live-audio` for
	 * an analog trial when live audio was not running or not tuned to the target for the whole
	 * window; `decoder-unavailable` also when the probe pool remembers the decoder type as
	 * unavailable (PROBE_UNAVAILABLE_MEMO_MS) and the trial is not spawned. `adsb-window` for a
	 * protocol the request names explicitly inside the ADS-B window (1089 to 1091 MHz), where only
	 * readsb is eligible: listed, never run.
	 */
	reason?:
		| "no-decoder"
		| "needs-channelizer"
		| "unsupported-format"
		| "no-ambient-decoder"
		| "decoder-unavailable"
		| "no-live-audio"
		| "adsb-window"
}
/** WG7 req 1.2: decoder types whose running instances name ambient-only protocols. */
export type ScannerAmbientDecoderType =
	| "ais-catcher"
	| "acarsdec"
	| "dumpvdl2"
	| "lora-meshtastic"
	| "readsb"
/** WG7 req 1.1: protocols identify names only from ambient evidence (no probe decoder). */
export const SCANNER_AMBIENT_PROTOCOLS: readonly ScannerProtocol[] =
	Object.freeze(["ais", "acars", "vdl2", "lora", "adsb"])
/** WG7 req 1.2: the ambient-only protocol each decoder type names. */
export const SCANNER_AMBIENT_DECODER_PROTOCOL: Readonly<
	Record<ScannerAmbientDecoderType, ScannerProtocol>
> = Object.freeze({
	"ais-catcher": "ais",
	acarsdec: "acars",
	dumpvdl2: "vdl2",
	"lora-meshtastic": "lora",
	readsb: "adsb",
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
/** WG10 req 3.1: closed live-audio transmissions considered per identify target (oldest dropped). */
export const IDENTIFY_ANALOG_MAX_TRANSMISSIONS = 32
/** WG10 req 3.1: a transmission that ended this long before the job started still counts. */
export const IDENTIFY_ANALOG_LOOKBACK_MS = 30_000
/** WG10 req 3.5: how long the probe pool remembers a decoder type whose program could not run. */
export const PROBE_UNAVAILABLE_MEMO_MS = 300_000
/** WG10 req 3.5: probe decoder types `decodersUnavailable` can name. */
export const SCANNER_PROBE_DECODER_TYPES = [
	"dsd-fme",
	"multimon-ng",
	"direwolf",
	"rtl433",
	// Replay-only IQ capture consumers.
	"acarsdec",
	"dumpvdl2",
	"lora-meshtastic",
] as const
export type ScannerProbeDecoderType =
	(typeof SCANNER_PROBE_DECODER_TYPES)[number]
/**
 * WG10 req 3.4: analog evidence for an identify target, from the live demodulator's closed
 * transmissions within the target's tolerance. Only what the transmission tracker reported.
 */
export interface ScannerIdentifyAnalog {
	source: "live-audio"
	modulation: "nfm" | "wfm" | "am" | "dsb"
	/** Matching closed transmissions (at most IDENTIFY_ANALOG_MAX_TRANSMISSIONS). */
	transmissions: number
	/** The latest matching transmission (the `live-audio:transmission` id). */
	transmissionId: string
	/** One of the 50 standard CTCSS tones heard on the latest tone-bearing match, or null. */
	ctcssHz: number | null
	/** DCS code heard (WG6 polarity rules), or null. */
	dcs: { code: string; polarity: "normal" | "inverted" } | null
	/** Tuning trust of the latest matching transmission's frequency. */
	tuningTrust: TuningTrust
}
export interface ScannerIdentifyResult {
	/** Target is a canonical decode anchor; no trial was needed. */
	alreadyDecoded?: string
	/** Fixed summary of the target evidence. Absent on older cores. */
	proof?: ScannerProof
	/** Spectral class derived from target measurements, never decoder text. */
	hint?: string
	protocol?: ScannerProtocol
	confidence: ScannerConfidence
	identity?: Identity
	metadata: DiscoveryMetadata
	discoveryId?: string
	observationId?: string
	measurements: ScannerIdentifyMeasurements
	artefact?: ScannerArtefactKind
	/**
	 * The target ended early. `window-moved`: the tuned window moved off it (retune, sweep
	 * takeover); open trials are `cancelled`. `no-signal`: `waitUntilSignal` elapsed with no
	 * gated transmission (WG12).
	 */
	ended?: "window-moved" | "no-signal"
	/** WG10 req 3.4: present when a closed live-audio transmission matched the target. */
	analog?: ScannerIdentifyAnalog
	/** WG10 req 3.5: probe decoder types that could not run during this job (sorted, unique); absent when none. */
	decodersUnavailable?: ScannerProbeDecoderType[]
	/**
	 * Why "nothing" was withheld: the centre of a live track within 12 500 Hz of the target that did
	 * not resolve it, or of the strongest bin at the target at or above the block threshold.
	 */
	nearbyHz?: number
}
/** `scanner:identify` (one stream per target; `all: true` gives one per surfaced emission). */
export interface ScannerIdentifyEventData {
	jobId: string
	targetHz: number
	state: ScannerIdentifyState
	trials: ScannerIdentifyTrial[]
	result?: ScannerIdentifyResult
	/** The answer in one closed code, once the target is final. Absent on older cores and while it runs. */
	verdict?: ScannerIdentifyVerdict
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

/** Every `ScannerTrialOutcome`, for clients and for tests that must cover them all. */
export const SCANNER_TRIAL_OUTCOMES = [
	"pending",
	"running",
	"decoded",
	"no-sync",
	"crc-errors",
	"timeout",
	"skipped-budget",
	"unsupported",
	"not-needed",
	"cancelled",
	"heard",
	"data-like",
	"carrier-only",
] as const satisfies readonly ScannerTrialOutcome[]
/** Compile-time check: fails when `ScannerTrialOutcome` gains a member the list lacks. */
export const SCANNER_TRIAL_OUTCOMES_COMPLETE: [ScannerTrialOutcome] extends [
	(typeof SCANNER_TRIAL_OUTCOMES)[number],
]
	? true
	: never = true

/**
 * `decoded`: a confirmed identity that met acceptance. `heard-digital-unconfirmed`: a lone sync or
 * one decode, never `decoded`. `undecodable`: a signal is there and the trials found nothing.
 * `nothing`: IQ blocks kept arriving, the target measured below the block threshold and no live
 * track sat near it. `could-not-test`: see `SCANNER_IDENTIFY_VERDICT_WHY`.
 */
export const SCANNER_IDENTIFY_VERDICT_CODES = [
	"decoded",
	"heard-digital-unconfirmed",
	"undecodable",
	"nothing",
	"could-not-test",
] as const
export type ScannerIdentifyVerdictCode =
	(typeof SCANNER_IDENTIFY_VERDICT_CODES)[number]

/** Why a target `could-not-test`. `unknown` is the safe answer to anything unrecognised. */
export const SCANNER_IDENTIFY_VERDICT_WHY = [
	"budget",
	"unsupported-protocol",
	"unsupported-format",
	"decoders-unavailable",
	"no-live-audio",
	"window-moved",
	"source-lost",
	"cancelled",
	"interrupted",
	"artefact",
	"unknown",
	"no-samples",
	"signal-nearby",
] as const
export type ScannerIdentifyVerdictWhy =
	(typeof SCANNER_IDENTIFY_VERDICT_WHY)[number]

export interface ScannerIdentifyVerdict {
	code: ScannerIdentifyVerdictCode
	/** Present only on `could-not-test`. */
	why?: ScannerIdentifyVerdictWhy
	/** What was decoded or heard; otherwise the one protocol the request named, when it named one. */
	protocol?: ScannerProtocol
	/**
	 * Only on `decoded`: this job heard one decode, and the match that confirms it came 2 s to 5 min
	 * earlier, before this job (another request, or a passive or scan probe, on this signal). Absent: both decodes,
	 * or a single-shot rule, in this job.
	 */
	confirmedAcrossJobs?: true
	/**
	 * Only on `heard-digital-unconfirmed` and `undecodable`: live audio heard a transmission at the
	 * target. A lone digital sync over voice is usually the voice.
	 */
	analogHeard?: true
}
