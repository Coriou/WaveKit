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
import { DSD_FME_LINE_CLUMP_MS } from "../../decoders/builtin/dsd-fme.js"
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
 * First voice to its call's admission, at most, on the RECORDED dv-latency seeds
 * (tests/mocks/fixtures/synthetic/dv-latency-dmr-*.json, 12 scenes, replayed through the
 * production dsd-fme adapter at every phase of its 500 ms call timer in 20 ms steps): from the
 * first voice sync line of an over (`VC*`, `VC1*` .. `VC6` on its slot) to the first `voice-call`
 * event of its call that is active, not encrypted and whose encryption is known (the snapshot
 * that admits pending voice). Measured worst 1 693.5 ms in direct mode (the call is announced
 * on the first line after its 100 ms start delay with its encryption not known, about a second
 * after the first voice, and known clear once a full link control decodes, after errored
 * `SLOT 1 FLCO FEC ERR` lines), 1 057.1 ms behind a repeater; rounded up to the millisecond.
 * tests/unit/core/auto-listen/pending-promotion.test.ts measures it and pins this value.
 */
export const AUTO_ROUTE_RECORDED_VOICE_TO_CLEAR_MS = 1_694
/**
 * Decoded voice may reach the router ahead of its sync line: dsd-fme sends voice datagrams as it
 * decodes them, while its printed lines arrive in clumps up to one clump after their burst
 * (`DSD_FME_LINE_CLUMP_MS`, 340 ms). So the first voice can precede the first voice line by this
 * much.
 */
export const AUTO_ROUTE_VOICE_AHEAD_OF_LINE_MS = DSD_FME_LINE_CLUMP_MS
/** One vocoder frame: 20 ms (160 samples at 8 kHz, one dsd-fme datagram). */
export const AUTO_ROUTE_VOCODER_FRAME_MS = 20
/** One DMR voice burst: 60 ms (a 360 ms superframe of six bursts); the bound's margin. */
export const AUTO_ROUTE_DMR_BURST_MS = 60

/**
 * Pending voice: decoded voice a decoder hands over before its call is active and explicitly
 * clear is kept this long (per decoder, by arrival time and by content) and admitted when the
 * call turns active and clear. The router learns of the call only from its `voice-call` events,
 * so the bound runs from the first decoded voice to the event that admits it: the recorded
 * seeds' worst first voice line to that event (1 694 ms), the voice ahead of its line (one line
 * clump, 340 ms) and one burst of margin (60 ms): 1 694 + 340 + 60 = 2 094 ms, rounded up to a
 * whole 20 ms vocoder frame: 2 100 ms (105 frames, 16 800 samples at 8 kHz). The digital voice
 * service hands the taps none of a call's voice while it is announced and its encryption is not
 * known (nothing on an unknown slot, zeros on a known one), so what waits here is the voice
 * before the call's first snapshot (up to 1 489 ms on the seeds) plus those zeros; the bound
 * runs on arrival time, and that voice is up to 1 885 ms old when the call turns known clear.
 * Memory per decoder: see `PendingVoice`. Assumes the adapter's default `callStartDelayMs`
 * (100 ms); a longer delay announces later and can let go a call's head (counted in
 * `autoRoute.pendingOverwrittenMs`).
 */
export const AUTO_ROUTE_PENDING_VOICE_MS =
	Math.ceil(
		(AUTO_ROUTE_RECORDED_VOICE_TO_CLEAR_MS +
			AUTO_ROUTE_VOICE_AHEAD_OF_LINE_MS +
			AUTO_ROUTE_DMR_BURST_MS) /
			AUTO_ROUTE_VOCODER_FRAME_MS,
	) * AUTO_ROUTE_VOCODER_FRAME_MS

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
