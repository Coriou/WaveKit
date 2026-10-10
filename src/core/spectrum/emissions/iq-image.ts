import type { TrackSnapshot } from "../types.js"

/**
 * Spec § 4.9: an RTL dongle's IQ imbalance mirrors every emission at baseband offset +x to −x,
 * typically 25–45 dB down. B is flagged as A's image when B sits at −offset(A) within
 * max(RBW, toleranceHz), neither is inside the DC guard, their −6 dB OBWs agree within
 * max(30 %, 2 RBW), and B is 20–65 dB below A. An independent emitter within 20 dB of its mirror
 * partner is never flagged.
 */
export type ImageCandidate = Pick<
	TrackSnapshot,
	"trackId" | "centreHz" | "obwHz" | "peakDbfs"
>

export interface IqImageOptions {
	rbwHz: number
	toleranceHz: number
	minRejectionDb: number
	maxRejectionDb: number
	dcGuardHz?: number
}

export const OBW_SIMILARITY = 0.3

export function flagIqImages(
	tracks: readonly ImageCandidate[],
	epochCentreHz: number,
	opts: IqImageOptions,
): Set<string> {
	const tol = Math.max(opts.rbwHz, opts.toleranceHz)
	const guard = Math.max(opts.dcGuardHz ?? 0, tol)
	const out = new Set<string>()
	for (const b of tracks) {
		const ob = b.centreHz - epochCentreHz
		if (Math.abs(ob) <= guard) continue
		for (const a of tracks) {
			if (a === b) continue
			const oa = a.centreHz - epochCentreHz
			if (Math.abs(oa) <= guard || Math.abs(ob + oa) > tol) continue
			if (
				Math.abs(b.obwHz - a.obwHz) >
				Math.max(OBW_SIMILARITY * a.obwHz, 2 * opts.rbwHz)
			)
				continue
			const rejection = a.peakDbfs - b.peakDbfs
			if (rejection < opts.minRejectionDb || rejection > opts.maxRejectionDb)
				continue
			out.add(b.trackId)
			break
		}
	}
	return out
}
