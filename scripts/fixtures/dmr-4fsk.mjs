/**
 * Synthetic DMR (ETSI TS 102 361-1) repeater downlink: one group voice call on
 * timeslot 1 while timeslot 2 sends Idle bursts. Each 30 ms burst is a CACH
 * (24 bits) plus 264 bits:
 *
 * - CACH: TACT (AT, TC = the following burst's slot, LCSS) with Hamming(7,4),
 *   then a null short-LC fragment, interleaved over 24 bits (7.1.3);
 * - data bursts (Voice LC header, Terminator with LC, Idle): 98 info bits,
 *   slot type (colour code, data type; Golay(20,8)), the BS data sync, slot
 *   type, 98 info bits. The info is BPTC(196,96) (B.1.1, interleave 181 mod
 *   196) of the 72-bit full LC and its RS(12,9) parity, masked 0x969696 (header)
 *   or 0x999999 (terminator) (B.3.12);
 * - voice bursts A to F: three 72-bit vocoder frames (seeded noise) around the
 *   BS voice sync (A) or the EMB (colour code, PI, LCSS; QR(16,7)) and 32
 *   bits of embedded LC (B to E: the 72-bit LC with its 5-bit checksum in
 *   BPTC(128,77), B.2.1; F: null).
 *
 * The code tables are the standard's (Annex B), in the bit order dsd-fme's
 * fec.c, bptc.c, dmr_bs.c and dmr_data.c read them (dsd-fme ed1d1d6).
 * Dibit 01 is +3 (+1944 Hz), 00 +1, 10 -1, 11 -3; the transmit filter is the
 * root raised cosine 0.2 (fsk-iq.mjs AIR_SHAPES.dmr) unless `shape` says
 * otherwise.
 */
import {
	AIR_SHAPES,
	bitsOf,
	bitsToDibits,
	rng,
	shapeFrequency,
} from "./fsk-iq.mjs"

const BS_VOICE_SYNC = 0x755fd7df75f7
const BS_DATA_SYNC = 0xdff57d75df5d
/** MS-sourced syncs (Table 9.2): a radio transmitting on its own, as in direct mode. */
const MS_VOICE_SYNC = 0x7f7d5dd57dfd
const MS_DATA_SYNC = 0xd5d7f77fd757

/** Data types (slot type, Table 6.13). */
export const DMR_DATA_TYPE = { voiceLcHeader: 1, terminatorLc: 2, idle: 9 }

/** Systematic encoder: data bits, then the XOR of the parity rows they select. */
function systematic(parityRows) {
	const rows = parityRows.map(row => row.split("").map(Number))
	return data => {
		const parity = new Array(rows[0].length).fill(0)
		data.forEach((bit, i) => {
			if (bit) rows[i].forEach((p, j) => (parity[j] ^= p))
		})
		return [...data, ...parity]
	}
}

/** Hamming(7,4,3), CACH TACT. */
export const hamming74 = systematic(["101", "111", "110", "011"])
/** Hamming(13,9,3), BPTC(196,96) columns. */
const hamming139 = systematic([
	"1111",
	"1110",
	"0111",
	"1010",
	"0101",
	"1011",
	"1100",
	"0110",
	"0011",
])
/** Hamming(15,11,3), BPTC(196,96) rows. */
const hamming1511 = systematic([
	"1001",
	"1101",
	"1111",
	"1110",
	"0111",
	"1010",
	"0101",
	"1011",
	"1100",
	"0110",
	"0011",
])
/** Hamming(16,11,4), BPTC(128,77) rows. */
const hamming16114 = systematic([
	"10011",
	"11010",
	"11111",
	"11100",
	"01110",
	"10101",
	"01011",
	"10110",
	"11001",
	"01101",
	"00111",
])
/** Golay(20,8), slot type. */
export const golay208 = systematic([
	"001111011010",
	"110110011001",
	"011011001101",
	"001101100111",
	"110111000110",
	"101010010111",
	"100100111110",
	"100011101011",
])
/** Quadratic residue (16,7,6), EMB. */
export const qr167 = systematic([
	"001001111",
	"100011110",
	"110110111",
	"111100010",
	"111001001",
	"011100101",
	"001110011",
])

/** GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1. */
const EXP = new Array(512)
const LOG = new Array(256)
{
	let x = 1
	for (let i = 0; i < 255; i++) {
		EXP[i] = x
		LOG[x] = i
		x <<= 1
		if (x & 0x100) x ^= 0x11d
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** RS(12,9) parity of 9 bytes: generator (x - a)(x - a^2)(x - a^3). */
export function rs129Parity(bytes) {
	let g = [1]
	for (let r = 1; r <= 3; r++) {
		const next = new Array(g.length + 1).fill(0)
		g.forEach((c, i) => {
			next[i] ^= c
			next[i + 1] ^= mul(c, EXP[r])
		})
		g = next
	}
	const rem = [...bytes, 0, 0, 0]
	for (let i = 0; i < bytes.length; i++) {
		const c = rem[i]
		if (c !== 0) for (let j = 1; j < g.length; j++) rem[i + j] ^= mul(g[j], c)
	}
	return rem.slice(bytes.length)
}

/** Group voice full LC (FLCO 0, FID 0, service options 0). */
export function dmrGroupVoiceLc({ talkgroup, source }) {
	return [
		0,
		0,
		0,
		(talkgroup >> 16) & 0xff,
		(talkgroup >> 8) & 0xff,
		talkgroup & 0xff,
		(source >> 16) & 0xff,
		(source >> 8) & 0xff,
		source & 0xff,
	]
}

const bytesBits = bytes => bytes.flatMap(b => bitsOf(b, 8))

/** BPTC(196,96) of 96 bits, interleaved (transmit order). */
export function bptc19696(bits96) {
	const m = Array.from({ length: 13 }, () => new Array(15).fill(0))
	let k = 0
	for (let i = 0; i < 9; i++) {
		// Row 0 starts with the reserved R(2), R(1), R(0).
		const data = []
		for (let j = 0; j < 11; j++) data.push(i === 0 && j < 3 ? 0 : bits96[k++])
		hamming1511(data).forEach((b, j) => (m[i][j] = b))
	}
	for (let j = 0; j < 15; j++)
		hamming139(m.slice(0, 9).map(row => row[j])).forEach(
			(b, i) => (m[i][j] = b),
		)
	const deinterleaved = [0, ...m.flat()] // R(3) first
	return Array.from({ length: 196 }, (_, i) => deinterleaved[(13 * i) % 196])
}

/** The four 32-bit embedded LC fragments (bursts B to E) of a 72-bit LC. */
export function embeddedLcFragments(lcBytes) {
	const lc = bytesBits(lcBytes)
	const crc = lcBytes.reduce((a, b) => a + b, 0) % 31
	const crcBits = bitsOf(crc, 5)
	const m = Array.from({ length: 8 }, () => new Array(16).fill(0))
	let k = 0
	for (let i = 0; i < 7; i++) {
		const data = []
		for (let j = 0; j < 11; j++)
			data.push(i >= 2 && j === 10 ? crcBits[i - 2] : lc[k++])
		hamming16114(data).forEach((b, j) => (m[i][j] = b))
	}
	for (let j = 0; j < 16; j++)
		m[7][j] = m.slice(0, 7).reduce((p, row) => p ^ row[j], 0)
	const stream = []
	for (let j = 0; j < 16; j++) for (let i = 0; i < 8; i++) stream.push(m[i][j])
	return [0, 1, 2, 3].map(f => stream.slice(32 * f, 32 * f + 32))
}

/** CACH: TACT (AT busy, TC = `slot` 0/1, LCSS 0) and a null short LC fragment. */
export function cachBits(slot) {
	const tact = hamming74([1, slot, 0, 0])
	const cach = [...tact, ...new Array(17).fill(0)]
	const order = [
		0, 7, 8, 9, 1, 10, 11, 12, 2, 13, 14, 15, 3, 16, 4, 17, 18, 19, 5, 20, 21,
		22, 6, 23,
	]
	return order.map(i => cach[i])
}

/** One data burst (264 bits) of `dataType` carrying the 96 info bits. */
export function dataBurstBits({
	colourCode,
	dataType,
	info96,
	sync = BS_DATA_SYNC,
}) {
	const info = bptc19696(info96)
	const slotType = golay208([...bitsOf(colourCode, 4), ...bitsOf(dataType, 4)])
	return [
		...info.slice(0, 98),
		...slotType.slice(0, 10),
		...bitsOf(sync, 48),
		...slotType.slice(10),
		...info.slice(98),
	]
}

/** The full LC with its masked RS(12,9) parity, as 96 bits. */
export function lcInfoBits(lcBytes, mask) {
	const parity = rs129Parity(lcBytes).map(
		(p, i) => p ^ ((mask >> (16 - 8 * i)) & 0xff),
	)
	return bytesBits([...lcBytes, ...parity])
}

/** One voice burst (264 bits): A carries the sync, B to F the EMB. */
export function voiceBurstBits({
	index,
	colourCode,
	fragments,
	random,
	sync = BS_VOICE_SYNC,
}) {
	const vocoder = () => [...Array(216)].map(() => (random() < 0.5 ? 0 : 1))
	const frames = vocoder()
	let middle
	if (index === 0) middle = bitsOf(sync, 48)
	else {
		// LCSS: B first fragment, C and D continuation, E last, F none.
		const lcss = [0, 1, 3, 3, 2, 0][index]
		const emb = qr167([...bitsOf(colourCode, 4), 0, ...bitsOf(lcss, 2)])
		const data = index <= 4 ? fragments[index - 1] : new Array(32).fill(0)
		middle = [...emb.slice(0, 8), ...data, ...emb.slice(8)]
	}
	return [...frames.slice(0, 108), ...middle, ...frames.slice(108)]
}

/**
 * Dibits of one call on slot 1, slot 2 idle throughout: `settle` idle burst
 * pairs (the repeater keying up), `headers` Voice LC headers, `superframes`
 * voice superframes (A to F), two terminators, then two idle pairs.
 */
export function dmrCallDibits({
	colourCode = 1,
	talkgroup,
	source,
	superframes = 3,
	headers = 2,
	settle = 3,
	seed = 19,
}) {
	const random = rng(seed)
	const lc = dmrGroupVoiceLc({ talkgroup, source })
	const fragments = embeddedLcFragments(lc)
	// Idle bursts with seeded payloads: dsd-fme treats repeated identical
	// bursts as a lost carrier (dmr_bs.c redundancy check).
	const idleBurst = () =>
		dataBurstBits({
			colourCode,
			dataType: DMR_DATA_TYPE.idle,
			info96: [...Array(96)].map(() => (random() < 0.5 ? 0 : 1)),
		})
	const slot1 = []
	for (let i = 0; i < settle; i++) slot1.push(idleBurst())
	for (let i = 0; i < headers; i++)
		slot1.push(
			dataBurstBits({
				colourCode,
				dataType: DMR_DATA_TYPE.voiceLcHeader,
				info96: lcInfoBits(lc, 0x969696),
			}),
		)
	for (let s = 0; s < superframes; s++)
		for (let index = 0; index < 6; index++)
			slot1.push(voiceBurstBits({ index, colourCode, fragments, random }))
	for (let i = 0; i < 2; i++)
		slot1.push(
			dataBurstBits({
				colourCode,
				dataType: DMR_DATA_TYPE.terminatorLc,
				info96: lcInfoBits(lc, 0x999999),
			}),
		)
	for (let i = 0; i < 2; i++) slot1.push(idleBurst())
	const bits = []
	for (const burst of slot1) {
		bits.push(...cachBits(0), ...burst)
		bits.push(...cachBits(1), ...idleBurst())
	}
	// 0.1 s of seeded random dibits before (the receiver's symbol timing).
	return [
		...[...Array(480)].map(() => Math.floor(random() * 4)),
		...bitsToDibits(bits),
	]
}

/** FM deviation (Hz, 48 kHz) of one DMR call (dmrCallDibits). */
export function dmrFrequency(
	call,
	{ rateHz = 48_000, shape = AIR_SHAPES.dmr } = {},
) {
	return shapeFrequency(dmrCallDibits(call), {
		symbolRate: 4800,
		rateHz,
		...shape,
		deviationHz: dibit => [648, 1944, -648, -1944][dibit],
	})
}

/** Direct-mode frame: one 27.5 ms burst (132 symbols) per 60 ms (288 symbols). */
export const DMR_DIRECT_BURST_SYMBOLS = 132
export const DMR_DIRECT_FRAME_SYMBOLS = 288
/** A symbol of carrier-off time in dmrDirectCallDibits. */
export const DMR_KEYED_OFF = 4

/**
 * Dibits of one direct-mode call (a radio to radios, no repeater): the same
 * call as dmrCallDibits (Voice LC headers, `superframes` voice superframes,
 * two terminators) with the MS-sourced syncs, one 264-bit burst per 60 ms
 * frame and the carrier off for the other 156 symbols (DMR_KEYED_OFF; the
 * carrier ramps inside that guard, dmrDirectEnvelope). No CACH: only a
 * repeater sends one.
 */
export function dmrDirectCallDibits({
	colourCode = 1,
	talkgroup,
	source,
	superframes = 3,
	headers = 2,
	seed = 19,
}) {
	const random = rng(seed)
	const lc = dmrGroupVoiceLc({ talkgroup, source })
	const fragments = embeddedLcFragments(lc)
	const bursts = []
	for (let i = 0; i < headers; i++)
		bursts.push(
			dataBurstBits({
				colourCode,
				dataType: DMR_DATA_TYPE.voiceLcHeader,
				info96: lcInfoBits(lc, 0x969696),
				sync: MS_DATA_SYNC,
			}),
		)
	for (let s = 0; s < superframes; s++)
		for (let index = 0; index < 6; index++)
			bursts.push(
				voiceBurstBits({
					index,
					colourCode,
					fragments,
					random,
					sync: MS_VOICE_SYNC,
				}),
			)
	for (let i = 0; i < 2; i++)
		bursts.push(
			dataBurstBits({
				colourCode,
				dataType: DMR_DATA_TYPE.terminatorLc,
				info96: lcInfoBits(lc, 0x999999),
				sync: MS_DATA_SYNC,
			}),
		)
	const off = () =>
		new Array(DMR_DIRECT_FRAME_SYMBOLS - DMR_DIRECT_BURST_SYMBOLS).fill(
			DMR_KEYED_OFF,
		)
	const out = off()
	for (const burst of bursts) out.push(...bitsToDibits(burst), ...off())
	return out
}

/** FM deviation (Hz, 48 kHz) of a direct-mode call; zero while keyed off. */
export function dmrDirectFrequency(
	call,
	{ rateHz = 48_000, shape = AIR_SHAPES.dmr } = {},
) {
	return shapeFrequency(dmrDirectCallDibits(call), {
		symbolRate: 4800,
		rateHz,
		...shape,
		deviationHz: dibit => [648, 1944, -648, -1944, 0][dibit],
	})
}

/**
 * Carrier amplitude (0 to 1) per sample of dmrDirectFrequency: full over each
 * burst, a raised-cosine ramp of `rampSeconds` just outside it (inside the
 * guard time), off otherwise. Same length and padding as the frequency trace.
 */
export function dmrDirectEnvelope(
	call,
	{ rateHz = 48_000, rampSeconds = 0.00125, padSymbols = 8 } = {},
) {
	const symbols = dmrDirectCallDibits(call)
	const sps = rateHz / 4800
	const n = Math.ceil((symbols.length + 2 * padSymbols) * sps)
	const on = new Uint8Array(n)
	for (let i = 0; i < n; i++) {
		const k = Math.floor(i / sps) - padSymbols
		on[i] = k >= 0 && k < symbols.length && symbols[k] !== DMR_KEYED_OFF ? 1 : 0
	}
	const ramp = Math.max(1, Math.round(rampSeconds * rateHz))
	const rise = d => 0.5 + 0.5 * Math.cos((Math.PI * d) / ramp)
	const out = new Float64Array(n)
	// Distance to the nearest on sample, from the left then from the right.
	let last = -Infinity
	for (let i = 0; i < n; i++) {
		if (on[i]) {
			out[i] = 1
			last = i
		} else if (i - last <= ramp) out[i] = rise(i - last)
	}
	let next = Infinity
	for (let i = n - 1; i >= 0; i--) {
		if (on[i]) next = i
		else if (next - i <= ramp) out[i] = Math.max(out[i], rise(next - i))
	}
	return out
}

/** One 60 ms TDMA frame: two 30 ms halves of 144 symbols (CACH or guard, then a burst). */
export const DMR_FRAME_MS = 60
const HALF_SYMBOLS = 144

/**
 * A DMR timeline of overs with true key-up and key-down (dv-plan.mjs), as
 * dibits from time 0 (DMR_KEYED_OFF where the carrier is off). Each over:
 * `startMs` (rounded to a 60 ms frame), `durationMs` (rounded to whole
 * bursts, at least a header, one voice burst and a terminator), `slot` 1 or
 * 2, `talkgroup`, `source`, `headers` Voice LC headers (default 1: a cold
 * key-up, no settle), `terminator` (default true: one Terminator with LC),
 * `lateEntry` the voice burst it starts at (0 = A; 2 = C: a receiver joining
 * mid-superframe, no header then).
 *
 * `mode` "direct": each over's radio keys one 27.5 ms burst per 60 ms in its
 * slot's half, MS syncs, carrier off between bursts and between overs.
 * "repeater": the downlink with CACH and BS syncs, keyed from an over's first
 * burst until `hangMs` (rounded to frames) after its last; a slot with no
 * over burst sends Idle while keyed (the hang-time idles), carrier off after.
 *
 * Returns the dibits and the overs as sent: start and end (ms from time 0:
 * the repeater's first and last half-frame of the over, a direct radio's
 * first burst's first and last burst's last symbol), and `frames`: the link
 * control frames it carries (headers, terminator, and one embedded LC per
 * superframe whose bursts B to E were all sent).
 */
export function dmrPlanDibits(
	overs,
	{ mode = "direct", hangMs = 0, colourCode = 1, seed = 29 } = {},
) {
	const random = rng(seed)
	const repeater = mode === "repeater"
	const voiceSync = repeater ? BS_VOICE_SYNC : MS_VOICE_SYNC
	const dataSync = repeater ? BS_DATA_SYNC : MS_DATA_SYNC
	/** Per slot (0, 1): frame index -> burst bits. */
	const slots = [new Map(), new Map()]
	const sent = []
	let lastFrame = 0
	for (const over of overs) {
		const slot = (over.slot ?? 1) - 1
		if (slot !== 0 && slot !== 1) throw new Error("a DMR slot is 1 or 2")
		const headers = over.lateEntry ? 0 : (over.headers ?? 1)
		const terminator = over.terminator ?? true
		const term = terminator ? 1 : 0
		const n = Math.max(
			headers + term + 1,
			Math.round(over.durationMs / DMR_FRAME_MS),
		)
		const first = Math.round(over.startMs / DMR_FRAME_MS)
		const lc = dmrGroupVoiceLc(over)
		const fragments = embeddedLcFragments(lc)
		const bursts = []
		for (let i = 0; i < headers; i++)
			bursts.push(
				dataBurstBits({
					colourCode,
					dataType: DMR_DATA_TYPE.voiceLcHeader,
					info96: lcInfoBits(lc, 0x969696),
					sync: dataSync,
				}),
			)
		// Embedded LC: a superframe counts when its bursts B to E were all sent.
		let index = over.lateEntry ?? 0
		let seen = new Set()
		let embedded = 0
		for (let v = 0; v < n - headers - term; v++) {
			bursts.push(
				voiceBurstBits({
					index,
					colourCode,
					fragments,
					random,
					sync: voiceSync,
				}),
			)
			seen.add(index)
			if (index === 4 && [1, 2, 3, 4].every(i => seen.has(i))) embedded++
			index = (index + 1) % 6
			if (index === 0) seen = new Set()
		}
		if (terminator)
			bursts.push(
				dataBurstBits({
					colourCode,
					dataType: DMR_DATA_TYPE.terminatorLc,
					info96: lcInfoBits(lc, 0x999999),
					sync: dataSync,
				}),
			)
		bursts.forEach((b, k) => {
			if (slots[slot].has(first + k))
				throw new Error(`two overs share slot ${slot + 1} at ${first + k}`)
			slots[slot].set(first + k, b)
		})
		const last = first + bursts.length - 1
		lastFrame = Math.max(lastFrame, last)
		const halfMs = DMR_FRAME_MS / 2
		// Direct: the carrier is on for the burst only, after a 6-symbol guard.
		const guardMs = repeater ? 0 : (6 / 4800) * 1000
		const onMs = repeater ? halfMs : (132 / 4800) * 1000
		sent.push({
			slot: slot + 1,
			talkgroup: over.talkgroup,
			source: over.source,
			startMs: first * DMR_FRAME_MS + slot * halfMs + guardMs,
			endMs: last * DMR_FRAME_MS + slot * halfMs + guardMs + onMs,
			frames: headers + term + embedded,
			terminator,
			bursts: bursts.length,
		})
	}
	const hang = Math.round(hangMs / DMR_FRAME_MS)
	const keyed = f =>
		sent.some(
			o =>
				f >= Math.floor(o.startMs / DMR_FRAME_MS) &&
				f <= Math.floor((o.endMs - 1) / DMR_FRAME_MS) + hang,
		)
	const idleBurst = () =>
		dataBurstBits({
			colourCode,
			dataType: DMR_DATA_TYPE.idle,
			info96: [...Array(96)].map(() => (random() < 0.5 ? 0 : 1)),
			sync: dataSync,
		})
	const off = n => new Array(n).fill(DMR_KEYED_OFF)
	const out = []
	for (let f = 0; f <= lastFrame + hang; f++) {
		if (repeater) {
			if (!keyed(f)) {
				out.push(...off(2 * HALF_SYMBOLS))
				continue
			}
			for (const s of [0, 1])
				out.push(
					...bitsToDibits([
						...cachBits(s),
						...(slots[s].get(f) ?? idleBurst()),
					]),
				)
			continue
		}
		// Direct: a radio's burst in its slot's half, 6 guard symbols of the
		// 12 a CACH would take before it, off otherwise.
		for (const s of [0, 1]) {
			const burst = slots[s].get(f)
			if (burst === undefined) out.push(...off(HALF_SYMBOLS))
			else out.push(...off(6), ...bitsToDibits(burst), ...off(6))
		}
	}
	return { dibits: out, symbolRate: 4800, overs: sent }
}
