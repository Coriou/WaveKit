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

	it("credits every pending single-block observation a promotion attaches", () => {
		const store = newStore()
		const hit = (id: string, t: number, jobIds: string[]) =>
			makeObs({ id, centreHz: CH, startedAt: t, blocks: 1, jobIds })
		expect(store.ingest(hit("a1", T0, ["A"])).attributed).toBeUndefined()
		expect(
			store.ingest(hit("a2", T0 + 60_000, ["B"])).attributed,
		).toBeUndefined()
		const third = store.ingest(hit("a3", T0 + 120_000, ["A"]))
		expect(third.change).toBe("created")
		expect(
			[...(third.attributed ?? [])].sort((a, b) =>
				a.observationId.localeCompare(b.observationId),
			),
		).toEqual([
			{
				observationId: "a1",
				discoveryId: third.discoveryId,
				jobIds: ["A"],
				created: true,
			},
			{
				observationId: "a2",
				discoveryId: third.discoveryId,
				jobIds: ["B"],
				created: true,
			},
			{
				observationId: "a3",
				discoveryId: third.discoveryId,
				jobIds: ["A"],
				created: true,
			},
		])
	})
})
