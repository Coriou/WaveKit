/**
 * Evidence squelch contract (docs/specs/evidence-squelch): the ports the live demodulator uses
 * for the evidence gate and the pre-roll, their factory, and sizing / applicability helpers.
 */
import {
	LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS,
	LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS,
} from "@wavekit/api-types"
import type {
	LiveAudioAutoSquelchDiagnostics,
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
	/**
	 * A16 tail mute (2026-10-24): while open, whether the PCM just pushed carries current carrier
	 * evidence and may play. Absent: every open slice plays (the pre-A16 behaviour).
	 */
	readonly passing?: boolean
	/**
	 * One measured block while stage 1 is open: `carrier` is the per-block carrier evidence.
	 * Returns `EVIDENCE_NOTE_*` bit flags (amendment 2026-10-23: was `void`): `RESET` when the
	 * block was a carrier onset that reset the voice window while waiting; `DISCARD` as well
	 * when the unquieted run before it was a real noise lead-in, and the owner then abandons
	 * the pre-roll's held audio. 0 otherwise.
	 */
	noteBlock(carrier: boolean): number
	/** Byte offset in [start, end] of the first sample after a latch in this call, or -1. */
	push(
		pcm: Buffer,
		format: EvidencePcmFormat,
		start: number,
		end: number,
	): number
	/**
	 * Stage-1-closed bytes: advances hang and guard; returns leading bytes inside the close guard
	 * (A2). A16 revision (2026-10-24): the guard is what is left of the carrier guard and its fade
	 * at the close, never a fresh one; with `pcm` and `start` the fade is applied in place.
	 */
	closed(
		byteCount: number,
		format: EvidencePcmFormat,
		pcm?: Buffer,
		start?: number,
	): number
	/**
	 * A16 (sample-accurate, 2026-10-24): byte offset in the last `push` range up to which samples
	 * may play while latched; samples after it are muted. Absent: the whole range plays.
	 */
	readonly audibleEnd?: number
	/** The gate was latched when the last `push` began (it may have ended inside it). */
	readonly pushWasOpen?: boolean
	/** A17: the gate holds everything muted after an STE tone until stage 1 closes. */
	readonly muted?: boolean
	/**
	 * A17: one-shot; input samples from the STE onset to the end of the last `push` when an STE
	 * tone was detected in it, else 0. The owner retags that queued tail `drop`.
	 */
	takeSteBack?(): number
	/** Drop all evidence and the latch (close without latch, retune, mode change). */
	reset(): void
	/** DIAGNOSTIC AND UNSTABLE: the current voice window, computed on demand (optional). */
	diagnostics?(): LiveAudioAutoSquelchDiagnostics
}

/** A16 revision: fade-out at a mute boundary (10 ms, linear to zero), so the cut does not click. */
export const EVIDENCE_FADE_OUT_MS = 10

/** `noteBlock` flag: the voice window was reset on a carrier onset. */
export const EVIDENCE_NOTE_RESET = 1
/** `noteBlock` flag: the held audio before the onset is noise; abandon the pre-roll. */
export const EVIDENCE_NOTE_DISCARD = 2

export interface PreRollPort {
	process(chunk: Buffer, start: number, end: number, tag: PreRollTag): void
	latch(): void
	abandon(): void
	clear(): void
	/**
	 * A17: retags the newest `samples` queued samples `drop` and fades the `fadeSamples` queued
	 * playable samples before them to zero (in place). Samples already played are out of reach.
	 */
	muteTail?(samples: number, fadeSamples: number): void
	readonly delaySamples: number
}

export interface EvidenceGateOptions {
	rate: number
	modulation: "nfm" | "am"
	gain: number
	/**
	 * A16 revision (2026-10-24): samples of back-chain lag between a measured IQ block and its PCM
	 * (`backChainDrainSamples`); the carrier and close guard is this plus one 10 ms block.
	 * Absent: 0.
	 */
	drainLagSamples?: number
	/**
	 * Nominal peak deviation of the channel (amendment 2026-10-24, A13; `evidenceDeviationHz`):
	 * the voice meter normalises it onto the analyzer's 5 kHz scale. Absent: 5 000 Hz.
	 */
	deviationHz?: number
}

/** Peak deviation of the 25 kHz channel plan, the analyzer's 0 dB reference (A13). */
export const EVIDENCE_WIDE_DEVIATION_HZ = 5_000
/** Peak deviation of the 12.5 kHz channel plan (PMR446, narrowband PMR) (A13). */
export const EVIDENCE_NARROW_DEVIATION_HZ = 2_500
/** Widest configured channel bandwidth judged on the 12.5 kHz plan (A13). */
export const EVIDENCE_NARROW_MAX_BANDWIDTH_HZ = 12_500

/**
 * Nominal peak deviation for a configured NFM channel bandwidth (A13): channels of at most
 * 12.5 kHz follow the 12.5 kHz plan (±2.5 kHz), wider ones the 25 kHz plan (±5 kHz). A
 * non-finite or non-positive bandwidth takes the 25 kHz reference (the frozen judgement).
 */
export function evidenceDeviationHz(bandwidthHz: number): number {
	return Number.isFinite(bandwidthHz) &&
		bandwidthHz > 0 &&
		bandwidthHz <= EVIDENCE_NARROW_MAX_BANDWIDTH_HZ
		? EVIDENCE_NARROW_DEVIATION_HZ
		: EVIDENCE_WIDE_DEVIATION_HZ
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
