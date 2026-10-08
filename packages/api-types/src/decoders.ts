export interface DecoderStats {
	bytesIn: number
	eventsOut: number
	errors: number
}

/**
 * - running: running (or stopped by the operator; see `running`)
 * - idle: running without output for `idleTimeoutMs`
 * - restarting: exited unexpectedly; an automatic restart is scheduled at `nextRestartAt`
 * - faulted: crash loop (consecutive unstable runs) or restart budget exhausted.
 *   `running: true` = a crash-loop retry on probation (returns to "running"
 *   once it produces output or stays up 30 s); `nextRestartAt` set = waiting
 *   for the next retry; `!running && !nextRestartAt` = terminal until an
 *   explicit start/restart.
 */
export type DecoderHealth = "running" | "idle" | "restarting" | "faulted"

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

/** Upper bound on `DecoderLastError.message`, in UTF-16 code units. */
export const DECODER_LAST_ERROR_MAX_LENGTH = 512

/**
 * Most recent decoder failure. Retained across automatic restarts so a crash
 * loop keeps its cause visible; cleared only by an explicit start/restart
 * (the same moment `restartCount` resets to 0). An "error" recorded during a
 * run is not replaced by the generic "exit" that ends that run.
 */
export interface DecoderLastError {
	/** "error": the decoder emitted an error (spawn failure, socket error, failed start). "exit": the process exited without being asked to stop. */
	kind: "error" | "exit"
	/** Human-readable message, truncated to DECODER_LAST_ERROR_MAX_LENGTH with a trailing "…". */
	message: string
	/** ISO-8601 time the failure was recorded. */
	at: string
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
	/**
	 * WaveKit source this decoder reads: the live assignment while wired,
	 * otherwise the configured `sourceId`. Absent for external-input decoders
	 * (they own their device) and for unwired decoders that use the default source.
	 */
	sourceId?: string
	/** Configured device serial of an external-input decoder; never inferred. */
	deviceSerial?: string
	/** Configured target frequencies in Hz; absent when the config declares none. */
	targetFrequenciesHz?: number[]
	/** Most recent failure; see DecoderLastError for retention semantics. */
	lastError?: DecoderLastError
	/** Effective ms without output before `health` becomes "idle". */
	idleTimeoutMs?: number
	/** ISO-8601 time of the scheduled automatic restart; present only while one is pending. */
	nextRestartAt?: string
}

/** GET /api/decoders item and `decoder:status` WebSocket payload. */
export interface DecoderInfo extends DecoderStatus {
	caps?: DecoderCaps
}

export interface DecoderOutput {
	type: string
	decoder: string
	timestamp: string
	data: unknown
}
