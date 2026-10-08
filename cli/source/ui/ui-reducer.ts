import { VIEW_ORDER, type Action } from "./actions.js"
import { PRESET_ORDER, type UiState } from "./ui-state.js"

export interface UiCtx {
	/** Selectable row ids in display order (Messages: seq strings, newest first). */
	rowIds: readonly string[]
	pageSize: number
}

function select(ui: UiState, id: string | null): UiState {
	return { ...ui, selected: { ...ui.selected, [ui.view]: id } }
}

/** Freeze the Messages slice at its newest visible seq so the selected row cannot move. */
function pause(ui: UiState, ctx: UiCtx): UiState {
	const seqs = ctx.rowIds.map(Number).filter(Number.isFinite)
	return {
		...ui,
		messages: {
			...ui.messages,
			following: false,
			pausedAtSeq: seqs.length > 0 ? Math.max(...seqs) : null,
		},
	}
}

function resume(ui: UiState): UiState {
	return {
		...ui,
		messages: { ...ui.messages, following: true, pausedAtSeq: null },
	}
}

function moveBy(ui: UiState, ctx: UiCtx, delta: number): UiState {
	const base =
		ui.view === "messages" && ui.messages.following ? pause(ui, ctx) : ui
	const rows = ctx.rowIds
	if (rows.length === 0) return base
	const cur = base.selected[base.view]
	const idx = cur === null ? -1 : rows.indexOf(cur)
	const next = idx < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, idx + delta))
	return select(base, rows[next] ?? null)
}

export function applyUiAction(
	ui: UiState,
	action: Action,
	ctx: UiCtx,
	now: number,
): UiState {
	const v = ui.view
	switch (action.type) {
		case "view":
			return { ...ui, view: action.view, help: false, notice: null }
		case "view-step": {
			const n = VIEW_ORDER.length
			const i = VIEW_ORDER.indexOf(v)
			return {
				...ui,
				view: VIEW_ORDER[(i + action.delta + n) % n] ?? v,
				help: false,
				notice: null,
			}
		}
		case "help-open":
			return { ...ui, help: true }
		case "help-close":
			return { ...ui, help: false }
		case "quit":
			return { ...ui, quit: true }
		case "move":
			return moveBy(ui, ctx, action.delta)
		case "page":
			return moveBy(ui, ctx, action.delta * Math.max(1, ctx.pageSize))
		case "top": {
			const base =
				v === "messages" && ui.messages.following ? pause(ui, ctx) : ui
			return select(base, ctx.rowIds[0] ?? null)
		}
		case "newest":
			return v === "messages"
				? { ...resume(ui), selected: { ...ui.selected, messages: null } }
				: select(ui, ctx.rowIds[ctx.rowIds.length - 1] ?? null)
		case "open": {
			const id = ui.selected[v] ?? ctx.rowIds[0] ?? null
			if (id === null) return ui
			// Overview has no detail pane: Enter opens the decoder in the Decoders view (spec §7).
			const target = v === "overview" ? "decoders" : v
			return {
				...ui,
				view: target,
				selected: { ...ui.selected, [target]: id },
				detail: { ...ui.detail, [target]: { open: true, scroll: 0 } },
			}
		}
		case "escape": {
			if (ui.detail[v].open)
				return {
					...ui,
					detail: { ...ui.detail, [v]: { open: false, scroll: 0 } },
				}
			if (ui.selected[v] !== null) return select(ui, null)
			if (v === "messages" && ui.messages.filterText !== "") {
				return { ...ui, messages: { ...ui.messages, filterText: "" } }
			}
			return ui
		}
		case "detail-scroll": {
			const d = ui.detail[v]
			return {
				...ui,
				detail: {
					...ui.detail,
					[v]: { ...d, scroll: Math.max(0, d.scroll + action.delta * 5) },
				},
			}
		}
		case "filter-open":
			return {
				...ui,
				messages: { ...ui.messages, draft: ui.messages.filterText },
			}
		case "filter-type":
			return ui.messages.draft === null
				? ui
				: {
						...ui,
						messages: {
							...ui.messages,
							draft: ui.messages.draft + action.text,
						},
					}
		case "filter-backspace":
			return ui.messages.draft === null
				? ui
				: {
						...ui,
						messages: {
							...ui.messages,
							draft: Array.from(ui.messages.draft).slice(0, -1).join(""),
						},
					}
		case "filter-apply":
			return {
				...ui,
				messages: {
					...ui.messages,
					filterText: (ui.messages.draft ?? "").trim(),
					draft: null,
				},
				selected: { ...ui.selected, messages: null },
			}
		case "filter-cancel":
			return { ...ui, messages: { ...ui.messages, draft: null } }
		case "pause-toggle":
			return ui.messages.following ? pause(ui, ctx) : resume(ui)
		case "preset-cycle": {
			const i = PRESET_ORDER.indexOf(ui.messages.preset)
			return {
				...ui,
				messages: {
					...ui.messages,
					preset: PRESET_ORDER[(i + 1) % PRESET_ORDER.length] ?? "all",
				},
			}
		}
		case "confirm-no":
			return { ...ui, confirm: null }
		case "notice":
			return { ...ui, notice: { text: action.text, at: now } }
		default:
			return ui
	}
}
