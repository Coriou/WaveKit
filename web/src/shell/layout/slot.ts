// Applying a layout rectangle to an element, and measuring the intrinsic sizes the layout needs. A slot carries
// `data-wk-slot="<id>"` and `data-wk-rect="x,y,w,h"` (ui-check compares the two); its element has no position CSS of
// its own.
import type { CSSProperties } from "react"

import { rectAttr, type Rect } from "./geometry.ts"

export function slotAttrs(
	id: string,
	r: Rect | null,
): { "data-wk-slot": string; "data-wk-rect"?: string } {
	return r
		? { "data-wk-slot": id, "data-wk-rect": rectAttr(r) }
		: { "data-wk-slot": id }
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
