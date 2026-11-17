// Keep for a playing recording, wherever it was played from. A playback id is the recording's stable key
// (an Activity row's `recording.id`, a catalogue item's `key ?? id`); the Keep route takes the catalogue id.
// A scanner key is its catalogue id; a dsd-fme call key is resolved through the Recordings list when it is
// loaded there (the core has no lookup by key yet).
import type {
	RecordingInventoryItem,
	RecordingKeepResult,
} from "@wavekit/api-types"
import {
	RECORDING_INVENTORY_ID,
	RECORDING_KEEP_ROUTE,
} from "@wavekit/api-types"

import type { ApiClient } from "../../data/api-client.ts"
import type { RecordingsStore } from "../../data/recordings-store.ts"
import { Store } from "../../data/store.ts"

/** The id surfaces play and mark a catalogue item by: its stable key, else its id. */
export const playbackIdOf = (item: RecordingInventoryItem): string =>
	item.key ?? item.id

export interface KeepTarget {
	/** The catalogue id the Keep route takes; null when it cannot be known here. */
	inventoryId: string | null
	/** Kept now; null when unknown. */
	kept: boolean | null
}

/** Keep answers for recordings that are not loaded in the Recordings list. */
export const keptHere = new Store<ReadonlyMap<string, boolean>>(new Map())

export function keepTarget(
	id: string,
	items: readonly RecordingInventoryItem[],
	known: ReadonlyMap<string, boolean>,
): KeepTarget {
	const item = items.find(i => i.id === id || i.key === id)
	if (item) return { inventoryId: item.id, kept: item.kept === true }
	return {
		inventoryId: RECORDING_INVENTORY_ID.test(id) ? id : null,
		kept: known.get(id) ?? null,
	}
}

export interface KeepLabel {
	/** "unknown": the Keep route is known but not whether it is kept; "unavailable": no Keep route here. */
	state: "kept" | "not-kept" | "unknown" | "unavailable"
	text: "Kept" | "Keep"
	title: string
	/** aria-pressed; undefined when the state is not known (never claims not kept). */
	pressed: boolean | undefined
	/** What a click asks for: keep (true) or unkeep (false); null: nothing. */
	next: boolean | null
}

/**
 * What the Keep button says. The kept state comes from the catalogue or an earlier Keep answer, else from the
 * row's own data (`rowKept`); unknown, it never reads as not kept: a click keeps it (the answer tells the state).
 */
export function keepLabel(
	target: KeepTarget,
	rowKept: boolean | null = null,
): KeepLabel {
	if (target.inventoryId === null)
		return {
			state: "unavailable",
			text: "Keep",
			title: "Open it in Recordings to keep it",
			pressed: undefined,
			next: null,
		}
	const kept = target.kept ?? rowKept
	if (kept === null)
		return {
			state: "unknown",
			text: "Keep",
			title:
				"Not known here whether it is kept. Keep protects it from every retention rule",
			pressed: undefined,
			next: true,
		}
	return kept
		? {
				state: "kept",
				text: "Kept",
				title: "Kept: retention never deletes it. Click to unkeep",
				pressed: true,
				next: false,
			}
		: {
				state: "not-kept",
				text: "Keep",
				title: "Keep: protect it from every retention rule",
				pressed: false,
				next: true,
			}
}

/** Keep (true) or unkeep (false) `id`; rejects with the ApiError. */
export async function setKept(
	api: ApiClient,
	recordings: RecordingsStore,
	id: string,
	kept: boolean,
): Promise<void> {
	const target = keepTarget(id, recordings.get().items, keptHere.get())
	if (target.inventoryId === null) return
	if (recordings.get().items.some(i => i.id === target.inventoryId)) {
		await recordings.setKept(target.inventoryId, kept)
		return
	}
	const route = RECORDING_KEEP_ROUTE.replace(
		":id",
		encodeURIComponent(target.inventoryId),
	)
	const result = kept
		? await api.put<RecordingKeepResult>(route)
		: await api.delete<RecordingKeepResult>(route)
	const next = new Map(keptHere.get())
	next.set(id, result.kept)
	keptHere.set(next)
}
