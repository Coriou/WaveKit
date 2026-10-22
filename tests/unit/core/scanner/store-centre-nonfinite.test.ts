/**
 * WG11 lane SC (review m6): the centre index refuses non-finite centres, so a NaN or Infinity
 * centre can neither corrupt the sorted order (hiding finite neighbours from the binary search)
 * nor be matched. (Today's linear scan matched a NaN-centred discovery to any probe of its
 * family, since `NaN > tol` is false; that is the defect, not a behaviour to keep.)
 */
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { CentreIndex } from "../../../../src/core/scanner/store/frequency-index.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import type { ProtocolFamily } from "../../../../src/core/scanner/types.js"
import { internals } from "./store-index-ops.js"

const FAMILIES: readonly ProtocolFamily[] = [
	"analog",
	"digital-voice",
	"pager",
	"packet",
	"ism",
	"carrier",
	"unknown",
]

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const CH = 446_006_250

describe("centre index non-finite centres (WG11 SC m6)", () => {
	it("refuses NaN and Infinity entries; finite lookups stay exact", () => {
		const index = new CentreIndex()
		const finite = [100, 200, 300, 400, 500, 600, 700]
		finite.forEach((c, i) => {
			index.add("s", "f", c, `a${i}`)
			if (i % 2 === 0) index.add("s", "f", Number.NaN, `n${i}`)
		})
		index.add("s", "f", Number.POSITIVE_INFINITY, "inf")
		index.add("s", "f", Number.NEGATIVE_INFINITY, "-inf")
		expect(index.size()).toBe(finite.length)
		expect(index.refusedNonFinite()).toBe(6)
		for (const c of finite) {
			const hits: number[] = []
			index.range("s", "f", c - 1, c + 1, e => hits.push(e.centreHz))
			expect(hits).toEqual([c])
		}
		const all: number[] = []
		index.range(
			"s",
			"f",
			Number.NEGATIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			e => all.push(e.centreHz),
		)
		expect(all).toEqual(finite)
		index.remove("s", "f", Number.NaN, "n0")
		expect(index.size()).toBe(finite.length)
	})

	it("a store observation with a NaN or Infinity centre never sticky-matches and hides nothing", () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 50,
			now: () => T0,
			newId: counterIds(),
		})
		const centres = [0, 1, 2, 3, 4].map(i => CH + i * 100_000)
		const ids = centres.map(
			(centreHz, i) =>
				store.ingest(
					makeObs({
						id: `f${i}`,
						centreHz,
						startedAt: T0 + i * 1000,
						blocks: 2,
					}),
				).discoveryId,
		)
		const odd = [Number.NaN, Number.POSITIVE_INFINITY, Number.NaN].map(
			(centreHz, k) =>
				store.ingest(
					makeObs({
						id: `x${k}`,
						centreHz,
						startedAt: T0 + 9000 + k,
						blocks: 2,
					}),
				).discoveryId,
		)
		// no non-finite observation was absorbed by a finite discovery (two NaNs may share the
		// frequency key, a separate path)
		expect(new Set(ids).size).toBe(5)
		for (const id of odd) expect(ids).not.toContain(id)
		const i = internals(store)
		const family = i.discoveries.get(ids[0] ?? "")?.family ?? "unknown"
		centres.forEach((centreHz, k) => {
			const obs = makeObs({ id: "probe", centreHz, startedAt: T0, blocks: 2 })
			expect(i.stickyMatch(obs, family)?.id).toBe(ids[k])
		})
		for (const centreHz of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const obs = makeObs({ id: "p", centreHz, startedAt: T0, blocks: 2 })
			for (const f of FAMILIES) expect(i.stickyMatch(obs, f)).toBeUndefined()
		}
		expect(
			(i as unknown as { centres: CentreIndex }).centres.refusedNonFinite(),
		).toBeGreaterThan(0)
	})
})
