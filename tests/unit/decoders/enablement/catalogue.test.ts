import { expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { ConfigSchema, DecoderConfigSchema } from "../../../../src/config.js"
import { LORA_REGION_RANGES_HZ } from "../../../../src/decoders/band-defaults.js"
import { RawOptionsSchema } from "../../../../src/decoders/builtin/lora-meshtastic.js"
import { BAND_REGIONS } from "../../../../src/decoders/band-region.js"
import { CATALOGUE_TYPES } from "../../../../src/decoders/enablement/contract.js"
import {
	buildDecoderCatalogue,
	CATALOGUE_DEFAULT_OPTIONS,
	isCatalogueConfig,
} from "../../../../src/decoders/enablement/catalogue.js"
import { validateDecoderOptions } from "../../../../src/decoders/options/index.js"

const build = (
	configs = [] as ReturnType<typeof DecoderConfigSchema.parse>[],
) => buildDecoderCatalogue(configs, { enabled: true, region: "EU" })
const yaml = (id: string, type: string) =>
	DecoderConfigSchema.parse({ id, type, enabled: false, options: {} })

it("shipped config yields nine entries in catalogue order with id === type", () => {
	const config = ConfigSchema.parse(
		parse(readFileSync("config/default.yaml", "utf8")),
	)
	expect(build(config.decoders).map(c => [c.id, c.type])).toEqual(
		CATALOGUE_TYPES.map(type => [type, type]),
	)
	for (const entry of build())
		expect(DecoderConfigSchema.safeParse(entry).success).toBe(true)
})
it("a YAML decoder of type ais-catcher suppresses the catalogue ais-catcher", () => {
	const entry = yaml("custom", "ais-catcher")
	const result = build([entry])
	expect(result[0]).toBe(entry)
	expect(result.filter(c => c.type === "ais-catcher")).toEqual([entry])
})
it("a YAML decoder with id 'readsb' of type rtl433 suppresses both catalogue readsb and catalogue rtl433", () => {
	const result = build([yaml("readsb", "rtl433")])
	expect(result).toHaveLength(8)
	expect(
		result.slice(1).some(c => c.type === "readsb" || c.type === "rtl433"),
	).toBe(false)
})
it("enabled: false yields the YAML list unchanged", () => {
	const configs = [yaml("custom", "readsb")]
	expect(
		buildDecoderCatalogue(configs, { enabled: false, region: "EU" }),
	).toEqual(configs)
	expect(
		buildDecoderCatalogue(configs, { enabled: false, region: "EU" })[0],
	).toBe(configs[0])
})
it("isCatalogueConfig is true only for derived entries", () => {
	const entry = yaml("custom", "readsb")
	const result = build([entry])
	expect(isCatalogueConfig(entry)).toBe(false)
	for (const derived of result.slice(1)) {
		expect(isCatalogueConfig(derived)).toBe(true)
		expect(isCatalogueConfig({ ...derived })).toBe(false)
	}
})
it("catalogue entries do not appear in the config export", () => {
	const base = ConfigSchema.parse(
		parse(readFileSync("config/default.yaml", "utf8")),
	)
	const exported = {
		...base,
		decoders: build(base.decoders).filter(c => !isCatalogueConfig(c)),
	}
	expect(JSON.stringify(exported)).toBe(JSON.stringify(base))
})
// Validates: Requirements 1.7
it("every catalogue default validates with empty optionIssues", () => {
	for (const region of BAND_REGIONS)
		for (const entry of buildDecoderCatalogue([], { enabled: true, region }))
			expect(validateDecoderOptions(entry.type, entry.options)).toEqual([])
})
it("default options use frozen frequencies and regional LoRa defaults with independent copies", () => {
	const regions = ["EU_868", "US", "US", "ANZ", "ANZ", "JP", "CN"]
	const frequencies = [
		869_525_000, 906_875_000, 906_875_000, 919_875_000, 919_875_000,
		923_375_000, 478_875_000,
	]
	BAND_REGIONS.forEach((region, index) =>
		expect(CATALOGUE_DEFAULT_OPTIONS(region)["lora-meshtastic"]).toEqual({
			region: regions[index],
			preset: "LongFast",
			frequency: frequencies[index],
			channelKey: "AQ==",
		}),
	)
	expect(CATALOGUE_DEFAULT_OPTIONS("EU").acarsdec).toEqual({
		frequencies: [
			131_525_000, 131_550_000, 131_725_000, 131_825_000, 131_850_000,
		],
	})
	expect(CATALOGUE_DEFAULT_OPTIONS("US").acarsdec).toEqual({
		frequencies: [131_550_000, 131_725_000],
	})
	expect(CATALOGUE_DEFAULT_OPTIONS("EU").dumpvdl2).toEqual({
		frequencies: [136_650_000, 136_700_000, 136_975_000],
	})
	const first = build()
	first[2]!.options["frequencies"] = []
	expect(build()[2]!.options).toEqual({
		frequencies: [
			131_525_000, 131_550_000, 131_725_000, 131_825_000, 131_850_000,
		],
	})
})

it("LongFast primary frequency lies inside the mapped LoRa range for every BandRegion", () => {
	const bandwidthHz = 250_000
	const channelHash = [..."LongFast"].reduce(
		(hash, character) => (hash * 33 + character.charCodeAt(0)) >>> 0,
		5381,
	)
	expect(channelHash).toBe(130_429_955)
	for (const region of BAND_REGIONS) {
		const options = RawOptionsSchema.parse(
			CATALOGUE_DEFAULT_OPTIONS(region)["lora-meshtastic"],
		)
		const range = LORA_REGION_RANGES_HZ[options.region]
		const slotCount = Math.floor((range.maxHz - range.minHz) / bandwidthHz)
		expect(options.frequency).toBe(
			range.minHz + bandwidthHz / 2 + (channelHash % slotCount) * bandwidthHz,
		)
		expect(options.frequency).toBeGreaterThanOrEqual(range.minHz)
		expect(options.frequency).toBeLessThanOrEqual(range.maxHz)
	}
})
