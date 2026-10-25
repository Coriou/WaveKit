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

/**
 * Req 9.4: an observation against a record. Established (3 or more): its medians. Young (1 or 2):
 * each of its observations as a single observation; false when any refuses, null only when every
 * test is undecided (non-finite values, 3.5), true otherwise. At most 2 `compatible` calls.
 */
export function observationCompatible(
	record: CompatibilityRecord,
	obs: { peakDbfs: number; obwHz: number },
): boolean | null {
	const self = asObservation(obs)
	if (record.medians.count >= DQ_MIN_HISTORY_OBS)
		return compatible(record.medians, self)
	let decided = false
	for (const o of record.observations) {
		const c = compatible(asObservation(o), self)
		if (c === false) return false
		if (c === true) decided = true
	}
	return decided ? true : null
}

/**
 * Two records (3.2, 9.4). Both established (3 or more observations): their medians. One
 * established and the other young (1 or 2): each young observation against the established
 * medians, as the sticky test judged them, so settle cannot fold back what sticky refused. Both
 * young: every pair of their observations (at most 2 x 2). False when any test refuses; null only
 * when every test is undecided.
 */
export function recordsCompatible(
	a: CompatibilityRecord,
	b: CompatibilityRecord,
): boolean | null {
	const aOld = a.medians.count >= DQ_MIN_HISTORY_OBS
	const bOld = b.medians.count >= DQ_MIN_HISTORY_OBS
	if (aOld && bOld) return compatible(a.medians, b.medians)
	if (!aOld && !bOld) {
		let decided = false
		for (const o of a.observations) {
			const c = observationCompatible(b, o)
			if (c === false) return false
			if (c === true) decided = true
		}
		return decided ? true : null
	}
	const [old, young] = aOld ? [a, b] : [b, a]
	let decided = false
	for (const o of young.observations) {
		const c = compatible(old.medians, asObservation(o))
		if (c === false) return false
		if (c === true) decided = true
	}
	return decided ? true : null
}
