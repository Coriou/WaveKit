/**
 * `node scripts/ui-check.mjs --flow=hints`: every hint, reached and measured the way a person would meet it, on
 * the web app's own mock core (fake target only).
 *
 * At 1440×900 and 390×844, with Listen's Audio options open and Sound unfolded: Tab walks the panel from its
 * first control, and every hint mark must be reached; keyboard focus shows its hint at once; the bubble lies
 * inside its host surface and the window (not clipped), and meets no other island and never its own row; Enter
 * pins it (a learn card when it has one); a bubble cut to the room beside its row (none fits whole) scrolls, and
 * the keyboard reaches it (the flow makes a learn card longer than the window, so a cut card is met at both
 * sizes, never by chance of what stands beside the panel): Tab from the mark goes into it, ArrowDown and End scroll it, Shift+Tab goes back to
 * the mark; focus in it goes back to the mark, never to the page, when it becomes whole (the hint stays open),
 * when a scroll elsewhere closes it and when a real click on nothing focusable closes it (a click on something
 * focusable keeps the focus it gives); no bubble is drawn with less
 * room than its padding, border and two lines; Escape closes the hint and leaves focus on the mark and the panel open. At 390×844 a tap (a touch pointer, then the click) pins it, and a tap elsewhere closes it. At 1440×900
 * a mouse opens the first hint after the delay, keeps it over the bubble and closes it once it leaves the
 * bubble; a hint keyboard focus showed stays while the mouse comes and goes, and Escape closes it; and with a
 * hint open, another island moved over its room makes the bubble move off it within a frame or two. It runs
 * with reduced motion, so each hint must appear whole at once.
 *
 * The mock core is seeded through its own API into three states, each a step with the exact set of marks it
 * must show, at both sizes, and at 390×844 no part of the panel wider than the panel: live audio off (the
 * mock's start state), a tone squelch set and waiting for its tone (a long label, DCS 023N: the walk above
 * runs in this state), and no live audio at all (the status route answers 404 in this page only).
 */
import type { Locator, Page } from "playwright-core"
import { within } from "./harness.ts"

const STEP_MS = 10_000
/** Tab presses before giving up on reaching the end of the panel. */
const MAX_TABS = 60

/** The marks each seeded state shows in the panel, Sound unfolded, by the explained control's name. */
const MARKS_OFF = [
	"Squelch",
	"Voice only",
	"Source",
	"Level control",
	"De-emphasis",
] as const
const MARKS_TONE = [...MARKS_OFF, "Tone squelch"] as const
const MARKS_MISSING = ["Squelch"] as const
/** A synthetic tone with the longest label the row shows ("Waiting for DCS 023N"). */
const SEED_TONE = { kind: "dcs", code: "023", polarity: "normal" } as const
const SEED_TONE_WAITING = "Waiting for DCS 023N"

const VIEWPORTS = [
	{ name: "1440x900", width: 1440, height: 900, tap: false },
	{ name: "390x844", width: 390, height: 844, tap: true },
] as const

export interface HintCase {
	viewport: string
	mark: string
	/** The mark's accessible name ("About Squelch"). */
	label: string
	how: "focus" | "enter" | "tap"
	ok: boolean
	problems: string[]
	side: string | null
	role: string | null
	bubble: { x: number; y: number; width: number; height: number } | null
	/** Neither side of its row had room for all of it: cut to the roomier side, its body scrolls. */
	cut: boolean
}

export interface HintsReport {
	ok: boolean
	/** Marks found in the panel, per viewport. */
	marks: Record<string, number>
	/** Marks Tab reached, per viewport. */
	reached: Record<string, number>
	cases: HintCase[]
	steps: { step: string; ok: boolean; detail: string }[]
}

interface Measure {
	open: boolean
	role: string | null
	side: string | null
	expanded: string | null
	focusOnMark: boolean
	panelOpen: boolean
	bubble: { x: number; y: number; width: number; height: number } | null
	problems: string[]
	/** Cut to the room beside its row (no side had room for all of it): its body scrolls. */
	cut: boolean
}

/** Measures the open hint of `id` in the page: inside its host and the window, off its row and other islands. */
const measure = (page: Page, id: string): Promise<Measure> =>
	page.evaluate(markId => {
		const HOST = "[data-wk-hint-host], .wk-island[data-expanded], .wk-drawer"
		const SLACK = 0.5
		/** The placement's inset from its host's edges (hint-place.ts, HINT_INSET). */
		const INSET = 12
		const mark = document.querySelector<HTMLElement>(
			`[data-wk-hint-mark="${markId}"]`,
		)
		const bubble = document.querySelector<HTMLElement>(
			`[data-wk-hint-bubble="${markId}"]`,
		)
		const toggle = document.querySelector('button[aria-label="Audio options"]')
		const base = {
			open: bubble !== null,
			role: bubble?.getAttribute("role") ?? null,
			side: bubble?.dataset["side"] ?? null,
			expanded: mark?.getAttribute("aria-expanded") ?? null,
			focusOnMark: document.activeElement === mark,
			panelOpen: toggle?.getAttribute("aria-expanded") === "true",
		}
		if (!mark || !bubble)
			return { ...base, bubble: null, problems: [], cut: false }
		// open but not drawn: no room beside its row for even a short cut (never in the Listen panel)
		if (bubble.hidden)
			return {
				...base,
				bubble: null,
				problems: ["no room to show it"],
				cut: false,
			}
		const b = bubble.getBoundingClientRect()
		const problems: string[] = []
		const meets = (r: DOMRect) =>
			Math.min(b.right, r.right) - Math.max(b.left, r.left) > SLACK &&
			Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) > SLACK
		if (
			b.left < -SLACK ||
			b.top < -SLACK ||
			b.right > innerWidth + SLACK ||
			b.bottom > innerHeight + SLACK
		)
			problems.push("clipped by the window")
		const host = mark.closest(HOST)
		if (host && bubble.dataset["outside"] !== undefined) {
			// no room beside its row in the host: out of it, in the window INSET in, never over the host
			if (
				b.left < INSET - SLACK ||
				b.top < INSET - SLACK ||
				b.right > innerWidth - INSET + SLACK ||
				b.bottom > innerHeight - INSET + SLACK
			)
				problems.push("out of its host, but not inside the window")
			if (meets(host.getBoundingClientRect()))
				problems.push("out of its host, but over it")
		} else if (host) {
			const h = host.getBoundingClientRect()
			// the box the placement uses: the host clipped to the window, INSET in from every edge
			if (
				b.left < Math.max(h.left, 0) + INSET - SLACK ||
				b.top < Math.max(h.top, 0) + INSET - SLACK ||
				b.right > Math.min(h.right, innerWidth) - INSET + SLACK ||
				b.bottom > Math.min(h.bottom, innerHeight) - INSET + SLACK
			)
				problems.push("outside its host")
		} else problems.push("no host surface")
		const row = mark.closest("[data-wk-hint-row]") ?? mark.parentElement
		// never over its own row: with no room for all of it on either side, the bubble is cut, not laid over
		if (row && meets(row.getBoundingClientRect()))
			problems.push("over its own row")
		const cut = bubble.dataset["scroll"] !== undefined
		if (cut && bubble.scrollHeight <= bubble.clientHeight + 1)
			problems.push("cut, but nothing to scroll")
		if (cut && bubble.tabIndex !== 0)
			problems.push("cut, but the keyboard cannot reach it")
		for (const island of document.querySelectorAll(".wk-island")) {
			if (island === host || host?.contains(island) || island.contains(mark))
				continue
			const r = island.getBoundingClientRect()
			if (r.width === 0 || r.height === 0) continue
			// an island out of sight (yielded to the open panel) is not met
			if (getComputedStyle(island).visibility === "hidden") continue
			if (meets(r))
				problems.push(
					`meets another island (${island.closest("[data-island]")?.getAttribute("data-island") ?? island.className})`,
				)
		}
		// visibly open: not transparent once its fade is done
		if (Number(getComputedStyle(bubble).opacity) < 0.99)
			problems.push("not fully shown")
		return {
			...base,
			bubble: {
				x: Math.round(b.left),
				y: Math.round(b.top),
				width: Math.round(b.width),
				height: Math.round(b.height),
			},
			problems,
			cut,
		}
	}, id)

/**
 * The keyboard in a cut (scrolling) bubble whose mark has focus: Tab moves into it, ArrowDown and End scroll it,
 * Shift+Tab returns to the mark, and Tab goes back in. The problems found; the hint is left open with focus in
 * the bubble, so the caller's Escape checks that closing from inside it puts focus back on the mark.
 */
async function cutByKeyboard(page: Page, id: string): Promise<string[]> {
	const problems: string[] = []
	const where = () =>
		page.evaluate(markId => {
			const bubble = document.querySelector<HTMLElement>(
				`[data-wk-hint-bubble="${markId}"]`,
			)
			const at = document.activeElement
			return {
				inBubble: bubble !== null && at !== null && bubble.contains(at),
				onMark: at?.getAttribute("data-wk-hint-mark") === markId,
				scrollTop: bubble?.scrollTop ?? 0,
				range: bubble ? bubble.scrollHeight - bubble.clientHeight : 0,
				active: at?.className || at?.tagName || "none",
			}
		}, id)
	await page.keyboard.press("Tab")
	if (!(await where()).inBubble)
		problems.push("Tab did not go into the cut card")
	// ArrowDown: a step down (the scroll may animate, so wait for it)
	await page.evaluate(markId => {
		const w = window as unknown as { wkFlowScrollEnded?: boolean }
		w.wkFlowScrollEnded = false
		document
			.querySelector(`[data-wk-hint-bubble="${markId}"]`)
			?.addEventListener(
				"scrollend",
				() => {
					w.wkFlowScrollEnded = true
				},
				{ once: true },
			)
	}, id)
	await page.keyboard.press("ArrowDown")
	if (
		!(await withinFrames(
			page,
			2_000,
			async () => (await where()).scrollTop > 0,
		))
	) {
		const w = await where()
		problems.push(
			`ArrowDown did not scroll the cut card (range ${w.range}, focus ${w.active})`,
		)
	}
	// the step's scroll over (its scrollend, or its offset held a few frames), as a person's next key comes
	// after the step lands: a key pressed while the browser still animates the last one can be lost
	let last = -1
	let since = 0
	await withinFrames(page, 2_000, async () => {
		const ended = await page.evaluate(
			() =>
				(window as unknown as { wkFlowScrollEnded?: boolean })
					.wkFlowScrollEnded === true,
		)
		if (ended) return true
		const now = await frameCount(page)
		const top = (await where()).scrollTop
		if (top !== last) {
			last = top
			since = now
			return false
		}
		return top > 0 && now - since >= STABLE_FRAMES
	})
	// End: the whole range in one key
	await page.keyboard.press("End")
	const atEnd = async () => {
		const w = await where()
		return Math.abs(w.scrollTop - w.range) <= 1
	}
	if (!(await withinFrames(page, 2_000, atEnd))) {
		const w = await where()
		problems.push(
			`End did not scroll the cut card to its end (at ${w.scrollTop} of ${w.range}, focus ${w.active})`,
		)
	}
	await page.keyboard.press("Shift+Tab")
	if (!(await where()).onMark)
		problems.push("Shift+Tab did not go back to the mark")
	await page.keyboard.press("Tab")
	if (!(await where()).inBubble)
		problems.push("Tab did not go back into the card")
	return problems
}

/** Where focus is, and the hint's state, for the focus-return checks of a cut bubble. */
const focusState = (page: Page, id: string) =>
	page.evaluate(markId => {
		const bubble = document.querySelector<HTMLElement>(
			`[data-wk-hint-bubble="${markId}"]`,
		)
		const at = document.activeElement
		return {
			open: bubble !== null,
			cut: bubble?.dataset["scroll"] !== undefined,
			inBubble: bubble !== null && at !== null && bubble.contains(at),
			onMark: at?.getAttribute("data-wk-hint-mark") === markId,
			active: at?.className || at?.tagName || "none",
		}
	}, id)

/**
 * Focus in a cut bubble is never dropped to the page: when the bubble becomes whole (its content shrinks) focus
 * goes to the mark and the hint stays open; when a scroll elsewhere or a real click on nothing focusable closes
 * it, focus goes to the mark and stays there through the whole click; a real click on something focusable (another
 * mark) closes it and keeps the focus it gives. Starts and ends with the hint pinned, cut, and focus in it.
 */
async function cutKeepsFocus(page: Page, id: string): Promise<string[]> {
	const problems: string[] = []
	const backIn = async (what: string) => {
		if (
			!(await withinFrames(
				page,
				2_000,
				async () => (await focusState(page, id)).cut,
			))
		)
			problems.push(`${what}: the card is not cut again`)
		await page.keyboard.press("Tab")
		if (!(await focusState(page, id)).inBubble)
			problems.push(`${what}: Tab did not go back into the card`)
	}
	// whole again: the learn rows hidden, the lead alone fits beside the row
	await page.evaluate(markId => {
		const style = document.createElement("style")
		style.id = "wk-flow-shrink"
		style.textContent = `[data-wk-hint-bubble="${markId}"] > :not(:first-child) { display: none }`
		document.head.append(style)
	}, id)
	const whole = await withinFrames(
		page,
		2_000,
		async () => !(await focusState(page, id)).cut,
	)
	const w = await focusState(page, id)
	if (!whole) problems.push("shrunk, the card stayed cut")
	else {
		if (!w.open) problems.push("whole again, the hint closed")
		if (!w.onMark) problems.push(`whole again, focus went to ${w.active}`)
	}
	await page.evaluate(() => document.getElementById("wk-flow-shrink")?.remove())
	await backIn("after whole")
	// a scroll elsewhere (past the settle time after opening) closes it: focus to the mark
	await page.waitForTimeout(300)
	await page.evaluate(() => document.dispatchEvent(new Event("scroll")))
	await withinFrames(
		page,
		2_000,
		async () => !(await focusState(page, id)).open,
	)
	const scrolled = await focusState(page, id)
	if (scrolled.open) problems.push("a scroll elsewhere left it open")
	if (!scrolled.onMark)
		problems.push(`a scroll elsewhere dropped focus to ${scrolled.active}`)
	await page.keyboard.press("Enter")
	await backIn("after the scroll")
	// a real click on nothing focusable closes it: focus to the mark, and still there once the whole click
	// (down, up, click) is over
	const plain = await plainPoint(page, id)
	if (!plain) problems.push("no plain text in the panel to click")
	else {
		await page.mouse.click(plain.x, plain.y)
		await withinFrames(
			page,
			2_000,
			async () => !(await focusState(page, id)).open,
		)
		await frames(page, 2)
		const clicked = await focusState(page, id)
		if (clicked.open) problems.push(`a click on ${plain.what} left it open`)
		if (!clicked.onMark)
			problems.push(
				`a click on ${plain.what} dropped focus to ${clicked.active}`,
			)
		await page.keyboard.press("Enter")
		await backIn("after the click")
	}
	// a real click on something focusable (another hint's mark) closes it and keeps the focus it gives
	const other = await page.evaluate(markId => {
		const panel = document.querySelector(
			'[role="region"][aria-label="Audio options"]',
		)
		// one a click lands on as it stands: in the window and not under the card (no scroll to it, which
		// would close the hint before the click)
		for (const m of panel?.querySelectorAll<HTMLElement>(
			"[data-wk-hint-mark]",
		) ?? []) {
			if (m.dataset["wkHintMark"] === markId) continue
			const r = m.getBoundingClientRect()
			const x = Math.round(r.left + r.width / 2)
			const y = Math.round(r.top + r.height / 2)
			if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
			const hit = document.elementFromPoint(x, y)
			if (hit && m.contains(hit))
				return { id: m.dataset["wkHintMark"] ?? "", x, y }
		}
		return null
	}, id)
	if (!other) problems.push("no other mark to click beside the card")
	else {
		await page.mouse.click(other.x, other.y)
		await withinFrames(
			page,
			2_000,
			async () => !(await focusState(page, id)).open,
		)
		const onOther = await page.evaluate(
			otherId =>
				document.activeElement?.getAttribute("data-wk-hint-mark") === otherId,
			other.id,
		)
		if ((await focusState(page, id)).open)
			problems.push("a click on another mark left it open")
		if (!onOther)
			problems.push(
				`a click on another mark put focus on ${(await focusState(page, id)).active}`,
			)
		// close the other mark's hint, move the mouse off every mark, and come back to this one
		if ((await measure(page, other.id)).open)
			await page.keyboard.press("Escape")
		if (plain) await page.mouse.move(plain.x, plain.y)
		await page.locator(`[data-wk-hint-mark="${id}"]`).focus()
		await page.keyboard.press("Enter")
		await withinFrames(page, 2_000, async () => (await measure(page, id)).open)
		await backIn("after the click on another mark")
	}
	return problems
}

/**
 * A point in the Audio options panel on plain text: nothing focusable, no hint mark, label or bubble under it.
 * Null when the panel shows none.
 */
const plainPoint = (page: Page, id: string) =>
	page.evaluate(markId => {
		const FOCUSABLE =
			'a[href], button, input, select, textarea, summary, label, [tabindex], [contenteditable]:not([contenteditable="false"]), [role]:not([role="region"]):not([role="group"]):not([role="presentation"])'
		const panel = document.querySelector(
			'[role="region"][aria-label="Audio options"]',
		)
		const bubble = document.querySelector(`[data-wk-hint-bubble="${markId}"]`)
		if (!panel) return null
		const p = panel.getBoundingClientRect()
		for (
			let y = Math.max(p.top, 0) + 4;
			y < Math.min(p.bottom, innerHeight) - 4;
			y += 6
		)
			for (let x = p.left + 4; x < p.right - 4; x += 6) {
				const el = document.elementFromPoint(x, y)
				if (!el || !panel.contains(el) || bubble?.contains(el)) continue
				if (el.closest(FOCUSABLE) || el.closest(".wk-hint-anchor")) continue
				if (!(el.textContent ?? "").trim()) continue
				// on the text itself, not the gap beside it
				const range = document.createRange()
				range.selectNodeContents(el)
				const onText = [...range.getClientRects()].some(
					r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
				)
				if (!onText) continue
				return {
					x,
					y,
					what: `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 24)}"`,
				}
			}
		return null
	}, id)

/**
 * A pinned hint with no room anywhere for even its shortest cut (its lines made taller than the window) is
 * not drawn, and the mark says so: not expanded, controlling nothing, still described by the sentence; focus is
 * on the mark. With its lines back, Escape and Enter pin it again, drawn and expanded. Left pinned.
 */
async function noRoomNotExpanded(page: Page, id: string): Promise<string[]> {
	const problems: string[] = []
	const state = () =>
		page.evaluate(markId => {
			const mark = document.querySelector(`[data-wk-hint-mark="${markId}"]`)
			const bubble = document.querySelector<HTMLElement>(
				`[data-wk-hint-bubble="${markId}"]`,
			)
			const d = mark?.getAttribute("aria-describedby")?.split(" ")[0] ?? ""
			return {
				mounted: bubble !== null,
				hidden: bubble?.hidden ?? true,
				expanded: mark?.getAttribute("aria-expanded") ?? null,
				controls: mark?.getAttribute("aria-controls") ?? null,
				described: (document.getElementById(d)?.textContent ?? "").length > 0,
			}
		}, id)
	// the lines grow before the hint opens: a cut bubble's box would not change, so nothing would re-place it
	await page.keyboard.press("Escape")
	await page.evaluate(markId => {
		const style = document.createElement("style")
		style.id = "wk-flow-no-room"
		style.textContent = `[data-wk-hint-bubble="${markId}"] { line-height: 2000px !important }`
		document.head.append(style)
	}, id)
	await page.keyboard.press("Enter")
	const gone = await withinFrames(page, 2_000, async () => {
		const s = await state()
		return s.mounted && s.hidden && s.expanded === "false"
	})
	const s = await state()
	if (!gone)
		problems.push(
			`no room: hidden ${s.hidden}, aria-expanded ${s.expanded}, controls ${s.controls}`,
		)
	if (s.controls !== null) problems.push("no room: still controls the bubble")
	if (!s.described) problems.push("no room: the mark lost its sentence")
	const onMark = await page.evaluate(
		markId =>
			document.activeElement?.getAttribute("data-wk-hint-mark") === markId,
		id,
	)
	if (!onMark) problems.push("no room: focus is not on the mark")
	await page.evaluate(() =>
		document.getElementById("wk-flow-no-room")?.remove(),
	)
	await page.keyboard.press("Escape")
	await page.keyboard.press("Enter")
	const back = await withinFrames(page, 2_000, async () => {
		const t = await state()
		return !t.hidden && t.expanded === "true" && t.controls !== null
	})
	if (!back) problems.push("room again: not drawn or not expanded")
	return problems
}

/** The style `pinnedTall` adds: the last line of a learn card below its lead made taller. */
const TALL_STYLE = "wk-flow-tall"
/** How much taller than the roomier side of its row `pinnedTall` makes a learn card (px): a short scroll. */
const TALL_OVER = 80

/**
 * A learn card made longer than its host can hold beside its row, as a long card would be: its last line below
 * the lead grows until the whole card is `TALL_OVER` px taller than the room on either side of the row, so
 * neither side has room for all of it and it is cut to the roomier side, with a short scroll as a real long
 * card has (the lead alone still fits, so hiding those lines, as `cutKeepsFocus` does, makes it whole). The cut
 * is the flow's own, at every size: never left to an island that happens to stand beside the panel. From the
 * pinned (whole) hint with focus on the mark: the card's size is read, then Escape, the taller line, and Enter
 * places it afresh. The measure of the pinned card, left pinned with focus on the mark; `dropTall` takes the
 * line back.
 */
async function pinnedTall(page: Page, id: string): Promise<Measure> {
	const grown = await page.evaluate(
		([markId, styleId, over]) => {
			const HOST = "[data-wk-hint-host], .wk-island[data-expanded], .wk-drawer"
			const INSET = 12
			const mark = document.querySelector(`[data-wk-hint-mark="${markId}"]`)
			const bubble = document.querySelector(`[data-wk-hint-bubble="${markId}"]`)
			const host = mark?.closest(HOST)
			const row = mark?.closest("[data-wk-hint-row]") ?? mark?.parentElement
			if (!bubble || !host || !row) return null
			const b = bubble.getBoundingClientRect()
			const h = host.getBoundingClientRect()
			const k = row.getBoundingClientRect()
			// the host's box the placement uses (clipped to the window, INSET in): each side's room is at most
			// the box beside the row, gap not taken off
			const top = Math.max(h.top, 0) + INSET
			const bottom = Math.min(h.bottom, innerHeight) - INSET
			const room = Math.max(k.top - top, bottom - k.bottom)
			const grow = Math.ceil(room + over - b.height)
			const style = document.createElement("style")
			style.id = styleId
			style.textContent = `[data-wk-hint-bubble="${markId}"] > :not(:first-child):last-child { padding-bottom: ${Math.max(0, grow)}px }`
			document.head.append(style)
			return grow
		},
		[id, TALL_STYLE, TALL_OVER] as const,
	)
	await page.keyboard.press("Escape")
	await page.keyboard.press("Enter")
	if (grown !== null)
		await withinFrames(page, 2_000, async () => (await measure(page, id)).cut)
	return settled(page, id)
}

/** Takes back the taller lines `pinnedTall` added. */
const dropTall = (page: Page): Promise<void> =>
	page.evaluate(
		styleId => document.getElementById(styleId)?.remove(),
		TALL_STYLE,
	)

/** Waits for `n` animation frames in the page: layout and the hints' per-frame re-placing have run. */
const frames = (page: Page, n = 2): Promise<void> =>
	page.evaluate(
		count =>
			new Promise<void>(done => {
				const tick = (left: number) =>
					left <= 0 ? done() : requestAnimationFrame(() => tick(left - 1))
				tick(count)
			}),
		n,
	)

/** Animation frames the page has drawn since the flow first asked (a counter it keeps from then on). */
const frameCount = (page: Page): Promise<number> =>
	page.evaluate(() => {
		const w = window as unknown as { wkFlowFrames?: number }
		if (w.wkFlowFrames === undefined) {
			w.wkFlowFrames = 0
			const tick = () => {
				w.wkFlowFrames = (w.wkFlowFrames ?? 0) + 1
				requestAnimationFrame(tick)
			}
			requestAnimationFrame(tick)
		}
		return w.wkFlowFrames
	})

/** Frames a frame-driven change is given at least: a ResizeObserver's re-place, a smooth keyboard scroll. */
const SETTLE_FRAMES = 12
/** The longest a frame-driven wait lasts, however few frames the page draws. */
const SETTLE_CAP_MS = 20_000

/**
 * `within` for what the page does in its animation frames (a ResizeObserver, the hints' per-frame re-placing,
 * a smooth keyboard scroll): gives up only once `ms` have passed and the page has drawn `SETTLE_FRAMES`
 * frames since the wait began (`SETTLE_CAP_MS` at most). A page short of frames (a loaded host, a software
 * GPU drew one or two a second) gets the frames the change needs, not only the wall time; one that never
 * makes the change still fails.
 */
async function withinFrames(
	page: Page,
	ms: number,
	check: () => boolean | Promise<boolean>,
): Promise<boolean> {
	const start = Date.now()
	const left = () => SETTLE_CAP_MS - (Date.now() - start)
	// every browser call races the cap: a stalled page cannot hold the wait past it
	const capped = async <T>(work: Promise<T>): Promise<T | typeof LATE> => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const late = new Promise<typeof LATE>(done => {
			timer = setTimeout(() => done(LATE), Math.max(0, left()))
		})
		try {
			return await Promise.race([work, late])
		} finally {
			clearTimeout(timer)
		}
	}
	const from = await capped(frameCount(page))
	if (from === LATE) return false
	for (;;) {
		const ok = await capped(Promise.resolve(check()))
		// a success seen after the cap is not a success
		if (ok === LATE || left() < 0) return false
		if (ok) return true
		const spent = Date.now() - start
		if (spent > ms) {
			const now = await capped(frameCount(page))
			if (now === LATE || now - from >= SETTLE_FRAMES) return false
		}
		await page.waitForTimeout(50)
	}
}

/** What a capped browser call gives when the cap passed first. */
const LATE = Symbol("late")

/**
 * Brings `mark` into view in its scroller without Playwright's stability wait (it needs steady frames a
 * loaded page does not draw), then waits on frames until it is in the window.
 */
async function intoView(page: Page, mark: Locator): Promise<boolean> {
	await mark.evaluate(el => el.scrollIntoView({ block: "nearest" }))
	return withinFrames(page, 2_000, () =>
		mark.evaluate(el => {
			const r = el.getBoundingClientRect()
			return (
				r.width > 0 &&
				r.top >= 0 &&
				r.left >= 0 &&
				r.bottom <= window.innerHeight &&
				r.right <= window.innerWidth
			)
		}),
	)
}

/** Frames a hint's place must hold for before it is measured as settled. */
const STABLE_FRAMES = 3

/**
 * Waits until the hint of `id` is open, its fade is done and its place (box, cut, side, role) has held for
 * `STABLE_FRAMES` drawn frames, then measures it: the hints re-place in their frames as the layout under them
 * converges, so a loaded page's first open frame is not yet where the hint stands.
 */
async function settled(page: Page, id: string): Promise<Measure> {
	let key = ""
	let since = 0
	await withinFrames(page, 2_000, async () => {
		const m = await measure(page, id)
		if (!m.open || m.problems.includes("not fully shown")) {
			key = ""
			return false
		}
		const now = await frameCount(page)
		const k = JSON.stringify([m.bubble, m.cut, m.side, m.role, m.expanded])
		if (k !== key) {
			key = k
			since = now
			return false
		}
		return now - since >= STABLE_FRAMES
	})
	return measure(page, id)
}

/**
 * A mouse opens the hint of `id` after the delay, the bubble keeps it, leaving the bubble closes it; a hint
 * keyboard focus showed outlasts the mouse coming and going, and Escape closes it.
 */
async function mouseAndFocus(
	page: Page,
	id: string,
	height: number,
	step: (name: string, ok: boolean, detail?: string) => void,
	vp: string,
): Promise<void> {
	const panel = page.getByRole("region", { name: "Audio options" })
	// close an open hint only: an Escape with none open would close the panel
	if ((await measure(page, id)).open) await page.keyboard.press("Escape")
	const mark = panel.locator(`[data-wk-hint-mark="${id}"]`)
	const away = { x: 4, y: Math.round(height / 2) }
	await intoView(page, mark)
	// a real mouse move onto the mark (no actionability wait: a loaded page draws too few frames for it)
	const overMark = async () => {
		const at = await mark.boundingBox({ timeout: 5_000 })
		if (!at) throw new Error("the first mark has no box")
		await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
	}
	await page.mouse.move(away.x, away.y)
	await page.waitForTimeout(150)
	await overMark()
	const hovered = await settled(page, id)
	const box = await page
		.locator(`[data-wk-hint-bubble="${id}"]`)
		.boundingBox({ timeout: 2_000 })
		.catch(() => null)
	let kept = false
	if (box) {
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
		await page.waitForTimeout(400)
		kept = (await measure(page, id)).open
	}
	await page.mouse.move(away.x, away.y)
	const closed = await within(
		2_000,
		async () => !(await measure(page, id)).open,
	)
	step(
		`${vp}: a mouse opens the hint, the bubble keeps it, leaving the bubble closes it`,
		hovered.open && kept && closed,
		`opened ${hovered.open}, kept over the bubble ${kept}, closed after ${closed}`,
	)
	// keyboard focus (Tab onto the mark): the mouse coming and going leaves it open; Escape closes it
	await mark.focus()
	await page.keyboard.press("Shift+Tab")
	await page.keyboard.press("Tab")
	const focused = await settled(page, id)
	await overMark()
	await page.mouse.move(away.x, away.y)
	await page.waitForTimeout(500)
	const stays = await measure(page, id)
	await page.keyboard.press("Escape")
	const escaped = await within(
		2_000,
		async () => !(await measure(page, id)).open,
	)
	step(
		`${vp}: a hint keyboard focus showed outlasts the mouse, Escape closes it`,
		focused.open && stays.open && stays.focusOnMark && escaped,
		`shown ${focused.open}, open after the mouse left ${stays.open}, focus kept ${stays.focusOnMark}, Escape closed it ${escaped}`,
	)
}

/**
 * An open hint follows the layout: with a hint shown by keyboard focus, another island is moved (by transform,
 * which ResizeObserver cannot see) over the bubble, on its side of the row; a frame or two later the bubble
 * must have moved off it to the other side, still inside its host and off its row. The hint is the first one
 * whose row has room for the bubble on both sides (else the move would leave it nowhere to go).
 */
async function islandMoves(
	page: Page,
	ids: readonly string[],
	step: (name: string, ok: boolean, detail?: string) => void,
	vp: string,
): Promise<void> {
	const name = `${vp}: an open hint moves off another island that moves over it`
	const panel = page.getByRole("region", { name: "Audio options" })
	for (const id of ids) {
		if ((await measure(page, id)).open) await page.keyboard.press("Escape")
		const mark = panel.locator(`[data-wk-hint-mark="${id}"]`)
		// no actionability wait: a loaded page draws too few frames for it
		await mark.evaluate(el => el.scrollIntoView({ block: "nearest" }))
		await frames(page, 2)
		await mark.focus()
		await page.keyboard.press("Shift+Tab")
		await page.keyboard.press("Tab")
		const shown = await settled(page, id)
		if (!shown.open) continue
		const moved = await page.evaluate(markId => {
			const HOST = "[data-wk-hint-host], .wk-island[data-expanded], .wk-drawer"
			const INSET = 12
			const GAP = 6
			const m = document.querySelector(`[data-wk-hint-mark="${markId}"]`)
			const bubble = document.querySelector(`[data-wk-hint-bubble="${markId}"]`)
			const host = m?.closest(HOST)
			if (!m || !bubble || !host) return null
			const keep = (
				m.closest("[data-wk-hint-row]") ??
				m.parentElement ??
				m
			).getBoundingClientRect()
			const b = bubble.getBoundingClientRect()
			const h = host.getBoundingClientRect()
			const top = Math.max(h.top, 0) + INSET
			const bottom = Math.min(h.bottom, innerHeight) - INSET
			const below = b.top >= keep.bottom
			// room on the other side: else covering this side leaves the bubble nowhere to go
			const otherFits = below
				? keep.top - GAP - b.height >= top
				: keep.bottom + GAP + b.height <= bottom
			if (!otherFits) return null
			const other = [
				...document.querySelectorAll<HTMLElement>(".wk-island"),
			].find(o => {
				if (o === host || host.contains(o) || o.contains(m)) return false
				const r = o.getBoundingClientRect()
				return r.width > 0 && r.height > 0
			})
			if (!other) return { island: null, covers: false, at: "" }
			const r = other.getBoundingClientRect()
			const was = getComputedStyle(other).transform
			other.dataset["wkHintFlowMoved"] = JSON.stringify({
				transform: other.style.transform,
				transition: other.style.transition,
			})
			// on the bubble's side of the row, its left at the bubble's: it lies over the bubble
			const dx = b.left - r.left
			const dy = below ? keep.bottom + 2 - r.top : keep.top - 2 - r.bottom
			other.style.transition = "none"
			other.style.transform = `translate(${dx}px, ${dy}px)${was === "none" ? "" : ` ${was}`}`
			const n = other.getBoundingClientRect()
			const covers =
				Math.min(b.right, n.right) - Math.max(b.left, n.left) > 0.5 &&
				Math.min(b.bottom, n.bottom) - Math.max(b.top, n.top) > 0.5
			return {
				island:
					other.closest("[data-island]")?.getAttribute("data-island") ??
					other.className,
				covers,
				at: [n, b, keep]
					.map(x =>
						[x.left, x.top, x.right, x.bottom].map(Math.round).join(","),
					)
					.join(" | "),
			}
		}, id)
		if (moved === null) continue
		await frames(page, 2)
		const after = await measure(page, id)
		await page.evaluate(() => {
			for (const el of document.querySelectorAll<HTMLElement>(
				"[data-wk-hint-flow-moved]",
			)) {
				const was = JSON.parse(el.dataset["wkHintFlowMoved"] ?? "{}") as {
					transform?: string
					transition?: string
				}
				el.style.transform = was.transform ?? ""
				el.style.transition = was.transition ?? ""
				delete el.dataset["wkHintFlowMoved"]
			}
		})
		if (after.open) await page.keyboard.press("Escape")
		await frames(page, 2)
		step(
			name,
			moved.island !== null &&
				moved.covers &&
				after.open &&
				after.problems.length === 0 &&
				after.side !== shown.side,
			`${id}: moved ${moved.island ?? "no other island"} over the bubble ${moved.covers} (island | bubble | row: ${moved.at}), side ${shown.side} then ${after.side}, open after ${after.open}, problems: ${after.problems.join(", ") || "none"}`,
		)
		return
	}
	if ((await measure(page, ids[ids.length - 1] ?? "")).open)
		await page.keyboard.press("Escape")
	step(name, false, "no hint with room on both sides of its row")
}

/** One call to the mock core's API (loopback, the run's own mock): throws unless it answers 2xx. */
async function coreCall(
	api: string,
	method: "POST" | "PATCH",
	path: string,
	body?: unknown,
): Promise<void> {
	const answer = await fetch(`${api}${path}`, {
		method,
		...(body === undefined
			? {}
			: {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
	})
	if (!answer.ok)
		throw new Error(
			`${method} ${path}: HTTP ${answer.status} ${await answer.text()}`,
		)
}

/**
 * Reloads the page, so it reads the core's state afresh (a broadcast sent while its socket reconnects after an
 * earlier reload would be missed).
 */
async function reload(page: Page): Promise<void> {
	await page.reload({ waitUntil: "load" })
	await page.locator("#root > *").first().waitFor({ timeout: STEP_MS })
}

/** Every island's box, rounded: the layout a hint is placed against. */
const islandBoxes = (page: Page): Promise<string> =>
	page.evaluate(() =>
		[...document.querySelectorAll(".wk-island")]
			.map(el => {
				const r = el.getBoundingClientRect()
				return [r.left, r.top, r.right, r.bottom].map(Math.round).join(",")
			})
			.join("|"),
	)

/** Waits (5 s at most) until the islands stop moving: after a reload the cards arrive and settle. */
async function layoutSettled(page: Page): Promise<boolean> {
	let last = await islandBoxes(page)
	return within(5_000, async () => {
		await page.waitForTimeout(300)
		const now = await islandBoxes(page)
		const same = now === last
		last = now
		return same
	})
}

/** Opens Listen's Audio options and unfolds Sound; true once the panel is there. */
async function openPanel(page: Page): Promise<boolean> {
	const toggle = page.getByRole("button", { name: "Audio options" })
	const panel = page.getByRole("region", { name: "Audio options" })
	if ((await toggle.getAttribute("aria-expanded")) !== "true")
		await toggle.click()
	const opened = await within(STEP_MS, async () => (await panel.count()) > 0)
	if (!opened) return false
	const fold = panel.locator(".wkf-ls-fold")
	if (
		(await fold.count()) > 0 &&
		(await fold.getAttribute("aria-expanded")) !== "true"
	) {
		await fold.click()
		// let the unfolded panel lay out before the marks are read and measured
		await frames(page, 2)
	}
	return true
}

/** The marks in the panel, by the name of what they explain ("About Squelch" → "Squelch"), sorted. */
const markNames = (page: Page): Promise<string[]> =>
	page
		.getByRole("region", { name: "Audio options" })
		.locator("[data-wk-hint-mark]")
		.evaluateAll(els =>
			els
				.map(e => (e.getAttribute("aria-label") ?? "").replace(/^About /, ""))
				.sort(),
		)

/** What sticks out of the Audio options panel sideways (or makes the page scroll sideways): empty when none. */
const overflowOf = (page: Page): Promise<string[]> =>
	page.evaluate(() => {
		const SLACK = 0.5
		const panel = document.querySelector<HTMLElement>(
			'[role="region"][aria-label="Audio options"]',
		)
		if (!panel) return ["no panel"]
		const out: string[] = []
		if (panel.scrollWidth > panel.clientWidth + 1)
			out.push(
				`panel scrolls sideways (${panel.scrollWidth} > ${panel.clientWidth})`,
			)
		if (document.documentElement.scrollWidth > innerWidth + 1)
			out.push(
				`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`,
			)
		const p = panel.getBoundingClientRect()
		for (const el of panel.querySelectorAll<HTMLElement>("*")) {
			const r = el.getBoundingClientRect()
			if (r.width === 0 || r.height === 0) continue
			// a range input's box is its track: clipped content inside an ellipsis does not count either
			if (r.right > p.right + SLACK || r.left < p.left - SLACK)
				out.push(
					`${el.tagName.toLowerCase()}.${el.className || "-"} "${(el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(r.left)}..${Math.round(r.right)} outside ${Math.round(p.left)}..${Math.round(p.right)}`,
				)
		}
		return out.slice(0, 6)
	})

/** Checks one seeded state: its note or text is shown, the marks are exactly `want`, and at 390 nothing sticks out. */
async function seededState(
	page: Page,
	vp: (typeof VIEWPORTS)[number],
	state: string,
	shows: string,
	want: readonly string[],
	step: (name: string, ok: boolean, detail?: string) => void,
	shoot: (name: string) => Promise<void>,
): Promise<void> {
	const opened = await openPanel(page)
	const panel = page.getByRole("region", { name: "Audio options" })
	const shown =
		opened &&
		(await within(
			STEP_MS,
			async () => (await panel.getByText(shows, { exact: true }).count()) > 0,
		))
	await layoutSettled(page)
	const names = opened ? await markNames(page) : []
	const expected = [...want].sort()
	const same = names.join("|") === expected.join("|")
	step(
		`${vp.name}: ${state}: says "${shows}" with the marks ${expected.join(", ")}`,
		shown && same,
		`shown ${shown}, marks ${names.join(", ") || "none"}`,
	)
	if (vp.tap) {
		const out = opened ? await overflowOf(page) : ["no panel"]
		step(
			`${vp.name}: ${state}: nothing in the panel sticks out sideways`,
			out.length === 0,
			out.join("; "),
		)
	}
	await shoot(`2-hints-${vp.name}-${state.replace(/\W+/g, "-")}`)
}

export async function hintsFlow(
	page: Page,
	/** Saves a screenshot under that name (with `--screenshot`). */
	shoot: (name: string) => Promise<void> = async () => undefined,
	/** The mock core's API origin, for seeding its states (live audio off, a tone squelch waiting). */
	mockApi: string | null = null,
): Promise<HintsReport> {
	const cases: HintCase[] = []
	const steps: HintsReport["steps"] = []
	const marks: Record<string, number> = {}
	const reached: Record<string, number> = {}
	const step = (name: string, ok: boolean, detail = "") =>
		void steps.push({ step: name, ok, detail })
	// reduced motion: a hint must then appear whole at once (no slide, no fade), and the measures are final
	// rather than mid-fade (a loaded headless page can draw too few frames for a transition to finish)
	await page.emulateMedia({ reducedMotion: "reduce" })
	const panel = page.getByRole("region", { name: "Audio options" })

	for (const vp of VIEWPORTS) {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		await page.keyboard.press("Escape")
		if (mockApi !== null)
			try {
				// live audio off, no tone squelch: the mock's start state
				await coreCall(mockApi, "POST", "/api/live-audio/stop")
				await coreCall(mockApi, "PATCH", "/api/live-audio/config", {
					toneSquelch: { kind: "none" },
				})
				await reload(page)
				await seededState(
					page,
					vp,
					"live audio off",
					"Live audio is off. Listen starts it.",
					MARKS_OFF,
					step,
					shoot,
				)
				// a tone squelch set and waiting for its tone: the walk below runs in this state
				await coreCall(mockApi, "POST", "/api/live-audio/start")
				await coreCall(mockApi, "PATCH", "/api/live-audio/config", {
					toneSquelch: SEED_TONE,
				})
				await reload(page)
				await seededState(
					page,
					vp,
					"tone squelch waiting",
					SEED_TONE_WAITING,
					MARKS_TONE,
					step,
					shoot,
				)
			} catch (e) {
				step(
					`${vp.name}: seeding the mock core`,
					false,
					e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e),
				)
			}
		else step(`${vp.name}: seeding the mock core`, false, "no mock core API")
		const opened = await openPanel(page)
		step(`${vp.name}: Audio options open`, opened)
		if (!opened) continue
		const ids = await panel
			.locator("[data-wk-hint-mark]")
			.evaluateAll(els =>
				els.map(e => e.getAttribute("data-wk-hint-mark") ?? ""),
			)
		await shoot(`2-hints-${vp.name}-panel`)
		marks[vp.name] = ids.length
		step(`${vp.name}: marks in the panel`, ids.length > 0, `${ids.length}`)

		// Tab from the panel's first control until focus leaves it
		let cutRuns = 0
		let tallDone = false
		await panel.locator("input, button").first().focus()
		const seen: string[] = []
		for (let i = 0; i < MAX_TABS; i++) {
			await page.keyboard.press("Tab")
			const at = await page.evaluate(() => {
				const el = document.activeElement
				const inPanel =
					el?.closest('[role="region"][aria-label="Audio options"]') !== null
				return {
					inPanel,
					mark: el?.getAttribute("data-wk-hint-mark") ?? null,
					label: el?.getAttribute("aria-label") ?? "",
				}
			})
			if (!at.inPanel) break
			if (at.mark === null || seen.includes(at.mark)) continue
			seen.push(at.mark)
			// focus shows the hint at once (measured once its fade is done)
			const shown = await settled(page, at.mark)
			const focusProblems = [...shown.problems]
			if (!shown.open) focusProblems.push("focus did not show it")
			if (shown.role !== "tooltip") focusProblems.push(`role ${shown.role}`)
			cases.push({
				viewport: vp.name,
				mark: at.mark,
				label: at.label,
				how: "focus",
				ok: focusProblems.length === 0,
				problems: focusProblems,
				side: shown.side,
				role: shown.role,
				bubble: shown.bubble,
				cut: shown.cut,
			})
			// Enter pins it (the learn card when it has one)
			await page.keyboard.press("Enter")
			const pinned = await settled(page, at.mark)
			if (pinned.role === "group" && seen.length === 1)
				await shoot(`2-hints-${vp.name}-learn`)
			const pinProblems = [...pinned.problems]
			if (!pinned.open) pinProblems.push("Enter closed it")
			if (pinned.expanded !== "true") pinProblems.push("mark not expanded")
			// a cut card: Tab goes into it, End scrolls it, Shift+Tab goes back to the mark, and Escape
			// from inside it closes it with focus back on the mark
			if (pinned.cut) {
				pinProblems.push(...(await cutByKeyboard(page, at.mark)))
				pinProblems.push(...(await cutKeepsFocus(page, at.mark)))
				cutRuns++
			}
			// the first learn card after the first hint (marks stand on both sides of its row), longer than the
			// window: cut at every size, then the same keyboard and focus checks
			if (
				!tallDone &&
				seen.length > 1 &&
				pinned.role === "group" &&
				!pinned.cut
			) {
				tallDone = true
				const tall = await pinnedTall(page, at.mark)
				pinProblems.push(...tall.problems.map(p => `longer card: ${p}`))
				if (!tall.open) pinProblems.push("longer card: Enter did not pin it")
				if (tall.role !== "group")
					pinProblems.push(`longer card: role ${tall.role}, not a learn card`)
				if (!tall.cut)
					pinProblems.push("longer card: taller than the window, but not cut")
				else {
					pinProblems.push(...(await cutByKeyboard(page, at.mark)))
					pinProblems.push(...(await cutKeepsFocus(page, at.mark)))
					cutRuns++
				}
				await dropTall(page)
			}
			// a pinned hint with no room at all is not drawn
			if (seen.length === 1)
				pinProblems.push(...(await noRoomNotExpanded(page, at.mark)))
			// Escape closes the hint only: focus stays on the mark, the panel stays open
			await page.keyboard.press("Escape")
			await within(
				2_000,
				async () => !(await measure(page, at.mark ?? "")).open,
			)
			const after = await measure(page, at.mark)
			if (after.open) pinProblems.push("Escape left it open")
			if (!after.focusOnMark) pinProblems.push("Escape moved focus")
			if (!after.panelOpen) pinProblems.push("Escape closed the panel")
			cases.push({
				viewport: vp.name,
				mark: at.mark,
				label: at.label,
				how: "enter",
				ok: pinProblems.length === 0,
				problems: pinProblems,
				side: pinned.side,
				role: pinned.role,
				bubble: pinned.bubble,
				cut: pinned.cut,
			})
		}
		reached[vp.name] = seen.length
		step(
			`${vp.name}: a cut card's keyboard and focus checks ran`,
			cutRuns > 0,
			`${cutRuns} cut card${cutRuns === 1 ? "" : "s"}`,
		)
		const missed = ids.filter(id => !seen.includes(id))
		step(
			`${vp.name}: every mark reached by Tab`,
			missed.length === 0 && seen.length > 0,
			missed.join(", "),
		)

		const first = ids[0]
		if (!vp.tap && first !== undefined)
			try {
				await mouseAndFocus(page, first, vp.height, step, vp.name)
			} catch (e) {
				step(
					`${vp.name}: mouse and focus on the first hint`,
					false,
					e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e),
				)
			}
		if (!vp.tap && first !== undefined)
			try {
				await islandMoves(page, ids, step, vp.name)
			} catch (e) {
				step(
					`${vp.name}: an open hint follows another island`,
					false,
					e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e),
				)
			}

		if (vp.tap) {
			for (const id of ids) {
				const mark = panel.locator(`[data-wk-hint-mark="${id}"]`)
				if (!(await intoView(page, mark)))
					step(`${vp.name}: ${id} tap`, false, "not brought into view")
				await page.waitForTimeout(150)
				// a tap: a touch pointer, then the click it makes
				await mark.evaluate(el => {
					const opts = { bubbles: true, pointerType: "touch", isPrimary: true }
					el.dispatchEvent(new PointerEvent("pointerdown", opts))
					el.dispatchEvent(new PointerEvent("pointerup", opts))
					;(el as HTMLElement).click()
				})
				const tapped = await settled(page, id)
				const problems = [...tapped.problems]
				if (!tapped.open) problems.push("a tap did not pin it")
				if (tapped.expanded !== "true") problems.push("mark not expanded")
				// a tap elsewhere in the panel closes it
				await page.evaluate(() => {
					const where = document.querySelector(".wkf-ls-cap")
					where?.dispatchEvent(
						new PointerEvent("pointerdown", {
							bubbles: true,
							pointerType: "touch",
						}),
					)
				})
				await within(2_000, async () => !(await measure(page, id)).open)
				if ((await measure(page, id)).open)
					problems.push("a tap elsewhere left it open")
				cases.push({
					viewport: vp.name,
					mark: id,
					label: (await mark.getAttribute("aria-label")) ?? "",
					how: "tap",
					ok: problems.length === 0,
					problems,
					side: tapped.side,
					role: tapped.role,
					bubble: tapped.bubble,
					cut: tapped.cut,
				})
			}
		}
		await page.keyboard.press("Escape")

		// no live audio at all: this page's status reads answer 404 (the core broadcasts status only on a
		// change, and nothing changes it here), so the panel says so with the Squelch mark alone
		const STATUS = "**/api/live-audio/status*"
		try {
			await page.route(STATUS, route =>
				route.fulfill({
					status: 404,
					contentType: "application/json",
					body: JSON.stringify({ error: "Not Found", message: "Not Found" }),
				}),
			)
			await reload(page)
			await seededState(
				page,
				vp,
				"no live audio",
				"This WaveKit has no live audio.",
				MARKS_MISSING,
				step,
				shoot,
			)
		} catch (e) {
			step(
				`${vp.name}: no live audio`,
				false,
				e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e),
			)
		} finally {
			await page.unroute(STATUS)
			await reload(page)
		}
	}
	await page.setViewportSize({ width: 2000, height: 900 })
	await page.emulateMedia({ reducedMotion: null })
	const ok =
		steps.every(s => s.ok) && cases.length > 0 && cases.every(c => c.ok)
	return { ok, marks, reached, cases, steps }
}
