// What narrows every Activity list at once, beside the search: the time range ("Today ▾" chip, Activity board)
// and "With audio". Ranges are relative to when the query is built (Last hour = the hour before now) or a fixed
// custom span; a range whose end has passed shows no live arrivals. "With audio" keeps transmissions and calls
// (the voice category) until the core puts a recording id on the event (CORE-GAPS "The recording id on the event").
import type { ActivityCategory, ActivityQuery } from "@wavekit/api-types"

export type PresetRangeId = "any" | "1h" | "today" | "24h" | "7d"

/** Epoch ms; `to` null = up to now. */
export interface CustomRange {
	readonly kind: "custom"
	readonly from: number
	readonly to: number | null
}

export type TimeRange = { readonly kind: PresetRangeId } | CustomRange

export const ANY_TIME: TimeRange = { kind: "any" }

export const TIME_RANGES: readonly { id: PresetRangeId; label: string }[] = [
	{ id: "any", label: "Any time" },
	{ id: "1h", label: "Last hour" },
	{ id: "today", label: "Today" },
	{ id: "24h", label: "Last 24 h" },
	{ id: "7d", label: "Last 7 days" },
]

export const AUDIO_CATEGORIES: readonly ActivityCategory[] = ["voice"]

const HOUR = 3_600_000

function startOfDay(now: number): number {
	const d = new Date(now)
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

/** The range's bounds in epoch ms at `now`; null bounds are open. */
export function rangeBounds(
	r: TimeRange,
	now: number,
): { from: number | null; to: number | null } {
	switch (r.kind) {
		case "any":
			return { from: null, to: null }
		case "1h":
			return { from: now - HOUR, to: null }
		case "today":
			return { from: startOfDay(now), to: null }
		case "24h":
			return { from: now - 24 * HOUR, to: null }
		case "7d":
			return { from: now - 7 * 24 * HOUR, to: null }
		case "custom":
			return { from: r.from, to: r.to }
	}
}

/** The range has ended: nothing new can arrive in it. */
export function rangeEnded(r: TimeRange, now: number): boolean {
	return r.kind === "custom" && r.to !== null && r.to < now
}

const pad = (n: number) => String(n).padStart(2, "0")

/** "17 Oct 14:05" in local time (the custom range's chip). */
function shortStamp(ms: number, now: number): string {
	const d = new Date(ms)
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
	if (startOfDay(ms) === startOfDay(now)) return time
	const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
	return `${day} ${time}`
}

/** What the range chip says. */
export function rangeLabel(r: TimeRange, now: number): string {
	if (r.kind !== "custom")
		return TIME_RANGES.find(x => x.id === r.kind)?.label ?? "Any time"
	const from = shortStamp(r.from, now)
	return r.to === null ? `Since ${from}` : `${from} – ${shortStamp(r.to, now)}`
}

export function sameRange(a: TimeRange, b: TimeRange): boolean {
	if (a.kind !== b.kind) return false
	if (a.kind !== "custom" || b.kind !== "custom") return true
	return a.from === b.from && a.to === b.to
}

/** A custom range from two `datetime-local` values; null when either is invalid or they are reversed. */
export function customRange(
	fromLocal: string,
	toLocal: string,
): TimeRange | null {
	const from = fromLocal ? new Date(fromLocal).getTime() : Number.NaN
	if (!Number.isFinite(from)) return null
	const to = toLocal ? new Date(toLocal).getTime() : null
	if (to !== null && (!Number.isFinite(to) || to <= from)) return null
	return { kind: "custom", from, to }
}

/** Epoch ms as a `datetime-local` value (local time, minutes). */
export function localInput(ms: number): string {
	const d = new Date(ms)
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface ActivityScope {
	range: TimeRange
	audio: boolean
}

/** `q` narrowed by the scope at `now`; null when it cannot match anything (With audio over a non-voice search). */
export function scopedQuery(
	q: ActivityQuery | null,
	scope: ActivityScope,
	now: number,
): ActivityQuery | null {
	if (q === null) return null
	const out: ActivityQuery = { ...q }
	if (scope.audio) {
		const categories = q.categories
			? q.categories.filter(c => AUDIO_CATEGORIES.includes(c))
			: [...AUDIO_CATEGORIES]
		if (categories.length === 0) return null
		out.categories = categories
	}
	const { from, to } = rangeBounds(scope.range, now)
	if (from !== null || to !== null) {
		const producedAt: { from?: string; to?: string } = {}
		if (from !== null) producedAt.from = new Date(from).toISOString()
		if (to !== null) producedAt.to = new Date(to).toISOString()
		out.producedAt = producedAt
	}
	return out
}

/** The scope's words for list titles ("Today · With audio"); empty when nothing narrows. */
export function scopeTitle(scope: ActivityScope, now: number): string {
	const parts: string[] = []
	if (scope.range.kind !== "any") parts.push(rangeLabel(scope.range, now))
	if (scope.audio) parts.push("With audio")
	return parts.join(" · ")
}
