import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	BANDPLAN_SCANNER_PROTOCOLS,
	operatorScanPresetSchema,
	scanPresetJobSchema,
} from "@wavekit/api-types"
import type {
	BandRegion,
	OperatorScanPreset,
	ScanJobSpec,
	ScanPreset,
	ScanPresetJob,
} from "@wavekit/api-types"
import { scanJobSpecSchema } from "../../../../src/api/routes/scanner-schemas.js"
import {
	builtinPresetsFor,
	presetIssuesFor,
	presetToJobSpec,
} from "../../../../src/core/bandplans/presets.js"
import {
	bandplansFor,
	resolveBandplan,
} from "../../../../src/core/scanner/bandplan/index.js"

const REGIONS = ["EU", "US", "CA", "AU", "NZ", "JP", "CN"] as const
const COMBINATIONS = [
	{
		id: "builtin-combo-ism-srd",
		name: "ISM / SRD",
		planIds: ["ism-433", "ism-868", "ism-169"],
	},
	{
		id: "builtin-combo-personal-radio",
		name: "Personal radio",
		planIds: ["pmr446", "dpmr446", "cb"],
	},
	{
		id: "builtin-combo-land-mobile-marine",
		name: "Land mobile + Marine",
		planIds: ["vhf-land-mobile", "marine-vhf"],
	},
] as const

let app: FastifyInstance
let validateJob: (data: unknown) => boolean
let jobErrors: () => unknown

beforeAll(async () => {
	app = Fastify({ logger: false })
	// Registering a body schema builds Fastify's Ajv compiler (it stays lazy until then).
	app.post(
		"/api/scanner/jobs",
		{ schema: { body: scanJobSpecSchema } },
		async () => ({}),
	)
	await app.ready()
	const compile = app.validatorCompiler
	if (!compile) throw new Error("Fastify validator compiler missing")
	const validate = compile({
		schema: scanJobSpecSchema,
		method: "POST",
		url: "/api/scanner/jobs",
		httpPart: "body",
	})
	validateJob = data => {
		const result = validate(structuredClone(data))
		return result === true
	}
	jobErrors = () => validate.errors
	await app.ready()
})

afterAll(async () => {
	await app.close()
})

function assertAccepted(spec: ScanJobSpec): void {
	if (validateJob(spec)) return
	throw new Error(
		`scanJobSpecSchema rejected ${JSON.stringify(spec)} ${JSON.stringify(jobErrors())}`,
	)
}

const slugUnit = fc.constantFrom(
	..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
)
const arbSlug = fc
	.string({ minLength: 1, maxLength: 12, unit: slugUnit })
	.filter(value => /^[a-z]/.test(value))
const arbBandplanId = fc.oneof(
	arbSlug,
	fc.constantFrom("airband", "pmr446", "marine-vhf", "ism-433", "not-a-plan"),
)
const arbProtocol = fc.constantFrom(...BANDPLAN_SCANNER_PROTOCOLS)
const arbName = fc.string({
	minLength: 1,
	maxLength: 40,
	unit: fc.constantFrom(
		..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(
			"",
		),
	),
})
const arbRange = fc
	.record({
		startHz: fc.integer({ min: 1, max: 1_000_000_000 }),
		endHz: fc.integer({ min: 1, max: 1_000_000_000 }),
		rasters: fc.array(
			fc.record({
				spacingHz: fc.integer({ min: 1, max: 1_000_000 }),
				firstChannelHz: fc.integer({ min: 0, max: 1_000_000_000 }),
			}),
			{ maxLength: 2 },
		),
		obwHz: fc.array(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 2 }),
		protocols: fc.array(arbProtocol, { maxLength: 3 }),
	})
	.filter(range => range.startHz < range.endHz)
const arbExclusion = fc
	.record({
		startHz: fc.integer({ min: 1, max: 1_000_000_000 }),
		endHz: fc.integer({ min: 1, max: 1_000_000_000 }),
		reason: fc.option(arbName, { nil: null }),
	})
	.filter(exclusion => exclusion.startHz <= exclusion.endHz)
const arbNullableInt = (min: number, max: number) =>
	fc.option(fc.integer({ min, max }), { nil: null })
const arbJobFields = {
	mode: fc.constantFrom<ScanPresetJob["mode"]>(
		null,
		"in-window",
		"sweep",
		"auto",
	),
	exclusions: fc.array(arbExclusion, { maxLength: 2 }),
	protocols: fc.uniqueArray(arbProtocol, { maxLength: 4 }),
	sensitivity: fc.constantFrom<ScanPresetJob["sensitivity"]>(
		null,
		"low",
		"normal",
		"high",
	),
	thresholdDb: arbNullableInt(0, 40),
	fftSize: fc.constantFrom<ScanPresetJob["fftSize"]>(
		null,
		512,
		1024,
		2048,
		4096,
		8192,
		16384,
	),
	integrationMs: arbNullableInt(5, 1000),
	dwellMs: arbNullableInt(10, 60_000),
	settleMs: arbNullableInt(0, 10_000),
}
const arbJob = fc
	.oneof(
		fc.record({
			...arbJobFields,
			bandplans: fc.uniqueArray(arbBandplanId, { minLength: 1, maxLength: 4 }),
			ranges: fc.array(arbRange, { maxLength: 2 }),
		}),
		fc.record({
			...arbJobFields,
			bandplans: fc.uniqueArray(arbBandplanId, { maxLength: 4 }),
			ranges: fc.array(arbRange, { minLength: 1, maxLength: 2 }),
		}),
	)
	.map(job => scanPresetJobSchema.parse(job))
const arbTimestamp = fc
	.integer({ min: 0, max: 2_000_000_000_000 })
	.map(ms => new Date(ms).toISOString())
const arbOperatorPreset: fc.Arbitrary<OperatorScanPreset> = fc
	.record({
		kind: fc.constant("operator" as const),
		id: fc.uuid(),
		name: arbName,
		job: arbJob,
		createdAt: arbTimestamp,
		updatedAt: arbTimestamp,
	})
	.map(preset => operatorScanPresetSchema.parse(preset))

function unresolved(preset: ScanPreset, region: BandRegion): string[] {
	return preset.job.bandplans.filter(
		id => resolveBandplan(id, region) === undefined,
	)
}

describe("band-plan presets", () => {
	it("rejects a job the scanner schema does not accept", () => {
		expect(validateJob({ mode: "sideways" })).toBe(false)
		expect(validateJob({ fftSize: 100 })).toBe(false)
		expect(validateJob({ ranges: [{ startHz: 1 }] })).toBe(false)
	})

	it("builds one preset per regional plan, then the fixed combinations", () => {
		for (const region of REGIONS) {
			const plans = bandplansFor(region)
			const before = structuredClone(plans)
			const presets = builtinPresetsFor(region)
			expect(bandplansFor(region)).toEqual(before)
			expect(presets.slice(0, plans.length).map(preset => preset.id)).toEqual(
				plans.map(plan => `builtin-${plan.id}`),
			)
			expect(presets.slice(0, plans.length).map(preset => preset.name)).toEqual(
				plans.map(plan => plan.name),
			)
			expect(presets.map(preset => preset.kind)).toEqual(
				presets.map(() => "builtin"),
			)
			expect(presets.map(preset => preset.region)).toEqual(
				presets.map(() => region),
			)
			expect(new Set(presets.map(preset => preset.id)).size).toBe(
				presets.length,
			)
			for (const preset of presets.slice(0, plans.length)) {
				expect(preset.job).toEqual({
					mode: null,
					bandplans: [preset.id.slice("builtin-".length)],
					ranges: [],
					exclusions: [],
					protocols: [],
					sensitivity: null,
					thresholdDb: null,
					fftSize: null,
					integrationMs: null,
					dwellMs: null,
					settleMs: null,
				})
				expect(scanPresetJobSchema.parse(preset.job)).toEqual(preset.job)
			}
			const combos = presets.slice(plans.length)
			expect(combos.map(preset => preset.id)).toEqual(
				COMBINATIONS.flatMap(combo => {
					const ids = combo.planIds.filter(
						id => resolveBandplan(id, region) !== undefined,
					)
					return ids.length >= 2 ? [combo.id] : []
				}),
			)
			for (const combo of combos) {
				expect(combo.job.bandplans.length).toBeGreaterThanOrEqual(2)
				expect(combo.name).toBe(
					COMBINATIONS.find(item => item.id === combo.id)?.name,
				)
			}
		}
		const eu = builtinPresetsFor("EU").filter(preset =>
			preset.id.startsWith("builtin-combo-"),
		)
		expect(eu.map(preset => [preset.id, preset.job.bandplans])).toEqual([
			["builtin-combo-ism-srd", ["ism-433", "ism-868", "ism-169"]],
			["builtin-combo-personal-radio", ["pmr446", "dpmr446", "cb"]],
			["builtin-combo-land-mobile-marine", ["vhf-land-mobile", "marine-vhf"]],
		])
		for (const region of ["US", "CA", "AU", "NZ", "JP", "CN"] as const) {
			const combos = builtinPresetsFor(region).filter(preset =>
				preset.id.startsWith("builtin-combo-"),
			)
			expect(combos.map(preset => [preset.id, preset.job.bandplans])).toEqual([
				["builtin-combo-land-mobile-marine", ["vhf-land-mobile", "marine-vhf"]],
			])
		}
	})

	it("omits null and empty top-level fields and keeps full ranges", () => {
		const plan = bandplansFor("EU")[0]
		const first = builtinPresetsFor("EU")[0]
		if (!plan || !first) throw new Error("EU bandplans missing")
		expect(presetToJobSpec(first)).toEqual({
			name: plan.name,
			bandplans: [plan.id],
		})
		const preset = operatorScanPresetSchema.parse({
			kind: "operator",
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			name: "Watch",
			createdAt: "2026-10-13T00:00:00.000Z",
			updatedAt: "2026-10-13T00:00:00.000Z",
			job: {
				mode: "sweep",
				bandplans: ["marine-vhf", "not-a-plan", "airband"],
				ranges: [
					{
						startHz: 156_000_000,
						endHz: 162_000_000,
						rasters: [],
						obwHz: [],
						protocols: [],
					},
				],
				exclusions: [
					{ startHz: 161_000_000, endHz: 162_000_000, reason: null },
					{
						startHz: 156_000_000,
						endHz: 156_100_000,
						reason: "guard band",
					},
				],
				protocols: [],
				sensitivity: "high",
				thresholdDb: null,
				fftSize: 4096,
				integrationMs: null,
				dwellMs: 50,
				settleMs: null,
			},
		})
		const frozen = structuredClone(preset)
		const spec = presetToJobSpec(preset)
		expect(preset).toEqual(frozen)
		expect(spec).toEqual({
			name: "Watch",
			mode: "sweep",
			bandplans: ["marine-vhf", "not-a-plan", "airband"],
			ranges: [
				{
					startHz: 156_000_000,
					endHz: 162_000_000,
					rasters: [],
					obwHz: [],
					protocols: [],
				},
			],
			exclusions: [
				{ startHz: 161_000_000, endHz: 162_000_000 },
				{
					startHz: 156_000_000,
					endHz: 156_100_000,
					reason: "guard band",
				},
			],
			sensitivity: "high",
			fftSize: 4096,
			dwellMs: 50,
		})
		expect(spec.kind).toBeUndefined()
		expect(spec.sourceId).toBeUndefined()
		expect(spec.tuner).toBeUndefined()
		spec.bandplans?.push("mutated")
		expect(preset.job.bandplans).toEqual([
			"marine-vhf",
			"not-a-plan",
			"airband",
		])
		assertAccepted(spec)
		expect(presetIssuesFor(preset, "EU")).toEqual([
			{ code: "unknown-bandplan", bandplanId: "not-a-plan" },
		])
		expect(presetIssuesFor(preset, "US")).toEqual([
			{ code: "unknown-bandplan", bandplanId: "not-a-plan" },
			{ code: "unknown-bandplan", bandplanId: "airband" },
		])
		expect(presetIssuesFor(preset, "AU")).toEqual([
			{ code: "unknown-bandplan", bandplanId: "not-a-plan" },
			{ code: "unknown-bandplan", bandplanId: "airband" },
		])
	})

	it("maps every built-in and operator preset to a valid scanner job", () => {
		// Feature: band-plans, Property 13: Preset to job validity
		// Validates: Requirements 7.1, 7.2, 7.3, 7.4
		for (const region of REGIONS) {
			for (const preset of builtinPresetsFor(region)) {
				assertAccepted(presetToJobSpec(preset))
				expect(unresolved(preset, region)).toEqual([])
				expect(presetIssuesFor(preset, region)).toEqual([])
				for (const id of preset.job.bandplans)
					expect(resolveBandplan(id, region)?.id).toBe(id)
			}
		}
		fc.assert(
			fc.property(
				arbOperatorPreset,
				fc.constantFrom(...REGIONS),
				(preset, region) => {
					const spec = presetToJobSpec(preset)
					assertAccepted(spec)
					expect(spec.name).toBe(preset.name)
					expect(spec.kind).toBeUndefined()
					expect(spec.sourceId).toBeUndefined()
					expect(spec.tuner).toBeUndefined()
					if (preset.job.bandplans.length === 0)
						expect(spec.bandplans).toBeUndefined()
					else expect(spec.bandplans).toEqual([...preset.job.bandplans])
					if (preset.job.ranges.length === 0)
						expect(spec.ranges).toBeUndefined()
					else expect(spec.ranges).toHaveLength(preset.job.ranges.length)
					expect(presetIssuesFor(preset, region)).toEqual(
						unresolved(preset, region).map(bandplanId => ({
							code: "unknown-bandplan",
							bandplanId,
						})),
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("judges preset ids against the effective scanner list when it is supplied", () => {
		// Feature: band-plans, Property 19: Preset applicability
		// Validates: Requirements 11.6, 7.3
		const watch: ScanPreset = {
			kind: "operator",
			id: "00000000-0000-4000-8000-0000000000aa",
			name: "Watch",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			job: {
				mode: null,
				bandplans: ["airband", "not-a-plan", "pmr446"],
				ranges: [],
				exclusions: [],
				protocols: [],
				sensitivity: null,
				thresholdDb: null,
				fftSize: null,
				integrationMs: null,
				dwellMs: null,
				settleMs: null,
			},
		}
		const present = new Set(["not-a-plan", "pmr446"])
		expect(presetIssuesFor(watch, "EU", present)).toEqual([
			{ code: "unknown-bandplan", bandplanId: "airband" },
		])
		expect(presetIssuesFor(watch, "EU", new Set(["not-a-plan"]))).toEqual([
			{ code: "unknown-bandplan", bandplanId: "airband" },
			{ code: "unknown-bandplan", bandplanId: "pmr446" },
		])
		expect(presetIssuesFor(watch, "EU", new Set())).toEqual([
			{ code: "unknown-bandplan", bandplanId: "airband" },
			{ code: "unknown-bandplan", bandplanId: "not-a-plan" },
			{ code: "unknown-bandplan", bandplanId: "pmr446" },
		])
		expect(presetIssuesFor(watch, "EU")).toEqual([
			{ code: "unknown-bandplan", bandplanId: "not-a-plan" },
		])
		expect(presetIssuesFor(watch, "US")).toEqual([
			{ code: "unknown-bandplan", bandplanId: "airband" },
			{ code: "unknown-bandplan", bandplanId: "not-a-plan" },
			{ code: "unknown-bandplan", bandplanId: "pmr446" },
		])
		for (const region of REGIONS) {
			const known = new Set(bandplansFor(region).map(plan => plan.id))
			for (const preset of builtinPresetsFor(region)) {
				expect(presetIssuesFor(preset, region)).toEqual([])
				expect(presetIssuesFor(preset, region, known)).toEqual([])
				const dropped = new Set(
					[...known].filter(id => id !== preset.job.bandplans[0]),
				)
				expect(presetIssuesFor(preset, region, dropped)).toEqual(
					preset.job.bandplans
						.filter(id => !dropped.has(id))
						.map(bandplanId => ({ code: "unknown-bandplan", bandplanId })),
				)
			}
		}
		fc.assert(
			fc.property(
				arbOperatorPreset,
				fc.constantFrom(...REGIONS),
				fc.uniqueArray(arbBandplanId, { maxLength: 6 }),
				(preset, region, ids) => {
					const effective = new Set(ids)
					expect(presetIssuesFor(preset, region, effective)).toEqual(
						preset.job.bandplans
							.filter(id => !effective.has(id))
							.map(bandplanId => ({ code: "unknown-bandplan", bandplanId })),
					)
					expect(presetIssuesFor(preset, region)).toEqual(
						unresolved(preset, region).map(bandplanId => ({
							code: "unknown-bandplan",
							bandplanId,
						})),
					)
					expect(
						presetIssuesFor(preset, region, new Set()).map(
							issue => issue.bandplanId,
						),
					).toEqual([...preset.job.bandplans])
				},
			),
			{ numRuns: 100 },
		)
	})
})
