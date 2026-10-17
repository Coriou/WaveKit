/**
 * WG10 req 2.2: silence fill unit tests (injected clock, counted writes).
 */

import { describe, it, expect } from "vitest"
import {
	LIVE_AUDIO_SILENCE_CHUNK_MS,
	LIVE_AUDIO_SILENCE_FILL_MAX_MS,
} from "@wavekit/api-types"
import {
	LIVE_AUDIO_SILENCE_MAX_CHUNKS,
	SilenceFill,
	silenceChunkSamples,
} from "../../../src/core/live-audio-silence.js"
import { ManualClock } from "./live-demodulator-continuity-fakes.js"

function sink() {
	const writes: Buffer[] = []
	let clears = 0
	return {
		writes,
		get clears() {
			return clears
		},
		write(chunk: Buffer) {
			writes.push(chunk)
		},
		clearRemainder() {
			clears++
		},
	}
}

describe("SilenceFill (WG10 req 2.2)", () => {
	it("bound arithmetic: 5000 ms / 20 ms = 250 chunks", () => {
		expect(LIVE_AUDIO_SILENCE_MAX_CHUNKS).toBe(
			LIVE_AUDIO_SILENCE_FILL_MAX_MS / LIVE_AUDIO_SILENCE_CHUNK_MS,
		)
		expect(LIVE_AUDIO_SILENCE_MAX_CHUNKS).toBe(250)
	})

	it("sends exactly 250 chunks at the bound and chunk 251 is never sent", () => {
		const clock = new ManualClock()
		const out = sink()
		const fill = new SilenceFill(out, clock)
		fill.arm({ rate: 25_000, format: "s16le" })
		expect(out.writes).toHaveLength(1)
		clock.advance(LIVE_AUDIO_SILENCE_FILL_MAX_MS - 1)
		expect(out.writes).toHaveLength(250)
		expect(fill.armed).toBe(true)
		clock.advance(1)
		expect(out.writes).toHaveLength(250)
		expect(fill.armed).toBe(false)
		clock.advance(60_000)
		expect(out.writes).toHaveLength(250)
		expect(clock.pending).toBe(0)
	})

	it("writes one chunk per 20 ms of stream time, catching up after a late timer", () => {
		const clock = new ManualClock()
		const out = sink()
		const fill = new SilenceFill(out, {
			now: clock.now,
			// A timer that fires 100 ms late.
			setTimer: (cb, ms) => clock.setTimer(cb, ms + 100),
			clearTimer: clock.clearTimer,
		})
		fill.arm({ rate: 25_000, format: "s16le" })
		clock.advance(120)
		// 120 ms of stream time → chunks for 0..140 ms started: floor(120/20)+1.
		expect(out.writes).toHaveLength(7)
	})

	it("reuses one zero buffer of whole samples per (rate, format)", () => {
		const clock = new ManualClock()
		const out = sink()
		const fill = new SilenceFill(out, clock)
		fill.arm({ rate: 25_000, format: "s16le" })
		clock.advance(100)
		const first = out.writes[0]!
		expect(first.length).toBe(500 * 2)
		expect(out.writes.every(chunk => chunk === first)).toBe(true)
		expect(first.every(byte => byte === 0)).toBe(true)
		fill.disarm("audio")
		fill.arm({ rate: 25_000, format: "s16le" })
		expect(out.writes.at(-1)).toBe(first)
		fill.arm({ rate: 48_000, format: "f32le" })
		const f32 = out.writes.at(-1)!
		expect(f32.length).toBe(960 * 4)
		expect(silenceChunkSamples(44_100)).toBe(882)
		expect(silenceChunkSamples(1)).toBe(1)
	})

	it("clears the sink's partial sample at arm and disarm, and disarm stops writes", () => {
		const clock = new ManualClock()
		const out = sink()
		const fill = new SilenceFill(out, clock)
		fill.arm({ rate: 25_000, format: "s16le" })
		expect(out.clears).toBe(1)
		expect(fill.disarm("audio")).toBe(true)
		expect(out.clears).toBe(2)
		expect(fill.disarm("stop")).toBe(false)
		expect(out.clears).toBe(2)
		const count = out.writes.length
		clock.advance(1000)
		expect(out.writes).toHaveLength(count)
		expect(clock.pending).toBe(0)
	})

	it("a re-arm restarts the bound for the new restart (250 chunks per restart)", () => {
		const clock = new ManualClock()
		const out = sink()
		const fill = new SilenceFill(out, clock)
		fill.arm({ rate: 25_000, format: "s16le" })
		clock.advance(3000)
		fill.arm({ rate: 25_000, format: "s16le" })
		clock.advance(10_000)
		expect(out.writes).toHaveLength(151 + 250)
	})
})
