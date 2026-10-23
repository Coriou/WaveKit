/**
 * Evidence squelch contract (docs/specs/evidence-squelch): the ports the live demodulator uses
 * for the evidence gate and the pre-roll, their factory, and sizing / applicability helpers.
 */
import {
	LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS,
	LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS,
} from "@wavekit/api-types"
import type {
	LiveAudioAutoSquelchEvidence,
	LiveAudioConfig,
	LiveAudioSquelchMode,
	LiveAudioToneSquelch,
} from "@wavekit/api-types"

export type EvidencePcmFormat = "s16le" | "f32le"
export type PreRollTag = "pending" | "pass" | "guard" | "drop"

export interface EvidenceGatePort {
	readonly state: "waiting" | "open"
	readonly evidence: LiveAudioAutoSquelchEvidence | null
	/** One measured block while stage 1 is open: `carrier` is the per-block carrier evidence. */
	noteBlock(carrier: boolean): void
	/** Byte offset in [start, end] of the first sample after a latch in this call, or -1. */
	push(
		pcm: Buffer,
		format: EvidencePcmFormat,
		start: number,
		end: number,
	): number
	/** Stage-1-closed bytes: advances hang and guard; returns leading bytes inside the close guard (A2). */
	closed(byteCount: number, format: EvidencePcmFormat): number
	/** Drop all evidence and the latch (close without latch, retune, mode change). */
	reset(): void
}

export interface PreRollPort {
	process(chunk: Buffer, start: number, end: number, tag: PreRollTag): void
	latch(): void
	abandon(): void
	clear(): void
	readonly delaySamples: number
}

export interface EvidenceGateOptions {
	rate: number
	modulation: "nfm" | "am"
	gain: number
}

export interface PreRollOptions {
	rate: number
	format: EvidencePcmFormat
}

export interface EvidenceSquelchFactory {
	createGate(options: EvidenceGateOptions): EvidenceGatePort
	createPreRoll(options: PreRollOptions): PreRollPort
}

/** Bytes per sample of a PCM format. */
export function pcmSampleBytes(format: EvidencePcmFormat): number {
	return format === "s16le" ? 2 : 4
}

/** Samples covering `ms` at `rate`, rounded up. */
export function msToSamples(ms: number, rate: number): number {
	return Math.ceil((rate * ms) / 1000)
}

/** Pre-roll FIFO capacity in samples. */
export function preRollCapacitySamples(rate: number): number {
	return msToSamples(LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS, rate)
}

/** Pre-roll FIFO bytes: capacity plus one sample for a split-sample hold. */
export function preRollBytes(rate: number, format: EvidencePcmFormat): number {
	return (preRollCapacitySamples(rate) + 1) * pcmSampleBytes(format)
}

/** True when the evidence gate governs client audio for this config. */
export function evidenceGateApplies(config: {
	squelchMode?: LiveAudioSquelchMode | undefined
	modulation: LiveAudioConfig["modulation"]
	toneSquelch?: LiveAudioToneSquelch | undefined
}): boolean {
	return (
		config.squelchMode === "auto" &&
		LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS.includes(config.modulation) &&
		(config.toneSquelch === undefined || config.toneSquelch.kind === "none")
	)
}
