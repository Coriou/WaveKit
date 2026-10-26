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
import { bandplansFor } from "../../core/scanner/bandplan/index.js"
import {
	BAND_DEFAULTS,
	type BandDefault,
	type BandDefaultEntry,
} from "../band-defaults.js"
import { BAND_REGIONS } from "../band-region.js"

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
	for (const plan of bandplansFor(region))
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
 * airband). The VHF paging plan spans 137-174 MHz, so AFSK1200 on the APRS
 * frequencies stays in band; EAS, DTMF or AFSK1200 elsewhere need a band
 * override or mode `always`. A supplement to the built-in table rather than
 * a row in it: band-defaults.ts is a preserved legacy file (band-plans 1.1).
 */
export const PAGER_BAND_DEFAULT: BandDefaultEntry = {
	scope: "region",
	byRegion: pagerBandByRegion(),
}

function pagerBandByRegion(): Record<BandRegion, BandDefault> {
	const byRegion = {} as Record<BandRegion, BandDefault>
	for (const region of BAND_REGIONS)
		byRegion[region] = { rangesHz: pagingBandRanges(region) }
	return byRegion
}

/** The built-in band table the manager resolves with: BAND_DEFAULTS plus the pager band. */
export const DECODER_BAND_TABLE: Readonly<
	Partial<Record<string, BandDefaultEntry>>
> = { ...BAND_DEFAULTS, "multimon-ng": PAGER_BAND_DEFAULT }

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
