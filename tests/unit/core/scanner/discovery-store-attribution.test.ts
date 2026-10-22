import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0)

const newStore = (): DiscoveryStore =>
	new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
	})

describe("DiscoveryStore attribution for job hits (WG2 req 13.1)", () => {
	it("credits a placed observation's jobs once and a job joining it later once", () => {
		const store = newStore()
		const first = store.ingest(
			makeObs({
				id: "o1",
				centreHz: CH,
				startedAt: T0,
				blocks: 2,
				jobIds: ["A"],
			}),
		)
		expect(first.attributed).toEqual([
			{
				observationId: "o1",
				discoveryId: first.discoveryId,
				jobIds: ["A"],
				created: true,
			},
		])
		// A plain re-ingest credits nobody new.
		const again = store.ingest(
			makeObs({
				id: "o1",
				centreHz: CH,
				startedAt: T0,
				blocks: 3,
				jobIds: ["A"],
			}),
		)
		expect(again.attributed).toBeUndefined()
		// Job B joins the open track: only B is credited.
		const joined = store.ingest(
			makeObs({
				id: "o1",
				centreHz: CH,
				startedAt: T0,
				blocks: 4,
				jobIds: ["A", "B"],
			}),
		)
		expect(joined.attributed).toEqual([
			{
				observationId: "o1",
				discoveryId: first.discoveryId,
				jobIds: ["B"],
				created: false,
			},
		])
	})

	it("credits every observation whose gate passed and none still pending", () => {
		const store = newStore()
		const hit = (
			id: string,
			t: number,
			jobIds: string[],
			gate: "passed" | "pending" | "below" | "absent",
		) => makeObs({ id, centreHz: CH, startedAt: t, blocks: 1, jobIds, gate })
		expect(
			store.ingest(hit("a1", T0, ["A"], "pending")).attributed,
		).toBeUndefined()
		expect(
			store.ingest(hit("a2", T0 + 60_000, ["B"], "absent")).attributed,
		).toBeUndefined()
		expect(
			store.ingest(hit("a5", T0 + 90_000, ["C"], "below")).attributed,
		).toBeUndefined()
		const passed = store.ingest(hit("a3", T0 + 120_000, ["A"], "passed"))
		expect(passed.change).toBe("created")
		expect(passed.attributed).toEqual([
			{
				observationId: "a3",
				discoveryId: passed.discoveryId,
				jobIds: ["A"],
				created: true,
			},
		])
		const joined = store.ingest(hit("a4", T0 + 180_000, ["B"], "passed"))
		expect(joined.attributed).toEqual([
			{
				observationId: "a4",
				discoveryId: passed.discoveryId,
				jobIds: ["B"],
				created: false,
			},
		])
		expect(store.discoveryIdOf("a1")).toBeUndefined()
		expect(store.discoveryIdOf("a2")).toBeUndefined()
		expect(store.discoveryIdOf("a5")).toBeUndefined()
		expect(store.discoveryIdOf("a3")).toBe(passed.discoveryId)
		expect(store.discoveryIdOf("a4")).toBe(passed.discoveryId)
	})

	it("keeps a joining job's credit when retention trims the re-ingested observation at once (Sol R2 1a)", () => {
		const store = newStore()
		const obs = (id: string, t: number, jobIds: string[]) =>
			makeObs({ id, centreHz: CH, startedAt: t, blocks: 2, jobIds })
		const first = store.ingest(obs("o_old", T0, ["A"]))
		// 256 newer observations push the open track's record out of retention.
		for (let i = 1; i <= 256; i++)
			store.ingest(obs(`o_${i}`, T0 + i * 1000, ["A"]))
		expect(store.discoveryIdOf("o_old")).toBeUndefined()
		// Its next ingest (job B joined) is placed again and trimmed again in the same operation.
		const joined = store.ingest(obs("o_old", T0, ["A", "B"]))
		expect(store.discoveryIdOf("o_old")).toBeUndefined()
		// The store cannot tell A was credited before; the service's per-job dedupe drops A.
		expect(joined.attributed).toEqual([
			{
				observationId: "o_old",
				discoveryId: first.discoveryId,
				jobIds: ["A", "B"],
				created: false,
			},
		])
	})

	it("snapshots the credit before a synchronous listener deletes the discovery (Sol R2 1b)", () => {
		const store = newStore()
		store.on("mutation", () => {
			for (const d of store.snapshot().discoveries) store.delete(d.id)
		})
		const r = store.ingest(
			makeObs({
				id: "o1",
				centreHz: CH,
				startedAt: T0,
				blocks: 2,
				jobIds: ["A"],
			}),
		)
		expect(store.get(r.discoveryId ?? "")).toBeUndefined()
		expect(r.attributed).toEqual([
			{
				observationId: "o1",
				discoveryId: r.discoveryId,
				jobIds: ["A"],
				created: true,
			},
		])
	})
})
