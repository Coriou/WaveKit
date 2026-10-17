/**
 * Known-protocol miss eligibility of a replay trial (WG11 req 1.8, 6.4; review m3 and MAJOR f),
 * shared by the replay queue's sink and identify's replay runs. A replay that decoded nothing
 * counts a miss only when the capture held the decoder's whole hold without a gap: gapSamples 0
 * and durationMs ≥ the trial mode's holdMs (e.g. DMR on dsd-fme auto: 1 800 ms of a capture of at
 * most 4 000 ms). A replay runs faster than real time, so its wall clock says nothing: only the
 * capture's own length counts. An unknown capture or hold is no miss.
 */
import type { IqCaptureView } from "../scanner/iq-capture-contract.js"

export function replayMissEligible(
	capture: Pick<IqCaptureView, "gapSamples" | "durationMs"> | null | undefined,
	holdMs: number | null | undefined,
): boolean {
	return (
		capture !== null &&
		capture !== undefined &&
		typeof holdMs === "number" &&
		Number.isFinite(holdMs) &&
		holdMs > 0 &&
		capture.gapSamples === 0 &&
		capture.durationMs >= holdMs
	)
}
