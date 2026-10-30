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
}

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
