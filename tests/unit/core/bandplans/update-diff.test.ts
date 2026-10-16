import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { StoredBand } from "@wavekit/api-types"
import {
	UPDATE_DIFF_FIELD_ORDER,
	diffImportedBands,
} from "../../../../src/core/bandplans/import/update-diff.js"

function band(id: string, extra: Partial<StoredBand> = {}): StoredBand {
	return {
		id,
		name: id,
		startHz: 100,
		endHz: 200,
		group: "other",
		mode: null,
		bandwidthHz: null,
		stepHz: null,
		skip: null,
		channels: [],
		parentId: null,
		colourHint: null,
		registryRef: null,
		scan: null,
		provenance: { kind: "imported" },
		...extra,
	}
}

const ids = ["a", "b", "c", "d", "e", "f", "g", "h"]
const bandArb = (id: string) =>
	fc.record({
		id: fc.constant(id),
		name: fc.constantFrom("A", "B"),
		startHz: fc.integer({ min: 1, max: 5 }),
		endHz: fc.integer({ min: 6, max: 9 }),
		group: fc.constantFrom("other" as const, "air" as const),
		mode: fc.constantFrom(null, "nfm" as const),
		bandwidthHz: fc.constantFrom(null, 12_500),
		stepHz: fc.constantFrom(null, 25_000),
		skip: fc.constant(null),
		channels: fc.constant<StoredBand["channels"]>([]),
		parentId: fc.constant(null),
		colourHint: fc.constantFrom(null, "#ff0000"),
		registryRef: fc.constant(null),
		scan: fc.constant(null),
		provenance: fc.constant({ kind: "imported" as const }),
	})
const listArb = fc
	.subarray(ids)
	.chain(chosen => fc.tuple(...chosen.map(bandArb)))
	.map((list): StoredBand[] => list)

describe("diffImportedBands", () => {
	// Feature: web-gaps-6, Property 13: Update diff
	// Validates: Requirements 6.2
	it("partitions ids and applying the diff to current yields fresh", () => {
		fc.assert(
			fc.property(listArb, listArb, (current, fresh) => {
				const diff = diffImportedBands(current, fresh)
				const added = diff.added.map(b => b.id)
				const removed = diff.removed.map(b => b.id)
				const changed = diff.changed.map(b => b.id)
				const freshIds = new Set(fresh.map(b => b.id))
				const currentIds = new Set(current.map(b => b.id))
				const unchanged = [...currentIds].filter(
					id => freshIds.has(id) && !changed.includes(id),
				)
				const all = [...added, ...removed, ...changed, ...unchanged]
				// Partition: disjoint and covering the union of ids.
				expect(new Set(all).size).toBe(all.length)
				expect(new Set(all)).toEqual(new Set([...currentIds, ...freshIds]))
				// Apply: drop removed, add added, take changed from fresh.
				const byId = new Map(current.map(b => [b.id, b]))
				for (const id of removed) byId.delete(id)
				const freshById = new Map(fresh.map(b => [b.id, b]))
				for (const id of [...added, ...changed])
					byId.set(id, freshById.get(id) as StoredBand)
				const sort = (list: StoredBand[]) =>
					[...list].sort((l, r) => (l.id < r.id ? -1 : 1))
				expect(sort([...byId.values()])).toEqual(sort(fresh))
				// Every list sorted by startHz then id; fields ordered.
				for (const list of [diff.added, diff.removed, diff.changed])
					for (let i = 1; i < list.length; i++) {
						const l = list[i - 1]
						const r = list[i]
						if (!l || !r) continue
						expect(
							l.startHz < r.startHz || (l.startHz === r.startHz && l.id < r.id),
						).toBe(true)
					}
				for (const entry of diff.changed) {
					const listed = entry.fields.filter(f =>
						UPDATE_DIFF_FIELD_ORDER.includes(f),
					)
					const order = listed.map(f => UPDATE_DIFF_FIELD_ORDER.indexOf(f))
					expect(order).toEqual([...order].sort((x, y) => x - y))
					expect(entry.fields.length).toBeGreaterThan(0)
				}
				expect(diff.truncated).toBe(false)
			}),
			{ numRuns: 200 },
		)
	})

	it("orders changed fields name, startHz, endHz, mode, stepHz, colourHint, group, then others", () => {
		const diff = diffImportedBands(
			[band("x")],
			[
				band("x", {
					name: "Y",
					startHz: 50,
					endHz: 300,
					mode: "am",
					stepHz: 8_330,
					colourHint: "#00ff00",
					group: "air",
					channels: [
						{
							id: "c1",
							name: "C",
							frequencyHz: 120,
							aliases: [],
							registryRef: null,
						},
					],
					bandwidthHz: 10_000,
				}),
			],
		)
		expect(diff.changed).toEqual([
			{
				id: "x",
				name: "Y",
				startHz: 50,
				endHz: 300,
				fields: [
					"name",
					"startHz",
					"endHz",
					"mode",
					"stepHz",
					"colourHint",
					"group",
					"channels",
					"bandwidthHz",
				],
			},
		])
	})

	it("ignores provenance and scan, reports sourceType when present", () => {
		const current = { ...band("x"), sourceType: "ham" }
		const scan = { bandplanId: "p", ranges: [] }
		const fresh = { ...band("x"), scan, sourceType: "air" }
		expect(diffImportedBands([current], [fresh]).changed[0]?.fields).toEqual([
			"sourceType",
		])
		expect(
			diffImportedBands(
				[band("x")],
				[Object.assign(band("x"), { scan, provenance: { kind: "operator" } })],
			).changed,
		).toEqual([])
	})

	it("sorts by startHz then id and caps each list at 512", () => {
		const fresh = Array.from({ length: 600 }, (_, i) =>
			band(`b${String(i).padStart(3, "0")}`, { startHz: 1000 - (i % 7) }),
		)
		const diff = diffImportedBands([], fresh)
		expect(diff.added).toHaveLength(512)
		expect(diff.truncated).toBe(true)
		expect(diff.added[0]).toMatchObject({ startHz: 994, id: "b006" })
	})

	it("benchmark: 512 x 512 (indicative)", () => {
		const current = Array.from({ length: 512 }, (_, i) =>
			band(`b${i}`, { startHz: i * 10, endHz: i * 10 + 5 }),
		)
		const fresh = Array.from({ length: 512 }, (_, i) =>
			band(`b${i + 100}`, {
				startHz: i * 10,
				endHz: i * 10 + (i % 3 === 0 ? 6 : 5),
				mode: i % 5 === 0 ? "nfm" : null,
			}),
		)
		diffImportedBands(current, fresh)
		const runs = 20
		const start = performance.now()
		for (let i = 0; i < runs; i++) diffImportedBands(current, fresh)
		const ms = (performance.now() - start) / runs
		console.info(`diffImportedBands 512x512: ${ms.toFixed(3)} ms`)
		expect(ms).toBeLessThan(50)
	})
})
