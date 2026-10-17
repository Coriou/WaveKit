import { describe, expect, it } from "vitest"

import {
	anchorInDirection,
	CARD_W,
	DEFAULT_GEOMETRY,
	DOCK_H,
	G,
	nearestAnchor,
	shellLayout,
	toCardAnchorId,
	type CardAnchor,
	type ShellGeometry,
} from "../../src/shell/layout.ts"

const at = (
	W: number,
	H = 900,
	extra: Partial<ShellGeometry> = {},
): ShellGeometry => ({ ...DEFAULT_GEOMETRY, W, H, dockW: 460, ...extra })

const ids = (a: readonly CardAnchor[]) => a.map(x => x.id)
const byId = (a: readonly CardAnchor[], id: string) => a.find(x => x.id === id)

describe("tuned card anchors", () => {
	it("1440 x 900, nothing open: all eight anchors, pushed off the islands", () => {
		const L = shellLayout(at(1440), null)
		expect(ids(L.anchors)).toEqual([
			"al",
			"tl",
			"tc",
			"tr",
			"ml",
			"mr",
			"bc",
			"br",
		])
		// top anchors sit one gutter under the top row
		expect(byId(L.anchors, "tl")).toEqual({
			id: "tl",
			name: "top left",
			x: G,
			y: G + 56 + G,
		})
		expect(byId(L.anchors, "tr")?.x).toBe(1440 - G - CARD_W)
		// bottom centre is pushed above the dock; bottom right sits on the baseline
		expect(byId(L.anchors, "bc")?.y).toBe(900 - G - DOCK_H - G - 300)
		expect(byId(L.anchors, "br")?.y).toBe(900 - G - 300)
		expect(L.cardAnchor).toBe("al")
	})

	it("takes the wanted anchor, and 'bl' is above Listen", () => {
		const L = shellLayout(at(1440), null, null, { at: "tr" })
		expect(L.cardAnchor).toBe("tr")
		expect(L.card).toEqual({ x: 1440 - G - CARD_W, y: G + 56 + G })
		expect(shellLayout(at(1440), null, null, { at: "bl" }).cardAnchor).toBe(
			"al",
		)
		expect(shellLayout(at(1440), null, null, { at: "nope" }).cardAnchor).toBe(
			"al",
		)
	})

	it("an open Listen panel too tall for above Listen: the card takes the nearest free anchor", () => {
		const L = shellLayout(
			at(1440, 900, { listenLiveH: 520, listenLiveW: 360 }),
			null,
		)
		expect(byId(L.anchors, "al")).toBeUndefined()
		expect(L.cardAnchor).not.toBeNull()
		expect(L.cardAnchor).not.toBe("al")
		// and it never overlaps the open Listen panel
		const c = L.card
		expect(c).not.toBeNull()
		if (c)
			expect(c.x >= G + 360 + G - 1 || c.y + 300 <= 900 - G - 520 - G + 1).toBe(
				true,
			)
	})

	it("an open Receiver panel pushes the top right anchor below it, or drops it", () => {
		const L = shellLayout(at(1440, 900, { rxLive: { w: 300, h: 400 } }), null)
		const tr = byId(L.anchors, "tr")
		if (tr) expect(tr.y).toBeGreaterThanOrEqual(G + 400 + G)
		expect(byId(L.anchors, "mr")).toBeUndefined()
	})

	it("anchors stay in the free area left of a full-height drawer", () => {
		const L = shellLayout(at(1440), "activity")
		const freeW = 1440 - 420 - G
		expect(L.freeW).toBe(freeW)
		for (const a of L.anchors)
			expect(a.x + CARD_W).toBeLessThanOrEqual(freeW - G)
		expect(byId(L.anchors, "tr")?.x).toBe(freeW - G - CARD_W)
	})

	it("drops anchors within 48 px of an earlier one", () => {
		// a short window: middle and top/bottom anchors coincide
		const L = shellLayout(at(1440, 760, { cardH: 560 }), null)
		for (const a of L.anchors)
			for (const b of L.anchors)
				if (a !== b)
					expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(48)
	})

	it("hides on narrow windows and while a pane covers the plot", () => {
		const narrow = shellLayout(at(1100), null)
		expect(narrow.card).toBeNull()
		expect(narrow.anchors).toEqual([])
		const pane = shellLayout(at(1440), "scanner", { want: true, pushIn: true })
		expect(pane.card).toBeNull()
		expect(pane.anchors).toEqual([])
	})

	it("a between-rows drawer is kept clear, unless the Receiver panel is open", () => {
		// 1120 px: the drawer cannot take 360 px beside the islands, so it overlays between the rows
		const g = at(1120)
		const L = shellLayout(g, "settings")
		expect(L.full).toBe(false)
		const left = 1120 - G - Math.min(560, 1120 - 2 * G)
		for (const a of L.anchors)
			expect(a.x + CARD_W).toBeLessThanOrEqual(left - G + 1)
		const open = shellLayout(g, "settings", null, { rxOpen: true })
		expect(open.anchors.length).toBeGreaterThanOrEqual(L.anchors.length)
	})
})

describe("nearestAnchor and anchorInDirection", () => {
	const A: CardAnchor[] = [
		{ id: "tl", name: "top left", x: 16, y: 88 },
		{ id: "tr", name: "top right", x: 1104, y: 88 },
		{ id: "al", name: "above Listen", x: 16, y: 504 },
		{ id: "br", name: "bottom right", x: 1104, y: 584 },
		{ id: "tc", name: "top centre", x: 560, y: 88 },
	]

	it("nearest by straight-line distance; null for none", () => {
		expect(nearestAnchor(A, 900, 500)?.id).toBe("br")
		expect(nearestAnchor(A, 0, 0)?.id).toBe("tl")
		expect(nearestAnchor([], 0, 0)).toBeNull()
	})

	it("arrow keys step to the anchor that way, preferring the straight line", () => {
		const al = { x: 16, y: 504 }
		expect(anchorInDirection(A, al, "ArrowUp")?.id).toBe("tl")
		expect(anchorInDirection(A, al, "ArrowRight")?.id).toBe("br")
		expect(anchorInDirection(A, al, "ArrowLeft")).toBeNull()
		// bottom right is 80 px lower: Down reaches it (along 80, across 1088)
		expect(anchorInDirection(A, al, "ArrowDown")?.id).toBe("br")
		expect(anchorInDirection(A, { x: 1104, y: 584 }, "ArrowDown")).toBeNull()
		expect(anchorInDirection(A, { x: 16, y: 88 }, "ArrowRight")?.id).toBe("tc")
	})

	it("ignores anchors less than 24 px along the direction", () => {
		const near: CardAnchor[] = [{ id: "tc", name: "top centre", x: 36, y: 88 }]
		expect(anchorInDirection(near, { x: 16, y: 88 }, "ArrowRight")).toBeNull()
	})
})

describe("toCardAnchorId", () => {
	it("knows the eight ids and the bl alias", () => {
		expect(toCardAnchorId("mr")).toBe("mr")
		expect(toCardAnchorId("bl")).toBe("al")
		expect(toCardAnchorId("xx")).toBeNull()
		expect(toCardAnchorId(null)).toBeNull()
	})
})
