// The Recordings list's keyboard map (one tab stop, a roving cursor): pure, so the map is tested as a
// table. ↑ ↓ move the cursor (an open row moves with it), Space plays or pauses the row, Enter opens or
// closes it, Escape closes it, J / L seek back / on and K pauses while something is loaded (the list's
// keys win over the app's single-key shortcuts), S keeps, Delete or Backspace deletes.

export type ListKeyAction =
	| { type: "move"; by: -1 | 1 }
	| { type: "play" }
	| { type: "toggle-open" }
	| { type: "close" }
	| { type: "player-toggle" }
	| { type: "seek"; by: -1 | 1 }
	| { type: "keep" }
	| { type: "delete" }

export interface ListKeyContext {
	/** A row is under the cursor. */
	cursor: boolean
	/** A row is open. */
	open: boolean
	/** The player has a recording loaded. */
	loaded: boolean
	readOnly: boolean
	/** The row under the cursor can be deleted from here (deleteBlocker is null). */
	deletable: boolean
}

export interface ListKey {
	key: string
	metaKey?: boolean
	ctrlKey?: boolean
	altKey?: boolean
	/** The key went to a text field inside the list. */
	inField?: boolean
}

/** What a key does on the list, or null (the key goes on to the app). */
export function listKeyAction(
	e: ListKey,
	ctx: ListKeyContext,
): ListKeyAction | null {
	if (e.inField || e.metaKey || e.ctrlKey || e.altKey) return null
	const k = e.key.toLowerCase()
	if (e.key === "ArrowDown") return { type: "move", by: 1 }
	if (e.key === "ArrowUp") return { type: "move", by: -1 }
	if (e.key === " " && ctx.cursor) return { type: "play" }
	if (e.key === "Enter" && ctx.cursor) return { type: "toggle-open" }
	if (e.key === "Escape" && ctx.open) return { type: "close" }
	if ((k === "j" || k === "l" || k === "k") && ctx.loaded)
		return k === "k"
			? { type: "player-toggle" }
			: { type: "seek", by: k === "l" ? 1 : -1 }
	if (k === "s" && ctx.cursor && !ctx.readOnly) return { type: "keep" }
	if (
		(e.key === "Delete" || e.key === "Backspace") &&
		ctx.cursor &&
		!ctx.readOnly &&
		ctx.deletable
	)
		return { type: "delete" }
	return null
}
