/**
 * Squelch-tail elimination (STE) tone detector (amendment A17, 2026-10-24; review revision). Many
 * analog radios key a 55 Hz tone for about 0.4 s after PTT release, with the microphone muted and
 * the carrier still up, so a receiver can close before the discriminator noise burst. Live
 * run6: a 55 Hz peak with about 99 % of the audio energy, 0.38-0.40 s, at the end of every over,
 * toned or not.
 *
 * Rule, on the gate's 8 kHz samples, per 100 ms block (800 samples), all of:
 * - the 55 Hz Goertzel bin holds at least `STE_BAND_FRACTION` (0.65) of the block's AC energy
 *   (it "wins the band": 50 or 60 Hz hum keeps only 0.41 of it);
 * - it is at least `STE_NEXT_RATIO` (3) times the 45 Hz and the 67.0 Hz bins;
 * - harmonics are absent (a pure tone, not a voiced fundamental): the 110 and 165 Hz bins are
 *   each at most `STE_HARMONIC_RATIO` (0.02, -17 dB) of the 55 Hz bin;
 * - the voice band is quiet (microphone muted): the 300-3 000 Hz energy is at most
 *   `STE_VOICE_BAND_DB` (-15 dB) relative to the 55 Hz tone's energy;
 * - the tone fills the block: the 55 Hz phasor magnitudes of the four 25 ms quarters agree
 *   within `STE_STEADY_RATIO` (0.6). Measured on the 55 Hz bin itself, a CTCSS tone continuing
 *   through the STE (beating against it) leaves the quarters within 0.64-0.74 (67-79.7 Hz at 0.2
 *   of the STE amplitude), while a tone ending inside the block leaves a quarter short.
 * Measured on the live STE segments (runs 2, 3, 4, 6): harmonics at most 0.006 (110 Hz) and
 * 0.0016 (165 Hz), voice band -18.5 to -28.7 dB in steady blocks, quarters 0.86-0.89.
 *
 * Four block phases run 25 ms apart, so a tone of at least 125 ms always fills one block, and
 * the first qualifying block starts at most 25 ms after the tone's onset. A tone under 90 ms
 * never qualifies (its last quarter holds under 0.6 of a full one), whatever follows it.
 *
 * Allocation free after construction: shared cos/sin tables, two biquads, four phases of scalar
 * accumulators.
 */
import { AUDIO_TONE_RATE_HZ } from "../audio-tones/tone-detector.js"

export const STE_HZ = 55
/** Block length: 100 ms at 8 kHz. */
export const STE_BLOCK_SAMPLES = 800
/** Block phases (25 ms apart). */
const STE_PHASES = 4
/** Latest start of the first qualifying block after the tone's onset. */
export const STE_ONSET_SLACK_MS = 25
export const STE_BAND_FRACTION = 0.65
export const STE_NEXT_RATIO = 3
export const STE_HARMONIC_RATIO = 0.02
export const STE_VOICE_BAND_DB = -15
export const STE_STEADY_RATIO = 0.6
const QUARTERS = 4
const QUARTER = STE_BLOCK_SAMPLES / QUARTERS
const VOICE_BAND_RATIO = 10 ** (STE_VOICE_BAND_DB / 10)

function coefficient(hz: number): number {
	return 2 * Math.cos((2 * Math.PI * hz) / AUDIO_TONE_RATE_HZ)
}

const C55 = coefficient(STE_HZ)
const C45 = coefficient(45)
const C67 = coefficient(67)
const C110 = coefficient(110)
const C165 = coefficient(165)

/** e^{-jωn} for the 55 Hz quarter phasors, n = 0..799. */
const COS = new Float64Array(STE_BLOCK_SAMPLES)
const SIN = new Float64Array(STE_BLOCK_SAMPLES)
for (let n = 0; n < STE_BLOCK_SAMPLES; n++) {
	const w = (2 * Math.PI * STE_HZ * n) / AUDIO_TONE_RATE_HZ
	COS[n] = Math.cos(w)
	SIN[n] = Math.sin(w)
}

class Resonator {
	s1 = 0
	s2 = 0
	constructor(readonly c: number) {}
	step(x: number): void {
		const s = x + this.c * this.s1 - this.s2
		this.s2 = this.s1
		this.s1 = s
	}
	power(): number {
		return this.s1 * this.s1 + this.s2 * this.s2 - this.c * this.s1 * this.s2
	}
	reset(): void {
		this.s1 = 0
		this.s2 = 0
	}
}

class Biquad {
	private x1 = 0
	private x2 = 0
	private y1 = 0
	private y2 = 0
	private readonly b0: number
	private readonly b1: number
	private readonly a1: number
	private readonly a2: number
	/** RBJ cookbook, Q = 1/√2. */
	constructor(high: boolean, hz: number) {
		const w0 = (2 * Math.PI * hz) / AUDIO_TONE_RATE_HZ
		const cos = Math.cos(w0)
		const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
		const a0 = 1 + alpha
		this.b0 = (high ? (1 + cos) / 2 : (1 - cos) / 2) / a0
		this.b1 = (high ? -(1 + cos) : 1 - cos) / a0
		this.a1 = (-2 * cos) / a0
		this.a2 = (1 - alpha) / a0
	}
	step(x: number): number {
		const y =
			this.b0 * x +
			this.b1 * this.x1 +
			this.b0 * this.x2 -
			this.a1 * this.y1 -
			this.a2 * this.y2
		this.x2 = this.x1
		this.x1 = x
		this.y2 = this.y1
		this.y1 = y
		return y
	}
	reset(): void {
		this.x1 = 0
		this.x2 = 0
		this.y1 = 0
		this.y2 = 0
	}
}

class Phase {
	count = 0
	sum = 0
	sumSq = 0
	bandSq = 0
	start = 0
	readonly qRe = new Float64Array(QUARTERS)
	readonly qIm = new Float64Array(QUARTERS)
	readonly r55 = new Resonator(C55)
	readonly r45 = new Resonator(C45)
	readonly r67 = new Resonator(C67)
	readonly r110 = new Resonator(C110)
	readonly r165 = new Resonator(C165)

	reset(): void {
		this.count = 0
		this.sum = 0
		this.sumSq = 0
		this.bandSq = 0
		this.qRe.fill(0)
		this.qIm.fill(0)
		this.r55.reset()
		this.r45.reset()
		this.r67.reset()
		this.r110.reset()
		this.r165.reset()
	}

	/** One sample (`band`: its 300-3 000 Hz part); true when the block completed and qualified. */
	push(x: number, band: number, index: number): boolean {
		const n = this.count
		if (n === 0) this.start = index
		const q = Math.floor(n / QUARTER)
		this.qRe[q] = (this.qRe[q] ?? 0) + x * (COS[n] ?? 0)
		this.qIm[q] = (this.qIm[q] ?? 0) - x * (SIN[n] ?? 0)
		this.count = n + 1
		this.sum += x
		this.sumSq += x * x
		this.bandSq += band * band
		this.r55.step(x)
		this.r45.step(x)
		this.r67.step(x)
		this.r110.step(x)
		this.r165.step(x)
		if (this.count < STE_BLOCK_SAMPLES) return false
		const ok = this.qualifies()
		this.reset()
		return ok
	}

	private qualifies(): boolean {
		const n = this.count
		const ac = this.sumSq - (this.sum * this.sum) / n
		const p55 = this.r55.power()
		if (!(ac > 1e-12) || !Number.isFinite(p55)) return false
		// A sinusoid at the bin holds 2 |X|² / N of the block energy.
		const tone = (2 * p55) / n
		if (!(tone >= STE_BAND_FRACTION * ac)) return false
		if (!(p55 >= STE_NEXT_RATIO * this.r45.power())) return false
		if (!(p55 >= STE_NEXT_RATIO * this.r67.power())) return false
		if (!(this.r110.power() <= STE_HARMONIC_RATIO * p55)) return false
		if (!(this.r165.power() <= STE_HARMONIC_RATIO * p55)) return false
		if (!(this.bandSq <= VOICE_BAND_RATIO * tone)) return false
		let min = Infinity
		let max = 0
		for (let i = 0; i < QUARTERS; i++) {
			const m = Math.hypot(this.qRe[i] ?? 0, this.qIm[i] ?? 0)
			if (m < min) min = m
			if (m > max) max = m
		}
		return max > 0 && min >= STE_STEADY_RATIO * max
	}
}

export class SteDetector {
	private readonly phases: readonly Phase[] = Array.from(
		{ length: STE_PHASES },
		() => new Phase(),
	)
	private readonly hp = new Biquad(true, 300)
	private readonly lp = new Biquad(false, 3_000)
	/** Samples since reset, capped once every phase runs. */
	private started = 0
	private hitStart = 0

	/**
	 * One 8 kHz sample; `index` is the caller's input-sample index of its first input sample.
	 * True when a qualifying block just completed; `onsetIndex` is then that block's start.
	 */
	push(x: number, index = 0): boolean {
		const value = Number.isFinite(x) ? x : 0
		const band = this.lp.step(this.hp.step(value))
		const hop = STE_BLOCK_SAMPLES / STE_PHASES
		if (this.started < STE_BLOCK_SAMPLES) this.started += 1
		let hit = false
		for (let i = 0; i < this.phases.length; i++) {
			// Phase i starts i hops after a reset.
			if (this.started <= i * hop) continue
			const phase = this.phases[i]
			if (phase === undefined) continue
			const start = phase.count === 0 ? index : phase.start
			if (phase.push(value, band, index)) {
				if (!hit || start < this.hitStart) this.hitStart = start
				hit = true
			}
		}
		return hit
	}

	/** Input-sample index of the qualifying block's start (valid after `push` returned true). */
	get onsetIndex(): number {
		return this.hitStart
	}

	reset(): void {
		for (const phase of this.phases) phase.reset()
		this.hp.reset()
		this.lp.reset()
		this.started = 0
	}
}
