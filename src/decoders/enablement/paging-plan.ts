/**
 * Paging raster plan of the pager decoder (multimon-ng), decoder-enablement
 * amendment 3.18. Pure data plus pure helpers: the manager resolves the
 * region, the planner enumerates the channels.
 *
 * Source of the ranges: the band catalogue's paging plans (scanner bandplans
 * whose protocols are paging only, e.g. `pager-vhf`), plus the supplement
 * below for paging bands the catalogue does not list yet (French UHF, US and
 * Canadian 929-932 MHz).
 */
import type { BandRegion, DecoderBandRange } from "@wavekit/api-types"
import { builtinBandplansFor } from "../../core/bandplans/builtin-supplement.js"
import {
	BAND_DEFAULTS,
	resolveBandRequirements,
	type BandDefault,
	type BandDefaultEntry,
	type ResolveBandInput,
	type ResolvedBand,
} from "../band-defaults.js"
import { BAND_REGIONS } from "../band-region.js"
import {
	effectiveMultimonModes,
	multimonPagingOnly,
} from "../builtin/multimon-ng.js"
import type { MultimonMode } from "../builtin/multimon-ng.js"

/** One paging range and the channel raster on it (inclusive integer Hz). */
export interface PagingRasterRange {
	minHz: number
	maxHz: number
	spacingHz: number
	firstChannelHz: number
}

/** Protocols that make a catalogue range a paging range. */
const PAGING_PROTOCOLS: readonly string[] = ["pocsag", "flex"]

/** US and Canadian 900 MHz paging (PAGING_SUPPLEMENT). */
const PAGING_900: PagingRasterRange = {
	minHz: 929_000_000,
	maxHz: 932_000_000,
	spacingHz: 25_000,
	firstChannelHz: 929_012_500,
}

/**
 * Paging bands missing from the catalogue, by region.
 *
 * EU (France): 466.025-466.230 MHz, the national UHF paging allocation
 * (12.5 kHz raster from 466.025 MHz). Carriers are also heard on the
 * 6.25 kHz offsets between them, so the raster is 6.25 kHz from
 * 466.025 MHz: every 12.5 kHz channel and every offset channel is on it
 * (e.g. 466.15625 = 466.025 + 21 x 6.25 kHz). The range holds
 * floor((466.230 - 466.025) / 0.00625) + 1 = 33 channels.
 *
 * US and CA: 929.0-932.0 MHz, the 900 MHz one-way paging band (929-930 MHz
 * and 931-932 MHz paging channels; 930-931 MHz is narrowband PCS, kept in so
 * the band is one range). Paging channels are 25 kHz apart from 929.0125 MHz
 * (931.0125 MHz = 929.0125 + 80 x 25 kHz is on the same raster), so the range
 * holds floor((932.0 - 929.0125) / 0.025) + 1 = 120 channels.
 */
const PAGING_SUPPLEMENT: Readonly<
	Partial<Record<BandRegion, readonly PagingRasterRange[]>>
> = {
	EU: [
		{
			minHz: 466_025_000,
			maxHz: 466_230_000,
			spacingHz: 6250,
			firstChannelHz: 466_025_000,
		},
	],
	US: [PAGING_900],
	CA: [PAGING_900],
}

/** Smallest raster spacing read (bounds the enumeration per window). */
export const PAGING_MIN_SPACING_HZ = 1000

const cache = new Map<BandRegion, readonly PagingRasterRange[]>()

/** The paging raster ranges of a region (catalogue first, then the supplement). */
export function pagingRasterRanges(
	region: BandRegion,
): readonly PagingRasterRange[] {
	const hit = cache.get(region)
	if (hit) return hit
	const out: PagingRasterRange[] = []
	for (const plan of builtinBandplansFor(region))
		for (const range of plan.ranges) {
			const protocols = range.protocols ?? []
			if (
				protocols.length === 0 ||
				!protocols.every(p => PAGING_PROTOCOLS.includes(p))
			)
				continue
			// The finest raster: 12.5 kHz channels also sit on a 6.25 kHz grid.
			const raster = [...(range.rasters ?? [])]
				.filter(r => r.spacingHz >= PAGING_MIN_SPACING_HZ)
				.sort((a, b) => a.spacingHz - b.spacingHz)[0]
			if (!raster) continue
			out.push({
				minHz: range.startHz,
				maxHz: range.endHz,
				spacingHz: raster.spacingHz,
				firstChannelHz: raster.firstChannelHz,
			})
		}
	out.push(...(PAGING_SUPPLEMENT[region] ?? []))
	const frozen = Object.freeze(out.map(r => Object.freeze({ ...r })))
	cache.set(region, frozen)
	return frozen
}

/** The band (ranges only) the pager decoder wants in a region: its paging ranges. */
export function pagingBandRanges(region: BandRegion): DecoderBandRange[] {
	return pagingRasterRanges(region).map(r => ({
		minHz: r.minHz,
		maxHz: r.maxHz,
	}))
}

/**
 * The pager decoder's built-in band (3.18): its region's paging ranges, so
 * it is `frequency-out-of-band` where none is in view (1090 MHz, ISM,
 * airband). It applies only when every mode multimon-ng runs is a paging
 * mode (decoderBandTable). A supplement to the built-in table rather than a
 * row in it: band-defaults.ts is a preserved legacy file (band-plans 1.1).
 */
export const PAGER_BAND_DEFAULT: BandDefaultEntry = {
	scope: "region",
	byRegion: pagerBandByRegion(),
}

function pagerBandByRegion(): Record<BandRegion, BandDefault> {
	const byRegion = {} as Record<BandRegion, BandDefault>
	for (const region of BAND_REGIONS)
		byRegion[region] = multimonServiceBand(region, true, [])
	return byRegion
}

/** BAND_DEFAULTS plus the pager band: the table for a paging-only multimon-ng. */
export const DECODER_BAND_TABLE: Readonly<
	Partial<Record<string, BandDefaultEntry>>
> = { ...BAND_DEFAULTS, "multimon-ng": PAGER_BAND_DEFAULT }

/** A non-paging band service of a multimon-ng mode (MODE_SERVICES). */
export type ModeService = "aprs" | "analog-fm" | "amateur" | "weather-radio"

/**
 * The band service each multimon-ng mode is heard on (frequency band check of
 * VFO-following mode lists):
 * - POCSAG and FLEX: the region's paging ranges (3.18, with the supplement).
 * - AFSK1200: APRS and 1200 Bd packet ("aprs"): the catalogue ranges listing
 *   "aprs", the amateur 2 m and 70 cm ranges (as FSK9600), the ISS packet
 *   channel and the 70 cm satellite packet channel (SATELLITE_PACKET_RANGES).
 * - DTMF: in-band signalling on analog FM voice channels ("analog-fm").
 * - FSK9600: 9600 Bd packet, an amateur mode: the region's amateur 2 m and
 *   70 cm plans, or the ITU-wide ranges where the catalogue has none
 *   (AMATEUR_FALLBACK).
 * - EAS: SAME alerts on NOAA Weather Radio / Weatheradio Canada
 *   (WEATHER_RADIO_RANGES; known to have no range elsewhere).
 */
const MODE_SERVICES: Readonly<Record<MultimonMode, "paging" | ModeService>> = {
	POCSAG512: "paging",
	POCSAG1200: "paging",
	POCSAG2400: "paging",
	FLEX: "paging",
	AFSK1200: "aprs",
	DTMF: "analog-fm",
	FSK9600: "amateur",
	EAS: "weather-radio",
}

/**
 * The amateur 2 m and 70 cm ranges by catalogue plan, with the ITU-wide
 * allocation each falls back to where the region's catalogue lacks the plan
 * (AU, NZ, JP and CN have none): 144-146 MHz is amateur in all three ITU
 * regions, and 430-440 MHz is amateur (primary or secondary) in all three.
 * A missing catalogue plan is incomplete data, never "no amateur band", so a
 * working amateur decode is never suspended for it.
 */
const AMATEUR_FALLBACK: Readonly<Record<string, DecoderBandRange>> = {
	"amateur-2m": { minHz: 144_000_000, maxHz: 146_000_000 },
	"amateur-70cm": { minHz: 430_000_000, maxHz: 440_000_000 },
}

/**
 * Packet channels AFSK1200 hears in every region, inside the amateur bands but
 * listed so they never depend on a regional plan:
 * - the ISS packet / APRS digipeater, 145.825 MHz +/- 12.5 kHz (an 8 kHz
 *   half-width FM channel plus up to 3.5 kHz of 2 m Doppler, rounded up);
 * - the 70 cm amateur satellite packet channel around 437.8 MHz,
 *   437.775-437.825 MHz (+/- 25 kHz: a 12.5 kHz half-width channel plus up to
 *   10 kHz of 70 cm Doppler from a low orbit, rounded up).
 */
const SATELLITE_PACKET_RANGES: readonly DecoderBandRange[] = [
	{ minHz: 145_812_500, maxHz: 145_837_500 },
	{ minHz: 437_775_000, maxHz: 437_825_000 },
]

/**
 * The weather radio band EAS / SAME alerts are broadcast on, which the band
 * catalogue does not list: the seven NOAA Weather Radio channels,
 * 162.400-162.550 MHz on a 25 kHz raster ((162.550 - 162.400) / 0.025 + 1
 * = 7 channels), used by the US and by Weatheradio Canada. No other region
 * broadcasts SAME (a North American system), so every other region is known
 * to have none: EAS adds no range there, which is data, not a gap.
 */
const WEATHER_RADIO_RANGES: Readonly<
	Record<BandRegion, readonly DecoderBandRange[]>
> = {
	US: [{ minHz: 162_400_000, maxHz: 162_550_000 }],
	CA: [{ minHz: 162_400_000, maxHz: 162_550_000 }],
	EU: [],
	AU: [],
	NZ: [],
	JP: [],
	CN: [],
}

/** The region's amateur 2 m and 70 cm ranges: catalogue plans, else the ITU-wide fallback per plan. */
function amateurRanges(region: BandRegion): DecoderBandRange[] {
	const plans = builtinBandplansFor(region)
	return Object.entries(AMATEUR_FALLBACK).flatMap(([id, fallback]) => {
		const plan = plans.find(p => p.id === id)
		return plan
			? plan.ranges.map(r => ({ minHz: r.startHz, maxHz: r.endHz }))
			: [{ ...fallback }]
	})
}

/**
 * A service's ranges in a region, or undefined when there is no data for it
 * there (multimonServiceBand then leaves the band unknown). An empty list is
 * known-empty: the service is not heard in the region.
 */
function serviceRanges(
	region: BandRegion,
	service: ModeService,
): DecoderBandRange[] | undefined {
	if (service === "weather-radio")
		return WEATHER_RADIO_RANGES[region].map(r => ({ ...r }))
	if (service === "amateur") return amateurRanges(region)
	const out: DecoderBandRange[] = []
	for (const plan of builtinBandplansFor(region))
		for (const range of plan.ranges)
			if (range.protocols?.includes(service))
				out.push({ minHz: range.startHz, maxHz: range.endHz })
	if (service === "aprs")
		out.push(
			...amateurRanges(region),
			...SATELLITE_PACKET_RANGES.map(r => ({ ...r })),
		)
	return out.length > 0 ? out : undefined
}

/** Options that pin multimon-ng to explicit channels (the planner's followVfo keys). */
const MULTIMON_PIN_OPTIONS: readonly string[] = [
	"channelHz",
	"channelsHz",
	"offsetHz",
	"frequency",
	"frequencies",
]

/**
 * One table per service set: paging plus the four ModeService values give
 * 2^5 = 32 sets at most, so the cache is bounded by the mode list itself.
 */
const modeTables = new Map<
	string,
	Readonly<Partial<Record<string, BandDefaultEntry>>>
>()

/**
 * One region's band for a mode list: the union of the paging ranges (when a
 * paging mode is listed) and each service's ranges (serviceRanges). When any
 * listed service has no data in the region (`rangesOf` gives undefined, or no
 * paging range is known) the band is unknown (`{}`: the decoder follows the
 * VFO as before), since incomplete data must never suspend a working decode.
 * A service known to be absent adds nothing; when every service has data and
 * the union is empty the band is `nowhere` (out of band at every centre).
 * `rangesOf` is the band-plan lookup (injectable for tests).
 */
export function multimonServiceBand(
	region: BandRegion,
	paging: boolean,
	services: readonly ModeService[],
	rangesOf: (
		region: BandRegion,
		service: ModeService,
	) => DecoderBandRange[] | undefined = serviceRanges,
): ModeBandDefault {
	const rangesHz: DecoderBandRange[] = []
	if (paging) {
		const pagingRanges = pagingBandRanges(region)
		if (pagingRanges.length === 0) return {}
		rangesHz.push(...pagingRanges)
	}
	for (const service of services) {
		const ranges = rangesOf(region, service)
		if (ranges === undefined) return {}
		rangesHz.push(...ranges)
	}
	return rangesHz.length > 0 ? { rangesHz } : { nowhere: true }
}

/**
 * A table band that may be known-empty. band-defaults.ts is a preserved
 * legacy file (band-plans 1.1), so its resolver reads `nowhere` as no band;
 * resolveDecoderBand restores it.
 */
export type ModeBandDefault = BandDefault & { nowhere?: true }

/**
 * resolveBandRequirements plus the known-empty band: when the decoder's
 * table band is `nowhere` in its effective region and nothing earlier in the
 * order (own source, override, configured, own tuning) or the decoder's
 * intrinsic band decided, its requirements are `nowhere` (out of band at
 * every centre, assessDecoderBand) instead of unknown.
 */
export function resolveDecoderBand(input: ResolveBandInput): ResolvedBand {
	const resolved = resolveBandRequirements(input)
	const declaration = input.declaration ?? {}
	if (
		resolved.requirements !== undefined ||
		declaration.ownSource === true ||
		declaration.ownTuning === true
	)
		return resolved
	const entry = (input.table ?? BAND_DEFAULTS)[input.type]
	const band: ModeBandDefault | undefined =
		entry?.scope === "region"
			? entry.byRegion[resolved.region.code]
			: entry?.band
	if (band?.nowhere !== true) return resolved
	return {
		...resolved,
		requirements: {
			nowhere: true,
			basis: "region-default",
			...(entry?.scope === "region" ? { region: { ...resolved.region } } : {}),
		},
	}
}

/**
 * The built-in band table one decoder resolves with. An explicit channel
 * option pins multimon-ng: its band stays unknown whatever its modes
 * (paging-only lists included), so it is never suspended for being off a
 * mode band. Otherwise its band is the union of the ranges of its modes'
 * services in the region (MODE_SERVICES, multimonServiceBand): paging modes
 * (POCSAG, FLEX) their paging ranges (3.18), AFSK1200 the APRS, amateur and
 * satellite packet ranges, DTMF the analog FM voice ranges, FSK9600 the
 * amateur 2 m and 70 cm ranges, EAS the US and Canadian weather radio band. A
 * service with no data in the region leaves the band unknown; with data
 * everywhere an empty union is `nowhere`: so a mode list follows the VFO
 * only where one of its services can be heard, and is
 * `frequency-out-of-band` at 1090 MHz or in the 868 MHz ISM band. Unknown
 * mode strings are dropped as the adapter drops them
 * (effectiveMultimonModes). Configured frequencies and band overrides win
 * over this table (resolveBandRequirements).
 */
export function decoderBandTable(
	type: string,
	options: Readonly<Record<string, unknown>>,
): Readonly<Partial<Record<string, BandDefaultEntry>>> {
	if (type !== "multimon-ng") return BAND_DEFAULTS
	// An explicit channel pins the decoder: no mode band ever suspends it.
	if (MULTIMON_PIN_OPTIONS.some(key => Object.hasOwn(options, key)))
		return BAND_DEFAULTS
	if (multimonPagingOnly(options["modes"])) return DECODER_BAND_TABLE
	let paging = false
	const services = new Set<ModeService>()
	for (const mode of effectiveMultimonModes(options["modes"])) {
		const service = MODE_SERVICES[mode]
		if (service === "paging") paging = true
		else services.add(service)
	}
	const sorted = [...services].sort()
	const key = `${paging ? "paging," : ""}${sorted.join(",")}`
	const hit = modeTables.get(key)
	if (hit) return hit
	const byRegion = {} as Record<BandRegion, BandDefault>
	for (const region of BAND_REGIONS)
		byRegion[region] = multimonServiceBand(region, paging, sorted)
	const table = Object.freeze({
		...BAND_DEFAULTS,
		"multimon-ng": { scope: "region", byRegion } as BandDefaultEntry,
	})
	modeTables.set(key, table)
	return table
}

/** Most raster points one call enumerates (a 2.4 Msps window at 1 kHz is 1 921). */
export const PAGING_MAX_RASTER_POINTS = 100_000

/**
 * Raster channels of `ranges` inside [minHz, maxHz], deduplicated, ascending.
 * Every range number must be a safe integer (Hz), the spacing at least
 * PAGING_MIN_SPACING_HZ; other ranges are skipped. Enumeration stops after
 * PAGING_MAX_RASTER_POINTS points in total, so no input can hang it.
 */
export function rasterChannelsBetween(
	ranges: readonly PagingRasterRange[],
	minHz: number,
	maxHz: number,
): number[] {
	const out = new Set<number>()
	if (!Number.isFinite(minHz) || !Number.isFinite(maxHz) || minHz > maxHz)
		return []
	let budget = PAGING_MAX_RASTER_POINTS
	for (const r of ranges) {
		if (
			!r ||
			!Number.isSafeInteger(r.minHz) ||
			!Number.isSafeInteger(r.maxHz) ||
			!Number.isSafeInteger(r.firstChannelHz) ||
			!Number.isSafeInteger(r.spacingHz) ||
			r.spacingHz < PAGING_MIN_SPACING_HZ ||
			r.minHz > r.maxHz
		)
			continue
		const lo = Math.max(r.minHz, Math.ceil(minHz))
		const hi = Math.min(r.maxHz, Math.floor(maxHz))
		if (lo > hi) continue
		const first = Math.ceil((lo - r.firstChannelHz) / r.spacingHz)
		const last = Math.floor((hi - r.firstChannelHz) / r.spacingHz)
		if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) continue
		for (let k = first; k <= last && budget > 0; k++, budget--) {
			const hz = r.firstChannelHz + k * r.spacingHz
			if (Number.isSafeInteger(hz) && hz >= lo && hz <= hi) out.add(hz)
		}
	}
	return [...out].sort((a, b) => a - b)
}
