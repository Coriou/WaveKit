import { VIEW_ORDER, type Action } from "./actions.js"
import { PRESET_ORDER, type UiState } from "./ui-state.js"

export interface UiCtx {
	/** Selectable row ids in display order (Messages: seq strings, newest first). */
	rowIds: readonly string[]
	pageSize: number
	/** Last scroll offset at which the open detail still fills its pane (R73, M3). */
	detailMaxScroll?: number
	/** Messages: the ring's newest seq, so a pause with no visible rows still freezes (R73, M4). */
	newestSeq?: number | null
}

/** A new selection starts its open detail at the top (R73, M3). */
function select(ui: UiState, id: string | null): UiState {
	const v = ui.view
	const d = ui.detail[v]
	return {
		...ui,
		selected: { ...ui.selected, [v]: id },
		...(id !== ui.selected[v] && d.scroll !== 0
			? { detail: { ...ui.detail, [v]: { ...d, scroll: 0 } } }
			: {}),
	}
}

/**
 * Freeze the Messages slice at its newest visible seq so the selected row cannot
 * move; with no visible rows, at the ring's newest seq (M4). `pausedAt` lets the
 * frozen slice leave out gaps that open later (M5).
 */
function pause(ui: UiState, ctx: UiCtx, now: number): UiState {
	const seqs = ctx.rowIds.map(Number).filter(Number.isFinite)
	return {
		...ui,
		messages: {
			...ui.messages,
			following: false,
			pausedAtSeq:
				seqs.length > 0 ? Math.max(...seqs) : (ctx.newestSeq ?? null),
			pausedAt: now,
		},
	}
}

function resume(ui: UiState): UiState {
	const { pausedAt: _pausedAt, ...rest } = ui.messages
	return {
		...ui,
		messages: { ...rest, following: true, pausedAtSeq: null },
	}
}

/** Selecting a Messages row while following freezes the feed (§6.3); an empty list has nothing to hold. */
function autoPause(ui: UiState, ctx: UiCtx, now: number): UiState {
	return ui.view === "messages" &&
		ui.messages.following &&
		ctx.rowIds.length > 0
		? pause(ui, ctx, now)
		: ui
}

/** Clearing the Messages selection also closes its detail, which would otherwise show no row. */
function clearMessagesSelection(ui: UiState): UiState {
	return {
		...ui,
		selected: { ...ui.selected, messages: null },
		detail: { ...ui.detail, messages: { open: false, scroll: 0 } },
	}
}

function moveBy(ui: UiState, ctx: UiCtx, delta: number, now: number): UiState {
	const rows = ctx.rowIds
	if (rows.length === 0) return ui
	const base = autoPause(ui, ctx, now)
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
			return moveBy(ui, ctx, action.delta, now)
		case "page":
			return moveBy(ui, ctx, action.delta * Math.max(1, ctx.pageSize), now)
		case "top": {
			if (ctx.rowIds.length === 0) return ui
			return select(autoPause(ui, ctx, now), ctx.rowIds[0] ?? null)
		}
		case "newest":
			return v === "messages"
				? clearMessagesSelection(resume(ui))
				: select(ui, ctx.rowIds[ctx.rowIds.length - 1] ?? null)
		case "open": {
			const id = ui.selected[v] ?? ctx.rowIds[0] ?? null
			if (id === null) return ui
			// Overview has no detail pane: Enter opens the decoder in the Decoders view (spec §7).
			const target = v === "overview" ? "decoders" : v
			const base = autoPause(ui, ctx, now)
			return {
				...base,
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
					[v]: {
						...d,
						scroll: Math.max(
							0,
							Math.min(
								ctx.detailMaxScroll ?? Number.POSITIVE_INFINITY,
								d.scroll + action.delta * 5,
							),
						),
					},
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
			return clearMessagesSelection({
				...ui,
				messages: {
					...ui.messages,
					filterText: (ui.messages.draft ?? "").trim(),
					draft: null,
				},
			})
		case "filter-cancel":
			return { ...ui, messages: { ...ui.messages, draft: null } }
		case "pause-toggle":
			return ui.messages.following ? pause(ui, ctx, now) : resume(ui)
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
