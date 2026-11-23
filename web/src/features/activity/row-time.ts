// The time an Activity row shows. A row for a kept recording (a scanner file, a call with audio) shows when its
// audio starts, as the Recordings list does: the loaded recording's start first (so the two lists agree), else
// the start its stored record carries (a kept file's own start, keptFileStartOf; a live transmission's startedAt) once
// that record was read here, else the row's producedAt. Only the shown time changes: the list stays ordered by
// producedAt, so a row's start can be earlier than the row below it.
import type {
	ActivityRecord,
	ActivitySummary,
	RecordingInventoryItem,
} from "@wavekit/api-types"

import { Store } from "../../data/store.ts"
import { recordedAt } from "../recordings/model.ts"

/** Records whose start is remembered (the newest win). */
const MAX_STARTS = 1000

/** Event id → when its audio starts, from the Activity records read in this browser. */
export const recordStarts = new Store<ReadonlyMap<string, string>>(new Map())

/**
 * A first file is kept within seconds of its audio's end; a later part of a rolled-over transmission starts at
 * least one file limit (minutes) after its observation did. A gap between the observation's start and this file's
 * start (its keep less its length) above this means the file is a later part.
 */
export const LATER_PART_GAP_MS = 30_000

/**
 * When a kept scanner file's own audio starts, from its stored record: the observation's start for its first (or
 * only) file; for a later part of a rolled-over transmission, whose observation started long before it, its keep
 * time less its length (the file was whole when it was kept, so that is when its audio started, give or take the
 * keep's latency). The record names no part, so a later part is told by the gap (LATER_PART_GAP_MS). Null when
 * neither time is valid.
 */
export function keptFileStartOf(p: {
	observationStartedAt: string | null
	finalizedAt: string
	durationMs: number
}): string | null {
	const obs =
		typeof p.observationStartedAt === "string"
			? Date.parse(p.observationStartedAt)
			: Number.NaN
	const kept = Date.parse(p.finalizedAt)
	const own =
		Number.isFinite(kept) && Number.isFinite(p.durationMs)
			? kept - Math.max(0, p.durationMs)
			: Number.NaN
	if (
		Number.isFinite(own) &&
		(!Number.isFinite(obs) || own - obs > LATER_PART_GAP_MS)
	)
		return new Date(own).toISOString()
	return Number.isFinite(obs) ? new Date(obs).toISOString() : null
}

/** The audio start a stored record carries; null when it carries none. */
export function recordStartOf(record: ActivityRecord): string | null {
	const iso =
		record.kind === "recording-change"
			? keptFileStartOf(record.payload)
			: record.kind === "analog-transmission"
				? record.payload.startedAt
				: null
	return typeof iso === "string" && Number.isFinite(Date.parse(iso))
		? iso
		: null
}

/** Remembers the audio start of a record just read (the event detail, the Transmission view). */
export function noteRecordStart(record: ActivityRecord | null): void {
	if (record === null || typeof record !== "object") return
	const start = recordStartOf(record)
	if (start === null || recordStarts.get().get(record.eventId) === start) return
	const next = new Map(recordStarts.get())
	next.delete(record.eventId)
	next.set(record.eventId, start)
	while (next.size > MAX_STARTS) {
		const oldest = next.keys().next().value
		if (oldest === undefined) break
		next.delete(oldest)
	}
	recordStarts.set(next)
}

/** A row for a kept recording: it links a file, or it is a kept scanner file's change. */
export function isKeptRecordingRow(item: ActivitySummary): boolean {
	return item.recording !== undefined || item.kind === "recording-change"
}

/**
 * The time a row shows: for a kept recording, its loaded recording's start, else its record's start, else
 * producedAt; for any other row, producedAt.
 */
export function rowTimeOf(
	item: ActivitySummary,
	known: { recording: string | null; record: string | null },
): string {
	if (!isKeptRecordingRow(item)) return item.producedAt
	for (const t of [known.recording, known.record])
		if (typeof t === "string" && Number.isFinite(Date.parse(t))) return t
	return item.producedAt
}

const startsCache = new WeakMap<
	readonly RecordingInventoryItem[],
	Map<string, string>
>()

/** Recording key (and catalogue id) → its start as the Recordings list shows it, once per loaded list. */
export function recordingStarts(
	items: readonly RecordingInventoryItem[],
): Map<string, string> {
	let m = startsCache.get(items)
	if (m === undefined) {
		m = new Map()
		for (const r of items) {
			const d = recordedAt(r)
			if (Number.isNaN(d.getTime())) continue
			const iso = d.toISOString()
			m.set(r.id, iso)
			if (r.key) m.set(r.key, iso)
		}
		startsCache.set(items, m)
	}
	return m
}
