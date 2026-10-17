import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	ANALOG_TRANSMISSION_MERGE_GAP_MS,
	ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS,
	ANALOG_TRANSMISSION_MIN_MS,
} from "../../../src/core/analog-transmission.js"
import { hygieneHarness } from "./analog-transmission-hygiene-fakes.js"

type Step =
	| { t: "open"; carrier: number }
	| { t: "close" }
	| { t: "advance"; ms: number }
	| { t: "level" }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
	fc.record({
		t: fc.constant("open" as const),
		carrier: fc.integer({ min: 0, max: 8 }),
	}),
	fc.record({ t: fc.constant("close" as const) }),
	fc.record({
		t: fc.constant("advance" as const),
		ms: fc.integer({ min: 0, max: 3_000 }),
	}),
	fc.record({ t: fc.constant("level" as const) }),
)

describe("analog transmission hygiene properties (WG10)", () => {
	it("merged output never overlaps, rows never exceed opens, every row qualifies", () => {
		// Feature: web-gaps-10, Property 11: Hygiene output is sound
		// Validates: Requirements 3.7
		fc.assert(
			fc.property(
				fc.array(stepArb, { maxLength: 60 }),
				fc.boolean(),
				(steps, carrierKnown) => {
					const h = hygieneHarness()
					if (!carrierKnown) h.source.carrier = null
					let opens = 0
					const carrierAt: Array<{ at: number; n: number }> = []
					for (const step of steps) {
						if (step.t === "open") {
							if (!h.source.open) opens += 1
							h.source.gate(true)
							if (h.source.carrier !== null) {
								h.source.carrier += step.carrier
								carrierAt.push({ at: h.now(), n: step.carrier })
							}
						} else if (step.t === "close") {
							if (h.source.open) h.source.gate(false)
						} else if (step.t === "advance") h.advance(step.ms)
						else h.source.level()
					}
					h.tracker.stop()

					expect(h.rows.length).toBeLessThanOrEqual(opens)
					const spans = h.rows.map(r => ({
						start: Date.parse(r.startedAt),
						end: Date.parse(r.endedAt),
					}))
					for (let i = 1; i < spans.length; i++)
						expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end)
					for (const row of h.rows) {
						expect(row.durationMs).toBeGreaterThanOrEqual(
							ANALOG_TRANSMISSION_MIN_MS,
						)
						if (carrierKnown) {
							const start = Date.parse(row.startedAt)
							const end = Date.parse(row.endedAt) + 250
							const seen = carrierAt
								.filter(c => c.at >= start && c.at <= end)
								.reduce((sum, c) => sum + c.n, 0)
							expect(seen).toBeGreaterThanOrEqual(
								ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS,
							)
						}
					}
					// WS: every id opens once, then closes once; rows are exactly the closed events.
					const states = new Map<string, string[]>()
					for (const e of h.events)
						states.set(e.transmissionId, [
							...(states.get(e.transmissionId) ?? []),
							e.state,
						])
					for (const seq of states.values())
						expect(seq).toEqual(["open", "closed"])
					expect(h.rows.map(r => r.transmissionId)).toEqual(
						h.events
							.filter(e => e.state === "closed")
							.map(e => e.transmissionId),
					)
					const s = h.tracker.suppressed()
					expect(h.rows.length + s.short + s.noCarrier).toBeLessThanOrEqual(
						opens,
					)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("a qualifying opening is exactly one row; carrier blocks while closed never count", () => {
		// Feature: web-gaps-10, Property 12: A qualifying opening is exactly one row
		// Validates: Requirements 3.7
		const HANG = 250
		const segmentArb = fc.record({
			openMs: fc.integer({ min: 0, max: 150 }).map(n => n * 10),
			carrier: fc.integer({ min: 0, max: 6 }),
			closedCarrier: fc.integer({ min: 0, max: 20 }),
			gapMs: fc.integer({ min: 0, max: 3_000 }),
		})
		fc.assert(
			fc.property(
				fc.array(segmentArb, { minLength: 1, maxLength: 40 }),
				fc.boolean(),
				(segments, carrierKnown) => {
					const h = hygieneHarness()
					if (!carrierKnown) h.source.carrier = null
					// Oracle: group segments whose re-open lies within the merge gap of the audio end.
					const groups: Array<{
						start: number
						audioMs: number
						best: number
					}> = []
					let lastEnd = Number.NEGATIVE_INFINITY
					for (const seg of segments) {
						const openAt = h.now()
						h.source.gate(true)
						if (h.source.carrier !== null) h.source.carrier += seg.carrier
						h.advance(seg.openMs)
						h.source.level()
						h.source.gate(false)
						// Quieted blocks counted while the squelch is closed (not this transmission's).
						if (h.source.carrier !== null) h.source.carrier += seg.closedCarrier
						const audioMs = Math.max(0, seg.openMs - HANG)
						const group = groups[groups.length - 1]
						if (group && openAt - lastEnd <= ANALOG_TRANSMISSION_MERGE_GAP_MS) {
							group.audioMs += audioMs
							group.best = Math.max(group.best, seg.carrier)
						} else groups.push({ start: openAt, audioMs, best: seg.carrier })
						lastEnd = openAt + audioMs
						h.advance(seg.gapMs)
					}
					h.advance(ANALOG_TRANSMISSION_MERGE_GAP_MS + 1)
					h.tracker.stop()
					const expected = groups
						.filter(
							g =>
								g.audioMs >= ANALOG_TRANSMISSION_MIN_MS &&
								(!carrierKnown ||
									g.best >= ANALOG_TRANSMISSION_MIN_CARRIER_BLOCKS),
						)
						.map(g => new Date(g.start).toISOString())
					expect(h.rows.map(r => r.startedAt)).toEqual(expected)
					const s = h.tracker.suppressed()
					expect(h.rows.length + s.short + s.noCarrier).toBe(groups.length)
				},
			),
			{ numRuns: 200 },
		)
	})
})
