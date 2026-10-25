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
	/** Declared channel width of a decoder; absent or invalid: DISCOVERY_COVERAGE_DEFAULT_CHANNEL_WIDTH_HZ. */
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

/**
 * Builds the per-request index. Returns null when decoder status is unavailable (not an array,
 * or no decoder reports placements): every discovery then omits the field.
 */
export function buildCoverageIndex(
	statuses: unknown,
	opts: CoverageProjectionOptions = {},
): CoverageIndex | null {
	if (!Array.isArray(statuses)) return null
	const list = statuses as readonly unknown[]
	// Capture window per source from the band assessments that carry both figures.
	const windows = new Map<string, { lo: number; hi: number }>()
	let reported = false
	for (const raw of list) {
		const s = record(raw)
		if (s === null) continue
		if (Array.isArray(s["placements"])) reported = true
		const band = record(s["bandAssessment"])
		const sourceId = s["sourceId"]
		if (band === null || typeof sourceId !== "string") continue
		const c = band["captureCenterHz"]
		const w = band["windowHalfWidthHz"]
		if (isFreq(c) && isFreq(w) && w >= 0 && !windows.has(sourceId))
			windows.set(sourceId, { lo: c - w, hi: c + w })
	}
	if (!reported) return null
	const intervals: Interval[] = []
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
				lo = ch - width / 2
				hi = ch + width / 2
			} else if (reach === "raw" || reach === "centre") {
				const window = windows.get(sourceId)
				if (window === undefined) {
					unresolved.add(sourceId)
					continue
				}
				lo = window.lo
				hi = window.hi
			} else {
				unresolved.add(sourceId)
				continue
			}
			const { state, reason } = stateOf(p)
			intervals.push({
				lo,
				hi,
				sourceId,
				decoderId,
				state,
				...(reason !== undefined ? { reason } : {}),
			})
		}
	}
	intervals.sort((a, b) => a.lo - b.lo)
	// maxHi[i]: the largest `hi` among intervals[0..i]; a backward scan stops once it is below f.
	const maxHi: number[] = []
	let running = Number.NEGATIVE_INFINITY
	for (const iv of intervals) {
		running = Math.max(running, iv.hi)
		maxHi.push(running)
	}
	return {
		coverageOf(discovery) {
			const f = discovery.frequencyHz
			const sources = Array.isArray(discovery.sourceIds)
				? discovery.sourceIds
				: []
			if (!isFreq(f)) return undefined
			for (const id of sources) if (unresolved.has(id)) return undefined
			// Last interval with lo <= f.
			let low = 0
			let high = intervals.length
			while (low < high) {
				const mid = (low + high) >>> 1
				if (intervals[mid]!.lo <= f) low = mid + 1
				else high = mid
			}
			const best = new Map<string, Interval>()
			for (let i = low - 1; i >= 0; i--) {
				if (maxHi[i]! < f) break
				const iv = intervals[i]!
				if (iv.hi < f || !sources.includes(iv.sourceId)) continue
				const prior = best.get(iv.decoderId)
				if (
					prior === undefined ||
					STATE_RANK[iv.state] < STATE_RANK[prior.state]
				)
					best.set(iv.decoderId, iv)
			}
			return [...best.values()]
				.sort(
					(a, b) =>
						STATE_RANK[a.state] - STATE_RANK[b.state] ||
						(a.decoderId < b.decoderId
							? -1
							: a.decoderId > b.decoderId
								? 1
								: 0),
				)
				.slice(0, DISCOVERY_COVERAGE_MAX)
				.map(iv => ({
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
