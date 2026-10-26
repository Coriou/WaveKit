import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { BandRegion, DisplayGroup } from "@wavekit/api-types"
import { bandplansFor } from "../../../../src/core/scanner/bandplan/index.js"
import { BUILTIN_BANDPLANS } from "../../../../src/core/scanner/bandplan/builtin.js"
import {
	builtinGroupFor,
	builtinPackIdFor,
	projectBuiltinPacks,
} from "../../../../src/core/bandplans/builtin-packs.js"

const REGIONS = ["EU", "US", "CA", "AU", "NZ", "JP", "CN"] as const satisfies readonly BandRegion[]
const GROUPS: Record<string, DisplayGroup> = {
	airband: "air",
	cb: "personal-radio",
	pmr446: "personal-radio",
	dpmr446: "personal-radio",
	"ism-169": "ism-srd",
	"ism-433": "ism-srd",
	"ism-868": "ism-srd",
	"pager-vhf": "pagers",
	// Added the French paging plan to builtin.ts.
	"pager-fr": "pagers",
	"vhf-land-mobile": "land-mobile",
	"uhf-land-mobile": "land-mobile",
	"amateur-2m": "amateur",
	"amateur-70cm": "amateur",
	aprs: "amateur",
	"marine-vhf": "marine",
}

describe("built-in pack projection", () => {
	it("projects one frozen pack per region, in order, from bandplansFor", () => {
		const packs = projectBuiltinPacks()
		expect(packs).toBe(projectBuiltinPacks())
		expect(packs.map(pack => pack.region)).toEqual([...REGIONS])
		for (const pack of packs) {
			expect(Object.isFrozen(pack)).toBe(true)
			expect(pack.kind).toBe("builtin")
			expect(pack.provenance).toEqual({ kind: "builtin" })
			expect(pack.id).toBe(builtinPackIdFor(pack.region!))
			expect(pack.name).toBe(`Built-in (${pack.region})`)
			const plans = bandplansFor(pack.region!)
			expect(pack.bands.map(band => band.id)).toEqual(plans.map(plan => plan.id))
			for (const [index, band] of pack.bands.entries()) {
				const plan = plans[index]!
				expect(Object.isFrozen(band)).toBe(true)
				expect(band.name).toBe(plan.name)
				expect(band.mode).toBeNull()
				expect(band.bandwidthHz).toBeNull()
				expect(band.stepHz).toBeNull()
				expect(band.skip).toBeNull()
				expect(band.channels).toEqual([])
				expect(band.parentId).toBeNull()
				expect(band.colourHint).toBeNull()
				expect(band.registryRef).toBeNull()
				expect(band.group).toBe(GROUPS[plan.id])
				expect(band.scan?.bandplanId).toBe(plan.id)
				expect(band.scan?.ranges).toEqual(plan.ranges)
				expect(band.scan?.ranges[0]).not.toBe(plan.ranges[0])
				expect(Object.isFrozen(band.scan?.ranges[0])).toBe(true)
				const starts = plan.ranges.map(range => range.startHz)
				const ends = plan.ranges.map(range => range.endHz)
				expect(band.startHz).toBe(Math.min(...starts))
				expect(band.endHz).toBe(Math.max(...ends))
				expect(band.startHz).toBeLessThan(band.endHz)
			}
		}
	})

	it("cites only the EU variant documents transcribed from builtin.ts", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "../../../../src/core/scanner/bandplan/builtin.ts"),
			"utf8",
		)
		const eu = projectBuiltinPacks().find(pack => pack.region === "EU")!
		const cited = new Map(
			eu.bands
				.filter(band => band.provenance.kind === "builtin-cited")
				.map(band => [band.id, band.provenance]),
		)
		expect([...cited.keys()].sort()).toEqual(
			["airband", "cb", "dpmr446", "ism-169", "pager-vhf", "pmr446"].sort(),
		)
		const air = cited.get("airband")
		expect(air?.kind).toBe("builtin-cited")
		if (air?.kind === "builtin-cited") expect(air.citations).toHaveLength(2)
		for (const provenance of cited.values()) {
			if (provenance.kind !== "builtin-cited") continue
			for (const citation of provenance.citations) {
				expect(source).toContain(citation.title)
				expect(source).toContain(citation.url)
			}
		}
		for (const pack of projectBuiltinPacks()) {
			if (pack.region === "EU") continue
			for (const band of pack.bands)
				expect(band.provenance).toEqual({ kind: "builtin" })
		}
		const usPager = projectBuiltinPacks()
			.find(pack => pack.region === "US")!
			.bands.find(band => band.id === "pager-vhf")
		expect(usPager?.provenance).toEqual({ kind: "builtin" })
	})

	it("does not freeze or rewrite scanner plan objects", () => {
		const before = bandplansFor("EU").map(plan => structuredClone(plan.ranges))
		projectBuiltinPacks()
		const after = bandplansFor("EU")
		expect(after.map(plan => plan.ranges)).toEqual(before)
		expect(Object.isFrozen(after[0]?.ranges[0])).toBe(false)
	})

	it("maps every current plan id explicitly and unknown ids to other", () => {
		const ids = new Set(BUILTIN_BANDPLANS.map(plan => plan.id))
		expect(new Set(Object.keys(GROUPS))).toEqual(ids)
		for (const id of ids) expect(builtinGroupFor(id)).toBe(GROUPS[id])
		expect(builtinGroupFor("not-a-plan")).toBe("other")
		expect(builtinGroupFor("marine")).toBe("other")
	})

	// Feature: band-plans, Property 14: Projection fidelity
	// Validates: Requirements 1.3, 2.1, 2.2, 2.3, 2.4
	it("keeps scan ranges identical to bandplansFor for every region", () => {
		fc.assert(
			fc.property(fc.constantFrom(...REGIONS), region => {
				const pack = projectBuiltinPacks().find(item => item.region === region)
				const plans = bandplansFor(region)
				expect(pack?.bands).toHaveLength(plans.length)
				for (const [index, plan] of plans.entries()) {
					const band = pack?.bands[index]
					expect(band?.id).toBe(plan.id)
					expect(band?.scan?.ranges).toEqual(plan.ranges)
					expect(band?.scan?.bandplanId).toBe(plan.id)
					expect(GROUPS[plan.id]).toBeDefined()
					expect(band?.group).toBe(builtinGroupFor(plan.id))
					expect(band?.channels).toEqual([])
					expect(band?.mode).toBeNull()
					expect(band?.bandwidthHz).toBeNull()
					expect(band?.stepHz).toBeNull()
				}
			}),
			{ numRuns: 100 },
		)
	})
})
