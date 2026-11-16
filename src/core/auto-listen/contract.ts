/**
 * Auto listen route contract (docs/specs/auto-listen-route/design.md, Contract): the ports the
 * router uses for decoded voice, coverage and time, and the fixed `/auto` stream format.
 */
import {
	LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS,
	LIVE_AUDIO_AUTO_ROUTE_DIGITAL_START_MS,
	LIVE_AUDIO_AUTO_ROUTE_FIFO_MS,
	LIVE_AUDIO_AUTO_ROUTE_FORMAT,
	LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS,
	LIVE_AUDIO_AUTO_ROUTE_RATE,
} from "@wavekit/api-types"
import type { StreamFormat } from "../audio-stream-server.js"

/** The `/auto` stream format (requirement 2.1), independent of the analog rate. */
export const AUTO_ROUTE_STREAM: Readonly<StreamFormat> = Object.freeze({
	rate: LIVE_AUDIO_AUTO_ROUTE_RATE,
	format: LIVE_AUDIO_AUTO_ROUTE_FORMAT,
})

/** 48 000 × 20 / 1 000 = 960 samples per output block. */
export const AUTO_ROUTE_BLOCK_SAMPLES =
	(LIVE_AUDIO_AUTO_ROUTE_RATE * LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS) / 1000
/** 960 samples × 2 bytes = 1 920 bytes per output block. */
export const AUTO_ROUTE_BLOCK_BYTES = AUTO_ROUTE_BLOCK_SAMPLES * 2
/** 48 000 × 3 000 / 1 000 = 144 000 samples per source FIFO. */
export const AUTO_ROUTE_FIFO_SAMPLES =
	(LIVE_AUDIO_AUTO_ROUTE_RATE * LIVE_AUDIO_AUTO_ROUTE_FIFO_MS) / 1000

/**
 * First `VC*` voice line to the first `SLOT` line of an over, at most, in the PROVISIONAL
 * dv-latency seeds (tests/mocks/fixtures/synthetic/dv-latency-*.json, 19 overs): 600.0 ms in
 * direct mode (every direct scene but one short over), 240.0 ms behind a repeater.
 */
export const AUTO_ROUTE_SEED_VOICE_TO_SLOT_MS = 600
/** One DMR voice burst: 60 ms (a 360 ms superframe of six bursts). */
export const AUTO_ROUTE_DMR_BURST_MS = 60
/**
 * dsd-fme adapter announce hold: the first `SLOT` line creates a pending call announced no
 * earlier than this after it (`CALL_START_DELAY_MS = 100`, src/decoders/builtin/dsd-fme.ts:578;
 * `emitAfter: nowMs + delayMs`, dsd-fme.ts:2917 and 2941).
 */
export const AUTO_ROUTE_ADAPTER_ANNOUNCE_HOLD_MS = 100
/**
 * dsd-fme adapter promotion period: the pending call is promoted (call_start, and the
 * `voice-call` event the router hears, dsd-fme.ts:1021) only by the call timer, every
 * `CALL_TIMEOUT_CHECK_INTERVAL_MS = 500` (dsd-fme.ts:575, the setInterval at 943-945,
 * `checkPendingCallEmission` at 1120 and 1136-1149). The timer's phase is free, so the call
 * event comes 100 to 600 ms after the `SLOT` line.
 */
export const AUTO_ROUTE_ADAPTER_PROMOTION_PERIOD_MS = 500
/** The seeds' guessed line latency (decoded voice to its printed line): 40 ms. */
export const AUTO_ROUTE_SEED_LINE_LATENCY_MS = 40

/**
 * Pending voice: decoded voice a decoder hands over before its call is active and explicitly
 * clear is kept this long (per decoder, by arrival time and by content) and admitted when the
 * call turns active and clear. The router learns of the call only from its `voice-call` event,
 * so the bound runs from the first voice to that event: the seeds' first voice to `SLOT`
 * (600 ms), the voice of the burst that line closes (60 ms), the adapter's announce hold
 * (100 ms) and its promotion period (500 ms, the worst timer phase), plus one burst of margin
 * (60 ms) and the seeds' line latency (40 ms): 600 + 60 + 100 + 500 + 60 + 40 = 1 360 ms
 * (10 880 samples at 8 kHz). Memory per decoder: see `PendingVoice`.
 */
export const AUTO_ROUTE_PENDING_VOICE_MS =
	AUTO_ROUTE_SEED_VOICE_TO_SLOT_MS +
	AUTO_ROUTE_DMR_BURST_MS +
	AUTO_ROUTE_ADAPTER_ANNOUNCE_HOLD_MS +
	AUTO_ROUTE_ADAPTER_PROMOTION_PERIOD_MS +
	AUTO_ROUTE_DMR_BURST_MS +
	AUTO_ROUTE_SEED_LINE_LATENCY_MS

/**
 * End guard of pending voice: after a clear call ends, voice handed over with no call is the
 * ended over's late datagrams for this long and is never kept as the next call's pre-voice.
 * The decoder hands voice over per 60 ms DMR burst (voice of one burst: 60 ms) and at most the
 * burst being decoded plus the one queued behind it trail the end: 2 × 60 = 120 ms. After an
 * encrypted or unresolved end no such voice is kept at all until the next call snapshot.
 */
export const AUTO_ROUTE_PENDING_END_GUARD_MS = 2 * 60

/**
 * Takeover: an admitted clear call replaces analog that no content check governs (Voice only
 * off, a manual or carrier squelch, no evidence gate and no tone squelch) once its start buffer
 * is ready: 200 ms (`LIVE_AUDIO_AUTO_ROUTE_DIGITAL_START_MS`), not the 1 500 ms preemption bound,
 * because that analog is the call's own carrier (the decoder covers the tuned channel).
 */
export const AUTO_ROUTE_TAKEOVER_MS = LIVE_AUDIO_AUTO_ROUTE_DIGITAL_START_MS

/**
 * An operator's listen mode change (a config change: `listenMode` or the open squelch) that waits
 * on a source still audible is put in force at most this long after it was made: the 1 500 ms
 * preemption bound (`LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS`), so a continuous carrier never holds
 * it forever. Automatic route decisions never switch mid-over for a mode.
 */
export const AUTO_ROUTE_OPERATOR_MODE_MAX_MS =
	LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS

export interface VoiceTapCall {
	callId: string
	active: boolean
	encrypted: boolean
	protocol: string | null
	slot: number | null
}

/** 8 kHz s16le mono after encryption muting; `pcm` is only valid during the call. */
export type VoiceTapFrame = (
	decoderId: string,
	pcm: Buffer,
	call: VoiceTapCall | null,
) => void

export interface VoiceTap {
	frame: VoiceTapFrame
	/** Every validated voice-call event, in the tick it is handled (start, update, end). */
	call(decoderId: string, call: VoiceTapCall): void
	/** The decoder's voice channel was removed or the service stopped. */
	detach(decoderId: string): void
}

export interface VoiceTapSource {
	/** Registers a tap; returns its remover. */
	addVoiceTap(tap: VoiceTap): () => void
	readonly voiceSampleRate: number
	/**
	 * Listen: the decoders whose voice this source can hand to taps, so the route can tell that no
	 * decoder covers the tuned channel before any call (`autoRoute.reason: "no-decoder"`). Optional:
	 * without it the route knows only the decoders it has heard from and reports no reason until
	 * one of them covers the channel.
	 */
	voiceDecoderIds?(): readonly string[]
}

/** "unknown" is treated exactly like "no". */
export type VoiceCoverage = "yes" | "no" | "unknown"

export interface VoiceCoveragePort {
	/** Called only when `generation` changed since the caller's cached answer. */
	covers(decoderId: string): VoiceCoverage
	/** Incremented at every event that can change coverage (retune, settle, placement). */
	readonly generation: number
}

/** Monotonic clock and timer for the pacer (injected in tests). */
export interface AutoRouteClock {
	now(): number
	setInterval(fn: () => void, ms: number): unknown
	clearInterval(handle: unknown): void
}
