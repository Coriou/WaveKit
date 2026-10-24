/**
 * Reverse-burst squelch-tail elimination (amendment A20, 2026-10-24). After PTT release, many
 * analog radios shift the phase of their CTCSS tone by 180° (some 120°) for about 150-200 ms
 * with the microphone muted, then drop the carrier. The CTCSS bank measures power only, so this
 * tracker follows the phase of the one latched tone.
 *
 * Coherent 40 ms blocks (`REVERSE_BURST_BLOCK_SAMPLES` at 8 kHz) of `x · e^{-jωn}` with a
 * phase-continuous oscillator at the tone's standard frequency (re-seeded from an exact cycle
 * count at every block start). The last 8 block phasors sit in a ring, oldest first: blocks
 * `k - 5 .. k + 2`, with `k` the block that may hold the reversal. Each completed block is stored,
 * then the rule runs with the newest block as `k + 2` (first evaluation once 8 blocks completed,
 * 320 ms after arming). It fires when all of:
 * (a) the 4 increments `k-5 -> k-4 .. k-2 -> k-1` lie within `REVERSE_BURST_STEADY_DEG` of their
 *     circular mean (the drift: a ±0.5 Hz transmitter error is 7.2° per block);
 * (b) the magnitudes of blocks `k-5 .. k-1` have a coefficient of variation of at most
 *     `REVERSE_BURST_MAGNITUDE_CV`;
 * (c) `wrap(φ(k+1) - φ(k-1) - 2 drift)` is at least `REVERSE_BURST_STEP_DEG` in magnitude;
 * (d) `wrap(φ(k+2) - φ(k+1) - drift)` lies within the steadiness bound (the new phase persists);
 * (e) blocks `k-1`, `k+1` and `k+2` keep at least `REVERSE_BURST_MAGNITUDE_RATIO` of the median
 *     magnitude of blocks `k-5 .. k-1`.
 * The reversal may lie in block `k` or `k + 1` (a mixed block that passes (c)-(e)): its position
 * is estimated from the two mixed-block phasors against the pre phasor (block `k-1` advanced by
 * the drift) and the post phasor (block `k+2` taken back by it), the fraction of each block that
 * is still pre-reversal, and the onset is that position less `REVERSE_BURST_ONSET_MARGIN`
 * samples. Allocation free after construction.
 */
import { AUDIO_TONE_RATE_HZ } from "../audio-tones/tone-detector.js"

/** Block length: 40 ms at 8 kHz. */
export const REVERSE_BURST_BLOCK_SAMPLES = 320
/** Phase increments of steady history before block `k`. */
export const REVERSE_BURST_HISTORY_BLOCKS = 4
/** Ring length: history (5 blocks), block `k`, `k + 1` and `k + 2`. */
export const REVERSE_BURST_RING_BLOCKS = REVERSE_BURST_HISTORY_BLOCKS + 4
export const REVERSE_BURST_STEADY_DEG = 25
export const REVERSE_BURST_STEP_DEG = 90
export const REVERSE_BURST_MAGNITUDE_RATIO = 0.5
export const REVERSE_BURST_MAGNITUDE_CV = 0.3
/** 8 kHz samples the onset is placed before the estimated reversal (10 ms). */
export const REVERSE_BURST_ONSET_MARGIN = 80

const N = REVERSE_BURST_BLOCK_SAMPLES
const RING = REVERSE_BURST_RING_BLOCKS
const HIST = REVERSE_BURST_HISTORY_BLOCKS + 1
const STEADY = (REVERSE_BURST_STEADY_DEG * Math.PI) / 180
const STEP = (REVERSE_BURST_STEP_DEG * Math.PI) / 180
const TWO_PI = 2 * Math.PI

function wrap(x: number): number {
	const y = (x + Math.PI) % TWO_PI
	return (y < 0 ? y + TWO_PI : y) - Math.PI
}

export class ReverseBurstTracker {
	private hz = 0
	private on = false
	private stepC = 1
	private stepS = 0
	private loC = 1
	private loS = 0
	/** Fractional oscillator cycles at the current block's start. */
	private cycles = 0
	private count = 0
	private accRe = 0
	private accIm = 0
	private blockStart = 0
	/** Blocks completed since the last arm or restart. */
	private blocks = 0
	/** Ring slot of the oldest block. */
	private head = 0
	private readonly re = new Float64Array(RING)
	private readonly im = new Float64Array(RING)
	private readonly start = new Float64Array(RING)
	private readonly ph = new Float64Array(RING)
	private readonly mag = new Float64Array(RING)
	private readonly sorted = new Float64Array(HIST)
	private onset = 0

	get armed(): boolean {
		return this.on
	}

	/** Frequency the tracker is armed on (0 when disarmed). */
	get toneHz(): number {
		return this.on ? this.hz : 0
	}

	/** Input-sample index of the estimated onset (valid after `push` returned true). */
	get onsetIndex(): number {
		return this.onset
	}

	/** Arms on `hz` from an empty history (A20.1). */
	arm(hz: number): void {
		if (!(hz > 0) || !Number.isFinite(hz)) {
			this.disarm()
			return
		}
		this.hz = hz
		const w = (TWO_PI * hz) / AUDIO_TONE_RATE_HZ
		this.stepC = Math.cos(w)
		this.stepS = Math.sin(w)
		this.on = true
		this.restart()
	}

	/** Empty history and a fresh block, same tone (a stage-1 reopen, A20.1). */
	restart(): void {
		this.loC = 1
		this.loS = 0
		this.cycles = 0
		this.count = 0
		this.accRe = 0
		this.accIm = 0
		this.blocks = 0
		this.head = 0
	}

	disarm(): void {
		this.on = false
		this.restart()
	}

	/**
	 * One 8 kHz sample; `index` is the caller's input-sample index of its first input sample.
	 * True once when a reversal is detected (the tracker is then disarmed).
	 */
	push(x: number, index: number): boolean {
		if (!this.on) return false
		const value = Number.isFinite(x) ? x : 0
		if (this.count === 0) this.blockStart = index
		const c = this.loC
		const s = this.loS
		this.accRe += value * c
		this.accIm -= value * s
		this.loC = c * this.stepC - s * this.stepS
		this.loS = s * this.stepC + c * this.stepS
		this.count += 1
		if (this.count < N) return false
		this.store()
		if (this.blocks < RING) return false
		if (!this.evaluate()) return false
		this.disarm()
		return true
	}

	private store(): void {
		const slot = this.blocks < RING ? this.blocks : this.head
		this.re[slot] = this.accRe
		this.im[slot] = this.accIm
		this.start[slot] = this.blockStart
		this.ph[slot] = Math.atan2(this.accIm, this.accRe)
		this.mag[slot] = Math.hypot(this.accRe, this.accIm)
		if (this.blocks < RING) this.blocks += 1
		else this.head = (this.head + 1) % RING
		this.accRe = 0
		this.accIm = 0
		this.count = 0
		const cycles = this.cycles + (N * this.hz) / AUDIO_TONE_RATE_HZ
		this.cycles = cycles - Math.floor(cycles)
		this.loC = Math.cos(TWO_PI * this.cycles)
		this.loS = Math.sin(TWO_PI * this.cycles)
	}

	/** Ring slot of chronological block `i` (0 = `k - 5`, 7 = `k + 2`). */
	private at(i: number): number {
		return (this.head + i) % RING
	}

	private evaluate(): boolean {
		const ph = this.ph
		const mag = this.mag
		let sumS = 0
		let sumC = 0
		for (let i = 0; i < HIST - 1; i++) {
			const inc = wrap((ph[this.at(i + 1)] ?? 0) - (ph[this.at(i)] ?? 0))
			sumS += Math.sin(inc)
			sumC += Math.cos(inc)
		}
		const drift = Math.atan2(sumS, sumC)
		for (let i = 0; i < HIST - 1; i++) {
			const inc = wrap((ph[this.at(i + 1)] ?? 0) - (ph[this.at(i)] ?? 0))
			if (!(Math.abs(wrap(inc - drift)) <= STEADY)) return false
		}
		let mean = 0
		for (let i = 0; i < HIST; i++) mean += mag[this.at(i)] ?? 0
		mean /= HIST
		if (!(mean > 1e-9)) return false
		let variance = 0
		for (let i = 0; i < HIST; i++) {
			const d = (mag[this.at(i)] ?? 0) - mean
			variance += d * d
		}
		if (!(Math.sqrt(variance / HIST) <= REVERSE_BURST_MAGNITUDE_CV * mean))
			return false
		const pre = this.at(HIST - 1)
		const k = this.at(HIST)
		const k1 = this.at(HIST + 1)
		const k2 = this.at(HIST + 2)
		const step = wrap((ph[k1] ?? 0) - (ph[pre] ?? 0) - 2 * drift)
		if (!(Math.abs(step) >= STEP)) return false
		if (!(Math.abs(wrap((ph[k2] ?? 0) - (ph[k1] ?? 0) - drift)) <= STEADY))
			return false
		const ref = this.median()
		const floor = REVERSE_BURST_MAGNITUDE_RATIO * ref
		if (
			!((mag[pre] ?? 0) >= floor) ||
			!((mag[k1] ?? 0) >= floor) ||
			!((mag[k2] ?? 0) >= floor)
		)
			return false
		const fk = this.preFraction(k, 1, 2, drift)
		const fk1 = this.preFraction(k1, 2, 1, drift)
		const position = fk + fk1
		const startK = this.start[k] ?? 0
		const startK1 = this.start[k1] ?? 0
		const startK2 = this.start[k2] ?? 0
		const perK = (startK1 - startK) / N
		const perK1 = (startK2 - startK1) / N
		const at =
			position < 1
				? startK + position * N * perK
				: startK1 + (position - 1) * N * perK1
		const margin = REVERSE_BURST_ONSET_MARGIN * (perK > 0 ? perK : 1)
		this.onset = Math.max(this.start[pre] ?? 0, Math.round(at - margin))
		return true
	}

	/**
	 * Fraction of the block at `slot` still before the reversal: its phasor projected on the
	 * segment from the post phasor to the pre phasor (block `k-1` advanced `ahead` blocks by the
	 * drift, block `k+2` taken back `back` blocks), clamped to [0, 1].
	 */
	private preFraction(
		slot: number,
		ahead: number,
		back: number,
		drift: number,
	): number {
		const pre = this.at(HIST - 1)
		const post = this.at(HIST + 2)
		const aC = Math.cos(drift * ahead)
		const aS = Math.sin(drift * ahead)
		const bC = Math.cos(-drift * back)
		const bS = Math.sin(-drift * back)
		const pRe = (this.re[pre] ?? 0) * aC - (this.im[pre] ?? 0) * aS
		const pIm = (this.re[pre] ?? 0) * aS + (this.im[pre] ?? 0) * aC
		const qRe = (this.re[post] ?? 0) * bC - (this.im[post] ?? 0) * bS
		const qIm = (this.re[post] ?? 0) * bS + (this.im[post] ?? 0) * bC
		const dRe = pRe - qRe
		const dIm = pIm - qIm
		const norm = dRe * dRe + dIm * dIm
		if (!(norm > 0)) return 0.5
		const xRe = (this.re[slot] ?? 0) - qRe
		const xIm = (this.im[slot] ?? 0) - qIm
		const a = (xRe * dRe + xIm * dIm) / norm
		return a < 0 ? 0 : a > 1 ? 1 : a
	}

	private median(): number {
		const sorted = this.sorted
		for (let i = 0; i < HIST; i++) sorted[i] = this.mag[this.at(i)] ?? 0
		sorted.sort()
		return sorted[(HIST - 1) >> 1] ?? 0
	}
}
