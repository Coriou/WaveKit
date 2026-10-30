import type { DecoderBandRequirements } from "../band-resolver.js"
import type { PlannerVfo, WantedPlacement } from "./contract.js"

/**
 * How far the tuned frequency may sit from a decoder's target and still be
 * "its" band: 200 kHz, the same offset readsb accepts from 1090 MHz
 * (READSB_REACH_HZ). It is 1/12 of a 2.4 Msps waterfall, about the error of
 * tuning by eye, and smaller than the 409.6 kHz half-window of the narrowest
 * common capture (1.024 Msps × 0.8 usable / 2), so "tuned" stays stricter than
 * "in view".
 */
export const TUNED_TARGET_TOLERANCE_HZ = 200_000

const positive = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0

/**
 * The frequency the operator tuned on a source: the settled VFO when it is on
 * that source, else the capture centre. Null when neither is a valid frequency.
 */
export function tunedFrequencyHz(
	sourceId: string,
	centreHz: number | null | undefined,
	vfo: PlannerVfo | null | undefined,
): number | null {
	if (vfo && vfo.sourceId === sourceId && positive(vfo.frequencyHz))
		return vfo.frequencyHz
	return positive(centreHz) ? centreHz : null
}

/**
 * True when the decoder's band contains the tuned frequency: within
 * TUNED_TARGET_TOLERANCE_HZ of a target, between the lowest and highest
 * target (a channel cluster such as VDL2's), or inside a range widened by the
 * tolerance. An unknown band, a malformed band or no tuned frequency is never
 * tuned: the safe answer keeps today's admission order.
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
		targets.length > 1 &&
		tunedHz >= Math.min(...targets) - tol &&
		tunedHz <= Math.max(...targets) + tol
	)
		return true
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
