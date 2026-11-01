import fc from "fast-check"
import { expect, it } from "vitest"
import { EFFICIENCY_PROBATION_MS } from "../../../../src/decoders/enablement/contract.js"
import { HOST_STARVATION_WINDOW_MS } from "../../../../src/decoders/enablement/host-starvation.js"
import {
	LIVE,
	SAMPLE_MS,
	starvationHarness,
} from "./host-starvation-harness.js"

/**
 * Host-wide congestion episodes, each one or more 2000 ms samples. Every drop
 * on readsb's branch has host evidence: a sibling branch (live audio) drops in
 * the same sample or within HOST_STARVATION_WINDOW_MS (a split over up to 5
 * samples, 10 000 ms, the bound included), or the event loop lags (>= 50 ms).
 * On probation the sibling of a split comes first (see the loop below).
 */
type Episode =
	| { kind: "both" }
	| { kind: "split"; readsbFirst: boolean; samples: number }
	| { kind: "lag"; live: boolean; lagMs: number }
	| { kind: "live" }
	| { kind: "clean"; samples: number }

const episode: fc.Arbitrary<Episode> = fc.oneof(
	fc.constant({ kind: "both" as const }),
	fc.record({
		kind: fc.constant("split" as const),
		readsbFirst: fc.boolean(),
		samples: fc.integer({
			min: 1,
			max: HOST_STARVATION_WINDOW_MS / SAMPLE_MS,
		}),
	}),
	fc.record({
		kind: fc.constant("lag" as const),
		live: fc.boolean(),
		lagMs: fc.integer({ min: 50, max: 2_000 }),
	}),
	fc.constant({ kind: "live" as const }),
	fc.record({
		kind: fc.constant("clean" as const),
		samples: fc.integer({ min: 1, max: 8 }),
	}),
)

// Feature: host-starvation, Property 1: host-wide congestion never sheds the tuned decoder
// Validates: Requirements 1, 2, 5
it("under any interleaving of host-wide congestion the tuned decoder is never shed and recovers within the bound", () => {
	fc.assert(
		fc.property(
			fc.boolean(),
			fc.array(episode, { minLength: 1, maxLength: 40 }),
			(onProbation, episodes) => {
				const h = starvationHarness()
				if (onProbation) {
					expect(h.admit("readsb", true)).toMatchObject({ admit: true })
					// The first read after its branch is added has no comparable
					// baseline (attribution "unknown"): host evidence is observable
					// from the next sample on.
					h.tick()
				} else h.start("readsb", true)
				const readsb = h.branch("readsb")
				for (const e of episodes) {
					if (e.kind === "both") h.tick([readsb, LIVE])
					else if (e.kind === "live") h.tick([LIVE])
					else if (e.kind === "clean") h.clean(e.samples * SAMPLE_MS)
					else if (e.kind === "lag")
						h.tick(e.live ? [readsb, LIVE] : [readsb], e.lagMs)
					else {
						// A probationer is judged on the evidence known at its drop:
						// readsb's branch alone first is its own loss then (a
						// newcomer that cannot keep up), so on probation a split
						// leads with the sibling.
						const readsbFirst = e.readsbFirst && !onProbation
						h.tick([readsbFirst ? readsb : LIVE])
						for (let i = 1; i < e.samples; i++) h.tick()
						h.tick([readsbFirst ? LIVE : readsb])
					}
					expect(h.shed).toEqual([])
				}
				// Recovery: once congestion ends, probation completes within
				// EFFICIENCY_PROBATION_MS (30 000 ms) plus one sample, and the
				// tuned decoder never stopped.
				h.clean(EFFICIENCY_PROBATION_MS + SAMPLE_MS)
				expect(h.shed).toEqual([])
				expect(h.isRunning("readsb")).toBe(true)
				expect(h.probation("readsb")).toBe(false)
			},
		),
		{ numRuns: 100 },
	)
})

// Feature: host-starvation, Property 2: the tuned decoder's own loss is retried within the tuned backoff
// Validates: Requirements 2, 5
it("a tuned decoder shed for its own loss is re-admitted within TUNED_RETRY_MS of its shed once its source flows", () => {
	fc.assert(
		fc.property(fc.integer({ min: 0, max: 5 }), cleanSamples => {
			const h = starvationHarness()
			h.start("readsb", true)
			h.clean(cleanSamples * SAMPLE_MS)
			const readsb = h.branch("readsb")
			for (let i = 0; i < 60 && h.shed.length === 0; i++) h.tick([readsb])
			expect(h.shed.map(s => s.key)).toEqual(["readsb"])
			const shedAt = h.shed[0]!.at
			let admittedAt: number | null = null
			while (admittedAt === null && h.mono() < shedAt + 60_000) {
				h.tick()
				if (h.admit("readsb", true).admit) admittedAt = h.mono()
			}
			expect(admittedAt).toBe(shedAt + 30_000)
		}),
		{ numRuns: 100 },
	)
})
