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

// prettier-ignore
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

// prettier-ignore
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
	readonly iqDelivery?: ReceiverIqDelivery
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
	/** WG6 (web-gaps-6 req 8): suggested sample rates; sent by WG6 cores. */
	readonly sampleRatePresets?: ReceiverSampleRatePresets
	/** WG7 (web-gaps-7 req 5): suggested tuner gain table; sent by WG7 cores. */
	readonly gainTable?: ReceiverGainTable
}

/**
 * WG6 req 8.1: RTL-SDR sample rates a client may offer. A suggestion inside the command's
 * validated ranges, not receiver evidence: no rate is claimed to work on the device.
 * The same list the CLI offers (cli/source/ui/tuner-edit.ts).
 */
export const RECEIVER_SAMPLE_RATE_PRESETS_HZ: readonly number[] = Object.freeze(
	[
		250_000, 1_024_000, 1_536_000, 1_792_000, 1_920_000, 2_048_000, 2_160_000,
		2_400_000, 2_560_000, 2_880_000, 3_200_000,
	],
)

/** WG6 req 8.1: presets on rtl_tcp sources; not-applicable on other transports. */
// prettier-ignore
export type ReceiverSampleRatePresets =
	| {
			readonly state: "suggested"
			readonly provenance: "wavekit-rtl-rate-presets"
			readonly valuesHz: readonly number[]
	}
	| {
			readonly state: "not-applicable"
			readonly reason: "non-rtl-transport"
	}

/** WG7 req 5.2: librtlsdr tuner names by the rtl_tcp header's tuner type (enum rtlsdr_tuner). */
export type RtlTunerName =
	| "unknown"
	| "E4000"
	| "FC0012"
	| "FC0013"
	| "FC2580"
	| "R820T"
	| "R828D"
export const RTL_TUNER_NAMES: readonly RtlTunerName[] = Object.freeze([
	"unknown",
	"E4000",
	"FC0012",
	"FC0013",
	"FC2580",
	"R820T",
	"R828D",
])
/**
 * WG7 req 5.2: the gain lists librtlsdr reports per tuner (`rtlsdr_get_tuner_gains` in
 * osmocom rtl-sdr src/librtlsdr.c: e4k_gains, fc0012_gains, fc0013_gains, r82xx_gains), in tenths
 * of dB, ascending; keyed by the rtl_tcp header's tuner type. The rtl_tcp header's gain count
 * is the length of that list. FC2580 (4) and unknown (0) report the single placeholder 0 and
 * have no table here. A suggestion matched on two advertised integers, not receiver evidence.
 */
// prettier-ignore
export const RTL_TUNER_GAIN_TABLES: Readonly<
	Partial<Record<number, { readonly tuner: RtlTunerName; readonly valuesTenthsDb: readonly number[] }>>
> = Object.freeze({
	1: Object.freeze({ tuner: "E4000", valuesTenthsDb: Object.freeze([-10, 15, 40, 65, 90, 115, 140, 165, 190, 215, 240, 290, 340, 420]) }),
	2: Object.freeze({ tuner: "FC0012", valuesTenthsDb: Object.freeze([-99, -40, 71, 179, 192]) }),
	3: Object.freeze({ tuner: "FC0013", valuesTenthsDb: Object.freeze([-99, -73, -65, -63, -60, -58, -54, 58, 61, 63, 65, 67, 68, 70, 71, 179, 181, 182, 184, 186, 188, 191, 197]) }),
	5: Object.freeze({ tuner: "R820T", valuesTenthsDb: Object.freeze([0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496]) }),
	6: Object.freeze({ tuner: "R828D", valuesTenthsDb: Object.freeze([0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496]) }),
})

/** WG7 req 5.1: a gain table suggestion on rtl_tcp items. */
// prettier-ignore
export type ReceiverGainTable =
	| {
			readonly state: "suggested"
			readonly provenance: "librtlsdr-tuner-gains"
			readonly tuner: RtlTunerName
			readonly valuesTenthsDb: readonly number[]
	}
	| {
			readonly state: "unknown"
			readonly reason:
				| "header-not-advertised"
				| "unlisted-tuner-type"
				| "gain-count-mismatch"
				| "no-gain-table"
	}
	| {
			readonly state: "not-applicable"
			readonly reason: "non-rtl-transport"
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

// prettier-ignore
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

export interface ReceiverIqDelivery {
	readonly advertised: readonly ("raw" | "channels")[] | null
	readonly configured: "raw" | "channels" | "auto"
	readonly resolved: "raw"
}
