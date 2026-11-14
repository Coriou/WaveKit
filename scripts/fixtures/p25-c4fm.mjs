/**
 * Synthetic P25 phase 1 transmission (C4FM 4800 sym/s, +-600 / +-1800 Hz)
 * for the decoder chain tests: LDU1 frames carrying a Group Voice Channel
 * User link control word, then a TDU. No side effects on import; NAC,
 * talkgroup and source are made up. Voice payload is seeded noise (no IMBE).
 *
 * Layout (TIA-102.BAAA, as dsd-fme dsd_frame.c / p25p1_ldu1.c read it):
 * - frame sync 0x5575F5FF77FF (24 dibits);
 * - NID: NAC (12 bits) and DUID (4 bits), BCH(63,16,23) systematic
 *   (generator octal 6331141367235453, message first, highest degree
 *   first), then a parity bit (1 for LDU1/LDU2);
 * - a status dibit after every 35 dibits from the start of the frame sync;
 * - LDU1: nine 144-bit voice codewords; after voice 2, 3 and 4 the 12
 *   link-control data hex words (LC bits 0-71, six bits each, the first word
 *   first), after voice 5, 6 and 7 the 12 RS(24,12,13) parity hex words, each
 *   hex word followed by its Hamming(10,6,3) parity; after voice 8 the
 *   low-speed data (32 bits).
 * RS(24,12,13) is the shortened RS(63,51) over GF(2^6) with x^6 + x + 1 and
 * zeros alpha^1..alpha^12, as dsd-fme's ReedSolomon.hpp encodes it. Dibit 01
 * is +3 (+1800 Hz), 00 +1, 10 -1, 11 -3; raised-cosine shaping, roll-off 0.5.
 */
import { bitsOf, bitsToDibits, rng, shapeFrequency } from "./fsk-iq.mjs"

const FRAME_SYNC = 0x5575f5ff77ff
const DUID = { hdu: 0x0, tdu: 0x3, ldu1: 0x5, ldu2: 0xa }

/** BCH(63,16) generator, octal 6331141367235453, highest degree first. */
const BCH_GEN = [..."6331141367235453"].flatMap(d => bitsOf(Number(d), 3))

/** 63 NID bits (message first) and the parity bit. */
export function p25NidBits(nac, duid) {
	const message = [...bitsOf(nac, 12), ...bitsOf(duid, 4)]
	const reg = [...message, ...Array(47).fill(0)]
	for (let i = 0; i < 16; i++)
		if (reg[i]) for (let j = 0; j < 48; j++) reg[i + j] ^= BCH_GEN[j]
	const parity = duid === DUID.ldu1 || duid === DUID.ldu2 ? 1 : 0
	return [...message, ...reg.slice(16), parity]
}

// GF(2^6), x^6 + x + 1, as ReedSolomon_63::generate_gf builds it.
const ALPHA = []
const INDEX = new Array(64).fill(-1)
{
	let x = 1
	for (let i = 0; i < 63; i++) {
		ALPHA.push(x)
		INDEX[x] = i
		x <<= 1
		if (x & 0x40) x ^= 0x43
	}
}

/** Generator (index form) of the RS(63, 63 - 2t) code with zeros alpha^1..alpha^2t. */
function rsGenerator(tt) {
	const nk = 2 * tt
	const gg = new Array(nk + 1).fill(0)
	gg[0] = 2
	gg[1] = 1
	for (let i = 2; i <= nk; i++) {
		gg[i] = 1
		for (let j = i - 1; j > 0; j--)
			gg[j] = gg[j] !== 0 ? gg[j - 1] ^ ALPHA[(INDEX[gg[j]] + i) % 63] : gg[j - 1]
		gg[0] = ALPHA[(INDEX[gg[0]] + i) % 63]
	}
	return gg.map(g => INDEX[g])
}

/** ReedSolomon_63<tt>::encode of `data` (k symbols, zero-extended): 2 tt parity symbols. */
export function rs63Parity(data, tt) {
	const nk = 2 * tt
	const kk = 63 - nk
	const gg = rsGenerator(tt)
	const full = [...data, ...Array(kk - data.length).fill(0)]
	const bb = new Array(nk).fill(0)
	for (let i = kk - 1; i >= 0; i--) {
		const feedback = INDEX[full[i] ^ bb[nk - 1]]
		if (feedback !== -1) {
			for (let j = nk - 1; j > 0; j--)
				bb[j] = gg[j] !== -1 ? bb[j - 1] ^ ALPHA[(gg[j] + feedback) % 63] : bb[j - 1]
			bb[0] = ALPHA[(gg[0] + feedback) % 63]
		} else {
			for (let j = nk - 1; j > 0; j--) bb[j] = bb[j - 1]
			bb[0] = 0
		}
	}
	return bb
}

/** Hamming(10,6,3) parity (4 bits) of a hex word, from the H matrix dsd-fme checks. */
const HAMMING_H = ["1110011000", "1101010100", "1011100010", "0111100001"]
export function hamming1063(hex) {
	const data = bitsOf(hex, 6)
	for (let p = 0; p < 16; p++) {
		const word = [...data, ...bitsOf(p, 4)]
		if (HAMMING_H.every(row => [...row].reduce((s, h, i) => s ^ (Number(h) & word[i]), 0) === 0))
			return bitsOf(p, 4)
	}
	throw new Error("no Hamming(10,6,3) parity")
}

/** The 9 link-control bytes of a Group Voice Channel User (LCF 0x00). */
export function p25GroupVoiceLc({ talkgroup, source, serviceOptions = 0 }) {
	return [
		0x00,
		0x00,
		serviceOptions & 0xff,
		0x00,
		(talkgroup >>> 8) & 0xff,
		talkgroup & 0xff,
		(source >>> 16) & 0xff,
		(source >>> 8) & 0xff,
		source & 0xff,
	]
}

/** Inserts the status dibits into one frame's data dibits. */
function withStatus(data, status = 2) {
	const out = []
	for (const dibit of data) {
		if ((out.length + 1) % 36 === 0) out.push(status)
		out.push(dibit)
	}
	while ((out.length + 1) % 36 === 0 || out.length % 36 !== 0) out.push(status)
	return out
}

function frameHead(nac, duid) {
	return [...bitsToDibits(bitsOf(FRAME_SYNC, 48)), ...bitsToDibits(p25NidBits(nac, duid))]
}

/** Dibits of one LDU1 (864 dibits, status included). */
export function p25Ldu1Dibits({ nac, lc, seed = 7 }) {
	const random = rng(seed)
	const noise = n => [...Array(n)].map(() => Math.floor(random() * 4))
	const lcBits = lc.flatMap(b => bitsOf(b, 8))
	const hexData = [...Array(12)].map((_, w) => parseInt(lcBits.slice(66 - 6 * w, 72 - 6 * w).join(""), 2))
	const hexParity = rs63Parity(hexData, 6)
	const word = hex => bitsToDibits([...bitsOf(hex, 6), ...hamming1063(hex)])
	const data = frameHead(nac, DUID.ldu1)
	const groups = [
		[11, 10, 9, 8].map(i => hexData[i]),
		[7, 6, 5, 4].map(i => hexData[i]),
		[3, 2, 1, 0].map(i => hexData[i]),
		[11, 10, 9, 8].map(i => hexParity[i]),
		[7, 6, 5, 4].map(i => hexParity[i]),
		[3, 2, 1, 0].map(i => hexParity[i]),
	]
	for (let v = 1; v <= 9; v++) {
		data.push(...noise(72))
		if (v >= 2 && v <= 7) for (const hex of groups[v - 2]) data.push(...word(hex))
		if (v === 8) data.push(...noise(16))
	}
	const frame = withStatus(data)
	if (frame.length !== 864) throw new Error(`LDU1 is ${frame.length} dibits`)
	return frame
}

/** Dibits of a TDU (72 dibits, status included). */
export function p25TduDibits({ nac }) {
	const frame = withStatus([...frameHead(nac, DUID.tdu), ...Array(14).fill(0)])
	if (frame.length !== 72) throw new Error(`TDU is ${frame.length} dibits`)
	return frame
}

/** Dibits of one call: `ldus` LDU1 frames and a TDU, after a 0.1 s pre-roll. */
export function p25CallDibits({ nac, talkgroup, source, ldus = 4 }) {
	const lc = p25GroupVoiceLc({ talkgroup, source })
	// Pre-roll: 0.1 s of seeded random dibits for the receiver's symbol timing.
	const random = rng(3)
	const out = [...Array(480)].map(() => Math.floor(random() * 4))
	for (let i = 0; i < ldus; i++) out.push(...p25Ldu1Dibits({ nac, lc, seed: 7 + i }))
	out.push(...p25TduDibits({ nac }))
	return out
}

/** C4FM deviation of a dibit (Hz). */
export const p25Deviation = dibit => [600, 1800, -600, -1800][dibit]

/** FM deviation (Hz, 48 kHz) of one P25 phase 1 call. */
export function p25Frequency(call, { rateHz = 48_000 } = {}) {
	return shapeFrequency(p25CallDibits(call), {
		symbolRate: 4800,
		rateHz,
		// Raised cosine 0.5: dsd-fme's integrate-and-slice symbol decision has
		// residual ISI from a 0.2 roll-off (measured: 20 Hamming corrections per call).
		shaping: "rc",
		alpha: 0.5,
		deviationHz: p25Deviation,
	})
}
