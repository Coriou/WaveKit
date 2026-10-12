import { afterEach, describe, expect, it } from "vitest"
import { ActivityQueryInvalidError } from "../../../../../src/core/activity/query/errors.js"
import { ActivitySnapshotResetError } from "../../../../../src/core/activity/query/errors.js"
import type { ActivityQueryService } from "../../../../../src/core/activity/storage/contract.js"
import { createFixture, delay, openQueryService, type ActivityFixture } from "./fixture.js"

describe("activity facets", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	it("rejects more than five dimensions, duplicates, and an empty list", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture)
		await expect(
			service.facets({
				query: {},
				dimensions: ["category", "protocol", "decoderId", "sourceId", "kind", "kind"],
			}),
		).rejects.toBeInstanceOf(ActivityQueryInvalidError)
		await expect(
			service.facets({ query: {}, dimensions: ["kind", "kind"] }),
		).rejects.toBeInstanceOf(ActivityQueryInvalidError)
		await expect(service.facets({ query: {}, dimensions: [] })).rejects.toBeInstanceOf(
			ActivityQueryInvalidError,
		)
	})

	it("caps values at 32 and sorts ties by value, keeping nulls first", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture, { limits: { facetScan: 100, facetValues: 32 } })
		for (let index = 0; index < 40; index += 1) {
			const protocol = index === 0 ? null : `p${String(index).padStart(2, "0")}`
			fixture.insert({
				eventId: `e${index}`,
				protocol,
				kind: index % 2 === 0 ? "decoder-reception" : "ingestion-gap",
			})
		}
		const result = await service.facets({
			query: {},
			dimensions: ["protocol", "kind"],
		})
		expect(result.truncated).toBe(false)
		expect(result.scanned).toBe(40)
		const protocols = result.facets["protocol"] ?? []
		expect(protocols).toHaveLength(32)
		expect(protocols[0]).toEqual({ value: null, count: 1 })
		expect(protocols.map(entry => entry.value).slice(1, 3)).toEqual(["p01", "p02"])
		expect(protocols.some(entry => entry.value === "p39")).toBe(false)
		const kinds = result.facets["kind"] ?? []
		expect(kinds[0]?.count).toBeGreaterThanOrEqual(kinds[1]?.count ?? 0)
	})

	it("marks counts as a lower bound when the scan cap is hit", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture, { limits: { facetScan: 3, facetValues: 32 } })
		fixture.insert({ eventId: "old", kind: "ingestion-gap", protocol: "old" })
		fixture.insert({ eventId: "a", kind: "decoder-reception", protocol: "ais" })
		fixture.insert({ eventId: "b", kind: "decoder-reception", protocol: "ais" })
		fixture.insert({ eventId: "c", kind: "decoder-reception", protocol: "acars" })
		const result = await service.facets({ query: {}, dimensions: ["kind", "protocol"] })
		expect(result.truncated).toBe(true)
		expect(result.scanned).toBe(3)
		expect(result.facets["kind"]).toEqual([{ value: "decoder-reception", count: 3 }])
		const protocols = result.facets["protocol"] ?? []
		expect(protocols).toEqual([
			{ value: "ais", count: 2 },
			{ value: "acars", count: 1 },
		])
		expect(result.snapshot.lowBarrier).toBe("0")
	})

	it("examines only the open snapshot and resets when the lower bound moves", async () => {
		fixture = await createFixture()
		const store = fixture
		store.insert({ eventId: "pruned", protocol: "gone" })
		store.insert({ eventId: "kept", protocol: "ais" })
		store.pruneThrough("1")
		service = openQueryService(store, {
			readerDelayMs: () => 20,
		})
		const visible = service.facets({ query: {}, dimensions: ["protocol"] })
		await delay(5)
		store.setIdentity({ pruneWatermark: "2" })
		await expect(visible).rejects.toBeInstanceOf(ActivitySnapshotResetError)
		store.setIdentity({ pruneWatermark: "1" })
		await service.close()
		service = openQueryService(store)
		const again = await service.facets({ query: {}, dimensions: ["protocol"] })
		expect(again.scanned).toBe(1)
		expect(again.facets["protocol"]).toEqual([{ value: "ais", count: 1 }])
		expect(again.snapshot.lowBarrier).toBe("1")
	})
})
