/**
 * DCS (Digital-Coded Squelch) decoder for one analog transmission (WG6 req 4).
 *
 * Signal: 134.4 bit/s NRZ under the voice, continuous 23-bit Golay(23,12) words. Word layout
 * (as in the contract test): data = code (9 bits) | 0b100 << 9, word = data << 11 | parity
 * (generator 0xC75). Bit order on air: LSB first, starting with the data (code bit 0 first,
 * then code bits 1-8, the fixed bits 0, 0, 1, then parity bits 0-10). The receiver sees a cyclic
 * stream, so any 23 consecutive bits are a rotation of the word; the decoder shifts each new bit
 * into bit 22 of a register (`reg = reg >>> 1 | bit << 22`) and looks the register up among all
 * rotations, so the start of the word does not matter but the LSB-first order does.
 *
 * Polarity: a positive PCM sample is a 1 bit ("normal" = the stream as demodulated). WaveKit's FM
 * demodulator is the external `csdr fmdemod` stage (src/core/live-demod-pipeline.ts, the
 * `case "nfm"` branch pushing "csdr fmdemod"), a quadrature discriminator whose output is the
 * phase advance per sample, so a positive frequency deviation of the received IQ gives positive
 * PCM; the stages after it (deemphasis, lowpass, dcblock, gain, limit, convert) do not change
 * sign. Whether positive RF deviation is positive IQ frequency depends on the source's IQ order,
 * which cannot be established offline, so readings are reported for the stream as demodulated.
 *
 * DSP at 8 kHz: 4th-order Butterworth low-pass at 200 Hz (two biquads), DC removal by a running
 * mean (cumulative for the first second, then exponential with a 1 s time constant), integrate-and-dump slicer over each bit, bit clock 8000 / 134.4 ≈ 59.52 samples
 * recovered from zero crossings (hard sync on the first crossing, then a bounded early/late
 * correction). A bit whose mean magnitude is below a floor breaks the register (silence).
 *
 * Confirmation: a hit is a register that is a rotation of a valid word (or of its complement,
 * reading "inverted"). Three hits exactly 23 bits apart with the same reading confirm it
 * (DCS_MIN_WORDS); a miss or a different reading at a 23-bit check point resets. No error
 * correction. `pushSample` allocates nothing after construction: all state is numbers, the
 * table is a shared Map<number, number> and lookups use number keys.
 */
import {
	DCS_CODE_SET,
	DCS_MIN_WORDS,
	DCS_STANDARD_CODES,
} from "@wavekit/api-types"
import type { AnalogTransmissionDcs } from "@wavekit/api-types"

/** AUDIO_TONE_RATE_HZ of tone-detector.ts (not imported: it imports this module). */
const RATE_HZ = 8_000
const BIT_RATE_BPS = 134.4
const SAMPLES_PER_BIT = RATE_HZ / BIT_RATE_BPS
const WORD_BITS = 23
const MASK23 = 0x7fffff
const LOWPASS_HZ = 200
/** Early/late gain and bound (fraction of the error, samples). */
const CLOCK_GAIN = 0.15
const CLOCK_MAX_STEP = SAMPLES_PER_BIT * 0.08
/** Mean |signal| over a bit below this is silence (breaks the register). */
const SILENCE_FLOOR = 1e-5
const INVERTED = 512
const NONE = -1

export type DcsCodeSet = "standard" | "any-valid"

function golayWord(code: number): number {
	const data = (code & 0x1ff) | (0b100 << 9)
	let r = data << 11
	for (let i = 22; i >= 11; i--) if (r & (1 << i)) r ^= 0xc75 << (i - 11)
	return ((data << 11) | r) & MASK23
}

function rotate(word: number, k: number): number {
	return ((word >>> k) | (word << (WORD_BITS - k))) & MASK23
}

/**
 * Register → packed entry: bits 0-9 the table code + 1 (0 = none in the table), bits 10-18 the
 * lowest valid code. Keys are all 23 rotations of all 512 words; the complement is looked up
 * with the same table. Built once per process on first use.
 */
let wordTable: Map<number, number> | null = null
let standardSet: Set<number> | null = null

function standardCodes(): Set<number> {
	if (standardSet === null)
		standardSet = new Set(DCS_STANDARD_CODES.map(c => Number.parseInt(c, 8)))
	return standardSet
}

function table(): Map<number, number> {
	if (wordTable !== null) return wordTable
	const listed = standardCodes()
	const map = new Map<number, number>()
	for (let code = 0; code < 512; code++) {
		const word = golayWord(code)
		for (let k = 0; k < WORD_BITS; k++) {
			const reg = rotate(word, k)
			const prior = map.get(reg)
			let std = prior === undefined ? 0 : prior & 0x3ff
			const lowest = prior === undefined ? code : prior >>> 10
			if (std === 0 && listed.has(code)) std = code + 1
			map.set(reg, std | (lowest << 10))
		}
	}
	wordTable = map
	return map
}

/** Packed reading (code | INVERTED) of a register, or NONE. */
function readRegister(
	map: Map<number, number>,
	reg: number,
	standard: boolean,
): number {
	const normal = map.get(reg)
	const inverted = map.get(~reg & MASK23)
	if (standard) {
		if (normal !== undefined && (normal & 0x3ff) !== 0)
			return (normal & 0x3ff) - 1
		if (inverted !== undefined && (inverted & 0x3ff) !== 0)
			return ((inverted & 0x3ff) - 1) | INVERTED
		return NONE
	}
	if (normal !== undefined) return normal >>> 10
	if (inverted !== undefined) return (inverted >>> 10) | INVERTED
	return NONE
}

function toDcs(packed: number): AnalogTransmissionDcs {
	return {
		code: (packed & 0x1ff).toString(8).padStart(3, "0"),
		polarity: (packed & INVERTED) !== 0 ? "inverted" : "normal",
	}
}

/**
 * The same bit stream read with the other polarity: the code whose word's complement is a
 * rotation of this code's word, with the polarity flipped (023N ↔ 047I). A table twin is
 * preferred, then the lowest valid code. A code with no valid twin (only possible outside the
 * table) or a malformed code is returned as an unchanged copy.
 */
export function dcsTwin(dcs: AnalogTransmissionDcs): AnalogTransmissionDcs {
	if (!/^[0-7]{3}$/.test(dcs.code)) return { ...dcs }
	const entry = table().get(~golayWord(Number.parseInt(dcs.code, 8)) & MASK23)
	if (entry === undefined) return { ...dcs }
	const twin = (entry & 0x3ff) !== 0 ? (entry & 0x3ff) - 1 : entry >>> 10
	return {
		code: twin.toString(8).padStart(3, "0"),
		polarity: dcs.polarity === "normal" ? "inverted" : "normal",
	}
}

/** Streaming DCS decoder. `pushSample` does not allocate after construction. */
export class DcsDecoder {
	private readonly standard: boolean
	private readonly map: Map<number, number>
	private readonly lb0: number
	private readonly lb1: number
	private readonly la1: number
	private readonly la2: number
	private readonly hb0: number
	private readonly hb1: number
	private readonly ha1: number
	private readonly ha2: number
	private s1a = 0
	private s1b = 0
	private s2a = 0
	private s2b = 0
	private dc = 0
	private dcCount = 0
	private prev = 0
	private locked = false
	/** Samples since the last bit boundary. */
	private phase = 0
	private acc = 0
	private mag = 0
	private register = 0
	/** Valid bits in the register (capped at 23). */
	private filled = 0
	private bitIndex = 0
	private candidate = NONE
	private candidateBit = 0
	/** Raw register at the last hit: a check point must repeat the same word, same rotation. */
	private candidateWord = 0
	private hits = 0
	private confirmed = NONE

	constructor(options?: { codeSet?: DcsCodeSet }) {
		this.standard = (options?.codeSet ?? DCS_CODE_SET) === "standard"
		this.map = table()
		// Two RBJ low-pass sections, Butterworth Qs for 4th order.
		const w0 = (2 * Math.PI * LOWPASS_HZ) / RATE_HZ
		const cos = Math.cos(w0)
		const sin = Math.sin(w0)
		const qa = 0.541_196_100_146_197
		const qb = 1.306_562_964_876_376_6
		const alphaA = sin / (2 * qa)
		const alphaB = sin / (2 * qb)
		const a0A = 1 + alphaA
		const a0B = 1 + alphaB
		this.lb0 = (1 - cos) / 2 / a0A
		this.lb1 = (1 - cos) / a0A
		this.la1 = (-2 * cos) / a0A
		this.la2 = (1 - alphaA) / a0A
		this.hb0 = (1 - cos) / 2 / a0B
		this.hb1 = (1 - cos) / a0B
		this.ha1 = (-2 * cos) / a0B
		this.ha2 = (1 - alphaB) / a0B
	}

	pushSample(sample: number): void {
		const x = Number.isFinite(sample) ? sample : 0
		// Section A (direct form II transposed; b2 = b0).
		const ya = this.lb0 * x + this.s1a
		this.s1a = this.lb1 * x - this.la1 * ya + this.s2a
		this.s2a = this.lb0 * x - this.la2 * ya
		const yb = this.hb0 * ya + this.s1b
		this.s1b = this.hb1 * ya - this.ha1 * yb + this.s2b
		this.s2b = this.hb0 * ya - this.ha2 * yb
		// Running mean for the first second, then a 1 s exponential mean.
		if (this.dcCount < RATE_HZ) this.dcCount += 1
		this.dc += (yb - this.dc) / this.dcCount
		const y = yb - this.dc

		this.phase += 1
		const prev = this.prev
		if ((prev < 0 && y >= 0) || (prev >= 0 && y < 0)) {
			const denominator = prev - y
			const frac = denominator !== 0 ? prev / denominator : 0
			// Time since the crossing, in samples.
			const since = 1 - frac
			if (!this.locked) {
				this.locked = true
				this.phase = since
				this.acc = 0
				this.mag = 0
			} else {
				let error = this.phase - since
				if (error > SAMPLES_PER_BIT / 2) error -= SAMPLES_PER_BIT
				let step = CLOCK_GAIN * error
				if (step > CLOCK_MAX_STEP) step = CLOCK_MAX_STEP
				else if (step < -CLOCK_MAX_STEP) step = -CLOCK_MAX_STEP
				this.phase -= step
			}
		}
		this.prev = y
		if (!this.locked) return
		this.acc += y
		this.mag += y < 0 ? -y : y
		if (this.phase < SAMPLES_PER_BIT) return
		this.phase -= SAMPLES_PER_BIT
		const quiet = this.mag < SILENCE_FLOOR * SAMPLES_PER_BIT
		this.pushBit(this.acc > 0 ? 1 : 0, quiet)
		this.acc = 0
		this.mag = 0
	}

	result(): AnalogTransmissionDcs | null {
		return this.confirmed === NONE ? null : toDcs(this.confirmed)
	}

	reset(): void {
		this.s1a = 0
		this.s1b = 0
		this.s2a = 0
		this.s2b = 0
		this.dc = 0
		this.dcCount = 0
		this.prev = 0
		this.locked = false
		this.phase = 0
		this.acc = 0
		this.mag = 0
		this.register = 0
		this.filled = 0
		this.bitIndex = 0
		this.candidate = NONE
		this.candidateBit = 0
		this.candidateWord = 0
		this.hits = 0
		this.confirmed = NONE
	}

	private pushBit(bit: number, quiet: boolean): void {
		this.bitIndex += 1
		if (quiet) {
			this.filled = 0
			this.register = 0
		} else {
			this.register = ((this.register >>> 1) | (bit << 22)) & MASK23
			if (this.filled < WORD_BITS) this.filled += 1
		}
		const reading =
			this.filled === WORD_BITS
				? readRegister(this.map, this.register, this.standard)
				: NONE
		if (this.candidate !== NONE) {
			if (this.bitIndex - this.candidateBit < WORD_BITS) return
			// Check point: exactly 23 bits after the previous hit.
			if (reading === this.candidate && this.register === this.candidateWord) {
				this.hits += 1
				this.candidateBit = this.bitIndex
				if (this.hits >= DCS_MIN_WORDS) this.confirmed = reading
				return
			}
			this.candidate = NONE
			this.hits = 0
		}
		if (reading === NONE) return
		this.candidate = reading
		this.candidateBit = this.bitIndex
		this.candidateWord = this.register
		this.hits = 1
	}
}
