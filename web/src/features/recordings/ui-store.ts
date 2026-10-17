// The Recordings drawer's view state: search chips, the All / Kept filter, the open row and the keyboard
// cursor. Module-level so it survives closing and reopening the drawer; nothing is remembered across reloads.
import type { RecordingInventoryItem } from "@wavekit/api-types"

import { Store } from "../../data/store.ts"
import type { RecToken } from "./model.ts"
import { matchesAll } from "./model.ts"

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

export function addToken(t: RecToken): void {
	recordingsUi.update(s => ({ ...s, tokens: [...s.tokens, t], text: "" }))
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

export function setCursor(id: string | null): void {
	recordingsUi.update(s => ({ ...s, cursorId: id }))
}

/** The rows the list shows: not being deleted, through the filter and the search. */
export function visibleRecordings(
	items: readonly RecordingInventoryItem[],
	removing: ReadonlySet<string>,
	ui: Pick<RecordingsUiState, "tokens" | "text" | "filter">,
): RecordingInventoryItem[] {
	return items.filter(
		r =>
			!removing.has(r.id) &&
			(ui.filter === "all" || r.kept === true) &&
			matchesAll(r, ui.tokens, ui.text),
	)
}
