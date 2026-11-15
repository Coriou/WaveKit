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
 * Pending voice: decoded voice a decoder hands over before its call is active and explicitly
 * clear is kept this long (per decoder, by arrival time and by content) and admitted when the
 * call turns active and clear. Sized from the PROVISIONAL dv-latency seeds
 * (tests/mocks/fixtures/synthetic/dv-latency-*.json, 19 overs): the first `VC*` voice line to
 * the first `SLOT` line (the call start) is 600.0 ms at most (direct mode, every scene but one
 * short over; 240 ms behind a repeater). In that time the decoder produces the voice of 11
 * bursts of 60 ms (the `VC*` burst through the burst whose embedded LC starts the call):
 * 600 + 60 = 660 ms, plus one 60 ms burst of margin for the seeds' guessed 40 ms line latency:
 * 720 ms (5 760 samples at 8 kHz, 11.5 kB per decoder).
 */
export const AUTO_ROUTE_PENDING_VOICE_MS = 720

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
