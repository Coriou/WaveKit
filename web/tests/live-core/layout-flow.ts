/**
 * `node scripts/ui-check.mjs --flow=layout`: the shell layout (docs/web/DESIGN.md, "Layout: rails and stage") seen
 * in a real browser, on the web app's mock core (web/mock).
 *
 * Setup: Listen on, a recording playing (the player), a link condition raised through POST /__mock/link-advisory
 * and a receipt with Undo (⌘K `vol <n>`), both held on screen by keeping the focus in a toast. Per viewport
 * (1440×900, 1280×800, 1100×800, 390×844) and drawer state (none, Activity, Recordings, Scanner, Settings at its
 * 560 px, expanded Cards; a phone opens each as a sheet), plus the tuned card minimised to its line where the card
 * shows and, from 1280 px, the Scanner with its plan pane attached, it reads every `[data-wk-slot]` box and the plot's
 * labels and rows, and checks:
 * - I1, I2: no two slots intersect or come closer than the layout's gaps; all inside the window's 16 px margin
 *   (src/shell/layout/compute.ts `layoutViolations`, the same rule the unit tests use);
 * - I7: each slot's box equals the rectangle it carries (`data-wk-rect`) within 1 px;
 * - I4, I5: no signal chip under any slot; no status item or the player on a chip or a scale row;
 * - I6: the scale rows end 16 px above the stack (when the window is 560 px tall or more), the plot body starts
 *   12 px under the top rail;
 * - I3, I8: across a viewport's cells the Tuner, the Receiver, Listen, the dock, the search button, the player and
 *   the card's home never move;
 * - visible states (V): in every cell each island the cell expects (the Tuner, the Receiver, Listen, the dock or the
 *   search button, the player, the condition and the receipt) is on screen (shown, not pending, not held, a
 *   non-zero box) or docked in the drawer's notice slot, or the shell lists it as waiting (`data-wk-waiting`: no room
 *   now, the layout's own reason); the notices count as set up only when shown;
 * - motion (M): when playback starts with the expanded card above Listen (the card glides up), and during one drawer
 *   opening per viewport, every animation frame for 400 ms (1200 ms for playback) WITH the CSS transitions on: no
 *   two shown slots intersect (a slot held for the card's glide is out of sight); a sample that sees no frame fails;
 * - open panels (P, every viewport): with Listen's panel open no island (the stacked Receiver, the tuned card,
 *   the player) covers it: the card is in the tree and either shown clear of the panel or listed as yielded; the
 *   opening is sampled from the click (an observed frame with the panel absent, then one with it present), and on
 *   every sampled frame the dock (or the search button) keeps its rectangle and its gap from the open Listen head
 *   (the dock reserves Listen's open width, LY rules §2.2); the dock's first button (the search button on a phone)
 *   is the element at its own centre, so it can be clicked;
 * - a panel over a receipt (P, 390×844): the Tuner panel opens over the strip's receipt with Undo; sampled from the
 *   click, the receipt is seen shown, then yielded (out of sight, inert, the element at Undo's centre is not Undo);
 *   it outlives its 6 s with the panel open (its clock does not run while covered), comes back shown on close with
 *   Undo at its own centre, and then expires after about the time it had left (it is live again);
 * - the map (1280×800, the Map view, Activity open, then each other viewport): the map's chrome is laid out with
 *   the rest (I1, I2, I7 and V), the Live chip stays off the dock and keeps its rectangle when the drawer opens.
 * The settled cells run with CSS transitions and animations switched off, so every box is a settled one.
 * `ticks` says how many animation frames each motion sample saw (from its action on).
 * The report gains `layout`; exit 1 on any violation.
 */
import type { Page } from "playwright-core"

import {
	layoutViolations,
	type Named,
	type Violation,
} from "../../src/shell/layout/compute.ts"
import { within } from "./harness.ts"
import { stackReceipt } from "./notices-flow.ts"

interface Box {
	x: number
	y: number
	w: number
	h: number
}

interface SlotBox extends Box {
	name: string
	/** The rectangle the slot carries from the layout, or null (docked in a drawer's slot). */
	want: Box | null
}

interface Chip extends Box {
	/** Fading out where an older layout put it (still drawn, so still checked). */
	leaving: boolean
}

interface Snapshot {
	slots: SlotBox[]
	listenOpen: boolean
	/** Slots out of sight: pending, held, hidden (by name). */
	hidden: string[]
	/** What the shell lists as waiting for room now (`data-wk-waiting`). */
	waiting: string[]
	/** The notice region is docked in a drawer's notice slot (its toasts are laid out there). */
	docked: boolean
	/** The toasts in the notice region's tree ("condition", "receipt"), shown or not. */
	toasts: string[]
	/** The player holds a recording (its transport is in the tree, shown or not). */
	playing: boolean
	chips: Chip[]
	rows: Box[]
	body: Box | null
	vw: number
	vh: number
}

export interface LayoutCell {
	viewport: string
	drawer: string
	rects: Record<string, string>
	violations: string[]
}

export interface LayoutReport {
	ok: boolean
	cells: LayoutCell[]
	/** Frame, player or card-home rectangles that changed between a viewport's cells. */
	moved: string[]
	/** Intersections seen on animation frames while a drawer opened or playback started. */
	frames: string[]
	/** Animation frames each of those samples saw. */
	ticks: number[]
	setup: string[]
}

const VIEWPORTS: [number, number][] = [
	[1440, 900],
	[1280, 800],
	[1100, 800],
	[390, 844],
]
const DRAWERS: { name: string; hash: string; ready: string }[] = [
	{ name: "activity", hash: "#/activity", ready: ".wka-drawer" },
	{ name: "recordings", hash: "#/recordings", ready: ".wkr-drawer" },
	{ name: "scanner", hash: "#/scanner", ready: ".wks-drawer" },
	// a phone lists the groups as screens (no group heads): the loaded view itself
	{ name: "settings", hash: "#/settings", ready: ".wkf-set" },
]
/** Onset (6 s of core time) plus the snapshot cadence and a margin (ms). */
const NOTICE_MS = 15_000
const STEP_MS = 10_000
/** A receipt's time on screen (src/shell/notices/service.ts `RECEIPT_MS`; not imported: its class syntax is not
 * type-strippable, and this flow runs under Node's type stripping). */
const RECEIPT_MS = 6000
const STEADY = ["tuner", "receiver", "listen", "dock", "find", "player"]

const fmt = (b: Box) =>
	`${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}`

const hits = (a: Box, b: Box) =>
	a.x < b.x + b.w - 0.5 &&
	b.x < a.x + a.w - 0.5 &&
	a.y < b.y + b.h - 0.5 &&
	b.y < a.y + a.h - 0.5

async function snapshot(page: Page): Promise<Snapshot> {
	return page.evaluate(() => {
		const box = (el: Element) => {
			const r = el.getBoundingClientRect()
			return { x: r.x, y: r.y, w: r.width, h: r.height }
		}
		const shown = (el: Element) => {
			const r = el.getBoundingClientRect()
			const cs = getComputedStyle(el)
			return (
				r.width > 0 &&
				r.height > 0 &&
				cs.visibility !== "hidden" &&
				Number(cs.opacity) > 0.5
			)
		}
		const every = [...document.querySelectorAll("[data-wk-slot]")]
		const out = (el: Element) =>
			el.closest("[data-pending], [data-held]") !== null || !shown(el)
		const hidden = every
			.filter(out)
			.map(el => el.getAttribute("data-wk-slot") ?? "")
		const slots = every
			.filter(el => !out(el))
			.map(el => {
				const attr = el.getAttribute("data-wk-rect")
				const [x = 0, y = 0, w = 0, h = 0] = (attr ?? "").split(",").map(Number)
				return {
					name: el.getAttribute("data-wk-slot") ?? "",
					...box(el),
					want: attr ? { x, y, w, h } : null,
				}
			})
		const all = (sel: string) =>
			[...document.querySelectorAll(sel)].filter(shown).map(box)
		const body = document.querySelector(".wk-plot-body")
		const region = document.querySelector("[data-wk-notice-region]")
		return {
			slots,
			listenOpen:
				document.querySelector(
					'.wk-shell-island[data-island="listen"][data-open]',
				) !== null,
			hidden,
			waiting: (
				document.querySelector(".wk-shell")?.getAttribute("data-wk-waiting") ??
				""
			)
				.split(" ")
				.filter(Boolean),
			docked: region?.getAttribute("data-where") === "drawer-slot",
			toasts: [
				...document.querySelectorAll("[data-wk-notice-region] .wk-notice"),
			].map(el => el.getAttribute("data-class") ?? ""),
			playing: document.querySelector("[data-wk-transport]") !== null,
			// the chip itself (its lead line runs down to the peak, under whatever is there); a leaving chip counts
			// too: the button's own opacity stays 1 while its chip fades
			chips: [...document.querySelectorAll(".wk-plot-sig > button")]
				.filter(shown)
				.map(el => ({
					...box(el),
					leaving: el.parentElement?.hasAttribute("data-leaving") ?? false,
				})),
			rows: all(
				".wk-plot-axis, .wk-plot-lane, .wk-plot-saved, .wk-plot-disc-root, .wk-ruler",
			),
			body: body ? box(body) : null,
			vw: window.innerWidth,
			vh: window.innerHeight,
		}
	})
}

/** The same slot boxes twice in a row, 250 ms apart (a loaded host may take a while), within 5 s. */
async function settled(page: Page): Promise<Snapshot> {
	await new Promise(resolve => setTimeout(resolve, 300))
	let last = await snapshot(page)
	const end = Date.now() + 5000
	while (Date.now() < end) {
		await new Promise(resolve => setTimeout(resolve, 250))
		const next = await snapshot(page)
		if (JSON.stringify(next.slots) === JSON.stringify(last.slots)) return next
		last = next
	}
	return last
}

/** Keeps both toasts on screen: the focus in a toast pauses their timers. */
async function holdToasts(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const controls = [
			...document.querySelectorAll<HTMLElement>(
				"[data-wk-notice-region] .wk-notice [data-control]",
			),
		].filter(el => el.getClientRects().length > 0)
		const el = controls[0]
		if (!el) return false
		el.focus({ preventScroll: true })
		return (
			document
				.querySelector("[data-wk-notice-region]")
				?.contains(document.activeElement) ?? false
		)
	})
}

/** The islands a cell expects on screen: the frame, the dock or the search button, the player while a recording is
 * in it, and every toast in the notice region's tree (a toast in the tree but out of sight must be one the layout
 * lists as waiting). */
function expected(s: Snapshot): string[] {
	return [
		"tuner",
		"receiver",
		"listen",
		s.vw >= 761 ? "dock|find" : "find",
		...(s.playing ? ["player"] : []),
		...s.toasts.map(t => `status:${t}`),
	]
}

/** V: every expected island shown, docked in the drawer's slot, or listed as waiting by the layout. */
function visibleStates(s: Snapshot, extra: readonly string[] = []): string[] {
	const out: string[] = []
	const on = (n: string) =>
		s.slots.some(sl => sl.name === n && sl.w > 0 && sl.h > 0)
	for (const want of [...expected(s), ...extra]) {
		const names = want.split("|")
		if (names.some(on)) continue
		if (want.startsWith("status:") && s.docked) continue
		if (names.some(n => s.waiting.includes(n))) continue
		out.push(
			`V ${want} not on screen${names.some(n => s.hidden.includes(n)) ? " (hidden)" : ""} and not listed as waiting`,
		)
	}
	return out
}

function check(
	s: Snapshot,
	extra: readonly string[] = [],
	mapView = false,
): string[] {
	const out: string[] = visibleStates(s, extra)
	// docked items sit inside their drawer by design
	const placed = s.slots.filter(
		sl => sl.want !== null || !sl.name.startsWith("status:"),
	)
	const named: Named[] = placed.map(sl => ({
		name: sl.name,
		x: sl.x,
		y: sl.y,
		w: sl.w,
		h: sl.h,
	}))
	for (const v of layoutViolations(named, { w: s.vw, h: s.vh }))
		out.push(describeViolation(v))
	for (const sl of placed) {
		const w = sl.want
		if (
			w &&
			(Math.abs(w.x - sl.x) > 1 ||
				Math.abs(w.y - sl.y) > 1 ||
				Math.abs(w.w - sl.w) > 1 ||
				Math.abs(w.h - sl.h) > 1)
		)
			out.push(`I7 ${sl.name}: DOM ${fmt(sl)}, layout ${fmt(w)}`)
	}
	// the Map view covers the plot: its chips and rows are not on screen there
	for (const c of mapView ? [] : s.chips)
		for (const sl of placed)
			if (hits(c, sl))
				out.push(
					`I5 ${c.leaving ? "leaving chip" : "chip"} ${fmt(c)} under ${sl.name}`,
				)
	const guests = placed.filter(
		sl => sl.name.startsWith("status:") || sl.name === "player",
	)
	for (const g of guests)
		for (const r of mapView ? [] : [...s.chips, ...s.rows])
			if (hits(g, r)) out.push(`I4 ${g.name} over the plot at ${fmt(r)}`)
	const get = (n: string) => placed.find(sl => sl.name === n)
	const tuner = get("tuner")
	const receiver = get("receiver")
	const stackTop = get("player")?.y ?? get("listen")?.y
	if (s.body && tuner && receiver) {
		const rail = Math.max(tuner.y + tuner.h, receiver.y + receiver.h)
		if (s.body.y < rail + 12 - 1)
			out.push(`I6 plot body at ${Math.round(s.body.y)}, top rail ends ${rail}`)
	}
	if (stackTop !== undefined && s.vh >= 560 && !mapView) {
		const end = Math.max(0, ...s.rows.map(r => r.y + r.h))
		if (end > stackTop - 16 + 1)
			out.push(`I6 scale rows end ${Math.round(end)}, stack starts ${stackTop}`)
	}
	return out
}

const describeViolation = (v: Violation) =>
	v.kind === "outside"
		? `I2 ${v.a} outside the window's margin`
		: `I1 ${v.a} and ${v.b ?? ""}: ${v.kind === "intersect" ? "intersect" : `${Math.round(v.gap ?? 0)} px apart, need ${v.need ?? 0}`}`

/** Samples every slot box on each animation frame (distinct rAF timestamps only) for `ms` from the action (a
 * capturing pointerdown, keydown or `wk:act` marks t0; Node waits on the page's done flag); the intersections seen. */
async function framesDuring(
	page: Page,
	act: () => Promise<void>,
	ms = 400,
): Promise<string[]> {
	await page.evaluate(ms => {
		const w = window as unknown as {
			__wkFrames?: string[]
			__wkTicks?: number
			__wkFramesDone?: boolean
		}
		w.__wkFrames = []
		w.__wkTicks = 0
		w.__wkFramesDone = false
		delete (window as unknown as { __wkActDone?: number }).__wkActDone
		const tick = () => {
			w.__wkTicks = (w.__wkTicks ?? 0) + 1
			const boxes = [
				...document.querySelectorAll("[data-wk-slot][data-wk-rect]"),
			]
				.filter(el => {
					if (el.closest("[data-pending], [data-held]")) return false
					const cs = getComputedStyle(el)
					return cs.visibility !== "hidden" && Number(cs.opacity) > 0.05
				})
				.map(el => {
					const r = el.getBoundingClientRect()
					return { name: el.getAttribute("data-wk-slot") ?? "", r }
				})
				.filter(b => b.r.width > 0 && b.r.height > 0)
			const parts = new Set(["drawer", "pane", "grip"])
			for (let i = 0; i < boxes.length; i++)
				for (let j = i + 1; j < boxes.length; j++) {
					const a = boxes[i]
					const b = boxes[j]
					if (!a || !b || (parts.has(a.name) && parts.has(b.name))) continue
					if (
						a.r.left < b.r.right - 0.5 &&
						b.r.left < a.r.right - 0.5 &&
						a.r.top < b.r.bottom - 0.5 &&
						b.r.top < a.r.bottom - 0.5
					)
						w.__wkFrames?.push(`${a.name} × ${b.name}`)
				}
		}
		let t0: number | null = null
		const mark = () => {
			if (t0 === null) t0 = performance.now()
		}
		const types = ["pointerdown", "keydown", "hashchange", "wk:act"]
		for (const t of types) window.addEventListener(t, mark, true)
		const armed = performance.now()
		let last = -1
		const frame = (ts: number) => {
			const now = performance.now()
			// an action that sent no event is marked when it resolves
			const done = (window as unknown as { __wkActDone?: number }).__wkActDone
			if (t0 === null && done !== undefined) t0 = done
			if (ts !== last && t0 !== null && now >= t0) tick()
			last = ts
			// a multi-step action (navigate, click, navigate back) is sampled until it has resolved, then `ms` more
			const end =
				t0 === null
					? armed + 30_000
					: done === undefined
						? Infinity
						: Math.max(t0 + ms + 160, done + ms)
			if (now < end) requestAnimationFrame(frame)
			else {
				for (const t of types) window.removeEventListener(t, mark, true)
				w.__wkFramesDone = true
			}
		}
		requestAnimationFrame(frame)
	}, ms)
	await act()
	await page.evaluate(() => {
		;(window as unknown as { __wkActDone?: number }).__wkActDone =
			performance.now()
	})
	await page.waitForFunction(
		() =>
			(window as unknown as { __wkFramesDone?: boolean }).__wkFramesDone ===
			true,
		undefined,
		{ timeout: 40_000 },
	)
	const got = await page.evaluate(() => {
		const w = window as unknown as { __wkFrames?: string[]; __wkTicks?: number }
		return { seen: [...new Set(w.__wkFrames ?? [])], ticks: w.__wkTicks ?? 0 }
	})
	ticks.push(got.ticks)
	// a sample that saw no frame proves nothing: it fails
	return got.ticks === 0 ? ["no animation frame sampled"] : got.seen
}

/** One sampled frame of named elements: each one's box, visibility and layout state, or null while it is absent. */
type Frame = Record<
	string,
	{
		x: number
		y: number
		w: number
		h: number
		vis: string
		state: string
	} | null
>

/** A sampled action: the frames (the first one read before the action was sent, then one per animation frame from
 * the action on), and how many animation frames fell inside the action's window. */
interface Sampled {
	frames: Frame[]
	inWindow: number
	/** The action's wall-clock time (Date.now() at t0), or null when no action was seen. */
	at: number | null
}

/** Fewer animation frames than this inside the window prove nothing: the cell is unobserved. */
const MIN_FRAMES = 3
/** The sampled window after the action; every frame in it is checked. */
const SAMPLE_MS = 600

/** Samples the named elements on every animation frame (distinct rAF timestamps only, no timer ticks) for `ms` from
 * the action (LY rules §7.2): armed in the page before it, a capturing listener (pointerdown, keydown, or a `wk:act`
 * event a programmatic step dispatches) records t0, frames before t0 are dropped, sampling runs to t0 + ms + 160,
 * and Node waits on the page's done flag. The first frame is read synchronously before `act` is sent. */
async function sampleDuring(
	page: Page,
	named: Record<string, string>,
	act: () => Promise<void>,
	ms = SAMPLE_MS,
): Promise<Sampled> {
	await page.evaluate(
		({ named, ms }) => {
			const w = window as unknown as {
				__wkSamples?: unknown[]
				__wkSampleDone?: boolean
				__wkInWindow?: number
				__wkSampleAt?: number | null
			}
			const out: unknown[] = []
			w.__wkSamples = out
			w.__wkSampleDone = false
			w.__wkInWindow = 0
			w.__wkSampleAt = null
			const read = () => {
				const f: Record<string, unknown> = {}
				for (const [name, sel] of Object.entries(named)) {
					const el = document.querySelector(sel)
					if (!el) {
						f[name] = null
						continue
					}
					const r = el.getBoundingClientRect()
					const holder = el.closest("[data-wk-state]")
					f[name] = {
						x: r.x,
						y: r.y,
						w: r.width,
						h: r.height,
						vis: getComputedStyle(el).visibility,
						state: holder?.getAttribute("data-wk-state") ?? "",
					}
				}
				return f
			}
			let t0: number | null = null
			const mark = () => {
				if (t0 !== null) return
				t0 = performance.now()
				w.__wkSampleAt = Date.now()
			}
			const types = ["pointerdown", "keydown", "hashchange", "wk:act"]
			for (const t of types) window.addEventListener(t, mark, true)
			const armed = performance.now()
			let last = -1
			let inWindow = 0
			// the state before the action, read now
			out.push(read())
			const frame = (ts: number) => {
				const now = performance.now()
				if (ts !== last) {
					last = ts
					if (t0 !== null && now >= t0) {
						out.push(read())
						if (now <= t0 + ms) inWindow++
					}
				}
				// no action within 30 s: done, unobserved
				const end = t0 === null ? armed + 30_000 : t0 + ms + 160
				if (now < end) requestAnimationFrame(frame)
				else {
					for (const t of types) window.removeEventListener(t, mark, true)
					w.__wkInWindow = inWindow
					w.__wkSampleDone = true
				}
			}
			requestAnimationFrame(frame)
		},
		{ named, ms },
	)
	await act()
	await page.waitForFunction(
		() =>
			(window as unknown as { __wkSampleDone?: boolean }).__wkSampleDone ===
			true,
		undefined,
		{ timeout: 40_000 },
	)
	const got = await page.evaluate(() => {
		const w = window as unknown as {
			__wkSamples?: Frame[]
			__wkInWindow?: number
			__wkSampleAt?: number | null
		}
		return {
			frames: w.__wkSamples ?? [],
			inWindow: w.__wkInWindow ?? 0,
			at: w.__wkSampleAt ?? null,
		}
	})
	ticks.push(got.inWindow)
	return got
}

/** Samples `act`; an unobserved sample (fewer than MIN_FRAMES in the window) is retried once, the same window,
 * after `reset` puts the cell's starting state back. Still unobserved, it says so (it never passes unobserved). */
async function sampleObserved(
	page: Page,
	named: Record<string, string>,
	act: () => Promise<void>,
	reset: () => Promise<void>,
	ms = SAMPLE_MS,
): Promise<Sampled & { unobserved: string | null }> {
	let got = await sampleDuring(page, named, act, ms)
	if (got.inWindow >= MIN_FRAMES) return { ...got, unobserved: null }
	await reset()
	got = await sampleDuring(page, named, act, ms)
	return {
		...got,
		unobserved:
			got.inWindow >= MIN_FRAMES
				? null
				: `unobserved: ${got.inWindow} animation frames in the ${ms} ms window (need ${MIN_FRAMES}), after one retry`,
	}
}

/** The element at the centre of the first match is that element or inside it, and not inert (a click reaches it). */
async function hitsItself(page: Page, sel: string): Promise<boolean> {
	return page.evaluate(sel => {
		const el = document.querySelector(sel)
		if (!el) return false
		const r = el.getBoundingClientRect()
		if (r.width <= 0 || r.height <= 0) return false
		const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
		return (
			at !== null && (at === el || el.contains(at)) && !el.closest("[inert]")
		)
	}, sel)
}

/** Listen's opening, sampled from the click: the panel seen absent then present (a changed frame), the dock or the
 * search button never moving and never within its gap of the open Listen head on any frame. */
function listenOpening(frames: readonly Frame[]): string[] {
	if (frames.length === 0) return ["P Listen opening: no frame sampled"]
	const out: string[] = []
	// the bottom rail's neighbour is there before the action (the dock, or the search button on a phone): a check of
	// "never moved" against nothing proves nothing
	const f0 = frames[0]
	if (!f0?.["dock"] && !f0?.["find"])
		out.push(
			"P Listen opening: neither the dock nor the search button on frame 0",
		)
	const before = frames.findIndex(f => f["panel"] === null)
	const after = frames.findIndex((f, i) => i > before && f["panel"] !== null)
	if (before < 0 || after < 0)
		out.push(
			`P Listen opening: no changed frame of the panel observed (${frames.length} frames)`,
		)
	const first = frames[0]
	for (const [name, need] of [
		["dock", 16],
		["find", 8],
	] as const) {
		const at0 = first?.[name] ?? null
		for (const f of frames) {
			const b = f[name] ?? null
			const l = f["listen"] ?? null
			if (!b || !l) continue
			if (
				at0 &&
				(Math.abs(b.x - at0.x) > 0.5 ||
					Math.abs(b.y - at0.y) > 0.5 ||
					Math.abs(b.w - at0.w) > 0.5)
			) {
				out.push(`P ${name} moved while Listen opened: ${fmt(at0)} → ${fmt(b)}`)
				break
			}
			if (b.x - (l.x + l.w) < need - 0.5) {
				out.push(
					`P open Listen ${fmt(l)} within ${need} px of the ${name} ${fmt(b)}`,
				)
				break
			}
		}
	}
	return out
}

/** Animation frames each motion sample saw from its action on. */
let ticks: number[] = []

export async function layoutFlow(
	page: Page,
	mockApi: string,
): Promise<LayoutReport> {
	const setup: string[] = []
	ticks = []
	let phase = "start"
	// kept on a failure: the cells checked so far say where it got to
	const cells: LayoutCell[] = []
	const moved: string[] = []
	const frames: string[] = []
	try {
		return await run()
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : ""
		setup.push(`MISSING: stopped at ${phase}: ${message ?? ""}`)
		return { ok: false, cells, moved, frames, ticks, setup }
	}

	async function run(): Promise<LayoutReport> {
		const advisory = async (body: unknown) => {
			const answer = await fetch(`${mockApi}/__mock/link-advisory`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})
			if (!answer.ok)
				throw new Error(`mock link advisory refused: HTTP ${answer.status}`)
		}
		const go = (hash: string) =>
			page.evaluate(h => {
				location.hash = h
			}, hash)
		const condition = page.locator(
			'[data-wk-notice-region] .wk-notice[data-class="condition"]',
		)
		const receipt = page.locator(
			'[data-wk-notice-region] .wk-notice[data-class="receipt"]',
		)
		// a toast counts as set up only when the reader can see it: placed (not pending, not held) and drawn
		const shownToast = (cls: "condition" | "receipt") =>
			page.evaluate(c => {
				const el = document.querySelector(
					`[data-wk-notice-region] .wk-notice[data-class="${c}"]`,
				)
				if (!el || el.closest("[data-pending], [data-held]")) return false
				const r = el.getBoundingClientRect()
				return (
					r.width > 0 &&
					r.height > 0 &&
					getComputedStyle(el).visibility !== "hidden"
				)
			}, cls)
		const player = page.locator("[data-wk-transport]")

		// settled geometry: in a headless page on a loaded host a CSS transition (the card's glide, a drawer's
		// foot) advances only when something else asks for a frame, so the DOM trails the layout by one change;
		// with transitions off every box is where the layout put it at once (reduced motion is no help: the kit
		// gives every property a 0.01 ms transition then, which waits for a frame just the same)
		const STILL =
			"*, *::before, *::after { transition: none !important; animation: none !important }"
		let still: Awaited<ReturnType<Page["addStyleTag"]>> | null = null
		const motionOff = async () => {
			if (!still) still = await page.addStyleTag({ content: STILL })
		}
		const motionOn = async () => {
			const el = still
			still = null
			if (el)
				await el.evaluate(n => {
					n.parentNode?.removeChild(n)
				})
		}
		await page.setViewportSize({ width: 1440, height: 900 })
		// Listen on, then a recording playing (the player): the first row with a recording in Activity
		phase = "Listen on"
		await page.locator("button.wk-shell-listen-btn").click()
		const play = async () => {
			phase = "play a recording"
			await go("#/activity")
			const disc = page.locator(".wka-list .wkp-disc").first()
			await disc.waitFor({ timeout: STEP_MS })
			await disc.click()
			await player.first().waitFor({ timeout: STEP_MS })
			await go("")
		}
		// the palette's code loads on first use (slow on a loaded host): once now, so the receipt step is quick
		phase = "warm the palette"
		await page.keyboard.press("Control+k")
		await page.locator(".wkp-input").waitFor({ timeout: 60_000 })
		await page.keyboard.press("Escape")
		await page
			.locator(".wkp-input")
			.waitFor({ state: "detached", timeout: STEP_MS })
		// each drawer's code loads on first use too (slow on a loaded host): open each once now, with the palette's
		// budget, so the cells' STEP_MS waits measure the layout and not a first chunk load
		for (const d of DRAWERS) {
			phase = `warm the ${d.name} drawer`
			await go(d.hash)
			await page
				.locator(`.wk-shell-drawer ${d.ready}`)
				.first()
				.waitFor({ timeout: 60_000 })
		}
		await go("")
		// with the transitions on: the expanded card above Listen glides up while the player enters under it
		const card = await page.evaluate(
			() =>
				document
					.querySelector('[data-wk-slot="card"]')
					?.getAttribute("data-wk-rect") ?? null,
		)
		setup.push(`card before playback: ${card ?? "MISSING"}`)
		const startFrames = await framesDuring(page, play, 1200)
		frames.push(...startFrames.map(f => `1440x900 playback start: ${f}`))
		setup.push(`player: ${(await player.count()) > 0 ? "shown" : "MISSING"}`)
		await motionOff()

		let volume = 30
		let episode = 0
		for (const [W, H] of VIEWPORTS) {
			const vp = `${W}x${H}`
			phase = `${vp}: setup`
			await go("")
			await page.setViewportSize({ width: W, height: H })
			if ((await player.count()) === 0) await play()
			// a fresh condition and receipt for this viewport, held by the focus
			if ((await condition.count()) === 0) {
				if (episode++ > 0) {
					await advisory({ level: "none", endEpisode: true })
					await new Promise(resolve => setTimeout(resolve, 2500))
				}
				await advisory({ level: "dropping", lossReason: "source" })
				await within(NOTICE_MS, async () => (await condition.count()) > 0)
			}
			volume += 5
			const why = await stackReceipt(page, volume)
			const held = await holdToasts(page)
			const cShown = await shownToast("condition")
			const rShown = await shownToast("receipt")
			setup.push(
				`${vp}: condition ${cShown ? "shown" : (await condition.count()) > 0 ? "MISSING (in the tree, not on screen)" : "MISSING"}, receipt ${rShown ? "shown" : (await receipt.count()) > 0 ? "MISSING (in the tree, not on screen)" : "MISSING"}${why && why !== "the focus is not in the region" ? ` (${why})` : ""}, held ${held}`,
			)
			const vpCells: { drawer: string; s: Snapshot }[] = []
			const record = async (drawer: string) => {
				phase = `${vp}: ${drawer}`
				await holdToasts(page)
				const s = await settled(page)
				const violations = check(s)
				vpCells.push({ drawer, s })
				cells.push({
					viewport: vp,
					drawer,
					rects: Object.fromEntries(s.slots.map(sl => [sl.name, fmt(sl)])),
					violations,
				})
			}
			await record("none")
			// Listen's panel open is part of the layout, in every viewport: no island over it (on the phone the stacked
			// Receiver; from 1101 px the tuned card at its home above Listen and the player, which yield in place, out of
			// sight), and the open head (420 px from 916 px) never reaches the dock, which reserves that width
			const wide = W === 1440 && H === 900
			{
				phase = `${vp}: open the Listen panel`
				const toggle = page
					.locator(
						'.wk-shell-island[data-island="listen"] [aria-controls][aria-expanded]',
					)
					.first()
				const focusViolations: string[] = []
				const LISTEN_NAMED = {
					listen: '[data-wk-slot="listen"]',
					panel: '.wk-shell-island[data-island="listen"] .wk-shell-panel',
					dock: '[data-wk-slot="dock"]',
					find: '[data-wk-slot="find"]',
				}
				const listenPanel = page.locator(LISTEN_NAMED.panel)
				// a retry's starting state: the Listen panel closed and the layout settled
				const closeListen = async () => {
					if ((await listenPanel.count()) > 0)
						await page.keyboard.press("Escape")
					await listenPanel.waitFor({ state: "detached", timeout: STEP_MS })
					await settled(page)
				}
				if (wide) {
					// Programmatic opening preserves focus inside the yielding slot until the shell transfers it.
					for (const slot of ["player", "card"]) {
						const control = page
							.locator(`[data-wk-slot="${slot}"] button:enabled:visible`)
							.first()
						if (slot === "player") {
							// Check the held state without racing the glide timer.
							const tookFocus = await control.evaluate(button => {
								const player = button.closest("[data-wk-slot]")
								if (!player) throw new Error("missing player slot")
								player.setAttribute("data-held", "")
								try {
									button.focus()
									return document.activeElement === button
								} finally {
									player.removeAttribute("data-held")
								}
							})
							if (tookFocus) focusViolations.push("held player accepted focus")
						}
						await control.focus()
						if (!(await control.evaluate(el => el === document.activeElement)))
							focusViolations.push(`could not focus ${slot} before yield`)
						const opening = await sampleObserved(
							page,
							LISTEN_NAMED,
							() =>
								toggle.evaluate(el => {
									// a programmatic step marks its action for the sampler
									window.dispatchEvent(new Event("wk:act"))
									;(el as HTMLButtonElement).click()
								}),
							async () => {
								await closeListen()
								await control.focus()
							},
						)
						if (opening.unobserved)
							focusViolations.push(
								`P Listen opening over the ${slot}: ${opening.unobserved}`,
							)
						focusViolations.push(...listenOpening(opening.frames))
						await page
							.locator(`[data-wk-slot="${slot}"][data-yielded]`)
							.waitFor({ state: "attached", timeout: STEP_MS })
						if (!(await toggle.evaluate(el => el === document.activeElement)))
							focusViolations.push(
								`focus did not reach Listen from the yielded ${slot}`,
							)
						if (slot === "player") await toggle.click()
					}
				} else {
					const opening = await sampleObserved(
						page,
						LISTEN_NAMED,
						() => toggle.click(),
						closeListen,
					)
					if (opening.unobserved)
						focusViolations.push(`P Listen opening: ${opening.unobserved}`)
					focusViolations.push(...listenOpening(opening.frames))
				}
				const panel = page.locator(
					'.wk-shell-island[data-island="listen"] .wk-shell-panel',
				)
				await panel.waitFor({ timeout: STEP_MS })
				const s = await settled(page)
				const p = await panel.boundingBox()
				const violations = [...check(s), ...focusViolations]
				// the control beside the open Listen head is clickable: nothing stands over it
				const neighbour =
					W >= 761 ? '[data-wk-slot="dock"] button' : '[data-wk-slot="find"]'
				if (!(await hitsItself(page, neighbour)))
					violations.push(
						`P ${W >= 761 ? "the dock's first button" : "the search button"} is not the element at its own centre with Listen open`,
					)
				const frameNames = [
					"tuner",
					"receiver",
					"dock",
					"find",
					"card",
					"player",
				]
				// the card is there (in the tree) while the panel is open: on screen clear of it, or listed as yielded
				if (wide) {
					const card = await page.evaluate(
						() => document.querySelector('[data-wk-slot="card"]') !== null,
					)
					if (!card) violations.push("P no tuned card in the tree")
					else if (
						!s.slots.some(sl => sl.name === "card") &&
						!s.waiting.includes("card")
					)
						violations.push(
							"P the card is out of sight and not listed as yielded",
						)
				}
				if (!p) violations.push("P the Listen panel has no box")
				else
					for (const sl of s.slots)
						if (
							frameNames.includes(sl.name) &&
							hits(sl, { x: p.x, y: p.y, w: p.width, h: p.height })
						)
							violations.push(
								`P ${sl.name} ${fmt(sl)} over the open Listen panel ${fmt({ x: p.x, y: p.y, w: p.width, h: p.height })}`,
							)
				cells.push({
					viewport: vp,
					drawer: "none, Listen panel open",
					rects: {
						...Object.fromEntries(s.slots.map(sl => [sl.name, fmt(sl)])),
						...(p
							? {
									"listen panel": fmt({
										x: p.x,
										y: p.y,
										w: p.width,
										h: p.height,
									}),
								}
							: {}),
					},
					violations,
				})
				await page.keyboard.press("Escape")
				await panel.waitFor({ state: "detached", timeout: STEP_MS })
				await holdToasts(page)
			}
			// the card minimised to its line, where the card shows
			const minimise = page.getByRole("button", { name: "Minimise card" })
			if (W > 1100 && (await minimise.count()) > 0) {
				phase = `${vp}: minimise the card`
				await minimise.first().click()
				await record("none, card minimised")
				await page.getByRole("button", { name: "Expand card" }).first().click()
				await holdToasts(page)
			}
			let sampled = false
			for (const d of DRAWERS) {
				const open = async () => {
					phase = `${vp}: open ${d.name}`
					await go(d.hash)
					try {
						await page
							.locator(`.wk-shell-drawer ${d.ready}`)
							.first()
							.waitFor({ timeout: STEP_MS })
					} catch (error) {
						// what is on screen instead: the address, the drawer shown and its shape, a loading skeleton
						const seen = await page.evaluate(sel => {
							const box = document.querySelector(".wk-shell-drawer")
							const title =
								box?.querySelector("h2, [role=heading]")?.textContent
							const ready = box?.querySelector(sel)
							const r = ready?.getBoundingClientRect()
							return `hash ${JSON.stringify(location.hash)}, drawer ${box ? `${JSON.stringify(title ?? "")} ${box.getAttribute("data-shape") ?? ""} rect ${box.getAttribute("data-wk-rect") ?? ""}${box.hasAttribute("data-held") ? " held" : ""}${box.querySelector("[aria-busy=true]") ? " loading" : ""}` : "none"}, ${sel} ${ready ? `${Math.round(r?.width ?? 0)}x${Math.round(r?.height ?? 0)} ${getComputedStyle(ready).visibility}` : "absent"}`
						}, `.wk-shell-drawer ${d.ready}`)
						const first =
							error instanceof Error ? (error.message.split("\n")[0] ?? "") : ""
						throw new Error(`${first} (${seen})`)
					}
				}
				if (!sampled) {
					// with the transitions on (the drawer's rise, a card yielding to it)
					await motionOn()
					const seen = await framesDuring(page, open)
					await motionOff()
					frames.push(...seen.map(f => `${vp} ${d.name} opening: ${f}`))
					sampled = true
				} else await open()
				await record(W < 1100 ? `${d.name} (sheet)` : d.name)
			}
			// the Scanner with its plan pane attached left of the column (from 1280 px; narrower it is pushed in)
			if (W >= 1280) {
				phase = `${vp}: attach the plan pane`
				await go("#/scanner")
				const plan = page.locator(".wk-shell-drawer .wks-plan-btn")
				await plan.waitFor({ timeout: STEP_MS })
				await plan.click()
				const paneSlot = page.locator(".wk-shell-paneslot")
				await paneSlot.waitFor({ timeout: STEP_MS })
				await record("scanner, plan pane attached")
				await page.keyboard.press("Escape")
				await paneSlot.waitFor({ state: "detached", timeout: STEP_MS })
			}
			// Activity › Cards › Expand, then back to the list
			phase = `${vp}: expand the cards`
			await go("#/activity")
			await page
				.locator(".wk-shell-drawer .wka-drawer")
				.waitFor({ timeout: STEP_MS })
			await page.getByRole("radio", { name: "Cards" }).click()
			await page.locator(".wk-shell-drawer .wka-expand").click()
			await page
				.locator(
					".wk-shell-drawer[data-expanded], .wk-shell-drawer[data-shape='sheet']",
				)
				.first()
				.waitFor({ timeout: STEP_MS })
			await record(W < 1100 ? "expanded cards (sheet)" : "expanded cards")
			await page.locator(".wk-shell-drawer .wka-expand").click()
			await page.getByRole("radio", { name: "List" }).click()
			await go("")

			// I3/I8: the frame, the player and the card's home are the same in every cell of the viewport
			const first = vpCells[0]
			if (first)
				for (const c of vpCells.slice(1)) {
					for (const name of [...STEADY, "card"]) {
						const a = first.s.slots.find(sl => sl.name === name)
						const b = c.s.slots.find(sl => sl.name === name)
						// the card hides under covering surfaces and takes its line form when minimised
						if (name === "card" && (!b || c.drawer.startsWith("none, card")))
							continue
						if (!a && !b) continue
						if (!a || !b || fmt(a) !== fmt(b))
							moved.push(
								`${vp} ${name}: ${a ? fmt(a) : "absent"} → ${b ? fmt(b) : "absent"} (${c.drawer})`,
							)
					}
				}
			// a phone: the Tuner panel over the strip's receipt (LY rules §2.3, decision 3: it waits, unseen, its clock
			// paused, and shows with Undo when the panel closes)
			if (W < 761) {
				volume += 5
				cells.push(await tunerOverReceipt(vp, volume))
			}
		}
		// a sampled cell seen in too few frames is retried once from a reset start (panel closed, a fresh receipt with
		// its own id); it never passes unobserved
		async function tunerOverReceipt(
			vp: string,
			percent: number,
		): Promise<LayoutCell> {
			const first = await tunerOverReceiptOnce(vp, percent)
			if (!first.unobserved) return first.cell
			const tunerPanel = page.locator(
				'.wk-shell-island[data-island="tuner"] .wk-shell-panel',
			)
			if ((await tunerPanel.count()) > 0) await page.keyboard.press("Escape")
			await tunerPanel.waitFor({ state: "detached", timeout: STEP_MS })
			const again = await tunerOverReceiptOnce(vp, percent + 1)
			if (again.unobserved)
				again.cell.violations.push(
					`unobserved: fewer than ${MIN_FRAMES} animation frames in a sampled window, after one retry`,
				)
			return again.cell
		}
		async function tunerOverReceiptOnce(
			vp: string,
			percent: number,
		): Promise<{ cell: LayoutCell; unobserved: boolean }> {
			phase = `${vp}: the Tuner panel over the receipt`
			const violations: string[] = []
			const rects: Record<string, string> = {}
			const RECEIPT_SEL =
				'[data-wk-notice-region] .wk-notice[data-class="receipt"]'
			const UNDO = `${RECEIPT_SEL} [data-control="undo"]`
			const named = {
				receipt: RECEIPT_SEL,
				panel: '.wk-shell-island[data-island="tuner"] .wk-shell-panel',
			}
			await go("")
			// a fresh receipt with Undo (the focus held in the region pauses its clock until the Tuner's click)
			const why = await stackReceipt(page, percent)
			if (why && why !== "no condition under the receipt")
				violations.push(`setup: ${why}`)
			const before = await settled(page)
			const r0 = before.slots.find(sl => sl.name === "status:receipt")
			if (!r0)
				violations.push(
					"setup: the receipt is not shown before the panel opens",
				)
			else rects["receipt"] = fmt(r0)
			if (!(await hitsItself(page, UNDO)))
				violations.push(
					"Undo is not the element at its own centre before the panel opens",
				)
			const toggle = page
				.locator(
					'.wk-shell-island[data-island="tuner"] [aria-controls][aria-expanded]',
				)
				.first()
			// the focus on Undo when the panel opens by keyboard (a key pressed on Undo opens it, so the focus stays
			// there until the shell hands it off): it must reach the Tuner's trigger, never fall to the body (LY rules
			// §1.2). The flow binds the key for this one press; the keydown itself is the sampler's t0
			const undo = page.locator(UNDO)
			await undo.focus()
			if (!(await undo.evaluate(el => el === document.activeElement)))
				violations.push("setup: could not focus Undo before the panel opened")
			// (a) the change, observed from the action: the receipt seen shown, then yielded under the panel
			await toggle.evaluate(el => {
				const open = (e: KeyboardEvent) => {
					if (e.key !== "F8") return
					window.removeEventListener("keydown", open)
					e.preventDefault()
					;(el as HTMLButtonElement).click()
				}
				window.addEventListener("keydown", open)
			})
			const sampled = await sampleDuring(page, named, () =>
				page.keyboard.press("F8"),
			)
			if (!(await page.locator(named.panel).count()))
				violations.push(
					"the Tuner panel did not open from the key pressed on Undo",
				)
			let unobserved = sampled.inWindow < MIN_FRAMES
			const opening = sampled.frames
			// on every frame the panel stands, the receipt is out of sight in place (mounted, hidden: never drawn under
			// or over it, never unmounted)
			const under = opening.findIndex(
				f => f["panel"] !== null && f["receipt"]?.vis !== "hidden",
			)
			if (under >= 0)
				violations.push(
					`frame ${under}: the receipt is visible (${opening[under]?.["receipt"]?.state ?? ""}) while the Tuner panel stands`,
				)
			const shownAt = opening.findIndex(
				f => f["receipt"]?.vis === "visible" && f["receipt"]?.state === "shown",
			)
			const yieldedAt = opening.findIndex(
				(f, i) =>
					i > shownAt &&
					f["receipt"]?.vis === "hidden" &&
					f["receipt"]?.state === "yielded" &&
					f["panel"] !== null,
			)
			if (shownAt < 0 || yieldedAt < 0)
				violations.push(
					`no observed change of the receipt from shown to yielded as the Tuner panel opened (${opening.length} frames)`,
				)
			const panelBox = await page.locator(named.panel).boundingBox()
			if (panelBox)
				rects["tuner panel"] = fmt({
					x: panelBox.x,
					y: panelBox.y,
					w: panelBox.width,
					h: panelBox.height,
				})
			// (b) covered: out of sight, inert, the element at Undo's centre is not Undo; listed as waiting
			const open = await snapshot(page)
			if (!open.waiting.includes("status:receipt"))
				violations.push("the yielded receipt is not listed in data-wk-waiting")
			if (await hitsItself(page, UNDO))
				violations.push("Undo is reachable under the open Tuner panel")
			const inert = await page.evaluate(
				sel => document.querySelector(sel)?.closest("[inert]") != null,
				RECEIPT_SEL,
			)
			if (!inert) violations.push("the yielded receipt is not inert")
			const focusIn = await page.evaluate(
				() =>
					document
						.querySelector("[data-wk-notice-region]")
						?.contains(document.activeElement) ?? false,
			)
			if (focusIn)
				violations.push("the focus stayed in the notice region under the panel")
			if (!(await toggle.evaluate(el => el === document.activeElement)))
				violations.push(
					"the focus did not move from Undo to the Tuner's trigger as the panel opened",
				)
			// (c) its clock does not run while covered: it outlives its whole time with the panel open
			await new Promise(resolve => setTimeout(resolve, RECEIPT_MS + 1500))
			if ((await page.locator(UNDO).count()) === 0)
				violations.push(
					"the receipt's Undo expired under the open Tuner panel (its clock ran while covered)",
				)
			const closed = await sampleDuring(page, named, () =>
				page.keyboard.press("Escape"),
			)
			if (closed.inWindow < MIN_FRAMES) unobserved = true
			const closing = closed.frames
			// no frame with the panel gone and the receipt still yielded (it is back in the same commit)
			const stuck = closing.findIndex(
				(f, i) =>
					i > 0 && f["panel"] === null && f["receipt"]?.state === "yielded",
			)
			if (stuck >= 0)
				violations.push(
					`frame ${stuck}: the Tuner panel is gone but the receipt is still yielded`,
				)
			// and once the frames have stopped: the panel gone, the receipt (if it has not expired yet) not yielded
			const afterClose = await page.evaluate(
				sel => ({
					panel:
						document.querySelector(
							'.wk-shell-island[data-island="tuner"] .wk-shell-panel',
						) !== null,
					state:
						document
							.querySelector(sel)
							?.closest("[data-wk-state]")
							?.getAttribute("data-wk-state") ?? null,
				}),
				RECEIPT_SEL,
			)
			if (afterClose.panel)
				violations.push("the Tuner panel is still open after Escape")
			else if (afterClose.state === "yielded")
				violations.push(
					"the receipt stays yielded after the Tuner panel closed and the frames settled",
				)
			const hiddenFirst = closing.findIndex(
				f => f["receipt"]?.state === "yielded",
			)
			const backAt = closing.findIndex(
				(f, i) =>
					i > hiddenFirst &&
					f["panel"] === null &&
					f["receipt"]?.vis === "visible" &&
					f["receipt"]?.state === "shown",
			)
			if (hiddenFirst < 0 || backAt < 0)
				violations.push(
					`no observed change of the receipt from yielded back to shown as the panel closed (${closing.length} frames)`,
				)
			// from the Escape itself (the sampler's t0): the receipt is shown again in that commit
			const closedAt = closed.at ?? Date.now()
			// where it is back: the first sampled frame it shows again (a later read may come after its remaining time
			// on a starved page)
			const r1 = backAt >= 0 ? (closing[backAt]?.["receipt"] ?? null) : null
			if (!r1)
				violations.push("the receipt is not shown after the panel closed")
			else if (r0 && fmt(r0) !== fmt(r1))
				violations.push(`the receipt moved: ${fmt(r0)} → ${fmt(r1)}`)
			// still there: Undo is reachable (gone already: its expiry time below says whether that was early)
			if (
				!(await hitsItself(page, UNDO)) &&
				(await page.locator(UNDO).count()) > 0
			)
				violations.push(
					"Undo is not the element at its own centre after the panel closed",
				)
			// live again: it expires after about the time it had left (nearly all of it: its clock ran only between the
			// click's press and the panel's first frame), not at once and not never
			const expired = await within(
				RECEIPT_MS + 4000,
				async () => (await page.locator(UNDO).count()) === 0,
			)
			const gone = Date.now() - closedAt
			if (!expired)
				violations.push(
					`the receipt did not expire within ${RECEIPT_MS + 4000} ms of the panel closing (its clock did not resume)`,
				)
			else {
				rects["receipt left after close (ms)"] = String(gone)
				if (gone < RECEIPT_MS - 2000)
					violations.push(
						`the receipt expired ${gone} ms after the panel closed: its clock ran while it was covered`,
					)
			}
			return {
				cell: {
					viewport: vp,
					drawer: "none, Tuner panel over the receipt",
					rects,
					violations,
				},
				unobserved,
			}
		}

		// the Map view: its chrome is laid out with the rest; the Live chip keeps its rectangle when a drawer opens
		for (const [W, H] of [
			[1280, 800],
			...VIEWPORTS.filter(([w]) => w !== 1280),
		] as [number, number][]) {
			const vp = `${W}x${H}`
			phase = `${vp}: the map`
			await page.setViewportSize({ width: W, height: H })
			await go("#/map")
			await page
				.locator('[data-wk-slot="map:live"][data-wk-rect]')
				.waitFor({ timeout: 60_000 })
			await holdToasts(page)
			const MAP = ["map:live|map:corner", "map:rail", "map:footer|map:corner"]
			const bare = await settled(page)
			cells.push({
				viewport: vp,
				drawer: "map",
				rects: Object.fromEntries(bare.slots.map(sl => [sl.name, fmt(sl)])),
				violations: check(bare, MAP, true),
			})
			await go("#/activity?view=map")
			await page
				.locator(".wk-shell-drawer .wka-drawer")
				.first()
				.waitFor({ timeout: STEP_MS })
			await holdToasts(page)
			const open = await settled(page)
			const violations = check(open, MAP, true)
			const a = bare.slots.find(sl => sl.name === "map:live")
			const b = open.slots.find(sl => sl.name === "map:live")
			if (a && b && fmt(a) !== fmt(b))
				violations.push(
					`M3 map:live moved ${fmt(a)} → ${fmt(b)} with Activity open`,
				)
			const dock = open.slots.find(sl => sl.name === "dock")
			if (b && dock && hits(b, dock))
				violations.push(`M3 map:live ${fmt(b)} inside the dock ${fmt(dock)}`)
			cells.push({
				viewport: vp,
				drawer: "map, activity",
				rects: Object.fromEntries(open.slots.map(sl => [sl.name, fmt(sl)])),
				violations,
			})
		}
		await go("")

		await advisory({ level: "none", endEpisode: true })
		await motionOn()
		await page.evaluate(() => {
			const a = document.activeElement
			if (a instanceof HTMLElement) a.blur()
		})
		const missing = setup.filter(s => s.includes("MISSING"))
		return {
			ok:
				missing.length === 0 &&
				cells.every(c => c.violations.length === 0) &&
				moved.length === 0 &&
				frames.length === 0,
			cells,
			moved,
			frames,
			ticks,
			setup,
		}
	}
}
