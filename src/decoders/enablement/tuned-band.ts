import type { DecoderBandRequirements } from "../band-resolver.js"
import type { PlannerVfo, WantedPlacement } from "./contract.js"
import { VFO_SETTLE_MS } from "./contract.js"

/**
 * How far the tuned frequency may sit from a decoder's target and still be
 * "its" band: 200 kHz, the same offset readsb accepts from 1090 MHz
 * (READSB_REACH_HZ). It is 1/12 of a 2.4 Msps waterfall, about the error of
 * tuning by eye, and smaller than the 409.6 kHz half-window of the narrowest
 * common capture (1.024 Msps × 0.8 usable / 2), so "tuned" stays stricter than
 * "in view".
 */
export const TUNED_TARGET_TOLERANCE_HZ = 200_000

/**
 * The widest gap between neighbouring targets of one channel cluster: a fixed
 * 2.4 MHz, whatever the source rate (it does not follow the capture width). A
 * cluster's channels share one band (VDL2's span 325 kHz), so the span between
 * them is the band; targets further apart are separate bands, such as the
 * catalogue LoRa decoder's 433 MHz and 869 MHz slots, and the frequencies
 * between them are not its band. A followCenter band is not a cluster: its
 * targets are the edges of the band it follows (bandContainsTuned).
 */
export const TUNED_CLUSTER_MAX_GAP_HZ = 2_400_000

/**
 * True when `hz` lies between two neighbouring targets of one channel cluster
 * (at most TUNED_CLUSTER_MAX_GAP_HZ apart), widened by `reach` at each end.
 * Targets must be positive and finite.
 */
export function clusterHolds(
	targets: readonly number[],
	hz: number,
	reach: number,
): boolean {
	const sorted = [...targets].sort((a, b) => a - b)
	for (let i = 1; i < sorted.length; i++) {
		const lo = sorted[i - 1]!
		const hi = sorted[i]!
		if (
			hi - lo <= TUNED_CLUSTER_MAX_GAP_HZ &&
			hz >= lo - reach &&
			hz <= hi + reach
		)
			return true
	}
	return false
}

/**
 * How long a placement's band must keep holding the tuned frequency before
 * tuning into it releases its holds or restarts a stopped decoder: one VFO
 * settle (VFO_SETTLE_MS = 1000 ms), the dwell the VFO tracker already asks of
 * a VFO move. A settled VFO has held its value for that long when it is
 * reported, so it counts at once; a capture-centre fallback or a VFO read
 * before the first settle waits it out in the manager. A pass across a band on
 * the way elsewhere is not a tune into it.
 */
export const TUNED_SETTLE_MS = VFO_SETTLE_MS

const positive = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0

/**
 * The frequency the operator tuned on a source. The VFO is the live
 * demodulator's frequency on one source (its own, else the default source), so
 * it is the tuned frequency of that source alone: another source, such as a
 * fixed second dongle, is not tuned by its own capture centre while the VFO
 * is elsewhere. Only without a valid VFO does the capture centre of the source
 * a VFO would sit on (`fallbackSourceId`, the default source) stand in for it.
 * Null when nothing was tuned on the source.
 */
export function tunedFrequencyHz(
	sourceId: string,
	centreHz: number | null | undefined,
	vfo: PlannerVfo | null | undefined,
	fallbackSourceId: string | undefined,
): number | null {
	if (vfo && positive(vfo.frequencyHz))
		return vfo.sourceId === sourceId ? vfo.frequencyHz : null
	return sourceId === fallbackSourceId && positive(centreHz) ? centreHz : null
}

/**
 * True when the decoder's band contains the tuned frequency: within
 * TUNED_TARGET_TOLERANCE_HZ of a target, between neighbouring targets of one
 * channel cluster such as VDL2's (clusterHolds; never across the gap between
 * two separate bands), or inside a range widened by the tolerance. A
 * followCenter band decodes the centre itself and its targets are the edges
 * of the band it follows (assessDecoderBand), so it holds the whole span from
 * the lowest to the highest target, widened by the tolerance, however wide.
 * An unknown band, a malformed band or no tuned frequency is never tuned: the
 * safe answer keeps today's admission order.
 */
export function bandContainsTuned(
	band: DecoderBandRequirements | undefined,
	tunedHz: number | null,
): boolean {
	if (!band || !positive(tunedHz)) return false
	const tol = TUNED_TARGET_TOLERANCE_HZ
	const targets = Array.isArray(band.targetsHz)
		? band.targetsHz.filter(positive)
		: []
	if (targets.some(t => Math.abs(t - tunedHz) <= tol)) return true
	if (
		band.followCenter === true &&
		targets.length > 1 &&
		tunedHz >= Math.min(...targets) - tol &&
		tunedHz <= Math.max(...targets) + tol
	)
		return true
	if (clusterHolds(targets, tunedHz, tol)) return true
	const ranges = Array.isArray(band.rangesHz) ? band.rangesHz : []
	return ranges.some(
		r =>
			r != null &&
			positive(r.minHz) &&
			positive(r.maxHz) &&
			r.minHz <= r.maxHz &&
			tunedHz >= r.minHz - tol &&
			tunedHz <= r.maxHz + tol,
	)
}

/**
 * Marks the placements whose decoder's band holds their source's tuned
 * frequency and moves them to the front, keeping the planner's order within
 * each group (a stable partition), so tuned placements are admitted first.
 */
export function prioritiseTuned(
	wanted: readonly WantedPlacement[],
	isTuned: (placement: WantedPlacement) => boolean,
): WantedPlacement[] {
	const tuned: WantedPlacement[] = []
	const rest: WantedPlacement[] = []
	for (const placement of wanted) {
		let hit = false
		try {
			hit = isTuned(placement) === true
		} catch {
			hit = false
		}
		if (hit) tuned.push({ ...placement, tunedBand: true })
		else if (placement.tunedBand === undefined) rest.push(placement)
		else {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { tunedBand, ...plain } = placement
			rest.push(plain)
		}
	}
	return [...tuned, ...rest]
}
