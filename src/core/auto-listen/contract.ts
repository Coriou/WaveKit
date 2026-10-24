/**
 * Auto listen route contract (docs/specs/auto-listen-route/design.md, Contract): the ports the
 * router uses for decoded voice, coverage and time, and the fixed `/auto` stream format.
 */
import {
	LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS,
	LIVE_AUDIO_AUTO_ROUTE_FIFO_MS,
	LIVE_AUDIO_AUTO_ROUTE_FORMAT,
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
