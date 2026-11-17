import { describe, expect, it } from "vitest"

import {
	freeSpans,
	regionPlacement,
	type Box,
	type ExpandedDrawer,
	type PlacementInput,
} from "../../src/shell/notices/top-centre.ts"

const box = (left: number, top: number, w: number, h: number): Box => ({
	left,
	top,
	right: left + w,
	bottom: top + h,
})

// default islands (layout.ts DEFAULT_GEOMETRY): Tuner 440×56, Receiver 300×56, gutter 16, top row bottom 72
const tuner = box(16, 16, 440, 56)

/** An expanded Activity drawer between the rows, with its header controls (title, Live, ✕) at the ends. */
const expanded = (
	W: number,
	topRow: readonly Box[],
	drawerTop: number,
): ExpandedDrawer => ({
	drawer: box(16, drawerTop, W - 32, 600),
	topRow,
	header: box(16, drawerTop, W - 32, 58),
	headerControls: [
		box(34, drawerTop + 14, 96, 32),
		box(140, drawerTop + 16, 70, 28),
		box(W - 16 - 42, drawerTop + 14, 32, 32),
	],
})

const cases: {
	name: string
	input: PlacementInput
	want: { where: string; cx: number; maxW: number; top: number }
}[] = [
	{
		name: "no drawer, 1440: the window's top centre, under the top row",
		input: {
			W: 1440,
			topRowBottom: 72,
			freeCx: 720,
			boxes: [],
			expanded: null,
		},
		want: { where: "free-plot", cx: 720, maxW: 560, top: 80 },
	},
	{
		name: "full-height drawer open, 1440: the free plot's centre left of it",
		input: {
			W: 1440,
			topRowBottom: 72,
			freeCx: 502,
			boxes: [],
			expanded: null,
		},
		want: { where: "free-plot", cx: 502, maxW: 560, top: 80 },
	},
	{
		// the Receiver stays where a full-height drawer leaves it (688..988): the gap right of it (1004..1424) is
		// the widest, wider than the 200 px between the Tuner and the Receiver
		name: "expanded Activity, 1440: the top row's gap right of the Receiver",
		input: {
			W: 1440,
			topRowBottom: 72,
			freeCx: 502,
			boxes: [],
			expanded: expanded(1440, [tuner, box(688, 16, 300, 56)], 88),
		},
		want: { where: "top-row", cx: 1214, maxW: 420, top: 16 },
	},
	{
		name: "expanded Activity, 1920: between the Tuner and the Receiver",
		input: {
			W: 1920,
			topRowBottom: 72,
			freeCx: 742,
			boxes: [],
			expanded: expanded(1920, [tuner, box(1168, 16, 300, 56)], 88),
		},
		want: { where: "top-row", cx: 812, maxW: 560, top: 16 },
	},
	{
		name: "expanded Activity, 1920, connection chip in the gap: under the chip",
		input: {
			W: 1920,
			topRowBottom: 72,
			freeCx: 742,
			boxes: [box(700, 16, 200, 36)],
			expanded: expanded(1920, [tuner, box(1168, 16, 300, 56)], 88),
		},
		want: { where: "top-row", cx: 812, maxW: 560, top: 60 },
	},
	{
		// a between-rows drawer (no full height below 1188 px): the Tuner–Receiver gap is 296 px, so the header's
		// empty middle, a gutter clear of Live and ✕
		name: "expanded Activity, 1100: the drawer header's empty middle",
		input: {
			W: 1100,
			topRowBottom: 72,
			freeCx: 550,
			boxes: [],
			expanded: expanded(1100, [tuner, box(784, 16, 300, 56)], 88),
		},
		want: { where: "drawer-head", cx: 626, maxW: 560, top: 95 },
	},
	{
		name: "expanded Activity, 1100, a measured 54 px toast: centred on the header",
		input: {
			W: 1100,
			topRowBottom: 72,
			freeCx: 550,
			boxes: [],
			expanded: expanded(1100, [tuner, box(784, 16, 300, 56)], 88),
			height: 54,
		},
		want: { where: "drawer-head", cx: 626, maxW: 560, top: 90 },
	},
	{
		// phone: Tuner and Receiver stacked, header full of controls; no room anywhere, so the normal place
		name: "expanded Activity, 390 (narrow): no room, the normal place",
		input: {
			W: 390,
			topRowBottom: 136,
			freeCx: 195,
			boxes: [],
			expanded: expanded(
				390,
				[box(16, 16, 358, 56), box(16, 80, 358, 56)],
				152,
			),
		},
		want: { where: "free-plot", cx: 195, maxW: 358, top: 144 },
	},
	{
		name: "narrow, no drawer: the normal place",
		input: {
			W: 390,
			topRowBottom: 136,
			freeCx: 195,
			boxes: [],
			expanded: null,
		},
		want: { where: "free-plot", cx: 195, maxW: 358, top: 144 },
	},
]

describe("the notice region's placement", () => {
	for (const c of cases)
		it(c.name, () => {
			expect(regionPlacement(c.input)).toEqual(c.want)
		})

	it("never lands on a top-row island or a header control while expanded", () => {
		for (const c of cases) {
			const x = c.input.expanded
			if (!x) continue
			const p = regionPlacement(c.input)
			if (p.where === "free-plot") continue
			const left = p.cx - p.maxW / 2
			const right = p.cx + p.maxW / 2
			const top = p.top
			const bottom = p.top + 44
			const hits = (b: Box) =>
				b.left < right && left < b.right && b.top < bottom && top < b.bottom
			expect([...x.topRow, ...x.headerControls].some(hits), c.name).toBe(false)
		}
	})
})

describe("free spans", () => {
	it("cuts each padded box out, widest first", () => {
		expect(freeSpans(0, 100, [box(40, 0, 10, 10)], 5)).toEqual([
			{ left: 55, right: 100 },
			{ left: 0, right: 35 },
		])
		expect(freeSpans(0, 100, [box(-10, 0, 200, 10)], 0)).toEqual([])
	})
})
