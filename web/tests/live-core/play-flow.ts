/**
 * `node scripts/ui-check.mjs --flow=play`: play anywhere, driven the way a person would, on the web app's mock
 * core (web/mock: Activity rows linked to its synthetic recordings, digital rows without one, live audio).
 *
 * Steps: Listen on; open Activity; a row with a recording shows a play disc and a row without shows none;
 * the disc plays it (the dock, the one `[data-wk-transport]`, reads `playing` and live audio `muted`); closing
 * the drawer keeps it playing; `#/recordings` marks the same item playing; the Listen button pauses the
 * recording and live audio comes back (Listen stays on); play again, close the dock (live audio still on);
 * "With audio" asks the core for `hasRecording=true`.
 */
import type { Page } from "playwright-core"
import { within } from "./harness.ts"

/** How long one step may take to show (ms). */
const STEP_MS = 15_000

export interface PlayStep {
	step: string
	ok: boolean
	detail: string
}

export interface PlayReport {
	ok: boolean
	/** The recording played (its stable key). */
	id: string | null
	playback: { state: string | null; live: string | null }
	transports: number
	steps: PlayStep[]
}

interface Dock {
	transports: number
	phase: string | null
	live: string | null
}

const readDock = (page: Page): Promise<Dock> =>
	page.evaluate(() => {
		const all = document.querySelectorAll("[data-wk-transport]")
		const dock = all[0] as HTMLElement | undefined
		return {
			transports: all.length,
			phase: dock?.dataset["phase"] ?? null,
			live: dock?.dataset["live"] ?? null,
		}
	})

export async function playFlow(page: Page): Promise<PlayReport> {
	const steps: PlayStep[] = []
	const note = (step: string, ok: boolean, detail = "") =>
		void steps.push({ step, ok, detail })
	const until = (test: () => Promise<boolean>) => within(STEP_MS, test)
	const dockIs = async (phase: string, live?: string) =>
		until(async () => {
			const d = await readDock(page)
			return d.phase === phase && (live === undefined || d.live === live)
		})
	let id: string | null = null
	/** The dock right after the disc was clicked. */
	let afterPlay: Dock | null = null
	try {
		// live audio on first: the recording must hold it, then give it back
		const listenButton = page.locator("button.wk-shell-listen-btn")
		await listenButton.click()
		const listening = await until(async () =>
			page.evaluate(
				() =>
					(document.querySelector(".wk-shell-listen-title b")?.textContent ??
						"") !== "",
			),
		)
		note("Listen on", listening)

		await page.evaluate(() => {
			location.hash = "#/activity"
		})
		const disc = page.locator(".wka-list .wkp-disc").first()
		const shown = await until(async () => (await disc.count()) > 0)
		note("a row with a recording shows a disc", shown)
		const bare = await page.evaluate(() => {
			const rows = [
				...document.querySelectorAll(".wka-list .wka-item:not([data-disc])"),
			]
			return {
				rows: rows.length,
				discs: rows.filter(r => r.querySelector(".wkp-disc") !== null).length,
			}
		})
		note(
			"a row without a recording shows none",
			bare.rows > 0 && bare.discs === 0,
			`${bare.rows} rows without audio, ${bare.discs} with a disc`,
		)
		id = await disc.getAttribute("data-playback-id")
		await disc.click()
		const played = await dockIs("playing", "muted")
		const d1 = await readDock(page)
		afterPlay = d1
		note(
			"the disc plays it; live audio muted",
			played,
			`${d1.phase ?? "no dock"}, live ${d1.live ?? "-"}`,
		)
		note("exactly one transport", d1.transports === 1, String(d1.transports))

		await page.getByRole("button", { name: "Close activity" }).click()
		const kept = await until(async () => {
			const open = await page.locator(".wka-list").count()
			return open === 0 && (await readDock(page)).phase === "playing"
		})
		note("closing the drawer keeps it playing", kept)

		await page.evaluate(() => {
			location.hash = "#/recordings"
		})
		const marked = await until(async () =>
			page.evaluate(
				key =>
					document.querySelector(
						`.wkr-list .wkp-disc[data-playback-id="${CSS.escape(key ?? "")}"][data-playback="playing"]`,
					) !== null,
				id,
			),
		)
		note("Recordings marks the same item playing", marked, id ?? "")
		note("still exactly one transport", (await readDock(page)).transports === 1)

		await listenButton.click()
		const restored = await dockIs("paused", "on")
		const wanted = await page.evaluate(
			() =>
				(document.querySelector(".wk-shell-listen-title b")?.textContent ??
					"") !== "Off",
		)
		note(
			"Listen pauses it and live audio comes back, Listen on",
			restored && wanted,
		)
		await page.locator(".wkp-dock-play").click()
		const again = await dockIs("playing", "muted")
		note("playing again holds live audio again", again)
		await page
			.getByRole("button", { name: "Close player and unmute live audio" })
			.click()
		const closed = await until(
			async () => (await readDock(page)).transports === 0,
		)
		note("closing the dock removes the one transport", closed)

		await page.getByRole("button", { name: "Close recordings" }).click()
		await page.evaluate(() => {
			location.hash = "#/activity"
		})
		const asked = page.waitForRequest(
			r =>
				new URL(r.url()).pathname === "/api/activity" &&
				new URL(r.url()).searchParams.get("hasRecording") === "true",
			{ timeout: STEP_MS },
		)
		await page.getByRole("button", { name: "With audio" }).click()
		const withAudio = await asked.then(
			() => true,
			() => false,
		)
		note("With audio sends hasRecording=true", withAudio)
		await page.getByRole("button", { name: "With audio" }).click()
	} catch (error) {
		note(
			"flow",
			false,
			error instanceof Error ? (error.message.split("\n")[0] ?? "") : "failed",
		)
	}
	const last = await readDock(page)
	return {
		ok: steps.length > 0 && steps.every(s => s.ok),
		id,
		playback: {
			state: afterPlay?.phase ?? null,
			live: afterPlay?.live ?? null,
		},
		transports: last.transports,
		steps,
	}
}
