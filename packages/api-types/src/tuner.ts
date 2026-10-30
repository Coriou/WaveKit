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
export interface SetGainRequest {
	tenthsDb: number
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
