import { describe, expect, it } from "vitest"

import {
	anchorInDirection,
	CARD_W,
	DOCK_H,
	G,
	nearestAnchor,
	toCardAnchorId,
	type CardAnchor,
} from "../../src/shell/layout.ts"
import {
	computeLayout,
	DEFAULT_SIZES,
	type LayoutInput,
} from "../../src/shell/layout/compute.ts"

const at = (
	W: number,
	H = 900,
	extra: Partial<LayoutInput> & { anchor?: string; cardH?: number } = {},
): LayoutInput => {
	const { anchor, cardH, ...rest } = extra
	return {
		viewport: { w: W, h: H },
		tuner: DEFAULT_SIZES.tuner,
		receiver: DEFAULT_SIZES.receiver,
		listen: DEFAULT_SIZES.listen,
		dock: DEFAULT_SIZES.dock,
		player: null,
		card: {
			expanded: { w: CARD_W, h: cardH ?? 300 },
			line: DEFAULT_SIZES.cardLine,
			minimised: false,
			anchor: anchor ?? "al",
		},
		status: [],
		drawer: null,
		panels: [],
		...rest,
	}
}

const ids = (a: readonly CardAnchor[]) => a.map(x => x.id)
const byId = (a: readonly CardAnchor[], id: string) => a.find(x => x.id === id)

describe("tuned card anchors", () => {
	it("1440 x 900, nothing open: all eight anchors, pushed off the rails", () => {
		const L = computeLayout(at(1440))
		expect(ids(L.cardAnchors)).toEqual([
			"al",
			"tl",
			"tc",
			"tr",
			"ml",
			"mr",
			"bc",
			"br",
		])
		// top anchors sit one gutter under the top rail (the status slot between the Tuner and the Receiver too)
		expect(byId(L.cardAnchors, "tl")).toEqual({
			id: "tl",
			name: "top left",
			x: G,
			y: G + 56 + G,
		})
		expect(byId(L.cardAnchors, "tc")?.y).toBe(G + 56 + G)
		expect(byId(L.cardAnchors, "tr")?.x).toBe(1440 - G - CARD_W)
		// bottom centre is pushed above the dock; bottom right sits on the baseline
		expect(byId(L.cardAnchors, "bc")?.y).toBe(900 - G - DOCK_H - G - 300)
		expect(byId(L.cardAnchors, "br")?.y).toBe(900 - G - 300)
		expect(L.card?.anchor).toBe("al")
	})

	it("takes the wanted anchor, and 'bl' is above Listen", () => {
		const L = computeLayout(at(1440, 900, { anchor: "tr" }))
		expect(L.card).toMatchObject({
			anchor: "tr",
			x: 1440 - G - CARD_W,
			y: G + 56 + G,
		})
		expect(computeLayout(at(1440, 900, { anchor: "bl" })).card?.anchor).toBe(
			"al",
		)
		expect(computeLayout(at(1440, 900, { anchor: "nope" })).card?.anchor).toBe(
			"al",
		)
	})

	it("an open island panel is a popover: the card stays where it is", () => {
		const closed = computeLayout(at(1440))
		const open = computeLayout(
			at(1440, 900, {
				panels: [{ island: "listen", size: { w: 420, h: 520 } }],
			}),
		)
		expect(open.card).toEqual(closed.card)
		expect(open.cardAnchors).toEqual(closed.cardAnchors)
	})

	it("above Listen rides on the player storey when a recording plays", () => {
		const L = computeLayout(at(1440, 900, { player: { w: 560, h: 70 } }))
		expect(L.card).toMatchObject({
			anchor: "al",
			y: 900 - G - 64 - G - 70 - G - 300,
		})
		// bottom centre clears the player as well as the dock
		const bc = byId(L.cardAnchors, "bc")
		if (bc) expect(bc.y + 300).toBeLessThanOrEqual(900 - G - 64 - G - 70 - G)
	})

	it("anchors stay in the free area left of a drawer column", () => {
		const L = computeLayout(
			at(1440, 900, {
				drawer: {
					id: "activity",
					wantedW: 420,
					expanded: false,
					pane: null,
					hasNoticeSlot: true,
				},
			}),
		)
		const freeW = 1440 - G - 420
		expect(L.cardFreeW).toBe(freeW)
		for (const a of L.cardAnchors)
			expect(a.x + CARD_W).toBeLessThanOrEqual(freeW - G)
		expect(byId(L.cardAnchors, "tr")?.x).toBe(freeW - G - CARD_W)
	})

	it("drops anchors within 48 px of an earlier one", () => {
		// a short window: middle and top/bottom anchors coincide
		const L = computeLayout(at(1440, 760, { cardH: 560 }))
		for (const a of L.cardAnchors)
			for (const b of L.cardAnchors)
				if (a !== b)
					expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(48)
	})

	it("hides on narrow windows and while a pane covers the plot", () => {
		const narrow = computeLayout(at(1100))
		expect(narrow.card).toBeNull()
		expect(narrow.cardAnchors).toEqual([])
		const pane = computeLayout(
			at(1440, 900, {
				drawer: {
					id: "scanner",
					wantedW: 420,
					expanded: false,
					pane: { want: true, pushIn: true },
					hasNoticeSlot: true,
				},
			}),
		)
		expect(pane.pane).not.toBeNull()
		expect(pane.card).toBeNull()
		expect(pane.cardAnchors).toEqual([])
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
