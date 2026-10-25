/**
 * WG15 DQ req 3.1, 3.5: level-and-bandwidth compatibility of two signals. Pure; O(1).
 */
import {
	DQ_LEVEL_SPLIT_DB,
	DQ_MIN_HISTORY_OBS,
	DQ_OBW_SPLIT_RATIO,
} from "../detection-quality-contract.js"

/** One side: an observation (`count` = Infinity) or a record's medians over its last 64. */
export interface CompatibilitySide {
	peakDbfs: number
	obwHz: number
	count: number
}

/**
 * Null when either side has fewer than `DQ_MIN_HISTORY_OBS` observations or a non-finite peak or
 * OBW (3.5: undecided); false when the peaks differ by at least 20 dB AND the wider OBW is at
 * least 1.5 times the narrower (3.1); true otherwise.
 */
export function compatible(
	a: CompatibilitySide,
	b: CompatibilitySide,
): boolean | null {
	if (!(a.count >= DQ_MIN_HISTORY_OBS) || !(b.count >= DQ_MIN_HISTORY_OBS))
		return null
	if (
		!Number.isFinite(a.peakDbfs) ||
		!Number.isFinite(b.peakDbfs) ||
		!Number.isFinite(a.obwHz) ||
		!Number.isFinite(b.obwHz)
	)
		return null
	const level = Math.abs(a.peakDbfs - b.peakDbfs) >= DQ_LEVEL_SPLIT_DB
	const wide = Math.max(a.obwHz, b.obwHz)
	const narrow = Math.min(a.obwHz, b.obwHz)
	return !(level && wide >= DQ_OBW_SPLIT_RATIO * narrow)
}

/** A record for the two-record test: its medians and its (last 1 or 2, when young) observations. */
export interface CompatibilityRecord {
	medians: CompatibilitySide
	observations: readonly { peakDbfs: number; obwHz: number }[]
}

const asObservation = (o: {
	peakDbfs: number
	obwHz: number
}): CompatibilitySide => ({
	peakDbfs: o.peakDbfs,
	obwHz: o.obwHz,
	count: Number.POSITIVE_INFINITY,
})

/** The sides that stand for a record: its medians when established, else each observation. */
function sidesOf(r: CompatibilityRecord): readonly CompatibilitySide[] {
	return r.medians.count >= DQ_MIN_HISTORY_OBS
		? [r.medians]
		: r.observations.map(asObservation)
}

/**
 * Two records (3.2), or an observation against a record (pass the observation as a record with
 * `count` Infinity). An established record (3 or more) is its medians; a young one (1 or 2) is
 * each of its observations, judged as the sticky test judges an observation, so neither sticky
 * nor settle can put two observations together that 3.1 separates (Property 9). False when any
 * pair is refused; null when no pair could be decided (3.5: merge as before); true otherwise.
 */
export function recordsCompatible(
	a: CompatibilityRecord,
	b: CompatibilityRecord,
): boolean | null {
	let decided = false
	for (const x of sidesOf(a))
		for (const y of sidesOf(b)) {
			const c = compatible(x, y)
			if (c === false) return false
			if (c === true) decided = true
		}
	return decided ? true : null
}
