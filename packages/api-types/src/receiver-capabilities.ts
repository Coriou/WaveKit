/** Read-only evidence, not receiver support or command acknowledgement. */
export type ReceiverControlId =
	| "frequency"
	| "sampleRate"
	| "gainMode"
	| "gain"
	| "ppm"
	| "ifGain"
	| "testMode"
	| "agcMode"
	| "directSampling"
	| "offsetTuning"
	| "rtlXtal"
	| "tunerXtal"
	| "gainIndex"
	| "biasTee"
	| "tunerIfGain"

export type ReceiverControlUnit =
	| "Hz"
	| "enum"
	| "tenthsDb"
	| "ppm"
	| "rawInteger"
	| "boolean"
	| "index"
	| "stageRawPair"

export type ReceiverCommandValidation =
	| {
			readonly kind: "integer-range"
			readonly min: number
			readonly max: number
	}
	| {
			readonly kind: "integer-ranges"
			readonly ranges: readonly [
				{ readonly min: number; readonly max: number },
				{ readonly min: number; readonly max: number },
			]
	}
	| { readonly kind: "enum"; readonly values: readonly string[] }
	| { readonly kind: "boolean" }
	| { readonly kind: "uint16-pair" }

export interface ReceiverControlEvidence {
	readonly id: ReceiverControlId
	readonly unit: ReceiverControlUnit
	readonly command: {
		readonly state: "implemented"
		readonly opcode: number
		readonly validation: {
			readonly authority: "admitted-rest-argument-policy"
			readonly rule: ReceiverCommandValidation
		}
	}
	readonly transport:
		| { readonly state: "applicable"; readonly reason: "rtl-tcp" }
		| { readonly state: "not-applicable"; readonly reason: "non-rtl-transport" }
	readonly physical: {
		readonly state: "unknown"
		readonly reason: "no-qualified-readback"
	}
	readonly currentValue: {
		readonly state: "unknown"
		readonly reason: "session-qualified-command-evidence-not-provided"
	}
}

export type ReceiverHeaderEvidence =
	| {
			readonly state: "advertised"
			readonly provenance: "rtl-peer-header"
			readonly sessionId: string
			readonly observedAt: string
			readonly tunerType: number
			readonly gainCount: number
	}
	| {
			readonly state: "unknown"
			readonly reason:
				| "not-connected"
				| "awaiting-header"
				| "partial-header"
				| "invalid-header"
				| "format-not-captured"
	}
	| {
			readonly state: "not-applicable"
			readonly reason: "non-rtl-transport" | "non-iq-source"
	}

export interface ReceiverSourceDescription {
	readonly type: "rtl_tcp" | "sdrpp-network" | "recording"
	readonly kind: "iq" | "audio_pcm" | "recording"
	readonly format: "U8_IQ" | "S16_IQ" | "S16LE" | "FLOAT32LE" | "auto"
}

export interface ReceiverCapabilities {
	readonly schemaVersion: 1
	readonly sourceId: string
	readonly sourceIncarnation: string
	readonly sessionId: string | null
	readonly snapshotId: string
	readonly capturedAt: string
	readonly source: ReceiverSourceDescription
	readonly connection: "connecting" | "connected" | "disconnected" | "ended"
	readonly delivery: {
		readonly state:
			| "disconnected"
			| "waiting"
			| "streaming"
			| "stale"
			| "paused"
			| "ended"
		readonly lastSampleAt: string | null
		readonly sampleAgeMs: number | null
		readonly timeoutMs: number
	}
	readonly peerHeader: ReceiverHeaderEvidence
	readonly controls: readonly ReceiverControlEvidence[]
	readonly declaredStream: {
		readonly provenance: "source-config-or-core-metadata"
		readonly sampleRateHz: number
		readonly centerFrequencyHz: number | null
	}
}

export interface ReceiverCapabilitiesPage {
	readonly schemaVersion: 1
	readonly items: readonly ReceiverCapabilities[]
	readonly nextAfter: string | null
}

export type ReceiverCapabilitiesErrorCode =
	| "NOT_FOUND"
	| "UNAVAILABLE"
	| "FAILED"
	| "CONFLICT"
	| "LIMIT"
	| "INVALID_REQUEST"
	| "METHOD_NOT_ALLOWED"

export type ReceiverCapabilitiesError = {
	readonly error: "ReceiverCapabilitiesError"
} & (
	| {
			readonly code: "RECEIVER_CAPABILITIES_NOT_FOUND"
			readonly message: "Receiver source not found"
	}
	| {
			readonly code: "RECEIVER_CAPABILITIES_UNAVAILABLE"
			readonly message: "Receiver capabilities unavailable"
	}
	| {
			readonly code: "RECEIVER_CAPABILITIES_FAILED"
			readonly message: "Receiver capabilities provider failed"
	}
	| {
			readonly code: "RECEIVER_CAPABILITIES_CONFLICT"
			readonly message: "Receiver capabilities evidence conflict"
	}
	| {
			readonly code: "RECEIVER_CAPABILITIES_LIMIT"
			readonly message: "Receiver capabilities bound exceeded"
	}
	| {
			readonly code: "RECEIVER_CAPABILITIES_INVALID_REQUEST"
			readonly message: "Invalid receiver capabilities request"
	}
	| {
			readonly code: "RECEIVER_CAPABILITIES_METHOD_NOT_ALLOWED"
			readonly message: "Receiver capabilities method not allowed"
	}
)
