#!/usr/bin/env node
/**
 * Synthetic OOK sensor IQ generator (scanner replay tests).
 *
 * Writes cf32 IQ (interleaved little-endian float32 I/Q) or cu8 IQ holding one
 * burst of a 40-bit pulse-position OOK temperature/humidity frame in the
 * Acurite 609TXC layout, the frame repeated as the sensor does, on a tone
 * offset from the capture centre, plus seeded Gaussian noise. No real capture
 * or decoded on-air content is involved: id, status, temperature and humidity
 * are made up.
 *
 * Frame (40 bits, MSB first): id (8), status (4), temperature in 0.1 C (12,
 * two's complement), humidity % (8), checksum (8: the sum of the first four
 * bytes modulo 256). Each bit is a 500 us carrier pulse followed by a 1000 us
 * gap (0) or a 2000 us gap (1); each row ends with one more pulse and a
 * 4000 us gap. rtl_433 reports every checksummed row, so one burst of
 * `repeats` rows gives `repeats` identical decodes.
 *
 * Usage:
 *   node scripts/fixtures/ook-sensor-iq.mjs <out.cf32|out.cu8> [--rate 250000]
 *     [--offset 0] [--id 90] [--status 2] [--temp 21.5] [--humidity 40]
 */
import { writeFileSync } from "node:fs"

const PULSE_US = 500
const ZERO_GAP_US = 1000
const ONE_GAP_US = 2000
const ROW_GAP_US = 4000

/** The 40 frame bits (0/1, MSB first). */
export function sensorBits({ id, status, tempC, humidity }) {
	const temp = Math.round(tempC * 10) & 0xfff
	const bytes = [
		id & 0xff,
		((status & 0xf) << 4) | (temp >> 8),
		temp & 0xff,
		humidity & 0xff,
	]
	bytes.push(bytes.reduce((a, b) => a + b, 0) & 0xff)
	const bits = []
	for (const byte of bytes)
		for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1)
	return bits
}

/** Mulberry32: a small seeded PRNG so fixtures are reproducible. */
function prng(seed) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Complex baseband samples (interleaved I/Q floats in -1..1) of one burst. */
export function synthesizeOokSensor({
	sampleRateHz = 250_000,
	offsetHz = 0,
	id = 90,
	status = 2,
	tempC = 21.5,
	humidity = 40,
	repeats = 3,
	leadSeconds = 0.05,
	amplitude = 0.5,
	noise = 0.01,
	seed = 1,
} = {}) {
	const us = n => Math.round((n * sampleRateHz) / 1e6)
	const bits = sensorBits({ id, status, tempC, humidity })
	/** On/off runs in samples. */
	const runs = [[false, Math.round(leadSeconds * sampleRateHz)]]
	for (let r = 0; r < repeats; r++) {
		for (const bit of bits) {
			runs.push([true, us(PULSE_US)])
			runs.push([false, us(bit ? ONE_GAP_US : ZERO_GAP_US)])
		}
		runs.push([true, us(PULSE_US)])
		runs.push([false, us(ROW_GAP_US)])
	}
	runs.push([false, Math.round(leadSeconds * sampleRateHz)])
	const total = runs.reduce((n, [, len]) => n + len, 0)
	const out = new Float32Array(total * 2)
	const rnd = prng(seed)
	const gauss = () =>
		Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd())
	let n = 0
	for (const [on, len] of runs) {
		for (let k = 0; k < len; k++, n++) {
			const phase = (2 * Math.PI * offsetHz * n) / sampleRateHz
			const a = on ? amplitude : 0
			out[2 * n] = a * Math.cos(phase) + noise * gauss()
			out[2 * n + 1] = a * Math.sin(phase) + noise * gauss()
		}
	}
	return out
}

/** cf32 bytes of the samples. */
export function toCf32(samples) {
	return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
}

/** cu8 bytes of the samples (127.5 = zero, clipped). */
export function toCu8(samples) {
	const out = Buffer.alloc(samples.length)
	for (let i = 0; i < samples.length; i++)
		out[i] = Math.max(0, Math.min(255, Math.round(samples[i] * 127.5 + 127.5)))
	return out
}

function main(argv) {
	const [outPath, ...rest] = argv
	if (!outPath) {
		process.stderr.write(
			"usage: ook-sensor-iq.mjs <out.cf32|out.cu8> [--rate hz] [--offset hz] [--id n] [--status n] [--temp c] [--humidity n]\n",
		)
		process.exit(2)
	}
	const opt = name => {
		const i = rest.indexOf(`--${name}`)
		return i >= 0 ? Number(rest[i + 1]) : undefined
	}
	const pick = (key, name) =>
		opt(name) === undefined ? {} : { [key]: opt(name) }
	const samples = synthesizeOokSensor({
		...pick("sampleRateHz", "rate"),
		...pick("offsetHz", "offset"),
		...pick("id", "id"),
		...pick("status", "status"),
		...pick("tempC", "temp"),
		...pick("humidity", "humidity"),
	})
	writeFileSync(
		outPath,
		outPath.endsWith(".cu8") ? toCu8(samples) : toCf32(samples),
	)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
