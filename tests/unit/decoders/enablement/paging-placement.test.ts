import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type { PlannerDecoder } from "../../../../src/decoders/enablement/contract.js"
import { MULTIMON_PAGING_MAX_CHANNELS } from "../../../../src/decoders/enablement/contract.js"
import {
	pagingChannels,
	planPlacements,
} from "../../../../src/decoders/enablement/placement.js"
import {
	DECODER_BAND_TABLE,
	PAGER_BAND_DEFAULT,
	decoderBandTable,
	pagingBandRanges,
	pagingRasterRanges,
	rasterChannelsBetween,
	PAGING_MAX_RASTER_POINTS,
	multimonServiceBand,
	resolveDecoderBand,
	type ModeBandDefault,
	type PagingRasterRange,
} from "../../../../src/decoders/enablement/paging-plan.js"
import type {
	PlannerInput,
	PlannerSource,
} from "../../../../src/decoders/enablement/contract.js"
import {
	BAND_DEFAULTS,
	resolveBandRequirements,
} from "../../../../src/decoders/band-defaults.js"
import { BAND_REGIONS } from "../../../../src/decoders/band-region.js"
import { assessDecoderBand } from "../../../../src/decoders/band-resolver.js"

const decoder = (overrides: Partial<PlannerDecoder> = {}): PlannerDecoder => ({
	id: "test",
	type: "acarsdec",
	origin: "catalogue",
	order: 0,
	mode: "auto",
	startMode: "auto",
	configuredSourceId: null,
	band: undefined,
	configuredChannelsHz: [100_000_000],
	reach: "channel",
	channelBandwidthHz: 20_000,
	channelTransitionHz: 10_000,
	protocols: [],
	channelPlacements: true,
	unavailable: false,
	ownDevice: false,
	centreSlotHz: null,
	centrePassbandHz: null,
	...overrides,
})
const source = (overrides: Partial<PlannerSource> = {}): PlannerSource => ({
	id: "s",
	centreHz: 100_000_000,
	sampleRateHz: 2_400_000,
	usableFraction: 0.8,
	dedicatedScanner: false,
	held: false,
	reservedBy: null,
	channelizerAvailable: true,
	order: 0,
	...overrides,
})
const input = (d: PlannerDecoder, sources: PlannerSource[]): PlannerInput => ({
	decoders: [d],
	sources,
	vfo: null,
	bandplanChannels: () => [],
	maxBandplanChannels: 4,
})

const CENTRE = 466_103_300
const EU_RASTER = pagingRasterRanges("EU")
const pager = (overrides: Partial<PlannerDecoder> = {}): PlannerDecoder =>
	decoder({
		id: "pager",
		type: "multimon-ng",
		origin: "config",
		configuredChannelsHz: [],
		channelBandwidthHz: 12_000,
		channelTransitionHz: 2_500,
		protocols: ["pocsag", "flex"],
		channelPlacements: false,
		band: {
			rangesHz: pagingBandRanges("EU"),
			basis: "region-default",
		},
		pagingRaster: EU_RASTER,
		...overrides,
	})
const capture = (overrides = {}) =>
	source({ centreHz: CENTRE, sampleRateHz: 1_024_000, ...overrides })
const channelsOf = (d: PlannerDecoder, s = capture(), vfo?: number) =>
	planPlacements({
		...input(d, [s]),
		vfo: vfo ? { sourceId: s.id, frequencyHz: vfo } : null,
	}).wanted.map(w => w.channelHz!)

describe("paging raster placement (3.18)", () => {
	it("the catalogue gives the VHF pager plan and the supplement the French UHF band", () => {
		expect(EU_RASTER).toContainEqual({
			minHz: 466_025_000,
			maxHz: 466_230_000,
			spacingHz: 6250,
			firstChannelHz: 466_025_000,
		})
		expect(EU_RASTER.some(r => r.minHz === 137_000_000)).toBe(true)
		expect(pagingRasterRanges("US").some(r => r.minHz === 466_025_000)).toBe(
			false,
		)
	})

	it("multimon-ng's built-in band is its region's paging ranges; the legacy table is unchanged", () => {
		expect(BAND_DEFAULTS["multimon-ng"]).toBeUndefined()
		expect(DECODER_BAND_TABLE).toMatchObject(BAND_DEFAULTS)
		expect(DECODER_BAND_TABLE["multimon-ng"]).toBe(PAGER_BAND_DEFAULT)
		for (const code of BAND_REGIONS) {
			const { requirements } = resolveBandRequirements({
				type: "multimon-ng",
				declaration: {},
				region: { code, source: "configured" },
				table: DECODER_BAND_TABLE,
			})
			expect(requirements).toEqual({
				rangesHz: pagingBandRanges(code),
				basis: "region-default",
				region: { code, source: "configured" },
			})
			const at = (centerHz: number) =>
				assessDecoderBand(requirements, { centerHz, sampleRateHz: 2_400_000 })
					.verdict
			expect(at(1_090_000_000)).toBe("out-of-band")
			expect(at(433_920_000)).toBe("out-of-band")
			expect(at(153_350_000)).toBe("in-band")
		}
		const eu = (centerHz: number) =>
			assessDecoderBand(
				resolveBandRequirements({
					type: "multimon-ng",
					declaration: {},
					region: { code: "EU", source: "configured" },
					table: DECODER_BAND_TABLE,
				}).requirements,
				{ centerHz, sampleRateHz: 1_024_000 },
			).verdict
		expect(eu(466_100_000)).toBe("in-band")
	})

	it("the pager band table applies only when every mode is a paging mode", () => {
		const table = (modes: unknown) =>
			decoderBandTable("multimon-ng", modes === undefined ? {} : { modes })
		for (const modes of [
			undefined,
			[],
			"POCSAG1200",
			["POCSAG1200"],
			["POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX"],
			["FLEX", "bogus"],
			["bogus"],
		])
			expect(table(modes)).toBe(DECODER_BAND_TABLE)
		// Every known mode has a service, so a mode list is never left unknown.
		for (const modes of [
			["FSK9600"],
			["EAS"],
			["POCSAG1200", "EAS"],
			["AFSK1200", "FSK9600"],
		])
			expect(table(modes)).not.toBe(BAND_DEFAULTS)
		// An explicit channel pin keeps the band unknown, paging-only lists included.
		for (const key of [
			"channelHz",
			"channelsHz",
			"offsetHz",
			"frequency",
			"frequencies",
		]) {
			expect(
				decoderBandTable("multimon-ng", { modes: ["AFSK1200"], [key]: 1 }),
			).toBe(BAND_DEFAULTS)
			expect(
				decoderBandTable("multimon-ng", { modes: ["POCSAG1200"], [key]: 1 }),
			).toBe(BAND_DEFAULTS)
			expect(decoderBandTable("multimon-ng", { [key]: 1 })).toBe(BAND_DEFAULTS)
		}
		expect(decoderBandTable("dsd-fme", {})).toBe(BAND_DEFAULTS)
	})

	it("R3: AFSK1200, DTMF and mixed paging modes take the band-plan ranges of their services", () => {
		const table = (modes: string[]) =>
			decoderBandTable("multimon-ng", { modes })
		const verdict = (
			modes: string[],
			centerHz: number,
			code: "EU" | "US" = "EU",
		) =>
			assessDecoderBand(
				resolveBandRequirements({
					type: "multimon-ng",
					declaration: {},
					region: { code, source: "configured" },
					table: decoderBandTable("multimon-ng", { modes }),
				}).requirements,
				{ centerHz, sampleRateHz: 2_400_000 },
			).verdict
		for (const modes of [
			["AFSK1200"],
			["DTMF"],
			["POCSAG1200", "AFSK1200"],
			["FLEX", "DTMF", "bogus"],
		]) {
			expect(table(modes)).not.toBe(BAND_DEFAULTS)
			expect(table(modes)["multimon-ng"]).not.toBe(PAGER_BAND_DEFAULT)
			expect(verdict(modes, 1_090_000_000)).toBe("out-of-band")
			expect(verdict(modes, 868_950_000)).toBe("out-of-band")
		}
		// The same service set shares one table.
		expect(table(["DTMF", "FLEX"])).toBe(table(["FLEX", "DTMF", "bogus"]))
		expect(verdict(["AFSK1200"], 144_800_000)).toBe("in-band")
		expect(verdict(["AFSK1200"], 144_390_000, "US")).toBe("in-band")
		// The amateur 70 cm band holds 1200 Bd packet too; weather radio does not.
		expect(verdict(["AFSK1200"], 433_920_000)).toBe("in-band")
		expect(verdict(["AFSK1200"], 162_475_000)).toBe("out-of-band")
		expect(verdict(["DTMF"], 446_050_000)).toBe("in-band")
		expect(verdict(["DTMF"], 156_800_000)).toBe("in-band")
		// 868.95 MHz is EU ISM but US 851-869 MHz land mobile (analog FM).
		expect(verdict(["DTMF"], 868_950_000, "US")).toBe("in-band")
		expect(verdict(["AFSK1200"], 868_950_000, "US")).toBe("out-of-band")
		// The 901-935 MHz gap between the 900 MHz halves holds no land mobile.
		expect(verdict(["DTMF"], 915_000_000, "US")).toBe("out-of-band")
		expect(verdict(["DTMF"], 901_000_000, "US")).toBe("in-band")
		expect(verdict(["DTMF"], 935_000_000, "US")).toBe("in-band")
		expect(verdict(["POCSAG1200", "AFSK1200"], 153_350_000)).toBe("in-band")
		expect(verdict(["POCSAG1200", "AFSK1200"], 466_100_000)).toBe("in-band")
		// Configured targets and overrides win over the mode band.
		const pinned = resolveBandRequirements({
			type: "multimon-ng",
			declaration: {
				configured: { targetsHz: [868_950_000], basis: "configured" },
			},
			region: { code: "EU", source: "configured" },
			table: decoderBandTable("multimon-ng", { modes: ["AFSK1200"] }),
		}).requirements
		expect(
			assessDecoderBand(pinned, {
				centerHz: 868_950_000,
				sampleRateHz: 2_400_000,
			}).verdict,
		).toBe("in-band")
	})

	it("R3: EAS and FSK9600 are out of band at 1090 MHz in every region, never unknown", () => {
		const resolve = (modes: string[], code: (typeof BAND_REGIONS)[number]) =>
			resolveDecoderBand({
				type: "multimon-ng",
				declaration: {},
				region: { code, source: "configured" },
				table: decoderBandTable("multimon-ng", { modes }),
			}).requirements
		const verdict = (
			modes: string[],
			code: (typeof BAND_REGIONS)[number],
			centerHz: number,
		) =>
			assessDecoderBand(resolve(modes, code), {
				centerHz,
				sampleRateHz: 2_400_000,
			})
		for (const code of BAND_REGIONS)
			for (const modes of [
				["EAS"],
				["FSK9600"],
				["EAS", "FSK9600"],
				["AFSK1200", "EAS"],
				["POCSAG1200", "EAS"],
				["DTMF", "FSK9600"],
			])
				expect(verdict(modes, code, 1_090_000_000)).toMatchObject({
					verdict: "out-of-band",
					reasonCode: "frequency-out-of-band",
				})
		// EAS: NOAA Weather Radio / Weatheradio Canada, 162.400-162.550 MHz.
		const weather = { minHz: 162_400_000, maxHz: 162_550_000 }
		for (const code of ["US", "CA"] as const) {
			expect(resolve(["EAS"], code)?.rangesHz).toEqual([weather])
			expect(verdict(["EAS"], code, 162_475_000).verdict).toBe("in-band")
			expect(verdict(["EAS"], code, 144_390_000).verdict).toBe("out-of-band")
		}
		// No weather radio band elsewhere: EAS alone is nowhere.
		for (const code of ["EU", "AU", "NZ", "JP", "CN"] as const) {
			expect(resolve(["EAS"], code)).toMatchObject({ nowhere: true })
			expect(verdict(["EAS"], code, 162_475_000).verdict).toBe("out-of-band")
		}
		// FSK9600: the region's amateur 2 m and 70 cm plans.
		expect(resolve(["FSK9600"], "EU")?.rangesHz).toEqual([
			{ minHz: 144_000_000, maxHz: 146_000_000 },
			{ minHz: 430_000_000, maxHz: 440_000_000 },
		])
		for (const code of ["US", "CA"] as const)
			expect(resolve(["FSK9600"], code)?.rangesHz).toEqual([
				{ minHz: 144_000_000, maxHz: 148_000_000 },
				{ minHz: 420_000_000, maxHz: 450_000_000 },
			])
		expect(verdict(["FSK9600"], "EU", 144_800_000).verdict).toBe("in-band")
		expect(verdict(["FSK9600"], "EU", 435_000_000).verdict).toBe("in-band")
		expect(verdict(["FSK9600"], "EU", 162_475_000).verdict).toBe("out-of-band")
		expect(verdict(["FSK9600"], "US", 146_520_000).verdict).toBe("in-band")
		// The catalogue has no amateur plan there: the ITU-wide 2 m and 70 cm ranges.
		for (const code of ["AU", "NZ", "JP", "CN"] as const) {
			expect(resolve(["FSK9600"], code)?.rangesHz).toEqual([
				{ minHz: 144_000_000, maxHz: 146_000_000 },
				{ minHz: 430_000_000, maxHz: 440_000_000 },
			])
			expect(verdict(["FSK9600"], code, 1_090_000_000).verdict).toBe(
				"out-of-band",
			)
		}
	})

	it("R3: a mixed list's band is the union of its modes' ranges", () => {
		const verdict = (
			modes: string[],
			code: (typeof BAND_REGIONS)[number],
			centerHz: number,
		) =>
			assessDecoderBand(
				resolveDecoderBand({
					type: "multimon-ng",
					declaration: {},
					region: { code, source: "configured" },
					table: decoderBandTable("multimon-ng", { modes }),
				}).requirements,
				{ centerHz, sampleRateHz: 1_024_000 },
			).verdict
		// AFSK1200 + EAS: APRS and amateur packet plus weather radio, nothing else.
		expect(verdict(["AFSK1200", "EAS"], "US", 144_390_000)).toBe("in-band")
		expect(verdict(["AFSK1200", "EAS"], "US", 162_475_000)).toBe("in-band")
		expect(verdict(["AFSK1200", "EAS"], "US", 433_920_000)).toBe("in-band")
		expect(verdict(["AFSK1200", "EAS"], "US", 868_950_000)).toBe("out-of-band")
		expect(verdict(["AFSK1200", "EAS"], "US", 1_090_000_000)).toBe(
			"out-of-band",
		)
		// In the EU EAS adds nothing: AFSK1200's packet ranges alone.
		expect(verdict(["AFSK1200", "EAS"], "EU", 144_800_000)).toBe("in-band")
		expect(verdict(["AFSK1200", "EAS"], "EU", 435_000_000)).toBe("in-band")
		expect(verdict(["AFSK1200", "EAS"], "EU", 162_475_000)).toBe("out-of-band")
		// POCSAG + EAS: paging plus weather radio; FSK9600 adds 70 cm.
		expect(verdict(["POCSAG1200", "EAS"], "EU", 466_100_000)).toBe("in-band")
		expect(verdict(["POCSAG1200", "EAS"], "EU", 435_000_000)).toBe(
			"out-of-band",
		)
		expect(verdict(["POCSAG1200", "FSK9600"], "EU", 435_000_000)).toBe(
			"in-band",
		)
		expect(verdict(["POCSAG1200", "FSK9600"], "EU", 868_950_000)).toBe(
			"out-of-band",
		)
		// The same service set shares one table, whatever the order.
		expect(
			decoderBandTable("multimon-ng", { modes: ["EAS", "AFSK1200"] }),
		).toBe(decoderBandTable("multimon-ng", { modes: ["AFSK1200", "EAS"] }))
		// A pin still keeps the band unknown.
		expect(
			decoderBandTable("multimon-ng", { modes: ["EAS"], channelHz: 1 }),
		).toBe(BAND_DEFAULTS)
	})

	it("R3: a pinned paging-only list is not suspended off the paging band (868.95 MHz)", () => {
		const assessment = assessDecoderBand(
			resolveDecoderBand({
				type: "multimon-ng",
				declaration: {},
				region: { code: "EU", source: "configured" },
				table: decoderBandTable("multimon-ng", {
					modes: ["POCSAG1200"],
					channelHz: 868_950_000,
				}),
			}).requirements,
			{ centerHz: 868_950_000, sampleRateHz: 2_400_000 },
		)
		expect(assessment.verdict).toBe("unknown")
	})

	it("R3: AFSK1200 takes each region's 2 m APRS channel and is out of band at 1090 MHz", () => {
		const aprs: Record<(typeof BAND_REGIONS)[number], number> = {
			EU: 144_800_000,
			US: 144_390_000,
			CA: 144_390_000,
			AU: 145_175_000,
			NZ: 144_575_000,
			JP: 144_660_000,
			CN: 144_640_000,
		}
		const table = decoderBandTable("multimon-ng", { modes: ["AFSK1200"] })
		for (const code of BAND_REGIONS) {
			const requirements = resolveDecoderBand({
				type: "multimon-ng",
				declaration: {},
				region: { code, source: "configured" },
				table,
			}).requirements
			expect(requirements?.rangesHz).toContainEqual({
				minHz: aprs[code] - 8000,
				maxHz: aprs[code] + 8000,
			})
			const at = (centerHz: number) =>
				assessDecoderBand(requirements, { centerHz, sampleRateHz: 2_400_000 })
			expect(at(1_090_000_000)).toMatchObject({
				verdict: "out-of-band",
				reasonCode: "frequency-out-of-band",
			})
			expect(at(aprs[code]).verdict).toBe("in-band")
			// Japan's 144.640 MHz is the 9600-baud channel, not AFSK1200's.
			if (code === "JP")
				expect(requirements?.rangesHz).not.toContainEqual({
					minHz: 144_632_000,
					maxHz: 144_648_000,
				})
		}
	})

	it("R3: a service with no data in the region leaves the band unknown, whatever the other modes", () => {
		const range = { minHz: 136_000_000, maxHz: 174_000_000 }
		// No data for aprs: unknown (follow the VFO), alone or beside a service with data.
		expect(multimonServiceBand("AU", false, ["aprs"], () => undefined)).toEqual(
			{},
		)
		expect(
			multimonServiceBand("AU", false, ["aprs", "analog-fm"], (_r, p) =>
				p === "aprs" ? undefined : [range],
			),
		).toEqual({})
		expect(multimonServiceBand("EU", true, ["aprs"], () => undefined)).toEqual(
			{},
		)
		const table = {
			...BAND_DEFAULTS,
			"multimon-ng": {
				scope: "region" as const,
				byRegion: Object.fromEntries(
					BAND_REGIONS.map(code => [
						code,
						multimonServiceBand(code, false, ["aprs"], () => undefined),
					]),
				) as Record<(typeof BAND_REGIONS)[number], ModeBandDefault>,
			},
		}
		const resolved = resolveDecoderBand({
			type: "multimon-ng",
			declaration: {},
			region: { code: "JP", source: "configured" },
			table,
		})
		expect(resolved.requirements).toBeUndefined()
		expect(
			assessDecoderBand(resolved.requirements, {
				centerHz: 1_090_000_000,
				sampleRateHz: 2_400_000,
			}).verdict,
		).toBe("unknown")
	})

	it("R3: every region has data for every mode service: 1090 MHz is out of band for each mode alone", () => {
		for (const code of BAND_REGIONS)
			for (const mode of [
				"POCSAG1200",
				"FLEX",
				"AFSK1200",
				"DTMF",
				"FSK9600",
				"EAS",
			]) {
				const requirements = resolveDecoderBand({
					type: "multimon-ng",
					declaration: {},
					region: { code, source: "configured" },
					table: decoderBandTable("multimon-ng", { modes: [mode] }),
				}).requirements
				expect(requirements).toBeDefined()
				expect(
					assessDecoderBand(requirements, {
						centerHz: 1_090_000_000,
						sampleRateHz: 2_400_000,
					}).verdict,
				).toBe("out-of-band")
			}
	})

	it("R3: AFSK1200 hears APRS, amateur 2 m / 70 cm, the ISS and 70 cm satellite packet in every region", () => {
		const verdict = (
			modes: string[],
			code: (typeof BAND_REGIONS)[number],
			centerHz: number,
		) =>
			assessDecoderBand(
				resolveDecoderBand({
					type: "multimon-ng",
					declaration: {},
					region: { code, source: "configured" },
					table: decoderBandTable("multimon-ng", { modes }),
				}).requirements,
				{ centerHz, sampleRateHz: 240_000 },
			).verdict
		for (const code of BAND_REGIONS) {
			// The ISS packet channel and the 70 cm satellite packet channel.
			expect(verdict(["AFSK1200"], code, 145_825_000)).toBe("in-band")
			expect(verdict(["AFSK1200"], code, 437_800_000)).toBe("in-band")
			expect(verdict(["AFSK1200"], code, 1_090_000_000)).toBe("out-of-band")
		}
		expect(verdict(["AFSK1200"], "AU", 145_825_000)).toBe("in-band")
		expect(verdict(["AFSK1200"], "EU", 437_800_000)).toBe("in-band")
		expect(verdict(["FSK9600"], "JP", 144_660_000)).toBe("in-band")
		expect(verdict(["AFSK1200"], "JP", 144_660_000)).toBe("in-band")
		// Outside every amateur range and APRS channel.
		expect(verdict(["AFSK1200"], "EU", 162_475_000)).toBe("out-of-band")
	})

	it("R3: US and Canadian 900 MHz paging (929-932 MHz) is a POCSAG/FLEX band, mixed lists included", () => {
		const verdict = (
			modes: string[],
			code: (typeof BAND_REGIONS)[number],
			centerHz: number,
		) =>
			assessDecoderBand(
				resolveDecoderBand({
					type: "multimon-ng",
					declaration: {},
					region: { code, source: "configured" },
					table: decoderBandTable("multimon-ng", { modes }),
				}).requirements,
				{ centerHz, sampleRateHz: 240_000 },
			).verdict
		for (const code of ["US", "CA"] as const) {
			expect(pagingRasterRanges(code)).toContainEqual({
				minHz: 929_000_000,
				maxHz: 932_000_000,
				spacingHz: 25_000,
				firstChannelHz: 929_012_500,
			})
			expect(verdict(["POCSAG1200"], code, 931_000_000)).toBe("in-band")
			expect(verdict(["POCSAG1200", "AFSK1200"], code, 931_000_000)).toBe(
				"in-band",
			)
			expect(verdict(["FLEX", "EAS"], code, 929_500_000)).toBe("in-band")
		}
		// 120 channels: 929.0125 MHz to 931.9875 MHz on 25 kHz.
		const us900 = pagingRasterRanges("US").filter(r => r.minHz === 929_000_000)
		const channels = rasterChannelsBetween(us900, 929_000_000, 932_000_000)
		expect(channels).toHaveLength(120)
		expect([channels[0], channels.at(-1)]).toEqual([929_012_500, 931_987_500])
		expect(rasterChannelsBetween(us900, 932_000_001, 940_000_000)).toEqual([])
		expect(verdict(["POCSAG1200", "AFSK1200"], "EU", 931_000_000)).toBe(
			"out-of-band",
		)
	})

	it("R3: a known mode with no range in the region is out of band", () => {
		const none = () => []
		// Every service known to be empty and no paging: the band is nowhere.
		expect(multimonServiceBand("AU", false, ["aprs"], none)).toEqual({
			nowhere: true,
		})
		// One mode without a range adds nothing; the others still count.
		expect(
			multimonServiceBand("AU", false, ["aprs", "analog-fm"], (_r, p) =>
				p === "aprs" ? [] : [{ minHz: 136_000_000, maxHz: 174_000_000 }],
			),
		).toEqual({ rangesHz: [{ minHz: 136_000_000, maxHz: 174_000_000 }] })
		const byRegion = Object.fromEntries(
			BAND_REGIONS.map(code => [
				code,
				multimonServiceBand(code, false, [], none),
			]),
		) as Record<(typeof BAND_REGIONS)[number], ModeBandDefault>
		const table = {
			...BAND_DEFAULTS,
			"multimon-ng": { scope: "region" as const, byRegion },
		}
		const region = { code: "JP" as const, source: "configured" as const }
		const resolved = resolveDecoderBand({
			type: "multimon-ng",
			declaration: {},
			region,
			table,
		})
		expect(resolved.requirements).toEqual({
			nowhere: true,
			basis: "region-default",
			region,
		})
		for (const centerHz of [1_090_000_000, 144_660_000])
			expect(
				assessDecoderBand(resolved.requirements, {
					centerHz,
					sampleRateHz: 2_400_000,
				}),
			).toEqual({
				verdict: "out-of-band",
				reasonCode: "frequency-out-of-band",
				basis: "region-default",
				region,
				captureCenterHz: centerHz,
			})
		// Configured targets, overrides and an own tuner still win over nowhere.
		const winning = [
			{
				configured: { targetsHz: [144_660_000], basis: "configured" as const },
			},
			{ ownTuning: true as const },
			{ ownSource: true as const },
		]
		for (const declaration of winning)
			expect(
				resolveDecoderBand({ type: "multimon-ng", declaration, region, table })
					.requirements?.nowhere,
			).toBeUndefined()
		expect(
			resolveDecoderBand({
				type: "multimon-ng",
				declaration: {},
				region,
				table,
				apiOverride: {
					rangesHz: [{ minHz: 144_000_000, maxHz: 146_000_000 }],
				},
			}).requirements?.basis,
		).toBe("override")
		// The planner treats a nowhere band as known: out of band, not unknown.
		const plan = planPlacements({
			...input(
				pager({
					band: { nowhere: true, basis: "region-default" },
					pagingRaster: [],
				}),
				[capture()],
			),
			vfo: { sourceId: "s", frequencyHz: CENTRE },
		})
		expect(plan.wanted).toEqual([])
		expect(plan.unplaced.get("pager")).toBe("frequency-out-of-band")
	})

	it("config-origin without channels places every French channel in the window, not the VFO", () => {
		const channels = channelsOf(pager(), capture(), CENTRE)
		expect(channels).toHaveLength(33)
		expect(channels).toEqual(
			expect.arrayContaining([466_100_000, 466_112_500, 466_156_250]),
		)
		expect(channels).not.toContain(CENTRE)
		expect(channels[0]).toBe(466_106_250)
	})

	it("catalogue-origin places the same raster channels", () => {
		const channels = channelsOf(
			pager({ origin: "catalogue", channelPlacements: true }),
		)
		expect(new Set(channels)).toEqual(
			new Set(rasterChannelsBetween(EU_RASTER, 466_025_000, 466_230_000)),
		)
	})

	it("config-origin with configured channels keeps them", () => {
		expect(
			channelsOf(
				pager({ configuredChannelsHz: [466_087_500], channelPlacements: true }),
				capture(),
				CENTRE,
			),
		).toEqual([466_087_500])
	})

	it("config-origin with followVfo false (explicit frequency option) keeps today's path", () => {
		const d = pager({ followVfo: false })
		expect(pagingChannels(d, capture()).channels).toEqual([])
	})

	it("without a channelizer it keeps the single VFO placement", () => {
		const plan = planPlacements({
			...input(pager(), [capture({ channelizerAvailable: false })]),
			vfo: { sourceId: "s", frequencyHz: 466_087_500 },
		})
		expect(plan.wanted.map(w => [w.channelHz, w.origin, w.reach])).toEqual([
			[466_087_500, "vfo", "raw"],
		])
	})

	it("channels past the usable window are left out (not Nyquist)", () => {
		// Window +-409.6 kHz around 466.5 MHz: 466.025-466.0904 is out, the rest in.
		const channels = channelsOf(pager(), capture({ centreHz: 466_500_000 }))
		expect(Math.min(...channels)).toBeGreaterThanOrEqual(
			466_500_000 - 409_600 + 8_500,
		)
		expect(channels).not.toContain(466_025_000)
		expect(channels).toContain(466_225_000)
	})

	it("a channel exactly at the bound fits and 1 Hz past it is too narrow", () => {
		// Fit: |hz - centre| + 6 kHz + 2.5 kHz <= 409.6 kHz, so 401.1 kHz.
		const raster = (offset: number): PagingRasterRange[] => [
			{
				minHz: CENTRE + offset,
				maxHz: CENTRE + offset,
				spacingHz: 12_500,
				firstChannelHz: CENTRE + offset,
			},
		]
		const at = pager({ band: undefined, pagingRaster: raster(401_100) })
		expect(pagingChannels(at, capture())).toEqual({
			channels: [CENTRE + 401_100],
			misfit: false,
		})
		const past = pager({
			origin: "catalogue",
			channelPlacements: true,
			band: undefined,
			pagingRaster: raster(401_101),
		})
		expect(pagingChannels(past, capture())).toEqual({
			channels: [],
			misfit: true,
		})
		expect(planPlacements(input(past, [capture()])).unplaced.get("pager")).toBe(
			"capture-too-narrow",
		)
	})

	it("bounds the count at MULTIMON_PAGING_MAX_CHANNELS, nearest the centre first", () => {
		const wide: PagingRasterRange[] = [
			{
				minHz: 465_000_000,
				maxHz: 467_000_000,
				spacingHz: 6250,
				firstChannelHz: 465_000_000,
			},
		]
		const d = pager({ band: undefined, pagingRaster: wide })
		const { channels } = pagingChannels(d, capture())
		expect(channels).toHaveLength(MULTIMON_PAGING_MAX_CHANNELS)
		const far = Math.max(...channels.map(hz => Math.abs(hz - CENTRE)))
		// 33 nearest points on a 6.25 kHz grid lie within 16 x 6.25 kHz (+ the 3 kHz phase).
		expect(far).toBeLessThanOrEqual(16 * 6250 + 3000)
	})

	it("the 1090 MHz gate: no paging band in view, out of band", () => {
		const s = source({ centreHz: 1_090_000_000, sampleRateHz: 2_400_000 })
		const plan = planPlacements({
			...input(pager(), [s]),
			vfo: { sourceId: "s", frequencyHz: 1_090_000_000 },
		})
		expect(plan.wanted).toEqual([])
		expect(plan.unplaced.get("pager")).toBe("frequency-out-of-band")
	})

	it("secondary paging channels are admitted after other decoders", () => {
		const other = decoder({
			id: "other",
			order: 1,
			origin: "config",
			channelPlacements: true,
			configuredChannelsHz: [466_300_000],
		})
		const plan = planPlacements({
			...input(pager(), [capture()]),
			decoders: [pager(), other],
		})
		const ids = plan.wanted.map(w => w.decoderId)
		expect(ids[0]).toBe("pager")
		expect(ids[1]).toBe("other")
		expect(ids.slice(2).every(id => id === "pager")).toBe(true)
	})

	it("catalogue: an on-raster VFO goes first; band-plan extras are capped after combining", () => {
		const d = pager({ origin: "catalogue", channelPlacements: true })
		const plan = planPlacements({
			...input(d, [capture()]),
			vfo: { sourceId: "s", frequencyHz: 466_137_500 },
			bandplanChannels: () => [466_101_000, 466_137_500],
			bandplanRangeContains: () => true,
		})
		const hz = plan.wanted.map(w => w.channelHz!)
		// 33 raster channels (the VFO is one of them) + 1 band-plan extra = 34 -> 33.
		expect(hz).toHaveLength(MULTIMON_PAGING_MAX_CHANNELS)
		expect(new Set(hz).size).toBe(hz.length)
		expect(plan.wanted[0]).toMatchObject({
			channelHz: 466_137_500,
			origin: "vfo",
			primary: true,
		})
		expect(plan.wanted[0]!.gated).toBeUndefined()
		// The band-plan extra has the lowest priority and is the one cut.
		expect(hz).not.toContain(466_101_000)
		expect(hz).toContain(466_225_000)
	})

	it.each(["config", "catalogue"] as const)(
		"%s: an off-raster VFO is dropped; the nearest raster channel is primary, the rest gated",
		origin => {
			const d = pager({ origin, channelPlacements: origin === "catalogue" })
			const plan = planPlacements({
				...input(d, [capture()]),
				vfo: { sourceId: "s", frequencyHz: CENTRE },
				bandplanRangeContains: () => true,
			})
			expect(plan.wanted.map(w => w.channelHz)).not.toContain(CENTRE)
			expect(plan.wanted[0]).toMatchObject({
				channelHz: 466_106_250,
				origin: "bandplan",
				primary: true,
			})
			expect(plan.wanted[0]!.gated).toBeUndefined()
			expect(plan.wanted.slice(1).every(w => w.gated === true)).toBe(true)
			expect(plan.wanted).toHaveLength(33)
		},
	)

	it("raster channels in view that cannot fit report capture-too-narrow, not a centre fallback", () => {
		const s = capture({ centreHz: 466_016_000, sampleRateHz: 22_500 })
		const plan = planPlacements(input(pager(), [s]))
		expect(plan.wanted).toEqual([])
		expect(plan.unplaced.get("pager")).toBe("capture-too-narrow")
		const catalogue = planPlacements(
			input(pager({ origin: "catalogue", channelPlacements: true }), [s]),
		)
		expect(catalogue.wanted).toEqual([])
		expect(catalogue.unplaced.get("pager")).toBe("capture-too-narrow")
	})

	it.each(["config", "catalogue"] as const)(
		"%s: a VFO on a raster channel is the ungated primary, the rest gated",
		origin => {
			const d = pager({ origin, channelPlacements: origin === "catalogue" })
			const plan = planPlacements({
				...input(d, [capture()]),
				vfo: { sourceId: "s", frequencyHz: 466_137_500 },
				bandplanRangeContains: () => true,
			})
			expect(plan.wanted[0]).toMatchObject({
				channelHz: 466_137_500,
				origin: "vfo",
				primary: true,
			})
			expect(plan.wanted[0]!.gated).toBeUndefined()
			expect(plan.wanted.slice(1).every(w => w.gated === true)).toBe(true)
			expect(plan.wanted.slice(1).every(w => w.origin === "bandplan")).toBe(
				true,
			)
			const hz = plan.wanted.map(w => w.channelHz)
			expect(hz).toHaveLength(33)
			expect(new Set(hz).size).toBe(33)
		},
	)

	it.each([
		["config", { mode: "always" as const }],
		["catalogue", { mode: "always" as const }],
		["catalogue", { startMode: "operator" as const }],
		["catalogue", { bandSuspension: false }],
	] as const)(
		"%s with the band bypassed (%o): a raster in view that no channel fits is capture-too-narrow, no fallback",
		(origin, bypass) => {
			const s = capture({ centreHz: 466_016_000, sampleRateHz: 22_500 })
			const d = pager({ origin, channelPlacements: true, ...bypass })
			for (const vfo of [null, 466_016_000, 466_025_000]) {
				const plan = planPlacements({
					...input(d, [s]),
					vfo: vfo === null ? null : { sourceId: "s", frequencyHz: vfo },
				})
				expect(plan.wanted).toEqual([])
				expect(plan.unplaced.get("pager")).toBe("capture-too-narrow")
			}
		},
	)

	it.each(["config", "catalogue"] as const)(
		"%s with mode always and no paging raster in view follows the VFO as before",
		origin => {
			const s = source({ centreHz: 1_090_000_000, sampleRateHz: 2_400_000 })
			const d = pager({
				origin,
				channelPlacements: origin === "catalogue",
				mode: "always",
			})
			const plan = planPlacements({
				...input(d, [s]),
				vfo: { sourceId: "s", frequencyHz: 1_090_100_000 },
			})
			expect(plan.wanted).toEqual([
				expect.objectContaining({
					channelHz: 1_090_100_000,
					origin: "vfo",
					primary: true,
				}),
			])
			expect(plan.unplaced.has("pager")).toBe(false)
		},
	)

	describe("an on-raster VFO counts within the cap", () => {
		const wide: PagingRasterRange[] = [
			{
				minHz: 465_000_000,
				maxHz: 467_000_000,
				spacingHz: 6250,
				firstChannelHz: 465_000_000,
			},
		]
		const byDistance = rasterChannelsBetween(
			wide,
			CENTRE - 409_600,
			CENTRE + 409_600,
		)
			.filter(hz => Math.abs(hz - CENTRE) + 8_500 <= 409_600)
			.sort((a, b) => Math.abs(a - CENTRE) - Math.abs(b - CENTRE) || a - b)
		const at = byDistance[MULTIMON_PAGING_MAX_CHANNELS - 1]!
		const past = byDistance[MULTIMON_PAGING_MAX_CHANNELS]!
		const far = byDistance[byDistance.length - 1]!

		it("pagingChannels keeps the nearest set and puts the VFO first", () => {
			const d = pager({ band: undefined, pagingRaster: wide })
			const nearest = pagingChannels(d, capture()).channels
			expect(nearest).toEqual(byDistance.slice(0, MULTIMON_PAGING_MAX_CHANNELS))
			// At the cap: the 33rd nearest is already in; it moves first.
			const withAt = pagingChannels(d, capture(), at).channels
			expect(withAt[0]).toBe(at)
			expect(new Set(withAt)).toEqual(new Set(nearest))
			// Past the cap: the 34th nearest and the farthest replace the 33rd.
			for (const vfo of [past, far]) {
				const channels = pagingChannels(d, capture(), vfo).channels
				expect(channels).toHaveLength(MULTIMON_PAGING_MAX_CHANNELS)
				expect(channels[0]).toBe(vfo)
				expect(channels.slice(1)).toEqual(
					byDistance.slice(0, MULTIMON_PAGING_MAX_CHANNELS - 1),
				)
			}
			// An off-raster VFO changes nothing.
			expect(pagingChannels(d, capture(), past + 1).channels).toEqual(nearest)
		})

		it.each(["config", "catalogue"] as const)(
			"%s: a VFO past the nearest 33 is still the primary",
			origin => {
				const d = pager({
					origin,
					channelPlacements: origin === "catalogue",
					band: undefined,
					pagingRaster: wide,
				})
				for (const vfo of [at, past, far]) {
					const plan = planPlacements({
						...input(d, [capture()]),
						vfo: { sourceId: "s", frequencyHz: vfo },
						bandplanRangeContains: () => true,
					})
					expect(plan.wanted[0]).toMatchObject({
						channelHz: vfo,
						origin: "vfo",
						primary: true,
					})
					expect(plan.wanted).toHaveLength(MULTIMON_PAGING_MAX_CHANNELS)
				}
			},
		)
	})

	it("unsafe raster numbers are skipped and enumeration is bounded", () => {
		const bad: PagingRasterRange[] = [
			{ minHz: -1e20, maxHz: 1e20, spacingHz: 6250, firstChannelHz: -1e20 },
			{ minHz: 0, maxHz: 1e15, spacingHz: 1000, firstChannelHz: 0.5 },
			{ minHz: 0, maxHz: 1e15, spacingHz: 999, firstChannelHz: 0 },
		]
		expect(rasterChannelsBetween(bad, 0, 1e15)).toEqual([])
		const huge: PagingRasterRange[] = [
			{ minHz: 0, maxHz: 1e15, spacingHz: 1000, firstChannelHz: 0 },
		]
		expect(rasterChannelsBetween(huge, 0, 1e15)).toHaveLength(
			PAGING_MAX_RASTER_POINTS,
		)
		const d = pager({ band: undefined, pagingRaster: bad })
		expect(pagingChannels(d, capture()).channels).toEqual([])
	})

	// Feature: decoder-enablement, Property 18: paging channels lie on the raster in the usable window
	// Validates: Requirements 3.18
	it("every emitted paging channel lies in the usable window and on the raster", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 465_500_000, max: 466_700_000 }),
				fc.constantFrom(250_000, 1_024_000, 2_048_000, 2_400_000),
				fc.constantFrom(0.5, 0.8, 0.95),
				fc.constantFrom(6250, 12_500, 25_000),
				fc.integer({ min: 0, max: 24_999 }),
				(centreHz, sampleRateHz, usableFraction, spacingHz, phase) => {
					const raster: PagingRasterRange[] = [
						{
							minHz: 465_800_000,
							maxHz: 466_400_000,
							spacingHz,
							firstChannelHz: 465_800_000 + (phase % spacingHz),
						},
					]
					const d = pager({ band: undefined, pagingRaster: raster })
					const s = capture({ centreHz, sampleRateHz, usableFraction })
					const half = (sampleRateHz * usableFraction) / 2
					const plan = planPlacements(input(d, [s]))
					const paging = plan.wanted.filter(w => w.origin === "bandplan")
					expect(paging.length).toBeLessThanOrEqual(
						MULTIMON_PAGING_MAX_CHANNELS,
					)
					for (const w of paging) {
						const hz = w.channelHz!
						expect(Math.abs(hz - centreHz) + 6000 + 2500).toBeLessThanOrEqual(
							half,
						)
						expect((hz - raster[0]!.firstChannelHz) % spacingHz).toBe(0)
						expect(hz).toBeGreaterThanOrEqual(raster[0]!.minHz)
						expect(hz).toBeLessThanOrEqual(raster[0]!.maxHz)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
