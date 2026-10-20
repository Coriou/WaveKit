import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	DecodeEvidence,
	Discovery,
} from "../../../../src/core/scanner/types.js"
import {
	classification,
	counterIds,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

function newStore(minSurfaceBlocks?: number): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		...(minSurfaceBlocks !== undefined ? { minSurfaceBlocks } : {}),
	})
}

describe("DiscoveryStore gated surfacing", () => {
	it("a pending track creates no discovery", () => {
		const store = newStore()
		const before = store.snapshot()
		expect(
			store.ingest(
				makeObs({
					id: "o1",
					centreHz: CH,
					startedAt: T0,
					blocks: 8,
					gate: "pending",
					cls: "fsk4-12k5",
					hypotheses: [["dmr", 0.9]],
				}),
			),
		).toEqual({ discoveryId: null, change: "transient" })
		expect(store.snapshot()).toEqual(before)
	})

	it("Absent gate is treated as pending", () => {
		const store = newStore()
		const obs = makeObs({
			id: "o1",
			centreHz: CH,
			startedAt: T0,
			blocks: 8,
			gate: "absent",
			cls: "analog-fm",
			hypotheses: [["analog-fm", 0.9]],
		})
		expect(obs.track.gate).toBeUndefined()
		expect(store.ingest(obs)).toEqual({
			discoveryId: null,
			change: "transient",
		})
		expect(store.snapshot().discoveries).toEqual([])
		expect(store.snapshot().observations).toEqual([])
	})

	it("A passed track creates one discovery with protocol unknown and confidence activity", () => {
		const store = newStore()
		const res = store.ingest(
			makeObs({
				id: "o1",
				centreHz: CH,
				startedAt: T0,
				blocks: 1,
				gate: "passed",
			}),
		)
		expect(res.change).toBe("created")
		const d = store.get(res.discoveryId ?? "")
		expect(d?.protocol).toBe("unknown")
		expect(d?.confidence).toBe("activity")
		expect(d?.family).toBe("unknown")
		expect(d?.proof).toBeUndefined()
		expect(d?.observationCount).toBe(1)
		expect(store.snapshot().discoveries).toHaveLength(1)
	})

	it("A below track changes only counts.transients", () => {
		const store = newStore()
		const before = store.snapshot()
		const counts = store.countsByJob("job-1")
		// The store returns transient. The service is what increments counts.transients.
		const caller = { observations: 0, transients: 0 }
		const res = store.ingest(
			makeObs({
				id: "o1",
				centreHz: CH,
				startedAt: T0,
				blocks: 8,
				snrDb: 30,
				gate: "below",
				cls: "fsk4-12k5",
				hypotheses: [["dmr", 0.9]],
				tier: "channel",
			}),
		)
		expect(res).toEqual({ discoveryId: null, change: "transient" })
		expect(store.snapshot()).toEqual(before)
		expect(store.countsByJob("job-1")).toEqual(counts)
		if (res.change === "transient") caller.transients += 1
		else caller.observations += 1
		expect(caller).toEqual({ observations: 0, transients: 1 })
	})

	it("minSurfaceBlocks no longer affects discovery creation (2 vs 10 give the same store)", () => {
		const run = (minSurfaceBlocks: number): DiscoveryStore => {
			const store = newStore(minSurfaceBlocks)
			store.ingest(
				makeObs({
					id: "o1",
					centreHz: CH,
					startedAt: T0,
					blocks: 1,
					gate: "passed",
				}),
			)
			store.ingest(
				makeObs({
					id: "o2",
					centreHz: CH + 100_000,
					startedAt: T0 + 1_000,
					blocks: 8,
					gate: "pending",
				}),
			)
			store.ingest(
				makeObs({
					id: "o3",
					centreHz: CH + 200_000,
					startedAt: T0 + 2_000,
					blocks: 2,
					gate: "passed",
				}),
			)
			store.setLimits({
				maxDiscoveries: 100,
				minSurfaceBlocks: minSurfaceBlocks + 5,
			})
			store.ingest(
				makeObs({
					id: "o4",
					centreHz: CH + 300_000,
					startedAt: T0 + 3_000,
					blocks: 2,
					gate: "passed",
				}),
			)
			return store
		}
		expect(run(2).snapshot()).toEqual(run(10).snapshot())
	})

	it("A prior-only hypothesis at score 0.9 leaves protocol unknown and activity", () => {
		const store = newStore()
		const res = store.ingest(
			makeObs({
				id: "o1",
				centreHz: CH,
				startedAt: T0,
				gate: "passed",
				cls: "fsk4-12k5",
				hypotheses: [["dmr", 0.9]],
				tier: "channel",
			}),
		)
		const id = res.discoveryId ?? ""
		expect(store.get(id)?.protocol).toBe("unknown")
		expect(store.get(id)?.confidence).toBe("activity")
		expect(store.get(id)?.proof).toBeUndefined()
		store.applyClassification(
			id,
			classification("fsk4-12k5", [["dmr", 0.9]], undefined, "channel"),
		)
		expect(store.get(id)?.protocol).toBe("unknown")
		expect(store.get(id)?.confidence).toBe("activity")
		expect(store.get(id)?.class).toBe("fsk4-12k5")
	})

	it("Stored records load unchanged (no migration)", () => {
		const store = newStore()
		store.ingest(
			makeObs({
				id: "o1",
				centreHz: CH,
				startedAt: T0,
				gate: "passed",
				cls: "fsk4-12k5",
				hypotheses: [["dmr", 0.9]],
				tier: "channel",
			}),
		)
		const snap = store.snapshot()
		const saved: Discovery | undefined = snap.discoveries[0]
		expect(saved).toBeDefined()
		if (saved === undefined) return
		saved.protocol = "dmr"
		saved.family = "digital-voice"
		saved.confidence = "classified"
		const raw = JSON.parse(JSON.stringify(snap)) as typeof snap
		const replica = newStore()
		replica.restore(raw)
		expect(replica.snapshot()).toEqual(raw)
		expect(replica.get(saved.id)?.protocol).toBe("dmr")
		expect(replica.get(saved.id)?.confidence).toBe("classified")
		expect(replica.get(saved.id)?.proof).toBeUndefined()
	})

	it("An ambient AIS decode sets protocol ais, decoded", () => {
		const store = newStore()
		const id =
			store.ingest(
				makeObs({
					id: "o1",
					centreHz: 162_025_000,
					startedAt: T0,
					gate: "passed",
				}),
			).discoveryId ?? ""
		expect(
			store.applyEvidence(id, {
				...evidence("ais", T0 + 10, {
					identity: { kind: "ais-mmsi", value: "211234567" },
				}),
				origin: "ambient",
			}),
		).toBe("upgraded")
		const d = store.get(id)
		expect(d?.protocol).toBe("ais")
		expect(d?.family).toBe("packet")
		expect(d?.confidence).toBe("decoded")
		expect(d?.identity).toEqual({ kind: "ais-mmsi", value: "211234567" })
		expect(d?.proof).toBeUndefined()
	})
})

describe("DiscoveryStore decode-proven placement", () => {
	const AIS_HZ = 162_025_000
	const mmsi = { kind: "ais-mmsi" as const, value: "211234567" }
	const aisDecode = (extra: Partial<DecodeEvidence> = {}): DecodeEvidence => ({
		...evidence("ais", T0 + 10, { identity: mmsi }),
		origin: "ambient",
		...extra,
	})
	const burst = (gate: "pending" | "below" | "absent", id = "o1") =>
		makeObs({
			id,
			centreHz: AIS_HZ,
			startedAt: T0,
			durationMs: 27,
			blocks: 1,
			burst: true,
			gate,
		})

	/** The service's evidence path: place with the decode, then append and apply it. */
	function applyAmbient(
		store: DiscoveryStore,
		gate: "pending" | "below" | "absent",
		ev: DecodeEvidence,
	): string | null {
		const placed = store.ingest(burst(gate), { decode: ev })
		if (placed.discoveryId === null) return null
		expect(store.appendObservationEvidence("o1", ev)).toBe(true)
		store.applyEvidence(placed.discoveryId, ev)
		return store.discoveryIdOf("o1") ?? null
	}

	it("an accepted AIS decode on a pending-gate 27 ms burst creates a decoded, proven discovery", () => {
		const store = newStore()
		const id = applyAmbient(store, "pending", aisDecode())
		expect(id).not.toBeNull()
		const d = store.get(id ?? "")
		expect(d?.protocol).toBe("ais")
		expect(d?.confidence).toBe("decoded")
		expect(d?.identity).toEqual(mmsi)
		expect(d?.evidenceLevel).toBe("proven")
		expect(d?.proof?.kind).toBe("decoded")
	})

	it("an absent gate with an accepted decode also creates", () => {
		const store = newStore()
		expect(applyAmbient(store, "absent", aisDecode())).not.toBeNull()
		expect(store.snapshot().discoveries).toHaveLength(1)
	})

	// A decode proves the burst is not noise, so a below gate does not veto it.
	it("a below gate with an accepted decode also creates", () => {
		const store = newStore()
		const id = applyAmbient(store, "below", aisDecode())
		expect(store.get(id ?? "")?.confidence).toBe("decoded")
	})

	it("the same burst without a decode creates nothing", () => {
		for (const gate of ["pending", "below", "absent"] as const) {
			const store = newStore()
			expect(store.ingest(burst(gate))).toEqual({
				discoveryId: null,
				change: "transient",
			})
			expect(store.snapshot().discoveries).toEqual([])
		}
	})

	it("a decode that is not an accepted identity decode creates nothing", () => {
		const rejected: DecodeEvidence[] = [
			aisDecode({ identity: { kind: "dmr-cc", value: "1" } }),
			aisDecode({ identity: { kind: "ais-mmsi", value: "" } }),
			aisDecode({ crcClean: false }),
			aisDecode({ epoch: 2 }),
			(() => {
				const ev = aisDecode()
				delete ev.identity
				return ev
			})(),
		]
		for (const ev of rejected) {
			const store = newStore()
			expect(store.ingest(burst("pending"), { decode: ev })).toEqual({
				discoveryId: null,
				change: "transient",
			})
			expect(store.snapshot().discoveries).toEqual([])
		}
	})

	it("a flagged track stays transient even with a decode", () => {
		const store = newStore()
		const obs = makeObs({
			id: "o1",
			centreHz: AIS_HZ,
			startedAt: T0,
			durationMs: 27,
			iqImage: true,
			gate: "pending",
		})
		expect(store.ingest(obs, { decode: aisDecode() }).change).toBe("transient")
	})
})

describe("DiscoveryStore re-ingest after placement", () => {
	it("a placed observation keeps re-ingesting when a later gate is not passed", () => {
		for (const gate of ["pending", "below", "absent"] as const) {
			const store = newStore()
			const placed = store.ingest(
				makeObs({
					id: "o1",
					centreHz: CH,
					startedAt: T0,
					open: true,
					gate: "passed",
				}),
			)
			const id = placed.discoveryId ?? ""
			const again = store.ingest(
				makeObs({
					id: "o1",
					centreHz: CH,
					startedAt: T0,
					durationMs: 4_000,
					gate,
				}),
			)
			expect(again.discoveryId).toBe(id)
			expect(again.change).not.toBe("transient")
			expect(store.discoveryIdOf("o1")).toBe(id)
			expect(store.get(id)?.airtimeMs).toBe(4_000)
		}
	})

	it("a new observation with the same non-passed gate is still transient", () => {
		const store = newStore()
		store.ingest(
			makeObs({ id: "o1", centreHz: CH, startedAt: T0, gate: "passed" }),
		)
		expect(
			store.ingest(
				makeObs({
					id: "o2",
					centreHz: CH,
					startedAt: T0 + 2_000,
					gate: "pending",
				}),
			).change,
		).toBe("transient")
	})
})
