/**
 * `node scripts/ui-check.mjs --flow=hints`: every hint, reached and measured the way a person would meet it, on
 * the web app's own mock core (fake target only).
 *
 * At 1440×900 and 390×844, with Listen's Audio options open and Sound unfolded: Tab walks the panel from its
 * first control, and every hint mark must be reached; keyboard focus shows its hint at once; the bubble lies
 * inside its host surface and the window (not clipped), and meets no other island and not its own row; Enter
 * pins it (a learn card when it has one); Escape closes the hint and leaves focus on the mark and the panel
 * open. At 390×844 a tap (a touch pointer, then the click) pins it, and a tap elsewhere closes it. It runs with
 * reduced motion, so each hint must appear whole at once.
 */
import type { Page } from "playwright-core"
import { within } from "./harness.ts"

const STEP_MS = 10_000
/** Tab presses before giving up on reaching the end of the panel. */
const MAX_TABS = 60

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
}

/** Measures the open hint of `id` in the page: inside its host and the window, off its row and other islands. */
const measure = (page: Page, id: string): Promise<Measure> =>
	page.evaluate(markId => {
		const HOST = "[data-wk-hint-host], .wk-island[data-expanded], .wk-drawer"
		const SLACK = 0.5
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
		if (!mark || !bubble) return { ...base, bubble: null, problems: [] }
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
		if (host) {
			const h = host.getBoundingClientRect()
			if (
				b.left < h.left - SLACK ||
				b.top < h.top - SLACK ||
				b.right > h.right + SLACK ||
				b.bottom > h.bottom + SLACK
			)
				problems.push("outside its host")
		} else problems.push("no host surface")
		const row = mark.closest("[data-wk-hint-row]") ?? mark.parentElement
		if (row && meets(row.getBoundingClientRect()))
			problems.push("over its own row")
		for (const island of document.querySelectorAll(".wk-island")) {
			if (island === host || host?.contains(island) || island.contains(mark))
				continue
			const r = island.getBoundingClientRect()
			if (r.width === 0 || r.height === 0) continue
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
		}
	}, id)

/** Waits (2 s at most) until the hint of `id` is open and its fade is done, then measures it. */
async function settled(page: Page, id: string): Promise<Measure> {
	await within(2_000, async () => {
		const m = await measure(page, id)
		return m.open && !m.problems.includes("not fully shown")
	})
	return measure(page, id)
}

export async function hintsFlow(
	page: Page,
	/** Saves a screenshot under that name (with `--screenshot`). */
	shoot: (name: string) => Promise<void> = async () => undefined,
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
	const toggle = page.getByRole("button", { name: "Audio options" })
	const panel = page.getByRole("region", { name: "Audio options" })

	for (const vp of VIEWPORTS) {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		await page.keyboard.press("Escape")
		if ((await toggle.getAttribute("aria-expanded")) !== "true")
			await toggle.click()
		const opened = await within(STEP_MS, async () => (await panel.count()) > 0)
		step(`${vp.name}: Audio options open`, opened)
		if (!opened) continue
		const fold = panel.locator(".wkf-ls-fold")
		if (
			(await fold.count()) > 0 &&
			(await fold.getAttribute("aria-expanded")) !== "true"
		)
			await fold.click()
		const ids = await panel
			.locator("[data-wk-hint-mark]")
			.evaluateAll(els =>
				els.map(e => e.getAttribute("data-wk-hint-mark") ?? ""),
			)
		await shoot(`2-hints-${vp.name}-panel`)
		marks[vp.name] = ids.length
		step(`${vp.name}: marks in the panel`, ids.length > 0, `${ids.length}`)

		// Tab from the panel's first control until focus leaves it
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
			})
			// Enter pins it (the learn card when it has one)
			await page.keyboard.press("Enter")
			const pinned = await settled(page, at.mark)
			if (pinned.role === "group" && seen.length === 1)
				await shoot(`2-hints-${vp.name}-learn`)
			const pinProblems = [...pinned.problems]
			if (!pinned.open) pinProblems.push("Enter closed it")
			if (pinned.expanded !== "true") pinProblems.push("mark not expanded")
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
			})
		}
		reached[vp.name] = seen.length
		const missed = ids.filter(id => !seen.includes(id))
		step(
			`${vp.name}: every mark reached by Tab`,
			missed.length === 0 && seen.length > 0,
			missed.join(", "),
		)

		if (vp.tap) {
			for (const id of ids) {
				const mark = panel.locator(`[data-wk-hint-mark="${id}"]`)
				await mark.scrollIntoViewIfNeeded()
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
				})
			}
		}
		await page.keyboard.press("Escape")
	}
	await page.setViewportSize({ width: 2000, height: 900 })
	await page.emulateMedia({ reducedMotion: null })
	const ok =
		steps.every(s => s.ok) && cases.length > 0 && cases.every(c => c.ok)
	return { ok, marks, reached, cases, steps }
}
