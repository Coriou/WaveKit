import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	bandPlanStateSchema,
	OPERATOR_PACK_ID,
} from "@wavekit/api-types"
import type {
	Band,
	BandEdit,
	BandEditFields,
	BandPlanPack,
	BandPlanState,
	PlanProvenance,
	ResolvedBand,
} from "@wavekit/api-types"
import {
	builtinPackIdFor,
	projectBuiltinPacks,
} from "../../../../src/core/bandplans/builtin-packs.js"
import {
	applyBandEdit,
	resolveBandPlans,
} from "../../../../src/core/bandplans/resolve.js"
import type { ResolverInput } from "../../../../src/core/bandplans/contract.js"

const PROVENANCE: PlanProvenance = {
	kind: "imported",
	trust: "community-unverified",
	format: "sdrpp-json",
	sourceName: "file.json",
	author: null,
	licence: null,
	importedAt: "2026-01-01T00:00:00.000Z",
	sha256: "ab".repeat(32),
}

function band(
	id: string,
	startHz: number,
	endHz: number,
	parentId: string | null = null,
): Band {
	return {
		id,
		name: id,
		startHz,
		endHz,
		group: "other",
		mode: null,
		bandwidthHz: null,
		stepHz: null,
		skip: null,
		channels: [],
		parentId,
		colourHint: null,
		registryRef: null,
		scan: null,
		provenance: { kind: "imported" },
	}
}

function pack(id: string, bands: readonly Band[]): BandPlanPack {
	return {
		id,
		kind: "imported",
		name: id,
		region: null,
		provenance: PROVENANCE,
		bands,
	}
}

function edit(
	packId: string,
	bandId: string,
	set: BandEditFields,
): BandEdit {
	return {
		packId,
		bandId,
		set,
		updatedAt: "2026-01-01T00:00:00.000Z",
	}
}

function resolve(input: ResolverInput) {
	return resolveBandPlans(input)
}

function contains(
	segments: readonly { startHz: number; endHz: number }[],
	hz: number,
): boolean {
	return segments.some(segment => segment.startHz <= hz && hz <= segment.endHz)
}

function overlaps(
	a: { startHz: number; endHz: number },
	b: { startHz: number; endHz: number },
): boolean {
	return a.startHz <= b.endHz && b.startHz <= a.endHz
}

describe("applyBandEdit", () => {
	const siblings = new Set(["self", "peer"])

	it("ignores both edges and reports edge-conflict when the edit would be empty", () => {
		const source = band("self", 100, 200)
		const applied = applyBandEdit(
			source,
			edit("p", "self", { startHz: 250, name: "Kept" }),
			siblings,
		)
		expect(applied.issues).toEqual(["edge-conflict"])
		expect(applied.editedFields).toEqual(["name"])
		expect(applied.band?.startHz).toBe(100)
		expect(applied.band?.endHz).toBe(200)
		expect(applied.band?.name).toBe("Kept")
		expect(source.startHz).toBe(100)
	})

	it("applies a valid one-sided edge and lists fields in contract order", () => {
		const applied = applyBandEdit(
			band("self", 100, 200),
			edit("p", "self", { endHz: 180, group: "air", hidden: false }),
			siblings,
		)
		expect(applied.issues).toEqual([])
		expect(applied.editedFields).toEqual(["endHz", "group", "hidden"])
		expect(applied.band?.endHz).toBe(180)
	})

	it("nulls a dangling parent and still reports the field as edited", () => {
		const applied = applyBandEdit(
			band("self", 100, 200, "peer"),
			edit("p", "self", { parentId: "gone" }),
			siblings,
		)
		expect(applied.issues).toEqual(["dangling-parent"])
		expect(applied.editedFields).toEqual(["parentId"])
		expect(applied.band?.parentId).toBeNull()
	})

	it("nulls an original dangling parent without calling it an edit", () => {
		const applied = applyBandEdit(
			band("self", 100, 200, "gone"),
			undefined,
			siblings,
		)
		expect(applied.issues).toEqual(["dangling-parent"])
		expect(applied.editedFields).toEqual([])
		expect(applied.band?.parentId).toBeNull()
	})

	it("hides the band when hidden is true", () => {
		const applied = applyBandEdit(
			band("self", 100, 200),
			edit("p", "self", { hidden: true, name: "Secret" }),
			siblings,
		)
		expect(applied.band).toBeNull()
		expect(applied.editedFields).toEqual(["name", "hidden"])
	})
})

describe("resolveBandPlans", () => {
	it("puts the operator layer above the stack and lets gaps fall through", () => {
		const packs = new Map([
			[
				"imported-000000000001",
				pack("imported-000000000001", [
					band("wide", 100, 250),
					band("high", 1000, 1100),
				]),
			],
		])
		const resolved = resolve({
			packs,
			stack: [{ packId: "imported-000000000001", enabled: true }],
			operatorBands: [
				{ ...band("op-1", 100, 200), provenance: { kind: "operator" } },
			],
			edits: [],
		})
		expect(resolved.bands.map(item => [item.key, item.layer, item.segments])).toEqual([
			[`${OPERATOR_PACK_ID}/op-1`, 0, [{ startHz: 100, endHz: 200 }]],
			["imported-000000000001/wide", 1, [{ startHz: 201, endHz: 250 }]],
			["imported-000000000001/high", 1, [{ startHz: 1000, endHz: 1100 }]],
		])
		expect(resolved.shadowed).toEqual([])
		expect(resolved.hidden).toEqual([])
	})

	it("splits a lower band around two higher ranges and keeps a 1 Hz boundary covered", () => {
		const packs = new Map([
			["imported-00000000000a", pack("imported-00000000000a", [band("top-a", 100, 150), band("top-b", 200, 250)])],
			["imported-00000000000b", pack("imported-00000000000b", [band("low", 100, 250)])],
		])
		const resolved = resolve({
			packs,
			stack: [
				{ packId: "imported-00000000000a", enabled: true },
				{ packId: "imported-00000000000b", enabled: true },
			],
			operatorBands: [],
			edits: [],
		})
		const low = resolved.bands.find(item => item.bandId === "low")
		expect(low?.segments).toEqual([{ startHz: 151, endHz: 199 }])
		expect(low?.layer).toBe(2)
	})

	it("does not clip overlapping bands in the same layer", () => {
		const packs = new Map([
			[
				"imported-00000000000c",
				pack("imported-00000000000c", [
					band("b-a", 100, 200),
					band("b-b", 150, 250),
				]),
			],
		])
		const resolved = resolve({
			packs,
			stack: [{ packId: "imported-00000000000c", enabled: true }],
			operatorBands: [],
			edits: [],
		})
		expect(resolved.bands.map(item => item.segments)).toEqual([
			[{ startHz: 100, endHz: 200 }],
			[{ startHz: 150, endHz: 250 }],
		])
	})

	it("reports a fully covered band as shadowed and skips disabled or unknown entries", () => {
		const packs = new Map([
			["imported-00000000000d", pack("imported-00000000000d", [band("cover", 1, 50)])],
			["imported-00000000000e", pack("imported-00000000000e", [band("under", 10, 20)])],
		])
		const stack = [
			{ packId: "imported-00000000000d", enabled: true },
			{ packId: "missing-pack", enabled: true },
			{ packId: "imported-00000000000e", enabled: false },
			{ packId: "imported-00000000000e", enabled: true },
		]
		const resolved = resolve({
			packs,
			stack,
			operatorBands: [],
			edits: [],
		})
		expect(resolved.shadowed).toEqual(["imported-00000000000e/under"])
		expect(resolved.bands.map(item => item.bandId)).toEqual(["cover"])
		expect(resolved.bands[0]?.layer).toBe(1)
		const removed = resolve({
			packs,
			stack: [
				{ packId: "imported-00000000000d", enabled: true },
				{ packId: "imported-00000000000e", enabled: true },
			],
			operatorBands: [],
			edits: [],
		})
		const disabled = resolve({
			packs,
			stack: [
				{ packId: "imported-00000000000d", enabled: true },
				{ packId: "imported-00000000000e", enabled: false },
			],
			operatorBands: [],
			edits: [],
		})
		expect(disabled).toEqual(
			resolve({
				packs,
				stack: [{ packId: "imported-00000000000d", enabled: true }],
				operatorBands: [],
				edits: [],
			}),
		)
		expect(removed.shadowed).toEqual(["imported-00000000000e/under"])
	})

	it("hides a band without letting it shadow, and keeps orphan edits off other bands", () => {
		const packs = new Map([
			[
				"imported-00000000000f",
				pack("imported-00000000000f", [
					band("keep", 1000, 1100),
					band("hide", 100, 400),
				]),
			],
			["imported-000000000010", pack("imported-000000000010", [band("lower", 150, 180)])],
		])
		const resolved = resolve({
			packs,
			stack: [
				{ packId: "imported-00000000000f", enabled: true },
				{ packId: "imported-000000000010", enabled: true },
			],
			operatorBands: [],
			edits: [
				edit("imported-00000000000f", "hide", { hidden: true, name: "Hidden" }),
				edit("imported-00000000000f", "keep", { name: "Kept" }),
				edit("imported-00000000000f", "gone", { name: "Orphan name" }),
				edit("imported-000000000099", "other", { name: "Unknown pack" }),
			],
		})
		expect(resolved.hidden).toEqual(["imported-00000000000f/hide"])
		expect(resolved.orphanedEdits).toEqual([
			{ packId: "imported-00000000000f", bandId: "gone" },
		])
		expect(resolved.shadowed).toEqual([])
		const keep = resolved.bands.find(item => item.bandId === "keep")
		const lower = resolved.bands.find(item => item.bandId === "lower")
		expect(keep?.band.name).toBe("Kept")
		expect(keep?.editedFields).toEqual(["name"])
		expect(lower?.segments).toEqual([{ startHz: 150, endHz: 180 }])
		expect(resolved.bands.some(item => item.band.name === "Orphan name")).toBe(false)
	})

	it("sorts same-start bands by key and uses original edges after an edge conflict", () => {
		const packs = new Map([
			[
				"imported-000000000011",
				pack("imported-000000000011", [
					band("b-b", 100, 180),
					band("b-a", 100, 160),
				]),
			],
		])
		const resolved = resolve({
			packs,
			stack: [{ packId: "imported-000000000011", enabled: true }],
			operatorBands: [],
			edits: [edit("imported-000000000011", "b-a", { startHz: 500 })],
		})
		expect(resolved.bands.map(item => item.bandId)).toEqual(["b-a", "b-b"])
		const edited = resolved.bands[0]
		expect(edited?.issues).toEqual(["edge-conflict"])
		expect(edited?.band.startHz).toBe(100)
		expect(edited?.editedFields).toEqual([])
	})
})

interface WorldBand {
	id: string
	startHz: number
	endHz: number
	hidden: boolean
}

interface WorldLayer {
	packId: string
	enabled: boolean
	bands: WorldBand[]
}

function worldInput(layers: readonly WorldLayer[], operator: readonly WorldBand[]): ResolverInput {
	const packs = new Map<string, BandPlanPack>()
	for (const layer of layers)
		packs.set(
			layer.packId,
			pack(
				layer.packId,
				layer.bands.map(item => band(item.id, item.startHz, item.endHz)),
			),
		)
	return {
		packs,
		stack: layers.map(layer => ({ packId: layer.packId, enabled: layer.enabled })),
		operatorBands: operator.map(item => ({
			...band(item.id, item.startHz, item.endHz),
			provenance: { kind: "operator" },
		})),
		edits: layers.flatMap(layer =>
			layer.bands
				.filter(item => item.hidden)
				.map(item => edit(layer.packId, item.id, { hidden: true })),
		),
	}
}

function visibleRanges(input: ResolverInput): { layer: number; startHz: number; endHz: number }[] {
	const ranges: { layer: number; startHz: number; endHz: number }[] = []
	input.operatorBands.forEach(item => {
		if (item.startHz < item.endHz)
			ranges.push({ layer: 0, startHz: item.startHz, endHz: item.endHz })
	})
	let layer = 1
	for (const entry of input.stack) {
		if (!entry.enabled) continue
		const found = input.packs.get(entry.packId)
		if (!found) continue
		const siblings = new Set(found.bands.map(item => item.id))
		for (const item of found.bands) {
			const editForBand = input.edits.find(
				candidate =>
					candidate.packId === found.id && candidate.bandId === item.id,
			)
			const applied = applyBandEdit(item, editForBand, siblings)
			if (applied.band && applied.band.startHz < applied.band.endHz)
				ranges.push({
					layer,
					startHz: applied.band.startHz,
					endHz: applied.band.endHz,
				})
		}
		layer += 1
	}
	return ranges
}

function merge(ranges: readonly { startHz: number; endHz: number }[]) {
	const sorted = ranges
		.filter(range => range.startHz <= range.endHz)
		.map(range => ({ startHz: range.startHz, endHz: range.endHz }))
		.sort((a, b) => a.startHz - b.startHz || a.endHz - b.endHz)
	const out: { startHz: number; endHz: number }[] = []
	for (const range of sorted) {
		const last = out[out.length - 1]
		if (last && range.startHz <= last.endHz + 1)
			last.endHz = Math.max(last.endHz, range.endHz)
		else out.push(range)
	}
	return out
}

const arbBand = fc
	.record({
		startHz: fc.integer({ min: 1, max: 280 }),
		span: fc.integer({ min: 1, max: 80 }),
		hidden: fc.boolean(),
	})
	.map(value => ({
		startHz: value.startHz,
		endHz: Math.min(400, value.startHz + value.span),
		hidden: value.hidden,
	}))

const arbWorld = fc
	.record({
		operatorCount: fc.integer({ min: 0, max: 2 }),
		layerCount: fc.integer({ min: 1, max: 3 }),
		perLayer: fc.integer({ min: 1, max: 3 }),
		seed: fc.array(arbBand, { minLength: 12, maxLength: 12 }),
		disabledAt: fc.integer({ min: 0, max: 2 }),
	})
	.map(value => {
		let cursor = 0
		const take = () => {
			const next = value.seed[cursor]!
			cursor += 1
			return next
		}
		const operator: WorldBand[] = []
		for (let index = 0; index < value.operatorCount; index += 1)
			operator.push({ id: `op-${index}`, ...take(), hidden: false })
		const layers: WorldLayer[] = []
		for (let index = 0; index < value.layerCount; index += 1) {
			const bands: WorldBand[] = []
			for (let bandIndex = 0; bandIndex < value.perLayer; bandIndex += 1)
				bands.push({ id: `b-${bandIndex}`, ...take() })
			layers.push({
				packId: `imported-${index.toString(16).padStart(12, "0")}`,
				enabled: index !== value.disabledAt,
				bands,
			})
		}
		return { operator, layers }
	})

describe("resolver properties", () => {
	// Feature: band-plans, Property 1: Resolver determinism
	// Validates: Requirements 4.6, 5.6
	it("is deterministic, total on schema-valid state, and does not mutate input", () => {
		fc.assert(
			fc.property(arbWorld, world => {
				const input = worldInput(world.layers, world.operator)
				const before = structuredClone(input)
				const forward = resolve(input)
				const reversed = new Map(
					[...input.packs.entries()].reverse(),
				)
				const backward = resolve({ ...input, packs: reversed })
				expect(backward).toEqual(forward)
				expect(input).toEqual(before)
				for (const item of forward.bands) {
					expect(item.segments.length).toBeGreaterThan(0)
					expect(item.band.startHz).toBeLessThan(item.band.endHz)
				}
			}),
			{ numRuns: 100 },
		)
		const state: BandPlanState = bandPlanStateSchema.parse({
			version: 1,
			storeId: "00000000-0000-4000-8000-0000000000aa",
			revision: 0,
			stack: null,
			importedPacks: [],
			operatorBands: [],
			edits: [
				{
					packId: "builtin-eu",
					bandId: "airband",
					set: { name: "Renamed" },
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
			presets: [],
		})
		const packs = new Map(projectBuiltinPacks().map(item => [item.id, item]))
		expect(() =>
			resolve({
				packs,
				stack: [{ packId: builtinPackIdFor("EU"), enabled: true }],
				operatorBands: state.operatorBands,
				edits: state.edits,
			}),
		).not.toThrow()
	})

	// Feature: band-plans, Property 2: Precedence
	// Validates: Requirements 4.3, 4.4
	it("keeps a lower segment out of every higher visible range", () => {
		fc.assert(
			fc.property(arbWorld, world => {
				const input = worldInput(world.layers, world.operator)
				const resolved = resolve(input)
				const higher = visibleRanges(input)
				for (const item of resolved.bands)
					for (const segment of item.segments)
						for (const range of higher)
							if (range.layer < item.layer)
								expect(overlaps(segment, range)).toBe(false)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: band-plans, Property 3: Fall-through
	// Validates: Requirements 4.1, 4.4, 5.8
	it("covers exactly the visible ranges, and disabling an entry equals removing it", () => {
		fc.assert(
			fc.property(arbWorld, world => {
				const input = worldInput(world.layers, world.operator)
				const resolved = resolve(input)
				expect(merge(resolved.bands.flatMap(item => [...item.segments]))).toEqual(
					merge(visibleRanges(input)),
				)
				if (world.layers.length === 0) return
				const index = 0
				const disabled = world.layers.map((layer, layerIndex) =>
					layerIndex === index ? { ...layer, enabled: false } : layer,
				)
				const removed = world.layers.filter((_, layerIndex) => layerIndex !== index)
				expect(resolve(worldInput(disabled, world.operator))).toEqual(
					resolve(worldInput(removed, world.operator)),
				)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: band-plans, Property 4: Segment shape
	// Validates: Requirements 4.4, 4.5
	it("emits nonempty sorted disjoint segments inside the band and keeps same-layer overlaps", () => {
		fc.assert(
			fc.property(arbWorld, world => {
				const input = worldInput(world.layers, world.operator)
				const resolved = resolve(input)
				for (const item of resolved.bands) {
					let previous = 0
					for (const segment of item.segments) {
						expect(segment.startHz).toBeLessThanOrEqual(segment.endHz)
						expect(segment.startHz).toBeGreaterThanOrEqual(item.band.startHz)
						expect(segment.endHz).toBeLessThanOrEqual(item.band.endHz)
						expect(segment.startHz).toBeGreaterThan(previous)
						previous = segment.endHz
					}
				}
				const sameLayer = new Map<number, ResolvedBand[]>()
				for (const item of resolved.bands) {
					const list = sameLayer.get(item.layer) ?? []
					list.push(item)
					sameLayer.set(item.layer, list)
				}
				for (const group of sameLayer.values()) {
					for (let left = 0; left < group.length; left += 1) {
						for (let right = left + 1; right < group.length; right += 1) {
							const a = group[left]!
							const b = group[right]!
							const start = Math.max(a.band.startHz, b.band.startHz)
							const end = Math.min(a.band.endHz, b.band.endHz)
							if (start > end) continue
							const coveredHigher = visibleRanges(input).some(
								range =>
									range.layer < a.layer &&
									range.startHz <= start &&
									range.endHz >= start,
							)
							if (coveredHigher) continue
							expect(contains(a.segments, start)).toBe(true)
							expect(contains(b.segments, start)).toBe(true)
						}
					}
				}
			}),
			{ numRuns: 100 },
		)
	})
})
