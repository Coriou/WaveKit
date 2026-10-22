import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	classification,
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"
import { newCtx, recount, step } from "./store-index-ops.js"
import type { Ctx } from "./store-index-ops.js"

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
						sinkEvidence(ctx)
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

	it("counts a commanded CTCSS tone as the classified label the discovery shows", () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => 0,
			newId: counterIds(),
		})
		const ingested = store.ingest(
			makeObs({
				id: "o1",
				centreHz: 446_006_250,
				startedAt: 1_000,
				gate: "passed",
				jobIds: ["j"],
			}),
		)
		const id = ingested.discoveryId ?? ""
		expect(store.get(id)?.confidence).toBe("activity")
		expect(store.countsByJob("j")).toEqual({
			activity: 1,
			candidate: 0,
			classified: 0,
			decoded: 0,
		})
		expect(store.recordAnalog("o1", tone(1_500))).toBe(true)
		expect(store.get(id)?.confidence).toBe("classified")
		expect(store.get(id)?.proof?.kind).toBe("analog-tone")
		expect(
			store.snapshot().discoveries.find(d => d.id === id)?.confidence,
		).toBe("activity")
		expect(store.countsByJob("j")).toEqual(recount(store, "j"))
		expect(store.countsByJob("j")).toEqual({
			activity: 0,
			candidate: 0,
			classified: 1,
			decoded: 0,
		})
		expect(
			store.applyClassification(
				id,
				classification(
					"analog-fm",
					[["analog-fm", 0.9]],
					"adjacent-leak",
					"channel",
				),
			),
		).toBe("updated")
		expect(store.get(id)?.confidence).toBe("candidate")
		expect(store.countsByJob("j")).toEqual({
			activity: 0,
			candidate: 1,
			classified: 0,
			decoded: 0,
		})
		const snap = store.snapshot()
		const restored = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => 0,
			newId: counterIds(),
		})
		restored.restore(snap)
		// The tone lives in the sink, not the snapshot, so the restored label is stored.
		expect(restored.get(id)?.confidence).toBe("activity")
		expect(restored.get(id)?.confidenceCap).toBe("adjacent-leak")
		expect(restored.countsByJob("j")).toEqual({
			activity: 1,
			candidate: 0,
			classified: 0,
			decoded: 0,
		})
		expect(restored.countsByJob("j")).toEqual(recount(restored, "j"))
	})

	it("drops a proof label from the job counts when that discovery is evicted", () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 1,
			now: () => 0,
			newId: counterIds(),
		})
		const kept = store.ingest(
			makeObs({
				id: "o1",
				centreHz: 446_006_250,
				startedAt: 1_000,
				gate: "passed",
				jobIds: ["j"],
			}),
		)
		expect(store.recordAnalog("o1", tone(1_500))).toBe(true)
		expect(store.get(kept.discoveryId ?? "")?.confidence).toBe("classified")
		expect(store.countsByJob("j").classified).toBe(1)
		const next = store.ingest(
			makeObs({
				id: "o2",
				centreHz: 450_000_000,
				startedAt: 2_000,
				gate: "passed",
				jobIds: ["j"],
			}),
		)
		expect(next.discoveryId).toBeTruthy()
		expect(store.get(kept.discoveryId ?? "")).toBeUndefined()
		expect(store.get(next.discoveryId ?? "")?.confidence).toBe("activity")
		expect(store.countsByJob("j")).toEqual(recount(store, "j"))
		expect(store.countsByJob("j")).toEqual({
			activity: 1,
			candidate: 0,
			classified: 0,
			decoded: 0,
		})
	})
})

/** Sink evidence changes the shown label without writing the stored confidence. */
function sinkEvidence(ctx: Ctx): void {
	const inputs = ctx.inputs
	if (inputs.length === 0) return
	const obs = inputs[Math.floor(ctx.rand() * inputs.length)]
	if (obs === undefined) return
	const roll = ctx.rand()
	if (roll < 0.45) {
		ctx.store.recordAnalog(obs.id, tone(ctx.clock))
		return
	}
	if (roll < 0.75) {
		ctx.store.recordAnalog(obs.id, {
			outcome: "data-like",
			mode: "nfm",
			voice: false,
			tone: { ctcssHz: null, dcs: null },
			transport: "live",
			at: ctx.clock,
		})
		ctx.store.recordTrial(obs.id, {
			protocol: "dmr",
			decoder: "dsd-fme",
			outcome: "no-sync",
			order: Math.floor(ctx.rand() * 8),
			at: ctx.clock,
		})
		return
	}
	ctx.store.recordAnalog(obs.id, {
		outcome: "heard",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at: ctx.clock,
	})
}

function tone(at: number): ProofAnalogInput {
	return {
		outcome: "decoded",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: 88.5, dcs: null },
		transport: "live",
		at,
	}
}
