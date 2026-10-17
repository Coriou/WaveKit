/**
 * WG10 R2 activity hygiene fixes of the analog transmission tracker: summed segment audio
 * and single-segment carrier evidence (M1), a tone split between speakers (M2), the carrier
 * base kept across a null count on resume (m4), max-duration continuations (m5) and the
 * pending accessor identify reads.
 */
import type { AnalogTransmissionDcs } from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import type { ToneDetectorPort } from "../../../src/core/analog-transmission.js"
import { hygieneHarness } from "./analog-transmission-hygiene-fakes.js"

/**
 * A detector that reads a marker byte per chunk: 1 → CTCSS 88.5, 2 → CTCSS 100.0, 3 → DCS 023,
 * 4 → DCS 047, 0 → nothing. CTCSS by vote, DCS last (like the real banks over a mix).
 */
function markerDetector(): ToneDetectorPort {
	let votes = new Map<number, number>()
	let dcs: AnalogTransmissionDcs | null = null
	return {
		push(pcm: Buffer) {
			const marker = pcm[0] ?? 0
			if (marker === 1 || marker === 2)
				votes.set(marker, (votes.get(marker) ?? 0) + 1)
			if (marker === 3) dcs = { code: "023", polarity: "normal" }
			if (marker === 4) dcs = { code: "047", polarity: "normal" }
		},
		result() {
			let best: number | null = null
			for (const [m, n] of votes)
				if (best === null || n > (votes.get(best) ?? 0)) best = m
			const ctcssHz = best === 1 ? 88.5 : best === 2 ? 100 : null
			return { ctcssHz, dtmf: null, dcs }
		},
		reset() {
			votes = new Map()
			dcs = null
		},
	}
}

const FMT = { rate: 8_000, format: "s16le" as const }

function toneHarness() {
	const h = hygieneHarness(undefined, { createToneDetector: markerDetector })
	/** Squelch open for `ms` (250 ms chunks of marker audio, carrier on every block), then closed. */
	const talk = (marker: number, ms: number): void => {
		h.source.gate(true)
		for (let t = 0; t < ms; t += 250) {
			h.source.carrier! += 25
			h.source.emit("pcm", Buffer.alloc(4_000, marker), FMT)
			h.advance(250)
			h.source.level()
		}
		h.source.gate(false)
	}
	return { ...h, talk }
}

describe("analog transmission hygiene R2: summed audio, single-segment carrier (M1)", () => {
	it("AM blips spaced inside the merge gap do not add their gaps to the minimum", () => {
		const h = hygieneHarness()
		h.source.carrier = null
		// Three 150 ms blips of audio (the close comes a 250 ms hang later), 850 ms apart.
		for (let i = 0; i < 3; i++) {
			h.burst(400, false)
			h.advance(600)
		}
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toEqual([])
		expect(h.events).toEqual([])
		expect(h.tracker.suppressed()).toEqual({ short: 1, noCarrier: 0 })
	})

	it("noise crossings held open only by the hang never qualify however many merge", () => {
		const h = hygieneHarness()
		h.source.carrier = null
		for (let i = 0; i < 30; i++) {
			h.burst(200, false)
			h.advance(800)
		}
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toEqual([])
		expect(h.tracker.suppressed()).toEqual({ short: 1, noCarrier: 0 })
	})

	it("nfm: chance-quieted blocks of different segments never add up", () => {
		const h = hygieneHarness()
		// Four 250 ms-audio segments 1 s apart, two quieted blocks each: 1 s of audio, 8 blocks.
		for (let i = 0; i < 4; i++) {
			h.source.gate(true)
			h.source.carrier! += 2
			h.advance(500)
			h.source.level()
			h.source.gate(false)
			h.advance(750)
		}
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toEqual([])
		expect(h.events).toEqual([])
		expect(h.tracker.suppressed()).toEqual({ short: 0, noCarrier: 1 })
	})

	it("one segment with the carrier qualifies a merged transmission", () => {
		const h = hygieneHarness()
		h.source.gate(true)
		h.source.carrier! += 1
		h.advance(500)
		h.source.gate(false)
		h.advance(300)
		h.source.gate(true)
		h.source.carrier! += 3
		h.advance(500)
		h.source.gate(false)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toHaveLength(1)
		// The row keeps its span: 500 + 300 + 500 − 250 ms.
		expect(h.rows[0]!.durationMs).toBe(1_050)
	})
})

describe("analog transmission hygiene R2: tone split (M2)", () => {
	it("two speakers with different CTCSS tones within the merge gap are two rows", () => {
		const h = toneHarness()
		const start = h.now()
		h.talk(1, 2_000)
		h.advance(300)
		h.talk(2, 3_000)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows.map(r => [r.transmissionId, r.tone?.ctcssHz])).toEqual([
			["tx-1", 88.5],
			["tx-2", 100],
		])
		const [a, b] = h.rows
		expect(a!.endedAt).toBe(new Date(start + 2_000 - 250).toISOString())
		expect(a!.closeReason).toBe("squelch")
		expect(b!.startedAt).toBe(new Date(start + 2_300).toISOString())
		expect(b!.durationMs).toBe(3_000 - 250)
		expect(h.events.map(e => `${e.transmissionId}:${e.state}`)).toEqual([
			"tx-1:open",
			"tx-1:closed",
			"tx-2:open",
			"tx-2:closed",
		])
	})

	it("different DCS codes split, and a CTCSS speaker followed by a DCS one splits", () => {
		const h = toneHarness()
		h.talk(3, 2_000)
		h.advance(300)
		h.talk(4, 2_000)
		h.advance(300)
		h.talk(1, 2_000)
		h.tracker.stop()
		expect(
			h.rows.map(r => [r.tone?.ctcssHz ?? null, r.tone?.dcs?.code ?? null]),
		).toEqual([
			[null, "023"],
			[null, "047"],
			[88.5, null],
		])
	})

	it("fades merge: the same tone, then an untoned segment, stay one transmission", () => {
		const h = toneHarness()
		h.talk(1, 2_000)
		h.advance(300)
		h.talk(1, 1_000)
		h.advance(300)
		h.talk(0, 1_000)
		h.tracker.stop()
		expect(h.rows.map(r => [r.transmissionId, r.tone?.ctcssHz])).toEqual([
			["tx-1", 88.5],
		])
	})

	it("an untoned held part never splits off a toned segment", () => {
		const h = toneHarness()
		h.talk(0, 2_000)
		h.advance(300)
		h.talk(1, 2_000)
		h.tracker.stop()
		expect(h.rows.map(r => [r.transmissionId, r.tone?.ctcssHz])).toEqual([
			["tx-1", 88.5],
		])
	})

	it("a short new speaker that never confirms its tone merges", () => {
		const h = toneHarness()
		h.talk(1, 2_000)
		h.advance(300)
		// 0.5 s of audio: under the 0.75 s CTCSS minimum.
		h.talk(2, 500)
		h.tracker.stop()
		expect(h.rows).toHaveLength(1)
	})
})

describe("analog transmission hygiene R2: carrier base, continuation, pending (m4, m5)", () => {
	it("a null carrier count on resume keeps the last known base", () => {
		const h = hygieneHarness()
		h.source.gate(true)
		h.advance(1_000)
		h.source.gate(false)
		h.advance(300)
		h.source.carrier = null
		h.source.gate(true)
		h.source.carrier = 5
		h.advance(1_000)
		h.source.gate(false)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toHaveLength(1)
		expect(h.tracker.suppressed()).toEqual({ short: 0, noCarrier: 0 })
	})

	it("a max-duration continuation is published under 500 ms; its carrier rule still applies", () => {
		const run = (carrierInContinuation: boolean) => {
			const h = hygieneHarness(undefined, { maxDurationMs: 2_000 })
			h.source.gate(true)
			for (let t = 0; t < 2_000; t += 10) {
				h.source.carrier! += 1
				h.advance(10)
				h.source.level()
			}
			// 300 ms more: 50 ms of audio after the hang.
			for (let t = 0; t < 300; t += 10) {
				if (carrierInContinuation) h.source.carrier! += 1
				h.advance(10)
				h.source.level()
			}
			h.source.gate(false)
			h.advance(5_000)
			h.tracker.stop()
			return h
		}
		const kept = run(true)
		expect(kept.rows.map(r => [r.closeReason, r.durationMs])).toEqual([
			["max-duration", 2_000],
			["squelch", 50],
		])
		const dropped = run(false)
		expect(dropped.rows.map(r => r.closeReason)).toEqual(["max-duration"])
		expect(dropped.tracker.suppressed()).toEqual({ short: 0, noCarrier: 1 })
	})

	it("pending() reports an opening until it reaches the minimum audio", () => {
		const h = hygieneHarness()
		expect(h.tracker.pending()).toBeNull()
		h.source.gate(true)
		h.source.carrier! += 10
		h.advance(300)
		expect(h.tracker.pending()?.transmissionId).toBe("tx-1")
		expect(h.tracker.pending()?.state).toBe("open")
		expect(h.tracker.current()).toBeNull()
		h.advance(450)
		h.source.level()
		expect(h.tracker.pending()).toBeNull()
		expect(h.tracker.current()?.transmissionId).toBe("tx-1")
		h.source.gate(false)
		expect(h.tracker.pending()).toBeNull()
	})
})
