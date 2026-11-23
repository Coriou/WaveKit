// The time an Activity row shows. A row for a kept recording (a scanner file, a call with audio) shows when its
// audio starts, as the Recordings list does: the loaded recording's real start first (its receipt's first sample or
// its facts' start, so the two lists agree), else the start its stored record carries (a live transmission's
// startedAt) once that record was read here, else the row's producedAt. A kept scanner file's record carries no
// start of its own (its observationStartedAt is the transmission's, which a second over or a later part of the
// same session shares), so without its recording such a row shows producedAt. Only the shown time changes: the
// list stays ordered by producedAt, so a row's start can be earlier than the row below it.
import type {
	ActivityRecord,
	ActivitySummary,
	RecordingInventoryItem,
} from "@wavekit/api-types"

import { Store } from "../../data/store.ts"
import { recordedAt } from "../recordings/model.ts"
import { factsOf } from "../transmission/contract.ts"

/** Records whose start is remembered (the newest win). */
const MAX_STARTS = 1000

/** Event id → when its audio starts, from the Activity records read in this browser. */
export const recordStarts = new Store<ReadonlyMap<string, string>>(new Map())

/** The audio start a stored record carries; null when it carries none. */
export function recordStartOf(record: ActivityRecord): string | null {
	// a kept file's record names only its transmission's start, never its own: no start here
	const iso =
		record.kind === "analog-transmission" ? record.payload.startedAt : null
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
			// the receipt's first sample, else the facts' start, else the list's own time (the file name's, its write)
			const real = r.startedAt ?? factsOf(r)?.startedAt ?? null
			const d =
				real !== null && Number.isFinite(Date.parse(real))
					? new Date(real)
					: recordedAt(r)
			if (Number.isNaN(d.getTime())) continue
			const iso = d.toISOString()
			m.set(r.id, iso)
			if (r.key) m.set(r.key, iso)
		}
		startsCache.set(items, m)
	}
	return m
}
