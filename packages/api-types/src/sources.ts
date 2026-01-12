export type SourceKind = "audio_pcm" | "iq" | "recording"

export type SourceFormat = "S16LE" | "FLOAT32LE" | "U8_IQ" | "S16_IQ" | "auto"

export interface SourceCaps {
	kind: SourceKind
	sampleRate: number
	format: SourceFormat
	channels?: number
	centerFreq?: number
	exclusive: boolean
}

export interface SourceStatus {
	id: string
	type?: string
	url?: string
	connected: boolean
	consumers?: number
	bytesReceived?: number
	dataRate?: number
	lastError?: string
	reconnectAttempts?: number
	caps?: SourceCaps
}

export interface DecoderAssignment {
	decoderId: string
	sourceId: string
	assignedAt: string
}

export interface ExtendedSourceStatus extends SourceStatus {
	assignments: DecoderAssignment[]
	consumers: number
	available: boolean
	caps: SourceCaps
	bytesReceived: number
	dataRate: number
	reconnectAttempts: number
}
