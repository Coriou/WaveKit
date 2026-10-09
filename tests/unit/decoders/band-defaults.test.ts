/**
 * Band defaults spec §3.2 / §5.1: the built-in table and the one resolver
 * (precedence and the field-wise override merge).
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	BAND_DEFAULTS,
	LORA_REGION_RANGES_HZ,
	mergeBandOverrides,
	resolveBandRequirements,
	type BandDefault,
	type BandOverrideInput,
} from "../../../src/decoders/band-defaults.js"
import { BAND_REGIONS } from "../../../src/decoders/band-region.js"
import type {
	DecoderBandDeclaration,
	DecoderBandRequirements,
} from "../../../src/decoders/band-resolver.js"
import { LORA_REGIONS } from "../../../src/decoders/builtin/lora-meshtastic.js"
import type { DecoderBandRegion } from "../../../src/decoders/types.js"

const EU: DecoderBandRegion = { code: "EU", source: "default" }

function bandsOf(): Array<[string, BandDefault]> {
	const out: Array<[string, BandDefault]> = []
	for (const [type, entry] of Object.entries(BAND_DEFAULTS)) {
		if (!entry) continue
		if (entry.scope === "all") out.push([type, entry.band])
		else
			for (const region of BAND_REGIONS)
				out.push([`${type}/${region}`, entry.byRegion[region]])
	}
	return out
}

describe("BAND_DEFAULTS", () => {
	it("every row is a valid, non-empty band", () => {
		for (const [name, band] of bandsOf()) {
			const ranges = band.rangesHz ?? []
			const targets = band.targetsHz ?? []
			expect(ranges.length + targets.length, name).toBeGreaterThan(0)
			for (const range of ranges) {
				expect(range.minHz, name).toBeGreaterThan(0)
				expect(range.minHz, name).toBeLessThanOrEqual(range.maxHz)
			}
			for (const target of targets) expect(target, name).toBeGreaterThan(0)
		}
	})

	it("has the spec rows and no multimon-ng entry", () => {
		expect(BAND_DEFAULTS["multimon-ng"]).toBeUndefined()
		expect(BAND_DEFAULTS["readsb"]).toBeUndefined()
		expect(BAND_DEFAULTS["ais-catcher"]).toBeUndefined()
		expect(BAND_DEFAULTS["dumpvdl2"]).toBeUndefined()
		expect(BAND_DEFAULTS["acarsdec"]).toEqual({
			scope: "all",
			band: { rangesHz: [{ minHz: 129_000_000, maxHz: 137_000_000 }] },
		})
		const direwolf = BAND_DEFAULTS["direwolf"]
		expect(direwolf?.scope).toBe("region")
		if (direwolf?.scope === "region") {
			expect(direwolf.byRegion.EU.targetsHz).toEqual([144_800_000, 145_825_000])
			expect(direwolf.byRegion.US.targetsHz).toEqual([144_390_000, 145_825_000])
			expect(direwolf.byRegion.AU.targetsHz).toEqual([145_175_000, 145_825_000])
		}
		const rtl433 = BAND_DEFAULTS["rtl433"]
		if (rtl433?.scope === "region")
			expect(rtl433.byRegion.JP.rangesHz).toEqual([
				{ minHz: 314_000_000, maxHz: 316_000_000 },
				{ minHz: 920_500_000, maxHz: 928_100_000 },
			])
	})

	it("has a Meshtastic range for every LoRa region", () => {
		for (const region of LORA_REGIONS) {
			const range = LORA_REGION_RANGES_HZ[region]
			expect(range.minHz, region).toBeGreaterThan(0)
			expect(range.minHz, region).toBeLessThanOrEqual(range.maxHz)
		}
		expect(LORA_REGION_RANGES_HZ.EU_868).toEqual({
			minHz: 869_400_000,
			maxHz: 869_650_000,
		})
	})
})

describe("resolveBandRequirements", () => {
	it("uses the region row and reports the region for regional defaults", () => {
		const resolved = resolveBandRequirements({
			type: "direwolf",
			declaration: {},
			region: { code: "US", source: "guessed:tz" },
		})
		expect(resolved).toEqual({
			requirements: {
				targetsHz: [144_390_000, 145_825_000],
				basis: "region-default",
				region: { code: "US", source: "guessed:tz" },
			},
			bandSuspension: true,
			region: { code: "US", source: "guessed:tz" },
		})
		// A scope-"all" row carries no region.
		expect(
			resolveBandRequirements({ type: "acarsdec", declaration: {}, region: EU })
				.requirements,
		).toEqual({
			rangesHz: [{ minHz: 129_000_000, maxHz: 137_000_000 }],
			basis: "region-default",
		})
		// A decoder region override selects its own row.
		expect(
			resolveBandRequirements({
				type: "direwolf",
				declaration: {},
				configOverride: { region: "JP" },
				apiOverride: { region: "AU" },
				region: EU,
			}).requirements,
		).toMatchObject({
			targetsHz: [145_175_000, 145_825_000],
			region: { code: "AU", source: "decoder" },
		})
	})

	it("keeps the protocol basis for decoders without a table entry", () => {
		const intrinsic: DecoderBandRequirements = {
			targetsHz: [1_090_000_000],
			basis: "protocol",
		}
		expect(
			resolveBandRequirements({
				type: "readsb",
				declaration: { intrinsic },
				region: EU,
			}).requirements,
		).toEqual(intrinsic)
		expect(
			resolveBandRequirements({
				type: "multimon-ng",
				declaration: {},
				region: EU,
			}).requirements,
		).toBeUndefined()
	})

	const configured: DecoderBandRequirements = {
		targetsHz: [100_000_000],
		basis: "configured",
	}
	const intrinsic: DecoderBandRequirements = {
		targetsHz: [200_000_000],
		basis: "protocol",
	}
	const apiBand: BandOverrideInput = {
		rangesHz: [{ minHz: 300_000_000, maxHz: 301_000_000 }],
	}
	const configBand: BandOverrideInput = { targetsHz: [400_000_000] }

	/** Expected basis per §3.2, first match wins. */
	function expected(layers: {
		ownSource: boolean
		api: boolean
		config: boolean
		configured: boolean
		ownTuning: boolean
		table: boolean
		intrinsic: boolean
	}): string | undefined {
		if (layers.ownSource) return undefined
		if (layers.api) return "override:api"
		if (layers.config) return "override:config"
		if (layers.configured) return "configured"
		if (layers.ownTuning) return undefined
		if (layers.table) return "region-default"
		if (layers.intrinsic) return "protocol"
		return undefined
	}

	function describeResult(
		requirements: DecoderBandRequirements | undefined,
	): string | undefined {
		if (!requirements) return undefined
		return requirements.basis === "override"
			? `override:${requirements.overrideSource ?? "?"}`
			: requirements.basis
	}

	it("resolves the highest present layer; lower layers never matter", () => {
		// Feature: decoder-band-defaults, Property 3: Precedence
		// Validates: §3.2
		const layersArb = fc.record({
			ownSource: fc.boolean(),
			api: fc.boolean(),
			config: fc.boolean(),
			configured: fc.boolean(),
			ownTuning: fc.boolean(),
			table: fc.boolean(),
			intrinsic: fc.boolean(),
		})
		fc.assert(
			fc.property(layersArb, layers => {
				const resolve = (l: typeof layers) => {
					const declaration: DecoderBandDeclaration = {
						...(l.ownSource ? { ownSource: true as const } : {}),
						...(l.ownTuning ? { ownTuning: true as const } : {}),
						...(l.configured ? { configured } : {}),
						...(l.intrinsic ? { intrinsic } : {}),
					}
					return resolveBandRequirements({
						type: l.table ? "acarsdec" : "no-table-entry",
						declaration,
						...(l.api ? { apiOverride: apiBand } : {}),
						...(l.config ? { configOverride: configBand } : {}),
						region: EU,
					}).requirements
				}
				const result = resolve(layers)
				expect(describeResult(result)).toBe(expected(layers))
				if (layers.ownSource) expect(result).toBeUndefined()

				// Removing any layer below the winning one changes nothing.
				const order = [
					"api",
					"config",
					"configured",
					"ownTuning",
					"table",
					"intrinsic",
				] as const
				const winner = order.findIndex(key => layers[key])
				if (winner >= 0)
					for (const key of order.slice(winner + 1))
						expect(resolve({ ...layers, [key]: false })).toEqual(result)
			}),
			{ numRuns: 100 },
		)
	})

	it("merges the API and config layers field-wise", () => {
		// Feature: decoder-band-defaults, Property 4: Field-wise merge
		// Validates: §3.2
		const range = fc
			.tuple(
				fc.integer({ min: 1, max: 1_000_000_000 }),
				fc.integer({ min: 0, max: 1_000_000 }),
			)
			.map(([minHz, width]) => ({ minHz, maxHz: minHz + width }))
		const overrideArb: fc.Arbitrary<BandOverrideInput> = fc.record(
			{
				rangesHz: fc.array(range, { minLength: 1, maxLength: 2 }),
				targetsHz: fc.array(fc.integer({ min: 1, max: 2_000_000_000 }), {
					minLength: 1,
					maxLength: 2,
				}),
				region: fc.constantFrom(...BAND_REGIONS),
				bandSuspension: fc.boolean(),
			},
			{ requiredKeys: [] },
		)
		fc.assert(
			fc.property(
				fc.option(overrideArb, { nil: undefined }),
				fc.option(overrideArb, { nil: undefined }),
				(api, config) => {
					const merged = mergeBandOverrides(api, config)
					const hasBand = (o: BandOverrideInput | undefined) =>
						Boolean(o?.rangesHz?.length || o?.targetsHz?.length)
					const bandFrom = hasBand(api)
						? api
						: hasBand(config)
							? config
							: undefined
					if (bandFrom) {
						expect(merged.bandSource).toBe(bandFrom === api ? "api" : "config")
						// An API list replaces both config lists.
						expect(merged.band?.rangesHz).toEqual(bandFrom.rangesHz)
						expect(merged.band?.targetsHz).toEqual(bandFrom.targetsHz)
					} else expect(merged.band).toBeUndefined()
					expect(merged.region).toBe(api?.region ?? config?.region)
					expect(merged.bandSuspension).toBe(
						api?.bandSuspension ?? config?.bandSuspension,
					)
					const resolved = resolveBandRequirements({
						type: "acarsdec",
						declaration: {},
						apiOverride: api,
						configOverride: config,
						region: EU,
					})
					expect(resolved.bandSuspension).toBe(
						api?.bandSuspension ?? config?.bandSuspension ?? true,
					)
					const region = api?.region ?? config?.region
					expect(resolved.region).toEqual(
						region ? { code: region, source: "decoder" } : EU,
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
