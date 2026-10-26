#!/usr/bin/env node
/**
 * Synthetic POCSAG IQ generator (decoder-enablement 3.18 tests).
 *
 * Writes cu8 IQ (interleaved unsigned 8-bit I/Q, 127.5 = zero) holding one
 * POCSAG burst, 2-FSK at +-4.5 kHz deviation, on a channel offset from the
 * capture centre, plus seeded Gaussian noise. No real capture or decoded
 * on-air content is involved: address and message are made up.
 *
 * POCSAG framing (ITU-R M.584-2): 576-bit 1010 preamble, then batches of the
 * sync codeword 0x7CD215D8 and 8 frames of 2 codewords. A codeword is 21
 * data bits, a BCH(31,21) check (generator x^10+x^9+x^8+x^6+x^5+x^3+1) and an
 * even-parity bit. Binary 1 is the lower frequency (-4.5 kHz).
 *
 * Usage:
 *   node scripts/fixtures/pocsag-iq.mjs <out.cu8> [--rate 1024000]
 *     [--offset 128250] [--baud 1200] [--address 1234567] [--message 12345]
 */
import { writeFileSync } from "node:fs"

const SYNC = 0x7cd215d8
const IDLE = 0x7a89c197
const BCH_POLY = 0x769

/** Codeword from its 21 data bits: BCH(31,21) check and even parity. */
export function pocsagCodeword(data21) {
	let r = (data21 << 10) >>> 0
	for (let bit = 30; bit >= 10; bit--)
		if (r & (1 << bit)) r = (r ^ (BCH_POLY << (bit - 10))) >>> 0
	let cw = (((data21 << 11) >>> 0) | ((r & 0x3ff) << 1)) >>> 0
	let ones = 0
	for (let x = cw; x; x >>>= 1) ones += x & 1
	return (cw | (ones & 1)) >>> 0
}

/** Numeric message digits as POCSAG BCD (each nibble bit-reversed). */
function numericNibbles(message) {
	const table = "0123456789*U -)("
	return [...message].map(ch => {
		const v = Math.max(0, table.indexOf(ch))
		return ((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3)
	})
}

/** Bits (0/1) of one numeric page: preamble, sync and batches. */
export function pocsagBits({ address, func = 0, message }) {
	const words = [
		pocsagCodeword(((address >>> 3) << 2) | (func & 3)) /* bit 31 = 0 */,
	]
	const nibbles = numericNibbles(message)
	while (nibbles.length % 5) nibbles.push(0b0011) // space, reversed 0xC
	for (let i = 0; i < nibbles.length; i += 5) {
		let d = 1 << 20
		for (let j = 0; j < 5; j++) d |= nibbles[i + j] << (16 - 4 * j)
		words.push(pocsagCodeword(d))
	}
	const frame = address & 7
	const slots = [...Array(frame * 2).fill(IDLE), ...words]
	const batches = []
	while (slots.length) batches.push(slots.splice(0, 16))
	const last = batches[batches.length - 1]
	while (last.length < 16) last.push(IDLE)
	batches.push(Array(16).fill(IDLE))
	const bits = []
	for (let i = 0; i < 576; i++) bits.push(i % 2 ? 0 : 1)
	for (const batch of batches)
		for (const cw of [SYNC, ...batch])
			for (let b = 31; b >= 0; b--) bits.push((cw >>> b) & 1)
	return bits
}

/** Seeded uniform PRNG (mulberry32). */
function rng(seed) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/**
 * cu8 IQ of the burst at `offsetHz` from the capture centre, with
 * `leadSeconds` of noise before and after. Amplitude 0.5 of full scale,
 * noise sigma `noise` (of full scale).
 */
export function synthesizePocsagCu8({
	sampleRateHz = 1_024_000,
	offsetHz = 0,
	baud = 1200,
	deviationHz = 4500,
	address = 1234567,
	message = "12345",
	leadSeconds = 0.1,
	noise = 0.02,
	seed = 1,
} = {}) {
	const bits = pocsagBits({ address, message })
	const lead = Math.round(leadSeconds * sampleRateHz)
	const burst = Math.ceil((bits.length / baud) * sampleRateHz)
	const n = lead + burst + lead
	const out = Buffer.alloc(2 * n)
	const random = rng(seed)
	const gauss = () =>
		Math.sqrt(-2 * Math.log(random() || 1e-12)) *
		Math.cos(2 * Math.PI * random())
	let phase = 0
	for (let i = 0; i < n; i++) {
		let I = 0
		let Q = 0
		const k = i - lead
		if (k >= 0 && k < burst) {
			const bit =
				bits[Math.min(bits.length - 1, Math.floor((k * baud) / sampleRateHz))]
			const f = offsetHz + (bit ? -deviationHz : deviationHz)
			phase += (2 * Math.PI * f) / sampleRateHz
			if (phase > Math.PI) phase -= 2 * Math.PI
			if (phase < -Math.PI) phase += 2 * Math.PI
			I = 0.5 * Math.cos(phase)
			Q = 0.5 * Math.sin(phase)
		}
		I += noise * gauss()
		Q += noise * gauss()
		out[2 * i] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * I)))
		out[2 * i + 1] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * Q)))
	}
	return out
}

function main(argv) {
	const [file, ...rest] = argv
	if (!file) {
		process.stderr.write(
			"usage: pocsag-iq.mjs <out.cu8> [--rate N] [--offset Hz] [--baud N] [--address N] [--message digits]\n",
		)
		process.exit(2)
	}
	const opt = {}
	for (let i = 0; i < rest.length; i += 2)
		opt[rest[i].replace(/^--/, "")] = rest[i + 1]
	const iq = synthesizePocsagCu8({
		...(opt.rate ? { sampleRateHz: Number(opt.rate) } : {}),
		...(opt.offset ? { offsetHz: Number(opt.offset) } : {}),
		...(opt.baud ? { baud: Number(opt.baud) } : {}),
		...(opt.address ? { address: Number(opt.address) } : {}),
		...(opt.message ? { message: opt.message } : {}),
	})
	writeFileSync(file, iq)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
