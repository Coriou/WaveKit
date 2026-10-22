/**
 * CTCSS detector for one analog transmission (WG2 req 7.2).
 *
 * Samples are mono at 8 kHz (the tone detector decimates). A 500 ms Goertzel
 * block hops by 250 ms. A block votes when its tone is at least 0.65 of the
 * 50–300 Hz band power and at least 3× the next tone. Two consecutive blocks
 * must agree, with tone power at least 1% of whole-audio power. At least
 * 60% of completed blocks must vote for the result. The qualified tone with
 * the most votes wins; a tie
 * goes to the tone that first won a block, then the earlier table entry.
 */

const RATE_HZ = 8_000
const BLOCK_SAMPLES = 4_000
const HOP_SAMPLES = 2_000
/** Two blocks: 500 ms plus one 250 ms hop. */
const MIN_SAMPLES = BLOCK_SAMPLES + HOP_SAMPLES
const BAND_FRACTION = 0.65
const NEXT_BEST_RATIO = 3
const CONSECUTIVE_BLOCKS = 2
/** A narrow leakage line must not qualify against an almost empty sub-audible band. */
const RAW_POWER_FRACTION = 0.01
/** A transient pair of overlapping windows is not a transmission-long tone. */
const MIN_VOTE_FRACTION = 0.6
/** Ignore numerical dust so a silent band cannot win on a ratio of zeros. */
const MIN_POWER = 1e-12

/** The 50 EIA/TIA-603 CTCSS tones, 67.0–254.1 Hz, low to high. */
export const CTCSS_HZ = [
	67, 69.3, 71.9, 74.4, 77, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100,
	103.5, 107.2, 110.9, 114.8, 118.8, 123, 127.3, 131.8, 136.5, 141.3, 146.2,
	151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5,
	186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1,
	233.6, 241.8, 250.3, 254.1,
] as const

const TONE_SET = new Set<number>(CTCSS_HZ)

export function isCtcssToneHz(hz: number): boolean {
	return TONE_SET.has(hz)
}

/**
 * Qualified tone with the most block wins. Ties break to the earliest first
 * win, then the earlier table index.
 */
export function selectCtcssTone(
	votes: ArrayLike<number>,
	qualified: ArrayLike<number>,
	firstBlock: ArrayLike<number>,
): number | null {
	let bestIndex = -1
	let bestVotes = -1
	let bestFirst = Number.POSITIVE_INFINITY
	for (let i = 0; i < CTCSS_HZ.length; i++) {
		if ((qualified[i] ?? 0) === 0) continue
		const won = votes[i] ?? 0
		if (won <= 0) continue
		const first = firstBlock[i] ?? Number.POSITIVE_INFINITY
		const earlier =
			won > bestVotes ||
			(won === bestVotes &&
				(first < bestFirst || (first === bestFirst && i < bestIndex)))
		if (!earlier) continue
		bestIndex = i
		bestVotes = won
		bestFirst = first
	}
	if (bestIndex < 0) return null
	return CTCSS_HZ[bestIndex] ?? null
}

interface Biquad {
	readonly b0: number
	readonly b1: number
	readonly b2: number
	readonly a1: number
	readonly a2: number
}

/** Butterworth Q = 1/√2. One section, normalised. */
function biquad(kind: "low" | "high", freqHz: number): Biquad {
	const w0 = (2 * Math.PI * freqHz) / RATE_HZ
	const cos = Math.cos(w0)
	const alpha = Math.sin(w0) / Math.SQRT2
	const a0 = 1 + alpha
	if (kind === "low") {
		const b0 = (1 - cos) / 2 / a0
		return {
			b0,
			b1: (1 - cos) / a0,
			b2: b0,
			a1: (-2 * cos) / a0,
			a2: (1 - alpha) / a0,
		}
	}
	const b0 = (1 + cos) / 2 / a0
	return {
		b0,
		b1: -(1 + cos) / a0,
		b2: b0,
		a1: (-2 * cos) / a0,
		a2: (1 - alpha) / a0,
	}
}

/**
 * Streaming CTCSS bank. `pushSample` does not allocate after construction.
 * Band power is the block's raw power minus a 40 Hz low-pass and a 400 Hz
 * high-pass (both 2nd-order Butterworth). Those cutoffs sit outside
 * 50–300 Hz, so an in-band tone near 290 Hz is counted in the denominator
 * with the same weight as the Goertzel numerator. A cascade cut off at
 * 300 Hz was attenuating that edge and letting a mid-band tone look like
 * more than 0.65 of the band.
 */
export class CtcssBank {
	private readonly coeffs = new Float64Array(CTCSS_HZ.length)
	private readonly powers = new Float64Array(CTCSS_HZ.length)
	private readonly raw = new Float64Array(BLOCK_SAMPLES)
	private readonly below = new Float64Array(BLOCK_SAMPLES)
	private readonly above = new Float64Array(BLOCK_SAMPLES)
	private readonly block = new Float64Array(BLOCK_SAMPLES)
	private readonly votes = new Uint32Array(CTCSS_HZ.length)
	private readonly qualified = new Uint8Array(CTCSS_HZ.length)
	private readonly firstBlock = new Int32Array(CTCSS_HZ.length)
	private readonly high: Biquad
	private readonly low: Biquad
	private hp1 = 0
	private hp2 = 0
	private lp1 = 0
	private lp2 = 0
	private write = 0
	private seen = 0
	private nextAt = BLOCK_SAMPLES
	private blockIndex = 0
	private lastWinner = -1
	private streak = 0
	/** Table index that won the most recent analysis block, or -1 (WG7 streaming view). */
	private lastBlockWinner = -1

	constructor() {
		for (let i = 0; i < CTCSS_HZ.length; i++) {
			this.coeffs[i] =
				2 * Math.cos((2 * Math.PI * (CTCSS_HZ[i] ?? 0)) / RATE_HZ)
		}
		this.high = biquad("high", 400)
		this.low = biquad("low", 40)
		this.firstBlock.fill(-1)
	}

	pushSample(sample: number): void {
		const high = this.high
		const low = this.low
		const above = high.b0 * sample + this.hp1
		this.hp1 = high.b1 * sample - high.a1 * above + this.hp2
		this.hp2 = high.b2 * sample - high.a2 * above
		const below = low.b0 * sample + this.lp1
		this.lp1 = low.b1 * sample - low.a1 * below + this.lp2
		this.lp2 = low.b2 * sample - low.a2 * below
		this.raw[this.write] = sample
		this.below[this.write] = below
		this.above[this.write] = above
		this.write += 1
		if (this.write === BLOCK_SAMPLES) this.write = 0
		this.seen += 1
		if (this.seen !== this.nextAt) return
		this.analyse()
		this.nextAt += HOP_SAMPLES
	}

	/**
	 * WG7 streaming per-block result: the number of 500 ms analysis blocks run so far
	 * (one every 250 ms hop after the first). A caller compares it between pushes to see
	 * a new block. Does not affect `result()`.
	 */
	blockCount(): number {
		return this.blockIndex
	}

	/**
	 * WG7 streaming per-block result: the table index (into `CTCSS_HZ`) that won the most
	 * recent analysis block (≥ 0.65 of the band and ≥ 3× the next tone), or -1 when no tone
	 * won it or no block has run. The block also needs 1% of whole-audio power.
	 * Does not affect `result()`; the latter additionally requires 60% continuity.
	 */
	lastBlockToneIndex(): number {
		return this.lastBlockWinner
	}

	result(): number | null {
		if (this.seen < MIN_SAMPLES) return null
		const tone = selectCtcssTone(this.votes, this.qualified, this.firstBlock)
		if (tone === null) return null
		const votes =
			this.votes[CTCSS_HZ.indexOf(tone as (typeof CTCSS_HZ)[number])] ?? 0
		return votes >= Math.ceil(this.blockIndex * MIN_VOTE_FRACTION) ? tone : null
	}

	reset(): void {
		this.raw.fill(0)
		this.below.fill(0)
		this.above.fill(0)
		this.block.fill(0)
		this.powers.fill(0)
		this.votes.fill(0)
		this.qualified.fill(0)
		this.firstBlock.fill(-1)
		this.hp1 = 0
		this.hp2 = 0
		this.lp1 = 0
		this.lp2 = 0
		this.write = 0
		this.seen = 0
		this.nextAt = BLOCK_SAMPLES
		this.blockIndex = 0
		this.lastWinner = -1
		this.streak = 0
		this.lastBlockWinner = -1
	}

	private analyse(): void {
		const start = this.write
		let rawEnergy = 0
		let belowEnergy = 0
		let aboveEnergy = 0
		for (let i = 0; i < BLOCK_SAMPLES; i++) {
			const index = start + i
			const at = index < BLOCK_SAMPLES ? index : index - BLOCK_SAMPLES
			const sample = this.raw[at] ?? 0
			const below = this.below[at] ?? 0
			const above = this.above[at] ?? 0
			this.block[i] = sample
			rawEnergy += sample * sample
			belowEnergy += below * below
			aboveEnergy += above * above
		}
		const bandEnergy = Math.max(0, rawEnergy - belowEnergy - aboveEnergy)
		const powers = this.powers
		const coeffs = this.coeffs
		const block = this.block
		for (let tone = 0; tone < CTCSS_HZ.length; tone++) {
			const coeff = coeffs[tone] ?? 0
			let s1 = 0
			let s2 = 0
			for (let n = 0; n < BLOCK_SAMPLES; n++) {
				const s0 = (block[n] ?? 0) + coeff * s1 - s2
				s2 = s1
				s1 = s0
			}
			const power = s1 * s1 + s2 * s2 - coeff * s1 * s2
			powers[tone] = power > 0 ? power : 0
		}
		let best = 0
		let second = 1
		if ((powers[1] ?? 0) > (powers[0] ?? 0)) {
			best = 1
			second = 0
		}
		for (let tone = 2; tone < CTCSS_HZ.length; tone++) {
			const power = powers[tone] ?? 0
			if (power > (powers[best] ?? 0)) {
				second = best
				best = tone
			} else if (power > (powers[second] ?? 0)) {
				second = tone
			}
		}
		const scale = BLOCK_SAMPLES * BLOCK_SAMPLES
		const bestPower = (2 * (powers[best] ?? 0)) / scale
		const bandMean = bandEnergy / BLOCK_SAMPLES
		const nextPower = powers[second] ?? 0
		const bestRaw = powers[best] ?? 0
		const dominates =
			nextPower <= 0 ? bestRaw > 0 : bestRaw >= NEXT_BEST_RATIO * nextPower
		const inBand =
			bandMean > MIN_POWER &&
			bestPower > MIN_POWER &&
			bestPower >= BAND_FRACTION * bandMean &&
			bestPower >= RAW_POWER_FRACTION * (rawEnergy / BLOCK_SAMPLES)
		const winner = inBand && dominates ? best : -1
		this.lastBlockWinner = winner
		if (winner >= 0 && winner === this.lastWinner) this.streak += 1
		else if (winner >= 0) {
			this.streak = 1
			this.lastWinner = winner
		} else {
			this.streak = 0
			this.lastWinner = -1
		}
		if (winner >= 0) {
			this.votes[winner] = (this.votes[winner] ?? 0) + 1
			if (this.firstBlock[winner] === -1)
				this.firstBlock[winner] = this.blockIndex
			if (this.streak >= CONSECUTIVE_BLOCKS) this.qualified[winner] = 1
		}
		this.blockIndex += 1
	}
}
