/**
 * Digital voice stream contracts (decoded dsd-fme voice as PCM).
 *
 * Audio: GET http://<core>:<httpPort>/stream (raw) or /stream.wav, and
 * /decoders/<decoderId>/stream[.wav] per dsd-fme decoder. Constant-rate mono
 * s16le at 8000 Hz for the stream's life, exact silence between calls and
 * during encrypted calls. Call metadata travels on REST/WebSocket only.
 */

export type DigitalVoiceSlot = 1 | 2 | "both"

export interface DigitalVoiceConfig {
	enabled: boolean
	httpPort: number
	voiceSlot: DigitalVoiceSlot
	jitterBufferMs: number
	maxBufferMs: number
}

/**
 * One digital voice call, mirroring the dsd-fme decoder's call_start /
 * call_end events (same callId). Payload of `digital-voice:call`.
 */
export interface DigitalVoiceCall {
	decoderId: string
	callId: string
	/** dsd-fme protocol, e.g. "dmr", "p25p1", "ysf", "dstar", "nxdn96". */
	protocol: string | null
	talkgroup: number | null
	source: number | null
	/** TDMA slot (DMR) or VCH (P25 phase 2); null when unknown. */
	slot: number | null
	/** Encrypted calls are never decoded: the stream stays silent. */
	encrypted: boolean
	/** true from call_start until call_end. */
	active: boolean
	/** ISO 8601 */
	startedAt: string
	/** ISO 8601, set once the call ended. */
	endedAt?: string
}

export type DigitalVoiceCallEventData = DigitalVoiceCall

export interface DigitalVoiceDecoderStatus {
	decoderId: string
	/** dsd-fme mode option (auto, dmr, p25, ...). */
	mode: string
	/** Local UDP port dsd-fme sends voice to. */
	udpPort: number
	httpUrl: string
	wavUrl: string
	clientCount: number
	bytesStreamed: number
	datagramsReceived: number
	/** Malformed datagrams (not whole sample frames, or oversized). */
	datagramsRejected: number
	/** Datagrams discarded because the call is encrypted. */
	encryptedDatagramsDropped: number
	/** Queued voice dropped by the bounded jitter buffer. */
	droppedSamples: number
	/** Voice waiting in the jitter buffer. */
	bufferedMs: number
	/** ISO 8601 */
	lastDatagramAt?: string
	call: DigitalVoiceCall | null
	lastCall?: DigitalVoiceCall
}

/** GET /api/digital-voice/status and `digital-voice:status`. */
export interface DigitalVoiceStatus {
	enabled: boolean
	running: boolean
	config: DigitalVoiceConfig
	sampleRate: number
	audioFormat: "s16le"
	channels: 1
	/** Default stream (the first dsd-fme decoder). */
	httpUrl: string
	wavUrl: string
	clientCount: number
	bytesStreamed: number
	decoders: DigitalVoiceDecoderStatus[]
	/** The first active call on any decoder, else null. */
	call: DigitalVoiceCall | null
	lastError?: string
}
