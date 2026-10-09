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

/** Muted output: a constant complex vector at about -80 dBFS. */
function isMuted(buf: Buffer): boolean {
	if (buf.length < 8) return true
	const i0 = buf.readFloatLE(0)
	const q0 = buf.readFloatLE(4)
	if (Math.hypot(i0, q0) > 1.01e-4) return false
	for (let offset = 0; offset + 8 <= buf.length; offset += 8) {
		if (buf.readFloatLE(offset) !== i0 || buf.readFloatLE(offset + 4) !== q0)
			return false
	}
	return true
}

/** Model of `csdr fmdemod` (dphase / pi, phase state starting at 0). */
function fmdemod(buf: Buffer): number[] {
	const out: number[] = []
	let last = 0
	for (let offset = 0; offset + 8 <= buf.length; offset += 8) {
		const phase = Math.atan2(
			buf.readFloatLE(offset + 4),
			buf.readFloatLE(offset),
		)
		let d = phase - last
		while (d < -Math.PI) d += 2 * Math.PI
		while (d > Math.PI) d -= 2 * Math.PI
		out.push(d / Math.PI)
		last = phase
	}
	return out
}

/** Same signal up to a constant phase rotation (what FM ignores). */
function sameUpToRotation(a: Buffer, b: Buffer): boolean {
	if (a.length !== b.length) return false
	const da = fmdemod(a).slice(1)
	const db = fmdemod(b).slice(1)
	for (let n = 0; n < da.length; n++) {
		if (Math.abs(da[n]! - db[n]!) > 1e-4) return false
	}
	for (let offset = 0; offset + 8 <= a.length; offset += 8) {
		const ma = Math.hypot(a.readFloatLE(offset), a.readFloatLE(offset + 4))
		const mb = Math.hypot(b.readFloatLE(offset), b.readFloatLE(offset + 4))
		if (Math.abs(ma - mb) > 1e-6) return false
	}
	return true
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
		expect(isMuted(noise)).toBe(true)
		expect(squelch.open).toBe(false)
		const signal = tone(LOUD, 200)
		const passed = run(squelch, [signal])
		expect(sameUpToRotation(passed, signal)).toBe(true)
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
		expect(isMuted(tail)).toBe(false)
		expect(squelch.open).toBe(true)
		// Another 20 ms crosses the 250 ms hang.
		run(squelch, [tone(QUIET, 20)])
		expect(squelch.open).toBe(false)
		expect(isMuted(run(squelch, [tone(QUIET, 50)]))).toBe(true)
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
		expect(isMuted(held)).toBe(false)
		// A closed gate does not open at -41 dBFS.
		const closed = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -40,
			hysteresisDb: 3,
		})
		expect(isMuted(run(closed, [tone(amp, 200)]))).toBe(true)
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

	it("never steps the phase at a squelch transition (no click after fmdemod)", () => {
		// Feature: live-analog-fixes, Property 4: squelch transitions are click-free
		fc.assert(
			fc.property(
				fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
				fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
				// Whole 10 ms blocks: B's phase jump lands while the gate is closed.
				fc.integer({ min: 0, max: 20 }).map(blocks => blocks * 10),
				(phaseA, phaseB, gapMs) => {
					const squelch = new ChannelSquelch({
						sampleRate: RATE,
						thresholdDbfs: -40,
						hangMs: 50,
					})
					const out = Buffer.concat([
						run(squelch, [tone(QUIET, 30)]),
						run(squelch, [tone(LOUD, 100, phaseA)]),
						// Phase-continuous with A: the gate is still open in its hang.
						run(squelch, [
							tone(QUIET, 100 + gapMs, phaseA + 2 * Math.PI * 100 * 0.1),
						]),
						run(squelch, [tone(LOUD, 100, phaseB)]),
					])
					// The 1 kHz test tone itself moves 0.08 per sample at 25 kHz.
					const demod = fmdemod(out).slice(1)
					expect(Math.max(...demod.map(Math.abs))).toBeLessThan(0.0802)
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
		expect(isMuted(run(squelch, [tone(QUIET, 50)]))).toBe(true)
		squelch.setThreshold(null)
		const input = tone(QUIET, 50)
		expect(sameUpToRotation(run(squelch, [input]), input)).toBe(true)
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
