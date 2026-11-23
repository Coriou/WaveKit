// Applying a layout rectangle to an element, and measuring the intrinsic sizes the layout needs. A slot carries
// `data-wk-slot="<id>"` and `data-wk-rect="x,y,w,h"` (ui-check compares the two); its element has no position CSS of
// its own.
import type { CSSProperties } from "react"

import { statusSeen, type StatusState } from "./compute.ts"
import { rectAttr, type Rect } from "./geometry.ts"

/** A slot's attributes: its id and rectangle and, given its state, `data-wk-state` and `inert` while the reader
 * cannot see it (LY rules §1.2: one predicate, `statusSeen`, for the render, the focus order and the timers). */
export function slotAttrs(
	id: string,
	r: Rect | null,
	state?: StatusState,
): {
	"data-wk-slot": string
	"data-wk-rect"?: string
	"data-wk-state"?: StatusState
	inert?: boolean
} {
	const at = r
		? { "data-wk-slot": id, "data-wk-rect": rectAttr(r) }
		: { "data-wk-slot": id }
	return state === undefined
		? at
		: { ...at, "data-wk-state": state, inert: !statusSeen(state) }
}

/** The structural part of an element the focus hand-off reads (a DOM Element is one). */
export interface SlotNode {
	closest(selector: string): SlotNode | null
	getAttribute(name: string): string | null
	readonly parentElement: SlotNode | null
}

/**
 * The focus is inside a slot the reader cannot see (LY rules §1.2, focus hand-off): an enclosing slot listed in
 * `unseen` ("status:<id>", from the layout: the DOM may not carry the new state yet), or an enclosing element whose
 * `data-wk-state` is not seen (shown or docked).
 */
export function focusInUnseen(
	active: SlotNode | null,
	unseen: readonly string[],
): boolean {
	for (
		let el = active?.closest("[data-wk-slot], [data-wk-state]") ?? null;
		el !== null;
		el = el.parentElement?.closest("[data-wk-slot], [data-wk-state]") ?? null
	) {
		const id = el.getAttribute("data-wk-slot")
		if (id !== null && unseen.includes(id)) return true
		const state = el.getAttribute("data-wk-state")
		if (state !== null && state !== "shown" && state !== "docked") return true
	}
	return false
}

/** Position at the rectangle's top-left (its size is the element's own unless `sized`). */
export function topLeft(r: Rect, sized = false): CSSProperties {
	return {
		left: r.x,
		top: r.y,
		right: "auto",
		bottom: "auto",
		translate: "none",
		...(sized ? { width: r.w, height: r.h } : {}),
	}
}

/** Position by its bottom-left corner (an island whose panel opens upward, the player storey). */
export function bottomLeft(r: Rect, H: number): CSSProperties {
	return {
		left: r.x,
		bottom: H - r.y - r.h,
		top: "auto",
		right: "auto",
		translate: "none",
	}
}

/** A measuring context for text widths (the font the element renders with). */
let ctx: CanvasRenderingContext2D | null | undefined
function textWidth(el: Element): number {
	if (ctx === undefined)
		ctx =
			typeof document === "undefined"
				? null
				: document.createElement("canvas").getContext("2d")
	const text = el.textContent ?? ""
	if (!ctx) return text.length * 7
	const cs = getComputedStyle(el)
	ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
	return ctx.measureText(text).width
}

/**
 * A row's natural one-line width: its padding and border, each shown child's width with the gaps between them,
 * and the children marked `[data-measure-text]` at their text's width (they may be wrapped or clipped now).
 */
export function naturalRowWidth(el: HTMLElement): number {
	const cs = getComputedStyle(el)
	const gap = parseFloat(cs.columnGap) || 0
	let w =
		(parseFloat(cs.paddingLeft) || 0) +
		(parseFloat(cs.paddingRight) || 0) +
		(parseFloat(cs.borderLeftWidth) || 0) +
		(parseFloat(cs.borderRightWidth) || 0)
	let n = 0
	for (const c of el.children) {
		if (getComputedStyle(c).display === "none") continue
		n++
		w += c.hasAttribute("data-measure-text")
			? textWidth(c)
			: c.getBoundingClientRect().width
	}
	return Math.ceil(w + gap * Math.max(0, n - 1)) + 1
}
