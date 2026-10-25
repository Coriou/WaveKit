import type { BandRegion } from "@wavekit/api-types"
import type { Raster } from "../../spectrum/types.js"
import type { ScannerProtocol, ScanRange } from "../types.js"
import { BUILTIN_BANDPLANS } from "./builtin.js"

export type BandRegionCode = BandRegion

export interface Bandplan {
	id: string
	region: "all" | BandRegionCode
	name: string
	ranges: ScanRange[]
}

const SPECIFIC_PROTOCOLS = [
	"analog-fm",
	"analog-am",
	"dmr",
	"p25p1",
	"p25p2",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
	"flex",
	"aprs",
	"ism",
] as const satisfies readonly ScannerProtocol[]
const SOFT_PRIOR = 0.25

function variantFor(region: BandRegionCode): BandRegionCode | null {
	if (region === "EU") return "EU"
	if (region === "US" || region === "CA") return "US"
	return null
}

export function bandplansFor(region: BandRegionCode): Bandplan[] {
	const variant = variantFor(region)
	const specificIds = new Set(
		BUILTIN_BANDPLANS.filter(p => p.region === variant).map(p => p.id),
	)
	return BUILTIN_BANDPLANS.filter(
		p => p.region === variant || (p.region === "all" && !specificIds.has(p.id)),
	)
}

export function resolveBandplan(
	id: string,
	region: BandRegionCode,
): Bandplan | undefined {
	return bandplansFor(region).find(p => p.id === id)
}

/** Distinct rasters of the ranges (same spacing and channel phase = same raster); the first is the main raster. */
export function rasterUnion(ranges: ScanRange[]): Raster[] {
	const out: Raster[] = []
	const seen = new Set<string>()
	for (const r of ranges) {
		for (const x of r.rasters ?? []) {
			if (!(x.spacingHz > 0)) continue
			const phase =
				((x.firstChannelHz % x.spacingHz) + x.spacingHz) % x.spacingHz
			const key = `${x.spacingHz}:${phase}`
			if (seen.has(key)) continue
			seen.add(key)
			out.push(x)
		}
	}
	return out
}

export function rasterToleranceHz(spacingHz: number): number {
	return Math.max(1000, spacingHz / 4)
}

export function gridToleranceHz(obwHz: number): number {
	return Math.round(Math.max(2000, obwHz / 4) / 500) * 500
}

/** Spec § 5.2: snap the corrected centre (hz − correctionHz) to the nearest channel within tolerance. */
export function snapToRaster(
	hz: number,
	rasters: Raster[],
	correctionHz: number,
): { hz: number; snapped: boolean } {
	const corrected = hz - correctionHz
	let best: { hz: number; d: number; spacing: number } | null = null
	for (const r of rasters) {
		if (!(r.spacingHz > 0)) continue
		const ch = Math.round(
			r.firstChannelHz +
				Math.round((corrected - r.firstChannelHz) / r.spacingHz) * r.spacingHz,
		)
		const d = Math.abs(corrected - ch)
		if (d > rasterToleranceHz(r.spacingHz)) continue
		const better =
			best === null ||
			d < best.d ||
			(d === best.d &&
				(r.spacingHz > best.spacing ||
					(r.spacingHz === best.spacing && ch < best.hz)))
		if (better) best = { hz: ch, d, spacing: r.spacingHz }
	}
	return best
		? { hz: best.hz, snapped: true }
		: { hz: corrected, snapped: false }
}

/** `r:<channel Hz>` for snapped centres, `g:<grid Hz>` (fixed grid, pure function of the centre) otherwise. */
export function frequencyKey(
	hz: number,
	snapped: boolean,
	obwHz: number,
): string {
	if (snapped) return `r:${Math.round(hz)}`
	const tol = gridToleranceHz(obwHz)
	return `g:${Math.round(hz / tol) * tol}`
}

export function priorsFor(
	ranges: ScanRange[],
	hz: number,
): Partial<Record<ScannerProtocol, number>> {
	// Scanner-redesign 3.12: the narrowest covering range that lists protocols decides (ties: stack order).
	let chosen: readonly ScannerProtocol[] | null = null
	let width = Infinity
	for (const r of ranges) {
		if (hz < r.startHz || hz > r.endHz) continue
		const list = r.protocols
		if (list === undefined || list.length === 0) continue
		const w = r.endHz - r.startHz
		if (w < width) {
			width = w
			chosen = list
		}
	}
	if (chosen === null) return {}
	const listed = new Set<ScannerProtocol>(chosen)
	const out: Partial<Record<ScannerProtocol, number>> = {
		carrier: 1,
		unknown: 1,
		"digital-unknown": 1,
	}
	for (const p of SPECIFIC_PROTOCOLS) out[p] = listed.has(p) ? 1 : SOFT_PRIOR
	return out
}
