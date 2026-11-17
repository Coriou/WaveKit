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
 * - during one drawer opening per viewport, and when playback starts, every rendered frame for 400 ms (1200 ms for
 *   playback): no two slots intersect.
 * It runs with CSS transitions and animations switched off, so every box is a settled one: the frame sampler sees
 * each render the layout commits on the way (a drawer's loading skeleton, a first unmeasured pass), not motion
 * between two of them; no per-frame motion is checked. `ticks` says how many animation frames the sampler saw
 * (none means the headless page produced no frames to sample).
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

interface Snapshot {
	slots: SlotBox[]
	chips: Box[]
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
	{ name: "settings", hash: "#/settings", ready: ".wkf-set-head" },
]
/** Onset (6 s of core time) plus the snapshot cadence and a margin (ms). */
const NOTICE_MS = 15_000
const STEP_MS = 10_000
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
		const slots = [...document.querySelectorAll("[data-wk-slot]")]
			.filter(shown)
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
		return {
			slots,
			// the chip itself (its lead line runs down to the peak, under whatever is there)
			chips: all(".wk-plot-sig > button"),
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

function check(s: Snapshot): string[] {
	const out: string[] = []
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
	for (const c of s.chips)
		for (const sl of placed)
			if (hits(c, sl)) out.push(`I5 chip ${fmt(c)} under ${sl.name}`)
	const guests = placed.filter(
		sl => sl.name.startsWith("status:") || sl.name === "player",
	)
	for (const g of guests)
		for (const r of [...s.chips, ...s.rows])
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
	if (stackTop !== undefined && s.vh >= 560) {
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

/** Samples every slot box on each animation frame for `ms` while `act` runs; the intersections seen. */
async function framesDuring(
	page: Page,
	act: () => Promise<void>,
	ms = 400,
): Promise<string[]> {
	await page.evaluate(ms => {
		const w = window as unknown as { __wkFrames?: string[]; __wkTicks?: number }
		w.__wkFrames = []
		w.__wkTicks = 0
		const end = performance.now() + ms
		const tick = () => {
			w.__wkTicks = (w.__wkTicks ?? 0) + 1
			const boxes = [
				...document.querySelectorAll("[data-wk-slot][data-wk-rect]"),
			]
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
			if (performance.now() < end) requestAnimationFrame(tick)
		}
		requestAnimationFrame(tick)
	}, ms)
	await act()
	await new Promise(resolve => setTimeout(resolve, ms + 100))
	const got = await page.evaluate(() => {
		const w = window as unknown as { __wkFrames?: string[]; __wkTicks?: number }
		return { seen: [...new Set(w.__wkFrames ?? [])], ticks: w.__wkTicks ?? 0 }
	})
	ticks.push(got.ticks)
	return got.seen
}

/** Animation frames each sample saw. */
let ticks: number[] = []

export async function layoutFlow(
	page: Page,
	mockApi: string,
): Promise<LayoutReport> {
	const setup: string[] = []
	ticks = []
	let phase = "start"
	try {
		return await run()
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : ""
		setup.push(`MISSING: stopped at ${phase}: ${message ?? ""}`)
		return { ok: false, cells: [], moved: [], frames: [], ticks, setup }
	}

	async function run(): Promise<LayoutReport> {
		const cells: LayoutCell[] = []
		const moved: string[] = []
		const frames: string[] = []
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
		const player = page.locator("[data-wk-transport]")

		// settled geometry: in a headless page on a loaded host a CSS transition (the card's glide, a drawer's
		// foot) advances only when something else asks for a frame, so the DOM trails the layout by one change;
		// with transitions off every box is where the layout put it at once (reduced motion is no help: the kit
		// gives every property a 0.01 ms transition then, which waits for a frame just the same)
		const still = await page.addStyleTag({
			content:
				"*, *::before, *::after { transition: none !important; animation: none !important }",
		})
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
		const startFrames = await framesDuring(page, play, 1200)
		frames.push(...startFrames.map(f => `1440x900 playback start: ${f}`))
		setup.push(`player: ${(await player.count()) > 0 ? "shown" : "MISSING"}`)

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
			setup.push(
				`${vp}: condition ${(await condition.count()) > 0 ? "shown" : "MISSING"}, receipt ${(await receipt.count()) > 0 ? "shown" : "MISSING"}${why && why !== "the focus is not in the region" ? ` (${why})` : ""}, held ${held}`,
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
					await go(d.hash)
					await page
						.locator(`.wk-shell-drawer ${d.ready}`)
						.first()
						.waitFor({ timeout: STEP_MS })
				}
				if (!sampled) {
					const seen = await framesDuring(page, open)
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
		}
		await advisory({ level: "none", endEpisode: true })
		await still.evaluate(el => {
			el.parentNode?.removeChild(el)
		})
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
