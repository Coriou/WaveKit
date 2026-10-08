import type { FanoutSnapshot } from "@wavekit/api-types"
import type {
	CounterSample,
	FanoutBranchSample,
	FanoutSample,
} from "./types.js"

export type { FanoutSample } from "./types.js"

export const DROP_WINDOW_MS = 10_000
export const MIN_DROP_SPAN_MS = 2_000
export const RATE_WINDOW_MS = 60_000
export const MIN_RATE_SPAN_MS = 20_000
export const RESTART_WINDOW_MS = 300_000
export const SPARK_MINUTES = 30

export function fanoutSample(s: FanoutSnapshot): FanoutSample | null {
	const t = Date.parse(s.timestamp)
	if (!Number.isFinite(t)) return null
	const branches: Record<string, FanoutBranchSample> = {}
	for (const b of s.branches) {
		branches[b.id] = {
			dropped: b.droppedBytesTotal,
			backpressure: b.backpressureActive,
			...(b.decoderId !== undefined ? { decoderId: b.decoderId } : {}),
			...(b.totalBytesWritten !== undefined
				? { offered: b.totalBytesWritten }
				: {}),
		}
	}
	return { t, branches }
}

/** Add a snapshot (deduped by server timestamp) and keep the trailing 10 s by server time. */
export function pushFanout(
	history: readonly FanoutSample[],
	s: FanoutSnapshot,
): FanoutSample[] {
	const sample = fanoutSample(s)
	if (!sample || history.some(h => h.t === sample.t)) return [...history]
	const next = [...history, sample].sort((a, b) => a.t - b.t)
	const newest = next[next.length - 1]?.t ?? sample.t
	return next.filter(h => h.t >= newest - DROP_WINDOW_MS)
}

export interface BranchDelta {
	dDropped: number
	dOffered: number
	spanMs: number
}

/** "reset" = a counter decreased between two samples of this branch; null = not computable. */
function deltaOf(
	history: readonly FanoutSample[],
	branchId: string,
): BranchDelta | "reset" | null {
	const pts: Array<{ t: number; b: FanoutBranchSample }> = []
	for (const h of history) {
		const b = h.branches[branchId]
		if (b) pts.push({ t: h.t, b })
	}
	if (pts.length < 2) return null
	for (let i = 1; i < pts.length; i++) {
		const prev = pts[i - 1]
		const cur = pts[i]
		if (!prev || !cur) return null
		if (cur.b.dropped < prev.b.dropped) return "reset"
		if (prev.b.offered === undefined || cur.b.offered === undefined) return null
		if (cur.b.offered < prev.b.offered) return "reset"
	}
	const first = pts[0]
	const last = pts[pts.length - 1]
	if (
		!first ||
		!last ||
		first.b.offered === undefined ||
		last.b.offered === undefined
	)
		return null
	const spanMs = last.t - first.t
	const dOffered = last.b.offered - first.b.offered
	if (spanMs < MIN_DROP_SPAN_MS || dOffered <= 0) return null
	return { dDropped: last.b.dropped - first.b.dropped, dOffered, spanMs }
}

export function branchDelta(
	history: readonly FanoutSample[],
	branchId: string,
): BranchDelta | null {
	const d = deltaOf(history, branchId)
	return d === "reset" ? null : d
}

export function branchDropNow(
	history: readonly FanoutSample[],
	branchId: string,
): number | null {
	const d = branchDelta(history, branchId)
	return d === null ? null : Math.min(1, Math.max(0, d.dDropped / d.dOffered))
}

export interface AggregateDrop {
	ratio: number | null
	/** Decoder branches in backpressure in the newest sample. */
	backpressure: number
	/** Decoder branches in the newest sample. */
	branches: number
	/** Mean offered bytes/s per decoder branch. */
	offeredBytesPerSec: number | null
}

function sumOver(
	history: readonly FanoutSample[],
	ids: string[],
): { ratio: number | null; rates: number[] } {
	let dd = 0
	let dof = 0
	const rates: number[] = []
	for (const id of ids) {
		const d = deltaOf(history, id)
		// R4: a reset in any branch seen in two samples makes the aggregate unknown;
		// branches seen in fewer than two samples are excluded.
		if (d === "reset") return { ratio: null, rates: [] }
		if (!d) continue
		dd += d.dDropped
		dof += d.dOffered
		rates.push((d.dOffered / d.spanMs) * 1000)
	}
	return { ratio: dof > 0 ? Math.min(1, Math.max(0, dd / dof)) : null, rates }
}

/** Σ Δ dropped / Σ Δ offered over branches with a decoderId. */
export function aggregateDropNow(
	history: readonly FanoutSample[],
): AggregateDrop {
	const newest = history[history.length - 1]
	if (!newest)
		return {
			ratio: null,
			backpressure: 0,
			branches: 0,
			offeredBytesPerSec: null,
		}
	const ids = Object.entries(newest.branches)
		.filter(([, b]) => b.decoderId !== undefined)
		.map(([id]) => id)
	const backpressure = ids.filter(
		id => newest.branches[id]?.backpressure === true,
	).length
	const { ratio, rates } = sumOver(history, ids)
	return {
		ratio,
		backpressure,
		branches: ids.length,
		offeredBytesPerSec:
			rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
	}
}

/** Branches without a decoderId (the tuner relay), reported separately. */
export function relayDropNow(history: readonly FanoutSample[]): number | null {
	const newest = history[history.length - 1]
	if (!newest) return null
	const ids = Object.entries(newest.branches)
		.filter(([, b]) => b.decoderId === undefined)
		.map(([id]) => id)
	return sumOver(history, ids).ratio
}

/** Append a counter sample; a decrease resets the history; samples older than the window are dropped. */
export function pushCounter(
	history: readonly CounterSample[],
	t: number,
	v: number,
	windowMs: number,
): CounterSample[] {
	const last = history[history.length - 1]
	if (last && v < last.v) return [{ t, v }]
	if (last && t <= last.t) return [...history]
	return [...history, { t, v }].filter(s => s.t >= t - windowMs)
}

/** Per-second rate once the history spans ≥ 20 s; null otherwise. */
export function counterRate(history: readonly CounterSample[]): number | null {
	const first = history[0]
	const last = history[history.length - 1]
	if (!first || !last) return null
	const span = last.t - first.t
	if (span < MIN_RATE_SPAN_MS) return null
	return Math.max(0, ((last.v - first.v) / span) * 1000)
}

export function restartIncrements(
	history: readonly CounterSample[],
	now: number,
): number {
	let n = 0
	for (let i = 1; i < history.length; i++) {
		const prev = history[i - 1]
		const cur = history[i]
		if (!prev || !cur || cur.t < now - RESTART_WINDOW_MS) continue
		if (cur.v > prev.v) n += cur.v - prev.v
	}
	return n
}

export function sparkAdd(
	spark: Readonly<Record<string, number>>,
	prev: CounterSample | undefined,
	cur: CounterSample,
): Record<string, number> {
	const minute = Math.floor(cur.t / 60_000)
	const delta = prev && cur.v >= prev.v ? cur.v - prev.v : 0
	const next: Record<string, number> = {}
	for (const [k, v] of Object.entries(spark)) {
		if (Number(k) > minute - SPARK_MINUTES) next[k] = v
	}
	const key = String(minute)
	next[key] = (next[key] ?? 0) + delta
	return next
}

/** 30 one-minute buckets, oldest first; undefined = not observed. */
export function sparkBuckets(
	spark: Readonly<Record<string, number>>,
	now: number,
): Array<number | undefined> {
	const m = Math.floor(now / 60_000)
	return Array.from(
		{ length: SPARK_MINUTES },
		(_, i) => spark[String(m - (SPARK_MINUTES - 1) + i)],
	)
}
