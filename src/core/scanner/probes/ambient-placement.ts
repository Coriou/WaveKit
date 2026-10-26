/**
 * Point ambient association: keep every time/source/channel match only when they all
 * belong to one discovery. Multiple discoveries are ambiguous unless exactly one track span encloses all
 * reaching spans. Callers supply the indexed frequency window (O(k) matching over its k tracks).
 */
import { SCANNER_AMBIENT_TARGET_TOLERANCE_HZ } from "@wavekit/api-types"
import type { ScannerProtocol } from "../types.js"
import type { ChannelCandidate } from "./ambient-channel.js"

/**
 * Channel width of each ambient-only decoder. AIS, ACARS and VDL2 use a 25 kHz channel
 * raster (half: 12.5 kHz). Meshtastic LoRa uses 125 or 250 kHz; the narrower 125 kHz
 * (half: 62.5 kHz) is used so a placement never reaches past a real channel. ADS-B: readsb
 * reports no frequency of its own, so the decode sits at the nominal 1090 MHz and the reach is a
 * tolerance on the track's measured centre, not a spectrum width. Width 1 MHz, so the reach is
 * 500 kHz: a 50 ppm tuning error is 1090 MHz × 50e-6 = 54.5 kHz, and the centre the detector
 * measures on a short pulse-position burst may sit off the carrier by a fraction of its spread
 * (a 0.5 µs pulse has its first spectral nulls at ±1 / 0.5 µs = ±2 MHz); 500 kHz leaves
 * 500 − 54.5 = 445.5 kHz for that centre error, under a quarter of the ±2 MHz spread. The nearest other allocation, the 1030 MHz
 * interrogation uplink, is 60 MHz away, so nothing else lies within the reach.
 */
export const AMBIENT_CHANNEL_WIDTH_HZ: Readonly<Record<string, number>> =
	Object.freeze({
		ais: 25_000,
		acars: 25_000,
		vdl2: 25_000,
		lora: 125_000,
		adsb: 1_000_000,
		// Point decoders reach half their channel width: 25 / 2 = 12.5 kHz for
		// APRS/paging, 12.5 / 2 = 6.25 kHz for digital voice, and 6.25 / 2
		// = 3.125 kHz for the narrow digital voice modes.
		aprs: 25_000,
		pocsag: 25_000,
		flex: 25_000,
		dmr: 12_500,
		p25p1: 12_500,
		p25p2: 12_500,
		ysf: 12_500,
		nxdn96: 12_500,
		dpmr: 6_250,
		nxdn48: 6_250,
		dstar: 6_250,
	})

/** Least reach of a VFO-targeted ambient decoder (unchanged WG7 rule): 1.5 kHz. */
export const AMBIENT_VFO_MIN_REACH_HZ = 1500

/**
 * Reach of a decode of `protocol` towards a track of `obwHz` (see the module rule). An
 * ambient-only protocol: max(1 kHz, channel width / 2). Otherwise max(1.5 kHz, obwHz / 2);
 * a non-finite or negative width counts as 0.
 */
export function ambientReachHz(
	protocol: ScannerProtocol | null,
	obwHz: number,
): number {
	const width =
		protocol !== null && Object.hasOwn(AMBIENT_CHANNEL_WIDTH_HZ, protocol)
			? AMBIENT_CHANNEL_WIDTH_HZ[protocol]
			: undefined
	if (width !== undefined)
		return Math.max(SCANNER_AMBIENT_TARGET_TOLERANCE_HZ, width / 2)
	const half = Number.isFinite(obwHz) && obwHz > 0 ? obwHz / 2 : 0
	return Math.max(AMBIENT_VFO_MIN_REACH_HZ, half)
}

export interface PlacementCandidate extends ChannelCandidate {
	discoveryId?: string | null | undefined
}

/** The observations a point decode names (see the module rule); [] when none or ambiguous. */
export function placeAmbientDecode<T extends PlacementCandidate>(
	candidates: Iterable<T>,
	e: {
		sourceId: string
		hz: number
		at: number
		protocol: ScannerProtocol | null
	},
	now: number,
	pairMs: number,
	onAmbiguous?: () => void,
): T[] {
	if (!Number.isFinite(e.hz) || !Number.isFinite(e.at)) return []
	const reaching: { o: T; distance: number }[] = []
	for (const o of candidates) {
		const t = o.lastTrack
		if (o.sourceId !== e.sourceId || !t || !Number.isFinite(t.centreHz))
			continue
		if (e.at < o.startedAt - pairMs || e.at > (o.endedAt ?? now) + pairMs)
			continue
		const distance = Math.abs(t.centreHz - e.hz)
		if (!(distance <= ambientReachHz(e.protocol, t.obwHz))) continue
		reaching.push({ o, distance })
	}
	if (reaching.length === 0) return []
	const matches = reaching.map(r => r.o)
	if (matches.length === 1) return matches
	const discoveryId = matches[0]!.discoveryId
	if (
		typeof discoveryId === "string" &&
		matches.every(o => o.discoveryId === discoveryId)
	)
		return matches
	// Only a unique enclosing discovery can resolve nested detector fragments.
	// Use extrema once so association remains O(k), including wide burst tracks.
	const lower = (o: T): number => o.lastTrack!.centreHz - o.lastTrack!.obwHz / 2
	const upper = (o: T): number => o.lastTrack!.centreHz + o.lastTrack!.obwHz / 2
	let min = Infinity
	let max = -Infinity
	for (const o of matches) {
		if (!Number.isFinite(o.lastTrack!.obwHz) || o.lastTrack!.obwHz < 0) {
			onAmbiguous?.()
			return []
		}
		min = Math.min(min, lower(o))
		max = Math.max(max, upper(o))
	}
	const enclosing = new Set(
		matches
			.filter(o => lower(o) <= min && upper(o) >= max)
			.map(o => o.discoveryId),
	)
	if (enclosing.size === 1) {
		const only = [...enclosing][0]
		if (typeof only === "string")
			return matches.filter(o => o.discoveryId === only)
	}
	onAmbiguous?.()
	return []
}
