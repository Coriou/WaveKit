/**
 * Squelch-tail elimination (STE) tone detector (amendment A17, 2026-10-24). Many analog radios
 * key a 55 Hz tone for about 0.4 s after PTT release, before the carrier drops, so a receiver can
 * close before the discriminator noise burst. Live run6: a 55 Hz peak with about 99 % of the
 * audio energy, 0.38-0.40 s, at the end of every over, toned or not.
 *
 * Rule, on the gate's 8 kHz samples: a 100 ms block (800 samples) qualifies when the Goertzel
 * power at `STE_HZ` holds at least `STE_BAND_FRACTION` of the block's AC energy (the 55 Hz bin
 * "wins the band": a tone 5 Hz away, 50 or 60 Hz mains hum, keeps only 0.41 of it) and at least
 * `STE_NEXT_RATIO` times the power at 45 Hz and at 67.0 Hz (the lowest CTCSS tone). One
 * qualifying block is at least 100 ms of tone. Four block phases run 25 ms apart, so a tone of
 * at least 125 ms always fills one block, and the first qualifying block starts at most 25 ms
 * after the tone's onset (`STE_ONSET_SLACK_MS`). The tone must also fill the block: the AC
 * energies of its four 25 ms quarters agree within `STE_STEADY_RATIO`, so a tone that stops early
 * (under about 95 ms in the block, with silence after it) never qualifies. Speech, noise, CTCSS
 * and DCS put
 * nearly all their energy elsewhere (speech above 100 Hz, CTCSS at 67-254 Hz, DCS spread over
 * 0-300 Hz), so none of them gives 55 Hz two thirds of a 100 ms block.
 *
 * Allocation free: four phases of three Goertzel resonators and two sums each.
 */
import { AUDIO_TONE_RATE_HZ } from "../audio-tones/tone-detector.js"

export const STE_HZ = 55
/** Block length: 100 ms at 8 kHz. */
export const STE_BLOCK_SAMPLES = 800
/** Block phases (25 ms apart). */
const STE_PHASES = 4
/** Latest start of the first qualifying block after the tone's onset. */
export const STE_ONSET_SLACK_MS = 25
/** Fraction of the block's AC energy the 55 Hz bin must hold. */
export const STE_BAND_FRACTION = 0.65
/** 55 Hz power over the 45 Hz and the 67.0 Hz power, each. */
export const STE_NEXT_RATIO = 3
const NEIGHBOUR_LOW_HZ = 45
const NEIGHBOUR_HIGH_HZ = 67

function coefficient(hz: number): number {
	return 2 * Math.cos((2 * Math.PI * hz) / AUDIO_TONE_RATE_HZ)
}

const C_STE = coefficient(STE_HZ)
const C_LOW = coefficient(NEIGHBOUR_LOW_HZ)
const C_HIGH = coefficient(NEIGHBOUR_HIGH_HZ)

/** Quarters of a block whose AC energies must agree (a tone that fills the block). */
const QUARTERS = 4
/** Weakest quarter's energy over the strongest's: a 55 Hz tone of 95 ms or more in the block. */
export const STE_STEADY_RATIO = 0.8

class Phase {
	count = 0
	sum = 0
	sumSq = 0
	readonly qSum = new Float64Array(QUARTERS)
	readonly qSq = new Float64Array(QUARTERS)
	s1 = 0
	s2 = 0
	l1 = 0
	l2 = 0
	h1 = 0
	h2 = 0

	reset(): void {
		this.count = 0
		this.sum = 0
		this.sumSq = 0
		this.qSum.fill(0)
		this.qSq.fill(0)
		this.s1 = 0
		this.s2 = 0
		this.l1 = 0
		this.l2 = 0
		this.h1 = 0
		this.h2 = 0
	}

	/** One sample; true when the block just completed and qualified (the phase restarts). */
	push(x: number): boolean {
		const q = Math.floor((this.count * QUARTERS) / STE_BLOCK_SAMPLES)
		this.count += 1
		this.sum += x
		this.sumSq += x * x
		this.qSum[q] = (this.qSum[q] ?? 0) + x
		this.qSq[q] = (this.qSq[q] ?? 0) + x * x
		let s = x + C_STE * this.s1 - this.s2
		this.s2 = this.s1
		this.s1 = s
		s = x + C_LOW * this.l1 - this.l2
		this.l2 = this.l1
		this.l1 = s
		s = x + C_HIGH * this.h1 - this.h2
		this.h2 = this.h1
		this.h1 = s
		if (this.count < STE_BLOCK_SAMPLES) return false
		const n = this.count
		const ac = this.sumSq - (this.sum * this.sum) / n
		const ste = power(this.s1, this.s2, C_STE)
		const low = power(this.l1, this.l2, C_LOW)
		const high = power(this.h1, this.h2, C_HIGH)
		// The tone must fill the block: every quarter carries nearly the same AC energy.
		const m = STE_BLOCK_SAMPLES / QUARTERS
		let qMin = Infinity
		let qMax = 0
		for (let i = 0; i < QUARTERS; i++) {
			const e =
				(this.qSq[i] ?? 0) - ((this.qSum[i] ?? 0) * (this.qSum[i] ?? 0)) / m
			if (e < qMin) qMin = e
			if (e > qMax) qMax = e
		}
		this.reset()
		if (!(ac > 1e-12) || !Number.isFinite(ste)) return false
		if (!(qMin >= STE_STEADY_RATIO * qMax)) return false
		// A sinusoid at the bin holds 2 |X|² / N of the block energy.
		const fraction = (2 * ste) / (n * ac)
		return (
			fraction >= STE_BAND_FRACTION &&
			ste >= STE_NEXT_RATIO * low &&
			ste >= STE_NEXT_RATIO * high
		)
	}
}

function power(s1: number, s2: number, c: number): number {
	return s1 * s1 + s2 * s2 - c * s1 * s2
}

export class SteDetector {
	private readonly phases: readonly Phase[] = Array.from(
		{ length: STE_PHASES },
		() => new Phase(),
	)
	/** Samples since reset, capped once every phase runs. */
	private started = 0

	/** One 8 kHz sample. True when a block of at least 100 ms of STE tone just completed. */
	push(x: number): boolean {
		const value = Number.isFinite(x) ? x : 0
		const hop = STE_BLOCK_SAMPLES / STE_PHASES
		if (this.started < STE_BLOCK_SAMPLES) this.started += 1
		let hit = false
		for (let i = 0; i < this.phases.length; i++) {
			// Phase i starts i hops after a reset.
			if (this.started <= i * hop) continue
			if (this.phases[i]?.push(value) === true) hit = true
		}
		return hit
	}

	reset(): void {
		for (const phase of this.phases) phase.reset()
		this.started = 0
	}
}
