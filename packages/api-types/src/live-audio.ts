/**
 * WG4 (docs/specs/web-gaps-4, requirement 4): post-demodulation AGC. Absent means the
 * modulation default (AM, CW, DSB, USB, LSB `fast`; NFM, WFM and raw none).
 */
export type LiveAudioAgcMode = "off" | "slow" | "fast"
export const LIVE_AUDIO_AGC_MODES: readonly LiveAudioAgcMode[] = [
	"off",
	"slow",
	"fast",
]

export interface LiveAudioConfig {
	enabled: boolean
	sourceId?: string
	httpPort: number
	modulation: "nfm" | "wfm" | "am" | "usb" | "lsb" | "dsb" | "cw" | "raw"
	bandwidth: number
	squelch: number
	/** Manual preserves the configured threshold; auto uses a channel-power floor estimate. */
	squelchMode?: "manual" | "auto"
	/** Auto threshold margin above the estimate, 0–40 dB; default 6. */
	autoMarginDb?: number
	noiseReduction: "off" | "voice" | "noaa-apt" | "narrow-band"
	lowPass: number
	highPass: number
	gain: number
	deEmphasis: boolean
	deEmphasisTau: 50 | 75
	audioFormat: "s16le" | "f32le"
	/** Deprecated and ignored by the server (accepted for compatibility). */
	iqDcBlock: boolean
	/**
	 * Channel offset from the tuned centre in Hz (a carrier at centre + offsetHz
	 * is shifted to DC before demodulation). Default 0.
	 */
	offsetHz?: number
	/** WG4: absent = modulation default. */
	agc?: LiveAudioAgcMode
}

export interface LiveAudioStatus {
	enabled: boolean
	running: boolean
	sourceId: string
	sourceConnected: boolean
	sourceIqSampleRate: number
	config: LiveAudioConfig
	effectiveSampleRate: number
	decimationFactor: number
	httpUrl: string
	clientCount: number
	bytesStreamed: number
	pipelineHealth: "running" | "starting" | "stopped" | "error"
	lastError?: string
	/** Same audio as httpUrl behind a streaming WAV header. */
	wavUrl?: string
	/** Automatic pipeline restarts since the last manual start. */
	pipelineRestarts?: number
	/** Smoothed pre-demodulation channel power in dBFS (while running). */
	channelPowerDbfs?: number
	/** Squelch gate state (while running; true when squelch is off). */
	squelchOpen?: boolean
	noiseFloorDbfs?: number
	thresholdDbfs?: number
	/** WG4: AGC in the running chain after the modulation default (raw is always off). */
	agc?: LiveAudioAgcMode
}

export type LiveDemodConfig = LiveAudioConfig
export type LiveDemodStatus = LiveAudioStatus

/** Payload for live-audio:level; null measurements precede the first IQ block. */
export interface LiveAudioLevel {
	sourceId: string
	channelPowerDbfs: number | null
	noiseFloorDbfs: number | null
	squelchOpen: boolean
	thresholdDbfs: number
}

/** Why an analog transmission ended (WG1). */
export type AnalogTransmissionCloseReason =
	| "squelch"
	| "retune"
	| "config"
	| "stopped"
	| "max-duration"

/** WG2: CTCSS tone and DTMF digits of a closed transmission (docs/specs/web-gaps-2, requirement 7). */
export interface AnalogTransmissionTone {
	/** One of the 50 standard CTCSS tones (67.0–254.1 Hz), or null when none qualified. */
	ctcssHz: number | null
	/** DTMF symbols `0-9*#A-D` in order, at most 32; null when none. */
	dtmf: string | null
	/**
	 * WG6 (web-gaps-6 req 4): Digital-Coded Squelch heard during the transmission, or null when
	 * none qualified. Sent on closed events by WG6 cores; absent before WG6.
	 */
	dcs?: AnalogTransmissionDcs | null
}

/**
 * WG6 req 4.4: a DCS code as received with WaveKit's FM demodulator polarity. Every standard
 * code has an inverted twin carrying the same bit stream (023 normal = 047 inverted); the twin
 * is derived, never sent, and search matches both spellings.
 */
export interface AnalogTransmissionDcs {
	/** Three octal digits, e.g. "023". */
	code: string
	polarity: "normal" | "inverted"
}

/** WG6 req 4.1: DCS bit rate, 134.4 bit/s NRZ (23-bit Golay words repeated). */
export const DCS_BIT_RATE_BPS = 134.4
/** WG6 req 4.3: identical valid words required before a code is reported. */
export const DCS_MIN_WORDS = 3
/** WG6 req 4.3: whole audio seconds a transmission needs for a DCS result (as CTCSS). */
export const DCS_MIN_AUDIO_SECONDS = 0.75
/**
 * WG6 req 4.5 (E3): "standard" reports only codes of DCS_STANDARD_CODES; "any-valid" reports the
 * lowest valid code of the received word's rotations (no table). One-constant switch.
 */
export const DCS_CODE_SET: "standard" | "any-valid" = "standard"
/**
 * WG6 req 4.5 (E3): the 104 standard DCS codes (octal), a protocol constant like the 50 CTCSS
 * tones. Source: the EIA/TIA-603 Digital Coded Squelch code set, the same 104 codes the
 * Motorola DPL code chart and common radio programming references list. Codes are 23-bit
 * Golay(23,12) words: 9 code bits, the fixed bits 100, 11 parity bits (generator 0xC75). No two
 * listed codes are cyclic rotations of each other; each has exactly one listed inverted twin.
 */
// prettier-ignore
export const DCS_STANDARD_CODES: readonly string[] = Object.freeze([
	"023", "025", "026", "031", "032", "036", "043", "047", "051", "053", "054", "065", "071",
	"072", "073", "074", "114", "115", "116", "122", "125", "131", "132", "134", "143", "145",
	"152", "155", "156", "162", "165", "172", "174", "205", "212", "223", "225", "226", "243",
	"244", "245", "246", "251", "252", "255", "261", "263", "265", "266", "271", "274", "306",
	"311", "315", "325", "331", "332", "343", "346", "351", "356", "364", "365", "371", "411",
	"412", "413", "423", "431", "432", "445", "446", "452", "454", "455", "462", "464", "465",
	"466", "503", "506", "516", "523", "526", "532", "546", "565", "606", "612", "624", "627",
	"631", "632", "654", "662", "664", "703", "712", "723", "731", "732", "734", "743", "754",
])

/** Event-time RF frequency of a transmission: the tuned centre plus `offsetHz` when it opened. */
export interface AnalogTransmissionFrequency {
	hz: number
	tuningTrust: "commanded" | "relay" | "unverified"
}

/**
 * `live-audio:transmission` on the `live-audio` channel (WG1): one squelch-delimited analog
 * transmission of the live demodulator. Sent once with `state: "open"` when the gated squelch
 * opens and once with `state: "closed"` when it ends; both carry the same `transmissionId`.
 * Produced whether or not the Activity store is enabled.
 */
export interface AnalogTransmissionEventData {
	transmissionId: string
	sourceId: string
	state: "open" | "closed"
	startedAt: string
	/** Null while open. */
	endedAt: string | null
	/** endedAt − startedAt in ms; null while open. */
	durationMs: number | null
	frequency: AnalogTransmissionFrequency | null
	modulation: LiveAudioConfig["modulation"]
	bandwidthHz: number
	squelchMode: "manual" | "auto"
	/** Effective threshold when the transmission opened. */
	thresholdDbfs: number
	/** Over the level samples of the transmission; null before the first one. */
	peakChannelPowerDbfs: number | null
	meanChannelPowerDbfs: number | null
	/** Null while open. */
	closeReason: AnalogTransmissionCloseReason | null
	/** WG2: on closed events only. */
	tone?: AnalogTransmissionTone
}
