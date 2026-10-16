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

/** Raw [start, end] intervals one view proves; `truncated` when items were past the bound. */
function coverageOf(
	view: DecoderCoverageView,
	jobSourceId: string,
	maxItems: number,
	out: [number, number][],
): boolean {
	if (view.running !== true) return false
	if (view.health !== "running" && view.health !== "idle") return false
	if (view.suspended !== false) return false
	if (view.owner !== "config") return false
	const sourceId = view.sourceId
	if (sourceId !== null && typeof sourceId !== "string") return false
	if (sourceId === jobSourceId) return false
	const band = view.band
	if (band === null || typeof band !== "object") return false
	const targets: unknown = band.targetsHz
	const ranges: unknown = band.rangesHz
	const targetList: readonly unknown[] = Array.isArray(targets) ? targets : []
	let truncated = false
	let budget = maxItems
	if (sourceId !== null) {
		if (band.verdict !== "in-band") return false
		const c: unknown = band.captureCenterHz
		const w: unknown = band.windowHalfWidthHz
		if (!isFreq(c) || !isFreq(w)) return false
		const lo = c - w
		const hi = c + w
		const rangeList: readonly unknown[] = Array.isArray(ranges) ? ranges : []
		for (const t of targetList) {
			if (budget <= 0) {
				truncated = true
				break
			}
			budget--
			if (!isFreq(t) || Math.abs(t - c) > w) continue
			out.push([Math.max(t - HALF, lo), Math.min(t + HALF, hi)])
		}
		for (const r of rangeList) {
			if (budget <= 0) {
				truncated = true
				break
			}
			budget--
			if (r === null || typeof r !== "object") continue
			const { minHz, maxHz } = r as { minHz: unknown; maxHz: unknown }
			if (!isFreq(minHz) || !isFreq(maxHz) || minHz > maxHz) continue
			const s = Math.max(minHz, lo)
			const e = Math.min(maxHz, hi)
			if (s <= e) out.push([s, e])
		}
		return truncated
	}
	if (view.inputKind !== "external") return false
	if (!TRUSTED_EXTERNAL_BASIS.has(band.basis)) return false
	for (const t of targetList) {
		if (budget <= 0) {
			truncated = true
			break
		}
		budget--
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
	if (clips.length === 0 || !Array.isArray(views))
		return { ranges: [], truncated: false }

	const pieces: Piece[] = []
	const raw: [number, number][] = []
	const count = Math.min(views.length, maxDecoders)
	if (views.length > maxDecoders) truncated = true
	for (let i = 0; i < count; i++) {
		raw.length = 0
		let id: string
		let sourceId: string | null
		try {
			const view = views[i]
			if (view === undefined || view === null || typeof view !== "object")
				continue
			id = view.id
			if (typeof id !== "string") continue
			sourceId = view.sourceId
			if (coverageOf(view, spec.sourceId, maxTargets, raw)) truncated = true
		} catch {
			continue
		}
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
		? v.filter((x): x is number => typeof x === "number")
		: []
}

/**
 * Pure mapping of a manager status to the view the plan reads (Main calls it in the scanner
 * service's preview context). External input is recognised by the manager's
 * `external-input` band reason or a configured device serial; it gets `sourceId` null. Anything
 * missing maps to the safe side (band null, running false).
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
		let basis: NonNullable<DecoderCoverageView["band"]>["basis"] = BASES.has(
			a.basis,
		)
			? (a.basis as NonNullable<DecoderCoverageView["band"]>["basis"])
			: null
		// The manager's external assessment carries no targets or basis; the configured target
		// frequencies are the operator's own declaration.
		let targetsHz = ownTargets
		if (external && ownTargets.length === 0 && configuredTargets.length > 0) {
			targetsHz = configuredTargets
			basis = basis ?? "configured"
		}
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
		suspended: status.suspended === true,
		owner: status.owner === "scanner" ? "scanner" : "config",
		sourceId,
		inputKind: external ? "external" : "iq",
		band,
	}
}
