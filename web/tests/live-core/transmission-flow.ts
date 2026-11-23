/**
 * `node scripts/ui-check.mjs --flow=transmission`: the Transmission view, driven the way a person would, on the web
 * app's mock core (web/mock: synthetic recordings, one per tone state of the facts sidecar).
 *
 * Steps: Recordings → an open row's Details shows the view; Back returns to the list with the same row open and
 * focused; Activity → a transmission row's Details shows the view inside Activity (its own screenshot) → Back; the
 * view for each tone state reads its Tone row ("CTCSS 88.5 Hz", "DCS 023", "No tone heard" from the recorder's
 * stored null, "Not measured" twice with its hint: "Not determined for this recording" for a missing tone, "This
 * recording did not store its tone" with no facts); Esc in the view goes Back and the drawer stays open. A PNG is
 * saved after each step.
 */
import type { Page } from "playwright-core"
import { within } from "./harness.ts"

/** How long one step may take to show (ms). */
const STEP_MS = 15_000

export interface TransmissionReport {
	ok: boolean
	status: "ok" | "failed"
	/** One boolean per step. */
	steps: Record<string, boolean>
	/** What each step saw, for a failure. */
	details: Record<string, string>
	/** The saved screenshots, one per step (filled in by the runner). */
	screenshots: string[]
}

interface Item {
	id: string
	kind: string
	frequencyHz: number | null
	facts?: { tone?: { kind: string; hz?: number; code?: string } | null } | null
}

/** The mock's scanner recordings by tone state, from its own inventory (no tone: measured none; absent: missing). */
async function toneRows(mockApi: string): Promise<Record<string, string>> {
	const res = await fetch(`${mockApi}/api/recordings?limit=200`)
	const body = (await res.json()) as { items?: Item[] }
	const out: Record<string, string> = {}
	for (const item of body.items ?? []) {
		if (item.kind !== "scanner-analog") continue
		const facts = item.facts
		let state: string
		if (facts === null || facts === undefined) state = "no facts"
		else if (facts.tone === null) state = "none heard"
		else if (facts.tone === undefined) state = "missing"
		else if (facts.tone.kind === "ctcss")
			state = facts.tone.hz === 88.5 ? "ctcss" : "ctcss other"
		else state = "dcs"
		out[state] ??= item.id
	}
	return out
}

export async function transmissionFlow(
	page: Page,
	mockApi: string,
	shoot: (name: string) => Promise<void>,
): Promise<TransmissionReport> {
	const steps: Record<string, boolean> = {}
	const details: Record<string, string> = {}
	const until = (test: () => Promise<boolean>) => within(STEP_MS, test)
	const bounded = { timeout: STEP_MS }
	const record = async (
		name: string,
		ok: boolean,
		detail = "",
	): Promise<void> => {
		steps[name] = ok
		details[name] = detail
		await shoot(`3-transmission-${name}`).catch(() => undefined)
	}
	const viewShown = () =>
		page.evaluate(() => document.querySelector(".wkt-view") !== null)
	const toneText = () =>
		page.evaluate(() => {
			for (const row of document.querySelectorAll(".wkt-known-row"))
				if (row.querySelector("dt")?.textContent?.trim() === "Tone")
					return row.querySelector("dd")?.textContent?.trim() ?? null
			return null
		})
	const openRow = async (id: string) => {
		const row = page.locator(`.wkr-item[data-row-id="${id}"]`)
		await row.scrollIntoViewIfNeeded(bounded)
		if ((await row.getAttribute("data-open")) === null)
			await row.locator(".wkr-row").click(bounded)
		await row.getByRole("button", { name: "Details" }).click(bounded)
		await until(viewShown)
	}
	const goBack = async () => {
		await page.locator(".wkt-bar button").first().click(bounded)
		await until(async () => !(await viewShown()))
	}
	const here = (step: string) => (error: unknown) => {
		details[step] =
			error instanceof Error ? (error.message.split("\n")[0] ?? "") : "failed"
		return false
	}
	try {
		const rows = await toneRows(mockApi)
		const first = Object.values(rows)[0] ?? ""

		// 1-2: Recordings → Details → Back
		await page.evaluate(() => {
			location.hash = "#/recordings"
		})
		await page.locator(".wkr-item").first().waitFor(bounded)
		await openRow(first)
		await record("recordings-details", await viewShown(), first)
		await goBack()
		const back = await until(async () =>
			page.evaluate(id => {
				const row = document.querySelector(
					`.wkr-item[data-row-id="${CSS.escape(id)}"]`,
				)
				return (
					row !== null &&
					row.getAttribute("data-open") !== null &&
					row.contains(document.activeElement)
				)
			}, first),
		).catch(here("recordings-back"))
		await record("recordings-back", back, details["recordings-back"] ?? first)

		// 3: Activity → a transmission row's Details → Back
		await page.getByRole("button", { name: "Close recordings" }).click(bounded)
		await page.evaluate(() => {
			location.hash = "#/activity"
		})
		let activityOk = false
		try {
			await page.locator(".wka-list .wka-item").first().waitFor(bounded)
			const rowsN = await page.locator(".wka-list .wka-item").count()
			for (let i = 0; i < rowsN && !activityOk; i++) {
				const item = page.locator(".wka-list .wka-item").nth(i)
				await item.locator(".wka-row").click(bounded)
				// a transmission row opens the view itself; another kind opens its event detail
				await page.locator(".wkt-view, .wka-detail").first().waitFor(bounded)
				if (await viewShown()) {
					activityOk = true
					break
				}
				const door = page
					.locator(".wka-detail-actions")
					.getByRole("button", { name: "Details", exact: true })
				if ((await door.count()) > 0) {
					await door.first().click(bounded)
					activityOk = await until(viewShown)
					break
				}
				// not a transmission: its event detail has no Details; back to the list
				await page.locator(".wka-detail-bar button").first().click(bounded)
				await page.locator(".wka-list").waitFor(bounded)
			}
			if (activityOk) {
				await page.locator(".wkt-known, .wkt-listen").first().waitFor(bounded)
				const inActivity = await page.evaluate(
					() =>
						document.querySelector(".wka-drawer .wkt-view") !== null &&
						document.querySelector(".wkr-drawer") === null,
				)
				await record(
					"activity-view",
					inActivity,
					inActivity ? "" : "the view is not inside the Activity drawer",
				)
				await goBack()
				activityOk = await until(
					async () =>
						(await page.locator(".wka-list").count()) > 0 &&
						!(await viewShown()),
				)
			}
		} catch (error) {
			here("activity")(error)
		}
		await record("activity-details-back", activityOk, details["activity"] ?? "")
		await page.getByRole("button", { name: "Close activity" }).click(bounded)

		// 4: one view per tone state
		await page.evaluate(() => {
			location.hash = "#/recordings"
		})
		await page.locator(".wkr-item").first().waitFor(bounded)
		// the value, then the hint when it has one (the row's text is both)
		const expected: [string, string, string, string][] = [
			["tone-ctcss", "ctcss", "CTCSS 88.5 Hz", ""],
			["tone-dcs", "dcs", "DCS 023", ""],
			["tone-none-heard", "none heard", "No tone heard", ""],
			[
				"tone-missing",
				"missing",
				"Not measured",
				"Not determined for this recording",
			],
			[
				"tone-no-facts",
				"no facts",
				"Not measured",
				"This recording did not store its tone",
			],
		]
		for (const [name, state, text, hint] of expected) {
			const id = rows[state]
			if (id === undefined) {
				await record(name, false, `the mock has no ${state} recording`)
				continue
			}
			let got: string | null = null
			try {
				await openRow(id)
				await until(async () => (await toneText()) !== null)
				got = await toneText()
			} catch (error) {
				here(name)(error)
			}
			await record(
				name,
				got !== null &&
					got.startsWith(text) &&
					got.includes(hint) &&
					!got.includes("steady"),
				`Tone: ${got ?? details[name] ?? "not shown"}`,
			)
			await goBack().catch(() => undefined)
		}

		// 5: Esc goes Back, the drawer stays open
		let escOk = false
		try {
			await openRow(first)
			await page
				.locator(".wkt-view")
				.focus()
				.catch(() => undefined)
			await page.keyboard.press("Escape")
			escOk = await until(
				async () =>
					!(await viewShown()) &&
					(await page.locator(".wkr-drawer").count()) > 0 &&
					(await page.locator(".wkr-list").count()) > 0,
			)
		} catch (error) {
			here("escape")(error)
		}
		await record("escape-back", escOk, details["escape"] ?? "")
	} catch (error) {
		details["flow"] =
			error instanceof Error ? (error.message.split("\n")[0] ?? "") : "failed"
		steps["flow"] = false
	}
	const ok =
		Object.keys(steps).length > 5 && Object.values(steps).every(Boolean)
	return { ok, status: ok ? "ok" : "failed", steps, details, screenshots: [] }
}
