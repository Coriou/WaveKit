// One layout for everything that floats in the shell (docs/web/DESIGN.md, "Layout: rails and stage"). Two rails hold
// the persistent chrome and never change when a drawer opens: the top rail has the Tuner, a status slot and the
// Receiver; the bottom rail has Listen and the dock, with one storey above Listen for the player and the tuned card's
// home above that. Everything between the rails is the stage: drawers, the pane, expanded Activity and the phone
// sheet take stage room only, and the plot gets every chrome rectangle over it as an exclusion zone. Pure and DOM
// free: components report their intrinsic sizes, the shell calls computeLayout and each slot applies its rectangle.
import { plotLayout, DISCOVERY_ROW_CSS, RULER_CSS } from "../../plot/layout.ts"
import {
	CARD_W,
	DEFAULT_CARD_ANCHOR,
	DOCK_MIN_VW,
	DR_MAX,
	DR_MIN,
	FULL_MIN_VW,
	G,
	cardAnchors,
	nearestAnchor,
	toCardAnchorId,
	type CardAnchor,
	type CardAnchorId,
} from "../layout.ts"
import type { DrawerId, IslandId } from "../store.ts"
import {
	bottom,
	insideOf,
	intersects,
	rect,
	right,
	separation,
	type Rect,
	type Size,
} from "./geometry.ts"

export type { Rect, Size } from "./geometry.ts"

/** Below this width the dock drops the active view's label (448 px instead of 492). */
export const DOCK_COMPACT_VW = 1180
/** The tuned card hides at this width and below (board rule). */
export const CARD_MAX_HIDDEN_VW = FULL_MIN_VW
/** The status slot's row: the top rail's 56 px island row, from y 16 to 72. */
export const STATUS_ROW_H = 56
/** Room between two status items, and between the strip and the top rail. */
export const STATUS_GAP = 8
/** A status slot narrower than this (or a stacked top row) sends the items to the strip under the top rail. */
export const STATUS_MIN_W = 200
/** A status item wrapped to two lines (13 px text at 1.4 line height, inside a 44 px toast's padding). */
export const TWO_LINE_H = 52
/** A two-line item needs at least half its one-line width plus this much for its glyph and buttons. */
export const TWO_LINE_PAD = 64
/** The player storey's width (the transport's full row), capped by the window less both gutters. */
export const PLAYER_STOREY_W = 560
/** An attached pane needs at least the player storey's width left of the drawer; else it is pushed in. */
export const PANE_MIN_W = PLAYER_STOREY_W
/** The plot body starts this far under the top rail (84 = 72 + 12 on the default rail). */
export const PLOT_INSET_GAP = 12
/** Neighbours in one rail row that the boards draw 8 px apart: the stacked Receiver under the Tuner, the phone's
 * search button beside Listen, and the status strip under the top rail. */
export const RAIL_NEIGHBOUR_GAP = 8
/** Fallback sizes before anything is measured (the boards' figures). */
export const DEFAULT_SIZES = {
	tuner: { w: 440, h: 56 },
	receiver: { w: 300, h: 56 },
	listen: { w: 340, h: 64 },
	dock: { wide: { w: 492, h: 64 }, compact: { w: 448, h: 64 } },
	find: { w: 48, h: 48 },
	cardExpanded: { w: CARD_W, h: 300 },
	cardLine: { w: CARD_W, h: 52 },
} as const

export type StatusKind =
	| "condition"
	| "connection"
	| "back-to-live"
	| "paused"
	| "receipt"
export type StatusForm = "full" | "compact" | "icon"

/** A status item's measured forms; the layout picks one. */
export interface StatusItem {
	readonly id: string
	readonly kind: StatusKind
	readonly forms: {
		readonly full: Size
		readonly compact?: Size
		readonly icon?: Size
	}
}

export interface DrawerInput {
	readonly id: DrawerId
	readonly wantedW: number
	/** Activity › Cards › Expand. */
	readonly expanded: boolean
	readonly pane: { readonly want: boolean; readonly pushIn: boolean } | null
	/** The drawer has a notice slot under its header to dock status items in. */
	readonly hasNoticeSlot: boolean
}

export interface LayoutInput {
	readonly viewport: Size
	/** The Tuner's head, the scan hold row included. */
	readonly tuner: Size
	readonly receiver: Size
	readonly listen: Size
	readonly dock: { readonly wide: Size; readonly compact: Size }
	readonly find?: Size
	/** The player's measured size, or null while nothing is in it. */
	readonly player: Size | null
	readonly card: {
		readonly expanded: Size
		readonly line: Size
		readonly minimised: boolean
		readonly anchor: CardAnchorId | string
	} | null
	readonly status: readonly StatusItem[]
	readonly drawer: DrawerInput | null
	/** Open island panels (popovers): exclusion zones for the plot only. */
	readonly panels: readonly { readonly island: IslandId; readonly size: Size }[]
}

export type DrawerShape = "column" | "between-rails" | "sheet" | "expanded"

export interface StatusPlaced extends Rect {
	readonly id: string
	readonly kind: StatusKind
	readonly form: StatusForm
	/** Wrapped to two lines. */
	readonly lines: 1 | 2
}

export interface CardPlaced extends Rect {
	readonly anchor: CardAnchorId
	readonly form: "expanded" | "line"
}

export interface DrawerPlaced extends Rect {
	readonly shape: DrawerShape
	readonly foot: "edge" | "rail" | "stack"
	readonly resizable: boolean
	readonly maxW: number
	readonly pushed: boolean
}

export interface Layout {
	readonly viewport: Size
	readonly tuner: Rect
	readonly receiver: Rect
	/** The Receiver sits under the Tuner (the top row cannot hold both). */
	readonly stacked: boolean
	readonly listen: Rect
	readonly dock: (Rect & { readonly compact: boolean }) | null
	readonly find: Rect | null
	readonly player: Rect | null
	readonly card: CardPlaced | null
	readonly cardAnchors: readonly CardAnchor[]
	/** The free width the card is dragged in (left of a drawer column). */
	readonly cardFreeW: number
	readonly status: {
		readonly where: "rail" | "strip" | "drawer-slot"
		/** The top rail's slot between the Tuner and the Receiver, or null in strip mode. */
		readonly slot: Rect | null
		/** The strip under the top rail holding the items, or null (rail, drawer slot, nothing to show). */
		readonly strip: Rect | null
		/** Placed items; empty in the drawer slot, which lays its items out itself. */
		readonly items: readonly StatusPlaced[]
		/** Items in the drawer's notice slot. */
		readonly docked: readonly string[]
		/** Items with no room now (shown again when there is). */
		readonly waiting: readonly string[]
	}
	readonly drawer: DrawerPlaced | null
	readonly pane: Rect | null
	readonly grip: Rect | null
	readonly plot: {
		readonly insetTop: number
		/** The plot's scale rows (axis, lanes, discovery row, ruler) end at or above this (shell px). */
		readonly rowsBottomMax: number
		/** The trace stops here at the latest so the scale rows keep above the stack (plot-body px). */
		readonly rowsMaxCss: number
		readonly visible: Rect
		/** Centre of the plot's status notes (shell px). */
		readonly noteCx: number
		/** Chrome over the plot body, in plot-body coordinates. */
		readonly exclusions: readonly Rect[]
	}
	readonly map: { readonly top: number; readonly right: number }
}

const clamp = (v: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(hi, v))

/** State-group rank from the Receiver outward. */
const STATE_ORDER: readonly StatusKind[] = [
	"condition",
	"connection",
	"back-to-live",
	"paused",
]

interface Pick {
	item: StatusItem
	form: StatusForm
	lines: 1 | 2
	size: Size
}

const formSize = (item: StatusItem, form: StatusForm): Size | undefined =>
	item.forms[form]

/** Height of `full` at width `w`: one line when it fits, two when half of it (plus the glyph and buttons) fits. */
function wrapAt(full: Size, w: number): { size: Size; lines: 1 | 2 } | null {
	if (full.w <= w) return { size: full, lines: 1 }
	if (full.w / 2 + TWO_LINE_PAD <= w)
		return { size: { w, h: Math.max(full.h, TWO_LINE_H) }, lines: 2 }
	return null
}

/** The rail's two groups (R3): the state group packed against the Receiver, the receipt against the Tuner. */
function fitRail(
	items: readonly StatusItem[],
	slot: Rect,
): { placed: StatusPlaced[]; waiting: string[] } {
	const receipt = items.find(i => i.kind === "receipt") ?? null
	let state = STATE_ORDER.flatMap(k => items.filter(i => i.kind === k))
	const waiting: string[] = []
	const one = (item: StatusItem): Pick => ({
		item,
		form: "full",
		lines: 1,
		size: item.forms.full,
	})
	const width = (ps: readonly Pick[]) =>
		ps.reduce((s, p) => s + p.size.w, 0) +
		Math.max(0, ps.length - 1) * STATUS_GAP
	for (;;) {
		let r = receipt ? one(receipt) : null
		let s = state.map(one)
		const total = () => width([...(r ? [r] : []), ...s])
		const fits = () => total() <= slot.w
		const setForm = (kind: StatusKind, form: StatusForm) => {
			s = s.map(p => {
				const size = p.item.kind === kind ? formSize(p.item, form) : undefined
				return size ? { ...p, form, size } : p
			})
		}
		// a lone item wraps to two lines at the slot's width before it changes form
		const lone = (r ? 1 : 0) + s.length === 1
		if (lone) {
			const p = (r ?? s[0]) as Pick
			const w = wrapAt(p.item.forms.full, slot.w)
			if (w) {
				const placed = { ...p, lines: w.lines, size: w.size }
				if (r) r = placed
				else s = [placed]
				return { placed: place(r, s, slot), waiting }
			}
		}
		if (fits()) return { placed: place(r, s, slot), waiting }
		setForm("condition", "compact")
		if (fits()) return { placed: place(r, s, slot), waiting }
		setForm("connection", "compact")
		if (fits()) return { placed: place(r, s, slot), waiting }
		setForm("condition", "icon")
		if (fits()) return { placed: place(r, s, slot), waiting }
		if (r) {
			const room = slot.w - (s.length > 0 ? width(s) + STATUS_GAP : 0)
			const w = wrapAt(r.item.forms.full, room)
			if (w) {
				r = { ...r, lines: w.lines, size: w.size }
				if (fits()) return { placed: place(r, s, slot), waiting }
			}
		}
		// the lowest-ranked state item waits, then the receipt
		const last = state.at(-1)
		if (last) {
			waiting.unshift(last.id)
			state = state.slice(0, -1)
			continue
		}
		if (receipt) waiting.unshift(receipt.id)
		return { placed: [], waiting }
	}
}

function place(r: Pick | null, s: readonly Pick[], slot: Rect): StatusPlaced[] {
	// an item taller than the row is clamped to it (centred, never above the window's margin)
	const at = (p: Pick, x: number): StatusPlaced => {
		const h = Math.min(p.size.h, STATUS_ROW_H)
		return {
			id: p.item.id,
			kind: p.item.kind,
			form: p.form,
			lines: p.lines,
			x,
			y: slot.y + Math.round((STATUS_ROW_H - h) / 2),
			w: p.size.w,
			h,
		}
	}
	const out: StatusPlaced[] = []
	if (r) out.push(at(r, slot.x))
	let x = right(slot)
	for (const p of s) {
		x -= p.size.w
		out.push(at(p, x))
		x -= STATUS_GAP
	}
	return out
}

/** The strip (R3 fallback): every item at the strip's width, stacked, the state group first; items that would
 * reach `maxBottom` wait. */
function fitStrip(
	items: readonly StatusItem[],
	x: number,
	y: number,
	w: number,
	maxBottom: number,
): { placed: StatusPlaced[]; waiting: string[] } {
	const order = [
		...STATE_ORDER.flatMap(k => items.filter(i => i.kind === k)),
		...items.filter(i => i.kind === "receipt"),
	]
	const placed: StatusPlaced[] = []
	const waiting: string[] = []
	let top = y
	for (const item of order) {
		const full = item.forms.full
		const lines: 1 | 2 = full.w <= w ? 1 : 2
		const h = lines === 1 ? full.h : Math.max(full.h, TWO_LINE_H)
		if (waiting.length > 0 || top + h > maxBottom) {
			waiting.push(item.id)
			continue
		}
		placed.push({
			id: item.id,
			kind: item.kind,
			form: "full",
			lines,
			x,
			y: top,
			w,
			h,
		})
		top += h + STATUS_GAP
	}
	return { placed, waiting }
}

export function computeLayout(input: LayoutInput): Layout {
	const { w: W, h: H } = input.viewport

	// ---- frame (R1): none of these reads the drawer, the status items or the player
	const tuner = rect(G, G, Math.min(input.tuner.w, W - 2 * G), input.tuner.h)
	const rxW = Math.min(input.receiver.w, W - 2 * G)
	const stacked = G + tuner.w + G + rxW + G > W
	const receiver = stacked
		? rect(G, bottom(tuner) + RAIL_NEIGHBOUR_GAP, rxW, input.receiver.h)
		: rect(W - G - rxW, G, rxW, input.receiver.h)
	const topRail = Math.max(bottom(tuner), bottom(receiver))
	// the dock hides below 761 px, and wherever Listen and the dock cannot share the bottom rail (the search
	// button opens everything it holds)
	const compact = W < DOCK_COMPACT_VW
	const dockSize = compact ? input.dock.compact : input.dock.wide
	const dockHidden =
		W < DOCK_MIN_VW || G + input.listen.w + G + dockSize.w + G > W
	const findSize = input.find ?? DEFAULT_SIZES.find
	const find = dockHidden
		? rect(W - G - findSize.w, H - G - findSize.h, findSize.w, findSize.h)
		: null
	const listenW = Math.min(
		input.listen.w,
		W - 2 * G - (find ? find.w + RAIL_NEIGHBOUR_GAP : 0),
	)
	const listen = rect(G, H - G - input.listen.h, listenW, input.listen.h)
	let dock: (Rect & { compact: boolean }) | null = null
	if (!dockHidden) {
		const d = dockSize
		const lo = right(listen) + G
		const x = Math.max(lo, Math.min(Math.round((W - d.w) / 2), W - G - d.w))
		dock = { ...rect(x, H - G - d.h, d.w, d.h), compact }
	}
	const railTop = Math.min(listen.y, dock?.y ?? Infinity, find?.y ?? Infinity)

	// ---- stack (R4): the bottom rail, the player storey, the card home; the storey stands on the rail's top (the
	// taller of Listen and the dock), so it keeps a gutter from both
	const storeyW = Math.min(PLAYER_STOREY_W, W - 2 * G)
	const player = input.player
		? rect(
				G,
				railTop - G - input.player.h,
				Math.min(input.player.w, storeyW),
				input.player.h,
			)
		: null
	const stackTop = player ? player.y : railTop
	const coverTop = topRail + G
	const coverFoot = stackTop - G

	// ---- drawer and pane (R2)
	let drawer: Layout["drawer"] = null
	let pane: Rect | null = null
	let grip: Rect | null = null
	const di = input.drawer
	if (di) {
		const cap = W - G - (G + storeyW + G)
		const column = W >= FULL_MIN_VW && cap >= DR_MIN && !di.expanded
		if (column) {
			const maxW = Math.min(DR_MAX, cap)
			const w = clamp(Math.round(di.wantedW), DR_MIN, maxW)
			const x = W - G - w
			const top = bottom(receiver) + G
			const paneRoom = x + 1 - G
			const paneOn = di.pane?.want === true && paneRoom >= PANE_MIN_W
			const pushed = di.pane?.want === true && !paneOn && di.pane.pushIn
			const edge = !paneOn && (dock === null || x >= right(dock) + G)
			const foot = edge ? H - G : railTop - G
			drawer = {
				...rect(x, top, w, foot - top),
				shape: "column",
				foot: edge ? "edge" : "rail",
				resizable: !pushed,
				maxW: Math.max(DR_MIN, maxW),
				pushed,
			}
			// a covering surface: under the Tuner's hold row too, down to the stack
			if (paneOn) pane = rect(G, coverTop, paneRoom, coverFoot - coverTop)
			if (!pushed) grip = rect(x - 10, top + 16, 20, drawer.h - 32)
		} else {
			const shape: DrawerShape =
				W < FULL_MIN_VW ? (dockHidden ? "sheet" : "between-rails") : "expanded"
			const pushed = di.pane?.want === true && di.pane.pushIn && !di.expanded
			drawer = {
				...rect(G, coverTop, W - 2 * G, coverFoot - coverTop),
				shape,
				foot: "stack",
				resizable: false,
				maxW: DR_MAX,
				pushed,
			}
		}
	}
	const covering = drawer !== null && drawer.shape !== "column"

	// ---- plot rows: the scale rows end above the stack; the trace is capped for that
	const insetTop = topRail + PLOT_INSET_GAP
	const rowsBottomMax = stackTop - G
	const rowsMaxCss = rowsBottomMax - insetTop
	// the worst case for what sits on the trace: the discovery row shown (a shorter trace)
	const trace = plotLayout(
		H - insetTop,
		DISCOVERY_ROW_CSS + RULER_CSS,
		rowsMaxCss,
	).traceCss

	// ---- status (R3)
	const slotX = right(tuner) + G
	const slotW = receiver.x - G - slotX
	const rail = !stacked && slotW >= STATUS_MIN_W
	const slot = rail ? rect(slotX, G, slotW, STATUS_ROW_H) : null
	let where: Layout["status"]["where"] = rail ? "rail" : "strip"
	let items: StatusPlaced[] = []
	let waiting: string[] = []
	let docked: string[] = []
	let strip: Rect | null = null
	if (slot) {
		const r = fitRail(input.status, slot)
		items = r.placed
		waiting = r.waiting
	} else if (input.status.length > 0) {
		const y = topRail + RAIL_NEIGHBOUR_GAP
		const x = G
		// left of a drawer column (a narrow slot on a wide window), else the window's width
		const w = (drawer?.shape === "column" ? drawer.x - G : W - G) - x
		const r = fitStrip(
			input.status,
			x,
			y,
			w,
			Math.min(coverFoot, insetTop + trace),
		)
		const box =
			r.placed.length > 0
				? rect(x, y, w, Math.max(...r.placed.map(bottom)) - y)
				: null
		// a covering surface under the strip (a covering drawer, or an attached pane beside a column): the items dock
		// in the drawer's notice slot
		const cover = covering ? drawer : pane
		if (box && cover && intersects(box, cover)) {
			if (di?.hasNoticeSlot) {
				where = "drawer-slot"
				docked = input.status.map(i => i.id)
			} else waiting = input.status.map(i => i.id)
		} else {
			items = r.placed
			waiting = r.waiting
			strip = box
		}
	}

	// ---- the tuned card (R4, R5)
	let card: Layout["card"] = null
	let anchors: CardAnchor[] = []
	const freeW = drawer?.shape === "column" ? drawer.x : W
	const ci = input.card
	if (
		ci &&
		W > CARD_MAX_HIDDEN_VW &&
		!covering &&
		pane === null &&
		!(drawer?.pushed ?? false)
	) {
		const islands: Rect[] = [tuner, receiver, listen]
		if (slot) islands.push(slot)
		if (strip) islands.push(strip)
		if (dock) islands.push(dock)
		if (find) islands.push(find)
		if (player) islands.push(player)
		if (drawer) islands.push(drawer)
		const at = toCardAnchorId(ci.anchor) ?? DEFAULT_CARD_ANCHOR
		const limit = topRail + G
		const solve = (s: Size) =>
			cardAnchors(islands, freeW, H, s.h, stackTop - G - s.h, limit)
		let form: "expanded" | "line" = ci.minimised ? "line" : "expanded"
		let size = form === "line" ? ci.line : ci.expanded
		let r = solve(size)
		let home = r.anchors.find(a => a.id === at) ?? null
		// no room for the expanded card on its anchor: its minimised line, on the same anchor
		if (!home && form === "expanded") {
			const r2 = solve(ci.line)
			const h2 = r2.anchors.find(a => a.id === at)
			if (h2) {
				form = "line"
				size = ci.line
				r = r2
				home = h2
			}
		}
		if (!home) {
			const want = r.spots[at]
			home = nearestAnchor(r.anchors, want.x, want.y)
		}
		anchors = r.anchors
		if (home)
			card = { ...rect(home.x, home.y, CARD_W, size.h), anchor: home.id, form }
	}

	// ---- plot contract (R6)
	const body = rect(0, insetTop, W, H - insetTop)
	const panelRects = input.panels.map(p => {
		if (p.island === "tuner")
			return rect(tuner.x, bottom(tuner) + 8, p.size.w, p.size.h)
		if (p.island === "receiver")
			return rect(
				right(receiver) - p.size.w,
				bottom(receiver) + 8,
				p.size.w,
				p.size.h,
			)
		return rect(listen.x, listen.y - 8 - p.size.h, p.size.w, p.size.h)
	})
	const chrome: Rect[] = [
		tuner,
		receiver,
		listen,
		...(dock ? [dock] : []),
		...(find ? [find] : []),
		...(player ? [player] : []),
		...(card ? [card] : []),
		...items,
		...(strip ? [strip] : []),
		...(drawer ? [drawer] : []),
		...(pane ? [pane] : []),
		...(grip ? [grip] : []),
		...panelRects,
	]
	const exclusions = chrome
		.filter(r => intersects(r, body))
		.map(r => rect(r.x, r.y - insetTop, r.w, r.h))
	const visibleW = drawer?.shape === "column" ? drawer.x : W
	const visible = covering
		? rect(0, insetTop, W, Math.max(0, coverTop - insetTop))
		: rect(0, insetTop, visibleW, H - insetTop)

	return {
		viewport: input.viewport,
		tuner,
		receiver,
		stacked,
		listen,
		dock,
		find,
		player,
		card,
		cardAnchors: anchors,
		cardFreeW: freeW,
		status: { where, slot, strip, items, docked, waiting },
		drawer,
		pane,
		grip,
		plot: {
			insetTop,
			rowsBottomMax,
			rowsMaxCss,
			visible,
			noteCx: Math.round(visibleW / 2),
			exclusions,
		},
		map: {
			top: coverTop,
			right: drawer?.shape === "column" ? W - drawer.x + G : G,
		},
	}
}

const sameRect = (a: Rect, b: Rect) =>
	a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** The plot's part of two layouts holds the same numbers and rectangles. */
export function samePlot(a: Layout["plot"], b: Layout["plot"]): boolean {
	return (
		a === b ||
		(a.insetTop === b.insetTop &&
			a.rowsBottomMax === b.rowsBottomMax &&
			a.rowsMaxCss === b.rowsMaxCss &&
			a.noteCx === b.noteCx &&
			sameRect(a.visible, b.visible) &&
			a.exclusions.length === b.exclusions.length &&
			a.exclusions.every((r, i) => {
				const o = b.exclusions[i]
				return o !== undefined && sameRect(r, o)
			}))
	)
}

/** The previous plot part while the new one holds the same contents (the plot re-renders only on a change). */
export function stablePlot(
	prev: Layout["plot"] | null,
	next: Layout["plot"],
): Layout["plot"] {
	return prev !== null && samePlot(prev, next) ? prev : next
}

/** One rectangle named for the checks. */
export interface Named extends Rect {
	readonly name: string
}

export interface Violation {
	readonly kind: "intersect" | "gap" | "outside"
	readonly a: string
	readonly b?: string
	/** The clear distance found, and the one needed. */
	readonly gap?: number
	readonly need?: number
}

/** Every rectangle the no-intersection rule (I1) covers, by name. Status items are "status:<id>". */
export function namedRects(layout: Layout): Named[] {
	const out: Named[] = []
	const add = (name: string, r: Rect | null) => {
		if (r) out.push({ name, x: r.x, y: r.y, w: r.w, h: r.h })
	}
	add("tuner", layout.tuner)
	add("receiver", layout.receiver)
	add("listen", layout.listen)
	add("dock", layout.dock)
	add("find", layout.find)
	add("player", layout.player)
	add("card", layout.card)
	for (const i of layout.status.items) add(`status:${i.id}`, i)
	add("drawer", layout.drawer)
	add("pane", layout.pane)
	add("grip", layout.grip)
	return out
}

const PART_OF_DRAWER = new Set(["drawer", "pane", "grip"])

/** The clear distance two named rectangles must keep (I1). */
export function neededGap(a: string, b: string): number {
	if (PART_OF_DRAWER.has(a) && PART_OF_DRAWER.has(b)) return -Infinity
	// the grip straddles the drawer's edge (10 px out): it keeps clear of the rest, the drawer keeps the gutter
	if (a === "grip" || b === "grip") return 0
	const pair = [a, b].sort().join("|")
	if (
		pair === "receiver|tuner" ||
		pair === "find|listen" ||
		(a.startsWith("status:") && b.startsWith("status:")) ||
		(a.startsWith("status:") && (b === "tuner" || b === "receiver")) ||
		(b.startsWith("status:") && (a === "tuner" || a === "receiver"))
	)
		return RAIL_NEIGHBOUR_GAP
	return G
}

/** Every pair of rectangles that breaks I1, and every rectangle outside the window's 16 px margin (I2): empty
 * when the layout is sound. Used by the tests and by ui-check. */
export function layoutViolations(
	rects: readonly Named[],
	viewport: Size,
): Violation[] {
	const out: Violation[] = []
	const win = rect(0, 0, viewport.w, viewport.h)
	for (const r of rects) {
		// the grip straddles the drawer's left edge, inside the window
		if (!insideOf(r, win, r.name === "grip" ? 0 : G))
			out.push({ kind: "outside", a: r.name })
	}
	for (let i = 0; i < rects.length; i++) {
		for (let j = i + 1; j < rects.length; j++) {
			const a = rects[i] as Named
			const b = rects[j] as Named
			const need = neededGap(a.name, b.name)
			if (need === -Infinity) continue
			const gap = separation(a, b)
			if (gap < 0)
				out.push({ kind: "intersect", a: a.name, b: b.name, gap, need })
			else if (gap < need - 0.5)
				out.push({ kind: "gap", a: a.name, b: b.name, gap, need })
		}
	}
	return out
}
