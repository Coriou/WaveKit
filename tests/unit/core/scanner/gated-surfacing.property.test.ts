import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const GATES = ["pending", "passed", "below", "absent"] as const

describe("gated surfacing", () => {
	// Feature: scanner-redesign, Property 6: Only gated tracks surface
	// Validates: Requirements 2.5, 4.1
	it("stores an observation only when its gate passed", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						gate: fc.constantFrom(...GATES),
						slot: fc.integer({ min: 0, max: 5 }),
						blocks: fc.integer({ min: 1, max: 8 }),
						snr: fc.integer({ min: 0, max: 40 }),
					}),
					{ minLength: 1, maxLength: 12 },
				),
				steps => {
					const store = new DiscoveryStore({
						maxDiscoveries: 100,
						now: () => T0,
						newId: counterIds(),
					})
					const passed = new Set<string>()
					let transients = 0
					steps.forEach((step, i) => {
						const before = store.snapshot()
						const counts = store.countsByJob("job-1")
						const obs = makeObs({
							id: `o${i}`,
							centreHz: CH + step.slot * 100_000,
							startedAt: T0 + i * 1_000,
							blocks: step.blocks,
							snrDb: step.snr,
							maxBlockSnrDb: step.snr,
							cls: "fsk4-12k5",
							hypotheses: [["dmr", 0.9]],
							tier: "channel",
							gate: step.gate,
						})
						const res = store.ingest(obs)
						if (step.gate !== "passed") {
							expect(res).toEqual({ discoveryId: null, change: "transient" })
							expect(store.snapshot()).toEqual(before)
							expect(store.countsByJob("job-1")).toEqual(counts)
							if (step.gate === "below") transients += 1
							return
						}
						passed.add(obs.id)
						expect(res.change === "transient" || res.discoveryId !== null).toBe(
							true,
						)
					})
					for (const observation of store.snapshot().observations)
						expect(passed.has(observation.id)).toBe(true)
					expect(transients).toBe(steps.filter(s => s.gate === "below").length)
				},
			),
			{ numRuns: 100 },
		)
	})
})
