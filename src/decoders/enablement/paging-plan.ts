/**
 * Paging raster plan of the pager decoder (multimon-ng), decoder-enablement
 * amendment 3.18. Pure data plus pure helpers: the manager resolves the
 * region, the planner enumerates the channels.
 *
 * Source of the ranges: the band catalogue's paging plans (scanner bandplans
 * whose protocols are paging only, e.g. `pager-vhf`), plus the supplement
 * below for paging bands the catalogue does not list yet.
 */
import type { BandRegion, DecoderBandRange } from "@wavekit/api-types"
import { builtinBandplansFor } from "../../core/bandplans/builtin-supplement.js"
import type { ScannerProtocol } from "../../core/scanner/types.js"
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
	MULTIMON_PAGING_MODES,
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

/**
 * Paging bands missing from the catalogue, by region.
 *
 * EU (France): 466.025-466.230 MHz, the national UHF paging allocation
 * (12.5 kHz raster from 466.025 MHz). Carriers are also heard on the
 * 6.25 kHz offsets between them, so the raster is 6.25 kHz from
 * 466.025 MHz: every 12.5 kHz channel and every offset channel is on it
 * (e.g. 466.15625 = 466.025 + 21 x 6.25 kHz). The range holds
 * floor((466.230 - 466.025) / 0.00625) + 1 = 33 channels.
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

/**
 * The band-plan services each non-paging multimon-ng mode needs (frequency
 * band check of VFO-following mode lists): AFSK1200 is APRS / 1200 Bd packet,
 * DTMF is in-band signalling on analog FM voice channels. A mode missing here
 * (EAS, FSK9600) has no service in the band plan, so its band stays unknown.
 */
const MODE_PROTOCOLS: Readonly<Partial<Record<MultimonMode, ScannerProtocol>>> =
	{
		AFSK1200: "aprs",
		DTMF: "analog-fm",
	}

/** Catalogue ranges of a region listing `protocol` (the plan data, not a copy). */
function serviceRanges(
	region: BandRegion,
	protocol: ScannerProtocol,
): DecoderBandRange[] {
	const out: DecoderBandRange[] = []
	for (const plan of builtinBandplansFor(region))
		for (const range of plan.ranges)
			if (range.protocols?.includes(protocol))
				out.push({ minHz: range.startHz, maxHz: range.endHz })
	return out
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
 * One table per service set: paging, "aprs" and "analog-fm" give
 * 2^3 = 8 sets at most, so the cache is bounded by the mode list itself.
 */
const modeTables = new Map<
	string,
	Readonly<Partial<Record<string, BandDefaultEntry>>>
>()

/**
 * One region's band for a mode list: the union of the paging ranges (when a
 * paging mode is listed) and each service's band-plan ranges. A mode whose
 * service has no range in the region adds nothing; when no mode has one the
 * band is `nowhere` (out of band at every centre), never unknown: the
 * restrictive answer, so a known mode list is suspended at 1090 MHz in every
 * region. `rangesOf` is the band-plan lookup (injectable for tests).
 */
export function multimonServiceBand(
	region: BandRegion,
	paging: boolean,
	services: readonly ScannerProtocol[],
	rangesOf: (
		region: BandRegion,
		protocol: ScannerProtocol,
	) => DecoderBandRange[] = serviceRanges,
): ModeBandDefault {
	const rangesHz = [
		...(paging ? pagingBandRanges(region) : []),
		...services.flatMap(p => rangesOf(region, p)),
	]
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
 * mode band. Otherwise its band is the union of the band-plan ranges where
 * each of its modes' services exists in the region (multimonServiceBand):
 * paging modes (POCSAG, FLEX) their paging ranges (3.18), AFSK1200 the APRS
 * ranges, DTMF the analog FM voice ranges. So a mode list follows the VFO
 * only where one of its services can be heard, and is
 * `frequency-out-of-band` at 1090 MHz or in the 868 MHz ISM band. Any mode
 * without a service in the plan (EAS, FSK9600) keeps the band unknown: it
 * follows the VFO on every band, as before. Configured frequencies and band
 * overrides win over this table (resolveBandRequirements).
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
	const modes = effectiveMultimonModes(options["modes"])
	const paging = modes.some(m => MULTIMON_PAGING_MODES.includes(m))
	const services = new Set<ScannerProtocol>()
	for (const mode of modes) {
		if (MULTIMON_PAGING_MODES.includes(mode)) continue
		const protocol = MODE_PROTOCOLS[mode]
		if (protocol === undefined) return BAND_DEFAULTS
		services.add(protocol)
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
