/**
 * WG11 lane SC (Main's identity accessor): DiscoveryStore.identityOf returns a fresh
 * { id, protocol, confidence } built from the stored discovery's scalars (no clone), resolves the
 * survivor after a merge through discoveryIdOf, and is undefined for an unknown id.
 */
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { Raster } from "../../../../src/core/spectrum/types.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const PMR: Raster[] = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

const newStore = (): DiscoveryStore =>
	new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
	})

const dmrObs = (id: string, centreHz: number, startedAt: number) =>
	makeObs({
		id,
		centreHz,
		startedAt,
		cls: "fsk4-12k5",
		hypotheses: [["dmr", 0.8]],
	})

describe("DiscoveryStore.identityOf (WG11 SC)", () => {
	it("returns the stored scalars in a fresh object; mutating it leaves the store alone", () => {
		const store = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		const d = store.get(id)
		const got = store.identityOf(id)
		expect(got).toEqual({
			id,
			protocol: d?.protocol,
			confidence: d?.confidence,
		})
		expect(store.identityOf(id)).not.toBe(got)
		if (got === undefined) throw new Error("missing")
		got.id = "x"
		got.protocol = "p25p1"
		got.confidence = "decoded"
		expect(store.identityOf(id)).toEqual({
			id,
			protocol: d?.protocol,
			confidence: d?.confidence,
		})
		expect(store.get(id)).toEqual(d)
	})

	it("an absorbed observation resolves to the survivor's identity after a merge", () => {
		const store = newStore()
		const a = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		const b =
			store.ingest(dmrObs("o2", CH + 3_500, T0 + 1_000)).discoveryId ?? ""
		expect(a).not.toBe(b)
		expect(store.rekey("src-1", 3_000)).toEqual({ merged: [[a, b]] })
		const survivor = store.discoveryIdOf("o2")
		expect(survivor).toBe(a)
		expect(store.identityOf(survivor ?? "")?.id).toBe(a)
		expect(store.identityOf(b)).toBeUndefined()
	})

	it("is undefined for an unknown id", () => {
		expect(newStore().identityOf("d_missing")).toBeUndefined()
	})
})
