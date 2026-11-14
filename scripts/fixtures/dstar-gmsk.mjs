/**
 * Synthetic D-STAR transmission (GMSK 4800 bps, BT 0.5, +-1.2 kHz) for the
 * decoder chain tests: radio header, then voice superframes whose slow data
 * repeats the header. No side effects on import; callsigns are fictional.
 *
 * Layout, as dsd-fme (dstar.c, dstar_header.c, descramble.h) receives it:
 * - bit sync (1010...) and the header frame sync 111011001010000;
 * - the 41-byte radio header: flags (3), RPT2, RPT1, UR, MY (8 each), MY
 *   suffix (4), FCS (CRC-16/X.25 of bytes 0-38, low byte first); bits LSB
 *   first, two zero tail bits, convolutional code K = 3 (outputs b^b1^b2,
 *   b^b2), the 24-step interleave and the x^7 + x^4 + 1 scrambler (seed all
 *   ones), 660 bits;
 * - superframes: 21 voice frames of 72 AMBE bits (the AMBE silence frame);
 *   frames 0-19 carry 24 slow-data bits each, then the 24-bit data sync
 *   101010101011010001101000 starts the next superframe. The 480 slow-data
 *   bits are ten 6-byte groups (mini-header 0x55, five header bytes), LSB
 *   first, each 24-bit block scrambled with the first 24 scrambler bits.
 * Bit 1 is the negative deviation (dsd-fme's +D-STAR polarity).
 */
import { ax25Fcs } from "./aprs-afsk.mjs"
import { shapeFrequency } from "./fsk-iq.mjs"

/** x^7 + x^4 + 1, seed all ones (equals dsd-fme's SCRAMBLER_TABLE_BITS). */
function scramblerBits(n) {
	let s = [1, 1, 1, 1, 1, 1, 1]
	const out = []
	for (let i = 0; i < n; i++) {
		const bit = s[6] ^ s[3]
		out.push(bit)
		s = [bit, ...s.slice(0, 6)]
	}
	return out
}
const SCRAMBLER = scramblerBits(660)
const AMBE_SILENCE = [0x9e, 0x8d, 0x32, 0x88, 0x26, 0x1a, 0x3f, 0x61, 0xe8]
const HEADER_SYNC = [1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0]
const DATA_SYNC = [...Array(10)].map((_, i) => (i % 2 ? 0 : 1))
DATA_SYNC.push(1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0)

const lsbBits = bytes => bytes.flatMap(b => [...Array(8)].map((_, i) => (b >> i) & 1))

/** The 41 header bytes, FCS included. */
export function dstarHeaderBytes({ rpt2, rpt1, ur, my, suffix = "", flags = [0, 0, 0] }) {
	const field = (text, width) => [...Buffer.from(text.padEnd(width, " ").slice(0, width), "latin1")]
	const bytes = [...flags, ...field(rpt2, 8), ...field(rpt1, 8), ...field(ur, 8), ...field(my, 8), ...field(suffix, 4)]
	const fcs = ax25Fcs(bytes)
	bytes.push(fcs & 0xff, fcs >>> 8)
	return bytes
}

/** The 660 on-air bits of the radio header. */
export function dstarHeaderBits(header) {
	const input = [...lsbBits(dstarHeaderBytes(header)), 0, 0]
	const coded = []
	let b1 = 0
	let b2 = 0
	for (const b of input) {
		coded.push(b ^ b1 ^ b2, b ^ b2)
		b2 = b1
		b1 = b
	}
	const out = new Array(660)
	let k = 0
	for (let i = 0; i < 660; i++) {
		out[i] = coded[k] ^ SCRAMBLER[i]
		k += 24
		if (k >= 672) k -= 671
		else if (k >= 660) k -= 647
	}
	return out
}

/** The 480 slow-data bits (20 blocks of 24) repeating the header. */
export function dstarSlowDataBits(header) {
	const data = dstarHeaderBytes(header)
	while (data.length < 50) data.push(0x66)
	const bytes = []
	for (let g = 0; g < 10; g++) bytes.push(0x55, ...data.slice(5 * g, 5 * g + 5))
	return lsbBits(bytes).map((bit, i) => bit ^ SCRAMBLER[i % 24])
}

/** Bits (1 = negative deviation) of a header and `superframes` superframes. */
export function dstarBits(header, { superframes = 3 } = {}) {
	const bits = []
	for (let i = 0; i < 96; i++) bits.push(i % 2 ? 0 : 1)
	bits.push(...HEADER_SYNC, ...dstarHeaderBits(header))
	const voice = lsbBits(AMBE_SILENCE)
	const slow = dstarSlowDataBits(header)
	for (let s = 0; s < superframes; s++) {
		for (let j = 0; j < 21; j++) {
			bits.push(...voice)
			if (j < 20) bits.push(...slow.slice(24 * j, 24 * j + 24))
		}
		bits.push(...DATA_SYNC)
	}
	for (let i = 0; i < 48; i++) bits.push(i % 2 ? 0 : 1)
	return bits
}

/** FM deviation (Hz, 48 kHz) of one D-STAR transmission. */
export function dstarFrequency(header, { superframes = 3, deviationHz = 1200, rateHz = 48_000 } = {}) {
	return shapeFrequency(dstarBits(header, { superframes }), {
		symbolRate: 4800,
		rateHz,
		shaping: "gauss",
		bt: 0.5,
		deviationHz: bit => (bit ? -deviationHz : deviationHz),
	})
}
