export type SourceKind = "audio_pcm" | "iq" | "recording"

export type SourceFormat = "S16LE" | "FLOAT32LE" | "U8_IQ" | "S16_IQ" | "auto"

export interface SourceActivity {
	state: "disconnected" | "waiting" | "streaming" | "stale" | "paused" | "ended"
	lastSampleAt: string | null
	sampleAgeMs: number | null
	timeoutMs: number
}

export const sourceActivitySchema = {
	type: "object",
	properties: {
		state: {
			type: "string",
			enum: [
				"disconnected",
				"waiting",
				"streaming",
				"stale",
				"paused",
				"ended",
			],
		},
		lastSampleAt: { type: ["string", "null"], format: "date-time" },
		sampleAgeMs: { type: ["number", "null"], minimum: 0 },
		timeoutMs: { type: "number", minimum: 0 },
	},
	required: ["state", "lastSampleAt", "sampleAgeMs", "timeoutMs"],
} as const

/**
 * Present only while the measured byte rate has differed from
 * `caps.sampleRate` × bytes per sample by more than 2 % for at least 30 s.
 * Warning only: caps are never corrected from it. Positive `deviation` means
 * faster than declared (e.g. an external client changed the dongle rate);
 * negative can also be delivery loss upstream.
 */
export interface SourceRateMismatch {
	declaredSampleRateHz: number
	/** Mean measured rate over the current mismatching run. */
	measuredSampleRateHz: number
	/** measured / declared − 1 */
	deviation: number
	/** ISO-8601: when this mismatching run was first observed. */
	since: string
}

export const sourceRateMismatchSchema = {
	type: "object",
	properties: {
		declaredSampleRateHz: { type: "number" },
		measuredSampleRateHz: { type: "number" },
		deviation: { type: "number" },
		since: { type: "string", format: "date-time" },
	},
	required: [
		"declaredSampleRateHz",
		"measuredSampleRateHz",
		"deviation",
		"since",
	],
} as const

/**
 * Present only while the subsampled IQ level of an IQ network source
 * (U8_IQ / S16_IQ) has stayed below `thresholdDbfs` for the hold time
 * (default −40 dBFS for 30 s), e.g. an external client left the dongle at
 * near-zero gain. Cleared after the same time at threshold + 3 dB or more.
 * Warning only.
 */
export interface SourceSignalFlat {
	/** Latest interval level (RMS of the IQ components about zero, dBFS). */
	levelDbfs: number
	thresholdDbfs: number
	/** ISO-8601: when this low-level run was first observed. */
	since: string
}

export const sourceSignalFlatSchema = {
	type: "object",
	properties: {
		levelDbfs: { type: "number" },
		thresholdDbfs: { type: "number" },
		since: { type: "string", format: "date-time" },
	},
	required: ["levelDbfs", "thresholdDbfs", "since"],
} as const

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
	/** Local sample delivery freshness; independent of transport and assignment capacity. */
	activity?: SourceActivity
	consumers?: number
	bytesReceived?: number
	dataRate?: number
	lastError?: string
	reconnectAttempts?: number
	caps?: SourceCaps
	/** Rate-truth check; see SourceRateMismatch. */
	rateMismatch?: SourceRateMismatch
	/** Signal-flat check; see SourceSignalFlat. */
	signalFlat?: SourceSignalFlat
	/** Latest measured IQ level (dBFS, 5 s mean); IQ network sources with data only. */
	signalLevelDbfs?: number
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
