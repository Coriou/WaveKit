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
}

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
