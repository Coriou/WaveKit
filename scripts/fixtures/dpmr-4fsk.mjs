/**
 * Synthetic dPMR voice superframes (4FSK 2400 sym/s, +-1050 / +-350 Hz) for
 * the decoder chain tests: called ID (talkgroup) in frames 0-1, calling ID
 * in frames 2-3, and the channel (colour) code. No side effects on import;
 * IDs and the colour code are made up. Voice payload is seeded noise.
 *
 * Payload frame (ETSI TS 102 658, as dsd-fme dpmr_voice.c reads it): even
 * frames start with FS2 0x5FF77D, odd frames with the 24-bit channel code
 * (dpmr_data.c GetdPmrColorCode table), then the CCH (72 bits) and four
 * 72-bit TCH. CCH: frame number (2 bits), half of the ID (12 bits), mode,
 * version, format, emergency and reserved bits, 18 bits of slow data and a
 * CRC-7 (x^7 + x^3 + 1, zero register) over the first 41 bits; six
 * Hamming(12,8) words (dsd-fme fec.c), written into a 12 x 6 matrix by
 * columns and read by rows, then scrambled with x^9 + x^5 + 1 (all ones).
 * IDs are air-interface IDs of 7-digit strings (dpmr_voice.c
 * ConvertAirInterfaceID). Dibit 01 is +3, 00 +1, 10 -1, 11 -3;
 * raised-cosine shaping, roll-off 0.5.
 */
import { bitsOf, bitsToDibits, rng, shapeFrequency } from "./fsk-iq.mjs"

const FS2 = 0x5ff77d
/** Channel codes 0-63 (ETSI TS 102 658 6.1.5.2.2), as dsd-fme decodes them. */
const CHANNEL_CODES = {
	0: 0x575f77,
	1: 0x577577,
	2: 0x57dd75,
	3: 0x57f775,
	4: 0x55577d,
	5: 0x557d7d,
	6: 0x55d57f,
	7: 0x55ff7f,
}

// Hamming(12,8) parity of each data bit (Hamming_12_8_m_G).
const HAMMING_P = [
	"1110",
	"0111",
	"1010",
	"0101",
	"1011",
	"1100",
	"0110",
	"0011",
]

/** Weights of the seven digits of a dPMR air-interface ID. */
const ID_WEIGHTS = [1464100, 146410, 14641, 1331, 121, 11, 1]

/** Air-interface ID of a 7-digit string (inverse of ConvertAirInterfaceID). */
export function dpmrAirId(digits) {
	return [...digits].reduce((acc, d, i) => acc + Number(d) * ID_WEIGHTS[i], 0)
}

/** dsd-fme CRC7BitdPMR. */
export function dpmrCrc7(bits) {
	let reg = 0
	for (const bit of bits)
		reg =
			((reg >> 6) & 1) ^ bit ? ((reg << 1) ^ 0x09) & 0x7f : (reg << 1) & 0x7f
	return bitsOf(reg, 7)
}

/** x^9 + x^5 + 1 scrambler from all ones (ScrambledPMRBit). */
function scramble(bits) {
	const s = [1, 1, 1, 1, 1, 1, 1, 1, 1]
	return bits.map(bit => {
		const out = bit ^ s[0]
		const fb = s[4] ^ s[0]
		s.shift()
		s.push(fb)
		return out
	})
}

/** The 72 on-air CCH bits of frame `fn` carrying 12 bits of an ID. */
export function dpmrCchBits({ fn, idPart }) {
	const data = [
		...bitsOf(fn, 2),
		...bitsOf(idPart, 12),
		...bitsOf(0, 3), // communication mode: voice
		...bitsOf(0, 2), // version
		...bitsOf(0, 2), // comms format
		0,
		0,
		...bitsOf(0, 18), // slow data
	]
	const cch = [...data, ...dpmrCrc7(data)]
	const coded = []
	for (let w = 0; w < 6; w++) {
		const d = cch.slice(8 * w, 8 * w + 8)
		const p = [0, 0, 0, 0]
		d.forEach((bit, i) => {
			if (bit) for (let j = 0; j < 4; j++) p[j] ^= Number(HAMMING_P[i][j])
		})
		coded.push(...d, ...p)
	}
	const interleaved = new Array(72)
	for (let i = 0; i < 12; i++)
		for (let j = 0; j < 6; j++) interleaved[6 * i + j] = coded[12 * j + i]
	return scramble(interleaved)
}

/** Dibits of `superframes` voice superframes (4 frames each), after a pre-roll. */
export function dpmrCallDibits({
	calledId,
	callingId,
	colourCode,
	superframes = 3,
	seed = 13,
}) {
	const random = rng(seed)
	const tch = () => [...Array(144)].map(() => Math.floor(random() * 4))
	const called = dpmrAirId(calledId)
	const calling = dpmrAirId(callingId)
	const parts = [called >>> 12, called & 0xfff, calling >>> 12, calling & 0xfff]
	const cc = CHANNEL_CODES[colourCode]
	if (cc === undefined)
		throw new Error(`no channel code table entry for ${colourCode}`)
	const out = [...Array(480)].map(() => Math.floor(random() * 4))
	for (let s = 0; s < superframes; s++)
		for (let fn = 0; fn < 4; fn++) {
			out.push(...bitsToDibits(bitsOf(fn % 2 ? cc : FS2, 24)))
			out.push(...bitsToDibits(dpmrCchBits({ fn, idPart: parts[fn] })))
			out.push(...tch())
		}
	return out
}

/** FM deviation (Hz, 48 kHz) of one dPMR call. */
export function dpmrFrequency(call, { rateHz = 48_000 } = {}) {
	return shapeFrequency(dpmrCallDibits(call), {
		symbolRate: 2400,
		rateHz,
		shaping: "rc",
		alpha: 0.5,
		deviationHz: dibit => [350, 1050, -350, -1050][dibit],
	})
}
