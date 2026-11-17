/**
 * `node scripts/ui-check.mjs --flow=naming`: one name for each thing, and the removed Messages view, on the web
 * app's mock core (web/mock: synthetic seeds). The run loads `#/messages`.
 *
 * Steps: the old Messages link lands on the Activity drawer in the Cards layout (no error, the address bar says
 * `layout=cards`, no Messages button in the dock); in List under Voice, a seeded scanner recording row reads "FM voice" and no
 * row title reads "Recording …"; in Recordings, the first part of a three-part transmission reads
 * "Part 1 of 3 · continues"; on the spectrum, the tag of the seeded discovery at a saved frequency carries the
 * saved name. Every step also checks that no visible text says "Show in".
 */
import type { Page } from "playwright-core"
import { within } from "./harness.ts"

/** How long one step may take to show (ms). */
const STEP_MS = 15_000
/** The route the flow loads: the removed view's link. */
export const NAMING_ROUTE = "#/messages"
/** The mock's saved frequency with a seeded, unlabelled discovery on it (web/mock/data.ts), and its name. */
const SAVED_HZ = 160_625_000
const SAVED_NAME = "Port ops"
const PART_LABEL = "Part 1 of 3 · continues"

export interface NamingStep {
	step: string
	ok: boolean
	detail: string
}

export interface NamingReport {
	ok: boolean
	steps: NamingStep[]
}

/** Visible text that says "Show in" (the old per-surface buttons), anywhere on the page. */
const showInText = (page: Page): Promise<string | null> =>
	page.evaluate(() => {
		const m = /Show in [A-Z][a-z]+/.exec(document.body.innerText)
		return m ? m[0] : null
	})

async function step(
	steps: NamingStep[],
	page: Page,
	name: string,
	check: () => Promise<{ ok: boolean; detail: string }>,
): Promise<void> {
	let last = { ok: false, detail: "not shown" }
	await within(STEP_MS, async () => {
		last = await check()
		return last.ok
	}).catch(() => undefined)
	const showIn = await showInText(page)
	steps.push({
		step: name,
		ok: last.ok && showIn === null,
		detail: showIn === null ? last.detail : `${last.detail}; shows "${showIn}"`,
	})
}

export async function namingFlow(page: Page): Promise<NamingReport> {
	const steps: NamingStep[] = []

	await step(steps, page, "messages link opens Activity as cards", () =>
		page.evaluate(() => {
			const drawer = document.querySelector(".wk-shell-drawer")
			const title = drawer?.querySelector("h2")?.textContent?.trim() ?? ""
			const cards = drawer?.querySelector(
				'[role="radiogroup"][aria-label="Show events as"] [role="radio"][aria-checked="true"]',
			)
			const dockMessages = document.querySelector(
				'nav[aria-label="Primary"] button[aria-label="Messages"]',
			)
			const hash = location.hash
			const ok =
				title === "Activity" &&
				cards?.textContent?.trim() === "Cards" &&
				hash.includes("layout=cards") &&
				dockMessages === null
			return {
				ok,
				detail: `drawer "${title}", layout "${cards?.textContent?.trim() ?? "none"}", hash ${hash}, dock Messages ${dockMessages ? "present" : "absent"}`,
			}
		}),
	)

	await page
		.locator('[role="radiogroup"][aria-label="Show events as"] [role="radio"]')
		.filter({ hasText: "List" })
		.click({ timeout: STEP_MS })
		.catch(() => undefined)
	// voice only: the seeded scanner recordings, not the newest decodes above them
	await page.evaluate(() => {
		location.hash = "#/activity?cat=voice"
	})
	await step(steps, page, "scanner row reads FM voice", () =>
		page.evaluate(() => {
			const rows = [
				...document.querySelectorAll(".wk-shell-drawer .wka-item"),
			].map(r => (r as HTMLElement).innerText.replace(/\s+/g, " ").trim())
			const titles = [
				...document.querySelectorAll(".wk-shell-drawer .wka-title"),
			].map(t => t.textContent?.trim() ?? "")
			const voice = rows.filter(r => r.includes("FM voice")).length
			const recording = titles.filter(t => /^Recording\b/.test(t))
			return {
				ok: voice > 0 && recording.length === 0,
				detail: `${voice} row(s) with "FM voice", ${recording.length} titled "Recording" of ${titles.length}`,
			}
		}),
	)

	await page.evaluate(() => {
		location.hash = "#/recordings"
	})
	await step(steps, page, "roll-over part reads its place", () =>
		page.evaluate(label => {
			const text = document.querySelector(
				".wk-shell-drawer",
			) as HTMLElement | null
			const body = text?.innerText ?? ""
			return {
				ok: body.includes(label),
				detail: body.includes(label)
					? `"${label}" shown`
					: `"${label}" missing; "Cut" ${/\bCut\b/.test(body) ? "shown" : "absent"}`,
			}
		}, PART_LABEL),
	)

	await page.evaluate(() => {
		location.hash = ""
	})
	await step(steps, page, "tag at a saved frequency shows the saved name", () =>
		page.evaluate(
			({ hz, name }) => {
				const anchors = [
					...document.querySelectorAll<HTMLElement>(".wk-plot-tag-anchor"),
				]
				const anchor = anchors.find(
					a => Math.abs(Number(a.dataset["hz"]) - hz) < 6_250,
				)
				const tag = anchor?.nextElementSibling as HTMLElement | null
				const said = `${tag?.getAttribute("aria-label") ?? ""} ${tag?.title ?? ""}`
				return {
					ok: tag !== null && tag !== undefined && said.includes(name),
					detail:
						tag === null || tag === undefined
							? `no tag near ${hz} Hz (${anchors.length} tags)`
							: `tag says "${tag.getAttribute("aria-label") ?? ""}"`,
				}
			},
			{ hz: SAVED_HZ, name: SAVED_NAME },
		),
	)

	return { ok: steps.every(s => s.ok), steps }
}
