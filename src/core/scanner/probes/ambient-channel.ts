/**
 * Channel-granular ambient association. rtl_433 reads a whole channel or the
 * whole capture on stdin, so its decode names that passband, not a point.
 * Rule (exactly one): the decode is credited only when exactly one
 * observation qualifies (same source, track centre inside the passband with
 * edges included, lifetime paired with the decode time). With none or several
 * there is no way to tell which signal the device was, so nothing is
 * identified. When rtl_433 reports a usable frequency estimate (see
 * rtl433FreqHz), a qualifying observation must also lie within
 * RTL433_FREQ_TOLERANCE_HZ plus half its own bandwidth of it.
 */
import { z } from "zod"
import { rtl433FrequencyMhz } from "../../activity/provenance/resolve.js"
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

const WindowBindingSchema = z.object({
	sourceId: z.string().min(1).max(256),
	channelHz: z.null(),
})

/**
 * The passband of a window-reach output (binding `channelHz: null`): the
 * whole capture, centre ± rate / 2. Null when the binding or the capture is
 * malformed or the half width passes AMBIENT_CHANNEL_MAX_HALF_HZ. Pure.
 */
export function windowPassbandOf(
	binding: unknown,
	capture: { centreHz: unknown; sampleRateHz: unknown },
): (ChannelPassband & { sourceId: string }) | null {
	const parsed = WindowBindingSchema.safeParse(binding)
	if (!parsed.success) return null
	const { centreHz, sampleRateHz } = capture
	if (
		typeof centreHz !== "number" ||
		!Number.isFinite(centreHz) ||
		centreHz <= 0 ||
		typeof sampleRateHz !== "number" ||
		!Number.isFinite(sampleRateHz) ||
		sampleRateHz <= 0 ||
		sampleRateHz / 2 > AMBIENT_CHANNEL_MAX_HALF_HZ
	)
		return null
	return { sourceId: parsed.data.sourceId, centreHz, halfHz: sampleRateHz / 2 }
}

/**
 * Tolerance between rtl_433's frequency estimate and a track centre, plus half
 * the track's bandwidth. Measured with synthetic OOK frames at 1.024 and
 * 2.048 Msps (rtl_433 25.12, `-M level`): within 0.8 of the half rate the
 * estimate erred by at most 56 kHz; 60 kHz covers that.
 */
export const RTL433_FREQ_TOLERANCE_HZ = 60_000

/**
 * Fraction of the passband half width inside which rtl_433's estimate is
 * used. Beyond about 0.85 of the half rate the same measurement erred by up
 * to 230 kHz (and a burst near the capture edge read 0.2 MHz off), so
 * estimates there are ignored and the passband rule applies.
 */
export const RTL433_FREQ_USABLE_FRACTION = 0.8

const FreqSchema = z.number().finite().positive().max(6_000)

/**
 * rtl_433's frequency estimate of a decode in Hz (`freq` in MHz, from
 * `-M level` with `-f`), or undefined when absent, malformed or outside the
 * usable part of `passband`. Pure.
 */
export function rtl433FreqHz(
	data: unknown,
	passband: ChannelPassband,
): number | undefined {
	if (!data || typeof data !== "object") return undefined
	const parsed = FreqSchema.safeParse(rtl433FrequencyMhz(data))
	if (!parsed.success) return undefined
	const hz = parsed.data * 1e6
	return Math.abs(hz - passband.centreHz) <=
		passband.halfHz * RTL433_FREQ_USABLE_FRACTION
		? hz
		: undefined
}

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
	lastTrack: Pick<TrackSnapshot, "centreHz" | "obwHz"> | null
}

/**
 * The only observation a channel decode at `at` can name, or null when none
 * or more than one qualifies. `pairMs`
 * widens each observation's lifetime on both sides; an open observation
 * ends at `now`. Pure.
 */
export function pickChannelObservation<T extends ChannelCandidate>(
	candidates: readonly T[],
	e: {
		sourceId: string
		passband: ChannelPassband
		at: number
		/** rtl_433's usable frequency estimate (rtl433FreqHz). */
		freqHz?: number | undefined
	},
	now: number,
	pairMs: number,
	onAmbiguous?: () => void,
): T | null {
	const qualifying: T[] = []
	for (const o of candidates) {
		const t = o.lastTrack
		if (o.sourceId !== e.sourceId || !t) continue
		if (Math.abs(t.centreHz - e.passband.centreHz) > e.passband.halfHz) continue
		if (e.at < o.startedAt - pairMs || e.at > (o.endedAt ?? now) + pairMs)
			continue
		qualifying.push(o)
	}
	// rtl_433's estimate narrows the choice only when no candidate could be an
	// edge emitter: a device past RTL433_FREQ_USABLE_FRACTION of the half
	// width may report a frequency far from where it is, onto another track.
	// Then (or without an estimate) the plain exactly-one rule decides.
	const freqHz = e.freqHz
	if (
		freqHz === undefined ||
		qualifying.some(
			o =>
				Math.abs(o.lastTrack!.centreHz - e.passband.centreHz) >
				e.passband.halfHz * RTL433_FREQ_USABLE_FRACTION,
		)
	) {
		if (qualifying.length > 1) onAmbiguous?.()
		return qualifying.length === 1 ? qualifying[0]! : null
	}
	let only: T | null = null
	for (const o of qualifying) {
		const t = o.lastTrack!
		if (
			Math.abs(t.centreHz - freqHz) >
			RTL433_FREQ_TOLERANCE_HZ + Math.max(0, t.obwHz) / 2
		)
			continue
		if (only) {
			onAmbiguous?.()
			return null
		}
		only = o
	}
	return only
}
