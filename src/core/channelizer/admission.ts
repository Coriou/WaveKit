import { WaveKitError } from "../../utils/errors.js"
import type { DecoderChannelRequest } from "./types.js"

/**
 * Slack, in Hz, on both admission inequalities (addendum §12.2, Review Focus 1). Mirrors
 * `ADMISSION_EPSILON_HZ` in native/wavekit-chan/src/plan.rs, which the process's admission.rs
 * re-exports: the §2 default passband (bw = out·(1−t), tr = out·t/2) can round one ulp past out/2.
 */
export const ADMISSION_EPSILON_HZ = 1e-6

interface AdmissionRejection {
	admitted: false
	reasonCode: "channel-outside-capture" | "channel-request-invalid"
	detail: string
}
export type AdmissionVerdict =
	| { admitted: true; offsetHz: number }
	| AdmissionRejection

const invalid = (detail: string): AdmissionVerdict => ({
	admitted: false,
	reasonCode: "channel-request-invalid",
	detail,
})

/**
 * Pure. Never touches a tuner. Same check order and arithmetic as native/wavekit-chan/src/admission.rs
 * (Property 1); the integer-rate and gain checks are the ones the process makes while parsing the
 * `open` request (protocol.rs), so they also classify as `channel-request-invalid` ahead of the span.
 * A usable fraction outside (0, 1] is a caller bug (config allows 0.5–0.95), so it throws.
 */
export function admitChannel(
	req: DecoderChannelRequest,
	capture: { sampleRateHz: number; centerHz: number },
	usableFraction: number,
): AdmissionVerdict {
	if (!(usableFraction > 0 && usableFraction <= 1))
		throw new WaveKitError(
			`usableFraction must be within (0, 1], got ${usableFraction}`,
			"CHANNELIZER_USABLE_FRACTION_INVALID",
		)
	const finite = [
		req.centerHz,
		req.bandwidthHz,
		req.transitionHz,
		capture.centerHz,
	].every(Number.isFinite)
	if (!finite) return invalid("non-finite request")
	if (
		!Number.isInteger(req.outputRateHz) ||
		!Number.isInteger(capture.sampleRateHz)
	)
		return invalid("rates must be integers")
	if (
		req.bandwidthHz <= 0 ||
		req.transitionHz <= 0 ||
		req.outputRateHz <= 0 ||
		req.outputRateHz > capture.sampleRateHz
	)
		return invalid(
			`bandwidth/transition must be > 0 and output rate within 1..=${capture.sampleRateHz}`,
		)
	if (
		req.gain !== undefined &&
		(req.format !== "cu8" || !(req.gain > 0) || !Number.isFinite(req.gain))
	)
		return invalid("gain is cu8 only and must be > 0")
	const halfOccupied = req.bandwidthHz / 2 + req.transitionHz
	if (halfOccupied > req.outputRateHz / 2 + ADMISSION_EPSILON_HZ)
		return invalid(
			`bw/2+tr=${halfOccupied} exceeds out/2=${req.outputRateHz / 2}`,
		)
	const offsetHz = req.centerHz - capture.centerHz
	const limit = (capture.sampleRateHz * usableFraction) / 2
	if (Math.abs(offsetHz) + halfOccupied > limit + ADMISSION_EPSILON_HZ)
		return {
			admitted: false,
			reasonCode: "channel-outside-capture",
			detail: `|Δf|+bw/2+tr=${Math.abs(offsetHz) + halfOccupied} exceeds usable half-span ${limit}`,
		}
	return { admitted: true, offsetHz }
}
