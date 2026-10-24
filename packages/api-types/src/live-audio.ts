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

/**
 * WG7 (docs/specs/web-gaps-7, requirement 2): squelch modes (absent = `auto`, the evidence
 * squelch runtime default; see `LiveAudioConfig.squelchMode`). `manual`:
 * `squelch` is the channel-power threshold; `auto`: noise-floor estimate + `autoMarginDb`;
 * `noise` (NFM and WFM only): opens when the FM discriminator's high-frequency noise is at least
 * `noiseQuietingDb` below its noise-only reference.
 */
export type LiveAudioSquelchMode = "manual" | "auto" | "noise"
export const LIVE_AUDIO_SQUELCH_MODES: readonly LiveAudioSquelchMode[] =
	Object.freeze(["manual", "auto", "noise"])
/** WG7 req 2.2: noise squelch quieting threshold in dB (default, inclusive range). */
/** WG10 req 2.2: silence chunk length while a restart keeps the stream format. */
export const LIVE_AUDIO_SILENCE_CHUNK_MS = 20
/** WG10 req 2.2: silence fill per restart at most (then clients wait as before). */
export const LIVE_AUDIO_SILENCE_FILL_MAX_MS = 5_000
/** WG10 req 2.3: an offset change falls back to a full restart when the new front is silent this long. */
export const LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS = 2_000

export const LIVE_AUDIO_NOISE_QUIETING_DB = Object.freeze({
	default: 6,
	min: 1,
	max: 30,
})
/** WG7 req 2.3, 3.1: modulations a noise squelch / tone squelch applies to. */
export const LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS: readonly LiveAudioConfig["modulation"][] =
	Object.freeze(["nfm", "wfm"])
export const LIVE_AUDIO_TONE_SQUELCH_MODULATIONS: readonly LiveAudioConfig["modulation"][] =
	Object.freeze(["nfm"])
/**
 * WG7 req 3.1: the tone a tone squelch gate waits for; the saved-frequency tone shape
 * (`frequencyTenthsHz` one of the 50 standard CTCSS tones, `code` one of DCS_STANDARD_CODES).
 */
export type LiveAudioToneSquelch =
	| { kind: "none" }
	| { kind: "ctcss"; frequencyTenthsHz: number }
	| { kind: "dcs"; code: string; polarity: "normal" | "inverted" }
/** WG7 req 3.2: consecutive CTCSS analysis blocks / DCS words that open and close the gate. */
export const LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT = 2
export const LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT = 2

/**
 * Evidence squelch (docs/specs/evidence-squelch): modulations whose `auto` squelch gates client
 * audio on voice or tone evidence, and those where tone evidence counts. NFM only (amendment
 * A8, 2026-10-23): a bare AM carrier opened the gate as voice, so AM keeps the stage-1 auto
 * squelch like WFM and the other modulations, with `autoSquelch` state `off`.
 */
export const LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS: readonly LiveAudioConfig["modulation"][] =
	Object.freeze(["nfm"])
export const LIVE_AUDIO_AUTO_SQUELCH_TONE_MODULATIONS: readonly LiveAudioConfig["modulation"][] =
	Object.freeze(["nfm"])
/** Voice meter frame length (equals ANALOG_TRIAL_FRAME_MS). */
export const LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS = 50
/** Frames in the voice judgement window (1 s). */
export const LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES = 20
/** Measured blocks in the carrier quieting window. */
export const LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS = 100
/** Audio before a qualified tone opens the gate (equals DCS_MIN_AUDIO_SECONDS). */
export const LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS = 750
/** Latch hang after stage 1 closes (equals ANALOG_TRANSMISSION_MERGE_GAP_MS). */
export const LIVE_AUDIO_AUTO_SQUELCH_HANG_MS = 1_500
/** Pre-roll capacity: the most audio held while waiting for evidence. */
export const LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS = 1_500
/**
 * Audio after the last carrier evidence of a latched over that still plays (the over's tail in
 * the back chain): one 10 ms block, to which the core adds the back chain's computed lag (1
 * sample on the default NFM chain). Changed 2026-10-24 (A16 revision) from 200 ms: live run6 showed
 * the old guard passing 200 ms of full-scale FM noise after every over, with the noise starting
 * within one block of the carrier drop.
 */
export const LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS = 10

export type LiveAudioAutoSquelchEvidence = "voice" | "ctcss" | "dcs"
/**
 * Evidence gate state: `off` (not evidence-gated), `waiting` (no evidence yet, audio held),
 * `open` (latched on `evidence`, audio passes).
 */
export interface LiveAudioAutoSquelch {
	state: "off" | "waiting" | "open"
	evidence?: LiveAudioAutoSquelchEvidence
	/**
	 * DIAGNOSTIC AND UNSTABLE (2026-10-24): present only on `GET /api/live-audio/status?diagnostics=true`
	 * while the evidence gate runs; never on level events. Its shape may change or disappear
	 * without notice; clients must not depend on it.
	 */
	diagnostics?: LiveAudioAutoSquelchDiagnostics
}

/**
 * Why the evidence gate is waiting, in the judge's order: `window-filling` (fewer than 20
 * frames since the window started), `non-finite` (a frame failed closed), `data-like` (median
 * cluster ≥ 0.6), `not-quiet` (quieted blocks under half of the noted blocks), `low-syllabic`
 * (median syllabic index under 0.3), `low-audio` (neither voice path: median audioDb under -30
 * and fewer than two syllable runs, A15), `voice-median` or `voice-runs` (the window passes on
 * that path; the next frame latches); `latched` while open (see `path`).
 */
export type LiveAudioAutoSquelchVerdict =
	| "window-filling"
	| "non-finite"
	| "data-like"
	| "not-quiet"
	| "low-syllabic"
	| "low-audio"
	| "voice-median"
	| "voice-runs"
	| "latched"

/** DIAGNOSTIC AND UNSTABLE: the evidence gate's current voice window (see `diagnostics`). */
export interface LiveAudioAutoSquelchDiagnostics {
	verdict: LiveAudioAutoSquelchVerdict
	/** Frames in the voice window (0-20). */
	frames: number
	/** Medians over the window (null when empty or not finite). */
	audioDb: number | null
	syllabic: number | null
	cluster: number | null
	/** Syllable runs (≥ 3 consecutive frames at ≥ -30 dB) in the window (A15). */
	syllableRuns: number
	/** While latched: `median` or `runs` (the voice path, A15) or `tone`. */
	path?: "median" | "runs" | "tone"
	/** Quieted and noted 10 ms blocks in the quiet window (at most 100). */
	quietBlocks: number
	notedBlocks: number
	/** Window resets on carrier onsets since the episode started. */
	windowResets: number
	/** Audio since the episode (or the last re-open) started, ms. */
	audioMs: number
	/** Deviation the voice meter normalises to (2 500 or 5 000 Hz). */
	deviationHz: number
	/** A17: an STE tone ended the over; everything is muted until stage 1 closes. */
	ste?: true
}

export interface LiveAudioConfig {
	enabled: boolean
	sourceId?: string
	httpPort: number
	modulation: "nfm" | "wfm" | "am" | "usb" | "lsb" | "dsb" | "cw" | "raw"
	bandwidth: number
	squelch: number
	/**
	 * `auto` is the runtime default: a channel-power floor estimate + margin and, on NFM only,
	 * client audio gated on voice or tone evidence with a pre-roll (AM and the other modulations
	 * keep the stage-1 auto squelch). `manual` (configured
	 * threshold) and WG7 `noise` (FM quieting) are unchanged.
	 */
	squelchMode?: LiveAudioSquelchMode
	/** Auto threshold margin above the estimate, 0–40 dB; default 6. */
	autoMarginDb?: number
	/** WG7: noise squelch quieting threshold, 1–30 dB; default 6 (used in `noise` mode only). */
	noiseQuietingDb?: number
	/** WG7: tone squelch gate (NFM only); absent or `none` = no tone gate. */
	toneSquelch?: LiveAudioToneSquelch
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
	/** Demodulator for this config. Absent means csdr. */
	engine?: "csdr" | "rust"
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
	/**
	 * WG7 req 3.4: tone squelch gate while running: `off` (no tone set), `waiting` (squelch closed
	 * or the tone not heard: audio muted), `open` (tone heard: audio passes).
	 */
	toneSquelch?: { state: "off" | "waiting" | "open" }
	/** Demodulator that produced this status. `csdr` when Rust fell back or was not asked. */
	engine?: "csdr" | "rust"
	/** Why a requested Rust engine is not the one running. Present only when set. */
	engineFallback?:
		| "binary-unavailable"
		| "protocol-unsupported"
		| "input-format-unsupported"
		| "modulation-unsupported"
		| "open-rejected"
		| "process-unstable"
	/**
	 * WG12: last closed or current transmission's tone. Absent until one is reported;
	 * cleared on retune and stop.
	 */
	tone?: {
		ctcssHz: number | null
		dcs: AnalogTransmissionDcs | null
		at: string
	}
	/** Evidence squelch gate while running; `off` when the evidence path is inactive (any non-NFM modulation). */
	autoSquelch?: LiveAudioAutoSquelch
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
	/** Evidence squelch gate state at the measured block. */
	autoSquelch?: LiveAudioAutoSquelch
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
	squelchMode: LiveAudioSquelchMode
	/** Effective threshold when the transmission opened (WG7 noise mode: the configured `squelch`). */
	thresholdDbfs: number
	/** WG7 req 2.4: the quieting threshold in effect; present in `noise` mode only. */
	noiseQuietingDb?: number
	/** Over the level samples of the transmission; null before the first one. */
	peakChannelPowerDbfs: number | null
	meanChannelPowerDbfs: number | null
	/** Null while open. */
	closeReason: AnalogTransmissionCloseReason | null
	/** WG2: on closed events only. */
	tone?: AnalogTransmissionTone
}
