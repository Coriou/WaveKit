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
 *   101010101011010001101000 starts the next superframe; the last one ends
 *   with the terminator. This is the order dsd-fme reads (the data sync
 *   after the 21st frame); dstarSpecBits is the JARL order. The 480 slow-data
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
/** End of transmission: 32 bits of 1010 and 000100110101111 (then a 0). */
const TERMINATOR = [
	...[...Array(32)].map((_, i) => (i % 2 ? 0 : 1)),
	...[0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0],
]
const DATA_SYNC = [...Array(10)].map((_, i) => (i % 2 ? 0 : 1))
DATA_SYNC.push(1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0)

const lsbBits = bytes =>
	bytes.flatMap(b => [...Array(8)].map((_, i) => (b >> i) & 1))

/** The 41 header bytes, FCS included. */
export function dstarHeaderBytes({
	rpt2,
	rpt1,
	ur,
	my,
	suffix = "",
	flags = [0, 0, 0],
}) {
	const field = (text, width) => [
		...Buffer.from(text.padEnd(width, " ").slice(0, width), "latin1"),
	]
	const bytes = [
		...flags,
		...field(rpt2, 8),
		...field(rpt1, 8),
		...field(ur, 8),
		...field(my, 8),
		...field(suffix, 4),
	]
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

/** Bits of slow-data `bytes`, each 24-bit block scrambled with the first 24 scrambler bits. */
const slowDataBits = bytes =>
	lsbBits(bytes).map((bit, i) => bit ^ SCRAMBLER[i % 24])

/** Header bytes for slow data; `badFcs` corrupts the FCS (a failed copy). */
function slowHeaderBytes(header, badFcs) {
	const data = dstarHeaderBytes(header)
	if (badFcs) data[39] ^= 0x01
	return data
}

/**
 * The 480 slow-data bits (20 blocks of 24) repeating the header from the
 * first block of a superframe: ten 6-byte groups 0x55 + 5 header bytes, the
 * alignment dsd-fme's processDSTAR_SD needs.
 */
export function dstarSlowDataBits(header, { badFcs = false } = {}) {
	const data = slowHeaderBytes(header, badFcs)
	while (data.length < 50) data.push(0x66)
	const bytes = []
	for (let g = 0; g < 10; g++) bytes.push(0x55, ...data.slice(5 * g, 5 * g + 5))
	return slowDataBits(bytes)
}

/**
 * Bits (1 = negative deviation) of a header and `superframes` superframes,
 * in the order dsd-fme reads them: 20 voice frames with slow data, a 21st
 * voice frame, then the data sync. `badFirstSlowData` fails the FCS of the
 * first superframe's slow-data header (the one printed on the HEADER line).
 */
export function dstarBits(
	header,
	{ superframes = 3, badFirstSlowData = false } = {},
) {
	const bits = []
	for (let i = 0; i < 96; i++) bits.push(i % 2 ? 0 : 1)
	bits.push(...HEADER_SYNC, ...dstarHeaderBits(header))
	const voice = lsbBits(AMBE_SILENCE)
	for (let s = 0; s < superframes; s++) {
		const slow = dstarSlowDataBits(header, {
			badFcs: badFirstSlowData && s === 0,
		})
		for (let j = 0; j < 21; j++) {
			bits.push(...voice)
			if (j < 20) bits.push(...slow.slice(24 * j, 24 * j + 24))
		}
		// The last voice frame is followed by the terminator, not a data sync
		// (after a sync dsd-fme reads a whole superframe blindly).
		bits.push(...(s < superframes - 1 ? DATA_SYNC : TERMINATOR))
	}
	return bits
}

/**
 * Spec-shaped D-STAR (JARL): after the header, voice frame 0 of every
 * superframe carries the data sync, frames 1-20 carry the slow data, and the
 * slow-data stream runs on across superframes: a 20-character text message
 * (mini headers 0x40-0x43) then the header (0x55 groups, 0x66 fill),
 * repeated, so the header groups do not start where a superframe does.
 */
export function dstarSpecBits(
	header,
	{ superframes = 6, text = "SYNTHETIC D-STAR TX" } = {},
) {
	const bits = []
	for (let i = 0; i < 96; i++) bits.push(i % 2 ? 0 : 1)
	bits.push(...HEADER_SYNC, ...dstarHeaderBits(header))
	const voice = lsbBits(AMBE_SILENCE)
	const chars = [...Buffer.from(text.padEnd(20, " ").slice(0, 20), "latin1")]
	const data = dstarHeaderBytes(header)
	while (data.length < 45) data.push(0x66)
	const cycle = []
	for (let g = 0; g < 4; g++)
		cycle.push(0x40 + g, ...chars.slice(5 * g, 5 * g + 5))
	for (let g = 0; g < 9; g++) cycle.push(0x55, ...data.slice(5 * g, 5 * g + 5))
	const stream = []
	while (stream.length < superframes * 60) stream.push(...cycle)
	const slow = slowDataBits(stream)
	for (let s = 0; s < superframes; s++) {
		bits.push(...voice, ...DATA_SYNC)
		for (let j = 1; j <= 20; j++) {
			const block = 20 * s + (j - 1)
			bits.push(...voice, ...slow.slice(24 * block, 24 * block + 24))
		}
	}
	bits.push(...voice, ...TERMINATOR)
	return bits
}

const gmsk = (bits, deviationHz, rateHz) =>
	shapeFrequency(bits, {
		symbolRate: 4800,
		rateHz,
		shaping: "gauss",
		bt: 0.5,
		deviationHz: bit => (bit ? -deviationHz : deviationHz),
	})

/** FM deviation (Hz, 48 kHz) of one D-STAR transmission. */
export function dstarFrequency(
	header,
	{
		superframes = 3,
		badFirstSlowData = false,
		deviationHz = 1200,
		rateHz = 48_000,
	} = {},
) {
	return gmsk(
		dstarBits(header, { superframes, badFirstSlowData }),
		deviationHz,
		rateHz,
	)
}

/** FM deviation of back-to-back D-STAR overs, 0.25 s of unmodulated carrier apart. */
export function dstarOversFrequency(
	overs,
	{ deviationHz = 1200, rateHz = 48_000 } = {},
) {
	const parts = overs.map(({ header, ...options }) =>
		dstarFrequency(header, { ...options, deviationHz, rateHz }),
	)
	const gap = new Float64Array(Math.round(0.25 * rateHz))
	const out = new Float64Array(
		parts.reduce((n, p) => n + p.length + gap.length, 0),
	)
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.length + gap.length
	}
	return out
}

/** FM deviation (Hz, 48 kHz) of the spec-shaped transmission (dstarSpecBits). */
export function dstarSpecFrequency(
	header,
	{ superframes = 6, deviationHz = 1200, rateHz = 48_000 } = {},
) {
	return gmsk(dstarSpecBits(header, { superframes }), deviationHz, rateHz)
}
