import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import type {
	Band,
	BandEdit,
	BandPlanPack,
	BandPlanPackSummary,
	BandPlanStackView,
	BandRegion,
	PlanStackEntryView,
} from "@wavekit/api-types"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { projectBuiltinPacks } from "../../../../src/core/bandplans/builtin-packs.js"
import { openBandPlanService } from "../../../../src/core/bandplans/index.js"
import type { BandPlanService } from "../../../../src/core/bandplans/contract.js"
import { resolveScannerBandplans } from "../../../../src/core/bandplans/scanner-feed.js"
import { BAND_REGIONS } from "../../../../src/decoders/band-region.js"
import { bandplansFor } from "../../../../src/core/scanner/bandplan/index.js"
import type { Bandplan } from "../../../../src/core/scanner/bandplan/index.js"

const WHEN = "2026-01-01T00:00:00.000Z"
const PACKS = projectBuiltinPacks()
const directories: string[] = []
const services: BandPlanService[] = []

afterEach(async () => {
	await Promise.all(
		services.splice(0).map(service => service.close().catch(() => undefined)),
	)
	await Promise.all(
		directories
			.splice(0)
			.map(path => rm(path, { recursive: true, force: true })),
	)
})

function summary(pack: BandPlanPack, editCount = 0): BandPlanPackSummary {
	return {
		id: pack.id,
		kind: pack.kind,
		name: pack.name,
		region: pack.region,
		provenance: pack.provenance,
		bandCount: pack.bands.length,
		editCount,
	}
}

function entry(
	pack: BandPlanPackSummary,
	enabled: boolean,
	kind: PlanStackEntryView["kind"] = pack.kind,
): PlanStackEntryView {
	return {
		packId: pack.id,
		enabled,
		kind,
		name: pack.name,
	}
}

const SUMMARIES = PACKS.map(pack => summary(pack))

function packFor(region: BandRegion): BandPlanPackSummary {
	const pack = SUMMARIES.find(item => item.region === region)
	if (!pack) throw new Error(`missing built-in pack ${region}`)
	return pack
}

const IMPORTED: BandPlanPackSummary = {
	id: "imported-0123456789ab",
	kind: "imported",
	name: "Community",
	region: null,
	provenance: {
		kind: "imported",
		trust: "community-unverified",
		format: "sdrpp-json",
		sourceName: "community",
		author: null,
		licence: null,
		importedAt: WHEN,
		sha256: "ab".repeat(32),
	},
	bandCount: 1,
	editCount: 0,
}

const NULL_REGION: BandPlanPackSummary = {
	id: "builtin-eu",
	kind: "builtin",
	name: "Built-in without a region",
	region: null,
	provenance: { kind: "builtin" },
	bandCount: 0,
	editCount: 0,
}

function shadowBand(): Band {
	return {
		id: "airband",
		name: "Operator air",
		startHz: 118_000_000,
		endHz: 137_000_000,
		group: "air",
		mode: null,
		bandwidthHz: null,
		stepHz: null,
		skip: null,
		channels: [],
		parentId: null,
		colourHint: null,
		registryRef: null,
		scan: null,
		provenance: { kind: "operator" },
	}
}

function edit(packId: string, bandId: string, set: BandEdit["set"]): BandEdit {
	return { packId, bandId, set, updatedAt: WHEN }
}

function stackView(init: {
	region?: BandRegion
	store?: BandPlanStackView["store"]
	entries?: readonly PlanStackEntryView[]
	packs?: readonly BandPlanPackSummary[]
	edits?: readonly BandEdit[]
	operatorBands?: readonly Band[]
	source?: BandPlanStackView["stack"]["source"]
	country?: string | null
	orphaned?: BandPlanStackView["orphanedEdits"]
}): BandPlanStackView {
	const region = init.region ?? "EU"
	const packs = init.packs ?? SUMMARIES
	return {
		schemaVersion: 1,
		store: init.store ?? { state: "unavailable" },
		context: { region, effectiveCountry: init.country ?? null },
		capabilities: { writable: false, importFormats: [] },
		stack: {
			source: init.source ?? "default",
			entries: init.entries ?? [entry(packFor(region), true)],
		},
		packs,
		operatorBands: init.operatorBands ?? [],
		edits: init.edits ?? [],
		orphanedEdits: init.orphaned ?? [],
		limits: BANDPLANS_LIMITS,
	}
}

function identities(region: BandRegion): readonly Bandplan[] {
	return bandplansFor(region)
}

function expectPlans(
	actual: readonly Bandplan[],
	expected: readonly Bandplan[],
): void {
	expect(actual).toStrictEqual(expected)
	expect(actual).toHaveLength(expected.length)
	for (let index = 0; index < expected.length; index += 1)
		expect(actual[index]).toBe(expected[index])
}

/** Design steps, written out so the property is not the implementation. */
function feedByDesign(view: BandPlanStackView): readonly Bandplan[] {
	const regionByPack = new Map<string, BandRegion>()
	const seenPack = new Set<string>()
	for (const pack of view.packs) {
		if (seenPack.has(pack.id)) continue
		seenPack.add(pack.id)
		if (pack.kind === "builtin" && pack.region !== null)
			regionByPack.set(pack.id, pack.region)
	}
	const hidden = new Set(
		view.edits
			.filter(item => item.set.hidden === true)
			.map(item => `${item.packId}/${item.bandId}`),
	)
	const emitted = new Set<string>()
	const plans: Bandplan[] = []
	for (const item of view.stack.entries) {
		if (!item.enabled) continue
		const region = regionByPack.get(item.packId)
		if (region === undefined) continue
		for (const plan of bandplansFor(region)) {
			if (hidden.has(`${item.packId}/${plan.id}`)) continue
			if (emitted.has(plan.id)) continue
			emitted.add(plan.id)
			plans.push(plan)
		}
	}
	return plans
}

function noiseFree(view: BandPlanStackView): BandPlanStackView {
	const builtin = new Map(
		view.packs
			.filter(pack => pack.kind === "builtin" && pack.region !== null)
			.map(pack => [pack.id, pack]),
	)
	return {
		...view,
		store: { state: "unavailable" },
		context: { ...view.context, effectiveCountry: "ZZ" },
		stack: {
			source: view.stack.source === "default" ? "operator" : "default",
			entries: view.stack.entries
				.filter(item => item.enabled && builtin.has(item.packId))
				.map(item => ({
					...item,
					kind: "builtin" as const,
					name: "normalised",
				})),
		},
		packs: [...view.packs].reverse().map(pack => ({
			...pack,
			name: `${pack.name} noise`,
			editCount: pack.editCount + 7,
			bandCount: pack.bandCount + 3,
		})),
		operatorBands: view.operatorBands.length > 0 ? [] : [shadowBand()],
		edits: view.edits.filter(item => item.set.hidden === true),
		orphanedEdits:
			view.orphanedEdits.length > 0
				? []
				: [{ packId: "builtin-eu", bandId: "airband" }],
	}
}

const STORES: readonly BandPlanStackView["store"][] = [
	{ state: "unavailable" },
	{ state: "available", storeId: null, revision: 0 },
	{
		state: "available",
		storeId: "00000000-0000-4000-8000-0000000000aa",
		revision: 4,
	},
]

const arbDraft = fc.record({
	region: fc.constantFrom(...BAND_REGIONS),
	enabled: fc.boolean(),
	mislabel: fc.boolean(),
	hiddenAt: fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 3 }),
})

const arbView: fc.Arbitrary<BandPlanStackView> = fc
	.record({
		drafts: fc.array(arbDraft, { maxLength: BAND_REGIONS.length }),
		imported: fc.integer({ min: 0, max: 2 }),
		importedFirst: fc.boolean(),
		unknown: fc.boolean(),
		nullRegion: fc.boolean(),
		operator: fc.boolean(),
		skip: fc.boolean(),
		rename: fc.boolean(),
		hiddenFalse: fc.boolean(),
		country: fc.option(fc.constant("GB"), { nil: null }),
		source: fc.constantFrom("default" as const, "operator" as const),
		contextRegion: fc.constantFrom(...BAND_REGIONS),
	})
	.map(sample => {
		const seen = new Set<BandRegion>()
		const drafts = sample.drafts.filter(draft => {
			if (seen.has(draft.region)) return false
			seen.add(draft.region)
			return true
		})
		const packs = [...SUMMARIES]
		if (sample.nullRegion) packs.push({ ...NULL_REGION, id: "builtin-null" })
		const entries: PlanStackEntryView[] = []
		const edits: BandEdit[] = []
		if (sample.importedFirst && sample.imported > 0) {
			packs.push(IMPORTED)
			entries.push(entry(IMPORTED, true))
		}
		for (const draft of drafts) {
			const pack = packFor(draft.region)
			entries.push(
				entry(pack, draft.enabled, draft.mislabel ? "imported" : pack.kind),
			)
			const plans = bandplansFor(draft.region)
			for (const index of draft.hiddenAt) {
				const plan = plans[index % plans.length]
				if (!plan) continue
				edits.push(edit(pack.id, plan.id, { hidden: true }))
			}
		}
		for (let index = 0; index < sample.imported; index += 1) {
			const imported: BandPlanPackSummary = {
				...IMPORTED,
				id: `imported-${index.toString(16).padStart(12, "0")}`,
				name: `Community ${index}`,
			}
			packs.push(imported)
			if (!(sample.importedFirst && index === 0))
				entries.push(entry(imported, index % 2 === 0))
		}
		if (sample.unknown)
			entries.push({
				packId: "missing-pack",
				enabled: true,
				kind: "builtin",
				name: "missing",
			})
		const region = drafts[0]?.region ?? "EU"
		const pack = packFor(region)
		const target = bandplansFor(region)[0]
		if (sample.skip && target)
			edits.push(edit(pack.id, target.id, { skip: { reason: "display only" } }))
		if (sample.rename && target)
			edits.push(edit(pack.id, target.id, { name: "Renamed" }))
		if (sample.hiddenFalse && target)
			edits.push(edit(pack.id, target.id, { hidden: false }))
		return stackView({
			region: sample.contextRegion,
			source: sample.source,
			country: sample.country,
			packs,
			entries,
			edits,
			operatorBands: sample.operator ? [shadowBand()] : [],
			store: sample.operator
				? { state: "unavailable" }
				: {
						state: "available",
						storeId: "00000000-0000-4000-8000-0000000000bb",
						revision: 2,
					},
		})
	})

describe("scanner bandplan feed", () => {
	it("matches bandplansFor for a default stack in every region", async () => {
		// Feature: band-plans, Property 16: Default scanner parity
		// Validates: Requirements 11.2, 11.4, 1.1
		fc.assert(
			fc.property(fc.constantFrom(...BAND_REGIONS), region => {
				const expected = identities(region)
				expect(expected.length).toBeGreaterThan(0)
				const before = expected.map(plan => [plan.name, plan.ranges] as const)
				for (const store of STORES) {
					const fed = resolveScannerBandplans(
						stackView({
							region,
							store,
							entries: [entry(packFor(region), true)],
							source: "default",
						}),
					)
					expectPlans(fed, expected)
				}
				const after = identities(region)
				for (let index = 0; index < before.length; index += 1) {
					expect(after[index]?.name).toBe(before[index]?.[0])
					expect(after[index]?.ranges).toBe(before[index]?.[1])
				}
			}),
			{ numRuns: 100 },
		)
		for (const region of BAND_REGIONS) {
			const stateDir = await mkdtemp(join(tmpdir(), "wavekit-bp2-s-"))
			directories.push(stateDir)
			const service = await openBandPlanService({
				stateDir,
				context: { region, effectiveCountry: null },
				writable: false,
			})
			services.push(service)
			const seen = service.view()
			expect(seen.stack.source).toBe("default")
			expect(seen.stack.entries).toEqual([
				expect.objectContaining({
					packId: `builtin-${region.toLowerCase()}`,
					enabled: true,
					kind: "builtin",
				}),
			])
			expectPlans(resolveScannerBandplans(seen), identities(region))
			await service.close()
		}
	})

	it("removes a hidden plan and restores it when the hide is cleared", () => {
		// Feature: band-plans, Property 17: Hidden removal
		// Validates: Requirements 11.1
		const region = "EU"
		const expected = identities(region)
		const target = expected[0]
		if (!target) throw new Error("EU feed is empty")
		const packId = packFor(region).id
		const hidden = stackView({
			region,
			edits: [edit(packId, target.id, { hidden: true, name: "Hidden" })],
		})
		expectPlans(
			resolveScannerBandplans(hidden),
			expected.filter(plan => plan.id !== target.id),
		)
		expect(
			resolveScannerBandplans(hidden).some(plan => plan.id === target.id),
		).toBe(false)
		const unhidden = stackView({
			region,
			edits: [edit(packId, target.id, { hidden: false, name: "Hidden" })],
		})
		expectPlans(resolveScannerBandplans(unhidden), expected)
		expectPlans(
			resolveScannerBandplans(stackView({ region, edits: [] })),
			expected,
		)
	})

	it("lets the higher built-in pack win and falls back when that plan is hidden", () => {
		const eu = identities("EU")
		const us = identities("US")
		const euAmateur = eu.find(plan => plan.id === "amateur-2m")
		const usAmateur = us.find(plan => plan.id === "amateur-2m")
		const euPmr = eu.find(plan => plan.id === "pmr446")
		if (!euAmateur || !usAmateur || !euPmr) throw new Error("missing plans")
		expect(euAmateur).not.toBe(usAmateur)
		expect(us.some(plan => plan.id === "pmr446")).toBe(false)
		const walk = (
			layers: readonly { region: BandRegion; hidden?: readonly string[] }[],
		): Bandplan[] => {
			const emitted = new Set<string>()
			const plans: Bandplan[] = []
			for (const layer of layers) {
				const hidden = new Set(layer.hidden ?? [])
				for (const plan of bandplansFor(layer.region)) {
					if (hidden.has(plan.id) || emitted.has(plan.id)) continue
					emitted.add(plan.id)
					plans.push(plan)
				}
			}
			return plans
		}
		const higherEu = stackView({
			region: "AU",
			source: "operator",
			country: "GB",
			entries: [entry(packFor("EU"), true), entry(packFor("US"), true)],
		})
		expectPlans(
			resolveScannerBandplans(higherEu),
			walk([{ region: "EU" }, { region: "US" }]),
		)
		const higherUs = stackView({
			region: "AU",
			entries: [entry(packFor("US"), true), entry(packFor("EU"), true)],
		})
		expectPlans(
			resolveScannerBandplans(higherUs),
			walk([{ region: "US" }, { region: "EU" }]),
		)
		expect(
			resolveScannerBandplans(higherUs).find(plan => plan.id === "amateur-2m"),
		).toBe(usAmateur)
		const fallback = stackView({
			region: "AU",
			entries: [entry(packFor("US"), true), entry(packFor("EU"), true)],
			edits: [edit(packFor("US").id, "amateur-2m", { hidden: true })],
		})
		expectPlans(
			resolveScannerBandplans(fallback),
			walk([{ region: "US", hidden: ["amateur-2m"] }, { region: "EU" }]),
		)
		expect(
			resolveScannerBandplans(fallback).find(plan => plan.id === "amateur-2m"),
		).toBe(euAmateur)
		expect(
			resolveScannerBandplans(fallback).find(plan => plan.id === "pmr446"),
		).toBe(euPmr)
		const hideLower = stackView({
			region: "AU",
			entries: [entry(packFor("US"), true), entry(packFor("EU"), true)],
			edits: [edit(packFor("EU").id, "amateur-2m", { hidden: true })],
		})
		expect(
			resolveScannerBandplans(hideLower).find(plan => plan.id === "amateur-2m"),
		).toBe(usAmateur)
	})

	it("ignores disabled entries, imports, operator bands and non-hidden edits", () => {
		const eu = identities("EU")
		const disabled = stackView({
			entries: [
				entry(packFor("US"), false),
				entry(IMPORTED, true),
				entry(packFor("EU"), true),
			],
			packs: [...SUMMARIES, IMPORTED],
			operatorBands: [shadowBand()],
			edits: [
				edit(packFor("EU").id, "airband", { skip: { reason: "display only" } }),
				edit(packFor("EU").id, "pmr446", { name: "Renamed" }),
				edit(packFor("EU").id, "marine-vhf", { hidden: false }),
				edit(packFor("US").id, "amateur-2m", { hidden: true }),
			],
			orphaned: [{ packId: "builtin-eu", bandId: "airband" }],
			source: "operator",
			country: "GB",
		})
		expectPlans(resolveScannerBandplans(disabled), eu)
		const mislabeled = stackView({
			entries: [entry(packFor("EU"), true, "imported")],
		})
		expectPlans(resolveScannerBandplans(mislabeled), eu)
		expect(
			resolveScannerBandplans(
				stackView({
					entries: [entry(IMPORTED, true), entry(IMPORTED, true)],
					packs: [IMPORTED],
				}),
			),
		).toEqual([])
		expect(
			resolveScannerBandplans(
				stackView({
					entries: [
						{
							packId: "builtin-null",
							enabled: true,
							kind: "builtin",
							name: "null",
						},
						{
							packId: "missing-pack",
							enabled: true,
							kind: "builtin",
							name: "missing",
						},
					],
					packs: [{ ...NULL_REGION, id: "builtin-null" }],
				}),
			),
		).toEqual([])
		expect(resolveScannerBandplans(stackView({ entries: [] }))).toEqual([])
	})

	it("keeps a total feed over generated stacks", () => {
		// Feature: band-plans, Property 17: Hidden removal
		// Validates: Requirements 11.1
		// Feature: band-plans, Property 18: Feed shape
		// Validates: Requirements 11.1, 11.5
		expect(
			resolveScannerBandplans(undefined as unknown as BandPlanStackView),
		).toEqual([])
		expect(resolveScannerBandplans({} as BandPlanStackView)).toEqual([])
		fc.assert(
			fc.property(arbView, view => {
				const fed = resolveScannerBandplans(view)
				const designed = feedByDesign(view)
				expectPlans(fed, designed)
				expect(new Set(fed.map(plan => plan.id)).size).toBe(fed.length)
				expectPlans(resolveScannerBandplans(noiseFree(view)), fed)
				const restored = {
					...view,
					edits: view.edits.flatMap(item => {
						if (item.set.hidden !== true) return [item]
						const { hidden: _hidden, ...rest } = item.set
						return Object.keys(rest).length > 0 ? [{ ...item, set: rest }] : []
					}),
				}
				expectPlans(resolveScannerBandplans(restored), feedByDesign(restored))
			}),
			{ numRuns: 100 },
		)
	})
})
