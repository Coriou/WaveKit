/**
 * Placement of a point ambient decode on an observation (WG16 SC fix 3c). A decoder reports
 * a frequency; the observation it names is the nearest one whose track reaches that
 * frequency, and none when two different signals are equally near.
 *
 * Rule (pure):
 * - A candidate is an observation of the decode's source with a track whose lifetime, widened
 *   by `pairMs` on both sides (an open one ends at `now`), contains the decode time.
 * - It reaches the decode when |track centre - decode hz| <= the reach. An ambient-only
 *   protocol (AIS, ACARS, VDL2, LoRa) reaches half its decoder's channel width
 *   (AMBIENT_CHANNEL_WIDTH_HZ), at least the 1 kHz decode tolerance: a track centred inside
 *   the decoder's channel is that channel's signal, and one centred outside it (a wide
 *   neighbour whose skirt covers the channel) is not. Any other decoder (a VFO-targeted
 *   multimon-ng, dsd-fme or direwolf) reaches max(1.5 kHz, track OBW / 2), as before.
 * - Of the reaching candidates the nearest wins. Candidates within AMBIENT_PLACEMENT_TIE_HZ of
 *   the nearest distance tie: when every tied candidate belongs to the same discovery they are
 *   all that discovery's observations and all are named; otherwise nothing is named.
 */
import { SCANNER_AMBIENT_TARGET_TOLERANCE_HZ } from "@wavekit/api-types"
import type { ScannerProtocol } from "../types.js"
import type { ChannelCandidate } from "./ambient-channel.js"

/**
 * Channel width of each ambient-only decoder. AIS, ACARS and VDL2 use a 25 kHz channel
 * raster (half: 12.5 kHz). Meshtastic LoRa uses 125 or 250 kHz; the narrower 125 kHz
 * (half: 62.5 kHz) is used so a placement never reaches past a real channel.
 */
export const AMBIENT_CHANNEL_WIDTH_HZ: Readonly<Record<string, number>> =
	Object.freeze({
		ais: 25_000,
		acars: 25_000,
		vdl2: 25_000,
		lora: 125_000,
	})

/** Least reach of a VFO-targeted ambient decoder (unchanged WG7 rule): 1.5 kHz. */
export const AMBIENT_VFO_MIN_REACH_HZ = 1500

/**
 * Tie width: 1 Hz. Track centres and decode frequencies are whole-Hz estimates, so two
 * distances within 1 Hz are indistinguishable.
 */
export const AMBIENT_PLACEMENT_TIE_HZ = 1

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
	let nearest = Infinity
	for (const r of reaching) nearest = Math.min(nearest, r.distance)
	const tied = reaching
		.filter(r => r.distance - nearest <= AMBIENT_PLACEMENT_TIE_HZ)
		.map(r => r.o)
	if (tied.length === 1) return tied
	const discoveryId = tied[0]!.discoveryId
	if (
		typeof discoveryId !== "string" ||
		!tied.every(o => o.discoveryId === discoveryId)
	)
		return []
	return tied
}
