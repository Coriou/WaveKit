export type TunerRelayControlPolicy = "exclusive" | "shared"

export interface TunerRelayCommandStat {
	id: number
	name: string
	count: number
	lastValue: number
	lastSeenAt: string
}

export interface TunerRelayCommandHistoryEntry {
	id: number
	name: string
	value: number
	at: string
	clientId?: string
	clientRemote?: string
}

export interface RtlTcpHeaderInfo {
	magic: string
	tunerType: number
	gainCount: number
}

export interface TunerRelayStatus {
	enabled: boolean
	listening: boolean
	host: string
	port: number
	sourceId?: string
	sourceConnected?: boolean
	sourceKind?: string
	sourceFormat?: string
	compatibility?:
		| "ok"
		| "missing-source"
		| "unsupported-type"
		| "unsupported-kind"
		| "unsupported-format"
	compatibilityMessage?: string
	clientsConnected: number
	controlClientId?: string
	controlClientRemote?: string
	controlPolicy: TunerRelayControlPolicy
	maxClients?: number
	bytesSent: number
	bytesReceived: number
	lastCommand?: string
	lastCommandAt?: string
	lastCommandValue?: number
	lastFrequency?: number
	lastSampleRate?: number
	lastGain?: number
	lastPpm?: number
	commandHistoryLimit?: number
	commandStats?: TunerRelayCommandStat[]
	commandHistory?: TunerRelayCommandHistoryEntry[]
	lastError?: string
	rtlTcpHeader?: RtlTcpHeaderInfo
}

// Tuner control types (for TunerController)
export type TunerGainMode = "manual" | "agc"
export type TunerDirectSampling = "off" | "i" | "q"
export type TunerControlMode = "internal" | "external"

/**
 * Always-present TunerState fields whose value can be a placeholder: rtl_tcp
 * has no readback, so the core only knows what it commanded, what it saw a
 * relay client command, or (frequency, sampleRate) what the config declares.
 */
export type TunerStateField =
	| "frequency"
	| "sampleRate"
	| "gainMode"
	| "gain"
	| "ppm"
	| "agcMode"
	| "biasTee"
	| "directSampling"
	| "offsetTuning"
	| "ifGain"
	| "tunerIfGain"
	| "testMode"

export interface TunerState {
	ratePolicy?: TunerRatePolicy
	sourceId: string
	frequency: number // Hz
	sampleRate: number // Hz
	gainMode: TunerGainMode
	gain: number // 0.1 dB units (0-500)
	ppm: number // PPM correction
	agcMode: boolean // RTL2832 AGC
	biasTee: boolean // Bias-T power
	directSampling: TunerDirectSampling
	offsetTuning: boolean
	ifGain: number
	tunerIfGain: { stage: number; gain: number } | null
	testMode: boolean
	rtlXtal?: number
	tunerXtal?: number
	tunerGainIndex?: number
	controlMode: TunerControlMode // "internal" = WaveKit controls, "external" = SDR++ controls
	lastCommandAt?: string
	/** Who made the last change, and why (see TunerLastChange). */
	lastChange?: TunerLastChange
	lastError?: string
	commandCount: number
	/**
	 * Fields whose value above is a placeholder the core never commanded or
	 * observed (e.g. gain set on the SDR host): render them as unknown.
	 * Absent when every field is known.
	 */
	unknownFields?: TunerStateField[]
	/**
	 * WG5: `frequency`/`sampleRate` whose value above comes only from the configured
	 * baseline (tuner config or source caps): never written by WaveKit nor seen from a
	 * relay client since the start or the last reset reconnect. The receiver may be
	 * elsewhere (rtlmux replays relay-set values), so it proves nothing. Absent when empty.
	 */
	declaredOnlyFields?: TunerStateField[]
	/**
	 * Fields listed in `unknownFields` whose value above is measured from the stream rather than
	 * last known: today only `sampleRate`, after a plain resume of a paused feed adopted the rate
	 * the receiver is measured to deliver. Still unverified (nothing wrote it). Absent when empty
	 * and from older cores.
	 */
	measuredFields?: TunerStateField[]
	/**
	 * Per-band gain: present only while a band gain is confirmed on the tuner, i.e. the core
	 * wrote it (or found it already there) for the current frequency and the tuner's known
	 * gain mode is manual with exactly this gain. Cleared by any later gain, gain mode or
	 * frequency write, the scanner's restore, a relay client taking control, or the gain
	 * becoming unknown. `tenthsDb` is the value written (snapped to the tuner's step).
	 */
	bandGain?: TunerBandGain
	/**
	 * The temporary tune of this source (POST /api/tuner/:sourceId/tune with `restoreAfterS`): the
	 * one pending, or how the last one ended. In memory; gone with the source or a core restart.
	 */
	restore?: TuneRestore
	/** How the last POST /api/tuner/:sourceId/tune ended, for a client that lost its answer. */
	lastTune?: TunerLastTune
}

/**
 * The settings of POST /api/tuner/:sourceId/tune, in the order they are written: the rate first
 * (the receiver restarts on it), then the centre, then the gain. `applied` and `notApplied` name
 * them. `sampleRateHz` and `frequencyHz` set `sampleRate` and `frequency` of GET /api/tuner.
 */
export const TUNE_SETTINGS = [
	"sampleRateHz",
	"frequencyHz",
	"gainMode",
	"gain",
] as const
export type TuneSetting = (typeof TUNE_SETTINGS)[number]

/**
 * Longest `restoreAfterS`: one hour, far under what a timer can hold (3,600,000 ms against
 * 2^31 − 1 ms, about 24.8 days). Each source holds one restore, so the memory is bounded by the
 * sources whatever the value.
 */
export const TUNE_RESTORE_MAX_S = 3_600

/** Body of POST /api/tuner/:sourceId/tune. At least one setting; `restoreAfterS` is not one. */
export interface TuneRequest {
	sampleRateHz?: number
	frequencyHz?: number
	gainMode?: TunerGainMode
	/** Tenths of a dB (0-500), as `gain` in GET /api/tuner. */
	gain?: number
	/** Integer seconds, 1 to TUNE_RESTORE_MAX_S: put the prior tuning back after this long. */
	restoreAfterS?: number
	/**
	 * Take the tuner from a scanner job holding its lease, whenever the lease came. Without it such
	 * a tune answers 409 TUNER_LEASE_HELD and writes nothing, or nothing more if it was mid-way.
	 */
	preempt?: boolean
}

/**
 * Most waiters a tune's answer names, the soonest first: each is about 100 bytes of a small answer
 * (8 x 100 B = under 1 KiB), and a source running more waiting jobs than this is not a real setup.
 */
export const TUNE_WAITERS_MAX = 8

/** A job waiting for the tuner a tune took, able to take it once the tuner is idle. */
export interface TunePreemptionWaiter {
	jobId: string
	jobName: string | null
	/** How long after the last operator write it may take the tuner; activity can hold it longer. */
	autoAfterIdleMs: number
}

/** What a tune with `preempt: true` did to the scanner job that held the tuner's lease. */
export interface TunePreemption {
	jobId: string
	jobName: string | null
	/** `paused`: its own resume rules apply. `failed`: it was still starting. */
	job: "paused" | "failed"
	/**
	 * The job's `resume.autoAfterIdleMs`: it resumes by itself this long after the last operator
	 * write, whatever a `restoreAfterS` says. Null: it stays paused until someone resumes it.
	 */
	autoAfterIdleMs: number | null
	/**
	 * Other jobs that can take this tuner while you are on it, at most TUNE_WAITERS_MAX: the job
	 * above is not the only thing that can move the receiver. Empty when none can.
	 */
	waiters: TunePreemptionWaiter[]
	/** The same in a sentence, with what to do next. */
	message: string
}

/** What became of a temporary tune's restore (`TunerState.restore.status`). */
export const TUNE_RESTORE_STATUSES = [
	"pending",
	"restoring",
	"restored",
	"cancelled",
	"failed",
] as const
export type TuneRestoreStatus = (typeof TUNE_RESTORE_STATUSES)[number]

/** Why a restore was cancelled (`TunerState.restore.cancelledBy.reason`). */
export const TUNE_RESTORE_CANCEL_REASONS = [
	"tuner-write",
	"state-changed",
	"external-control",
	"cancel-request",
	"scanner-lease",
	"scanner-preempted",
] as const
export type TuneRestoreCancelReason =
	(typeof TUNE_RESTORE_CANCEL_REASONS)[number]

/** The prior tuning a restore writes; a field the core did not know then is absent. */
export interface TuneRestoreTuning {
	sampleRate?: number
	frequency?: number
	gainMode?: TunerGainMode
	gain?: number
}

export interface TuneRestore {
	/** ISO time the restore is or was due. */
	at: string
	status: TuneRestoreStatus
	state: TuneRestoreTuning
	/** Who ended it, once cancelled. A cancelled restore never comes back. */
	cancelledBy?: {
		actor: TunerChangeActor
		reason: TuneRestoreCancelReason
		at: string
		/** The scanner job, on `scanner-lease` and `scanner-preempted`, when the core can name it. */
		job?: { jobId: string; jobName: string | null }
	}
	/** The settings back at their prior value; on a cancel or a failure, those before it stopped. */
	restored?: TuneSetting[]
	/** The error code of a failed restore. It is not retried. */
	failure?: string
}

export interface TunerLastTune {
	at: string
	usable: boolean
	applied: TuneSetting[]
	notApplied: TuneSetting[]
	/** The error code of a tune that did not fully apply. */
	code?: string
	/** The scanner job this tune took the tuner from. */
	preempted?: TunePreemption
}

/** 200 of POST /api/tuner/:sourceId/tune: the new tuner state, usable, every setting applied. */
export type TuneResponse = TunerState & {
	usable: true
	applied: TuneSetting[]
	notApplied: []
	/** The scanner job this tune took the tuner from (`preempt: true` with a lease held). */
	preempted?: TunePreemption
}

/** The band gain on the tuner (TunerState.bandGain). */
export interface TunerBandGain {
	/** Tenths of a dB, as written (snapped to the tuner's nearest supported step). */
	tenthsDb: number
	/** The band entry's label, when it has one. */
	label?: string
	/** "scanner": a scanner hop, dwell or job; "user": an operator retune ("apply to my tuning"). */
	owner: TunerBandGainOwner
}
export type TunerBandGainOwner = "scanner" | "user"

// API request/response types
export interface SetFrequencyRequest {
	hz: number
}
/**
 * POST /api/tuner/:sourceId/gain. Send exactly one field: `gain` (tenths of a dB, the same
 * name and unit as TunerState.gain) or the deprecated alias `tenthsDb`. Both present with
 * different values is a 400.
 */
export interface SetGainRequest {
	gain?: number
	/** @deprecated Use `gain` (same unit). */
	tenthsDb?: number
}
export interface SetGainModeRequest {
	mode: TunerGainMode
}
export interface SetSampleRateRequest {
	hz: number
}
export interface SetPpmRequest {
	ppm: number
}
export interface SetBooleanRequest {
	enabled: boolean
}
export interface SetDirectSamplingRequest {
	mode: TunerDirectSampling
}
export interface SetControlModeRequest {
	mode: TunerControlMode
}
export interface SetIfGainRequest {
	gain: number
}
export interface SetTunerIfGainRequest {
	stage: number
	gain: number
}
export interface SetTunerGainIndexRequest {
	index: number
}
export interface SetXtalRequest {
	hz: number
}
export interface TunerConfigUpdate extends Partial<
	Omit<
		TunerState,
		| "sourceId"
		| "lastCommandAt"
		| "lastError"
		| "commandCount"
		| "unknownFields"
		| "declaredOnlyFields"
		| "measuredFields"
	>
> {}

/**
 * Who issued a tuner write: the REST API, the scanner, or reconnect replay. WG11 req 4.2:
 * `config` = the source's configured gain, gain mode or AGC written on a new connection.
 */
export type TunerCommandOrigin =
	| "rest"
	| "scanner"
	| "replay"
	| "config"
	| "decoder-rate"

/**
 * Who made a tuner's last change (`TunerState.lastChange`). Set by the core, never by a client:
 * `web` a browser session, `agent` a machine token, `scanner-job` a scanner job's tuner lease,
 * `restore` the core putting tuning back (after a scanner lease, after a temporary tune, or replay
 * on reconnect),
 * `config` the source's configured tuning, `decoder-rate` the decoder rate policy, `relay` an
 * external client through the tuner relay. `unknown`: a REST write on a core without access
 * protection (no principal to tell who), or an untagged write.
 */
export const TUNER_CHANGE_ACTORS = [
	"web",
	"agent",
	"scanner-job",
	"restore",
	"config",
	"decoder-rate",
	"relay",
	"unknown",
] as const
export type TunerChangeActor = (typeof TUNER_CHANGE_ACTORS)[number]

/** Why a tuner's last change happened (`TunerState.lastChange.reason`). */
export const TUNER_CHANGE_REASONS = [
	"rest-command",
	"scanner-hop",
	"scanner-restore",
	"tune-restore",
	"reconnect-replay",
	"source-config",
	"decoder-rate",
	"relay-command",
	"unknown",
] as const
export type TunerChangeReason = (typeof TUNER_CHANGE_REASONS)[number]

/** The tuner fields a change can name. */
export const TUNER_CHANGE_FIELDS = [
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
	"ppm",
	"ifGain",
	"testMode",
	"agcMode",
	"directSampling",
	"offsetTuning",
	"rtlXtal",
	"tunerXtal",
	"tunerGainIndex",
	"biasTee",
	"tunerIfGain",
] as const
export type TunerChangeField = (typeof TUNER_CHANGE_FIELDS)[number]

/**
 * The last change the core wrote or saw on a tuner: one per source, in memory, absent until the
 * first one since the core started. Writes of one actor, reason and job within a second extend
 * `fields` (a hop writes rate, centre and gain in a row), so `fields` holds each closed field at
 * most once. A scanner settle marker (test mode on and off) is no change.
 */
export interface TunerLastChange {
	actor: TunerChangeActor
	reason: TunerChangeReason
	at: string
	fields: TunerChangeField[]
	/** The job whose lease moved the tuner; only on `scanner-job` and scanner `restore` changes. */
	jobId?: string
}

/** `tuner:command-sent` on the `tuner` channel. */
export interface TunerCommandSentEventData {
	sourceId: string
	command: string
	value: number
	/** Absent for writes whose origin is not tagged. */
	origin?: TunerCommandOrigin
}

export interface TunerRatePolicy {
	raisedFromHz: number
	since: string
}
export interface LinkAdvisory {
	burst?: LinkBurstSummary
	level: "none" | "unproven" | "dropping"
	transport: "loopback" | "network"
	payloadBytesPerSecond: number
	sustainedBytesPerSecond: number | null
	shortfallPercent: number | null
	upstreamDropBytesPerSecond: number | null
	/**
	 * Why samples were lost; absent when none were. `source`: bytes never
	 * reached the core (a received-rate shortfall, or receiver-side drops);
	 * only this makes `level` `dropping`. `branch-congestion`: every byte
	 * arrived and a core fanout branch dropped them after an arrival gap (a
	 * `link` drop attribution caused by internal congestion); `level` stays
	 * as the link itself reads.
	 */
	lossReason?: "source" | "branch-congestion"
}
export interface TunerRatePolicyEventData {
	sourceId: string
	action: "raised" | "restored" | "skipped"
	reason: "adsb-1090"
	fromHz: number
	toHz: number
	skipped?: "external-control" | "rate-above" | "write-failed"
	link?: LinkAdvisory
}

export interface LinkBurstSummary {
	worstStallMs: number | null
	overflowedBytes10m: number
	burstSeconds: number
}

// === Per-band gain (GET/PUT /api/tuner-band-gain) ===

/** A band's gain: tenths of a dB (0-500), or "keep" to leave the current gain alone. */
export type BandGainValue = number | "keep"

/** One entry of the band gain table. The range is inclusive at both ends. */
export interface BandGainEntry {
	minHz: number
	maxHz: number
	gain: BandGainValue
	/** Display name only (at most BAND_GAIN_LABEL_MAX_LENGTH characters). */
	label?: string
}

export interface BandGainSettings {
	/**
	 * When true, an operator retune (REST frequency or config) also applies the band gain.
	 * When false (the default), only scanner hops, dwells and jobs apply it.
	 */
	applyToMyTuning: boolean
	/** At most BAND_GAIN_MAX_ENTRIES entries; ranges never overlap. */
	entries: BandGainEntry[]
}

/**
 * Bounds of the band gain table. 32 entries: an RTL-SDR covers 24 MHz-1.9 GHz, and the bands
 * that warrant their own gain (ISM 433/868/915, ADS-B, 2 m, 70 cm, airband, marine, pagers,
 * broadcast FM, ...) number about 20, so 32 leaves headroom while one hop's lookup stays a
 * linear scan of at most 32 range checks. Frequencies span the tuner's write range; gains span
 * the tuner gain write range (0-500 tenths, 0-50 dB).
 */
export const BAND_GAIN_MAX_ENTRIES = 32
export const BAND_GAIN_MIN_HZ = 24_000_000
export const BAND_GAIN_MAX_HZ = 1_900_000_000
export const BAND_GAIN_MIN_TENTHS_DB = 0
export const BAND_GAIN_MAX_TENTHS_DB = 500
export const BAND_GAIN_LABEL_MAX_LENGTH = 48

/** GET /api/tuner-band-gain and the PUT response. */
export interface BandGainSettingsView {
	settings: BandGainSettings
	/** "config": the YAML `tuner.bandGain` section; "runtime": the persisted PUT override. */
	provenance: "config" | "runtime"
	limits: {
		maxEntries: number
		minHz: number
		maxHz: number
		minGainTenthsDb: number
		maxGainTenthsDb: number
		labelMaxLength: number
	}
}
