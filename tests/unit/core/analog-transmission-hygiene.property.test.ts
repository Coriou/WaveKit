import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
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
		// Feature: web-gaps-10, Property: activity hygiene merge and filter
		// Validates: activity hygiene rules 1-3 (merge gap, minimum duration, carrier evidence)
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
})
