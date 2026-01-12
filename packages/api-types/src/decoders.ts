export interface DecoderStats {
	bytesIn: number
	eventsOut: number
	errors: number
}

export type DecoderHealth = "running" | "idle" | "faulted"

export type DecoderInputType = "audio_pcm" | "iq" | "external"

export type DecoderOutputFormat = "jsonl" | "nmea" | "beast" | "text"

export type DecoderIntegrationPattern =
	| "pure_consumer"
	| "network_producer"
	| "external_sdr"

export interface DecoderCaps {
	input: DecoderInputType
	wantsExclusiveSource?: boolean
	preferredSampleRates?: number[]
	output: DecoderOutputFormat
	integrationPattern: DecoderIntegrationPattern
}

export interface DecoderStatus {
	id: string
	type: string
	running: boolean
	health: DecoderHealth
	pid?: number
	uptime: number
	stats: DecoderStats
	lastOutputAt?: string | null
	restartCount: number
	version?: string
}

export interface DecoderOutput {
	type: string
	decoder: string
	timestamp: string
	data: unknown
}
