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
