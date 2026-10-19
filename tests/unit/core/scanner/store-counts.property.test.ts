import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	classification,
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"
import { newCtx, recount, step } from "./store-index-ops.js"

describe("discovery store job counts (WG11 SC)", () => {
	// Feature: web-gaps-11, Property 7: Incremental counts equal a recount
	// Validates: Requirements 3.3
	it("countsByJob equals the list({ jobId }) recount after every step", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				fc.integer({ min: 10, max: 60 }),
				fc.boolean(),
				(seed, steps, wide) => {
					const ctx = newCtx(seed, wide)
					for (let n = 0; n < steps; n++) {
						step(ctx)
						// every step: the jobs of the four most recent inputs; at the end: every job seen
						for (const o of ctx.inputs.slice(-4))
							for (const job of o.jobIds.slice(0, 3))
								expect(ctx.store.countsByJob(job)).toEqual(
									recount(ctx.store, job),
								)
					}
					for (const job of ctx.jobs)
						expect(ctx.store.countsByJob(job)).toEqual(recount(ctx.store, job))
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("returns a copy, zeros for an unknown job, and follows evidence and a cap downgrade", () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => 0,
			newId: counterIds(),
		})
		expect(store.countsByJob("none")).toEqual({
			activity: 0,
			candidate: 0,
			classified: 0,
			decoded: 0,
		})
		const r = store.ingest(
			makeObs({
				id: "o1",
				centreHz: 446_100_000,
				startedAt: 1_000,
				cls: "analog-fm",
				hypotheses: [["analog-fm", 0.9]],
				tier: "channel",
				jobIds: ["j"],
			}),
		)
		const id = r.discoveryId ?? ""
		// A prior-only hypothesis leaves the ladder at activity.
		expect(store.get(id)?.protocol).toBe("unknown")
		expect(store.get(id)?.confidence).toBe("activity")
		const copy = store.countsByJob("j")
		expect(copy.activity).toBe(1)
		copy.activity = 99
		expect(store.countsByJob("j").activity).toBe(1)
		store.applyEvidence(id, evidence("dmr", 2_000, { identity: dmrCc(1) }))
		expect(store.get(id)?.confidence).toBe("decoded")
		expect(store.countsByJob("j")).toEqual({
			activity: 0,
			candidate: 0,
			classified: 0,
			decoded: 1,
		})
		// A stored classified record still drops to candidate when a cap is recorded.
		const snap = store.snapshot()
		const saved = snap.discoveries[0]
		expect(saved).toBeDefined()
		if (saved !== undefined) saved.confidence = "classified"
		store.restore(snap)
		expect(store.countsByJob("j").classified).toBe(1)
		store.applyClassification(
			id,
			classification(
				"analog-fm",
				[["analog-fm", 0.9]],
				"adjacent-leak",
				"channel",
			),
		)
		expect(store.get(id)?.confidence).toBe("candidate")
		expect(store.get(id)?.confidenceCap).toBe("adjacent-leak")
		expect(store.countsByJob("j")).toEqual({
			activity: 0,
			candidate: 1,
			classified: 0,
			decoded: 0,
		})
		store.delete(id)
		expect(store.countsByJob("j").candidate).toBe(0)
		// bound: a job no discovery carries any more holds no entry
		expect(
			(store as unknown as { jobCounts: { jobs(): number } }).jobCounts.jobs(),
		).toBe(0)
	})
})
