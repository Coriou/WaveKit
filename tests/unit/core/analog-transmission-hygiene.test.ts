/**
 * WG10 activity hygiene: merge within ANALOG_TRANSMISSION_MERGE_GAP_MS, the minimum
 * duration, and the nfm/wfm carrier-evidence rule of the analog transmission tracker.
 */
import { describe, expect, it } from "vitest"
import {
	ANALOG_TRANSMISSION_HYGIENE,
	ANALOG_TRANSMISSION_MERGE_GAP_MS,
	ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS,
	ANALOG_TRANSMISSION_MIN_MS,
	AnalogTransmissionTracker,
} from "../../../src/core/analog-transmission.js"
import { hygieneHarness } from "./analog-transmission-hygiene-fakes.js"

describe("analog transmission hygiene (WG10)", () => {
	it("pins the constants", () => {
		expect(ANALOG_TRANSMISSION_MERGE_GAP_MS).toBe(1500)
		expect(ANALOG_TRANSMISSION_MIN_MS).toBe(500)
		expect(ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS).toBe(3)
		expect(ANALOG_TRANSMISSION_HYGIENE).toEqual({
			mergeGapMs: 1500,
			minDurationMs: 500,
			minCarrierBlocks: 3,
		})
	})

	it("flapping noise without a carrier produces no row and no WS event", () => {
		const h = hygieneHarness()
		for (let i = 0; i < 200; i++) {
			h.burst(50 + ((i * 37) % 400), false)
			h.advance(30 + ((i * 53) % 2500))
		}
		h.advance(10_000)
		h.tracker.stop()
		expect(h.events).toEqual([])
		expect(h.rows).toEqual([])
		const s = h.tracker.suppressed()
		expect(s.short + s.noCarrier).toBeGreaterThan(0)
		expect(s.short + s.noCarrier).toBe(h.suppressedLog.length)
	})

	it("flapping noise on a mode without carrier evidence: short openings past the gap give no row", () => {
		const h = hygieneHarness()
		h.source.carrier = null
		for (let i = 0; i < 50; i++) {
			h.burst(200, false)
			h.advance(2_000)
		}
		h.tracker.stop()
		expect(h.rows).toEqual([])
		expect(h.tracker.suppressed()).toEqual({ short: 50, noCarrier: 0 })
	})

	it("a 3 s transmission with a 300 ms dropout is one row", () => {
		const h = hygieneHarness()
		const start = h.now()
		// 1.25 s of audio (the close comes a 250 ms hang later), a 300 ms dropout, 1.45 s more.
		h.burst(1_500, true)
		h.advance(50)
		h.burst(1_700, true)
		expect(h.rows).toEqual([])
		h.advance(ANALOG_TRANSMISSION_MERGE_GAP_MS)
		expect(h.rows).toHaveLength(1)
		const row = h.rows[0]!
		expect(row.transmissionId).toBe("tx-1")
		expect(Date.parse(row.startedAt)).toBe(start)
		expect(row.durationMs).toBe(1_500 + 50 + 1_700 - 250)
		expect(row.closeReason).toBe("squelch")
		expect(h.events.map(e => [e.transmissionId, e.state])).toEqual([
			["tx-1", "open"],
			["tx-1", "closed"],
		])
		h.tracker.stop()
		expect(h.rows).toHaveLength(1)
	})

	it("a 400 ms burst is suppressed as short; live gating is not the tracker's business", () => {
		const h = hygieneHarness()
		h.burst(650, true)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toEqual([])
		expect(h.events).toEqual([])
		expect(h.tracker.suppressed()).toEqual({ short: 1, noCarrier: 0 })
	})

	it("a long opening without carrier evidence is suppressed as noCarrier", () => {
		const h = hygieneHarness()
		h.burst(3_000, false)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toEqual([])
		expect(h.tracker.suppressed()).toEqual({ short: 0, noCarrier: 1 })
	})

	it("needs ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS quieted blocks", () => {
		const h = hygieneHarness()
		h.source.gate(true)
		h.source.carrier! += ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS - 1
		h.advance(2_000)
		h.source.gate(false)
		h.advance(5_000)
		expect(h.rows).toEqual([])
		h.source.gate(true)
		h.source.carrier! += ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS
		h.advance(2_000)
		h.source.gate(false)
		h.advance(5_000)
		expect(h.rows).toHaveLength(1)
	})

	it("a re-open past the merge gap starts a new transmission", () => {
		const h = hygieneHarness()
		h.burst(1_000, true)
		// Audio ended 250 ms before the close: the gap is 250 + advance.
		h.advance(ANALOG_TRANSMISSION_MERGE_GAP_MS - 250 + 1)
		h.burst(1_000, true)
		h.tracker.stop()
		expect(h.rows.map(r => r.transmissionId)).toEqual(["tx-1", "tx-2"])
	})

	it("a re-open exactly at the merge gap continues the transmission", () => {
		const h = hygieneHarness()
		h.burst(1_000, true)
		h.advance(ANALOG_TRANSMISSION_MERGE_GAP_MS - 250)
		h.burst(1_000, true)
		h.tracker.stop()
		expect(h.rows.map(r => r.transmissionId)).toEqual(["tx-1"])
	})

	it("never merges across a retune or a config change", () => {
		const h = hygieneHarness()
		h.burst(1_000, true)
		h.advance(100)
		h.source.offsetHz = 12_500
		h.burst(1_000, true)
		h.tracker.stop()
		expect(h.rows.map(r => r.frequency?.hz)).toEqual([446_000_000, 446_012_500])
		const g = hygieneHarness()
		g.burst(1_000, true)
		g.advance(100)
		g.source.reconfigure({ offsetHz: 25_000 })
		// The config change finalises the held transmission at its audio end.
		expect(g.rows).toHaveLength(1)
		expect(g.rows[0]!.closeReason).toBe("squelch")
		expect(g.rows[0]!.durationMs).toBe(750)
	})

	it("announces the open event during the transmission once it must reach the minimum", () => {
		const h = hygieneHarness()
		h.source.gate(true)
		h.source.carrier! += 10
		h.advance(ANALOG_TRANSMISSION_MIN_MS + 250 - 10)
		h.source.level()
		expect(h.events).toEqual([])
		expect(h.tracker.current()).toBeNull()
		h.advance(10)
		h.source.level()
		expect(h.events.map(e => e.state)).toEqual(["open"])
		expect(h.tracker.current()?.transmissionId).toBe("tx-1")
		// In the merge gap the transmission is still current.
		h.source.gate(false)
		expect(h.tracker.current()?.transmissionId).toBe("tx-1")
		h.advance(ANALOG_TRANSMISSION_MERGE_GAP_MS)
		expect(h.events.map(e => e.state)).toEqual(["open", "closed"])
		expect(h.tracker.current()).toBeNull()
	})

	it("a level sample past the gap finalises without a timer", () => {
		const h = hygieneHarness()
		h.burst(1_000, true)
		for (const t of h.timers) t.cancelled = true
		// The audio ended a 250 ms hang before the close.
		h.advance(ANALOG_TRANSMISSION_MERGE_GAP_MS - 250)
		h.source.level()
		expect(h.rows).toEqual([])
		h.advance(1)
		h.source.level()
		expect(h.rows).toHaveLength(1)
	})

	it("stop in the merge gap closes at the audio end with reason squelch", () => {
		const h = hygieneHarness()
		h.burst(1_000, true)
		h.advance(400)
		h.tracker.stop()
		expect(h.rows).toHaveLength(1)
		expect(h.rows[0]!.durationMs).toBe(750)
		expect(h.rows[0]!.closeReason).toBe("squelch")
	})

	it("stop during an open transmission keeps reason stopped", () => {
		const h = hygieneHarness()
		h.source.gate(true)
		h.source.carrier! += 50
		h.advance(2_000)
		h.tracker.stop()
		expect(h.rows.map(r => [r.closeReason, r.durationMs])).toEqual([
			["stopped", 2_000],
		])
	})

	it("a merged transmission accumulates audio for the tone detector", () => {
		const pushed: number[] = []
		const h = hygieneHarness()
		// Re-wire a tracker with a counting detector on the same source.
		h.tracker.stop()
		let now = 0
		const tracker = new AnalogTransmissionTracker({
			source: h.source,
			frequencyAt: () => null,
			now: () => now,
			setTimer: () => () => {},
			createToneDetector: () => ({
				push: (b: Buffer) => pushed.push(b.length),
				result: () => ({ ctcssHz: 88.5, dtmf: null, dcs: null }),
				reset() {},
			}),
		})
		const rows: Array<{ tone?: { ctcssHz: number | null } }> = []
		tracker.on("closed", p => rows.push(p))
		tracker.start()
		const fmt = { rate: 8_000, format: "s16le" as const }
		h.source.gate(true)
		h.source.carrier! += 10
		h.source.emit("pcm", Buffer.alloc(8_000), fmt) // 0.5 s
		now += 750
		h.source.gate(false)
		h.source.emit("pcm", Buffer.alloc(8_000), fmt) // muted gap: not fed
		now += 200
		h.source.gate(true)
		h.source.emit("pcm", Buffer.alloc(8_000), fmt) // 0.5 s more: 1 s >= 0.75 s
		now += 750
		tracker.stop()
		expect(pushed).toEqual([8_000, 8_000])
		expect(rows).toHaveLength(1)
		expect(rows[0]?.tone?.ctcssHz).toBe(88.5)
	})
})
