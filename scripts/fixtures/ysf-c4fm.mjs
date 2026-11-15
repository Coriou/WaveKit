/**
 * Synthetic Yaesu System Fusion (YSF) transmission (C4FM 4800 sym/s) for the
 * decoder chain tests: a header (HC), V/D mode 2 communication frames (CC)
 * and a terminator (TC). No side effects on import; callsigns are fictional.
 * Voice payload is seeded noise (no AMBE).
 *
 * Frame (100 ms, 480 symbols), as dsd-fme ysf.c reads it:
 * - frame sync 0xD471C9634D (20 dibits);
 * - FICH (100 dibits): 32 bits (FI, CS, CM, BN, BT, FN, FT, reserved, MR,
 *   VoIP, DT, SQL type, SQL code / DG-ID) and CRC-16 (x^16+x^12+x^5+1, init
 *   0, inverted), four Golay(24,12) words (dsd-fme's generator matrix),
 *   4 zero tail bits, convolutional code K = 5 (G1 = 1 + D^3 + D^4,
 *   G2 = 1 + D + D^2 + D^4, dibit G1 G2), interleaved 20 x 5 dibits;
 * - HC / TC: ten 36-dibit blocks, the even ones CSD1 (destination and
 *   source callsigns, 10 bytes each), the odd ones CSD2 (uplink, downlink);
 *   each DCH is 160 bits whitened with the 9-bit PN (x^9 + x^5 + 1, seed
 *   111001001), CRC-16, 4 tail bits, the K = 5 code, interleaved 20 x 9;
 * - V/D mode 2 CC: five blocks of 20 DCH dibits and 52 VeCH dibits; the
 *   DCH (80 bits whitened, CRC-16, tail, K = 5, 20 x 5) holds the
 *   destination in FN 0 and the source in FN 1.
 * Dibit 01 is +3 (+1800 Hz), 00 +1, 10 -1, 11 -3; raised-cosine shaping, roll-off 0.5.
 * Each over leads with two settle frames (sync and noise, no valid FICH).
 */
import {
	bitsOf,
	bitsToDibits,
	bytesToBits,
	rng,
	shapeFrequency,
} from "./fsk-iq.mjs"

const FRAME_SYNC = 0xd471c9634d

// Golay_24_12_m_G parity columns (fec.c), one 12-bit row per data bit.
const GOLAY_P = [
	"110001110101",
	"011000111011",
	"111101101000",
	"011110110100",
	"001111011010",
	"110110011001",
	"011011001101",
	"001101100111",
	"110111000110",
	"101010010111",
	"100100111110",
	"100011101011",
]

/** Golay(24,12) codeword bits (data first) of 12 data bits. */
export function golay2412(data) {
	const parity = new Array(12).fill(0)
	data.forEach((bit, i) => {
		if (bit) for (let j = 0; j < 12; j++) parity[j] ^= Number(GOLAY_P[i][j])
	})
	return [...data, ...parity]
}

/** YSF CRC-16 bits of `bits`, so that ysf.c's crc16ysf(bits ++ crc) is 0. */
export function ysfCrc(bits) {
	let crc = 0
	for (const bit of [...bits, ...Array(16).fill(0)]) {
		crc = ((crc << 1) | bit) & 0x1ffff
		if (crc & 0x10000) crc = (crc & 0xffff) ^ 0x1021
	}
	return bitsOf(crc ^ 0xffff, 16)
}

/** The 9-bit whitening sequence (seed 111001001, x^9 + x^5 + 1); equals ysf.c pn95[]. */
export function pn95(n) {
	let s = [1, 0, 0, 1, 0, 0, 1, 1, 1]
	const out = []
	for (let i = 0; i < n; i++) {
		out.push(s[0])
		const fb = s[0] ^ s[4]
		s = [...s.slice(1), fb]
	}
	return out
}
const PN = pn95(160)

/** K = 5 convolutional code (4 zero tail bits appended), as dibits. */
export function conv5Dibits(bits) {
	const reg = [0, 0, 0, 0]
	const out = []
	for (const b of [...bits, 0, 0, 0, 0]) {
		const g1 = b ^ reg[2] ^ reg[3]
		const g2 = b ^ reg[0] ^ reg[1] ^ reg[3]
		out.push((g1 << 1) | g2)
		reg.unshift(b)
		reg.pop()
	}
	return out
}

/** Transmit order of a block deinterleaved by buf[j + rows i] = in[i + 20 j]. */
function interleave(coded, rows) {
	const out = new Array(coded.length)
	for (let i = 0; i < 20; i++)
		for (let j = 0; j < rows; j++) out[i + 20 * j] = coded[j + rows * i]
	return out
}

/** The 100 FICH dibits. */
export function ysfFichDibits({
	fi,
	cm = 0,
	bn = 0,
	bt = 0,
	fn = 0,
	ft = 0,
	dt = 2,
	vp = 0,
	mr = 0,
	dgid = 0,
}) {
	const info = [
		...bitsOf(fi, 2),
		...bitsOf(0, 2),
		...bitsOf(cm, 2),
		...bitsOf(bn, 2),
		...bitsOf(bt, 2),
		...bitsOf(fn, 3),
		...bitsOf(ft, 3),
		0,
		0,
		...bitsOf(mr, 3),
		vp,
		...bitsOf(dt, 2),
		0,
		...bitsOf(dgid, 7),
	]
	const fich = [...info, ...ysfCrc(info)]
	const golay = [0, 1, 2, 3].flatMap(i =>
		golay2412(fich.slice(12 * i, 12 * i + 12)),
	)
	return interleave(conv5Dibits(golay), 5)
}

/** DCH dibits for `bytes` (20 bytes: 180 dibits, 20 x 9; 10 bytes: 100 dibits, 20 x 5). */
function dchDibits(bytes, { badCrc = false } = {}) {
	const data = bytesToBits(bytes).map((bit, i) => bit ^ PN[i])
	// badCrc: a valid code word whose CRC does not match (a corrupted block).
	const crc = ysfCrc(data).map(bit => (badCrc ? bit ^ 1 : bit))
	return interleave(conv5Dibits([...data, ...crc]), bytes.length === 20 ? 9 : 5)
}

const callsign = text => [
	...Buffer.from(text.padEnd(10, " ").slice(0, 10), "latin1"),
]

function frame(fich, payload) {
	const out = [...bitsToDibits(bitsOf(FRAME_SYNC, 40)), ...fich, ...payload]
	if (out.length !== 480) throw new Error(`YSF frame is ${out.length} symbols`)
	return out
}

/** HC (fi 0) or TC (fi 2) frame dibits. */
export function ysfHeaderDibits({ fi, dest, src, dgid = 0, badCsd1 = false }) {
	const csd1 = dchDibits([...callsign(dest), ...callsign(src)], {
		badCrc: badCsd1,
	})
	const csd2 = dchDibits([...callsign(""), ...callsign("")])
	const payload = []
	for (let i = 0; i < 10; i++) {
		const csd = i % 2 ? csd2 : csd1
		payload.push(...csd.slice(36 * (i >> 1), 36 * (i >> 1) + 36))
	}
	return frame(ysfFichDibits({ fi, dt: 2, ft: 6, dgid }), payload)
}

/** V/D mode 2 CC frame `fn` of `ft + 1`, with seeded voice. */
export function ysfVd2Dibits({ fn, ft, dest, src, dgid = 0, seed = 11 }) {
	const random = rng(seed + fn)
	const text = fn === 0 ? dest : fn === 1 ? src : ""
	const dch = dchDibits(callsign(text))
	const payload = []
	for (let i = 0; i < 5; i++) {
		payload.push(...dch.slice(20 * i, 20 * i + 20))
		for (let j = 0; j < 52; j++) payload.push(Math.floor(random() * 4))
	}
	return frame(ysfFichDibits({ fi: 1, dt: 2, fn, ft, dgid }), payload)
}

/**
 * Dibits of one YSF over: two settle frames, HC, `frames` V/D2 CC frames, TC.
 * dsd-fme sets its symbol levels from the first frame syncs and loses those
 * frames, so two frames of sync and noise (no valid FICH) lead.
 * `badCsd1` sends a header whose CSD1 fails its CRC.
 */
export function ysfCallDibits({
	dest,
	src,
	dgid = 0,
	frames = 7,
	badCsd1 = false,
	seed = 5,
}) {
	const random = rng(seed)
	const noise = n => [...Array(n)].map(() => Math.floor(random() * 4))
	const out = noise(480)
	for (let i = 0; i < 2; i++)
		out.push(...bitsToDibits(bitsOf(FRAME_SYNC, 40)), ...noise(460))
	out.push(...ysfHeaderDibits({ fi: 0, dest, src, dgid, badCsd1 }))
	for (let fn = 0; fn < frames; fn++)
		out.push(...ysfVd2Dibits({ fn, ft: frames - 1, dest, src, dgid }))
	out.push(...ysfHeaderDibits({ fi: 2, dest, src, dgid }))
	return out
}

/** Dibits of back-to-back overs (`ysfCallDibits` each), 0.25 s of noise apart. */
export function ysfOversDibits(overs) {
	const random = rng(17)
	return overs.flatMap((over, i) => [
		...(i > 0 ? [...Array(1200)].map(() => Math.floor(random() * 4)) : []),
		...ysfCallDibits({ ...over, seed: 5 + i }),
	])
}

/** FM deviation (Hz, 48 kHz) of one YSF call. */
export function ysfFrequency(call, { rateHz = 48_000 } = {}) {
	return ysfShape(ysfCallDibits(call), rateHz)
}

/** FM deviation (Hz, 48 kHz) of back-to-back YSF overs. */
export function ysfOversFrequency(overs, { rateHz = 48_000 } = {}) {
	return ysfShape(ysfOversDibits(overs), rateHz)
}

function ysfShape(dibits, rateHz) {
	return shapeFrequency(dibits, {
		symbolRate: 4800,
		rateHz,
		// Raised cosine 0.5: dsd-fme's integrate-and-slice symbol decision has
		// residual ISI from a 0.2 roll-off (measured: 5 of 11 FICH CRC failures).
		shaping: "rc",
		alpha: 0.5,
		deviationHz: dibit => [600, 1800, -600, -1800][dibit],
	})
}
