/**
 * Synthetic NXDN conventional call (4FSK) for the decoder chain tests:
 * FACCH1 frames carrying a VCALL (group call, source and destination unit
 * IDs), then voice frames whose SACCH superframe repeats the VCALL with the
 * RAN. NXDN48 is 2400 sym/s (+-1050 / +-350 Hz), NXDN96 4800 sym/s
 * (+-2400 / +-800 Hz); the 192-symbol frame is the same. No side effects on
 * import; RAN and unit IDs are made up. Voice payload is seeded noise.
 *
 * Frame, as dsd-fme nxdn_frame.c / nxdn_deperm.c read it:
 * - FSW 0xCDF59 (10 symbols);
 * - 182 dibits scrambled together by the PN95 dibit scrambler (seed 0xE4,
 *   x^9 + x^5 + 1, a 1 inverts that symbol's sign): the LICH (8 dibits, the
 *   7-bit LICH and its parity as the high bits, every low bit 1), the SACCH
 *   (60 bits) and two 144-bit FACCH1 / VCH halves;
 * - SACCH: SR (structure 2 bits, RAN 6 bits) and an 18-bit superframe
 *   fragment, CRC-6, 4 tail bits, K = 5 code (G1 = 1 + D^3 + D^4,
 *   G2 = 1 + D + D^2 + D^4), punctured {1,1,1,1,1,0,1,1,1,1,1,0},
 *   interleaved bit i -> PERM_12_5[i] = 12 (i mod 5) + i div 5;
 * - FACCH1: 80 bits (message type VCALL 0x01, CC option, call type, voice
 *   call option, source and destination IDs, cipher, key), CRC-12, tail,
 *   K = 5, punctured {1,0,1,1}, interleaved PERM_16_9[i] = 16 (i mod 9) + i div 9.
 * CRC-6 and CRC-12 are dsd-fme's crc6 / crc12f (all-ones register). Dibit
 * 01 is +3, 00 +1, 10 -1, 11 -3; raised-cosine shaping, roll-off 0.5.
 */
import { bitsOf, bitsToDibits, rng, shapeFrequency } from "./fsk-iq.mjs"
import { conv5Dibits } from "./ysf-c4fm.mjs"

const FSW = 0xcdf59
/** LICH: RDCH, SACCH superframe, FACCH1 in both halves / VCH in both, outbound. */
const LICH_FACCH1 = 0x51
const LICH_VOICE = 0x57

/** dsd-fme crc6: register all ones, feedback taps as nxdn_deperm.c. */
export function nxdnCrc6(bits) {
	const s = [1, 1, 1, 1, 1, 1]
	for (const bit of bits) {
		const a = bit ^ s[0]
		s[0] = a ^ s[1]
		s[1] = s[2]
		s[2] = s[3]
		s[3] = a ^ s[4]
		s[4] = a ^ s[5]
		s[5] = a
	}
	return s
}

/** dsd-fme crc12f. */
export function nxdnCrc12(bits) {
	const s = new Array(12).fill(1)
	for (const bit of bits) {
		const a = bit ^ s[0]
		for (let i = 0; i < 8; i++) s[i] = i === 0 ? a ^ s[1] : s[i + 1]
		s[8] = a ^ s[9]
		s[9] = a ^ s[10]
		s[10] = a ^ s[11]
		s[11] = a
	}
	return s
}

/** K = 5 code, punctured and interleaved into `perm.length` bits. */
function channelBits(info, puncture, perm) {
	const coded = conv5Dibits(info).flatMap(d => [d >> 1, d & 1])
	const kept = coded.filter((_, i) => puncture[i % puncture.length])
	if (kept.length !== perm.length)
		throw new Error(`channel is ${kept.length} bits`)
	return perm.map(p => kept[p])
}
const PERM_12_5 = [...Array(60)].map((_, i) => 12 * (i % 5) + Math.floor(i / 5))
const PERM_16_9 = [...Array(144)].map(
	(_, i) => 16 * (i % 9) + Math.floor(i / 9),
)

/** The 60 on-air SACCH bits. */
export function nxdnSacchBits({ sf, ran, fragment }) {
	const info = [...bitsOf(sf, 2), ...bitsOf(ran, 6), ...fragment]
	return channelBits(
		[...info, ...nxdnCrc6(info)],
		[1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0],
		PERM_12_5,
	)
}

/** The 80 bits of a VCALL message (group call, no cipher). */
export function nxdnVcallBits({
	source,
	destination,
	callType = 1,
	voiceOption = 0,
	messageType = 0x01,
}) {
	return [
		0,
		0,
		...bitsOf(messageType, 6), // flags, message type (VCALL 0x01, TX_REL 0x08)
		...bitsOf(0, 8), // CC option
		...bitsOf(callType, 3),
		...bitsOf(voiceOption, 5),
		...bitsOf(source, 16),
		...bitsOf(destination, 16),
		...bitsOf(0, 2), // cipher type
		...bitsOf(0, 6), // key ID
		...Array(16).fill(0),
	]
}

/** The 144 on-air FACCH1 bits of an 80-bit message. */
export function nxdnFacch1Bits(message) {
	return channelBits(
		[...message, ...nxdnCrc12(message)],
		[1, 0, 1, 1],
		PERM_16_9,
	)
}

/** PN95 dibit scrambler (nxdn_pn95_dibit_scrambler, seed 0xE4). */
export function nxdnScramble(dibits) {
	let lfsr = 0xe4
	return dibits.map(d => {
		const invert = lfsr & 1
		const bit = ((lfsr >> 4) ^ lfsr) & 1
		lfsr = (lfsr >> 1) | (bit << 8)
		return invert ? d ^ 2 : d
	})
}

function lichDibits(lich) {
	const parity = ((lich >> 6) ^ (lich >> 5) ^ (lich >> 4) ^ (lich >> 3)) & 1
	return bitsOf((lich << 1) | parity, 8).map(b => (b << 1) | 1)
}

/** One 192-symbol frame. */
function frame(lich, sacch, halves) {
	const body = [...lichDibits(lich), ...bitsToDibits([...sacch, ...halves])]
	if (body.length !== 182) throw new Error(`NXDN frame body is ${body.length}`)
	return [...bitsToDibits(bitsOf(FSW, 20)), ...nxdnScramble(body)]
}

/** Dibits of one call: pre-roll, FACCH1 VCALL frames, then voice superframes. */
export function nxdnCallDibits({
	ran,
	source,
	destination,
	superframes = 2,
	release = false,
	seed = 9,
}) {
	const random = rng(seed)
	const noise = n => [...Array(n)].map(() => (random() < 0.5 ? 0 : 1))
	const vcall = nxdnVcallBits({ source, destination })
	const facch = nxdnFacch1Bits(vcall)
	const out = [...Array(480)].map(() => Math.floor(random() * 4))
	const idle = nxdnSacchBits({ sf: 3, ran, fragment: Array(18).fill(0) })
	for (let i = 0; i < 3; i++)
		out.push(...frame(LICH_FACCH1, idle, [...facch, ...facch]))
	for (let s = 0; s < superframes; s++)
		for (let part = 0; part < 4; part++) {
			const sacch = nxdnSacchBits({
				sf: 3 - part,
				ran,
				fragment: vcall.slice(18 * part, 18 * part + 18),
			})
			out.push(...frame(LICH_VOICE, sacch, noise(288)))
		}
	// TX_REL (message type 0x08, same fields as VCALL) in FACCH1: the end.
	if (release) {
		const rel = nxdnFacch1Bits(
			nxdnVcallBits({ source, destination, messageType: 0x08 }),
		)
		out.push(...frame(LICH_FACCH1, idle, [...rel, ...rel]))
	}
	return out
}

/** Dibits of back-to-back calls (`nxdnCallDibits` each), `gapSymbols` of noise apart. */
export function nxdnCallsDibits(calls, { gapSymbols = 480 } = {}) {
	const random = rng(23)
	return calls.flatMap((call, i) => [
		...(i > 0
			? [...Array(gapSymbols)].map(() => Math.floor(random() * 4))
			: []),
		...nxdnCallDibits({ ...call, seed: 9 + i }),
	])
}

/** The two NXDN rates: symbol rate and outer deviation (Hz). */
export const NXDN_RATES = {
	nxdn48: { symbolRate: 2400, outerHz: 1050 },
	nxdn96: { symbolRate: 4800, outerHz: 2400 },
}

/** FM deviation (Hz, 48 kHz) of one NXDN call. */
export function nxdnFrequency(
	call,
	{ variant = "nxdn48", rateHz = 48_000 } = {},
) {
	return nxdnShape(nxdnCallDibits(call), variant, rateHz)
}

/** FM deviation (Hz, 48 kHz) of back-to-back NXDN calls. */
export function nxdnCallsFrequency(
	calls,
	{ variant = "nxdn48", rateHz = 48_000, gapSymbols = 480 } = {},
) {
	return nxdnShape(nxdnCallsDibits(calls, { gapSymbols }), variant, rateHz)
}

function nxdnShape(dibits, variant, rateHz) {
	const { symbolRate, outerHz } = NXDN_RATES[variant]
	const inner = outerHz / 3
	return shapeFrequency(dibits, {
		symbolRate,
		rateHz,
		shaping: "rc",
		alpha: 0.5,
		deviationHz: dibit => [inner, outerHz, -inner, -outerHz][dibit],
	})
}
