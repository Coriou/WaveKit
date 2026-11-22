// One layout for everything that floats in the shell (docs/web/DESIGN.md, "Layout: rails and stage"). Two rails hold
// the persistent chrome and never change when a drawer opens: the top rail has the Tuner, a status slot and the
// Receiver; the bottom rail has Listen and the dock, with one storey above Listen for the player and the tuned card's
// home above that. Everything between the rails is the stage: drawers, the pane, expanded Activity and the phone
// sheet take stage room only, and the plot gets every chrome rectangle over it as an exclusion zone. Pure and DOM
// free: components report their intrinsic sizes, the shell calls computeLayout and each slot applies its rectangle.
import {
	plotLayout,
	DISCOVERY_ROW_CSS,
	GAP_CSS,
	RULER_CSS,
	TRACE_FLOOR_CSS,
} from "../../plot/layout.ts"
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
import { clampDrag, dragLegal, type CardFrame } from "../card-place.ts"
import type { DrawerId, IslandId } from "../store.ts"
import {
	bottom,
	insideOf,
	intersects,
	rect,
	right,
	separation,
	union,
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
/** An island's panel stands this far from its island and from the rail across the stage. */
export const PANEL_GAP = 8
/** Neighbours in one rail row that the boards draw 8 px apart: the stacked Receiver under the Tuner, the phone's
 * search button beside Listen, and the status strip under the top rail. */
export const RAIL_NEIGHBOUR_GAP = 8
/** Listen's width while its panel (Audio options) is open: the board's 420. The one source for it: the shell sets
 * the Listen island's `--wk-listen-open-w` from the layout's `listenOpen`, and the dock reserves it (LY rules §2.2). */
export const LISTEN_OPEN_W = 420
/** Fallback sizes before anything is measured (the boards' figures). */
export const DEFAULT_SIZES = {
	tuner: { w: 440, h: 56 },
	receiver: { w: 300, h: 56 },
	listen: { w: 340, h: 64 },
	dock: { wide: { w: 492, h: 64 }, compact: { w: 448, h: 64 } },
	find: { w: 48, h: 48 },
	cardExpanded: { w: CARD_W, h: 300 },
	cardLine: { w: CARD_W, h: 52 },
	/** The player's full transport and its compact line (playback.css `.wkp-dock`, `[data-compact]`). */
	player: { w: PLAYER_STOREY_W, h: 70 },
	playerCompact: { w: PLAYER_STOREY_W, h: 38 },
} as const

/** The map's layer rail: 156 px with names from 1100 px, 48 px of icons below (map.css `.wkm-rail`). */
export const MAP_RAIL_W = { wide: 156, narrow: 48 } as const
export const MAP_RAIL_WIDE_MIN = FULL_MIN_VW
/** Room between the map's rail and the panel beside it (the board's 10 px). */
export const MAP_SIDE_GAP = 10
/** The map's side panel (selection, overlays) is at most this wide (map.css `.wkm-sel`). */
export const MAP_SIDE_MAX_W = 320
/** Room between the parts of the map's corner (the scale, the Live chip, the attribution line). */
export const MAP_CORNER_GAP = 8
/** The scale rows the plot needs in full (axis, lanes, discovery row, ruler) and lean (axis and lanes). */
export const ROWS_FULL_CSS = GAP_CSS + DISCOVERY_ROW_CSS + RULER_CSS
export const ROWS_LEAN_CSS = GAP_CSS

export type StatusKind =
	| "condition"
	| "connection"
	| "back-to-live"
	| "paused"
	| "note"
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
	/** Listen's closed head (measured only while its panel is closed: opening it never moves the stack). */
	readonly listen: Size
	/** Listen's width while its panel is open (default LISTEN_OPEN_W): the dock reserves it. */
	readonly listenOpenW?: number
	readonly dock: { readonly wide: Size; readonly compact: Size }
	readonly find?: Size
	/** The player's measured size in the form it chose itself, or null while nothing is in it. */
	readonly player: Size | null
	/** The player's compact line, when the layout may collapse a full player to it (insufficient height). */
	readonly playerCompact?: Size
	readonly card: {
		readonly expanded: Size
		readonly line: Size
		readonly minimised: boolean
		readonly anchor: CardAnchorId | string
	} | null
	readonly status: readonly StatusItem[]
	readonly drawer: DrawerInput | null
	/** Open island panels (popovers), measured: exclusion zones for the plot, obstacles the card and player yield to. */
	readonly panels: readonly { readonly island: IslandId; readonly size: Size }[]
	/** The island whose panel is open now, measured or not (a panel opened this frame has no size yet). */
	readonly openPanel?: IslandId | null
	/** The map's chrome, measured, while the Map view shows (null or absent: the spectrum view). */
	readonly map?: MapInput | null
	/** Motion in progress (the shell's, between two settled layouts). */
	readonly motion?: MotionInput
}

/** The map view's chrome sizes (MapScreen reports them; the layout places them). */
export interface MapInput {
	/** The layer rail's natural height (its width is MAP_RAIL_W by the window). */
	readonly railH: number
	/** The side panel shown beside the rail (the selection or the overlays menu), or null. */
	readonly side: Size | null
	/** The station chip asking for a location, or null. */
	readonly station: Size | null
	readonly live: Size
	readonly scale: Size
	readonly footer: Size
}

export interface MotionInput {
	/** The card's rectangle before it glides to its new home (cleared when the glide ends). */
	readonly cardFrom?: Rect | null
	/** The card's top-left while the reader drags it. */
	readonly cardDrag?: { readonly x: number; readonly y: number } | null
}

export interface MapPlaced {
	/** The rail's width form. */
	readonly wide: boolean
	/** The layer rail under the Receiver, or null while a drawer covers it. */
	readonly rail: Rect | null
	/** The side panel left of the rail, or null (nothing shown, or covered). */
	readonly side: Rect | null
	/** How tall the side panel and the rail may grow (shell px, from their top). */
	readonly sideMaxH: number
	readonly station: Rect | null
	/** The corner: the Live chip, the scale left of it, the attribution line above (null while covered). */
	readonly live: Rect | null
	readonly scale: Rect | null
	readonly footer: Rect | null
	/** The corner stands on the bottom rail (else above the stack, in the stage). */
	readonly cornerOnRail: boolean
	/** Map chrome a drawer, pane or sheet covers now (hidden, never moved). */
	readonly covered: readonly ("rail" | "side" | "station" | "corner")[]
}

/** What may yield to an open panel: a frame island, the tuned card, the player, a status item ("status:<id>"). */
export type YieldedId = IslandId | "card" | "player" | `status:${string}`

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

export interface PlayerPlaced extends Rect {
	readonly form: "full" | "compact"
}

export interface Layout {
	readonly viewport: Size
	readonly tuner: Rect
	readonly receiver: Rect
	/** The Receiver sits under the Tuner (the top row cannot hold both). */
	readonly stacked: boolean
	/** Listen's closed head: the frame's rectangle. */
	readonly listen: Rect
	/** The head's rectangle while its panel is open (as wide as the layout reserves for it, the dock clear of it). */
	readonly listenOpen: Rect
	/** The island whose panel is open now (measured or not). */
	readonly openPanel: IslandId | null
	readonly dock: (Rect & { readonly compact: boolean }) | null
	readonly find: Rect | null
	readonly player: PlayerPlaced | null
	/** The player has something in it but no room now (insufficient height: it keeps playing, hidden). */
	readonly playerWaiting: boolean
	readonly card: CardPlaced | null
	/** Where the card stands this frame: its home, or under the pointer while dragged (null while hidden). */
	readonly cardNow: Rect | null
	/** Slots held out of sight while the card glides through their rectangle (they appear when it lands). */
	readonly held: readonly string[]
	/** The tallest each island's panel may grow (its top below the top rail, its foot above the bottom rail). */
	readonly panelMaxH: Readonly<Record<IslandId, number>>
	/** How far a panel going down stands past its island's 8 px (under a taller neighbour on the top rail). */
	readonly panelDrop: Readonly<Record<IslandId, number>>
	/** Open panels where they stand (their height capped to panelMaxH): frame islands never cover them. */
	readonly panels: readonly { readonly island: IslandId; readonly rect: Rect }[]
	/** The room the open panel takes: its measured rectangle, or before it is measured all it may grow to (its
	 * island's column at panelMaxH). Slots within PANEL_GAP of it yield. Empty while no panel is open. */
	readonly panelRooms: readonly Rect[]
	/** Islands out of sight while an open panel takes their place: the stacked Receiver under the Tuner's, and the
	 * card or the player under Listen's (or any panel within 8 px of them). */
	readonly yielded: readonly YieldedId[]
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
		/** The docked items' host (the drawer and its notice slot): yielded while an open panel's room covers it. */
		readonly dockHost: "shown" | "yielded"
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
		/** Which scale rows the plot draws: all; lean (no discovery row, no ruler); none (the waterfall only). */
		readonly rows: "full" | "lean" | "none"
		readonly visible: Rect
		/** Centre of the plot's status notes (shell px). */
		readonly noteCx: number
		/** Chrome over the plot body, in plot-body coordinates. */
		readonly exclusions: readonly Rect[]
	}
	/** The map view's chrome, or null in the spectrum view. */
	readonly map: MapPlaced | null
}

const clamp = (v: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(hi, v))

/** State-group rank from the Receiver outward. */
const STATE_ORDER: readonly StatusKind[] = [
	"condition",
	"connection",
	"back-to-live",
	"paused",
	"note",
]

interface StatusPick {
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
	const one = (item: StatusItem): StatusPick => ({
		item,
		form: "full",
		lines: 1,
		size: item.forms.full,
	})
	const width = (ps: readonly StatusPick[]) =>
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
			const p = (r ?? s[0]) as StatusPick
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

function place(
	r: StatusPick | null,
	s: readonly StatusPick[],
	slot: Rect,
): StatusPlaced[] {
	// an item taller than the row is clamped to it (centred, never above the window's margin)
	const at = (p: StatusPick, x: number): StatusPlaced => {
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

/** The status items in the strip under the top rail (R3 fallback), or docked in a covering surface's notice slot. */
function stripLayout(
	items: readonly StatusItem[],
	x: number,
	y: number,
	w: number,
	maxBottom: number,
	cover: Rect | null,
	hasNoticeSlot: boolean,
): {
	where: "strip" | "drawer-slot"
	items: StatusPlaced[]
	waiting: string[]
	docked: string[]
	strip: Rect | null
} {
	const r = fitStrip(items, x, y, w, maxBottom)
	const box =
		r.placed.length > 0
			? rect(x, y, w, Math.max(...r.placed.map(bottom)) - y)
			: null
	// a covering surface under the strip (a covering drawer, or an attached pane beside a column): the items dock in
	// the drawer's notice slot
	if (box && cover && intersects(box, cover)) {
		if (hasNoticeSlot)
			return {
				where: "drawer-slot",
				items: [],
				waiting: [],
				docked: items.map(i => i.id),
				strip: null,
			}
		return {
			where: "strip",
			items: [],
			waiting: items.map(i => i.id),
			docked: [],
			strip: null,
		}
	}
	return {
		where: "strip",
		items: r.placed,
		waiting: r.waiting,
		docked: [],
		strip: box,
	}
}

/** The width the map's layer rail takes at window width `W`. */
export const mapRailW = (W: number): number =>
	W >= MAP_RAIL_WIDE_MIN ? MAP_RAIL_W.wide : MAP_RAIL_W.narrow

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
	// Listen widens while its panel is open: the dock reserves that width, so nothing moves when it opens and the open
	// head never covers the dock (LY rules §2.2). With the dock shown, reserveW = clamp(listenOpenW, listen.w,
	// W − 3G − dockW): the dock's hide bound above uses the closed width, so G + listen.w + G + dockW + G ≤ W and the
	// range is never empty (at 836 px: 836 − 48 − 448 = 340, the closed width; from 916 px the board's 420). On a
	// phone, reserveW = clamp(listenOpenW, listen.w, W − 2G − find.w − NG): the search button stays 8 px away.
	const listenOpenW = input.listenOpenW ?? LISTEN_OPEN_W
	const reserveW = dockHidden
		? clamp(
				listenOpenW,
				listenW,
				Math.max(listenW, W - 2 * G - (find ? find.w + RAIL_NEIGHBOUR_GAP : 0)),
			)
		: clamp(listenOpenW, listenW, W - 3 * G - dockSize.w)
	const listenOpen = rect(G, listen.y, reserveW, listen.h)
	let dock: (Rect & { compact: boolean }) | null = null
	if (!dockHidden) {
		const d = dockSize
		// dock.x = clamp(round((W − dockW) / 2), G + reserveW + G, W − G − dockW): centred when that clears the open
		// head by a gutter (the wide dock from 1395 px, round(903 / 2) = 452), else at the bound (452 from 916 px);
		// the compact dock (below 1180 px) would need 1352 px to centre, so it never does
		const lo = right(listenOpen) + G
		const x = Math.max(lo, Math.min(Math.round((W - d.w) / 2), W - G - d.w))
		dock = { ...rect(x, H - G - d.h, d.w, d.h), compact }
	}
	const railTop = Math.min(listen.y, dock?.y ?? Infinity, find?.y ?? Infinity)
	const insetTop = topRail + PLOT_INSET_GAP

	// ---- stack (R4): the bottom rail, the player storey, the card home; the storey stands on the rail's top (the
	// taller of Listen and the dock), so it keeps a gutter from both. Insufficient height collapses in a stated order
	// (DESIGN.md, "Insufficient height"): the player to its compact line, the trace floor, the discovery row and the
	// ruler, the player (waiting, still playing), then every scale row; nothing overlaps.
	const stackTopOf = (p: Size | null) => (p ? railTop - G - p.h : railTop)
	const rowsRoom = (p: Size | null) => stackTopOf(p) - G - insetTop
	const rowsFor = (p: Size | null): "full" | "lean" | "none" =>
		rowsRoom(p) >= ROWS_FULL_CSS
			? "full"
			: rowsRoom(p) >= ROWS_LEAN_CSS
				? "lean"
				: "none"
	let pSize = input.player
	let collapsed = false
	const pc = input.playerCompact
	if (
		pSize &&
		pc &&
		pc.h < pSize.h &&
		rowsRoom(pSize) < ROWS_FULL_CSS + TRACE_FLOOR_CSS
	) {
		pSize = pc
		collapsed = true
	}
	let playerWaiting = false
	if (pSize && rowsFor(pSize) === "none") {
		pSize = null
		collapsed = false
		playerWaiting = true
	}
	const rows = rowsFor(pSize)
	const storeyW = Math.min(PLAYER_STOREY_W, W - 2 * G)
	const player: PlayerPlaced | null = pSize
		? {
				...rect(G, railTop - G - pSize.h, Math.min(pSize.w, storeyW), pSize.h),
				form: collapsed ? "compact" : "full",
			}
		: null
	const stackTop = player ? player.y : railTop
	const coverTop = topRail + G
	const coverFoot = stackTop - G

	// ---- the map's corner (map view): on the bottom rail right of the dock when the rail has room for the Live
	// chip and the scale, the attribution line above them; else it stands above the stack
	const mi = input.map ?? null
	let corner: {
		live: Rect
		scale: Rect
		footer: Rect
		onRail: boolean
	} | null = null
	if (mi) {
		const roomX0 =
			Math.max(
				right(listenOpen),
				dock ? right(dock) : 0,
				find ? right(find) : 0,
			) + G
		const rowW = mi.scale.w + MAP_CORNER_GAP + mi.live.w
		const onRail = W - G - roomX0 >= rowW
		const base = onRail ? H - G : stackTop - G
		const live = rect(W - G - mi.live.w, base - mi.live.h, mi.live.w, mi.live.h)
		const scale = rect(
			live.x - MAP_CORNER_GAP - mi.scale.w,
			base - mi.scale.h,
			mi.scale.w,
			mi.scale.h,
		)
		const fw = Math.max(0, Math.min(mi.footer.w, W - G - (onRail ? roomX0 : G)))
		const footer = rect(
			W - G - fw,
			Math.min(live.y, scale.y) - MAP_CORNER_GAP - mi.footer.h,
			fw,
			mi.footer.h,
		)
		corner = { live, scale, footer, onRail }
	}
	// the top of the map's corner where it stands on the rail under x..x+w (a surface's foot keeps a gutter above it)
	const cornerTopUnder = (x: number, w: number) =>
		corner?.onRail === true &&
		W - G + G > x &&
		Math.min(corner.footer.x, corner.scale.x, corner.live.x) - G < x + w
			? Math.min(corner.footer.y, corner.scale.y, corner.live.y)
			: Infinity
	const coverFootAt = (x: number, w: number) =>
		Math.min(coverFoot, cornerTopUnder(x, w) - G)

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
			// the map's corner on the rail under the column: the column stands a gutter above its attribution line
			const cornerUnder = cornerTopUnder(x, w)
			const edge =
				!paneOn &&
				cornerUnder === Infinity &&
				(dock === null || x >= right(dock) + G)
			const foot = edge ? H - G : Math.min(railTop, cornerUnder) - G
			drawer = {
				...rect(x, top, w, foot - top),
				shape: "column",
				foot: edge ? "edge" : "rail",
				resizable: !pushed,
				maxW: Math.max(DR_MIN, maxW),
				pushed,
			}
			// a covering surface: under the Tuner's hold row too, down to the stack
			if (paneOn)
				pane = rect(G, coverTop, paneRoom, coverFootAt(G, paneRoom) - coverTop)
			if (!pushed) grip = rect(x - 10, top + 16, 20, drawer.h - 32)
		} else {
			const shape: DrawerShape =
				W < FULL_MIN_VW ? (dockHidden ? "sheet" : "between-rails") : "expanded"
			const pushed = di.pane?.want === true && di.pane.pushIn && !di.expanded
			drawer = {
				...rect(G, coverTop, W - 2 * G, coverFootAt(G, W - 2 * G) - coverTop),
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
	const rowsBottomMax = stackTop - G
	const rowsMaxCss = rows === "none" ? 0 : rowsBottomMax - insetTop
	// the worst case for what sits on the trace: the discovery row shown (a shorter trace)
	const trace =
		rows === "none"
			? 0
			: plotLayout(
					H - insetTop,
					rows === "full" ? DISCOVERY_ROW_CSS + RULER_CSS : 0,
					rowsMaxCss,
				).traceCss

	// ---- status (R3): the rail's slot; the strip when the slot is too narrow, or when the strip shows more of the
	// items than the slot can (an item degrades to the strip before it waits)
	const slotX = right(tuner) + G
	const slotW = receiver.x - G - slotX
	const rail = !stacked && slotW >= STATUS_MIN_W
	const slot = rail ? rect(slotX, G, slotW, STATUS_ROW_H) : null
	type Placed = ReturnType<typeof stripLayout>
	const placeStatus = (
		columnX: number | null,
		cover: Rect | null,
		noticeSlot: boolean,
	): Placed => {
		const inStrip = () =>
			stripLayout(
				input.status,
				G,
				topRail + RAIL_NEIGHBOUR_GAP,
				// left of a drawer column (a narrow slot on a wide window), else the window's width
				(columnX !== null ? columnX - G : W - G) - G,
				Math.min(coverFoot, insetTop + trace),
				cover,
				noticeSlot,
			)
		if (slot) {
			const r = fitRail(input.status, slot)
			const inRail: Placed = {
				where: "strip",
				items: r.placed,
				waiting: r.waiting,
				docked: [],
				strip: null,
			}
			if (r.waiting.length > 0) {
				const s = inStrip()
				if (s.waiting.length < r.waiting.length) return s
			}
			return inRail
		}
		if (input.status.length > 0) return inStrip()
		return { where: "strip", items: [], waiting: [], docked: [], strip: null }
	}
	const st = placeStatus(
		drawer?.shape === "column" ? drawer.x : null,
		covering ? drawer : pane,
		di?.hasNoticeSlot === true,
	)
	const items = st.items
	const waiting = st.waiting
	const docked = st.docked
	const strip = st.strip
	const where: Layout["status"]["where"] =
		st.where === "drawer-slot"
			? "drawer-slot"
			: strip !== null || !rail
				? "strip"
				: "rail"

	// ---- the map's chrome (map view): the layer rail under the Receiver (under the strip while it shows), the
	// side panel and the station chip left of it; stage chrome a drawer covers (hidden, never moved)
	let map: MapPlaced | null = null
	if (mi && corner) {
		const covers = [...(drawer ? [drawer] : []), ...(pane ? [pane] : [])]
		// Keep a gutter from surfaces and strip items. The grip straddles the column edge and needs only clearance.
		const isCovered = (r: Rect) =>
			covers.some(c => separation(r, c) < G) ||
			(grip !== null && intersects(r, grip)) ||
			(strip !== null && items.some(i => separation(i, r) < G))
		const wide = W >= MAP_RAIL_WIDE_MIN
		const railW = mapRailW(W)
		// the stage's top under the status strip as it stands with no drawer (a drawer never moves the map's chrome)
		const bare = drawer ? placeStatus(null, null, false).strip : strip
		const top = bare ? bottom(bare) + G : coverTop
		const railX = W - G - railW
		// the stage's floor for a column at x..x+w: the corner's top on the right, the stack where it lies under it
		const floor = (x: Rect["x"], w: number) =>
			Math.min(
				corner.footer.y,
				player && x < right(player) + G && player.x < x + w + G
					? player.y
					: Infinity,
				x < right(listen) + G && listen.x < x + w + G ? listen.y : Infinity,
				find && x < right(find) + G && find.x < x + w + G ? find.y : Infinity,
				dock && x < right(dock) + G && dock.x < x + w + G ? dock.y : Infinity,
			) - G
		const railR = rect(
			railX,
			top,
			railW,
			Math.max(0, Math.min(mi.railH, floor(railX, railW) - top)),
		)
		let sideR: Rect | null = null
		let sideMaxH = Math.max(0, floor(railX, railW) - top)
		if (mi.side) {
			const w = Math.max(
				0,
				Math.min(mi.side.w, MAP_SIDE_MAX_W, railX - MAP_SIDE_GAP - G),
			)
			const x = railX - MAP_SIDE_GAP - w
			sideMaxH = Math.max(0, floor(x, w) - top)
			sideR = rect(x, top, w, Math.min(mi.side.h, sideMaxH))
		}
		let stationR: Rect | null = null
		if (mi.station) {
			const x1 = sideR ? sideR.x - G : railX - MAP_SIDE_GAP
			const w = Math.max(0, Math.min(mi.station.w, x1 - G))
			const x = Math.round((G + x1 - w) / 2)
			// no room above the corner and the stack: it waits (the footer names the station too)
			if (top + mi.station.h <= floor(x, w))
				stationR = rect(x, top, w, mi.station.h)
		}
		const covered: MapPlaced["covered"][number][] = []
		const keep = (name: "rail" | "side" | "station", r: Rect | null) => {
			if (r && (r.w <= 0 || r.h <= 0)) return null
			if (r && isCovered(r)) {
				covered.push(name)
				return null
			}
			return r
		}
		// a corner above the stack with no room under the top rail (a short window) waits like a covered one
		const cornerCovered = [corner.live, corner.scale, corner.footer].some(
			r => isCovered(r) || r.y < top,
		)
		if (cornerCovered) covered.push("corner")
		map = {
			wide,
			rail: keep("rail", railR),
			side: keep("side", sideR),
			sideMaxH,
			station: keep("station", stationR),
			live: cornerCovered ? null : corner.live,
			scale: cornerCovered ? null : corner.scale,
			footer: cornerCovered ? null : corner.footer,
			cornerOnRail: corner.onRail,
			covered,
		}
	}
	const mapRects: Rect[] = map
		? [map.rail, map.side, map.station, map.live, map.scale, map.footer].filter(
				(r): r is Rect => r !== null && r.w > 0 && r.h > 0,
			)
		: []

	// ---- island panels (popovers): a panel going down starts 8 px under the whole top rail (under a taller Tuner's
	// hold row too: `panelDrop` past its own island's 8 px) and keeps 8 px above the bottom rail; Listen's going up
	// starts 8 px under the top rail; so no frame island ever covers an open panel. On a stacked rail the Tuner's
	// panel opens under the Tuner and the Receiver yields while it is open over it
	const panelTop: Record<"tuner" | "receiver", number> = {
		tuner: stacked ? bottom(tuner) + PANEL_GAP : topRail + PANEL_GAP,
		receiver: topRail + PANEL_GAP,
	}
	const panelDrop: Record<IslandId, number> = {
		tuner: panelTop.tuner - (bottom(tuner) + PANEL_GAP),
		receiver: panelTop.receiver - (bottom(receiver) + PANEL_GAP),
		listen: 0,
	}
	const panelMaxH: Record<IslandId, number> = {
		tuner: Math.max(0, railTop - PANEL_GAP - panelTop.tuner),
		receiver: Math.max(0, railTop - PANEL_GAP - panelTop.receiver),
		// its foot on the bottom rail's top (a dock taller than Listen beside it)
		listen: Math.max(0, railTop - PANEL_GAP - (topRail + PANEL_GAP)),
	}
	const panels = input.panels.map(p => {
		const h = Math.min(p.size.h, panelMaxH[p.island])
		const r =
			p.island === "tuner"
				? rect(tuner.x, panelTop.tuner, p.size.w, h)
				: p.island === "receiver"
					? rect(right(receiver) - p.size.w, panelTop.receiver, p.size.w, h)
					: rect(listen.x, railTop - PANEL_GAP - h, p.size.w, h)
		return { island: p.island, rect: r }
	})
	const yielded: YieldedId[] = panels.some(
		p => p.island === "tuner" && stacked && intersects(p.rect, receiver),
	)
		? ["receiver"]
		: []

	// ---- the tuned card (R4, R5)
	let card: Layout["card"] = null
	let anchors: CardAnchor[] = []
	const freeW = drawer?.shape === "column" ? drawer.x : W
	const ci = input.card
	const islands: Rect[] = [tuner, receiver, listen]
	if (slot) islands.push(slot)
	if (strip) islands.push(strip)
	if (dock) islands.push(dock)
	if (find) islands.push(find)
	if (player) islands.push(player)
	if (drawer) islands.push(drawer)
	islands.push(...mapRects)
	if (
		ci &&
		W > CARD_MAX_HIDDEN_VW &&
		!covering &&
		pane === null &&
		!(drawer?.pushed ?? false)
	) {
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

	// ---- an open panel over the card or the player (Listen's going up over the card's home and the player storey):
	// they yield, out of sight in place (still mounted and measured), and are back where they were when it closes;
	// so no island stands over an open panel and nothing moves for a popover
	// a panel opened this frame and not measured yet takes, for this, all the room it may grow to (its island's
	// column, as tall as panelMaxH): the card is out of sight from the panel's first frame, never drawn over it
	const pending = input.openPanel ?? null
	// the open panel's room (one panel at a time; a measured panel no longer open is stale and takes no room)
	const panelRoom: Rect[] = panels
		.filter(p => pending === null || p.island === pending)
		.map(p => p.rect)
	if (pending && !panels.some(p => p.island === pending)) {
		const h = panelMaxH[pending]
		panelRoom.push(
			pending === "tuner"
				? rect(tuner.x, panelTop.tuner, Math.max(tuner.w, CARD_W), h)
				: pending === "receiver"
					? rect(
							right(receiver) - Math.max(receiver.w, CARD_W),
							panelTop.receiver,
							Math.max(receiver.w, CARD_W),
							h,
						)
					: rect(
							listen.x,
							railTop - PANEL_GAP - h,
							Math.max(listenOpen.w, CARD_W),
							h,
						),
		)
	}
	// ---- motion (DESIGN.md, "Motion"): a dragged card stands where the pointer holds it, clamped here against this
	// very layout's frame (LY rules §4.1): every island, the open Listen head at its open width and every open or
	// pending panel room. So a layout change under a still pointer (Listen opening, a drawer, the player) revalidates
	// the drag, and the held card jumps clear under the pointer (taste call 6) rather than standing under the change.
	// A card gliding to a new home sweeps the box of its two homes, and a slot entering that box is held out of sight
	// until the card lands
	const mo = input.motion
	const dragFrame: Rect[] = [
		...islands,
		...(input.openPanel === "listen" ? [listenOpen] : []),
		...panelRoom,
	]
	const want = mo?.cardDrag ?? null
	const heldFrame: CardFrame | null =
		card && want
			? {
					anchors,
					card: { x: card.x, y: card.y },
					freeW,
					H,
					cardH: card.h,
					obstacles: dragFrame,
				}
			: null
	const dragAt = heldFrame && want ? clampDrag(want, heldFrame, null) : null
	// no legal spot left in this frame: the clamp's fallback (the window-clamped wanted spot) would stand the held card
	// over an island or an open room, so it yields there instead (out of sight in place, back under the pointer as
	// soon as a spot frees)
	const dragStuck =
		heldFrame !== null && dragAt !== null && !dragLegal(dragAt, heldFrame)
	const cardNow: Rect | null =
		card && dragAt ? rect(dragAt.x, dragAt.y, CARD_W, card.h) : card
	const path =
		card && !mo?.cardDrag && mo?.cardFrom ? union(mo.cardFrom, card) : null
	const held: string[] = []
	if (path) {
		const entering: [string, Rect | null][] = [
			["player", player],
			["drawer", drawer],
			["pane", pane],
			["grip", grip],
			...items.map((i): [string, Rect] => [`status:${i.id}`, i]),
			...(map
				? ([
						["map:side", map.side],
						["map:station", map.station],
					] as [string, Rect | null][])
				: []),
		]
		for (const [name, r] of entering)
			if (r && intersects(r, path)) held.push(name)
	}
	const cardSwept = path ?? cardNow

	// the card (held or not) whose spot is within PANEL_GAP of the open room yields, and so does a held card with no
	// legal spot left in its frame (dragStuck); the player and the status items under the open room yield too
	const underPanel = (r: Rect | null) =>
		r !== null && panelRoom.some(p => separation(p, r) < PANEL_GAP)
	if (dragStuck || underPanel(cardNow)) yielded.push("card")
	if (underPanel(player)) yielded.push("player")
	// a status item within PANEL_GAP of the open panel's room yields in place (LY rules §2.3): out of sight, inert, its
	// timer paused; it is back where it was, with its remaining time, when the panel closes. A positive-area item only:
	// the rail's items never yield (their foot is at most 72, the panel's top at least topRail + 8 = 80)
	for (const i of items)
		if (i.w > 0 && i.h > 0 && underPanel(i)) yielded.push(`status:${i.id}`)
	// the docked items' host (the drawer holding the notice slot) under the open panel's room: they yield with it
	const dockHost: Layout["status"]["dockHost"] =
		docked.length > 0 && drawer !== null && underPanel(drawer)
			? "yielded"
			: "shown"

	// ---- plot contract (R6)
	const body = rect(0, insetTop, W, H - insetTop)
	const panelRects = panels.map(p => p.rect)
	const chrome: Rect[] = [
		tuner,
		receiver,
		listen,
		...(dock ? [dock] : []),
		...(find ? [find] : []),
		...(player ? [player] : []),
		...(cardSwept ? [cardSwept] : []),
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
		listenOpen,
		openPanel: pending,
		dock,
		find,
		player,
		playerWaiting,
		card,
		cardNow,
		held,
		panelMaxH,
		panelDrop,
		panels,
		panelRooms: panelRoom,
		yielded,
		cardAnchors: anchors,
		cardFreeW: freeW,
		status: { where, slot, strip, items, docked, waiting, dockHost },
		drawer,
		pane,
		grip,
		plot: {
			insetTop,
			rowsBottomMax,
			rowsMaxCss,
			rows,
			visible,
			noteCx: Math.round(visibleW / 2),
			exclusions,
		},
		map,
	}
}

/** One status item's visibility (LY rules §1.2): the single predicate the notice region reads for its render, its
 * `inert`, the focus hand-off and the item's timer. Precedence: absent > waiting > yielded > held > docked > shown.
 * A docked item is `docked` (seen) only while its portal target exists (`dockTarget`) and its host is shown: with no
 * target it waits, under an open panel it yields with its host. */
export type StatusState =
	| "shown"
	| "docked"
	| "held"
	| "yielded"
	| "waiting"
	| "absent"

export function statusState(
	layout: Pick<Layout, "status" | "yielded" | "held">,
	id: string,
	dockTarget: boolean,
): StatusState {
	const st = layout.status
	if (st.docked.includes(id)) {
		if (!dockTarget) return "waiting"
		return st.dockHost === "yielded" ? "yielded" : "docked"
	}
	if (st.waiting.includes(id)) return "waiting"
	if (!st.items.some(i => i.id === id)) return "absent"
	if (layout.yielded.includes(`status:${id}`)) return "yielded"
	if (layout.held.includes(`status:${id}`)) return "held"
	return "shown"
}

/** The reader can see the item (and reach its controls): its timer runs only then. */
export const statusSeen = (s: StatusState): boolean =>
	s === "shown" || s === "docked"

/** The status slots ("status:<id>") the reader cannot see now: every placed, docked or waiting item whose state is
 * not seen (yielded in place, docked in a yielded host, held, waiting). The shell hands the focus out of them. */
export function unseenStatusSlots(
	layout: Pick<Layout, "status" | "yielded" | "held">,
): string[] {
	const st = layout.status
	const ids = new Set([...st.items.map(i => i.id), ...st.docked, ...st.waiting])
	return [...ids]
		.filter(id => !statusSeen(statusState(layout, id, true)))
		.map(id => `status:${id}`)
}

/** The islands the dragged card keeps clear of (every placed rectangle but the card's own). */
export function cardObstacles(layout: Layout): Rect[] {
	const out: Rect[] = namedRects(layout)
		.filter(r => r.name !== "card" && r.name !== "grip")
		.map(r => rect(r.x, r.y, r.w, r.h))
	if (layout.status.slot) out.push(layout.status.slot)
	if (layout.status.strip) out.push(layout.status.strip)
	// a player yielded to an open panel comes back where it was: the card keeps off its storey all the same
	const p = layout.player
	if (p && layout.yielded.includes("player")) out.push(rect(p.x, p.y, p.w, p.h))
	return out
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
			a.rows === b.rows &&
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
	// the head as wide as it stands: its open width while its panel is open
	add(
		"listen",
		layout.openPanel === "listen" ? layout.listenOpen : layout.listen,
	)
	add("dock", layout.dock)
	add("find", layout.find)
	// a yielded card, player or status item is out of sight (under an open panel): not on screen, so not in the checks
	const shown = (id: YieldedId) => !layout.yielded.includes(id)
	if (shown("player")) add("player", layout.player)
	if (shown("card")) add("card", layout.cardNow ?? layout.card)
	for (const i of layout.status.items)
		if (shown(`status:${i.id}`)) add(`status:${i.id}`, i)
	add("drawer", layout.drawer)
	add("pane", layout.pane)
	add("grip", layout.grip)
	const m = layout.map
	if (m) {
		add("map:rail", m.rail)
		add("map:side", m.side)
		add("map:station", m.station)
		add("map:live", m.live)
		add("map:scale", m.scale)
		add("map:footer", m.footer)
	}
	return out.filter(r => r.w > 0 && r.h > 0)
}

const PART_OF_DRAWER = new Set(["drawer", "pane", "grip"])

/** The clear distance two named rectangles must keep (I1). */
export function neededGap(a: string, b: string): number {
	if (PART_OF_DRAWER.has(a) && PART_OF_DRAWER.has(b)) return -Infinity
	// the grip straddles the drawer's edge (10 px out): it keeps clear of the rest, the drawer keeps the gutter
	if (a === "grip" || b === "grip") return 0
	const pair = [a, b].sort().join("|")
	// the map's own parts sit as neighbours (the rail and its side panel 10 px apart, the corner's parts 8)
	if (a.startsWith("map:") && b.startsWith("map:")) return RAIL_NEIGHBOUR_GAP
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
