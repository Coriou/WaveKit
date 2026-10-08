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

/** Rates in Hz in one explicitly named domain, never inferred from legacy preferences. */
export type DecoderRateSet =
	| { kind: "discrete"; valuesHz: number[] }
	| { kind: "range"; minHz: number; maxHz?: number; stepHz?: number }

/** Instance requirements; capture rates and program stdin rates are distinct. */
export interface DecoderRateRequirements {
	version: 1
	sourceKind: DecoderInputType
	capture?: {
		accepted: DecoderRateSet[]
		preferredHz: number[]
		minimum?: {
			hz: number
			basis: "implementation" | "verified-rf"
			evidence: string
		}
	}
	frontendIq?: { preferredHz: number; accepted: DecoderRateSet[] }
	decoderInput: {
		kind: DecoderInputType
		format?: string
		preferredHz?: number
		accepted?: DecoderRateSet[]
	}
}

/** Reporting only: this verdict does not start, stop, or suspend a decoder. */
export interface DecoderRateAssessment {
	verdict: "best" | "acceptable" | "unusable" | "unknown"
	sourceKind?: DecoderInputType
	sourceRateHz?: number
	frontendRateHz?: number
	decoderInputKind?: DecoderInputType
	decoderInputRateHz?: number
	adaptation?: "none" | "integer-decimation" | "resample"
	reasonCode?:
		| "insufficient-sample-rate"
		| "unsupported-sample-rate"
		| "unsupported-input-kind"
		| "unsupported-input-format"
		| "unsupported-frontend-rate"
		| "unsupported-decoder-input-rate"
		| "unknown-requirements"
		| "source-rate-unknown"
		| "adaptation-unknown"
		| "external-input"
	requiredMinimumHz?: number
	requirementBasis?: "implementation" | "verified-rf"
}

export interface DecoderCaps {
	input: DecoderInputType
	wantsExclusiveSource?: boolean
	preferredSampleRates?: number[]
	/** Optional declarations; absence means unknown, never incompatible. */
	rateRequirements?: DecoderRateRequirements
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
	rateAssessment?: DecoderRateAssessment
}

export interface DecoderOutput {
	type: string
	decoder: string
	timestamp: string
	data: unknown
}
