import type { FreqRange } from "../spectrum/types.js"

/**
 * Confirmed real signals for the spectrum engine's spur masks (spectrum/spur-map.ts): a spur or
 * comb mask never covers the bins of a discovery whose content is confirmed real. Confirmed real
 * is a decode (`decoded` confidence or an identity), a kept recording (the recorder keeps a file
 * only when it holds voice) or a proof. Decode anchors carry no RF extent and never count.
 *
 * The extent is the measured centre ± half the median OBW, widened outward to whole
 * REAL_RANGE_QUANTUM_HZ steps, so the small drift of a median does not resend the masks.
 */
export const REAL_RANGE_QUANTUM_HZ = 1000

export interface RealEvidence {
	anchor?: "decode"
	confidence: string
	identity?: unknown
	evidence: { recordings: number }
	proof?: unknown
	frequencyHz: number
	measuredOffsetHz: number
	bandwidthHz: number
}

export function confirmedRealRange(d: RealEvidence): FreqRange | null {
	if (d.anchor !== undefined) return null
	const real =
		d.confidence === "decoded" ||
		d.identity !== undefined ||
		d.evidence.recordings > 0 ||
		d.proof !== undefined
	if (!real) return null
	const centre = d.frequencyHz + d.measuredOffsetHz
	const half = Math.max(0, d.bandwidthHz) / 2
	if (!Number.isFinite(centre) || !Number.isFinite(half) || centre <= 0)
		return null
	const q = REAL_RANGE_QUANTUM_HZ
	return {
		startHz: Math.floor((centre - half) / q) * q,
		endHz: Math.max(
			Math.ceil((centre + half) / q) * q,
			Math.floor((centre - half) / q) * q + q,
		),
	}
}
