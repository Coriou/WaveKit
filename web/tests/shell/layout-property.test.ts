import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { placeLabels, type SignalInfo } from "../../src/plot/maths.ts"
import {
	DISCOVERY_ROW_CSS,
	plotLayout,
	RULER_CSS,
} from "../../src/plot/layout.ts"
import { CARD_ANCHOR_IDS } from "../../src/shell/layout.ts"
import {
	computeLayout,
	layoutViolations,
	namedRects,
	type DrawerInput,
	type LayoutInput,
	type StatusItem,
} from "../../src/shell/layout/compute.ts"
import { intersects, type Rect } from "../../src/shell/layout/geometry.ts"
import type { DrawerId } from "../../src/shell/store.ts"

const size = (w: [number, number], h: [number, number]) =>
	fc.record({
		w: fc.integer({ min: w[0], max: w[1] }),
		h: fc.integer({ min: h[0], max: h[1] }),
	})

const statusItems: fc.Arbitrary<StatusItem[]> = fc
	.record({
		condition: fc.option(fc.integer({ min: 120, max: 560 }), { nil: null }),
		connection: fc.option(fc.integer({ min: 160, max: 360 }), { nil: null }),
		paused: fc.option(fc.integer({ min: 200, max: 300 }), { nil: null }),
		receipt: fc.option(fc.integer({ min: 100, max: 400 }), { nil: null }),
	})
	.map(o => {
		const out: StatusItem[] = []
		if (o.condition !== null)
			out.push({
				id: "condition",
				kind: "condition",
				forms: {
					full: { w: o.condition, h: 44 },
					compact: { w: 168, h: 44 },
					icon: { w: 44, h: 44 },
				},
			})
		if (o.connection !== null)
			out.push({
				id: "connection",
				kind: "connection",
				forms: {
					full: { w: o.connection, h: 36 },
					compact: { w: Math.round(o.connection * 0.6), h: 36 },
				},
			})
		if (o.paused !== null)
			out.push({
				id: "paused",
				kind: "paused",
				forms: { full: { w: o.paused, h: 52 } },
			})
		if (o.receipt !== null)
			out.push({
				id: "receipt",
				kind: "receipt",
				forms: { full: { w: o.receipt, h: 44 } },
			})
		return out
	})

const DRAWERS = [
	"none",
	"activity",
	"recordings",
	"scanner",
	"settings",
	"expanded",
] as const

const drawer: fc.Arbitrary<DrawerInput | null> = fc
	.record({
		state: fc.constantFrom(...DRAWERS),
		wantedW: fc.integer({ min: 360, max: 640 }),
		pane: fc.option(fc.record({ want: fc.boolean(), pushIn: fc.boolean() }), {
			nil: null,
		}),
	})
	.map(d =>
		d.state === "none"
			? null
			: {
					id: (d.state === "expanded" ? "activity" : d.state) as DrawerId,
					wantedW: d.wantedW,
					expanded: d.state === "expanded",
					pane: d.pane,
					hasNoticeSlot: true,
				},
	)

const layoutInput: fc.Arbitrary<LayoutInput> = fc.record({
	viewport: size([320, 2560], [560, 1600]),
	tuner: fc.constantFrom({ w: 440, h: 56 }, { w: 472, h: 104 }),
	receiver: size([260, 320], [56, 56]),
	listen: size([300, 420], [64, 64]),
	dock: fc.record({
		wide: size([460, 520], [64, 64]),
		compact: size([420, 460], [64, 64]),
	}),
	player: fc.option(size([560, 560], [60, 80]), { nil: null }),
	card: fc.option(
		fc.record({
			expanded: size([340, 340], [200, 500]),
			line: size([340, 340], [52, 52]),
			minimised: fc.boolean(),
			anchor: fc.constantFrom(...CARD_ANCHOR_IDS),
		}),
		{ nil: null },
	),
	status: statusItems,
	drawer,
	panels: fc.constant([]),
})

const signals: fc.Arbitrary<SignalInfo[]> = fc.array(
	fc.record({
		hz: fc.integer({ min: 100_000_000, max: 102_000_000 }),
		widthHz: fc.integer({ min: 5_000, max: 200_000 }),
		label: fc.constantFrom(
			"FM voice",
			"DMR?",
			"Unidentified · 12.5 kHz",
			"Wide FM",
		),
		sub: fc.option(fc.constant("100.000"), { nil: null }),
		burst: fc.constant(false),
		known: fc.boolean(),
		peakDb: fc.constant(null),
	}),
	{ maxLength: 24 },
)

describe("computeLayout properties", () => {
	it("no two islands intersect and every one is inside the window's margin", () => {
		// Feature: web-layout, Property 1: no island intersects another or leaves the free area
		// Validates: I1, I2
		fc.assert(
			fc.property(layoutInput, input => {
				const L = computeLayout(input)
				expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
			}),
			{ numRuns: 300 },
		)
	})

	it("the frame, the dock, the player and the default card home are the same with and without a drawer", () => {
		// Feature: web-layout, Property 1: frame islands and the dock never move for a drawer
		// Validates: I3, I8
		fc.assert(
			fc.property(layoutInput, drawer, (input, other) => {
				const a = computeLayout({ ...input, drawer: null })
				const b = computeLayout({ ...input, drawer: other })
				expect(b.tuner).toEqual(a.tuner)
				expect(b.receiver).toEqual(a.receiver)
				expect(b.listen).toEqual(a.listen)
				expect(b.dock).toEqual(a.dock)
				expect(b.find).toEqual(a.find)
				expect(b.player).toEqual(a.player)
				expect(b.plot.insetTop).toBe(a.plot.insetTop)
				if (
					a.card?.anchor === "al" &&
					b.card !== null &&
					input.card?.anchor === "al"
				)
					expect(b.card).toEqual(a.card)
			}),
			{ numRuns: 200 },
		)
	})

	it("no signal chip lands on chrome, and no rail guest on the plot's rows", () => {
		// Feature: web-layout, Property 1: no island over the plot's labels
		// Validates: I4, I5, I6
		fc.assert(
			fc.property(layoutInput, signals, (input, sigs) => {
				const L = computeLayout(input)
				const p = L.plot
				const H = L.viewport.h
				const trace = plotLayout(
					H - p.insetTop,
					DISCOVERY_ROW_CSS + RULER_CSS,
					p.rowsMaxCss,
				)
				// I6: the scale rows end above the stack, the body starts under the top rail
				expect(p.insetTop + trace.traceCss + trace.gapCss).toBeLessThanOrEqual(
					p.rowsBottomMax,
				)
				expect(p.insetTop).toBeGreaterThanOrEqual(
					Math.max(L.tuner.y + L.tuner.h, L.receiver.y + L.receiver.h) + 12,
				)
				// rail guests: the rail's items above the body; the player below the rows
				if (L.status.where === "rail")
					for (const i of L.status.items)
						expect(i.y + i.h).toBeLessThanOrEqual(p.insetTop)
				if (L.player)
					expect(L.player.y).toBeGreaterThanOrEqual(
						p.insetTop + trace.traceCss + trace.gapCss,
					)
				// a strip stays on the trace band, where the chips flow around it
				if (L.status.strip)
					expect(L.status.strip.y + L.status.strip.h).toBeLessThanOrEqual(
						p.insetTop + trace.traceCss,
					)
				const placed = placeLabels(
					sigs,
					{ startHz: 100_000_000, endHz: 102_000_000 },
					{
						widthPx: L.viewport.w,
						traceCss: trace.traceCss,
						tunedHz: null,
						taken: p.exclusions.map(r => [r.x, r.y, r.x + r.w, r.y + r.h]),
					},
				)
				const chrome: Rect[] = namedRects(L)
				if (L.status.strip) chrome.push(L.status.strip)
				for (const c of placed) {
					const w =
						40 + c.label.length * 7.4 + (c.sub ? 6 + c.sub.length * 6.6 : 0)
					const chip = { x: c.x - w / 2, y: p.insetTop + c.top, w, h: 28 }
					for (const r of chrome) expect(intersects(chip, r)).toBe(false)
				}
			}),
			{ numRuns: 200 },
		)
	})
})
