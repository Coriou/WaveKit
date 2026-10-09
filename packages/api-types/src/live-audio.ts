export interface LiveAudioConfig {
	enabled: boolean
	sourceId?: string
	httpPort: number
	modulation: "nfm" | "wfm" | "am" | "usb" | "lsb" | "dsb" | "cw" | "raw"
	bandwidth: number
	squelch: number
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
}

export type LiveDemodConfig = LiveAudioConfig
export type LiveDemodStatus = LiveAudioStatus
