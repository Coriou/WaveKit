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
	/**
	 * false: the call started on its voice frames before its link control said
	 * whether it is encrypted, so it is NOT clear (treat as encrypted); true
	 * once known (`encrypted` then says which). Absent: known (legacy).
	 */
	encryptionKnown?: boolean
	/** true from call_start until call_end. */
	active: boolean
	/** ISO 8601 */
	startedAt: string
	/** ISO 8601, set once the call ended. */
	endedAt?: string
	/** WG2: DMR colour code, when known. */
	colourCode?: number
	/** WG2: P25 network access code, upper-case hex, when known. */
	nac?: string
	/** WG2: encryption algorithm id (hex), encrypted calls only. */
	algorithmId?: string
	/** WG2: encryption key id (hex), when known. */
	keyId?: string
	/** WG2: NXDN radio access number, when known. */
	ran?: number
	/** WG2: CRC and FEC error counts of the call so far. */
	errors?: { crc: number; fec: number }
}

export type DigitalVoiceCallEventData = DigitalVoiceCall

/**
 * The /stream hold of voice whose call's encryption is not known yet:
 * cumulative milliseconds since the service started, plus the current lag.
 */
export interface DigitalVoiceHoldStatus {
	/** Voice put on hold while its call's encryption was not known. */
	heldMs: number
	/** Held voice played once its call was known clear. */
	releasedMs: number
	/** Held voice discarded: encrypted, ended unknown, detach, or no listener. */
	discardedMs: number
	/** Held voice dropped oldest-first beyond the 2 s hold bound. */
	overflowDroppedMs: number
	/** Current lag of the most delayed lane (held or released, not played yet). */
	bufferedMs: number
}

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
	/**
	 * Datagrams muted because the call is encrypted: discarded (mono, or slot
	 * unknown) or with that call's slot silenced (stereo). Voice held while its
	 * call's encryption is not known yet is not counted here (voiceHold).
	 */
	encryptedDatagramsDropped: number
	/** Queued voice dropped by the bounded jitter buffer. */
	droppedSamples: number
	/**
	 * Times the jitter buffer ran dry while playing. A call ends with at most
	 * one; more than one per call means gaps: raise jitterBufferMs.
	 */
	underruns: number
	/** Voice waiting in the jitter buffer. */
	bufferedMs: number
	/** /stream hold of voice whose call's encryption is not known yet. */
	voiceHold?: DigitalVoiceHoldStatus
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
