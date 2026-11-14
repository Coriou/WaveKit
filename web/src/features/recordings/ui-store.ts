// The Recordings drawer's view state: search chips, the All / Kept filter, the open row and the keyboard
// cursor. Module-level so it survives closing and reopening the drawer; nothing is remembered across reloads.
// The filtering itself runs on the core (model.ts recordingsQuery).
import type { RecordingInventoryItem } from "@wavekit/api-types"

import { Store } from "../../data/store.ts"
import type { RecToken } from "./model.ts"
import { withToken } from "./model.ts"

export type RecFilter = "all" | "kept"

export interface RecordingsUiState {
	tokens: readonly RecToken[]
	/** The search field's text (it filters as you type, like the board). */
	text: string
	filter: RecFilter
	openId: string | null
	cursorId: string | null
}

export const recordingsUi = new Store<RecordingsUiState>({
	tokens: [],
	text: "",
	filter: "all",
	openId: null,
	cursorId: null,
})

export function setFilter(filter: RecFilter): void {
	recordingsUi.update(s => ({ ...s, filter }))
}

export function setText(text: string): void {
	recordingsUi.update(s => ({ ...s, text }))
}

/** Adds a chip; it replaces the chip of its kind (one value per core filter). */
export function addToken(t: RecToken): void {
	recordingsUi.update(s => ({ ...s, tokens: withToken(s.tokens, t), text: "" }))
}

export function removeToken(index: number): void {
	recordingsUi.update(s => ({
		...s,
		tokens: s.tokens.filter((_, i) => i !== index),
	}))
}

export function clearSearch(): void {
	recordingsUi.update(s => ({ ...s, tokens: [], text: "" }))
}

/** Opens a row (null closes); the cursor follows. */
export function openRow(id: string | null): void {
	recordingsUi.update(s => ({ ...s, openId: id, cursorId: id ?? s.cursorId }))
}

/** A request to scroll a row into view (the player's title); `n` makes a repeat a change. */
export const revealRequest = new Store<{ id: string; n: number } | null>(null)

export function requestReveal(id: string): void {
	revealRequest.set({ id, n: (revealRequest.get()?.n ?? 0) + 1 })
}

export function setCursor(id: string | null): void {
	recordingsUi.update(s => ({ ...s, cursorId: id }))
}

/** The rows the list shows: the core's answer for the search, without those being deleted here. */
export function visibleRecordings(
	items: readonly RecordingInventoryItem[],
	removing: ReadonlySet<string>,
): readonly RecordingInventoryItem[] {
	return removing.size === 0 ? items : items.filter(r => !removing.has(r.id))
}
