/** Point decodes require occupied-span containment. Nested channel fragments take
 * precedence; unrelated reaching discoveries remain ambiguous. ADS-B alone uses
 * an inclusive nominal-frequency centre tolerance with nearest-wins; different
 * discoveries tied within 1 Hz receive nothing. */
import type { ScannerProtocol } from "../types.js"
import type { ChannelCandidate } from "./ambient-channel.js"

/** Nominal protocol widths for metadata/tests; point placement uses measured OBW.
 * ADS-B's 500 kHz centre tolerance covers 54.5 kHz at 50 ppm plus 445.5 kHz
 * burst-centre error, below a quarter of a 0.5 µs pulse's ±2 MHz spread.
 */
export const AMBIENT_CHANNEL_WIDTH_HZ: Readonly<Record<string, number>> =
	Object.freeze({
		ais: 25_000,
		acars: 25_000,
		vdl2: 25_000,
		lora: 125_000,
		adsb: 1_000_000,
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
 * Placement tolerance: 1 kHz decoder/raster agreement + 1.5 kHz measured-centre
 * error = 2.5 kHz. Including the 1.5 kHz minimum half-span, the added
 * reach beyond measured OBW/2 is at most 4 kHz, strictly below half the
 * tightest 12.5 kHz raster (6.25 kHz).
 * Point protocols, including 25 kHz AIS/ACARS/VDL2 and wide LoRa, must contain
 * the decode in the measured occupied span, widened by this tolerance. A
 * merged track may contain several channels; prefer a nested channel fragment.
 * ADS-B alone retains its nominal-frequency centre tolerance.
 */
export const AMBIENT_PLACEMENT_TOLERANCE_HZ = 2_500

export function ambientReachHz(
	protocol: ScannerProtocol | null,
	obwHz: number,
): number {
	if (protocol === "adsb") return 500_000
	const half = Number.isFinite(obwHz) && obwHz > 0 ? obwHz / 2 : 0
	return (
		Math.max(AMBIENT_VFO_MIN_REACH_HZ, half) +
		(protocol === null ? 0 : AMBIENT_PLACEMENT_TOLERANCE_HZ)
	)
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
		// ADS-B placement serves Identify/confirmation scopes only; discovery ownership is the anchor.
		const distance = Math.abs(t.centreHz - e.hz)
		const reach = ambientReachHz(e.protocol, t.obwHz)
		// ADS-B keeps its inclusive centre tolerance; point decodes are exclusive.
		if (!(e.protocol === "adsb" ? distance <= reach : distance < reach))
			continue
		reaching.push({ o, distance })
	}
	if (reaching.length === 0) return []
	if (e.protocol === "adsb") return nearestAdsb(reaching, onAmbiguous)
	let matches = reaching.map(r => r.o)
	const sharedDiscovery = matches[0]!.discoveryId
	if (
		typeof sharedDiscovery === "string" &&
		matches.every(o => o.discoveryId === sharedDiscovery)
	)
		return matches
	// The smallest reaching occupied span wins only when it is nested in all
	// others. Equal/non-nested signals remain ambiguous, regardless of distance.
	if (matches.length > 1) {
		const narrow = matches.reduce((a, b) =>
			a.lastTrack!.obwHz <= b.lastTrack!.obwHz ? a : b,
		)
		const t = narrow.lastTrack!
		if (
			Number.isFinite(t.obwHz) &&
			t.obwHz >= 0 &&
			matches.every(o => {
				const other = o.lastTrack!
				return (
					other.centreHz - other.obwHz / 2 <= t.centreHz - t.obwHz / 2 &&
					other.centreHz + other.obwHz / 2 >= t.centreHz + t.obwHz / 2
				)
			})
		) {
			matches = matches.filter(
				o =>
					o.lastTrack!.centreHz === t.centreHz &&
					o.lastTrack!.obwHz === t.obwHz,
			)
		}
	}
	if (matches.length === 1) return matches
	const discoveryId = matches[0]!.discoveryId
	if (
		typeof discoveryId === "string" &&
		matches.every(o => o.discoveryId === discoveryId)
	)
		return matches
	onAmbiguous?.()
	return []
}

/**
 * Tie width for ADS-B placement: 1 Hz. Track centres and decode frequencies are whole-Hz
 * estimates, so two distances within 1 Hz are indistinguishable.
 */
export const AMBIENT_PLACEMENT_TIE_HZ = 1

/**
 * ADS-B placement, unchanged from the earlier rule: the nearest reaching track wins; candidates
 * tied within AMBIENT_PLACEMENT_TIE_HZ are all named only when they share one discovery.
 */
function nearestAdsb<T extends PlacementCandidate>(
	reaching: readonly { o: T; distance: number }[],
	onAmbiguous?: () => void,
): T[] {
	let nearest = Infinity
	for (const r of reaching) nearest = Math.min(nearest, r.distance)
	const tied = reaching
		.filter(r => r.distance - nearest <= AMBIENT_PLACEMENT_TIE_HZ)
		.map(r => r.o)
	if (tied.length === 1) return tied
	const discoveryId = tied[0]!.discoveryId
	if (
		typeof discoveryId === "string" &&
		tied.every(o => o.discoveryId === discoveryId)
	)
		return tied
	onAmbiguous?.()
	return []
}
