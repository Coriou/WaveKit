// The Immersive shell grid (docs/web/canvas/Immersive.dc.html, shellLayout): one 16 px gutter; top row Tuner and
// Receiver, bottom row Listen, the dock and the tuned card's home; the plot is always full-bleed. Pure, so it tests
// in node; the shell feeds it measured island sizes.
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
	/** Tuned card top-left at its "above Listen" home, or null when hidden. */
	readonly card: { readonly x: number; readonly y: number } | null
	/** Bottom of the top row (where between-rows drawers start). */
	readonly topRow: number
	/** The drawer's attached pane, or null (not wanted, or no room for it). */
	readonly pane: PaneRect | null
	/** The pane is wanted but has no room: the drawer is full width and shows the pane's content as a screen. */
	readonly pushed: boolean
}

export function shellLayout(
	g: ShellGeometry,
	drawerId: DrawerId | null,
	paneRequest: PaneRequest | null = null,
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
	const want = drawerId ? DRAWER_W[drawerId] : 0
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
		if (full) drawer = { top: G, bottom: G, right: G, width: dW, full: true }
		else if (W < FULL_MIN_VW || pushed)
			drawer = {
				top: topRow,
				bottom: bottomRow,
				right: G,
				width: null,
				full: false,
			}
		else
			drawer = {
				top: G + g.rx.h + G,
				bottom: bottomRow,
				right: G,
				width: Math.min(want, W - 2 * G),
				full: false,
			}
	}

	const compact = W < 1180 || (full && freeW - G - minX < DOCK_WIDE)
	const dockW = g.dockW || (compact ? 400 : 500)
	let dockX = Math.max((W - dockW) / 2, minX)
	if (full && dockX + dockW > freeW - G)
		dockX = Math.max(minX, freeW - G - dockW)

	// the card's home is one gutter above Listen's live top edge; it hides on narrow windows (board: <= 1100 px) and
	// when an open panel leaves no room under the top row
	const cardY = H - G - g.listenLiveH - G - g.cardH
	// the tuned card hides while a pane covers the plot (attached or pushed in)
	const card =
		W > FULL_MIN_VW &&
		cardY >= topRow &&
		G + CARD_W <= freeW - G &&
		pane === null &&
		!pushed
			? { x: G, y: cardY }
			: null

	return {
		full,
		drawer,
		rxRight: G + clearR,
		rxTop,
		dockX: Math.round(dockX),
		dockHidden,
		compact,
		card,
		topRow,
		pane,
		pushed,
	}
}
