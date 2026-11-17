// The shell's fixed numbers and the tuned card's anchors (docs/web/DESIGN.md, "Layout: rails and stage"). Every
// rectangle is computed by ./layout/compute.ts; this module holds the gutter, the drawer widths and the eight card
// anchors (above Listen by default) with their names, keys and drag snapping. Pure, so it tests in node.
import type { DrawerId } from "./store.ts"

export const G = 16
export const DOCK_H = 64
export const CARD_W = 340
/** From this width a drawer is a column on the right under the Receiver; below it a sheet between the rails. */
export const FULL_MIN_VW = 1100
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

// two rects closer than one gutter (the half pixel lets edges exactly one gutter apart pass; 15 px apart is a hit)
const hits = (a: Rect, b: Rect): boolean =>
	a.x < b.x + b.w + G - 0.5 &&
	b.x < a.x + a.w + G - 0.5 &&
	a.y < b.y + b.h + G - 0.5 &&
	b.y < a.y + a.h + G - 0.5

/** The card's free anchors (canvas shellLayout): each is pushed off the islands along its own axis, dropped if it
 * still collides or leaves the free area, and dropped within 48 px of an earlier one. "Above Listen" sits at
 * `aboveListenY` (one gutter over the stack) and is never pushed; it is free only from `topLimit` down. */
export function cardAnchors(
	islands: readonly Rect[],
	freeW: number,
	H: number,
	cardH: number,
	aboveListenY: number,
	topLimit: number = G,
): { anchors: CardAnchor[]; spots: Record<CardAnchorId, Point> } {
	const cw = CARD_W
	const xs = { l: G, c: Math.round((freeW - cw) / 2), r: freeW - G - cw }
	const anchors: CardAnchor[] = []
	const spots = {} as Record<CardAnchorId, Point>
	for (const A of ANCHORS) {
		// above Listen is not pushed anywhere, so it never drifts away from the stack
		const y0 =
			A.v === "al"
				? aboveListenY
				: A.v === "t"
					? G
					: A.v === "b"
						? H - G - cardH
						: Math.round((H - cardH) / 2)
		const x = xs[A.h]
		spots[A.id] = { x, y: y0 }
		let y = y0
		for (let i = 0; i <= islands.length && A.v !== "al"; i++) {
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
			y < (A.v === "al" ? topLimit : G) ||
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
