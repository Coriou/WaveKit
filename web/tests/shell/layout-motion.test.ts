// The shell layout's motion, drag, insufficient-height and map rules (docs/web/DESIGN.md, "Layout: rails and stage":
// "Motion", "Dragging the card", "Insufficient height", "The map's chrome"). Expected numbers from the stated
// arithmetic; each bound is tested at and one past it.
import { describe, expect, it } from "vitest"

import { clampDrag, type CardFrame } from "../../src/shell/card-place.ts"
import { CARD_W } from "../../src/shell/layout.ts"
import {
	cardObstacles,
	computeLayout,
	DEFAULT_SIZES,
	layoutViolations,
	namedRects,
	ROWS_FULL_CSS,
	ROWS_LEAN_CSS,
	type LayoutInput,
	type MapInput,
} from "../../src/shell/layout/compute.ts"
import { intersects, type Rect } from "../../src/shell/layout/geometry.ts"
import { TRACE_FLOOR_CSS } from "../../src/plot/layout.ts"

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
const box = (l: Rect | null): Rect | null =>
	l === null ? null : r(l.x, l.y, l.w, l.h)

function input(
	W: number,
	H: number,
	o: Partial<LayoutInput> = {},
): LayoutInput {
	return {
		viewport: { w: W, h: H },
		tuner: { w: 440, h: 56 },
		receiver: { w: 300, h: 56 },
		listen: { w: 340, h: 64 },
		dock: DEFAULT_SIZES.dock,
		player: null,
		card: {
			expanded: { w: 340, h: 440 },
			line: { w: 340, h: 52 },
			minimised: false,
			anchor: "al",
		},
		status: [],
		drawer: null,
		panels: [],
		...o,
	}
}
const PLAYER = { w: 560, h: 70 }
const COMPACT = { w: 560, h: 38 }

describe("motion: the card's glide never crosses a slot", () => {
	it("1440 x 900: playback starting holds the player while the 440 px card glides from 364 to 278", () => {
		const before = computeLayout(input(1440, 900))
		expect(box(before.card)).toEqual(r(16, 364, 340, 440))
		const settled = computeLayout(input(1440, 900, { player: PLAYER }))
		expect(box(settled.card)).toEqual(r(16, 278, 340, 440))
		expect(box(settled.player)).toEqual(r(16, 734, 560, 70))
		expect(settled.held).toEqual([])
		const gliding = computeLayout(
			input(1440, 900, {
				player: PLAYER,
				motion: { cardFrom: before.card },
			}),
		)
		// the box of both homes: 16,278 .. 356,804; the player (734..804) enters it, so it waits for the landing
		expect(gliding.held).toEqual(["player"])
		// the plot keeps its labels off the whole box meanwhile (body px: 278 - 84 = 194)
		expect(gliding.plot.exclusions).toContainEqual(r(16, 194, 340, 526))
		expect(settled.plot.exclusions).not.toContainEqual(r(16, 194, 340, 526))
	})

	it("a drawer opening holds the drawer while a card on a right anchor glides left of it", () => {
		const at = { anchor: "tr" }
		const card = { ...input(1440, 900).card!, ...at }
		const before = computeLayout(input(1440, 900, { card }))
		const drawer = {
			id: "activity" as const,
			wantedW: 420,
			expanded: false,
			pane: null,
			hasNoticeSlot: true,
		}
		const after = computeLayout(
			input(1440, 900, { card, drawer, motion: { cardFrom: before.card } }),
		)
		expect(after.card?.anchor).toBe("tr")
		expect(after.card!.x).toBeLessThan(before.card!.x)
		expect(after.held).toContain("drawer")
		expect(after.held).toContain("grip")
	})

	it("a glide that crosses no slot holds nothing", () => {
		const before = computeLayout(input(1440, 900))
		const L = computeLayout(
			input(1440, 900, { motion: { cardFrom: before.card } }),
		)
		expect(L.held).toEqual([])
	})
})

describe("dragging the card", () => {
	const L = computeLayout(input(1440, 900, { player: PLAYER }))
	const frame: CardFrame = {
		anchors: L.cardAnchors,
		card: L.card,
		freeW: L.cardFreeW,
		H: 900,
		cardH: L.card!.h,
		obstacles: cardObstacles(L),
	}

	it("the live rectangle feeds the plot's exclusions and the card's named rectangle", () => {
		const D = computeLayout(
			input(1440, 900, {
				player: PLAYER,
				motion: { cardDrag: { x: 600, y: 120 } },
			}),
		)
		expect(box(D.cardNow)).toEqual(r(600, 120, 340, 440))
		expect(D.plot.exclusions).toContainEqual(r(600, 36, 340, 440))
		expect(namedRects(D).find(n => n.name === "card")).toMatchObject({
			x: 600,
			y: 120,
		})
		// the home and its anchors stay (the drop snaps from there)
		expect(box(D.card)).toEqual(box(L.card))
	})

	it("a drag onto the Tuner stops a gutter under it, never over the rails", () => {
		expect(clampDrag({ x: 16, y: 16 }, frame, null)).toEqual({ x: 16, y: 88 })
		// past Listen and the player: back above the player storey (734 - 16 - 440)
		expect(clampDrag({ x: 16, y: 500 }, frame, null)).toEqual({ x: 16, y: 278 })
	})

	it("keeps one gutter in from the window: at the bound it stays, one past it is clamped", () => {
		const open: CardFrame = { ...frame, obstacles: [] }
		const xHi = 1440 - 16 - CARD_W
		const yHi = 900 - 16 - 440
		expect(clampDrag({ x: xHi, y: yHi }, open, null)).toEqual({
			x: xHi,
			y: yHi,
		})
		expect(clampDrag({ x: xHi + 1, y: yHi + 1 }, open, null)).toEqual({
			x: xHi,
			y: yHi,
		})
		expect(clampDrag({ x: 16, y: 16 }, open, null)).toEqual({ x: 16, y: 16 })
		expect(clampDrag({ x: 15, y: 15 }, open, null)).toEqual({ x: 16, y: 16 })
	})

	it("every clamped spot keeps a gutter from every island", () => {
		for (let x = -200; x <= 1600; x += 97)
			for (let y = -200; y <= 1100; y += 89) {
				const p = clampDrag({ x, y }, frame, L.card)
				const card = r(p.x, p.y, CARD_W, frame.cardH)
				for (const o of frame.obstacles) {
					const grown = r(o.x - 15, o.y - 15, o.w + 30, o.h + 30)
					expect(intersects(card, grown), `${x},${y} at ${p.x},${p.y}`).toBe(
						false,
					)
				}
			}
	})
})

describe("insufficient height: the stated collapse order", () => {
	it("720 x 450 with the scan hold row, the Receiver stacked and the player: the player's compact line, rows end above it", () => {
		const L = computeLayout(
			input(720, 450, {
				tuner: { w: 472, h: 104 },
				player: PLAYER,
				playerCompact: COMPACT,
			}),
		)
		expect(L.stacked).toBe(true)
		expect(L.plot.insetTop).toBe(196)
		expect(L.player).toMatchObject({ ...r(16, 316, 560, 38), form: "compact" })
		expect(L.plot.rows).toBe("full")
		// rows end at 196 + 4 + 100 = 300, the player's top less a gutter
		expect(L.plot.rowsBottomMax).toBe(300)
		expect(L.plot.rowsMaxCss).toBe(104)
		expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
	})

	// at 1440 wide: inset 84, the bottom rail's top H - 80
	const at = (H: number, player = true) =>
		computeLayout(
			input(1440, H, {
				card: null,
				player: player ? PLAYER : null,
				playerCompact: COMPACT,
			}),
		)

	it("1: the full player stays while the rows have the full rows and the trace floor (H - 266 >= 148)", () => {
		expect(ROWS_FULL_CSS + TRACE_FLOOR_CSS).toBe(148)
		expect(at(414).player?.form).toBe("full")
		expect(at(413).player?.form).toBe("compact")
	})

	it("2-3: the trace floor yields, then the discovery row and the ruler (compact: H - 234 >= 100)", () => {
		expect(ROWS_FULL_CSS).toBe(100)
		expect(at(334).plot.rows).toBe("full")
		expect(at(334).plot.rowsMaxCss).toBe(100)
		expect(at(333).plot.rows).toBe("lean")
	})

	it("4: the player waits (still playing) when even the lean rows (54) have no room above its line", () => {
		expect(ROWS_LEAN_CSS).toBe(54)
		expect(at(288).playerWaiting).toBe(false)
		expect(at(288).plot.rows).toBe("lean")
		const w = at(287)
		expect(w.playerWaiting).toBe(true)
		expect(w.player).toBeNull()
		// without the player the rows have H - 180 = 107 px again
		expect(w.plot.rows).toBe("full")
	})

	it("5: every scale row hides when the lean rows have no room over Listen (H - 180 >= 54)", () => {
		expect(at(234, false).plot.rows).toBe("lean")
		const n = at(233, false)
		expect(n.plot.rows).toBe("none")
		expect(n.plot.rowsMaxCss).toBe(0)
	})
})

describe("the map's chrome", () => {
	const MAP: MapInput = {
		railH: 300,
		side: null,
		station: null,
		live: { w: 64, h: 44 },
		scale: { w: 90, h: 20 },
		footer: { w: 380, h: 15 },
	}
	const activity = {
		id: "activity" as const,
		wantedW: 420,
		expanded: false,
		pane: null,
		hasNoticeSlot: true,
	}

	it("1280 x 800: the Live chip stays on the bottom rail right of the dock when Activity opens", () => {
		const a = computeLayout(input(1280, 800, { map: MAP }))
		const b = computeLayout(input(1280, 800, { map: MAP, drawer: activity }))
		expect(a.map?.cornerOnRail).toBe(true)
		expect(a.map?.live).toEqual(r(1200, 740, 64, 44))
		expect(a.map?.scale).toEqual(r(1102, 764, 90, 20))
		// the attribution line above, from a gutter right of the dock (452 + 492 + 16 = 960: the dock reserves Listen's
		// open 420, LY rules §2.2) to the window's gutter (1280 − 16 − 960 = 304)
		expect(a.map?.footer).toEqual(r(960, 717, 304, 15))
		expect(b.map?.live).toEqual(a.map?.live)
		expect(b.map?.scale).toEqual(a.map?.scale)
		expect(b.map?.footer).toEqual(a.map?.footer)
		expect(intersects(b.map!.live!, b.dock!)).toBe(false)
		// the column stands a gutter above the attribution line
		expect(box(b.drawer)).toEqual(r(844, 88, 420, 613))
		// the rail under the Receiver; the drawer covers it (hidden, never moved)
		expect(a.map?.rail).toEqual(r(1108, 88, 156, 300))
		expect(b.map?.rail).toBeNull()
		expect(b.map?.covered).toContain("rail")
		for (const L of [a, b])
			expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
	})

	it("the corner stays on the rail while scale + 8 + Live fits right of the dock (room 304 @1280, 168 @1100)", () => {
		// room = W − G − (right(dock) + G): 1280 − 16 − 960 = 304; 1100 − 16 − (452 + 448 + 16) = 168
		const on = (W: number, rowW: number) =>
			computeLayout(
				input(W, 800, { map: { ...MAP, scale: { w: rowW - 8 - 64, h: 20 } } }),
			).map?.cornerOnRail
		expect(on(1280, 304)).toBe(true)
		expect(on(1280, 305)).toBe(false)
		expect(on(1100, 168)).toBe(true)
		expect(on(1100, 169)).toBe(false)
		for (const [W, rowW] of [
			[1280, 305],
			[1100, 169],
		] as const) {
			const L = computeLayout(
				input(W, 800, { map: { ...MAP, scale: { w: rowW - 8 - 64, h: 20 } } }),
			)
			expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
		}
	})

	it("the side panel and the station chip stand left of the rail", () => {
		const L = computeLayout(
			input(1440, 900, {
				map: { ...MAP, side: { w: 320, h: 900 }, station: { w: 300, h: 36 } },
			}),
		)
		const m = L.map!
		expect(m.rail).toEqual(r(1268, 88, 156, 300))
		// 10 px left of the rail, clamped above the attribution line (817 - 16 - 88)
		expect(m.side).toEqual(r(938, 88, 320, 713))
		expect(m.sideMaxH).toBe(713)
		expect(m.station).toEqual(r(Math.round((16 + 922 - 300) / 2), 88, 300, 36))
		expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
	})

	it("390 x 844: the corner stands above the stack (the search button holds the rail's corner)", () => {
		const L = computeLayout(input(390, 844, { map: MAP }))
		const m = L.map!
		expect(m.cornerOnRail).toBe(false)
		expect(m.live).toEqual(r(310, 704, 64, 44))
		expect(m.footer).toEqual(r(16, 681, 358, 15))
		expect(m.rail).toEqual(r(326, 152, 48, 300))
		expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
		// a sheet covers the stage and the corner with it
		const S = computeLayout(input(390, 844, { map: MAP, drawer: activity }))
		expect(S.map?.covered).toEqual(expect.arrayContaining(["rail", "corner"]))
		expect(layoutViolations(namedRects(S), S.viewport)).toEqual([])
	})

	it("the tuned card's anchors keep off the map's chrome", () => {
		const L = computeLayout(input(1440, 900, { map: MAP }))
		const m = L.map!
		for (const a of L.cardAnchors) {
			const c = r(a.x, a.y, CARD_W, L.card!.h)
			for (const x of [m.rail, m.live, m.scale, m.footer])
				if (x) expect(intersects(c, x), a.id).toBe(false)
		}
	})
})

describe("open island panels are part of the layout", () => {
	const phone = (panel: LayoutInput["panels"][number]) =>
		computeLayout(input(390, 844, { card: null, panels: [panel] }))
	const frame = (L: ReturnType<typeof computeLayout>, own: string) =>
		namedRects(L).filter(
			n =>
				["tuner", "receiver", "listen", "dock", "find"].includes(n.name) &&
				n.name !== own &&
				!L.yielded.includes(n.name as "receiver"),
		)

	it("390 x 844: the Listen panel starts 8 px under the stacked Receiver, never under it", () => {
		const L = phone({ island: "listen", size: { w: 358, h: 700 } })
		expect(L.stacked).toBe(true)
		expect(box(L.receiver)).toEqual(r(16, 80, 300, 56))
		// 764 (the rail's top) - 8 - (136 + 8) = 612
		expect(L.panelMaxH.listen).toBe(612)
		expect(L.panels[0]?.rect).toEqual(r(16, 144, 358, 612))
		for (const n of frame(L, "listen"))
			expect(intersects(n, L.panels[0]!.rect), n.name).toBe(false)
		// at the cap it stands as tall as it is; one taller it is capped
		const at = phone({ island: "listen", size: { w: 358, h: 612 } })
		expect(at.panels[0]?.rect.h).toBe(612)
		const past = phone({ island: "listen", size: { w: 358, h: 613 } })
		expect(past.panels[0]?.rect).toEqual(r(16, 144, 358, 612))
	})

	it("the Tuner's panel over the stacked Receiver: the Receiver yields while it is open", () => {
		const L = phone({ island: "tuner", size: { w: 358, h: 400 } })
		expect(L.yielded).toEqual(["receiver"])
		for (const n of frame(L, "tuner"))
			expect(intersects(n, L.panels[0]!.rect), n.name).toBe(false)
		// side by side on a wide window: no frame island yields (the card above Listen does: the 400 px panel
		// reaches its home at 278)
		const W = computeLayout(
			input(1440, 900, {
				panels: [{ island: "tuner", size: { w: 440, h: 400 } }],
			}),
		)
		expect(W.yielded).toEqual(["card"])
	})

	it("a panel going down keeps 8 px above the bottom rail", () => {
		const L = computeLayout(
			input(1440, 500, {
				panels: [{ island: "receiver", size: { w: 300, h: 900 } }],
			}),
		)
		// rail top 420: 420 - 8 - (72 + 8) = 332
		expect(L.panels[0]?.rect).toEqual(r(1124, 80, 300, 332))
	})
})

describe("a panel going down starts under the whole top rail", () => {
	it("680 px with the scan hold row: the Receiver's panel opens under the Tuner's hold row, not beside it", () => {
		const L = computeLayout(
			input(680, 400, {
				card: null,
				tuner: { w: 472, h: 104 },
				receiver: { w: 160, h: 56 },
				panels: [{ island: "receiver", size: { w: 240, h: 80 } }],
			}),
		)
		expect(L.stacked).toBe(false)
		// the top rail ends at 120 (the Tuner's hold row): 128, 48 px past the Receiver's own 72 + 8
		expect(L.panels[0]?.rect).toEqual(r(424, 128, 240, 80))
		expect(L.panelDrop.receiver).toBe(48)
		expect(intersects(L.panels[0]!.rect, L.tuner)).toBe(false)
		// on the default rail nothing drops
		const D = computeLayout(input(1440, 900))
		expect(D.panelDrop).toEqual({ tuner: 0, receiver: 0, listen: 0 })
	})
})
