/**
 * Detection quality requirement 10: legacy fragment retirement. Pure planner over frozen records;
 * the store freezes the records, supplies the covering channel raster and the 3.1 compatibility
 * test, and applies the plan (merges through the ordinary `absorb`, retirements through the
 * ordinary delete).
 *
 * Bounds per pass (10.6), at the default `maxDiscoveries` 10 000:
 * - freezing and sorting: O(n log n) over n records (one centre sort per source, one id sort);
 * - at most `FRAGMENT_SCAN_MAX` 512 candidates examined, each visiting at most
 *   `FRAGMENT_PEER_SCAN_MAX` + 1 = 33 nearest entries: at most 16 896 entry visits and
 *   512 x 32 = 16 384 pair checks;
 * - at most `FRAGMENT_GROUPS_MAX` 32 groups of at most 16 records: 32 x 15 = 480 absorbs, each
 *   moving at most 256 observations, so at most 122 880 observation moves;
 * - at most `FRAGMENT_RETIRE_MAX` 256 retirements.
 */
import { compareCentre, nearest } from "./consolidation.js"
import { DQ_CONSOLIDATE_GROUP_MAX } from "../detection-quality-contract.js"
import type { ProtocolFamily, ScannerConfidence } from "../types.js"
import type { Raster } from "../../spectrum/types.js"

/** 10.6: candidates (unprotected records) examined per pass, resumed from a cursor. */
export const FRAGMENT_SCAN_MAX = 512
/** 10.6: nearest records visited around one candidate's channel centre. */
export const FRAGMENT_PEER_SCAN_MAX = 32
/** 10.6: channel groups merged per pass. */
export const FRAGMENT_GROUPS_MAX = 32
/** 10.6: records per group (the survivor and at most 15 members). */
export const FRAGMENT_GROUP_MAX = DQ_CONSOLIDATE_GROUP_MAX
/** 10.6: retirements per pass. */
export const FRAGMENT_RETIRE_MAX = 256
/** 10.4: a fragment retires after this long without a sighting. */
export const FRAGMENT_RETIRE_AGE_MS = 72 * 3_600_000
/** 10.4: only records with at most this many sightings retire. */
export const FRAGMENT_RETIRE_MAX_SIGHTINGS = 2
/** 10.2: a fragment wider than this many channel spacings is not a fragment of one channel. */
export const FRAGMENT_OBW_SPACINGS_MAX = 2

/** One record's frozen values for one pass. */
export interface FragmentRecord {
	id: string
	sourceId: string
	/** Median centre with the source correction removed (the raster frame). */
	centreHz: number
	obwHz: number
	observationCount: number
	firstSeenAt: string
	lastSeenAt: string
	confidence: ScannerConfidence
	/** DQ 9.1 association family. */
	family: ProtocolFamily
	/** 10.3: operator state (label, notes, lockout, keep). */
	operator: boolean
	/** 10.3: decoded, decoded metadata, identity, recordings, PSD/IQ evidence, proof or kept recordings. */
	evidence: boolean
}

export interface FragmentPlanInput {
	records: readonly FragmentRecord[]
	/** The finest covering channel raster at a candidate, or null where no channel grid covers it. */
	rasterOf: (r: FragmentRecord) => Raster | null
	/** DQ 3.1 on the live records: false only when refused. */
	compatible: (survivorId: string, memberId: string) => boolean
	nowMs: number
	/** Id after which this pass starts examining candidates (wraps). */
	cursor?: string | undefined
}

export interface FragmentGroup {
	survivor: string
	/** Absorbed in this order. */
	members: string[]
}

export interface FragmentPlan {
	groups: FragmentGroup[]
	/** Oldest first. */
	retire: string[]
	/** Candidates examined. */
	scanned: number
	/** Cursor for the next pass; undefined when this pass examined every candidate. */
	nextCursor: string | undefined
	/** Candidates whose peer scan or group filled up (the rest waits for a later pass). */
	truncated: number
}

const LOOSE: ReadonlySet<ProtocolFamily> = new Set<ProtocolFamily>([
	"unknown",
	"carrier",
])

const compareText = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0

/** 10.1: protected records never become members. */
export function isProtected(r: FragmentRecord): boolean {
	return r.operator || r.evidence
}

/**
 * 10.2: the channel record first: operator state, then evidence, then most sightings, then the
 * earliest `firstSeenAt`, then the smaller id. Negative = `a` above.
 */
export function survivorCompare(a: FragmentRecord, b: FragmentRecord): number {
	if (a.operator !== b.operator) return a.operator ? -1 : 1
	if (a.evidence !== b.evidence) return a.evidence ? -1 : 1
	return (
		b.observationCount - a.observationCount ||
		compareText(a.firstSeenAt, b.firstSeenAt) ||
		compareText(a.id, b.id)
	)
}

function channelIndex(hz: number, r: Raster): number {
	return Math.round((hz - r.firstChannelHz) / r.spacingHz)
}

function familiesMeet(a: ProtocolFamily, b: ProtocolFamily): boolean {
	return a === b || LOOSE.has(a) || LOOSE.has(b)
}

/** 10.4: a stale low-sighting record with no evidence. */
export function retirable(r: FragmentRecord, nowMs: number): boolean {
	if (isProtected(r)) return false
	if (r.observationCount > FRAGMENT_RETIRE_MAX_SIGHTINGS) return false
	if (r.confidence !== "activity" && r.confidence !== "candidate") return false
	const last = Date.parse(r.lastSeenAt)
	return Number.isFinite(last) && nowMs - last >= FRAGMENT_RETIRE_AGE_MS
}

/** Req 10.2 to 10.6: one bounded pass. Deterministic for a given input and cursor. */
export function planFragments(input: FragmentPlanInput): FragmentPlan {
	const bySource = new Map<string, FragmentRecord[]>()
	const candidates: FragmentRecord[] = []
	for (const r of input.records) {
		if (!Number.isFinite(r.centreHz)) continue
		const list = bySource.get(r.sourceId)
		if (list === undefined) bySource.set(r.sourceId, [r])
		else list.push(r)
		if (!isProtected(r)) candidates.push(r)
	}
	for (const list of bySource.values()) list.sort(compareCentre)
	candidates.sort((a, b) => compareText(a.id, b.id))

	// The cursor: start after the last id examined, wrap once.
	let start = 0
	if (input.cursor !== undefined) {
		let lo = 0
		let hi = candidates.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			const c = candidates[mid]
			if (c !== undefined && c.id <= input.cursor) lo = mid + 1
			else hi = mid
		}
		start = lo
	}
	const scanCount = Math.min(FRAGMENT_SCAN_MAX, candidates.length)
	const owned = new Set<string>()
	const groups: FragmentGroup[] = []
	let truncated = 0
	let scanned = 0
	let last: string | undefined
	for (let k = 0; k < scanCount; k++) {
		if (groups.length >= FRAGMENT_GROUPS_MAX) break
		const c = candidates[(start + k) % candidates.length]
		if (c === undefined) continue
		scanned += 1
		last = c.id
		if (owned.has(c.id)) continue
		const raster = input.rasterOf(c)
		if (raster === null || !(raster.spacingHz > 0)) continue
		const idx = channelIndex(c.centreHz, raster)
		const channelHz = raster.firstChannelHz + idx * raster.spacingHz
		const list = bySource.get(c.sourceId)
		if (list === undefined) continue
		const peers = nearest(
			list,
			channelHz,
			raster.spacingHz / 2,
			FRAGMENT_PEER_SCAN_MAX + 1,
		)
		let cut = peers.length > FRAGMENT_PEER_SCAN_MAX
		if (cut) peers.length = FRAGMENT_PEER_SCAN_MAX
		const onChannel = peers.filter(
			p => !owned.has(p.id) && channelIndex(p.centreHz, raster) === idx,
		)
		if (!onChannel.some(p => p.id === c.id)) onChannel.push(c)
		if (onChannel.length < 2) continue
		onChannel.sort(survivorCompare)
		const s = onChannel[0]
		if (s === undefined) continue
		const maxObw = FRAGMENT_OBW_SPACINGS_MAX * raster.spacingHz
		const members: string[] = []
		for (const m of onChannel) {
			if (m.id === s.id || isProtected(m)) continue
			if (!(Number.isFinite(m.obwHz) && m.obwHz > 0 && m.obwHz <= maxObw))
				continue
			if (!familiesMeet(s.family, m.family)) continue
			if (!input.compatible(s.id, m.id)) continue
			if (members.length >= FRAGMENT_GROUP_MAX - 1) {
				cut = true
				break
			}
			members.push(m.id)
		}
		if (cut) truncated += 1
		if (members.length === 0) continue
		owned.add(s.id)
		for (const m of members) owned.add(m)
		groups.push({ survivor: s.id, members })
	}

	const stale = candidates.filter(
		r => !owned.has(r.id) && retirable(r, input.nowMs),
	)
	stale.sort(
		(a, b) =>
			compareText(a.lastSeenAt, b.lastSeenAt) || compareText(a.id, b.id),
	)
	if (stale.length > FRAGMENT_RETIRE_MAX) stale.length = FRAGMENT_RETIRE_MAX
	const wholeList = scanned >= candidates.length
	return {
		groups,
		retire: stale.map(r => r.id),
		scanned,
		nextCursor: wholeList ? undefined : last,
		truncated,
	}
}
