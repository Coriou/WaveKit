// The Immersive shell grid (docs/web/canvas/Immersive.dc.html, shellLayout): one 16 px gutter; top row Tuner and
// Receiver, bottom row Listen and the dock; the tuned card sits on one of eight anchors of the free plot area (above
// Listen by default). The plot is always full-bleed. Pure, so it tests in node; the shell feeds it measured island sizes.
import type { DrawerId } from "./store.ts"

export const G = 16
export const DOCK_H = 64
export const CARD_W = 320
/** From this width a drawer floats over the plot's right side at full height. */
export const FULL_MIN_VW = 1100
/** Dock width with the active label showing, and without it, for the collision checks. */
export const DOCK_WIDE = 460
export const DOCK_COMPACT = 380
export const DR_MIN = 360
export const DR_MAX = 640
/** Below this width the dock is hidden (board media rule). */
export const DOCK_MIN_VW = 761
export const DRAWER_W: Readonly<Record<DrawerId, number>> = {
	activity: 420,
	scanner: 420,
	recordings: 420,
	settings: 560,
}

export interface Size {
	readonly w: number
	readonly h: number
}

export interface ShellGeometry {
	readonly W: number
	readonly H: number
	/** Collapsed island sizes (the grid uses these). */
	readonly tuner: Size
	readonly rx: Size
	readonly listen: Size
	/** Listen's live height, open panel included (the card rides above it). */
	readonly listenLiveH: number
	/** Live island sizes, open panel included: the card keeps one gutter away from these. Listen's live width is
	 * listenLiveW (its height is listenLiveH). */
	readonly tunerLive: Size
	readonly rxLive: Size
	readonly listenLiveW: number
	readonly dockW: number
	readonly cardH: number
}

export const DEFAULT_GEOMETRY: ShellGeometry = {
	W: 1440,
	H: 900,
	tuner: { w: 440, h: 56 },
	rx: { w: 300, h: 56 },
	listen: { w: 340, h: 64 },
	listenLiveH: 64,
	tunerLive: { w: 440, h: 56 },
	rxLive: { w: 300, h: 56 },
	listenLiveW: 340,
	dockW: 0,
	cardH: 300,
}

export interface DrawerRect {
	readonly top: number
	readonly bottom: number
	readonly right: number
	/** Px width, or null when it spans from the left gutter. */
	readonly width: number | null
	readonly full: boolean
	/** The left edge has a resize grip (full height, or between the rows with a set width). */
	readonly resizable: boolean
	/** The widest the grip may take it to now (640 px, less what the Receiver needs beside a full-height drawer). */
	readonly maxW: number
}

/** The attached pane: left of a full-height drawer, between the top island row and the bottom row. */
export interface PaneRect {
	readonly top: number
	readonly bottom: number
	readonly left: number
	/** Distance from the right edge: the pane's right edge sits 1 px over the drawer's border (one outline). */
	readonly right: number
	readonly width: number
}

/** What the open drawer asks of its attached pane (docs/web/DESIGN.md, "drawer + attached pane"). */
export interface PaneRequest {
	/** The drawer wants its pane shown now. */
	readonly want: boolean
	/** Without room for the pane, its content is pushed into a full-width drawer as a screen. */
	readonly pushIn: boolean
}

export interface ShellLayout {
	/** The drawer covers the full height on the right; the Receiver and dock step aside. */
	readonly full: boolean
	readonly drawer: DrawerRect | null
	/** Receiver's distance from the right edge. */
	readonly rxRight: number
	/** Receiver's top: stacked under the Tuner when the top row cannot hold both. */
	readonly rxTop: number
	readonly dockX: number
	readonly dockHidden: boolean
	/** The dock drops the active view's label. */
	readonly compact: boolean
	/** Tuned card top-left at the wanted anchor (else the nearest free one), or null when hidden. */
	readonly card: Point | null
	/** The anchor the card sits on, or null when hidden. */
	readonly cardAnchor: CardAnchorId | null
	/** Free anchors for the card (empty while it hides): drag snaps and arrow keys move between these. */
	readonly anchors: readonly CardAnchor[]
	/** Width of the free plot area left of a full-height drawer (the card is dragged inside it). */
	readonly freeW: number
	/** Bottom of the top row (where between-rows drawers start). */
	readonly topRow: number
	/** The drawer's attached pane, or null (not wanted, or no room for it). */
	readonly pane: PaneRect | null
	/** The pane is wanted but has no room: the drawer is full width and shows the pane's content as a screen. */
	readonly pushed: boolean
}

export interface Point {
	readonly x: number
	readonly y: number
}

interface Rect extends Point {
	readonly w: number
	readonly h: number
}

// ---- tuned card anchors (canvas ANCHORS): "above Listen" (the default) sits left-aligned with Listen, one gutter
// above it, and rides up when Listen expands; it replaces the old bottom-left anchor ('bl' still resolves to it)
export const CARD_ANCHOR_IDS = [
	"al",
	"tl",
	"tc",
	"tr",
	"ml",
	"mr",
	"bc",
	"br",
] as const
export type CardAnchorId = (typeof CARD_ANCHOR_IDS)[number]
export const DEFAULT_CARD_ANCHOR: CardAnchorId = "al"

interface AnchorSpec {
	readonly id: CardAnchorId
	readonly name: string
	readonly h: "l" | "c" | "r"
	readonly v: "al" | "t" | "m" | "b"
}
const ANCHORS: readonly AnchorSpec[] = [
	{ id: "al", name: "above Listen", h: "l", v: "al" },
	{ id: "tl", name: "top left", h: "l", v: "t" },
	{ id: "tc", name: "top centre", h: "c", v: "t" },
	{ id: "tr", name: "top right", h: "r", v: "t" },
	{ id: "ml", name: "left edge", h: "l", v: "m" },
	{ id: "mr", name: "right edge", h: "r", v: "m" },
	{ id: "bc", name: "bottom centre", h: "c", v: "b" },
	{ id: "br", name: "bottom right", h: "r", v: "b" },
]
const CARD_ALIAS: Readonly<Record<string, CardAnchorId>> = { bl: "al" }

/** An anchor's spoken name ("top left"). */
export function cardAnchorName(id: CardAnchorId): string {
	return ANCHORS.find(a => a.id === id)?.name ?? id
}

/** A free card anchor: the card's top-left there. */
export interface CardAnchor extends Point {
	readonly id: CardAnchorId
	/** Spoken name ("Card moved to top left"). */
	readonly name: string
}

/** A stored or typed anchor id as a known one ('bl' is "above Listen"), or null. */
export function toCardAnchorId(id: unknown): CardAnchorId | null {
	if (typeof id !== "string") return null
	const a = CARD_ALIAS[id] ?? id
	return (CARD_ANCHOR_IDS as readonly string[]).includes(a)
		? (a as CardAnchorId)
		: null
}

/** The anchor closest to (x, y), or null when there is none. */
export function nearestAnchor(
	anchors: readonly CardAnchor[],
	x: number,
	y: number,
): CardAnchor | null {
	let best: CardAnchor | null = null
	let bd = Infinity
	for (const a of anchors) {
		const d = Math.hypot(a.x - x, a.y - y)
		if (d < bd) {
			bd = d
			best = a
		}
	}
	return best
}

export type CardDirection = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"
const DIRS: Readonly<Record<CardDirection, readonly [number, number]>> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
}

/** The arrow key's anchor from `from` (canvas cardKey): at least 24 px along the key's direction, scored by distance
 * along it plus twice the distance across it; null when nothing lies that way. */
export function anchorInDirection(
	anchors: readonly CardAnchor[],
	from: Point,
	dir: CardDirection,
): CardAnchor | null {
	const [ux, uy] = DIRS[dir]
	let best: CardAnchor | null = null
	let bestScore = Infinity
	for (const a of anchors) {
		const dx = a.x - from.x
		const dy = a.y - from.y
		const along = dx * ux + dy * uy
		const across = Math.abs(dx * uy) + Math.abs(dy * ux)
		if (along < 24) continue
		const score = along + across * 2
		if (score < bestScore) {
			bestScore = score
			best = a
		}
	}
	return best
}

// two rects closer than one gutter (the -1 lets edges exactly one gutter apart pass)
const hits = (a: Rect, b: Rect): boolean =>
	a.x < b.x + b.w + G - 1 &&
	b.x < a.x + a.w + G - 1 &&
	a.y < b.y + b.h + G - 1 &&
	b.y < a.y + a.h + G - 1

/** The card's free anchors (canvas shellLayout): each is pushed off the islands along its own axis, dropped if it
 * still collides or leaves the free area, and dropped within 48 px of an earlier one. */
export function cardAnchors(
	islands: readonly Rect[],
	freeW: number,
	H: number,
	cardH: number,
	listenLiveH: number,
): { anchors: CardAnchor[]; spots: Record<CardAnchorId, Point> } {
	const cw = CARD_W
	const xs = { l: G, c: Math.round((freeW - cw) / 2), r: freeW - G - cw }
	const anchors: CardAnchor[] = []
	const spots = {} as Record<CardAnchorId, Point>
	for (const A of ANCHORS) {
		// above Listen is not pushed anywhere, so it never drifts away from Listen (if a tall panel leaves no room
		// the card uses the nearest other anchor meanwhile)
		const y0 =
			A.v === "al"
				? H - G - listenLiveH - G - cardH
				: A.v === "t"
					? G
					: A.v === "b"
						? H - G - cardH
						: Math.round((H - cardH) / 2)
		const x = xs[A.h]
		spots[A.id] = { x, y: y0 }
		let y = y0
		for (let i = 0; i < 4 && A.v !== "al"; i++) {
			const r = { x, y, w: cw, h: cardH }
			const hit = islands.find(b => hits(r, b))
			if (!hit) break
			if (A.v === "t") y = hit.y + hit.h + G
			else if (A.v === "b") y = hit.y - G - cardH
			else {
				y = -1
				break
			}
		}
		const r = { x, y, w: cw, h: cardH }
		if (
			y < G ||
			y + cardH > H - G ||
			x < G ||
			x + cw > freeW - G ||
			islands.some(b => hits(r, b))
		)
			continue
		if (anchors.some(o => Math.hypot(o.x - x, o.y - y) < 48)) continue
		anchors.push({ id: A.id, name: A.name, x, y })
	}
	return { anchors, spots }
}

export interface CardOptions {
	/** The anchor the card wants (remembered per browser); default "above Listen". */
	readonly at?: string
	/** The Receiver panel is open: a between-rows drawer is not shown, so the card need not clear it. */
	readonly rxOpen?: boolean
	/** The open drawer's wanted width (src/shell/drawer-width.ts); its default when omitted. */
	readonly drawerW?: number
}

export function shellLayout(
	g: ShellGeometry,
	drawerId: DrawerId | null,
	paneRequest: PaneRequest | null = null,
	cardOpts: CardOptions = {},
): ShellLayout {
	const { W, H } = g
	const stacked = G + g.tuner.w + G + g.rx.w + G > W
	const rxTop = stacked ? G + g.tuner.h + 8 : G
	const topRow = stacked
		? rxTop + g.rx.h + G
		: G + Math.max(g.tuner.h, g.rx.h) + G
	const minX = G + g.listen.w + G
	// widest drawer that still leaves the Tuner and the slid Receiver on the top row, and Listen and a compact dock on the bottom
	const drMax =
		W - G - Math.max(G + g.tuner.w + G + g.rx.w + G, minX + DOCK_COMPACT + G)
	const want = drawerId ? (cardOpts.drawerW ?? DRAWER_W[drawerId]) : 0
	const dW = drawerId ? Math.min(want, drMax) : 0
	const full = drawerId !== null && W >= FULL_MIN_VW && dW >= DR_MIN
	const clearR = full ? dW + G : 0
	const freeW = W - clearR
	const dockHidden = W < DOCK_MIN_VW
	const bottomRow =
		G + (dockHidden ? g.listen.h : Math.max(g.listen.h, DOCK_H)) + G

	// the pane attaches only beside a full-height drawer (the Receiver then clears the Tuner: about 1164 px with the
	// default islands, more while the Tuner shows a scan row); otherwise a push-in pane takes the full-width drawer
	const paneWanted = drawerId !== null && paneRequest?.want === true
	const pane: PaneRect | null =
		paneWanted && full
			? {
					top: topRow,
					bottom: bottomRow,
					left: G,
					right: G + dW - 1,
					width: W - G - (G + dW - 1),
				}
			: null
	const pushed = paneWanted && !full && paneRequest.pushIn

	let drawer: DrawerRect | null = null
	if (drawerId) {
		if (full)
			drawer = {
				top: G,
				bottom: G,
				right: G,
				width: dW,
				full: true,
				resizable: true,
				maxW: Math.max(DR_MIN, Math.min(DR_MAX, drMax)),
			}
		else if (W < FULL_MIN_VW || pushed)
			drawer = {
				top: topRow,
				bottom: bottomRow,
				right: G,
				width: null,
				full: false,
				resizable: false,
				maxW: DR_MAX,
			}
		else
			drawer = {
				top: G + g.rx.h + G,
				bottom: bottomRow,
				right: G,
				width: Math.min(want, W - 2 * G),
				full: false,
				resizable: true,
				maxW: Math.max(DR_MIN, Math.min(DR_MAX, W - 2 * G)),
			}
	}

	const compact = W < 1180 || (full && freeW - G - minX < DOCK_WIDE)
	const dockW = g.dockW || (compact ? 400 : 500)
	let dockX = Math.max((W - dockW) / 2, minX)
	if (full && dockX + dockW > freeW - G)
		dockX = Math.max(minX, freeW - G - dockW)

	dockX = Math.round(dockX)

	// the tuned card hides on narrow windows (board: <= 1100 px) and while a pane covers the plot (attached or pushed
	// in); otherwise it takes its wanted anchor, or the nearest free one while that is taken, or hides when none is free
	let anchors: CardAnchor[] = []
	let home: CardAnchor | null = null
	if (W > FULL_MIN_VW && pane === null && !pushed) {
		const listenLiveH = g.listenLiveH
		const islands: Rect[] = [
			{ x: G, y: G, w: g.tunerLive.w, h: g.tunerLive.h },
			{ x: freeW - G - g.rxLive.w, y: rxTop, w: g.rxLive.w, h: g.rxLive.h },
			{ x: G, y: H - G - listenLiveH, w: g.listenLiveW, h: listenLiveH },
		]
		if (!dockHidden)
			islands.push({ x: dockX, y: H - G - DOCK_H, w: dockW, h: DOCK_H })
		// a drawer between the rows covers the plot; it only shows while the Receiver panel is shut
		if (drawer && !drawer.full && !cardOpts.rxOpen) {
			const ow = drawer.width ?? W - 2 * G
			islands.push({
				x: W - drawer.right - ow,
				y: drawer.top,
				w: ow,
				h: H - drawer.top - drawer.bottom,
			})
		}
		const r = cardAnchors(islands, freeW, H, g.cardH, listenLiveH)
		anchors = r.anchors
		const at = toCardAnchorId(cardOpts.at) ?? DEFAULT_CARD_ANCHOR
		const want = r.spots[at]
		home =
			anchors.find(a => a.id === at) ?? nearestAnchor(anchors, want.x, want.y)
	}

	return {
		full,
		drawer,
		rxRight: G + clearR,
		rxTop,
		dockX,
		dockHidden,
		compact,
		card: home ? { x: home.x, y: home.y } : null,
		cardAnchor: home?.id ?? null,
		anchors,
		freeW,
		topRow,
		pane,
		pushed,
	}
}
