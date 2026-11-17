// src/core/dv-tap/types.ts
/**
 * Per-call digital-voice PCM tap: the contract between the digital-voice service and a consumer
 * that keeps a call's audio (a call recorder). Types only.
 *
 * The service delivers each call's clear audio to registered taps, per call and per slot, before
 * any listener processing (resampling, gain, pacing, jitter buffer), whichever thread hosts audio
 * delivery. A tap never touches the delivery path and never sees audio it may not keep.
 *
 * Guarantees the service gives a tap:
 *
 * 1. Main thread, ordered. Every callback runs on the main thread. Per call: one `start`, then
 *    `state`, `pcm` and `drop` in order, then exactly one `end`; nothing after `end`. `end` is
 *    also delivered when the decoder exits or restarts, its voice channel is re-attached, the
 *    service stops or audio delivery faults (`reason` says which), so a tap never has to time a
 *    call out.
 * 2. Clear audio only. No sample of a call is delivered while the call's state is `unknown` or
 *    `encrypted`. Voice received while `unknown`, and voice received on the call's slot up to
 *    `DV_TAP_PRE_CALL_MS` before its `start` (a decoder can announce a call after its audio has
 *    begun), is held by the service and delivered with `held: true`, in order and before any
 *    later audio, once the call is known clear. A call that turns out encrypted, or ends while
 *    still `unknown`, has its held voice discarded: the `state` or `end` event says how many
 *    samples. Voice before a call is kept fail closed: any restricted (unknown or encrypted) call
 *    event on that decoder discards it, and nothing received within `DV_TAP_PRE_CALL_MS` after a
 *    restricted call's end is ever attributed to a later call. Every change of state fires a
 *    `state` event, including clear to encrypted in the middle of a call; after it no further
 *    sample of that call is delivered.
 * 3. Per call, per slot. `pcm` holds the call's own slot and never the other slot's audio, as
 *    8 kHz signed 16-bit mono exactly as decoded. Every block names its `callId` and `slot`.
 * 4. Batched and owned. A block holds `DV_TAP_BLOCK_MIN_MS` to `DV_TAP_BLOCK_MAX_MS` of audio
 *    (the last block of a call may be shorter). Its `Int16Array` belongs to the tap: the service
 *    never reuses or reads it again.
 * 5. Never in the way. A tap that throws is caught and counted. Blocks waiting for a main thread
 *    that is not running queue up to `DV_TAP_QUEUE_MAX_MS` of audio per process; past that the
 *    oldest waiting blocks are dropped, and each affected call gets one `drop` event per run of
 *    dropped blocks and the total in its `end`.
 * 6. No invented audio. Missing input is not filled with silence: `firstSample` is contiguous over
 *    what was delivered, and `atMs` places a block in time.
 * 7. Independent of listeners. Taps receive calls with no audio client connected.
 */

/** Sample rate of every tap block. */
export const DV_TAP_SAMPLE_RATE_HZ = 8000
/** Shortest block, except the last of a call: 100 ms = 800 samples. */
export const DV_TAP_BLOCK_MIN_MS = 100
/** Longest block: 200 ms = 1 600 samples. */
export const DV_TAP_BLOCK_MAX_MS = 200
/** Voice on a slot before its call's `start` that is still attributed to the call: 1 500 ms. */
export const DV_TAP_PRE_CALL_MS = 1500
/** Blocks waiting for the main thread, per process: 5 minutes = 2 400 000 samples (4.8 MB). */
export const DV_TAP_QUEUE_MAX_MS = 300_000

/** Whether a call's audio may be kept: only `clear` audio is ever delivered. */
export type DvTapCallState = "unknown" | "clear" | "encrypted"

/** Which kind of decoder channel carries the call. */
export type DvTapChannelKind = "main" | "placement" | "probe"

export interface DvTapCallRef {
	decoderId: string
	/** The call id of the decoder's voice-call events; Activity's call rows carry the same id. */
	callId: string
	/** TDMA slot, or null on a one-slot channel. */
	slot: 1 | 2 | null
}

export interface DvTapCallStart extends DvTapCallRef {
	channelKind: DvTapChannelKind
	/** The scanner probe's id when `channelKind` is `probe`. */
	probeId: string | null
	/** The channel frequency the decoder listens on, in Hz, or null when it is not known. */
	channelHz: number | null
	protocol: string | null
	state: DvTapCallState
	/** Wall clock of the call's first event, ms since the epoch. */
	startedAtMs: number
}

export interface DvTapCallStateChange extends DvTapCallRef {
	state: DvTapCallState
	/**
	 * Held samples this change settles: about to be delivered (`clear`) or discarded
	 * (`encrypted`). 0 when nothing was held.
	 */
	heldSamples: number
}

export interface DvTapPcm extends DvTapCallRef {
	/** Mono, `DV_TAP_SAMPLE_RATE_HZ`, this call's slot only. Owned by the tap. */
	pcm: Int16Array
	/** Index of `pcm[0]` within the audio delivered for this call; contiguous from 0. */
	firstSample: number
	/** Wall clock at which the first sample of the block was received, ms since the epoch. */
	atMs: number
	/** True for audio received before the call was known clear and released afterwards. */
	held: boolean
}

export interface DvTapDrop extends DvTapCallRef {
	/** Clear samples of this call that were dropped before reaching the tap, in this run. */
	lostSamples: number
	/** `firstSample` the next delivered block will carry (the drop sits just before it). */
	beforeSample: number
}

export type DvTapEndReason =
	| "end"
	| "timeout"
	| "replaced"
	| "decoder-exit"
	| "restart"
	| "shutdown"
	| "fault"

export interface DvTapCallEnd extends DvTapCallRef {
	reason: DvTapEndReason
	finalState: DvTapCallState
	/** Samples delivered to the tap for this call. */
	deliveredSamples: number
	/** Clear samples dropped before reaching the tap, over the whole call. */
	lostSamples: number
	/** Held samples discarded at the end (a call that ended while `unknown`). */
	discardedHeldSamples: number
	/** Wall clock of the end, ms since the epoch. */
	endedAtMs: number
}

export interface DvCallTap {
	start(event: DvTapCallStart): void
	state(event: DvTapCallStateChange): void
	pcm(event: DvTapPcm): void
	drop(event: DvTapDrop): void
	end(event: DvTapCallEnd): void
}

/** What the digital-voice service offers: registers a tap and returns its remover. */
export interface DvCallTapSource {
	addCallTap(tap: DvCallTap): () => void
}
