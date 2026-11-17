import { describe, expect, it } from "vitest"

import { plotLayout } from "../../src/plot/layout.ts"
import {
	computeLayout,
	DEFAULT_SIZES,
	layoutViolations,
	namedRects,
	PANE_MIN_W,
	stablePlot,
	STATUS_MIN_W,
	STATUS_ROW_H,
	TWO_LINE_H,
	TWO_LINE_PAD,
	type DrawerInput,
	type Layout,
	type LayoutInput,
	type StatusItem,
} from "../../src/shell/layout/compute.ts"
import type { Rect } from "../../src/shell/layout/geometry.ts"
import type { DrawerId } from "../../src/shell/store.ts"

// The intrinsic sizes the design fixes for the expected numbers (docs/web/DESIGN.md, "Layout: rails and stage").
const CONDITION: StatusItem = {
	id: "condition",
	kind: "condition",
	forms: {
		full: { w: 431, h: 44 },
		compact: { w: 168, h: 44 },
		icon: { w: 44, h: 44 },
	},
}
const RECEIPT: StatusItem = {
	id: "receipt",
	kind: "receipt",
	forms: { full: { w: 220, h: 44 } },
}

type DrawerState =
	| "none"
	| "activity"
	| "recordings"
	| "scanner"
	| "settings"
	| "expanded"

const drawerOf = (d: DrawerState): DrawerInput | null =>
	d === "none"
		? null
		: {
				id: (d === "expanded" ? "activity" : d) as DrawerId,
				wantedW: d === "settings" ? 560 : 420,
				expanded: d === "expanded",
				pane: null,
				hasNoticeSlot: true,
			}

function input(
	W: number,
	H: number,
	o: {
		drawer?: DrawerState
		player?: boolean
		minimised?: boolean
		status?: StatusItem[]
		tunerH?: number
		tunerW?: number
		anchor?: string
	} = {},
): LayoutInput {
	const phone = W < 761
	return {
		viewport: { w: W, h: H },
		tuner: { w: o.tunerW ?? 440, h: o.tunerH ?? 56 },
		receiver: { w: 300, h: 56 },
		listen: { w: 340, h: 64 },
		dock: DEFAULT_SIZES.dock,
		player: o.player === false ? null : { w: 560, h: 70 },
		card: {
			expanded: { w: 340, h: 440 },
			line: { w: 340, h: 52 },
			minimised: o.minimised ?? false,
			anchor: o.anchor ?? "al",
		},
		status: o.status ?? [],
		drawer: drawerOf(o.drawer ?? "none"),
		panels: [],
		...(phone ? {} : {}),
	}
}

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
const box = (l: Rect | null): Rect | null =>
	l === null ? null : r(l.x, l.y, l.w, l.h)

const STATES: DrawerState[] = [
	"none",
	"activity",
	"recordings",
	"scanner",
	"settings",
	"expanded",
]

describe("computeLayout: frame and stack (expected rectangles)", () => {
	const table: {
		vp: [number, number]
		tuner: Rect
		receiver: Rect
		listen: Rect
		dock: Rect | null
		find: Rect | null
		player: Rect
		line: Rect | null
		card: Rect | null
		inset: number
		rows: [number, number]
	}[] = [
		{
			vp: [1440, 900],
			tuner: r(16, 16, 440, 56),
			receiver: r(1124, 16, 300, 56),
			listen: r(16, 820, 340, 64),
			dock: r(474, 820, 492, 64),
			find: null,
			player: r(16, 734, 560, 70),
			line: r(16, 666, 340, 52),
			card: r(16, 278, 340, 440),
			inset: 84,
			rows: [384, 484],
		},
		{
			vp: [1280, 800],
			tuner: r(16, 16, 440, 56),
			receiver: r(964, 16, 300, 56),
			listen: r(16, 720, 340, 64),
			dock: r(394, 720, 492, 64),
			find: null,
			player: r(16, 634, 560, 70),
			line: r(16, 566, 340, 52),
			card: r(16, 178, 340, 440),
			inset: 84,
			rows: [370, 470],
		},
		{
			vp: [1100, 800],
			tuner: r(16, 16, 440, 56),
			receiver: r(784, 16, 300, 56),
			listen: r(16, 720, 340, 64),
			dock: r(372, 720, 448, 64),
			find: null,
			player: r(16, 634, 560, 70),
			line: null,
			card: null,
			inset: 84,
			rows: [370, 470],
		},
		{
			vp: [390, 844],
			tuner: r(16, 16, 358, 56),
			receiver: r(16, 80, 300, 56),
			listen: r(16, 764, 302, 64),
			dock: null,
			find: r(326, 780, 48, 48),
			player: r(16, 678, 358, 70),
			line: null,
			card: null,
			inset: 148,
			rows: [426, 526],
		},
	]
	for (const t of table) {
		const [W, H] = t.vp
		it(`${W}x${H}: frame, player and card home in every drawer state`, () => {
			for (const d of STATES) {
				const L = computeLayout(input(W, H, { drawer: d }))
				expect(L.tuner, d).toEqual(t.tuner)
				expect(L.receiver, d).toEqual(t.receiver)
				expect(L.listen, d).toEqual(t.listen)
				expect(box(L.dock), d).toEqual(t.dock)
				expect(L.find, d).toEqual(t.find)
				expect(box(L.player), d).toEqual(t.player)
				expect(L.player?.form, d).toBe("full")
				expect(L.plot.insetTop, d).toBe(t.inset)
				// the card hides under covering surfaces only; elsewhere its home stays
				if (d !== "expanded") expect(box(L.card), d).toEqual(t.card)
				const lined = computeLayout(input(W, H, { drawer: d, minimised: true }))
				if (d !== "expanded") expect(box(lined.card), d).toEqual(t.line)
				expect(
					layoutViolations(namedRects(L), L.viewport),
					`${W}x${H} ${d}`,
				).toEqual([])
			}
		})
		it(`${W}x${H}: the scale rows end above the stack`, () => {
			const L = computeLayout(input(W, H))
			const p = plotLayout(H - L.plot.insetTop, 20 + 26, L.plot.rowsMaxCss)
			const top = L.plot.insetTop + p.traceCss
			expect([top, top + p.gapCss]).toEqual(t.rows)
			expect(top + p.gapCss).toBeLessThanOrEqual(L.plot.rowsBottomMax)
		})
	}

	it("the default card home moves by the player's height and a gutter when the player leaves (stated move)", () => {
		const a = computeLayout(input(1440, 900))
		const b = computeLayout(input(1440, 900, { player: false }))
		expect((b.card?.y ?? 0) - (a.card?.y ?? 0)).toBe(70 + 16)
		expect(b.player).toBeNull()
	})

	it("an expanded card with no room above the stack shows its line on the same anchor", () => {
		// 1440 x 640: the player at 474, so the expanded card would start at 474 − 16 − 440 = 18, above 72 + 16
		const L = computeLayout(input(1440, 640))
		expect(L.card).toMatchObject({
			anchor: "al",
			form: "line",
			y: 474 - 16 - 52,
		})
		// 1 px taller per px of window: from 1440 x 710 the expanded card fits (y 88)
		expect(computeLayout(input(1440, 710)).card).toMatchObject({
			form: "expanded",
			y: 88,
		})
		expect(computeLayout(input(1440, 709)).card?.form).toBe("line")
	})

	it("a card parked on a right anchor steps left of a drawer column and returns", () => {
		const free = computeLayout(input(1440, 900, { anchor: "tr" }))
		expect(free.card).toMatchObject({ anchor: "tr", x: 1440 - 16 - 340 })
		const open = computeLayout(
			input(1440, 900, { anchor: "tr", drawer: "recordings" }),
		)
		expect(open.card).toMatchObject({ anchor: "tr", x: 1004 - 16 - 340 })
	})

	it("hides the dock below 761 px, and wherever Listen and the compact dock cannot share the rail", () => {
		// 16 + 340 + 16 + 448 + 16 = 836: from there the compact dock fits beside Listen
		expect(computeLayout(input(836, 800)).dock).toMatchObject({
			x: 372,
			w: 448,
		})
		expect(computeLayout(input(835, 800)).dock).toBeNull()
		expect(computeLayout(input(835, 800)).find).toEqual(
			r(835 - 64, 800 - 64, 48, 48),
		)
		const narrowListen = { ...input(761, 800), listen: { w: 260, h: 64 } }
		expect(computeLayout(narrowListen).dock).not.toBeNull()
		expect(
			computeLayout({ ...narrowListen, viewport: { w: 760, h: 800 } }).dock,
		).toBeNull()
	})

	it("compacts the dock below 1180 px", () => {
		expect(computeLayout(input(1180, 800)).dock?.compact).toBe(false)
		expect(computeLayout(input(1179, 800)).dock?.compact).toBe(true)
	})

	it("hides the card at 1100 px and below, shows it from 1101", () => {
		expect(computeLayout(input(1100, 800)).card).toBeNull()
		expect(computeLayout(input(1101, 800)).card).not.toBeNull()
	})
})

describe("computeLayout: stage surfaces (player present: covering surfaces stand on the stack)", () => {
	const cases: [number, number, DrawerState, Rect, string][] = [
		[1440, 900, "activity", r(1004, 88, 420, 796), "edge"],
		[1440, 900, "recordings", r(1004, 88, 420, 796), "edge"],
		[1440, 900, "scanner", r(1004, 88, 420, 796), "edge"],
		[1280, 800, "activity", r(844, 88, 420, 616), "rail"],
		[1100, 800, "activity", r(664, 88, 420, 616), "rail"],
		[390, 844, "activity", r(16, 152, 358, 510), "stack"],
		[1440, 900, "settings", r(864, 88, 560, 716), "rail"],
		[1280, 800, "settings", r(704, 88, 560, 616), "rail"],
		[1100, 800, "settings", r(592, 88, 492, 616), "rail"],
		[390, 844, "settings", r(16, 152, 358, 510), "stack"],
		[1440, 900, "expanded", r(16, 88, 1408, 630), "stack"],
		[1280, 800, "expanded", r(16, 88, 1248, 530), "stack"],
		[1100, 800, "expanded", r(16, 88, 1068, 530), "stack"],
		[390, 844, "expanded", r(16, 152, 358, 510), "stack"],
	]
	for (const [W, H, d, want, foot] of cases)
		it(`${W}x${H} ${d}: ${want.x},${want.y} ${want.w}x${want.h}, foot ${foot}`, () => {
			const L = computeLayout(input(W, H, { drawer: d }))
			expect(box(L.drawer)).toEqual(want)
			expect(L.drawer?.foot).toBe(foot)
		})

	it("the phone sheet without the player reaches down to Listen", () => {
		const L = computeLayout(
			input(390, 844, { drawer: "activity", player: false }),
		)
		expect(box(L.drawer)).toEqual(r(16, 152, 358, 596))
		expect(L.drawer?.shape).toBe("sheet")
	})

	it("the column's foot reaches the window edge exactly when it clears the dock by a gutter", () => {
		// 1440: dock ends 966, so the drawer's left edge must be at or right of 982: 420 wide clears it,
		// 438 (x 986) clears it, 443 (x 981) does not
		const w = (wantedW: number) =>
			computeLayout({
				...input(1440, 900),
				drawer: { ...(drawerOf("activity") as DrawerInput), wantedW },
			}).drawer
		expect(w(442)?.foot).toBe("edge")
		expect(w(443)?.foot).toBe("rail")
	})

	it("caps the column by the player storey and 640 px, and keeps it at least 360", () => {
		const at = (W: number, wantedW: number) =>
			computeLayout({
				...input(W, 800),
				drawer: { ...(drawerOf("settings") as DrawerInput), wantedW },
			}).drawer
		// 1100 − 16 − (16 + 560 + 16) = 492
		expect(at(1100, 640)).toMatchObject({ w: 492, maxW: 492 })
		// 1248 − 608 = 640: from there 640 is the cap
		expect(at(1248, 640)).toMatchObject({ w: 640, maxW: 640 })
		expect(at(1600, 700)).toMatchObject({ w: 640, maxW: 640 })
		expect(at(1440, 200)).toMatchObject({ w: 360 })
	})

	it("attaches a pane left of the column when it has the player storey's width, else pushes it in", () => {
		const withPane = (W: number) =>
			computeLayout({
				...input(W, 900),
				drawer: {
					...(drawerOf("scanner") as DrawerInput),
					pane: { want: true, pushIn: true },
				},
			})
		const L = withPane(1440)
		expect(L.pane).toEqual(r(16, 88, 1004 + 1 - 16, 734 - 16 - 88))
		expect(L.drawer?.foot).toBe("rail")
		expect(L.card).toBeNull()
		expect(PANE_MIN_W).toBe(560)
		const narrow = computeLayout({
			...input(1440, 900),
			drawer: {
				...(drawerOf("scanner") as DrawerInput),
				wantedW: 640,
				pane: { want: true, pushIn: true },
			},
		})
		// 1440 − 16 − 640 = 784: room 769 ≥ 560
		expect(narrow.pane).not.toBeNull()
		const sheet = withPane(1000)
		expect(sheet.pane).toBeNull()
		expect(sheet.drawer?.pushed).toBe(true)
	})
})

describe("computeLayout: status slot", () => {
	const place = (L: Layout) =>
		L.status.items.map(i => [i.id, box(i), i.form, i.lines])

	it("1440 x 900: a condition alone, full, against the Receiver; with a receipt it goes compact", () => {
		let L = computeLayout(input(1440, 900, { status: [CONDITION] }))
		expect(L.status.where).toBe("rail")
		expect(L.status.slot).toEqual(r(472, 16, 636, 56))
		expect(place(L)).toEqual([["condition", r(677, 22, 431, 44), "full", 1]])
		L = computeLayout(input(1440, 900, { status: [CONDITION, RECEIPT] }))
		expect(place(L)).toEqual([
			["receipt", r(472, 22, 220, 44), "full", 1],
			["condition", r(940, 22, 168, 44), "compact", 1],
		])
	})

	it("1280 x 800: full alone, compact with a receipt", () => {
		expect(
			place(computeLayout(input(1280, 800, { status: [CONDITION] }))),
		).toEqual([["condition", r(517, 22, 431, 44), "full", 1]])
		expect(
			place(computeLayout(input(1280, 800, { status: [CONDITION, RECEIPT] }))),
		).toEqual([
			["receipt", r(472, 22, 220, 44), "full", 1],
			["condition", r(780, 22, 168, 44), "compact", 1],
		])
	})

	it("1100 x 800: alone it wraps to two lines at the slot's width; with a receipt it is an icon", () => {
		expect(
			place(computeLayout(input(1100, 800, { status: [CONDITION] }))),
		).toEqual([["condition", r(472, 18, 296, TWO_LINE_H), "full", 2]])
		expect(
			place(computeLayout(input(1100, 800, { status: [CONDITION, RECEIPT] }))),
		).toEqual([
			["receipt", r(472, 22, 220, 44), "full", 1],
			["condition", r(724, 22, 44, 44), "icon", 1],
		])
	})

	it("390 x 844: the strip under the stacked Receiver; with a sheet open, the sheet's notice slot", () => {
		let L = computeLayout(input(390, 844, { status: [CONDITION] }))
		expect(L.status.where).toBe("strip")
		expect(L.status.strip).toEqual(r(16, 144, 358, TWO_LINE_H))
		L = computeLayout(input(390, 844, { status: [CONDITION, RECEIPT] }))
		expect(L.status.strip).toEqual(r(16, 144, 358, TWO_LINE_H + 8 + 44))
		expect(place(L)).toEqual([
			["condition", r(16, 144, 358, TWO_LINE_H), "full", 2],
			["receipt", r(16, 204, 358, 44), "full", 1],
		])
		L = computeLayout(
			input(390, 844, { status: [CONDITION, RECEIPT], drawer: "recordings" }),
		)
		expect(L.status.where).toBe("drawer-slot")
		expect(L.status.docked).toEqual(["condition", "receipt"])
		expect(L.status.items).toEqual([])
	})

	it("the slot is a rail from 200 px; narrower it is the strip", () => {
		// slot = W − 16 − 300 − 16 − 472: 200 at W 1004
		const at = (W: number) =>
			computeLayout(input(W, 800, { status: [RECEIPT] })).status.where
		expect(STATUS_MIN_W).toBe(200)
		expect(at(1004)).toBe("rail")
		expect(at(1003)).toBe("strip")
	})

	it("a lone item wraps only while half its width and its controls fit", () => {
		// 296 px slot: 431 / 2 + 64 = 279.5 fits; a 466 px item (297) does not, so it goes compact
		expect(TWO_LINE_PAD).toBe(64)
		const wide = {
			...CONDITION,
			forms: { ...CONDITION.forms, full: { w: 464, h: 44 } },
		}
		expect(
			place(computeLayout(input(1100, 800, { status: [wide] })))[0]?.[2],
		).toBe("full")
		const wider = {
			...CONDITION,
			forms: { ...CONDITION.forms, full: { w: 466, h: 44 } },
		}
		expect(
			place(computeLayout(input(1100, 800, { status: [wider] })))[0]?.[2],
		).toBe("compact")
	})

	it("an item the slot cannot hold degrades to the strip under the top rail before it waits", () => {
		const chip: StatusItem = {
			id: "connection",
			kind: "connection",
			forms: { full: { w: 300, h: 36 }, compact: { w: 200, h: 36 } },
		}
		const L = computeLayout(
			input(1100, 800, { status: [CONDITION, chip, RECEIPT] }),
		)
		expect(L.status.where).toBe("strip")
		expect(L.status.waiting).toEqual([])
		expect(L.status.items.map(i => i.id)).toEqual([
			"condition",
			"connection",
			"receipt",
		])
		// the strip: 16 px in, 8 under the top rail, as wide as the window less both gutters
		expect(L.status.strip).toMatchObject({ x: 16, y: 80, w: 1068 })
		expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
	})

	it("the lowest-ranked state item waits in the slot when the strip would show no more", () => {
		const chip: StatusItem = {
			id: "connection",
			kind: "connection",
			forms: { full: { w: 300, h: 36 }, compact: { w: 200, h: 36 } },
		}
		// an attached pane covers the strip and the drawer has no notice slot: every strip item would wait
		const base = input(1100, 800, { status: [CONDITION, chip, RECEIPT] })
		const L = computeLayout({
			...base,
			drawer: {
				id: "activity",
				wantedW: 420,
				expanded: false,
				pane: { want: true, pushIn: false },
				hasNoticeSlot: false,
			},
		})
		expect(L.pane).not.toBeNull()
		expect(L.status.where).toBe("rail")
		expect(L.status.waiting).toEqual(["connection"])
		expect(L.status.items.map(i => i.id)).toEqual(["receipt", "condition"])
	})

	it("with the scan hold row the slot starts at 504 and the plot at 132", () => {
		const L = computeLayout(
			input(1440, 900, { tunerW: 472, tunerH: 104, drawer: "expanded" }),
		)
		expect(L.status.slot?.x).toBe(504)
		expect(L.plot.insetTop).toBe(132)
		expect(L.drawer?.y).toBe(136)
		expect(
			computeLayout(
				input(1440, 900, { tunerW: 472, tunerH: 104, drawer: "activity" }),
			).drawer?.y,
		).toBe(88)
	})
})

describe("computeLayout: plot contract", () => {
	it("hands the plot every chrome rect over its body, in body coordinates", () => {
		const L = computeLayout(input(390, 844, { status: [CONDITION] }))
		// the strip at y 144 is 4 px above the body (148): it starts at −4 in body px
		expect(L.plot.exclusions).toContainEqual(r(16, -4, 358, TWO_LINE_H))
		const wide = computeLayout(input(1440, 900, { drawer: "recordings" }))
		expect(wide.plot.exclusions).toContainEqual(r(1004, 4, 420, 796))
		expect(wide.plot.noteCx).toBe(502)
		expect(wide.plot.visible).toEqual(r(0, 84, 1004, 816))
		expect(computeLayout(input(1440, 900)).plot.noteCx).toBe(720)
	})
})

describe("computeLayout: the stack stands on the bottom rail", () => {
	it("a Listen shorter than the dock: the player and covering surfaces keep a gutter from the dock", () => {
		for (const d of ["none", "expanded"] as const) {
			const base = input(1440, 900, { drawer: d })
			const L = computeLayout({ ...base, listen: { w: 340, h: 52 } })
			const dock = L.dock
			expect(dock).not.toBeNull()
			if (!dock || !L.player) throw new Error("dock and player expected")
			// the rail's top is the dock's (64 px tall), not Listen's (52)
			expect(L.player.y + L.player.h).toBe(dock.y - 16)
			if (L.drawer) expect(L.drawer.y + L.drawer.h).toBe(L.player.y - 16)
			expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
		}
	})

	it("without the player a covering surface stands 16 px above the rail's top", () => {
		const base = input(1000, 800, { drawer: "activity", player: false })
		const L = computeLayout({ ...base, listen: { w: 340, h: 52 } })
		const dock = L.dock
		if (!dock || !L.drawer) throw new Error("dock and drawer expected")
		expect(L.drawer.y + L.drawer.h).toBe(dock.y - 16)
		expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
	})
})

describe("computeLayout: status items taller than the row", () => {
	const tall = (h: number): StatusItem => ({
		id: "paused",
		kind: "paused",
		forms: { full: { w: 240, h } },
	})
	for (const h of [STATUS_ROW_H, STATUS_ROW_H + 1, 72]) {
		it(`a ${h} px item stays in the row and inside the window's margin`, () => {
			const L = computeLayout(input(1440, 900, { status: [tall(h), RECEIPT] }))
			expect(L.status.where).toBe("rail")
			const item = L.status.items.find(i => i.id === "paused")
			if (!item) throw new Error("paused item expected")
			expect(item.y).toBeGreaterThanOrEqual(16)
			expect(item.h).toBe(Math.min(h, STATUS_ROW_H))
			expect(item.y + item.h).toBeLessThanOrEqual(16 + STATUS_ROW_H)
			expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
		})
	}
})

describe("stablePlot", () => {
	it("keeps the previous plot part while its contents hold, and takes a changed one", () => {
		const a = computeLayout(input(1440, 900, { drawer: "activity" })).plot
		const same = computeLayout(input(1440, 900, { drawer: "activity" })).plot
		expect(same).not.toBe(a)
		expect(stablePlot(a, same)).toBe(a)
		expect(stablePlot(null, same)).toBe(same)
		// a grip move that changes the column's width changes the exclusions
		const wider = computeLayout({
			...input(1440, 900, { drawer: "activity" }),
			drawer: {
				id: "activity",
				wantedW: 500,
				expanded: false,
				pane: null,
				hasNoticeSlot: true,
			},
		}).plot
		expect(stablePlot(a, wider)).toBe(wider)
		// a rail notice sits above the plot body: the plot's part is unchanged by it
		const withItem = computeLayout(
			input(1440, 900, { drawer: "activity", status: [CONDITION] }),
		).plot
		expect(stablePlot(a, withItem)).toBe(a)
	})
})

describe("computeLayout: a strip beside a drawer column", () => {
	// a wide Receiver leaves a slot under 200 px on a 1100 px window: the strip, with a column open
	const narrowSlot = (d: DrawerState, pane = false): LayoutInput => {
		const base = input(1100, 800, { drawer: d, status: [RECEIPT] })
		return {
			...base,
			receiver: { w: 400, h: 56 },
			drawer: base.drawer
				? { ...base.drawer, pane: pane ? { want: true, pushIn: false } : null }
				: null,
		}
	}

	it("stops a gutter left of the column", () => {
		const L = computeLayout(narrowSlot("recordings"))
		expect(L.status.where).toBe("strip")
		const strip = L.status.strip
		if (!strip || !L.drawer) throw new Error("strip and drawer expected")
		expect(L.drawer.shape).toBe("column")
		expect(strip.x + strip.w).toBe(L.drawer.x - 16)
		expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
	})

	it("docks in the drawer's notice slot when an attached pane covers the strip", () => {
		const wide: LayoutInput = {
			...narrowSlot("activity", true),
			viewport: { w: 1440, h: 900 },
			receiver: { w: 740, h: 56 },
		}
		const L = computeLayout(wide)
		expect(L.pane).not.toBeNull()
		expect(L.status.where).toBe("drawer-slot")
		expect(L.status.docked).toEqual(["receipt"])
		expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
	})
})
