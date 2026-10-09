/**
 * Pre-demodulation channel-power squelch (complex float32 IQ).
 */

import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { ChannelSquelch } from "../../../src/core/channel-squelch.js"

const RATE = 25_000
const MS = RATE / 1000

/** Complex float32 tone of the given amplitude, `ms` long. */
function tone(amplitude: number, ms: number, phase0 = 0): Buffer {
	const samples = Math.round(ms * MS)
	const buf = Buffer.alloc(samples * 8)
	for (let i = 0; i < samples; i++) {
		const phase = phase0 + (2 * Math.PI * 1000 * i) / RATE
		buf.writeFloatLE(amplitude * Math.cos(phase), i * 8)
		buf.writeFloatLE(amplitude * Math.sin(phase), i * 8 + 4)
	}
	return buf
}

/** Runs chunks through the squelch, returning the concatenated output. */
function run(squelch: ChannelSquelch, chunks: Buffer[]): Buffer {
	const out: Buffer[] = []
	for (const chunk of chunks) out.push(...squelch.process(chunk))
	return Buffer.concat(out)
}

function isZero(buf: Buffer): boolean {
	return buf.every(byte => byte === 0)
}

// -20 dBFS power = amplitude 0.1; -60 dBFS = amplitude 0.001.
const LOUD = 0.1
const QUIET = 0.001

describe("ChannelSquelch", () => {
	it("passes everything and still measures power when disabled", () => {
		const squelch = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: null,
		})
		const input = tone(LOUD, 100)
		const output = run(squelch, [input])
		expect(output.equals(input)).toBe(true)
		expect(squelch.open).toBe(true)
		expect(squelch.powerDbfs).toBeCloseTo(-20, 0)
	})

	it("mutes the channel below the threshold and opens above it", () => {
		const squelch = new ChannelSquelch({ sampleRate: RATE, thresholdDbfs: -40 })
		const noise = run(squelch, [tone(QUIET, 200)])
		expect(isZero(noise)).toBe(true)
		expect(squelch.open).toBe(false)
		const signal = tone(LOUD, 200)
		const passed = run(squelch, [signal])
		expect(passed.equals(signal)).toBe(true)
		expect(squelch.open).toBe(true)
	})

	it("holds open for the hang time measured in stream time, then closes", () => {
		const squelch = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -40,
			hangMs: 250,
		})
		run(squelch, [tone(LOUD, 100)])
		// 240 ms below threshold, delivered as one burst: still within the hang.
		const tail = run(squelch, [tone(QUIET, 240)])
		expect(isZero(tail)).toBe(false)
		expect(squelch.open).toBe(true)
		// Another 20 ms crosses the 250 ms hang.
		run(squelch, [tone(QUIET, 20)])
		expect(squelch.open).toBe(false)
		expect(isZero(run(squelch, [tone(QUIET, 50)]))).toBe(true)
	})

	it("uses hysteresis: a level just under the threshold keeps an open gate open", () => {
		const squelch = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -40,
			hysteresisDb: 3,
			hangMs: 100,
		})
		run(squelch, [tone(LOUD, 50)])
		// -41 dBFS: below the threshold but within the 3 dB hysteresis.
		const amp = Math.sqrt(10 ** (-41 / 10))
		const held = run(squelch, [tone(amp, 1000)])
		expect(squelch.open).toBe(true)
		expect(isZero(held)).toBe(false)
		// A closed gate does not open at -41 dBFS.
		const closed = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -40,
			hysteresisDb: 3,
		})
		expect(isZero(run(closed, [tone(amp, 200)]))).toBe(true)
	})

	it("timing does not depend on how the stream is chunked", () => {
		// Feature: live-analog-fixes, Property 3: squelch is chunking-invariant
		const reference = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -40,
			hangMs: 120,
		})
		const stream = Buffer.concat([
			tone(QUIET, 60),
			tone(LOUD, 80),
			tone(QUIET, 300),
			tone(LOUD, 40),
		])
		const expected = Buffer.concat([
			run(reference, [stream]),
			...reference.flush(),
		])
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 1, max: 4000 }), {
					minLength: 1,
					maxLength: 40,
				}),
				cuts => {
					const squelch = new ChannelSquelch({
						sampleRate: RATE,
						thresholdDbfs: -40,
						hangMs: 120,
					})
					const chunks: Buffer[] = []
					let offset = 0
					for (const size of cuts) {
						if (offset >= stream.length) break
						chunks.push(stream.subarray(offset, offset + size))
						offset += size
					}
					chunks.push(stream.subarray(offset))
					const out = Buffer.concat([run(squelch, chunks), ...squelch.flush()])
					expect(out.equals(expected)).toBe(true)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("changes the threshold live without losing alignment", () => {
		const squelch = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: null,
		})
		run(squelch, [tone(QUIET, 50)])
		squelch.setThreshold(-30)
		expect(isZero(run(squelch, [tone(QUIET, 50)]))).toBe(true)
		squelch.setThreshold(null)
		const input = tone(QUIET, 50)
		expect(run(squelch, [input]).equals(input)).toBe(true)
	})

	it("reports a floor instead of -Infinity for an all-zero channel", () => {
		const squelch = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: null,
		})
		run(squelch, [Buffer.alloc(8 * 2500)])
		expect(squelch.powerDbfs).toBe(-160)
	})
})
