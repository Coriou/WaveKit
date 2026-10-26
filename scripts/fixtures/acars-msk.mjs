#!/usr/bin/env node
/**
 * Synthetic ACARS generator (scanner replay groundwork).
 *
 * One ARINC 618 downlink block, made up (mode, registration, label, text):
 * a pre-key of ones, `+` (with its odd parity bit), `*`, SYN, SYN, SOH, the
 * text block (mode, 7-character address, technical ack, label, block id, STX,
 * text, ETX; a downlink block id is a digit, so the text starts with a
 * made-up 4-character message number and 6-character flight id), the CRC-16 (reflected 0x8408, initial 0, over the text block
 * from the mode character through ETX, low byte first) and DEL. Every
 * character carries odd parity in bit 7 and is sent LSB first.
 *
 * Modulation: 2400 bit/s MSK on 1200 and 2400 Hz audio tones; a bit equal to
 * the previous one is sent at 2400 Hz, a changed bit at 1200 Hz (what the
 * acarsdec demodulator's alternating I/Q decisions read back).
 *
 * Outputs: `.s16` is 12 000 Hz signed 16-bit mono audio (what acarsdec reads
 * with `--sndfile <file>,subtype=0x02 -m 1`); `.cf32` is 48 000 Hz complex
 * float32 IQ, the audio as AM (depth 0.5) on a carrier offset from the centre,
 * like a replayed capture. Checked with the image's acarsdec: the `.s16`
 * output decodes as one block with `error` 0, and so does the `.cf32` output
 * after an offline AM envelope detector and 12 kHz resampling (the bit stream
 * comes back inverted there; the 32-byte pre-key lets acarsdec flip its
 * polarity and still sync).
 *
 * Usage:
 *   node scripts/fixtures/acars-msk.mjs <out.s16|out.cf32> [--offset 2000]
 */
import { writeFileSync } from "node:fs"

const AUDIO_HZ = 12_000
const IQ_HZ = 48_000
const BAUD = 2_400
/**
 * Pre-key: 32 bytes of ones. acarsdec syncs on at least 12 bytes of 0xFF before `+`; on a
 * stream it hears inverted (an AM demodulator's MSK sampling phase can flip it) it first counts
 * 10 bytes of 0x00 to flip its polarity, then needs the 12, so 22 or more are needed either way.
 */
const PREKEY_BYTES = 32

/** `c` (7-bit) with odd parity in bit 7. */
export function oddParity(c) {
	let ones = 0
	for (let i = 0; i < 7; i++) ones += (c >> i) & 1
	return (c & 0x7f) | ((ones & 1) === 0 ? 0x80 : 0)
}

/** CRC-16, reflected polynomial 0x8408, initial 0. */
export function acarsCrc(bytes) {
	let crc = 0
	for (const b of bytes) {
		crc ^= b
		for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1
	}
	return crc
}

/** The block's bytes, from the pre-key to DEL. */
export function acarsBytes({
	mode = "2",
	address = ".N12345",
	label = "H1",
	blockId = "1",
	msgno = "M01A",
	flight = "XX0001",
	text = "WAVEKIT TEST",
} = {}) {
	const chars = s => [...s].map(c => c.charCodeAt(0))
	const block = [
		...chars(mode),
		...chars(address.padStart(7, ".").slice(0, 7)),
		0x15,
		...chars(label),
		...chars(blockId),
		0x02,
		// a downlink (digit block id) text starts with the message number (4) and flight id (6)
		...(/^[0-9]$/.test(blockId)
			? chars(
					msgno.padEnd(4, " ").slice(0, 4) + flight.padEnd(6, " ").slice(0, 6),
				)
			: []),
		...chars(text),
		0x03,
	].map(oddParity)
	const crc = acarsCrc(block)
	return [
		...Array(PREKEY_BYTES).fill(0xff),
		oddParity(0x2b),
		oddParity(0x2a),
		0x16,
		0x16,
		0x01,
		...block,
		crc & 0xff,
		crc >> 8,
		0x7f,
	]
}

/** MSK audio (floats in -1..1) at `rate` (a multiple of 2 400), with `leadSeconds` of silence around it. */
export function acarsAudio(options = {}, rate = AUDIO_HZ, leadSeconds = 0.1) {
	const bits = []
	for (const b of acarsBytes(options))
		for (let i = 0; i < 8; i++) bits.push((b >> i) & 1)
	const spb = rate / BAUD
	const lead = Math.round(leadSeconds * rate)
	const out = new Float32Array(lead * 2 + bits.length * spb)
	let n = lead
	let phase = 0
	let prev = 1
	for (const bit of bits) {
		const f = bit === prev ? 2400 : 1200
		prev = bit
		for (let k = 0; k < spb; k++) {
			phase += (2 * Math.PI * f) / rate
			out[n++] = Math.sin(phase)
		}
	}
	return out
}

/** 12 kHz signed 16-bit audio bytes. */
export function acarsS16(options = {}) {
	const a = acarsAudio(options, AUDIO_HZ)
	const out = Buffer.alloc(a.length * 2)
	for (let i = 0; i < a.length; i++)
		out.writeInt16LE(Math.round(a[i] * 12_000), i * 2)
	return out
}

/** 48 kHz cf32 IQ: the audio as AM (depth 0.5) on a carrier at `offsetHz`. */
export function acarsCf32(options = {}, offsetHz = 2_000, amplitude = 0.4) {
	const a = acarsAudio(options, IQ_HZ)
	const out = new Float32Array(a.length * 2)
	for (let n = 0; n < a.length; n++) {
		const env = amplitude * (1 + 0.5 * a[n])
		const ph = (2 * Math.PI * offsetHz * n) / IQ_HZ
		out[2 * n] = env * Math.cos(ph)
		out[2 * n + 1] = env * Math.sin(ph)
	}
	return Buffer.from(out.buffer)
}

function main(argv) {
	const [outPath, ...rest] = argv
	if (!outPath || !/\.(s16|cf32)$/.test(outPath)) {
		process.stderr.write(
			"usage: acars-msk.mjs <out.s16|out.cf32> [--offset hz]\n",
		)
		process.exit(2)
	}
	const i = rest.indexOf("--offset")
	const offset = i >= 0 ? Number(rest[i + 1]) : 2_000
	writeFileSync(
		outPath,
		outPath.endsWith(".s16") ? acarsS16() : acarsCf32({}, offset),
	)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
