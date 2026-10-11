import type { FreqRange } from "./types.js"

/**
 * Artefact masks (spec § 4.9) as plain data, and the pure question identify mode (§ 10.8) asks
 * of them: is this frequency an artefact rather than an emission? SpectrumPipeline.artefactMasks()
 * (Task 10) builds the masks for the current epoch; Task 35a carries them to the main thread.
 */
export type ArtefactKind = "dc" | "spur" | "image" | "rfi"

/** RF extent of a masked spur line, including its ±1-bin Hann skirt. */
export interface ArtefactSpurLine extends FreqRange {
	origin: "baseband" | "provisional" | "comb"
}
/** An IQ-image track flagged in the last block (Task 11a) and the stronger track it mirrors. */
export interface ArtefactImage {
	centreHz: number
	obwHz: number
	partnerHz: number
}
export interface ArtefactRfi {
	/** Periodic broadband RFI is established and recent (ImpulseBlanker.rfi()). */
	active: boolean
	periodMs: number | null
	blankedFrames: number
}
export interface ArtefactMasks {
	sourceId: string
	/** 0 before the first epoch. */
	epoch: number
	centreHz: number
	binHz: number
	usable: FreqRange
	/** max(dcGuardHz, 2 RBW): the DC mask is centreHz ± this (§ 4.5). */
	dcGuardHz: number
	spurs: ArtefactSpurLine[]
	images: ArtefactImage[]
	rfi: ArtefactRfi
	/** RF extent of every tracked segment (after blanking and line filtering) in the last ACTIVITY_HOLD_MS. */
	activity: FreqRange[]
}

export const ACTIVITY_HOLD_MS = 1000
export const RFI_TARGET_TOLERANCE_HZ = 2000

/**
 * The artefact at `centreHz` in `epoch`, or null. First match wins: dc, spur, image, rfi. A DC or
 * spur mask that an emission straddles (activity 1.5 bins outside both edges) is not an artefact
 * there. `rfi` is evidence of absence: RFI is active and nothing non-blanked was seen near the
 * target, so callers that can wait for a signal report it only when the wait finds nothing.
 */
export function artefactOf(
	centreHz: number,
	epoch: number,
	masks: ArtefactMasks,
): ArtefactKind | null {
	if (epoch !== masks.epoch) return null
	const bin = masks.binHz
	const activeNear = (hz: number, tolHz: number): boolean =>
		masks.activity.some(a => hz >= a.startHz - tolHz && hz <= a.endHz + tolHz)
	const straddled = (lo: number, hi: number): boolean =>
		activeNear(lo - 1.5 * bin, bin / 2) && activeNear(hi + 1.5 * bin, bin / 2)
	const dcLo = masks.centreHz - masks.dcGuardHz
	const dcHi = masks.centreHz + masks.dcGuardHz
	if (centreHz >= dcLo && centreHz <= dcHi && !straddled(dcLo, dcHi))
		return "dc"
	for (const s of masks.spurs) {
		if (
			centreHz >= s.startHz - bin / 2 &&
			centreHz <= s.endHz + bin / 2 &&
			!straddled(s.startHz, s.endHz)
		)
			return "spur"
	}
	for (const im of masks.images)
		if (Math.abs(centreHz - im.centreHz) <= Math.max(bin, im.obwHz / 2))
			return "image"
	const usable =
		centreHz >= masks.usable.startHz && centreHz <= masks.usable.endHz
	if (
		masks.rfi.active &&
		usable &&
		!activeNear(centreHz, RFI_TARGET_TOLERANCE_HZ)
	)
		return "rfi"
	return null
}
