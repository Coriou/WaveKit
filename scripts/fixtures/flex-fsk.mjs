/**
 * Synthetic FLEX page (1600 bps, 2-level FSK) for the decoder chain tests:
 * one frame with one short-address alphanumeric page. No side effects on
 * import; the capcode and text are made up.
 *
 * Frame, as multimon-ng's FLEX decoder (demod_flex.c) receives it:
 * - bit sync: alternating extreme symbols (the decoder locks on 24 of them);
 * - sync 1: the 64-bit window AAAA:A6C6AAAA:~AAAA with AAAA = 0x870C
 *   (1600 bps 2-level), MSB first, bit 1 sent as the low symbol;
 * - 16 dotting bits, then the frame information word (32 bits LSB first,
 *   bit 1 high symbol): checksum nibble, cycle (4 bits), frame (7 bits) and
 *   6 spare bits, such that the nibble sum is 0xF;
 * - sync 2: 40 bits (25 ms) of dotting;
 * - data: 11 blocks of 8 codewords, each block sent bit-interleaved (bit k of
 *   word w at position 8 k + w), LSB first.
 * Every codeword is BCH(31,21) (GF(2^5), x^5 + x^2 + 1, zeros alpha and
 * alpha^3: 21 data bits 0-20, 10 parity bits 21-30) plus an even parity bit 31.
 * Word 0 is the block information word (address field at word 1, vector field
 * at word 2), word 1 the short address (capcode + 0x8000), word 2 the vector
 * (type 5 alphanumeric, start word, length), then the message: a header word
 * (fragment 3, no continuation: a complete page), then 7-bit ASCII characters
 * three per word (the first word's low character is the signature slot).
 * Unused words are the all-zero codeword.
 */
import { shapeFrequency } from "./fsk-iq.mjs"

const GF_POLY = 0x25
const EXP = []
{
	let x = 1
	for (let i = 0; i < 31; i++) {
		EXP.push(x)
		x <<= 1
		if (x & 0x20) x ^= GF_POLY
	}
}

/** (S1 << 5) | S3 of a 31-bit word, as multimon-ng's bch.c computes it. */
function syndrome(word) {
	let s1 = 0
	let s3 = 0
	for (let bit = 0; bit < 31; bit++)
		if ((word >>> bit) & 1) {
			const i = 30 - bit
			s1 ^= EXP[i]
			s3 ^= EXP[(3 * i) % 31]
		}
	return (s1 << 5) | s3
}

/** Parity bits (21-30) for a single data bit, found by search (once). */
const PARITY = []
for (let bit = 0; bit < 21; bit++) {
	for (let p = 0; p < 1024; p++)
		if (syndrome(((1 << bit) | (p << 21)) >>> 0) === 0) {
			PARITY.push(p)
			break
		}
}

/** 32-bit FLEX codeword of 21 data bits. */
export function flexCodeword(data21) {
	let parity = 0
	for (let bit = 0; bit < 21; bit++)
		if ((data21 >>> bit) & 1) parity ^= PARITY[bit]
	let word = ((data21 & 0x1fffff) | (parity << 21)) >>> 0
	let ones = 0
	for (let x = word; x; x >>>= 1) ones += x & 1
	return (word | ((ones & 1) << 31)) >>> 0
}

function frameInfoWord(cycle, frame) {
	const body = ((cycle & 0xf) << 4) | ((frame & 0x7f) << 8)
	let sum = 0
	for (let shift = 4; shift < 20; shift += 4) sum += (body >>> shift) & 0xf
	sum += (body >>> 20) & 1
	return flexCodeword(body | ((0xf - (sum & 0xf)) & 0xf))
}

/** The 88 phase-A codewords of one frame holding one alphanumeric page. */
export function flexPageWords({ capcode, message }) {
	const chars = [...Buffer.from(message, "latin1")].map(c => c & 0x7f)
	// First message word: header, then a signature character slot and two characters.
	const body = []
	const first = [chars.shift() ?? 0x03, chars.shift() ?? 0x03]
	body.push(0x7f | (first[0] << 7) | (first[1] << 14))
	while (chars.length)
		body.push(
			(chars.shift() ?? 0x03) |
				((chars.shift() ?? 0x03) << 7) |
				((chars.shift() ?? 0x03) << 14),
		)
	const start = 3
	const header = 3 << 11 // fragment 3, continuation 0: complete
	const length = 1 + body.length
	const words = [
		// Block information word: address offset 0 (word 1), vector offset 2.
		(2 << 10) | 0x5,
		capcode + 0x8000,
		(5 << 4) | (start << 7) | (length << 14),
		header,
		...body,
	]
	while (words.length < 88) words.push(0)
	return words.map(w => flexCodeword(w >>> 0))
}

/** Line bits (1 = high symbol) of one frame; `capcode` is a short address. */
export function flexFrameBits({ capcode, message, cycle = 0, frame = 0 }) {
	const bits = []
	const push = (value, width, lsbFirst, oneHigh) => {
		for (let i = 0; i < width; i++) {
			const b = lsbFirst ? i : width - 1 - i
			const bit = Math.floor(value / 2 ** b) % 2
			bits.push(oneHigh ? bit : 1 - bit)
		}
	}
	for (let i = 0; i < 128; i++) bits.push(i % 2)
	push(0x870c, 16, false, false)
	push(0xa6c6aaaa, 32, false, false)
	push(0x78f3, 16, false, false)
	for (let i = 0; i < 16; i++) bits.push(i % 2)
	push(frameInfoWord(cycle, frame), 32, true, true)
	for (let i = 0; i < 40; i++) bits.push(i % 2)
	const words = flexPageWords({ capcode, message })
	for (let block = 0; block < 11; block++)
		for (let k = 0; k < 32; k++)
			for (let w = 0; w < 8; w++) bits.push((words[block * 8 + w] >>> k) & 1)
	for (let i = 0; i < 64; i++) bits.push(i % 2)
	return bits
}

/** FM deviation (Hz, 48 kHz) of one FLEX frame: +-4.8 kHz, 1600 baud. */
export function flexFrequency(
	page,
	{ deviationHz = 4800, rateHz = 48_000 } = {},
) {
	return shapeFrequency(flexFrameBits(page), {
		symbolRate: 1600,
		rateHz,
		shaping: "rect",
		deviationHz: bit => (bit ? deviationHz : -deviationHz),
	})
}
