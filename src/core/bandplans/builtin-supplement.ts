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

const ALL_REGIONS = [
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
] as const satisfies readonly BandRegion[]

export const BUILTIN_SUPPLEMENT: readonly SupplementPlan[] = Object.freeze([
	{ regions: ["EU"], before: "pmr446", plan: PAGER_FR },
	{ regions: ALL_REGIONS, before: "", plan: ADSB },
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
