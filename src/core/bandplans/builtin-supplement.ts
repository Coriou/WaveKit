/**
 * Built-in bands the legacy scanner table lacks (web-gaps-11 9.x amendment of band-plans 1.1,
 * 1.3, 2.1 and 11.2). `src/core/scanner/bandplan/builtin.ts` and `index.ts` stay byte-identical
 * (band-plans 1.1, 10.2; regional-display-registry 1.5): this module is the one place a new
 * built-in band is added. The built-in catalogue of a region is `bandplansFor(region)` with
 * these plans inserted; the built-in packs, the presets, the scanner's effective list and its
 * fallback all read the catalogue, so the scanner and the band view see the same bands.
 *
 * Pure data and pure helpers. General public band-plan knowledge; no regulatory citation.
 */
import type { BandRegion } from "@wavekit/api-types"
import { bandplansFor } from "../scanner/bandplan/index.js"
import type { Bandplan } from "../scanner/bandplan/index.js"
import type { ScannerProtocol, ScanRange } from "../scanner/types.js"

interface SupplementPlan {
	/** Regions whose catalogue carries the plan. */
	regions: readonly BandRegion[]
	/** The plan goes right before this plan id when the region has it; else last ("": last). */
	before: string
	plan: Bandplan
}

/**
 * French wide-area POCSAG paging: 466.025-466.230 MHz on a 12.5 kHz raster from 466.025 MHz
 * (205 kHz / 12.5 kHz = 16.4, so 17 channels up to 466.225 MHz), plus the single pager channel
 * at 446.5325 MHz (one 12.5 kHz channel, ±6.25 kHz).
 */
const PAGER_FR: Bandplan = {
	id: "pager-fr",
	region: "EU",
	name: "French paging (466 MHz and 446.5325 MHz)",
	ranges: [
		{
			startHz: 466_025_000,
			endHz: 466_230_000,
			rasters: [{ spacingHz: 12_500, firstChannelHz: 466_025_000 }],
			obwHz: [12_000],
			protocols: ["pocsag"],
			bandplanId: "pager-fr",
		},
		{
			startHz: 446_532_500 - 6250,
			endHz: 446_532_500 + 6250,
			rasters: [{ spacingHz: 12_500, firstChannelHz: 446_532_500 }],
			obwHz: [12_000],
			protocols: ["pocsag"],
			bandplanId: "pager-fr",
		},
	],
}

const MHz = (x: number): number => Math.round(x * 1e6)

/** The legacy land mobile occupied bandwidths (12.5 kHz FM, 12.5 kHz digital, 6.25 kHz digital). */
const LAND_MOBILE_OBW: readonly number[] = [9000, 11_000, 4500]
/** dsd-fme's land mobile protocols plus P25 phase 2 (TDMA trunking in these bands). */
const LAND_MOBILE_DIGITAL: readonly ScannerProtocol[] = [
	"dmr",
	"p25p1",
	"p25p2",
	"nxdn48",
	"nxdn96",
]

/** One paired land mobile segment (inclusive MHz edges) on a 12.5 / 6.25 kHz raster. */
function landMobile(
	id: string,
	startMhz: number,
	endMhz: number,
	protocols: readonly ScannerProtocol[],
	rasters: readonly { spacingHz: number; firstMhz: number }[],
): ScanRange {
	return {
		startHz: MHz(startMhz),
		endHz: MHz(endMhz),
		rasters: rasters.map(r => ({
			spacingHz: r.spacingHz,
			firstChannelHz: MHz(r.firstMhz),
		})),
		obwHz: [...LAND_MOBILE_OBW],
		protocols: [...protocols],
		bandplanId: id,
	}
}

/**
 * US and Canadian 700/800/900 MHz land mobile (public safety, business and trunked LMR), the
 * published allocations: FCC 47 CFR Part 90 (subpart R §90.531 for 700 MHz, §90.613 for the
 * 800 and 900 MHz channel tables) and the ISED Canada band plans that mirror the same edges.
 * - 700 MHz public safety narrowband: 769-775 MHz (base) and 799-805 MHz (mobile), 6.25 kHz
 *   channels from 769.003125 / 799.003125 MHz (§90.531), aggregable to 12.5 kHz. Narrowband
 *   700 MHz equipment must carry one voice path per 6.25 kHz, so no analog FM is listed.
 * - 800 MHz: 806-824 MHz (mobile) and 851-869 MHz (base), channels on 12.5 kHz steps from
 *   806.0125 / 851.0125 MHz (25 kHz channels plus 12.5 kHz interstitials), and the two
 *   6.25 kHz carriers inside each 12.5 kHz channel (±3.125 kHz).
 * - 900 MHz: 896-901 MHz (mobile) and 935-940 MHz (base), 12.5 kHz channels from
 *   896.0125 / 935.0125 MHz.
 * One plan per contiguous allocation: a plan projects to one display band spanning its
 * ranges, so a plan holding a base and a mobile half would claim the gap between them
 * (775-799, 824-851 and 901-935 MHz, which hold LTE, cellular and the 902-928 MHz ISM band).
 */
/** 6.25 kHz channels from `firstMhz`; their 12.5 kHz pairs centre 3.125 kHz higher. */
const RASTER_6K25 = (firstMhz: number) => [
	{ spacingHz: 6250, firstMhz },
	{ spacingHz: 12_500, firstMhz: firstMhz + 0.003125 },
]
/** 12.5 kHz channels from `firstMhz`; each one's lower 6.25 kHz half centres 3.125 kHz lower. */
const RASTER_12K5 = (firstMhz: number) => [
	{ spacingHz: 12_500, firstMhz },
	{ spacingHz: 6250, firstMhz: firstMhz - 0.003125 },
]
/** One land mobile allocation as its own plan (one contiguous range), for the US. */
function landMobilePlan(
	id: string,
	name: string,
	startMhz: number,
	endMhz: number,
	protocols: readonly ScannerProtocol[],
	rasters: readonly { spacingHz: number; firstMhz: number }[],
): Bandplan {
	return {
		id,
		region: "US",
		name,
		ranges: [landMobile(id, startMhz, endMhz, protocols, rasters)],
	}
}
const LMR_ANALOG: readonly ScannerProtocol[] = [
	...LAND_MOBILE_DIGITAL,
	"analog-fm",
]
/** The 700/800/900 MHz land mobile plans in frequency order (region "US"; LAND_MOBILE_700_900_CA for Canada). */
export const LAND_MOBILE_700_900: readonly Bandplan[] = Object.freeze([
	landMobilePlan(
		"land-mobile-700-base",
		"Land mobile 700 MHz (base)",
		769,
		775,
		LAND_MOBILE_DIGITAL,
		RASTER_6K25(769.003125),
	),
	landMobilePlan(
		"land-mobile-700-mobile",
		"Land mobile 700 MHz (mobile)",
		799,
		805,
		LAND_MOBILE_DIGITAL,
		RASTER_6K25(799.003125),
	),
	landMobilePlan(
		"land-mobile-800-mobile",
		"Land mobile 800 MHz (mobile)",
		806,
		824,
		LMR_ANALOG,
		RASTER_12K5(806.0125),
	),
	landMobilePlan(
		"land-mobile-800-base",
		"Land mobile 800 MHz (base)",
		851,
		869,
		LMR_ANALOG,
		RASTER_12K5(851.0125),
	),
	landMobilePlan(
		"land-mobile-900-mobile",
		"Land mobile 900 MHz (mobile)",
		896,
		901,
		LMR_ANALOG,
		RASTER_12K5(896.0125),
	),
	landMobilePlan(
		"land-mobile-900-base",
		"Land mobile 900 MHz (base)",
		935,
		940,
		LMR_ANALOG,
		RASTER_12K5(935.0125),
	),
])

/** The same plans served to Canada: copies carrying region "CA", so a CA catalogue never shows a US plan. */
export const LAND_MOBILE_700_900_CA: readonly Bandplan[] = Object.freeze(
	LAND_MOBILE_700_900.map(plan => ({ ...plan, region: "CA" as const })),
)

/** One 2 m APRS channel: ±8 kHz around the carrier, 16 kHz FM (the legacy APRS shape). */
function aprsPlan(region: BandRegion, mhz: number): Bandplan {
	return {
		id: "aprs",
		region,
		name: `APRS ${mhz.toFixed(3)}`,
		ranges: [
			{
				startHz: MHz(mhz) - 8000,
				endHz: MHz(mhz) + 8000,
				rasters: [{ spacingHz: 25_000, firstChannelHz: MHz(mhz) }],
				obwHz: [16_000],
				protocols: ["aprs"],
				bandplanId: "aprs",
			},
		],
	}
}

/**
 * National 2 m APRS frequencies of the regions the legacy table lacks, as each national
 * amateur society publishes them: Australia 145.175 MHz (WIA), New Zealand 144.575 MHz
 * (NZART), Japan 144.660 MHz (JARL; 144.640 MHz there is the 9600-baud channel, which no
 * scanner protocol or band-plan service maps to), China 144.640 MHz (CRAC). The EU
 * (144.800 MHz) and US/CA (144.390 MHz) channels are in the legacy table.
 */
const APRS_AU = aprsPlan("AU", 145.175)
const APRS_NZ = aprsPlan("NZ", 144.575)
const APRS_JP = aprsPlan("JP", 144.66)
const APRS_CN = aprsPlan("CN", 144.64)

/**
 * The ADS-B window: 1090 MHz Mode S / ADS-B, the channel ±1 MHz (1 089 000 000 to
 * 1 091 000 000 Hz inclusive). The ADSB plan below, the replay plan's ADS-B window and the
 * identify job's readsb-only rule all read these.
 */
export const ADSB_WINDOW_LOW_HZ = 1_089_000_000
export const ADSB_WINDOW_HIGH_HZ = 1_091_000_000

/** True when `hz` lies in the ADS-B window (inclusive); false for a non-finite value. */
export function inAdsbWindow(hz: number): boolean {
	return (
		Number.isFinite(hz) && hz >= ADSB_WINDOW_LOW_HZ && hz <= ADSB_WINDOW_HIGH_HZ
	)
}

/**
 * 1090 MHz Mode S / ADS-B: the ADS-B window. No scan protocol: readsb decodes it; the band is
 * projected with a skip (builtin-packs.ts) so sweeps that honour band-plan skips leave it to
 * readsb, and inside it the scanner plans and runs readsb trials only (replay-plan.ts,
 * identify.ts).
 */
const ADSB: Bandplan = {
	id: "adsb",
	region: "all",
	name: "ADS-B (1090 MHz)",
	ranges: [
		{
			startHz: ADSB_WINDOW_LOW_HZ,
			endHz: ADSB_WINDOW_HIGH_HZ,
			obwHz: [],
			protocols: [],
			bandplanId: "adsb",
		},
	],
}

/**
 * Built-in plans that exist only to be skipped: no scan protocol, projected with a band-plan
 * skip (builtin-packs.ts BUILTIN_SKIPS) because another decoder covers them. Never a scan preset.
 */
export const SKIP_ONLY_PLAN_IDS: ReadonlySet<string> = new Set([ADSB.id])

// Every region (this module may import only the scanner band plan modules and api-types, so it cannot share
// src/decoders/band-region.ts BAND_REGIONS); the check below fails the build when BandRegion grows.
const ADSB_REGIONS = [
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
] as const satisfies readonly BandRegion[]
type MissingAdsbRegion = Exclude<BandRegion, (typeof ADSB_REGIONS)[number]>
const adsbRegionsComplete: MissingAdsbRegion extends never ? true : never = true
void adsbRegionsComplete

export const BUILTIN_SUPPLEMENT: readonly SupplementPlan[] = Object.freeze([
	{ regions: ["EU"], before: "pmr446", plan: PAGER_FR },
	...LAND_MOBILE_700_900.map(plan => ({
		regions: ["US"] as const,
		before: "amateur-2m",
		plan,
	})),
	...LAND_MOBILE_700_900_CA.map(plan => ({
		regions: ["CA"] as const,
		before: "amateur-2m",
		plan,
	})),
	{ regions: ["AU"], before: "pager-vhf", plan: APRS_AU },
	{ regions: ["NZ"], before: "pager-vhf", plan: APRS_NZ },
	{ regions: ["JP"], before: "pager-vhf", plan: APRS_JP },
	{ regions: ["CN"], before: "pager-vhf", plan: APRS_CN },
	{ regions: ADSB_REGIONS, before: "", plan: ADSB },
])

const cache = new Map<BandRegion, readonly Bandplan[]>()

/**
 * The built-in catalogue of a region: `bandplansFor(region)` (the legacy plan objects
 * themselves) with the supplement plans inserted. A fresh array per call, as `bandplansFor`.
 * An id the legacy list already has is never added twice.
 */
export function builtinBandplansFor(region: BandRegion): Bandplan[] {
	const base = bandplansFor(region)
	let extra = cache.get(region)
	if (extra === undefined) {
		extra = BUILTIN_SUPPLEMENT.filter(s => s.regions.includes(region)).map(
			s => s.plan,
		)
		cache.set(region, extra)
	}
	if (extra.length === 0) return base
	const out = [...base]
	for (const s of BUILTIN_SUPPLEMENT) {
		if (!extra.includes(s.plan) || out.some(p => p.id === s.plan.id)) continue
		const at = out.findIndex(p => p.id === s.before)
		if (at < 0) out.push(s.plan)
		else out.splice(at, 0, s.plan)
	}
	return out
}

/** `resolveBandplan` over the built-in catalogue. */
export function resolveBuiltinBandplan(
	id: string,
	region: BandRegion,
): Bandplan | undefined {
	return builtinBandplansFor(region).find(p => p.id === id)
}
