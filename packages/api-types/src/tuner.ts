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

export interface TunerState {
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
	Omit<TunerState, "sourceId" | "lastCommandAt" | "lastError" | "commandCount">
> {}
