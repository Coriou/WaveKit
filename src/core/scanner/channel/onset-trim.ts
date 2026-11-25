/**
 * Onset trim of a scanner analog file's head (WidebandAnalogRecorder, once per file before its
 * first write). A file opens `hold.preRollMs` (300 ms) before its track's start, and the detector
 * reports the track up to about 0.85 s before the FM carrier quiets, so a file used to open with
 * up to about 1.15 s of open-squelch static near −8 dBFS. Static is rich in high frequencies, a
 * quieted carrier (voice or silence) is not: the second difference of the 8 kHz audio
 * (x[i] − 2·x[i−1] + x[i−2], a 12 dB/octave high-pass: +10.6 dB at 3 kHz, −9.5 dB at 750 Hz)
 * measures it. A first difference (6 dB/octave) left synthetic voice only 7 dB under the static
 * (modelled, WidebandNfmChain); the second difference separates them by more.
 *
 * Rule: over the head [0, searchSamples) in ONSET_BLOCK_SAMPLES blocks (20 ms), each block's
 * second-difference energy in dB; the lead is the median of the first ONSET_LEAD_BLOCKS (60 ms);
 * the onset is the first block whose level is at least ONSET_DROP_DB (10 dB) under the lead and
 * that stays so for ONSET_HOLD_BLOCKS blocks (100 ms) in a row. The cut keeps ONSET_KEEP_SAMPLES
 * (150 ms) before the first quieted block (at least 10 dB under the lead) after the static prefix,
 * which is the onset or earlier: cut = max(0, quiet − 150 ms), so a sound between a first quieting
 * and the held onset (a fricative, a quieting broken by a word) keeps its start.
 * Static guard: static is stationary, voice is not. The static prefix is the leading blocks within
 * ONSET_STATIC_SPREAD_DB of the lead; a cut needs a prefix of at least ONSET_MIN_STATIC_BLOCKS
 * (200 ms) that ends at most ONSET_TRANSITION_BLOCKS (200 ms, the carrier rising) before the onset,
 * and never passes it (cut ≤ prefix). A file that opens on voice (a mid-voice start: its lead is
 * voice, which leaves that band within a block or two, or a keying edge) has no such prefix, so a
 * pause in its speech is never taken for an onset. No onset (all static, or no quieting that
 * holds): no cut. Then the first
 * ONSET_FADE_SAMPLES (20 ms) written get a raised-cosine fade-in, cut or not.
 *
 * Bounded work: one pass of at most searchSamples (ONSET_MAX_SEARCH_SAMPLES) samples and one sort
 * of ONSET_LEAD_BLOCKS numbers per file; nothing per sample on the hot path.
 */
import { ANALOG_AUDIO_RATE_HZ } from "./fm-audio.js"

const PER_MS = ANALOG_AUDIO_RATE_HZ / 1000
/** 20 ms blocks: 20 × 8 = 160 samples. */
export const ONSET_BLOCK_SAMPLES = 20 * PER_MS
/** The lead: the first 3 blocks (60 ms), its median the static's level. */
export const ONSET_LEAD_BLOCKS = 3
/** A quieted block is at least 10 dB under the lead's median. */
export const ONSET_DROP_DB = 10
/**
 * The static prefix: blocks within ±4 dB of the lead's median. Modelled static (WidebandNfmChain
 * on noise alone) holds ±1.5 dB per 20 ms block; synthetic syllabic voice moves 10 to 25 dB.
 */
export const ONSET_STATIC_SPREAD_DB = 4
/** The static prefix a cut needs: 200 ms = 10 blocks (a synthetic voice tone lasts 150 ms). */
export const ONSET_MIN_STATIC_BLOCKS = 10
/** The onset may come at most 200 ms = 10 blocks after the static prefix ends (carrier rise). */
export const ONSET_TRANSITION_BLOCKS = 10
/** The quieting holds 100 ms: 100 / 20 = 5 blocks in a row. */
export const ONSET_HOLD_BLOCKS = 5
/** Audio kept before the onset: 150 ms = 1 200 samples. */
export const ONSET_KEEP_SAMPLES = 150 * PER_MS
/** The fade-in: 20 ms = 160 samples. */
export const ONSET_FADE_SAMPLES = 20 * PER_MS
/**
 * What is searched past the file's start: the pre-roll plus 1 000 ms of detector lead (the 0 to
 * 0.85 s measured, with margin): 300 + 1 000 = 1 300 ms = 10 400 samples at the default pre-roll.
 */
export const ONSET_LEAD_MS = 1_000
/**
 * Search bound whatever the pre-roll (hold.preRollMs may be set up to 10 s): 2 000 ms = 16 000
 * samples, one pass of 16 000 multiply-adds per file at most.
 */
export const ONSET_MAX_SEARCH_MS = 2_000
export const ONSET_MAX_SEARCH_SAMPLES = ONSET_MAX_SEARCH_MS * PER_MS

/** Samples searched for a file opened `preRollMs` before its track (ONSET_MAX_SEARCH_SAMPLES at most). */
export function onsetSearchSamples(preRollMs: number): number {
	const ms = Math.max(0, Number.isFinite(preRollMs) ? preRollMs : 0)
	return Math.min(
		ONSET_MAX_SEARCH_SAMPLES,
		Math.round((ms + ONSET_LEAD_MS) * PER_MS),
	)
}

/** onsetTrim's answer: the samples to drop and the onset found (null: none). */
export interface OnsetTrim {
	readonly cutSamples: number
	readonly onsetSamples: number | null
}

/**
 * The head trim of `head` (the file's first samples, 8 kHz; only the first `searchSamples` are
 * read). 0 ≤ cutSamples ≤ max(0, q − ONSET_KEEP_SAMPLES) ≤ max(0, onsetSamples −
 * ONSET_KEEP_SAMPLES) < searchSamples (q: the first quieted block after the static prefix), and
 * cutSamples never passes the static prefix.
 */
export function onsetTrim(head: Int16Array, searchSamples: number): OnsetTrim {
	const n = Math.min(head.length, Math.max(0, Math.floor(searchSamples)))
	const blocks = Math.floor(n / ONSET_BLOCK_SAMPLES)
	if (blocks < ONSET_LEAD_BLOCKS + ONSET_HOLD_BLOCKS)
		return { cutSamples: 0, onsetSamples: null }
	const db = new Float64Array(blocks)
	for (let b = 0; b < blocks; b++) {
		const from = b * ONSET_BLOCK_SAMPLES
		let e = 0
		// The file's first two samples have no history: they repeat the first sample (no step).
		let p1 = head[Math.max(0, from - 1)]!
		let p2 = head[Math.max(0, from - 2)]!
		if (from === 0) p2 = p1
		for (let i = from; i < from + ONSET_BLOCK_SAMPLES; i++) {
			const x = head[i]!
			const d = x - 2 * p1 + p2
			e += d * d
			p2 = p1
			p1 = x
		}
		// +1: an all-zero block reads 0 dB, not −∞.
		db[b] = 10 * Math.log10(e / ONSET_BLOCK_SAMPLES + 1)
	}
	const lead = Array.from(db.subarray(0, ONSET_LEAD_BLOCKS)).sort(
		(a, b) => a - b,
	)[Math.floor(ONSET_LEAD_BLOCKS / 2)]!
	const floor = lead - ONSET_DROP_DB
	let prefix = 0
	while (
		prefix < blocks &&
		Math.abs(db[prefix]! - lead) <= ONSET_STATIC_SPREAD_DB
	)
		prefix++
	let run = 0
	for (let b = 0; b < blocks; b++) {
		if (db[b]! <= floor) run++
		else run = 0
		if (run === ONSET_HOLD_BLOCKS) {
			const first = b - ONSET_HOLD_BLOCKS + 1
			const onset = first * ONSET_BLOCK_SAMPLES
			if (
				prefix < ONSET_MIN_STATIC_BLOCKS ||
				first - prefix > ONSET_TRANSITION_BLOCKS
			)
				return { cutSamples: 0, onsetSamples: onset }
			// The pre-roll is measured back from the first quieted block after the static (a quieting
			// that does not hold yet, or a sound between it and the onset, keeps its start).
			let quiet = prefix
			while (quiet < first && db[quiet]! > floor) quiet++
			return {
				cutSamples: Math.max(
					0,
					Math.min(
						quiet * ONSET_BLOCK_SAMPLES - ONSET_KEEP_SAMPLES,
						prefix * ONSET_BLOCK_SAMPLES,
					),
				),
				onsetSamples: onset,
			}
		}
	}
	return { cutSamples: 0, onsetSamples: null }
}

/**
 * A copy of `pcm` with a raised-cosine fade-in over its first ONSET_FADE_SAMPLES samples
 * (g(i) = ½ − ½·cos(π·i / ONSET_FADE_SAMPLES): 0 at the first sample); a shorter `pcm` is faded
 * over its own length of that curve. The input is never changed (queued audio is a view).
 */
export function fadeIn(pcm: Int16Array): Int16Array {
	const out = Int16Array.from(pcm)
	const n = Math.min(out.length, ONSET_FADE_SAMPLES)
	for (let i = 0; i < n; i++)
		out[i] = Math.round(
			out[i]! * (0.5 - 0.5 * Math.cos((Math.PI * i) / ONSET_FADE_SAMPLES)),
		)
	return out
}
