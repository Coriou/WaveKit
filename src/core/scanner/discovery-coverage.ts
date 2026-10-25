/**
 * Band inspection UX req 1.4: `Discovery.coverage`, projected at read time from each decoder's
 * `DecoderStatus.placements` (never stored or journaled). Pure; statuses are read defensively.
 *
 * One sorted interval index over every placement is built per request (O(P log P)); each
 * discovery is then answered in O(log P + k).
 */
import {
	DISCOVERY_COVERAGE_DECODER_ID_MAX,
	DISCOVERY_COVERAGE_DEFAULT_CHANNEL_WIDTH_HZ,
	DISCOVERY_COVERAGE_MAX,
} from "@wavekit/api-types"
import type {
	DecoderSuspensionReasonCode,
	DiscoveryCoverage,
} from "@wavekit/api-types"
import type { Discovery } from "./types.js"

type CoverageState = DiscoveryCoverage["state"]

const STATE_RANK: Record<CoverageState, number> = {
	running: 0,
	suspended: 1,
	stopped: 2,
}

/** A reason string longer than this is not a reason code and is dropped. */
const REASON_MAX = 64

interface Interval {
	lo: number
	hi: number
	sourceId: string
	decoderId: string
	state: CoverageState
	reason?: string
}

export interface CoverageProjectionOptions {
	/**
	 * Declared channel width of a decoder, used when a channel placement reports no valid
	 * `channelWidthHz`; absent or invalid too: DISCOVERY_COVERAGE_DEFAULT_CHANNEL_WIDTH_HZ.
	 */
	channelWidthHz?: (decoderId: string) => number | undefined
	/** Called once per index build for each decoder id skipped as too long or empty. */
	onSkippedDecoderId?: (decoderId: string) => void
}

export interface CoverageIndex {
	/** Absent result: unknown (field omitted). */
	coverageOf(
		discovery: Pick<Discovery, "frequencyHz" | "sourceIds">,
	): DiscoveryCoverage[] | undefined
}

function isFreq(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v)
}

function record(v: unknown): Record<string, unknown> | null {
	return v !== null && typeof v === "object"
		? (v as Record<string, unknown>)
		: null
}

function stateOf(p: Record<string, unknown>): {
	state: CoverageState
	reason?: string
} {
	if (p["running"] === true) return { state: "running" }
	const suspension = record(p["suspension"])
	if (suspension !== null) {
		const code = suspension["reasonCode"]
		return typeof code === "string" &&
			code.length > 0 &&
			code.length <= REASON_MAX
			? { state: "suspended", reason: code }
			: { state: "suspended" }
	}
	return { state: "stopped" }
}

/** Most covering intervals one lookup examines per source; past it the result is unknown. */
export const COVERAGE_SCAN_MAX = 256
/** Most of a discovery's `sourceIds` one lookup examines; past it the result is unknown. */
export const COVERAGE_SOURCES_MAX = 16

interface SourceIndex {
	/** Sorted by `lo`. */
	intervals: Interval[]
	/** maxHi[i]: the largest `hi` among intervals[0..i]; a backward scan stops once it is below f. */
	maxHi: number[]
}

/**
 * Builds the per-request index. Returns null when decoder status is unavailable (not an array,
 * or no decoder reports placements): every discovery then omits the field.
 *
 * A raw or centre placement covers its decoder's OWN band-assessment window (an assessment is
 * per decoder: a channel decoder's window is its channel, not the capture), and only when that
 * decoder's `sourceId` is the placement's source. Otherwise the window is not established and
 * every discovery on that source is unknown.
 *
 * Cost. Build: O(P log P) for P placements (one sort per source). Lookup: at most
 * COVERAGE_SOURCES_MAX sources, each a binary search (O(log P)) plus a backward scan that
 * examines at most COVERAGE_SCAN_MAX intervals reaching past the previous ones' lows (the
 * prefix-max stop). The candidates are distinct decoders across all scanned sources, so at most
 * 16 x 256 = 4 096; the top-3 selection makes 3 passes over them, <= 3 x 4 096 = 12 288
 * comparisons. So per discovery <= 16 x (log2 P + 256) interval visits + 12 288 comparisons,
 * independent of how many placements sit on other sources. A discovery listing more than 16
 * source ids (duplicates included) is unknown before any traversal or allocation; a scan that
 * would pass the bound returns unknown.
 */
export function buildCoverageIndex(
	statuses: unknown,
	opts: CoverageProjectionOptions = {},
): CoverageIndex | null {
	if (!Array.isArray(statuses)) return null
	const list = statuses as readonly unknown[]
	let reported = false
	for (const raw of list) {
		const s = record(raw)
		if (s !== null && Array.isArray(s["placements"])) reported = true
	}
	if (!reported) return null
	const bySource = new Map<string, Interval[]>()
	/** Sources with a placement whose figures are missing: their discoveries are unknown. */
	const unresolved = new Set<string>()
	const skipped = new Set<string>()
	for (const raw of list) {
		const s = record(raw)
		if (s === null || !Array.isArray(s["placements"])) continue
		const decoderId = s["id"]
		if (typeof decoderId !== "string") continue
		if (
			decoderId.length === 0 ||
			decoderId.length > DISCOVERY_COVERAGE_DECODER_ID_MAX
		) {
			if (!skipped.has(decoderId)) {
				skipped.add(decoderId)
				opts.onSkippedDecoderId?.(decoderId)
			}
			continue
		}
		const declared = opts.channelWidthHz?.(decoderId)
		const width =
			isFreq(declared) && declared > 0
				? declared
				: DISCOVERY_COVERAGE_DEFAULT_CHANNEL_WIDTH_HZ
		// This decoder's own window, valid only on its own source.
		const band = record(s["bandAssessment"])
		const ownSource = s["sourceId"]
		const c = band?.["captureCenterHz"]
		const w = band?.["windowHalfWidthHz"]
		const own =
			typeof ownSource === "string" && isFreq(c) && isFreq(w) && w >= 0
				? { sourceId: ownSource, lo: c - w, hi: c + w }
				: undefined
		for (const rawPlacement of s["placements"] as readonly unknown[]) {
			const p = record(rawPlacement)
			if (p === null) continue
			const sourceId = p["sourceId"]
			if (typeof sourceId !== "string") continue
			const reach = p["reach"]
			let lo: number
			let hi: number
			if (reach === "channel") {
				const ch = p["channelHz"]
				if (!isFreq(ch)) {
					unresolved.add(sourceId)
					continue
				}
				const reported = p["channelWidthHz"]
				const placed = isFreq(reported) && reported > 0 ? reported : width
				lo = ch - placed / 2
				hi = ch + placed / 2
			} else if (reach === "raw" || reach === "centre") {
				if (own === undefined || own.sourceId !== sourceId) {
					unresolved.add(sourceId)
					continue
				}
				lo = own.lo
				hi = own.hi
			} else {
				unresolved.add(sourceId)
				continue
			}
			const { state, reason } = stateOf(p)
			let bucket = bySource.get(sourceId)
			if (bucket === undefined) {
				bucket = []
				bySource.set(sourceId, bucket)
			}
			bucket.push({
				lo,
				hi,
				sourceId,
				decoderId,
				state,
				...(reason !== undefined ? { reason } : {}),
			})
		}
	}
	const index = new Map<string, SourceIndex>()
	for (const [sourceId, intervals] of bySource) {
		intervals.sort((x, y) => x.lo - y.lo)
		const maxHi: number[] = []
		let top = Number.NEGATIVE_INFINITY
		for (const iv of intervals) {
			top = Math.max(top, iv.hi)
			maxHi.push(top)
		}
		index.set(sourceId, { intervals, maxHi })
	}
	const better = (x: Interval, y: Interval): boolean =>
		STATE_RANK[x.state] < STATE_RANK[y.state] ||
		(STATE_RANK[x.state] === STATE_RANK[y.state] && x.decoderId < y.decoderId)
	return {
		coverageOf(discovery) {
			const f = discovery.frequencyHz
			if (!isFreq(f) || !Array.isArray(discovery.sourceIds)) return undefined
			// Bail before traversing or copying an over-long list.
			if (discovery.sourceIds.length > COVERAGE_SOURCES_MAX) return undefined
			const sources = [...new Set(discovery.sourceIds)]
			for (const id of sources) if (unresolved.has(id)) return undefined
			const best = new Map<string, Interval>()
			for (const sourceId of sources) {
				const at = index.get(sourceId)
				if (at === undefined) continue
				const { intervals, maxHi } = at
				// Last interval with lo <= f.
				let low = 0
				let high = intervals.length
				while (low < high) {
					const mid = (low + high) >>> 1
					if (intervals[mid]!.lo <= f) low = mid + 1
					else high = mid
				}
				let visited = 0
				for (let i = low - 1; i >= 0; i--) {
					if (maxHi[i]! < f) break
					if (++visited > COVERAGE_SCAN_MAX) return undefined
					const iv = intervals[i]!
					if (iv.hi < f) continue
					const prior = best.get(iv.decoderId)
					if (
						prior === undefined ||
						STATE_RANK[iv.state] < STATE_RANK[prior.state]
					)
						best.set(iv.decoderId, iv)
				}
			}
			// Top DISCOVERY_COVERAGE_MAX by (state rank, decoderId): 3 linear passes, no sort.
			const out: Interval[] = []
			const taken = new Set<string>()
			for (let k = 0; k < DISCOVERY_COVERAGE_MAX; k++) {
				let pick: Interval | undefined
				for (const iv of best.values())
					if (
						!taken.has(iv.decoderId) &&
						(pick === undefined || better(iv, pick))
					)
						pick = iv
				if (pick === undefined) break
				taken.add(pick.decoderId)
				out.push(pick)
			}
			return out.map(iv => ({
				decoderId: iv.decoderId,
				state: iv.state,
				...(iv.state === "suspended" && iv.reason !== undefined
					? {
							suspensionReason: iv.reason as DecoderSuspensionReasonCode,
						}
					: {}),
			}))
		},
	}
}

/** Returns a copy of `discovery` with `coverage` set, or the record itself when unknown. */
export function withCoverage<T extends Discovery>(
	discovery: T,
	index: CoverageIndex | null,
): T {
	if (index === null) return discovery
	const coverage = index.coverageOf(discovery)
	return coverage === undefined ? discovery : { ...discovery, coverage }
}
