// Rule P (LY rules §2): Listen's open width and an open panel's room are layout inputs. The dock reserves the width
// Listen takes while its panel is open, so nothing moves when it opens and the open head never covers the dock; a
// status item within PANEL_GAP of an open panel's room yields (out of sight in place, inert, its timer paused), and
// the notice region reads one predicate of the layout for render, inert, focus and the timer.
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { clampDrag } from "../../src/shell/card-place.ts"
import { CARD_ANCHOR_IDS } from "../../src/shell/layout.ts"
import {
	cardObstacles,
	computeLayout,
	DEFAULT_SIZES,
	LISTEN_OPEN_W,
	layoutViolations,
	namedRects,
	PANEL_GAP,
	statusSeen,
	statusState,
	type DrawerInput,
	type LayoutInput,
	type StatusItem,
} from "../../src/shell/layout/compute.ts"
import {
	intersects,
	right,
	separation,
	type Rect,
} from "../../src/shell/layout/geometry.ts"
import type { IslandId } from "../../src/shell/store.ts"

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
const box = (l: Rect | null): Rect | null =>
	l === null ? null : r(l.x, l.y, l.w, l.h)

const RECEIPT: StatusItem = {
	id: "receipt",
	kind: "receipt",
	forms: { full: { w: 220, h: 44 } },
}

function input(
	W: number,
	H: number,
	o: {
		open?: IslandId | null
		panel?: { w: number; h: number } | null
		status?: StatusItem[]
		drawer?: DrawerInput | null
		card?: boolean
	} = {},
): LayoutInput {
	const open = o.open ?? null
	return {
		viewport: { w: W, h: H },
		tuner: { w: 440, h: 56 },
		receiver: { w: 300, h: 56 },
		listen: { w: 340, h: 64 },
		dock: DEFAULT_SIZES.dock,
		player: { w: 560, h: 70 },
		card:
			o.card === false
				? null
				: {
						expanded: { w: 340, h: 300 },
						line: { w: 340, h: 52 },
						minimised: false,
						anchor: "al",
					},
		status: o.status ?? [],
		drawer: o.drawer ?? null,
		panels: open && o.panel ? [{ island: open, size: o.panel }] : [],
		openPanel: open,
	}
}

/** Listen's panel open at its real width (the board's 420, or what the layout reserves for it). */
const listenOpen = (
	W: number,
	H: number,
	extra: Parameters<typeof input>[2] = {},
) => {
	const closed = computeLayout(input(W, H, extra))
	return computeLayout(
		input(W, H, {
			...extra,
			open: "listen",
			panel: { w: closed.listenOpen.w, h: 320 },
		}),
	)
}

describe("Rule P: the dock reserves Listen's open width (LY rules §2.2)", () => {
	it("Listen opens to the board's 420 px", () => {
		expect(LISTEN_OPEN_W).toBe(420)
	})

	// W, H, dock x, dock w, reserved (open) Listen width, gap open Listen → dock
	const table: [number, number, number, number, number, number][] = [
		// round((1440 − 492) / 2) = 474 ≥ 16 + 420 + 16 = 452: centred; gap 474 − 436 = 38
		[1440, 900, 474, 492, 420, 38],
		// round((1280 − 492) / 2) = 394 < 452: at the bound; gap 452 − 436 = 16
		[1280, 800, 452, 492, 420, 16],
		// compact: round((1100 − 448) / 2) = 326 < 452: at the bound
		[1100, 800, 452, 448, 420, 16],
		// reserve squeezed: min(420, 900 − 48 − 448 = 404); dock 16 + 404 + 16 = 436 = 900 − 16 − 448
		[900, 800, 436, 448, 404, 16],
	]
	for (const [W, H, x, w, reserve, gap] of table)
		it(`${W}x${H}: dock ${x} (${w} wide), Listen open ${reserve}, ${gap} px apart, closed or open`, () => {
			const closed = computeLayout(input(W, H))
			const open = listenOpen(W, H)
			for (const L of [closed, open]) {
				expect(L.dock).toMatchObject({ x, y: H - 16 - 64, w, h: 64 })
				expect(L.listenOpen).toEqual(r(16, H - 16 - 64, reserve, 64))
				// the closed head is the frame's: opening Listen never moves the stack
				expect(L.listen).toEqual(r(16, H - 16 - 64, 340, 64))
			}
			expect(L0dockGap(open)).toBe(gap)
			expect(box(open.dock)).toEqual(box(closed.dock))
			expect(open.player).toEqual(closed.player)
			expect(open.tuner).toEqual(closed.tuner)
			expect(open.receiver).toEqual(closed.receiver)
			expect(layoutViolations(namedRects(open), open.viewport)).toEqual([])
		})

	it("390x844 (phone): the open head keeps to the search button, min(420, 390 − 32 − 48 − 8) = 302", () => {
		const L = listenOpen(390, 844)
		expect(L.dock).toBeNull()
		expect(L.find).toEqual(r(326, 780, 48, 48))
		expect(L.listenOpen).toEqual(r(16, 764, 302, 64))
		// find − right(open Listen) = 326 − 318 = 8 (the rail neighbours' gap)
		expect((L.find?.x ?? 0) - right(L.listenOpen)).toBe(8)
		expect(layoutViolations(namedRects(L), L.viewport)).toEqual([])
	})

	const dockX = (W: number) => computeLayout(input(W, 800)).dock?.x ?? null
	const reserveW = (W: number) => computeLayout(input(W, 800)).listenOpen.w

	it("the dock hides at 835 (closed width: 16 + 340 + 16 + 448 + 16 = 836), the reserve squeezes from 836", () => {
		expect(dockX(835)).toBeNull()
		// 836: reserve = 836 − 48 − 448 = 340 (the closed width); the dock ends at the margin, 372 + 448 = 820
		expect(dockX(836)).toBe(372)
		expect(reserveW(836)).toBe(340)
		expect(right(computeLayout(input(836, 800)).dock as Rect)).toBe(836 - 16)
	})

	it("the reserve is W − 496 up to 915 and the board's 420 from 916", () => {
		expect(reserveW(915)).toBe(419)
		expect(dockX(915)).toBe(451)
		expect(reserveW(916)).toBe(420)
		expect(dockX(916)).toBe(452)
		expect(reserveW(917)).toBe(420)
		expect(dockX(917)).toBe(452)
	})

	it("the compact dock (below 1180) is never centred; the wide one centres from 1395 (round(903/2) = 452)", () => {
		expect(dockX(1100)).toBe(452)
		expect(dockX(1101)).toBe(452)
		expect(dockX(1179)).toBe(452)
		expect(computeLayout(input(1179, 800)).dock?.compact).toBe(true)
		expect(dockX(1180)).toBe(452)
		// round((1394 − 492) / 2) = 451 < 452: clamped
		expect(dockX(1394)).toBe(452)
		expect(dockX(1395)).toBe(452)
		expect(dockX(1396)).toBe(452)
		// round(905 / 2) = 453: centred, past the bound
		expect(dockX(1397)).toBe(453)
	})

	it("the card shows from 1101 and keeps its home when Listen opens (it yields, never moves)", () => {
		expect(computeLayout(input(1100, 800)).card).toBeNull()
		const closed = computeLayout(input(1101, 800))
		const open = listenOpen(1101, 800)
		expect(closed.card).not.toBeNull()
		expect(open.card).toEqual(closed.card)
		expect(open.yielded).toContain("card")
	})

	it("a measured open head wider than the board (421) still keeps a gutter from the dock", () => {
		const L = computeLayout({
			...input(1280, 800, { open: "listen", panel: { w: 421, h: 300 } }),
			listenOpenW: 421,
		})
		expect(L.listenOpen.w).toBe(421)
		expect(L.dock?.x).toBe(453)
		expect(L0dockGap(L)).toBe(16)
	})
})

/** The clear distance between the open Listen head and the dock (or the search button). */
function L0dockGap(L: ReturnType<typeof computeLayout>): number {
	const other = L.dock ?? L.find
	return other ? other.x - right(L.listenOpen) : Infinity
}

describe("Rule P: a status item under an open panel's room yields (LY rules §2.3)", () => {
	it("390x844: the Tuner panel (16,80 358×340) yields the receipt in the strip at 16,144; its timer is unseen", () => {
		const closed = computeLayout(input(390, 844, { status: [RECEIPT] }))
		expect(closed.stacked).toBe(true)
		const item = closed.status.items.find(i => i.id === "receipt")
		expect(item).toMatchObject({ x: 16, y: 144 })
		expect(statusState(closed, "receipt", false)).toBe("shown")
		expect(statusSeen(statusState(closed, "receipt", false))).toBe(true)
		// pending (opened this frame, not measured): the room at its cap height already yields it
		const pending = computeLayout(
			input(390, 844, { status: [RECEIPT], open: "tuner" }),
		)
		// measured
		const open = computeLayout(
			input(390, 844, {
				status: [RECEIPT],
				open: "tuner",
				panel: { w: 358, h: 340 },
			}),
		)
		expect(open.panels[0]?.rect).toEqual(r(16, 80, 358, 340))
		for (const L of [pending, open]) {
			expect(L.yielded).toContain("status:receipt")
			expect(statusState(L, "receipt", false)).toBe("yielded")
			expect(statusSeen(statusState(L, "receipt", false))).toBe(false)
			// in place: it keeps its rectangle (it is back there, with Undo, when the panel closes)
			expect(L.status.items).toEqual(closed.status.items)
			expect(namedRects(L).some(n => n.name === "status:receipt")).toBe(false)
		}
		// closed again: shown
		expect(statusState(closed, "receipt", false)).toBe("shown")
	})

	it("390x844: the Receiver panel (top 144 = the strip's top) yields the strip's receipt", () => {
		const L = computeLayout(
			input(390, 844, {
				status: [RECEIPT],
				open: "receiver",
				panel: { w: 300, h: 200 },
			}),
		)
		expect(statusState(L, "receipt", false)).toBe("yielded")
	})

	it("a short Tuner panel that ends PANEL_GAP above the strip item leaves it shown (at and past the bound)", () => {
		// item top 144; the panel's foot at 80 + h; it yields iff 144 − (80 + h) < 8 ⇔ h > 56
		const at = (h: number) =>
			statusState(
				computeLayout(
					input(390, 844, {
						status: [RECEIPT],
						open: "tuner",
						panel: { w: 358, h },
					}),
				),
				"receipt",
				false,
			)
		expect(at(56)).toBe("shown")
		expect(at(57)).toBe("yielded")
	})

	it("1440x900: the rail's items never yield to a panel (its top is 8 under the top rail)", () => {
		for (const open of ["tuner", "receiver", "listen"] as const) {
			const L = computeLayout(
				input(1440, 900, {
					status: [RECEIPT],
					open,
					panel: { w: open === "listen" ? 420 : 300, h: 600 },
				}),
			)
			expect(L.status.where).toBe("rail")
			expect(statusState(L, "receipt", false), open).toBe("shown")
		}
	})

	it("a docked item is seen only while its host is shown and its target exists", () => {
		const sheet: DrawerInput = {
			id: "activity",
			wantedW: 420,
			expanded: false,
			pane: null,
			hasNoticeSlot: true,
		}
		const L = computeLayout(
			input(390, 844, { status: [RECEIPT], drawer: sheet }),
		)
		expect(L.status.docked).toEqual(["receipt"])
		expect(statusState(L, "receipt", true)).toBe("docked")
		expect(statusSeen(statusState(L, "receipt", true))).toBe(true)
		// no portal target yet: it waits
		expect(statusState(L, "receipt", false)).toBe("waiting")
		// the Tuner panel over the sheet's top (its notice slot): the host yields, so the docked item does
		const covered = computeLayout(
			input(390, 844, {
				status: [RECEIPT],
				drawer: sheet,
				open: "tuner",
				panel: { w: 358, h: 340 },
			}),
		)
		expect(covered.status.dockHost).toBe("yielded")
		expect(statusState(covered, "receipt", true)).toBe("yielded")
		expect(statusSeen(statusState(covered, "receipt", true))).toBe(false)
	})

	it("an item held for the card's glide is held (unseen); a missing item is absent", () => {
		const L = computeLayout(input(1440, 900, { status: [RECEIPT] }))
		expect(statusState(L, "condition", false)).toBe("absent")
		const held = { ...L, held: ["status:receipt"] }
		expect(statusState(held, "receipt", false)).toBe("held")
		expect(statusSeen("held")).toBe(false)
		expect(statusSeen("waiting")).toBe(false)
	})
})

// ---- properties

const size = (w: [number, number], h: [number, number]) =>
	fc.record({
		w: fc.integer({ min: w[0], max: w[1] }),
		h: fc.integer({ min: h[0], max: h[1] }),
	})

const statusArb: fc.Arbitrary<StatusItem[]> = fc
	.record({
		receipt: fc.option(size([100, 400], [36, 72]), { nil: null }),
		condition: fc.option(size([120, 560], [36, 72]), { nil: null }),
		// the guests outside the notice region: the connection chip, back to live, the paused label, plot notes
		connection: fc.option(size([120, 420], [32, 48]), { nil: null }),
		backToLive: fc.option(size([100, 240], [32, 48]), { nil: null }),
		paused: fc.option(size([100, 240], [24, 40]), { nil: null }),
		notes: fc.array(size([80, 320], [24, 48]), { maxLength: 2 }),
	})
	.map(o => [
		...(o.condition
			? [
					{
						id: "condition",
						kind: "condition" as const,
						forms: {
							full: o.condition,
							compact: { w: 168, h: o.condition.h },
							icon: { w: 44, h: o.condition.h },
						},
					},
				]
			: []),
		...(o.receipt
			? [
					{
						id: "receipt",
						kind: "receipt" as const,
						forms: { full: o.receipt },
					},
				]
			: []),
		...(o.connection
			? [
					{
						id: "connection",
						kind: "connection" as const,
						forms: {
							full: o.connection,
							compact: { w: 120, h: o.connection.h },
						},
					},
				]
			: []),
		...(o.backToLive
			? [
					{
						id: "back-to-live",
						kind: "back-to-live" as const,
						forms: { full: o.backToLive },
					},
				]
			: []),
		...(o.paused
			? [{ id: "paused", kind: "paused" as const, forms: { full: o.paused } }]
			: []),
		...o.notes.map((full, n) => ({
			id: `note:${n}`,
			kind: "note" as const,
			forms: { full },
		})),
	])

const drawerArb: fc.Arbitrary<DrawerInput | null> = fc.option(
	fc.record({
		id: fc.constantFrom(
			"activity" as const,
			"recordings" as const,
			"settings" as const,
		),
		wantedW: fc.integer({ min: 360, max: 640 }),
		expanded: fc.boolean(),
		pane: fc.constant(null),
		hasNoticeSlot: fc.boolean(),
	}),
	{ nil: null },
)

// the real open widths: the viewports the rule table names, and any window from a phone to a wide desktop
const viewport = fc.oneof(
	fc.constantFrom(
		{ w: 1440, h: 900 },
		{ w: 1280, h: 800 },
		{ w: 1100, h: 800 },
		{ w: 900, h: 800 },
		{ w: 390, h: 844 },
	),
	size([320, 2560], [560, 1600]),
)

const motionArb = fc.record({
	cardFrom: fc.option(
		fc.record({
			x: fc.integer({ min: 16, max: 1200 }),
			y: fc.integer({ min: 88, max: 700 }),
			w: fc.constant(340),
			h: fc.integer({ min: 52, max: 300 }),
		}),
		{ nil: null },
	),
	cardDrag: fc.option(
		fc.record({
			x: fc.integer({ min: 16, max: 1200 }),
			y: fc.integer({ min: 88, max: 700 }),
		}),
		{ nil: null },
	),
})

const scenario = fc.record({
	viewport,
	open: fc.constantFrom<IslandId | null>("listen", "tuner", "receiver", null),
	measured: fc.boolean(),
	panelH: fc.integer({ min: 40, max: 800 }),
	status: statusArb,
	drawer: drawerArb,
	card: fc.boolean(),
	anchor: fc.constantFrom(...CARD_ANCHOR_IDS),
	motion: motionArb,
})

function build(
	s: typeof scenario extends fc.Arbitrary<infer T> ? T : never,
): LayoutInput {
	const W = s.viewport.w
	const H = s.viewport.h
	const base = input(W, H, { status: s.status, drawer: s.drawer, card: s.card })
	const closed = computeLayout(base)
	const w =
		s.open === "listen"
			? closed.listenOpen.w
			: s.open === "tuner"
				? closed.tuner.w
				: closed.receiver.w
	const withCard: LayoutInput = {
		...base,
		card: base.card ? { ...base.card, anchor: s.anchor } : null,
	}
	// a stationary drag: the pointer holds the card where the settled (panel-closed) layout let it stand
	const settled = computeLayout(withCard)
	const want = s.motion.cardDrag
	const cardDrag =
		want && settled.card
			? clampDrag(
					want,
					{
						anchors: settled.cardAnchors,
						card: settled.card,
						freeW: settled.cardFreeW,
						H: settled.viewport.h,
						cardH: settled.card.h,
						obstacles: cardObstacles(settled),
					},
					settled.card,
				)
			: null
	return {
		...withCard,
		openPanel: s.open,
		panels:
			s.open && s.measured
				? [{ island: s.open, size: { w, h: s.panelH } }]
				: [],
		motion: { cardFrom: s.motion.cardFrom, cardDrag },
	}
}

/**
 * The open panel's room from LY rules §2.2, computed from the frame (its islands, the dock, the search button) and
 * the scenario: panelTop.tuner = stacked ? bottom(tuner) + PG : topRail + PG, panelTop.receiver = topRail + PG, the
 * cap = railTop − PG − panelTop (Listen: railTop − PG − (topRail + PG)), h = min(measured, cap) or the cap while
 * pending; Listen's width is the reserve (clamp(420, listen.w, W − 3G − dock.w) with the dock, else clamp(420,
 * listen.w, W − 2G − find.w − NG)); a pending room is at least the card's width (340) wide.
 */
function expectedRoom(
	L: ReturnType<typeof computeLayout>,
	open: IslandId | null,
	measured: number | null,
): Rect | null {
	if (!open) return null
	const G = 16
	const PG = 8
	const W = L.viewport.w
	const bottom = (b: Rect) => b.y + b.h
	const topRail = Math.max(bottom(L.tuner), bottom(L.receiver))
	const railTop = Math.min(
		L.listen.y,
		L.dock?.y ?? Infinity,
		L.find?.y ?? Infinity,
	)
	const fit = (v: number, lo: number, hi: number) =>
		Math.max(lo, Math.min(hi, v))
	const reserveW = L.dock
		? fit(LISTEN_OPEN_W, L.listen.w, W - 3 * G - L.dock.w)
		: fit(
				LISTEN_OPEN_W,
				L.listen.w,
				Math.max(L.listen.w, W - 2 * G - (L.find ? L.find.w + 8 : 0)),
			)
	expect(L.listenOpen.w).toBe(reserveW)
	const top =
		open === "tuner"
			? L.stacked
				? bottom(L.tuner) + PG
				: topRail + PG
			: open === "receiver"
				? topRail + PG
				: topRail + PG
	const cap = Math.max(0, railTop - PG - top)
	const h = measured === null ? cap : Math.min(measured, cap)
	const islandW =
		open === "tuner" ? L.tuner.w : open === "receiver" ? L.receiver.w : reserveW
	const w = measured === null ? Math.max(islandW, 340) : islandW
	if (open === "tuner") return r(L.tuner.x, top, w, h)
	if (open === "receiver") return r(L.receiver.x + L.receiver.w - w, top, w, h)
	return r(G, railTop - PG - h, w, h)
}

// the open Listen head and the dock are never covered by a shown slot (Property 1 below; pinned by a recorded seed)
const openListenClear = fc.property(scenario, s => {
	const L = computeLayout(build(s))
	const shown = namedRects(L)
	const listen = shown.find(n => n.name === "listen")
	// the head's rectangle in the checks is its open one while its panel is open
	if (s.open === "listen") expect(box(listen ?? null)).toEqual(L.listenOpen)
	// the frame and the dock are the same whatever opens (nothing moves when Listen opens)
	const bare = computeLayout({ ...build(s), openPanel: null, panels: [] })
	expect(box(L.dock)).toEqual(box(bare.dock))
	expect(L.listen).toEqual(bare.listen)
	if (L.dock) {
		// the open head keeps a gutter from the dock by construction: dock.x ≥ G + reserveW + G
		expect(L.dock.x - right(L.listenOpen)).toBeGreaterThanOrEqual(16)
		for (const n of shown)
			if (n.name !== "dock" && !n.name.startsWith("map:"))
				expect(intersects(n, L.dock), `${n.name} × dock`).toBe(false)
	}
	if (s.open === "listen")
		for (const n of shown)
			if (n.name !== "listen")
				expect(intersects(n, L.listenOpen), `${n.name} × open Listen`).toBe(
					false,
				)
})

describe("Rule P properties", () => {
	it("no shown slot overlaps the open Listen head or the dock, in transitions and during a stationary drag", () => {
		// Feature: layout, Property 1: the open Listen head and the dock are never covered
		// Validates: Requirements LY.2
		fc.assert(openListenClear, { numRuns: 300 })
	})

	it("the recorded seed that held a card under the open Listen head (review MJ1) stays clear", () => {
		// Feature: layout, Property 1: the open Listen head and the dock are never covered
		// Validates: Requirements LY.2
		fc.assert(openListenClear, { numRuns: 300, seed: 60 })
	})

	it("a status item within PANEL_GAP of an open panel's room yields, and is never seen while it does", () => {
		// Feature: layout, Property 2: occluded status items yield (unseen, timer paused)
		// Validates: Requirements LY.2
		fc.assert(
			fc.property(scenario, s => {
				const inp = build(s)
				const L = computeLayout(inp)
				// the room from the rule's formulas (LY rules §2.2) and the frame alone, never from L.panelRooms
				const room = expectedRoom(L, s.open, s.measured ? s.panelH : null)
				if (!s.open) expect(L.panelRooms).toEqual([])
				else expect(L.panelRooms).toEqual([room])
				for (const i of L.status.items) {
					const near =
						room !== null &&
						room.w > 0 &&
						room.h > 0 &&
						i.w > 0 &&
						i.h > 0 &&
						separation(room, i) < PANEL_GAP
					expect(L.yielded.includes(`status:${i.id}`), i.id).toBe(near)
					// every guest reads this one state (the chip, back to live, the paused label, the notes, the toasts)
					const state = statusState(L, i.id, true)
					if (near) expect(state, i.id).toBe("yielded")
					else expect(["shown", "held"], i.id).toContain(state)
					if (near) {
						expect(statusSeen(statusState(L, i.id, true))).toBe(false)
						expect(namedRects(L).some(n => n.name === `status:${i.id}`)).toBe(
							false,
						)
					}
				}
				// every shown status item keeps PANEL_GAP from the painted panel
				for (const n of namedRects(L))
					if (n.name.startsWith("status:"))
						for (const p of L.panels)
							expect(separation(n, p.rect)).toBeGreaterThanOrEqual(PANEL_GAP)
				// yielding never moves an item
				const bare = computeLayout({ ...inp, openPanel: null, panels: [] })
				expect(L.status.items).toEqual(bare.status.items)
			}),
			{ numRuns: 300 },
		)
	})
})

describe("Rule D: a held card under the open Listen head (LY rules §4.2)", () => {
	// review MJ1: 2000x560, the line-form card (52 tall) held at 372,480 (clamped against the closed 340 px head),
	// then Listen opens: its head widens to 16,480 420×64 and the held card must jump clear under the still pointer
	// (taste call 6), never stand under the open head, whether the panel is measured or still pending
	const held = (panel: { w: number; h: number } | null): LayoutInput => {
		const base = input(2000, 560, { open: "listen", panel })
		return {
			...base,
			card: base.card ? { ...base.card, minimised: true } : null,
			motion: { cardFrom: null, cardDrag: { x: 372, y: 480 } },
		}
	}
	for (const [name, panel] of [
		["measured", { w: 420, h: 300 }],
		["pending", null],
	] as const)
		it(`2000x560, card held at 372,480, Listen opens (${name}): the card stands a gutter clear of the open head`, () => {
			const L = computeLayout(held(panel))
			expect(L.listenOpen).toEqual(r(16, 480, 420, 64))
			const card = L.cardNow
			expect(card).not.toBeNull()
			if (!card) return
			expect(card.h).toBe(52)
			// held, it is pushed clear like any island and never yields (LY rules §4.2: "it never yields while held")
			expect(L.yielded).not.toContain("card")
			expect(separation(card, L.listenOpen)).toBeGreaterThanOrEqual(15.5)
			for (const room of L.panelRooms)
				expect(separation(card, room)).toBeGreaterThanOrEqual(15.5)
			expect(
				layoutViolations(namedRects(L), L.viewport).filter(
					v => v.a === "card" || v.b === "card",
				),
			).toEqual([])
		})
})

describe("Rule D: a held card with no legal spot left (LY rules §4.1)", () => {
	// a crowded frame: 1280x420 (the card in its line form), Activity open, a receipt and a condition up and Listen's
	// panel open; held low over the open Listen head, no spot is a gutter clear of every island and open room, and
	// the clamp's window-clamped fallback (16,352) stands under the open head and the player. The card yields there
	// (out of sight in place) rather than overlap an island; wherever a legal spot exists it stands clear
	const crowded = (
		x: number,
		y: number,
		panel: { w: number; h: number } | null,
	): LayoutInput => ({
		...input(1280, 420, {
			open: "listen",
			panel,
			status: [
				RECEIPT,
				{ id: "cond", kind: "condition", forms: { full: { w: 320, h: 60 } } },
			],
			drawer: {
				id: "activity",
				wantedW: 420,
				expanded: false,
				pane: null,
				hasNoticeSlot: true,
			},
		}),
		motion: { cardFrom: null, cardDrag: { x, y } },
	})
	const frameOf = (L: ReturnType<typeof computeLayout>): Rect[] => [
		...cardObstacles(L),
		...L.panelRooms,
		...(L.listenOpen ? [L.listenOpen] : []),
	]

	it("1280x420, the card held at 0,360 over the open Listen head: no legal spot, so it yields", () => {
		const L = computeLayout(crowded(0, 360, { w: 420, h: 300 }))
		const card = L.cardNow
		expect(card).not.toBeNull()
		if (!card) return
		// the fallback spot overlaps an island (the frame really has no legal spot)
		expect(frameOf(L).some(o => separation(card, o) < 0)).toBe(true)
		expect(L.yielded).toContain("card")
		expect(namedRects(L).some(n => n.name === "card")).toBe(false)
	})

	it("1280x420 crowded, any held spot: the card yields or stands a gutter clear of every island and room", () => {
		for (const panel of [{ w: 420, h: 300 }, null])
			for (let x = 0; x <= 1280; x += 80)
				for (let y = 0; y <= 420; y += 60) {
					const L = computeLayout(crowded(x, y, panel))
					const card = L.cardNow
					if (!card || L.yielded.includes("card")) continue
					for (const o of frameOf(L))
						expect(
							separation(card, o),
							`${x},${y} ${panel ? "measured" : "pending"}: card at ${card.x},${card.y}`,
						).toBeGreaterThanOrEqual(15.5)
				}
	})
})
