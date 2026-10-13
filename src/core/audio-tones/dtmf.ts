/**
 * DTMF detector for one analog transmission (WG2 req 7.3).
 *
 * Samples are mono at 8 kHz. Each 10 ms window hops by 5 ms. A symbol is a
 * row tone and a column tone that together dominate the window, with twist
 * inside +4/−8 dB (column relative to row) and each tone at least 3× the
 * next tone in its group. The symbol must hold for 40 ms and may repeat
 * only after 40 ms of absence. At most 32 symbols are kept.
 */

const RATE_HZ = 8_000
const WINDOW_SAMPLES = 80
const HOP_SAMPLES = 40
const MIN_ON_SAMPLES = 320
const MIN_GAP_SAMPLES = 320
const MAX_SYMBOLS = 32
/**
 * A 10 ms window can miss a legal tone for about one hop when the two
 * sinusoids beat. That is not the 40 ms inter-digit gap.
 */
const MAX_DROPOUT_HOPS = 3
/** Column dB minus row dB. */
const TWIST_MIN_DB = -8
const TWIST_MAX_DB = 4
/** The pair must be most of the window, so a half-tone edge does not count. */
const PAIR_FRACTION = 0.7
const TONE_FRACTION = 0.08
const GROUP_RATIO = 3

export const DTMF_ROW_HZ = [697, 770, 852, 941] as const
export const DTMF_COLUMN_HZ = [1209, 1336, 1477, 1633] as const

/** Row-major: 697/1209 is `1`, 941/1477 is `#`. */
export const DTMF_CHAR = [
	"1",
	"2",
	"3",
	"A",
	"4",
	"5",
	"6",
	"B",
	"7",
	"8",
	"9",
	"C",
	"*",
	"0",
	"#",
	"D",
] as const

export const DTMF_DIGIT_PATTERN = /^[0-9*#A-D]{1,32}$/

export function isDtmfDigitString(value: string): boolean {
	return DTMF_DIGIT_PATTERN.test(value)
}

function coeff(hz: number): number {
	return 2 * Math.cos((2 * Math.PI * hz) / RATE_HZ)
}

/**
 * Streaming DTMF bank. `pushSample` does not allocate after construction.
 */
export class DtmfBank {
	private readonly rowCoeff = new Float64Array(DTMF_ROW_HZ.map(coeff))
	private readonly colCoeff = new Float64Array(DTMF_COLUMN_HZ.map(coeff))
	private readonly rowPower = new Float64Array(DTMF_ROW_HZ.length)
	private readonly colPower = new Float64Array(DTMF_COLUMN_HZ.length)
	private readonly ring = new Float64Array(WINDOW_SAMPLES)
	private readonly window = new Float64Array(WINDOW_SAMPLES)
	private readonly symbols = new Array<string>(MAX_SYMBOLS)
	private write = 0
	private seen = 0
	private sinceHop = 0
	private count = 0
	private armed = true
	private pending = -1
	private onSamples = 0
	private offSamples = 0
	private dropout = 0

	pushSample(sample: number): void {
		this.ring[this.write] = sample
		this.write += 1
		if (this.write === WINDOW_SAMPLES) this.write = 0
		this.seen += 1
		this.sinceHop += 1
		if (this.seen < WINDOW_SAMPLES || this.sinceHop < HOP_SAMPLES) return
		this.sinceHop = 0
		this.classify()
	}

	result(): string | null {
		if (this.count === 0) return null
		let digits = ""
		for (let i = 0; i < this.count; i++) digits += this.symbols[i] ?? ""
		return digits.length === 0 ? null : digits
	}

	reset(): void {
		this.ring.fill(0)
		this.window.fill(0)
		this.rowPower.fill(0)
		this.colPower.fill(0)
		this.write = 0
		this.seen = 0
		this.sinceHop = 0
		this.count = 0
		this.armed = true
		this.pending = -1
		this.onSamples = 0
		this.offSamples = 0
		this.dropout = 0
	}

	private classify(): void {
		const start = this.write
		let energy = 0
		for (let i = 0; i < WINDOW_SAMPLES; i++) {
			const index = start + i
			const at = index < WINDOW_SAMPLES ? index : index - WINDOW_SAMPLES
			const sample = this.ring[at] ?? 0
			this.window[i] = sample
			energy += sample * sample
		}
		const symbol = energy > 0 ? this.symbol(energy) : -1
		if (symbol >= 0) {
			if (symbol === this.pending) this.onSamples += HOP_SAMPLES
			else {
				this.pending = symbol
				this.onSamples = WINDOW_SAMPLES
			}
			this.dropout = 0
			this.offSamples = 0
			if (this.armed && this.onSamples >= MIN_ON_SAMPLES) {
				if (this.count < MAX_SYMBOLS) {
					this.symbols[this.count] = DTMF_CHAR[symbol] ?? ""
					this.count += 1
				}
				this.armed = false
			}
			return
		}
		if (this.pending >= 0 && this.dropout < MAX_DROPOUT_HOPS) {
			this.dropout += 1
			return
		}
		const absorbed = this.dropout * HOP_SAMPLES
		this.pending = -1
		this.onSamples = 0
		this.dropout = 0
		this.offSamples += HOP_SAMPLES + absorbed
		if (this.offSamples >= MIN_GAP_SAMPLES) this.armed = true
	}

	private symbol(energy: number): number {
		this.measure(this.rowCoeff, this.rowPower)
		this.measure(this.colCoeff, this.colPower)
		const rowIndex = dominant(this.rowPower)
		const colIndex = dominant(this.colPower)
		if (rowIndex < 0 || colIndex < 0) return -1
		const rowBest = this.rowPower[rowIndex] ?? 0
		const colBest = this.colPower[colIndex] ?? 0
		const rowSecond = runnerUp(this.rowPower, rowIndex)
		const colSecond = runnerUp(this.colPower, colIndex)
		const scale = WINDOW_SAMPLES * WINDOW_SAMPLES
		const rowNorm = (2 * rowBest) / scale
		const colNorm = (2 * colBest) / scale
		const mean = energy / WINDOW_SAMPLES
		if (!(mean > 0) || !(rowNorm > 0) || !(colNorm > 0)) return -1
		if (rowNorm + colNorm < PAIR_FRACTION * mean) return -1
		if (rowNorm < TONE_FRACTION * mean || colNorm < TONE_FRACTION * mean)
			return -1
		if (rowSecond > 0 && rowBest < GROUP_RATIO * rowSecond) return -1
		if (colSecond > 0 && colBest < GROUP_RATIO * colSecond) return -1
		const twist = 10 * Math.log10(colNorm / rowNorm)
		if (twist < TWIST_MIN_DB || twist > TWIST_MAX_DB) return -1
		return rowIndex * 4 + colIndex
	}

	private measure(coeffs: Float64Array, powers: Float64Array): void {
		const window = this.window
		for (let tone = 0; tone < coeffs.length; tone++) {
			const factor = coeffs[tone] ?? 0
			let s1 = 0
			let s2 = 0
			for (let n = 0; n < WINDOW_SAMPLES; n++) {
				const s0 = (window[n] ?? 0) + factor * s1 - s2
				s2 = s1
				s1 = s0
			}
			const power = s1 * s1 + s2 * s2 - factor * s1 * s2
			powers[tone] = power > 0 ? power : 0
		}
	}
}

function dominant(powers: Float64Array): number {
	let index = 0
	for (let i = 1; i < powers.length; i++) {
		if ((powers[i] ?? 0) > (powers[index] ?? 0)) index = i
	}
	return index
}

function runnerUp(powers: Float64Array, best: number): number {
	let second = 0
	for (let i = 0; i < powers.length; i++) {
		if (i === best) continue
		const power = powers[i] ?? 0
		if (power > second) second = power
	}
	return second
}
