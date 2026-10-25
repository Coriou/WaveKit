/**
 * Channel-granular ambient association. rtl_433 reads a whole channel on
 * stdin and its JSON carries no frequency, so its decode names the channel's
 * passband, not a point. Rule (exactly one): the decode is credited only when
 * exactly one observation qualifies (same source, track centre inside the
 * passband with edges included, lifetime paired with the decode time). With
 * none or several there is no way to tell which signal the device was, so
 * nothing is identified.
 */
import { z } from "zod"
import type { TrackSnapshot } from "../../spectrum/types.js"
import { RTL433_TARGET_SAMPLE_RATE_MAX_HZ } from "../../../decoders/options/rtl433.js"

export interface ChannelPassband {
	centreHz: number
	/** Half the two-sided passband, > 0. */
	halfHz: number
}

/**
 * Largest half passband accepted: an rtl_433 channel is at most
 * RTL433_TARGET_SAMPLE_RATE_MAX_HZ wide (3.2 MHz), so half is 1.6 MHz.
 * Anything wider is malformed and gives no passband (fail closed).
 */
export const AMBIENT_CHANNEL_MAX_HALF_HZ = RTL433_TARGET_SAMPLE_RATE_MAX_HZ / 2

const BindingSchema = z.object({
	sourceId: z.string().min(1).max(256),
	channelHz: z.number().finite().positive(),
})

/**
 * The passband a channel decoder's output names: the output's placement
 * binding (`provenanceBinding.channelHz`) and the decoder's two-sided
 * channel bandwidth. Null when either is missing or malformed. Pure.
 */
export function channelPassbandOf(
	binding: unknown,
	bandwidthHz: unknown,
): (ChannelPassband & { sourceId: string }) | null {
	const parsed = BindingSchema.safeParse(binding)
	if (!parsed.success) return null
	if (
		typeof bandwidthHz !== "number" ||
		!Number.isFinite(bandwidthHz) ||
		bandwidthHz <= 0 ||
		bandwidthHz / 2 > AMBIENT_CHANNEL_MAX_HALF_HZ
	)
		return null
	return {
		sourceId: parsed.data.sourceId,
		centreHz: parsed.data.channelHz,
		halfHz: bandwidthHz / 2,
	}
}

/** The observation fields the association reads (structural subset of LiveObservation). */
export interface ChannelCandidate {
	observationId: string
	sourceId: string
	startedAt: number
	endedAt?: number | undefined
	lastTrack: Pick<TrackSnapshot, "centreHz"> | null
}

/**
 * The only observation a channel decode at `at` can name, or null when none
 * or more than one qualifies. `pairMs`
 * widens each observation's lifetime on both sides; an open observation
 * ends at `now`. Pure.
 */
export function pickChannelObservation<T extends ChannelCandidate>(
	candidates: readonly T[],
	e: { sourceId: string; passband: ChannelPassband; at: number },
	now: number,
	pairMs: number,
): T | null {
	let only: T | null = null
	for (const o of candidates) {
		const t = o.lastTrack
		if (o.sourceId !== e.sourceId || !t) continue
		if (Math.abs(t.centreHz - e.passband.centreHz) > e.passband.halfHz) continue
		if (e.at < o.startedAt - pairMs || e.at > (o.endedAt ?? now) + pairMs)
			continue
		if (only) return null
		only = o
	}
	return only
}
