/**
 * WG6 (web-gaps-6 requirement 1, design "Decoded elsewhere (lane K)"): ranges that running
 * decoders on other sources (or external-input decoders on their own device) provably cover.
 * Pure; views come from runtime state and are read defensively.
 */
import {
	DECODED_ELSEWHERE_MAX_DECODERS,
	DECODED_ELSEWHERE_MAX_RANGES,
	DECODED_ELSEWHERE_MAX_TARGETS,
	DECODED_ELSEWHERE_TARGET_HALF_WIDTH_HZ,
} from "@wavekit/api-types"
import type { DecoderStatus } from "../../../decoders/types.js"
import type {
	DecodedElsewhereRange,
	DecoderCoverageView,
	NormalisedJobSpec,
} from "../types.js"
import { isRangeEnabled } from "./range-contract.js"

export interface DecodedElsewhereLimits {
	maxDecoders: number
	maxTargets: number
	maxRanges: number
}

export interface DecodedElsewhereResult {
	ranges: DecodedElsewhereRange[]
	truncated: boolean
}

interface Piece {
	startHz: number
	endHz: number
	sourceId: string | null
	decoderId: string
}

const HALF = DECODED_ELSEWHERE_TARGET_HALF_WIDTH_HZ
const TRUSTED_EXTERNAL_BASIS = new Set<unknown>([
	"configured",
	"protocol",
	"override",
])

function isFreq(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0
}

function limit(v: number | undefined, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0
		? Math.floor(v)
		: fallback
}

interface BandSnapshot {
	verdict: unknown
	basis: unknown
	targetsHz: unknown
	rangesHz: unknown
	captureCenterHz: unknown
	windowHalfWidthHz: unknown
}

/** Every field the plan uses, read exactly once (a getter cannot change answers mid-check). */
interface ViewSnapshot {
	id: unknown
	running: unknown
	health: unknown
	suspended: unknown
	owner: unknown
	sourceId: unknown
	inputKind: unknown
	band: unknown
}

function snapshotView(view: DecoderCoverageView): ViewSnapshot {
	return {
		id: view.id,
		running: view.running,
		health: view.health,
		suspended: view.suspended,
		owner: view.owner,
		sourceId: view.sourceId,
		inputKind: view.inputKind,
		band: view.band,
	}
}

function snapshotBand(band: object): BandSnapshot {
	const b = band as Record<string, unknown>
	return {
		verdict: b["verdict"],
		basis: b["basis"],
		targetsHz: b["targetsHz"],
		rangesHz: b["rangesHz"],
		captureCenterHz: b["captureCenterHz"],
		windowHalfWidthHz: b["windowHalfWidthHz"],
	}
}

/** Constant-time state gate: a view failing it can never cover and never counts. */
function passesGate(v: ViewSnapshot, jobSourceId: string): boolean {
	if (v.running !== true) return false
	if (v.health !== "running" && v.health !== "idle") return false
	if (v.suspended !== false) return false
	if (v.owner !== "config") return false
	if (v.sourceId !== null && typeof v.sourceId !== "string") return false
	if (v.sourceId === jobSourceId) return false
	if (typeof v.id !== "string") return false
	return v.band !== null && typeof v.band === "object"
}

/** Array length read once; non-arrays have none. */
function lengthOf(v: unknown): number {
	if (!Array.isArray(v)) return 0
	const n: unknown = v.length
	return typeof n === "number" && Number.isFinite(n) && n > 0
		? Math.floor(n)
		: 0
}

/**
 * Raw [start, end] intervals one gated view proves; `truncated` when items were past the
 * bound. Items past the budget are never read.
 */
function coverageOf(
	v: ViewSnapshot,
	maxItems: number,
	out: [number, number][],
): boolean {
	const band = snapshotBand(v.band as object)
	const targets = band.targetsHz as readonly unknown[]
	const nTargets = lengthOf(targets)
	let truncated = false
	let budget = maxItems
	if (v.sourceId !== null) {
		if (band.verdict !== "in-band") return false
		const c = band.captureCenterHz
		const w = band.windowHalfWidthHz
		if (!isFreq(c) || !isFreq(w)) return false
		const lo = c - w
		const hi = c + w
		const tCount = Math.min(nTargets, budget)
		if (nTargets > budget) truncated = true
		for (let i = 0; i < tCount; i++) {
			const t: unknown = targets[i]
			if (!isFreq(t) || Math.abs(t - c) > w) continue
			out.push([Math.max(t - HALF, lo), Math.min(t + HALF, hi)])
		}
		budget -= tCount
		const ranges = band.rangesHz as readonly unknown[]
		const nRanges = lengthOf(ranges)
		const rCount = Math.min(nRanges, budget)
		if (nRanges > budget) truncated = true
		for (let i = 0; i < rCount; i++) {
			const r: unknown = ranges[i]
			if (r === null || typeof r !== "object") continue
			const { minHz, maxHz } = r as { minHz: unknown; maxHz: unknown }
			if (!isFreq(minHz) || !isFreq(maxHz) || minHz > maxHz) continue
			const s = Math.max(minHz, lo)
			const e = Math.min(maxHz, hi)
			if (s <= e) out.push([s, e])
		}
		return truncated
	}
	if (v.inputKind !== "external") return false
	if (!TRUSTED_EXTERNAL_BASIS.has(band.basis)) return false
	const count = Math.min(nTargets, budget)
	if (nTargets > budget) truncated = true
	for (let i = 0; i < count; i++) {
		const t: unknown = targets[i]
		if (!isFreq(t)) continue
		out.push([t - HALF, t + HALF])
	}
	return truncated
}

function compareSource(a: string | null, b: string | null): number {
	if (a === b) return 0
	if (a === null) return 1
	if (b === null) return -1
	return a < b ? -1 : 1
}

/**
 * Req 1.2, 1.3, 1.5: coverage entries for `spec`, clipped to its enabled ranges, merged per
 * source, sorted by start then source (null last), cut to `maxRanges`. Every entry is
 * `applied: false`; the planner decides application.
 */
export function computeDecodedElsewhere(
	views: readonly DecoderCoverageView[],
	spec: Pick<NormalisedJobSpec, "sourceId" | "ranges">,
	limits?: Partial<DecodedElsewhereLimits>,
): DecodedElsewhereResult {
	const maxDecoders = limit(limits?.maxDecoders, DECODED_ELSEWHERE_MAX_DECODERS)
	const maxTargets = limit(limits?.maxTargets, DECODED_ELSEWHERE_MAX_TARGETS)
	const maxRanges = limit(limits?.maxRanges, DECODED_ELSEWHERE_MAX_RANGES)
	let truncated = false

	const clips: [number, number][] = []
	for (const r of spec.ranges) {
		if (!isRangeEnabled(r)) continue
		if (
			!Number.isFinite(r.startHz) ||
			!Number.isFinite(r.endHz) ||
			r.startHz > r.endHz
		)
			continue
		clips.push([r.startHz, r.endHz])
	}
	if (clips.length === 0) return { ranges: [], truncated: false }

	const pieces: Piece[] = []
	let nViews = 0
	try {
		nViews = lengthOf(views)
	} catch {
		return { ranges: [], truncated: false }
	}
	let counted = 0
	for (let i = 0; i < nViews; i++) {
		const raw: [number, number][] = []
		let snap: ViewSnapshot
		let viewTruncated: boolean
		try {
			const view: unknown = views[i]
			if (view === undefined || view === null || typeof view !== "object")
				continue
			snap = snapshotView(view as DecoderCoverageView)
			if (!passesGate(snap, spec.sourceId)) continue
			if (counted >= maxDecoders) {
				truncated = true
				break
			}
			counted++
			viewTruncated = coverageOf(snap, maxTargets, raw)
		} catch {
			continue
		}
		if (viewTruncated) truncated = true
		const id = snap.id as string
		const sourceId = snap.sourceId as string | null
		for (const [s, e] of raw) {
			for (const [cs, ce] of clips) {
				const ps = Math.max(s, cs)
				const pe = Math.min(e, ce)
				if (ps <= pe)
					pieces.push({ startHz: ps, endHz: pe, sourceId, decoderId: id })
			}
		}
	}
	if (pieces.length === 0) return { ranges: [], truncated }

	pieces.sort(
		(a, b) =>
			compareSource(a.sourceId, b.sourceId) ||
			a.startHz - b.startHz ||
			a.endHz - b.endHz,
	)
	const merged: {
		startHz: number
		endHz: number
		sourceId: string | null
		ids: Set<string>
	}[] = []
	let cur: (typeof merged)[number] | undefined
	for (const p of pieces) {
		if (
			cur !== undefined &&
			cur.sourceId === p.sourceId &&
			p.startHz <= cur.endHz
		) {
			if (p.endHz > cur.endHz) cur.endHz = p.endHz
			cur.ids.add(p.decoderId)
			continue
		}
		cur = {
			startHz: p.startHz,
			endHz: p.endHz,
			sourceId: p.sourceId,
			ids: new Set([p.decoderId]),
		}
		merged.push(cur)
	}
	merged.sort(
		(a, b) => a.startHz - b.startHz || compareSource(a.sourceId, b.sourceId),
	)
	if (merged.length > maxRanges) truncated = true
	const ranges = merged.slice(0, maxRanges).map(m => ({
		startHz: m.startHz,
		endHz: m.endHz,
		sourceId: m.sourceId,
		decoderIds: [...m.ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		applied: false,
	}))
	return { ranges, truncated }
}

const HEALTHS = new Set<unknown>(["running", "idle", "restarting", "faulted"])
const VERDICTS = new Set<unknown>(["in-band", "out-of-band", "unknown"])
const BASES = new Set<unknown>([
	"configured",
	"protocol",
	"decoder-default",
	"region-default",
	"override",
])

function finiteNumbers(v: unknown): number[] {
	return Array.isArray(v)
		? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x))
		: []
}

/**
 * Pure mapping of a manager status to the view the plan reads (Main calls it in the scanner
 * service's preview context). External input is recognised by the manager's
 * `external-input` band reason or a configured device serial; it gets `sourceId` null. Anything
 * missing or malformed maps to the safe side (band null, basis null, running false, suspended
 * true, owner scanner).
 */
export function toDecoderCoverageView(
	status: DecoderStatus,
	defaultSourceId: string | null,
): DecoderCoverageView {
	const a = status.bandAssessment
	const external =
		a?.reasonCode === "external-input" || status.deviceSerial !== undefined
	const sourceId = external
		? null
		: typeof status.sourceId === "string"
			? status.sourceId
			: defaultSourceId
	const health = HEALTHS.has(status.health)
		? (status.health as DecoderCoverageView["health"])
		: "faulted"
	let band: DecoderCoverageView["band"] = null
	if (a !== undefined && a !== null && VERDICTS.has(a.verdict)) {
		const configuredTargets = finiteNumbers(status.targetFrequenciesHz)
		const ownTargets = finiteNumbers(a.targetsHz)
		// Basis only ever comes from the assessment itself; nothing is manufactured.
		const basis: NonNullable<DecoderCoverageView["band"]>["basis"] = BASES.has(
			a.basis,
		)
			? (a.basis as NonNullable<DecoderCoverageView["band"]>["basis"])
			: null
		// Configured target frequencies stand in for external targets only when the
		// assessment itself carries a proving basis.
		let targetsHz = ownTargets
		if (
			external &&
			ownTargets.length === 0 &&
			TRUSTED_EXTERNAL_BASIS.has(basis)
		)
			targetsHz = configuredTargets
		band = {
			verdict: a.verdict,
			basis,
			targetsHz,
			rangesHz: Array.isArray(a.rangesHz)
				? a.rangesHz.map(r => ({ minHz: r.minHz, maxHz: r.maxHz }))
				: [],
			captureCenterHz:
				typeof a.captureCenterHz === "number" ? a.captureCenterHz : null,
			windowHalfWidthHz:
				typeof a.windowHalfWidthHz === "number" ? a.windowHalfWidthHz : null,
		}
	}
	return {
		id: status.id,
		running: status.running === true,
		health,
		// Missing or malformed state maps to the side that never counts.
		suspended: typeof status.suspended === "boolean" ? status.suspended : true,
		owner: status.owner === "config" ? "config" : "scanner",
		sourceId,
		inputKind: external ? "external" : "iq",
		band,
	}
}
