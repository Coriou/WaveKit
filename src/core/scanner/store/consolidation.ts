/**
 * WG15 DQ requirement 7: consolidation of records the store already holds. Pure: the joinable
 * predicate (7.1), the survivor rank (7.2), the bounded nearest walk (7.3 step 2) and the load
 * plan (7.3, 7.4). The store builds the frozen records and applies the plan.
 */
import {
	DQ_CONSOLIDATE_GROUP_MAX,
	DQ_CONSOLIDATE_SCAN_MAX,
	DQ_CROSS_FAMILY_HZ,
	DQ_MIN_HISTORY_OBS,
} from "../detection-quality-contract.js"
import type { ProtocolFamily } from "../types.js"
import { recordsCompatible } from "./compatibility.js"

/** One record's frozen values (read once before planning, never re-read while planning). */
export interface ConsolidationRecord {
	id: string
	sourceId: string
	/** Median centre over the last 64 observations. */
	centreHz: number
	obwHz: number
	/** Req 9.2: smallest and largest finite OBW of the last 64 observations (NaN when none). */
	obwMin: number
	obwMax: number
	/** Req 9.2: `DQ_OBW_RATIO_MAX` when decoded or identified, else `DQ_YOUNG_OBW_RATIO`. */
	bandFactor: number
	peakDbfs: number
	/** Observations in the median window. */
	count: number
	/** The young record's own observations (fewer than 3), for the 3.1 two-record test. */
	young: readonly { peakDbfs: number; obwHz: number }[]
	identity?: { kind: string; value: string } | undefined
	/** Req 9.1: association family (the effective family only when decoded, identified or proven). */
	family: ProtocolFamily
	/** Effective confidence is `decoded`. */
	decoded: boolean
	/** Effective protocol. */
	protocol: string
	firstSeenAt: string
	hasOperator: boolean
}

export interface ConsolidationGroup {
	survivor: string
	/** Selection order (nearest first, ties by id). */
	members: string[]
}

export interface ConsolidationPlan {
	groups: ConsolidationGroup[]
	/** Survivors whose scan or group bound cut the result short (7.4). */
	truncated: number
}

const LOOSE_FAMILIES: ReadonlySet<ProtocolFamily> = new Set<ProtocolFamily>([
	"unknown",
	"carrier",
])

const compareText = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0

/** Req 7.2: decoded first, then earliest `firstSeenAt`, then smaller id. Negative = `a` above. */
export function rankCompare(
	a: Pick<ConsolidationRecord, "decoded" | "firstSeenAt" | "id">,
	b: Pick<ConsolidationRecord, "decoded" | "firstSeenAt" | "id">,
): number {
	if (a.decoded !== b.decoded) return a.decoded ? -1 : 1
	return compareText(a.firstSeenAt, b.firstSeenAt) || compareText(a.id, b.id)
}

/** DQ 9.8: a malformed identity is different from every other identity. */
function sameWellFormedIdentity(
	a: { kind: string; value: string },
	b: { kind: string; value: string },
): boolean {
	const x = a as { kind?: unknown; value?: unknown } | null
	const y = b as { kind?: unknown; value?: unknown } | null
	if (x === null || y === null) return false
	if (typeof x.kind !== "string" || typeof x.value !== "string") return false
	return x.kind === y.kind && x.value === y.value
}

const finitePositive = (x: number): boolean => Number.isFinite(x) && x > 0

/**
 * Req 9.2: does `obwHz` lie in the band `[obwMin / f, obwMax x f]`? False on any non-finite or
 * non-positive input (9.8).
 */
export function inObwBand(
	obwHz: number,
	obwMin: number,
	obwMax: number,
	factor: number,
): boolean {
	if (
		!finitePositive(obwHz) ||
		!finitePositive(obwMin) ||
		!finitePositive(obwMax) ||
		!finitePositive(factor)
	)
		return false
	return obwHz >= obwMin / factor && obwHz <= obwMax * factor
}

/** Req 7.1, 7.9, 9.6: are two records one emitter? Pure, O(1). */
export function joinable(
	a: ConsolidationRecord,
	b: ConsolidationRecord,
): boolean {
	if (a.id === b.id || a.sourceId !== b.sourceId) return false
	if (a.hasOperator || b.hasOperator) return false
	if (!Number.isFinite(a.centreHz) || !Number.isFinite(b.centreHz)) return false
	if (Math.abs(a.centreHz - b.centreHz) > DQ_CROSS_FAMILY_HZ) return false
	// 9.6: each median OBW in the other's band (9.2, each record's own factor).
	if (!inObwBand(a.obwHz, b.obwMin, b.obwMax, b.bandFactor)) return false
	if (!inObwBand(b.obwHz, a.obwMin, a.obwMax, a.bandFactor)) return false
	if (!Number.isFinite(a.peakDbfs) || !Number.isFinite(b.peakDbfs)) return false
	if (
		a.identity !== undefined &&
		b.identity !== undefined &&
		!sameWellFormedIdentity(a.identity, b.identity)
	)
		return false
	if (
		a.family !== b.family &&
		!LOOSE_FAMILIES.has(a.family) &&
		!LOOSE_FAMILIES.has(b.family)
	)
		return false
	if (a.decoded && b.decoded && a.protocol !== b.protocol) return false
	const c = recordsCompatible(
		{
			medians: { peakDbfs: a.peakDbfs, obwHz: a.obwHz, count: a.count },
			observations: a.count >= DQ_MIN_HISTORY_OBS ? [] : a.young,
		},
		{
			medians: { peakDbfs: b.peakDbfs, obwHz: b.obwHz, count: b.count },
			observations: b.count >= DQ_MIN_HISTORY_OBS ? [] : b.young,
		},
	)
	if (c === false) return false
	// 7.9: undecided is joinable only for two young records (3.5).
	if (c === null)
		return a.count < DQ_MIN_HISTORY_OBS && b.count < DQ_MIN_HISTORY_OBS
	return true
}

/** Ascending (centre, id); the order `nearest` expects. */
export function compareCentre(
	a: { centreHz: number; id: string },
	b: { centreHz: number; id: string },
): number {
	return a.centreHz - b.centreHz || compareText(a.id, b.id)
}

/**
 * Req 7.3 step 2: the `k` entries of `sorted` (ascending by centre then id, finite centres) nearest
 * to `centreHz` within `radiusHz`, nearest first (ties: smaller id). O(log n + k).
 */
export function nearest<T extends { centreHz: number; id: string }>(
	sorted: readonly T[],
	centreHz: number,
	radiusHz: number,
	k: number,
): T[] {
	const out: T[] = []
	if (!Number.isFinite(centreHz) || k <= 0) return out
	// First index whose centre is >= c (strict = false) or > c (strict = true).
	const bound = (c: number, strict: boolean): number => {
		let lo = 0
		let hi = sorted.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			const e = sorted[mid]
			if (e !== undefined && (e.centreHz < c || (strict && e.centreHz === c)))
				lo = mid + 1
			else hi = mid
		}
		return lo
	}
	let left = bound(centreHz, false) - 1
	let right = left + 1
	// Each step takes the entries at the next smallest distance: a run of equal centres on each
	// side (ascending ids within a run), merged in id order, so ties go to the smaller id on
	// either side. Runs are located by binary search: O(log n + k) whatever the density.
	while (out.length < k) {
		const l = left >= 0 ? sorted[left] : undefined
		const r = right < sorted.length ? sorted[right] : undefined
		const dl = l === undefined ? Infinity : centreHz - l.centreHz
		const dr = r === undefined ? Infinity : r.centreHz - centreHz
		const d = Math.min(dl, dr)
		if (!(d <= radiusHz)) break
		let li = -1
		let lEnd = -1
		if (l !== undefined && dl === d) {
			li = bound(l.centreHz, false)
			lEnd = left
			left = li - 1
		}
		let ri = -1
		let rEnd = -1
		if (r !== undefined && dr === d) {
			ri = right
			rEnd = bound(r.centreHz, true) - 1
			right = rEnd + 1
		}
		while (out.length < k) {
			const x = li >= 0 && li <= lEnd ? sorted[li] : undefined
			const y = ri >= 0 && ri <= rEnd ? sorted[ri] : undefined
			if (x === undefined && y === undefined) break
			if (y === undefined || (x !== undefined && x.id < y.id)) {
				if (x !== undefined) out.push(x)
				li++
			} else {
				out.push(y)
				ri++
			}
		}
	}
	return out
}

/** Optional counter, for the bound tests (7.8). */
export interface PlanProbe {
	checks: number
}

/** Req 7.3, 7.4: the load plan over frozen records. Deterministic and input-order independent. */
export function planConsolidation(
	input: readonly ConsolidationRecord[],
	probe?: PlanProbe,
): ConsolidationPlan {
	const bySource = new Map<string, ConsolidationRecord[]>()
	for (const r of input) {
		if (!Number.isFinite(r.centreHz)) continue
		const list = bySource.get(r.sourceId)
		if (list === undefined) bySource.set(r.sourceId, [r])
		else list.push(r)
	}
	for (const list of bySource.values()) list.sort(compareCentre)
	const ranked = [...input].sort(rankCompare)
	const owned = new Set<string>()
	const groups: ConsolidationGroup[] = []
	let truncated = 0
	for (const s of ranked) {
		if (owned.has(s.id)) continue
		const list = bySource.get(s.sourceId)
		if (list === undefined) continue
		// The survivor itself is at distance 0; ask for one more so 32 others are scanned.
		const scanned = nearest(
			list,
			s.centreHz,
			DQ_CROSS_FAMILY_HZ,
			DQ_CONSOLIDATE_SCAN_MAX + 1,
		).filter(c => c.id !== s.id)
		if (scanned.length > DQ_CONSOLIDATE_SCAN_MAX)
			scanned.length = DQ_CONSOLIDATE_SCAN_MAX
		const members: string[] = []
		let cut = scanned.length === DQ_CONSOLIDATE_SCAN_MAX
		for (const c of scanned) {
			if (owned.has(c.id) || rankCompare(c, s) < 0) continue
			if (probe) probe.checks++
			if (!joinable(s, c)) continue
			if (members.length >= DQ_CONSOLIDATE_GROUP_MAX - 1) {
				cut = true
				break
			}
			members.push(c.id)
		}
		if (cut) truncated++
		if (members.length === 0) continue
		owned.add(s.id)
		for (const m of members) owned.add(m)
		groups.push({ survivor: s.id, members })
	}
	return { groups, truncated }
}
