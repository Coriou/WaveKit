/**
 * Paced PCM stream: bursty voice in, continuous constant-rate audio out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import { PacedPcmStream } from "../../../src/core/paced-pcm-stream.js"

const RATE = 8000

function tone(samples: number, value = 1000): Buffer {
	const buf = Buffer.alloc(samples * 2)
	for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2)
	return buf
}

function collect(stream: PacedPcmStream): Buffer[] {
	const chunks: Buffer[] = []
	stream.on("audio", (chunk: Buffer) => chunks.push(chunk))
	return chunks
}

function samples(chunks: Buffer[]): number[] {
	const all = Buffer.concat(chunks)
	const out: number[] = []
	for (let i = 0; i + 1 < all.length; i += 2) out.push(all.readInt16LE(i))
	return out
}

describe("PacedPcmStream", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(Date.parse("2026-10-09T12:00:00.000Z"))
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("emits exact silence at the configured rate when no voice arrives", () => {
		const stream = new PacedPcmStream({
			sampleRate: RATE,
			jitterBufferMs: 200,
			maxBufferMs: 1000,
		})
		const chunks = collect(stream)
		stream.start()
		vi.advanceTimersByTime(1000)
		stream.stop()
		const out = samples(chunks)
		expect(out).toHaveLength(RATE)
		expect(out.every(sample => sample === 0)).toBe(true)
		expect(stream.stats.silenceSamples).toBe(RATE)
	})

	it("waits for the jitter target, then plays the burst in order and returns to silence", () => {
		const stream = new PacedPcmStream({
			sampleRate: RATE,
			jitterBufferMs: 100,
			maxBufferMs: 1000,
		})
		const chunks = collect(stream)
		stream.start()
		vi.advanceTimersByTime(100)
		// 20 ms datagrams: 2 queued (40 ms) is below the 100 ms target.
		stream.push(tone(160, 1))
		stream.push(tone(160, 2))
		vi.advanceTimersByTime(40)
		expect(samples(chunks).slice(-1)[0]).toBe(0)
		stream.push(tone(160, 3))
		stream.push(tone(160, 4))
		stream.push(tone(160, 5))
		vi.advanceTimersByTime(200)
		stream.stop()
		const out = samples(chunks)
		const voice = out.filter(sample => sample !== 0)
		expect(voice).toEqual([
			...Array<number>(160).fill(1),
			...Array<number>(160).fill(2),
			...Array<number>(160).fill(3),
			...Array<number>(160).fill(4),
			...Array<number>(160).fill(5),
		])
		// Constant rate: 340 ms of output regardless of the burst.
		expect(out).toHaveLength((340 * RATE) / 1000)
		expect(out.at(-1)).toBe(0)
	})

	it("plays a short burst once it has waited the jitter target", () => {
		const stream = new PacedPcmStream({
			sampleRate: RATE,
			jitterBufferMs: 200,
			maxBufferMs: 1000,
		})
		const chunks = collect(stream)
		stream.start()
		stream.push(tone(160, 7))
		vi.advanceTimersByTime(180)
		expect(samples(chunks).every(sample => sample === 0)).toBe(true)
		vi.advanceTimersByTime(60)
		expect(samples(chunks).filter(sample => sample === 7)).toHaveLength(160)
		stream.stop()
	})

	it("bounds the queue, dropping the oldest audio", () => {
		const stream = new PacedPcmStream({
			sampleRate: RATE,
			jitterBufferMs: 100,
			maxBufferMs: 500,
		})
		const chunks = collect(stream)
		stream.start()
		// 2 s of voice arrives at once: only the newest 500 ms is kept.
		for (let n = 0; n < 100; n++) stream.push(tone(160, n + 1))
		expect(stream.bufferedMs).toBe(500)
		expect(stream.stats.droppedSamples).toBe(1.5 * RATE)
		vi.advanceTimersByTime(600)
		stream.stop()
		const voice = samples(chunks).filter(sample => sample !== 0)
		expect(voice).toHaveLength(0.5 * RATE)
		expect(voice[0]).toBe(76)
		expect(voice.at(-1)).toBe(100)
	})

	it("keeps its rate when the wall clock steps backwards (NTP)", () => {
		const stream = new PacedPcmStream({
			sampleRate: RATE,
			jitterBufferMs: 0,
			maxBufferMs: 1000,
		})
		const chunks = collect(stream)
		stream.start()
		vi.advanceTimersByTime(200)
		vi.setSystemTime(Date.now() - 60_000)
		vi.advanceTimersByTime(800)
		stream.stop()
		expect(samples(chunks)).toHaveLength(RATE)
	})

	it("counts underruns only for gaps inside an active call", () => {
		const stream = new PacedPcmStream({
			sampleRate: RATE,
			jitterBufferMs: 0,
			maxBufferMs: 1000,
		})
		collect(stream)
		stream.start()
		// A burst ending between calls is not an underrun.
		stream.push(tone(100, 1))
		vi.advanceTimersByTime(100)
		expect(stream.stats.underruns).toBe(0)
		// The same gap during a call is.
		stream.setCallActive(true)
		stream.push(tone(100, 1))
		vi.advanceTimersByTime(100)
		expect(stream.stats.underruns).toBe(1)
		stream.stop()
	})

	it("clear() turns queued voice into silence", () => {
		const stream = new PacedPcmStream({
			sampleRate: RATE,
			jitterBufferMs: 0,
			maxBufferMs: 1000,
		})
		const chunks = collect(stream)
		stream.start()
		stream.push(tone(800, 9))
		stream.clear()
		vi.advanceTimersByTime(200)
		stream.stop()
		expect(samples(chunks).every(sample => sample === 0)).toBe(true)
	})

	it("resynchronises after an event-loop stall instead of bursting seconds of audio", () => {
		let clock = 0
		const stream = new PacedPcmStream({
			sampleRate: RATE,
			jitterBufferMs: 0,
			maxBufferMs: 1000,
			now: () => clock + performance.now(),
		})
		const chunks = collect(stream)
		stream.start()
		vi.advanceTimersByTime(100)
		const before = samples(chunks).length
		// 5 s pass without timers firing (a blocked event loop).
		clock += 5000
		vi.advanceTimersByTime(20)
		const burst = samples(chunks).length - before
		expect(burst).toBeLessThanOrEqual(0.04 * RATE)
		stream.stop()
	})

	// Feature: digital-voice, Property 1: paced output is continuous and lossless below the bound
	// Validates: ROADMAP 5b stream semantics (constant rate, silence fill, bounded jitter buffer)
	it("emits sampleRate samples per second and plays every queued sample in order when under the bound", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						gapMs: fc.integer({ min: 0, max: 400 }),
						datagrams: fc.integer({ min: 1, max: 10 }),
					}),
					{ minLength: 1, maxLength: 12 },
				),
				fc.integer({ min: 0, max: 300 }),
				(bursts, jitterBufferMs) => {
					vi.setSystemTime(Date.parse("2026-10-09T12:00:00.000Z"))
					const stream = new PacedPcmStream({
						sampleRate: RATE,
						jitterBufferMs,
						maxBufferMs: 5000,
					})
					const chunks = collect(stream)
					stream.start()
					let value = 1
					const expected: number[] = []
					let elapsed = 0
					for (const burst of bursts) {
						vi.advanceTimersByTime(burst.gapMs)
						elapsed += burst.gapMs
						for (let d = 0; d < burst.datagrams; d++) {
							stream.push(tone(160, value))
							expected.push(...Array<number>(160).fill(value))
							value++
						}
					}
					// Let everything drain.
					vi.advanceTimersByTime(3000)
					elapsed += 3000
					stream.stop()
					const out = samples(chunks)
					expect(out.length).toBe(
						Math.floor((Math.floor(elapsed / 20) * 20 * RATE) / 1000),
					)
					expect(out.filter(sample => sample !== 0)).toEqual(expected)
					expect(stream.stats.droppedSamples).toBe(0)
				},
			),
			{ numRuns: 100 },
		)
	})
})
