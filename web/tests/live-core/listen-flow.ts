/**
 * `node scripts/ui-check.mjs --flow=listen`: the Listen flow, driven the way a person would, on the web
 * app's mock core (web/mock: it emits the voice check and the `/auto` route as the Listen contract says).
 *
 * Steps: tune to the mock's bare carrier (162.400 MHz, never speech) on the defaults (Auto, Voice only,
 * Source Auto); Listen → `Waiting for voice`; Play anyway → `Listening`; Source Digital (squelch closed, no
 * decoder on the carrier) → `Quiet` with the no-decoder notice and Use Auto, which goes back to Source Auto
 * → `Listening`; the Open segment → `Open`; Source Analog, Digital, Auto; `Q` back (to Auto with Voice only
 * off, as before Open) and `Q` again → `Open`. Every squelch and Source change must keep the one audio
 * stream attached. Then, from the defaults with Listen off, how many keys and clicks reach the noise: `Q`
 * alone, and the panel's Open (both counted as pressed).
 */
import type { Locator, Page } from "playwright-core"
import { within } from "./harness.ts"

/** How long one step may take to show (ms): the mock's level events come every 250 ms. */
const STEP_MS = 15_000
/** The mock's steady carrier: centre 161.500 MHz + 900 kHz (web/mock/data.ts). */
const CARRIER_OFFSET_HZ = 900_000

export interface ListenStep {
	step: string
	ok: boolean
	title: string
	sub: string
	attaches: number
}

export interface ListenReport {
	ok: boolean
	/** The head after the main flow. */
	title: string
	sub: string
	squelchMode: string | null
	voiceOnly: boolean | null
	listenMode: string | null
	/** Audio stream requests during the main flow (one Listen, then squelch and Source changes): 1 expected. */
	attaches: number
	steps: ListenStep[]
	/** From the defaults with Listen off: what reached `Open` while playing. */
	toNoise: { keys: number; clicks: number; keyOk: boolean; clickOk: boolean }
}

interface Head {
	title: string
	sub: string
	playAnyway: boolean
	/** The line under Source in the panel ("" while the panel is closed). */
	sourceHint: string
	/** The Source line offers Use Auto. */
	useAuto: boolean
}

const readHead = (page: Page): Promise<Head> =>
	page.evaluate(() => {
		const t = document.querySelector(".wk-shell-listen-title")
		const hint = document.querySelector("[data-wk-source-hint]")
		return {
			title: t?.querySelector("b")?.textContent ?? "",
			sub: t?.querySelector(".wk-shell-sub")?.textContent ?? "",
			playAnyway: t?.querySelector(".wkf-play-anyway") !== null,
			sourceHint: hint?.textContent ?? "",
			useAuto: [...(hint?.querySelectorAll("button") ?? [])].some(
				b => b.textContent?.trim() === "Use Auto",
			),
		}
	})

interface Config {
	squelchMode?: string
	voiceOnly?: boolean
	listenMode?: string
}

const readConfig = (page: Page): Promise<Config> =>
	page.evaluate(async () => {
		const answer = await fetch("/api/live-audio/status")
		const body = (await answer.json()) as { config?: Config }
		return body.config ?? {}
	})

const patchConfig = (
	page: Page,
	body: Record<string, unknown>,
): Promise<number> =>
	page.evaluate(async b => {
		const answer = await fetch("/api/live-audio/config", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(b),
		})
		return answer.status
	}, body)

const DEFAULTS = {
	offsetHz: CARRIER_OFFSET_HZ,
	squelchMode: "auto",
	voiceOnly: true,
	listenMode: "auto",
} as const

export async function listenFlow(
	page: Page,
	audioPort: number,
): Promise<ListenReport> {
	let attaches = 0
	page.on("request", request => {
		const url = new URL(request.url())
		if (
			Number(url.port) === audioPort &&
			/^\/(auto|stream|voice)(\.wav)?$/.test(url.pathname)
		)
			attaches++
	})
	const steps: ListenStep[] = []
	const note = async (step: string, ok: boolean) => {
		const h = await readHead(page)
		steps.push({ step, ok, title: h.title, sub: h.sub, attaches })
		return ok
	}
	const titleIs = (want: string) =>
		within(STEP_MS, async () => (await readHead(page)).title === want)
	const configIs = (want: Config) =>
		within(STEP_MS, async () => {
			const c = await readConfig(page)
			return Object.entries(want).every(([k, v]) => c[k as keyof Config] === v)
		})
	const listenButton = page.locator("button.wk-shell-listen-btn")
	const panelToggle = page.getByRole("button", { name: "Audio options" })
	const radio = (group: string, name: string) =>
		page
			.getByRole("radiogroup", { name: group, exact: true })
			.getByRole("radio", { name, exact: true })
	const panelOpen = async () =>
		(await panelToggle.getAttribute("aria-expanded")) === "true"
	// every key press goes through here, so the report counts what was really pressed
	let keys = 0
	const press = async (key: string, on?: Locator) => {
		keys++
		await (on ? on.press(key) : page.keyboard.press(key))
	}

	await note("tune to the carrier", (await patchConfig(page, DEFAULTS)) === 200)
	await listenButton.click()
	await note("Listen → Waiting for voice", await titleIs("Waiting for voice"))
	await within(STEP_MS, async () => attaches >= 1)
	const attached = attaches
	await page.locator(".wkf-play-anyway").click()
	await note(
		"Play anyway → Listening",
		(await titleIs("Listening")) &&
			(await configIs({ squelchMode: "auto", voiceOnly: false })),
	)
	if (!(await panelOpen())) await panelToggle.click()
	// Digital with the squelch closed and no decoder on the carrier: nothing plays, and the panel says so
	await radio("Source", "Digital").click()
	await note(
		"Source Digital, no decoder → Quiet, notice, Use Auto",
		(await configIs({ listenMode: "digital" })) &&
			(await titleIs("Quiet")) &&
			(await within(STEP_MS, async () => {
				const h = await readHead(page)
				return h.useAuto && /No digital voice decoder/.test(h.sourceHint)
			})),
	)
	await page
		.locator("[data-wk-source-hint]")
		.getByRole("button", { name: "Use Auto", exact: true })
		.click()
	await note(
		"Use Auto → Source Auto, Listening",
		(await configIs({ listenMode: "auto" })) && (await titleIs("Listening")),
	)
	await radio("Squelch", "Open").click()
	await note(
		"Open → Open",
		(await titleIs("Open")) && (await configIs({ squelchMode: "open" })),
	)
	for (const [name, mode] of [
		["Analog", "analog"],
		["Digital", "digital"],
		["Auto", "auto"],
	] as const) {
		await radio("Source", name).click()
		await note(
			`Source ${name}`,
			(await configIs({ listenMode: mode })) && attaches === attached,
		)
	}
	await press("q")
	await note(
		"Q → back to Auto (Voice only off)",
		(await configIs({ squelchMode: "auto", voiceOnly: false })) &&
			(await titleIs("Listening")),
	)
	await press("q")
	await note(
		"Q → Open",
		(await configIs({ squelchMode: "open" })) && (await titleIs("Open")),
	)
	const mainAttaches = attaches
	const head = await readHead(page)
	const config = await readConfig(page)
	await note("no reattach on any change", mainAttaches === attached)

	// from the defaults with Listen off: one key
	const reset = async () => {
		if ((await listenButton.getAttribute("aria-pressed")) === "true")
			await listenButton.click()
		await titleIs("Not listening")
		// the defaults: the panel closed too
		if (await panelOpen()) await panelToggle.click()
		await patchConfig(page, DEFAULTS)
		await configIs({ squelchMode: "auto", voiceOnly: true })
	}
	await reset()
	// the panel stays as it was; keys go to the page, not a text field
	const keysBefore = keys
	await press("q", page.locator("body"))
	const keyOk = await titleIs("Open")
	const toNoiseKeys = keys - keysBefore
	await note("defaults, Listen off: Q → Open", keyOk)
	await reset()
	let clicks = 0
	await panelToggle.click()
	clicks++
	await radio("Squelch", "Open").click()
	clicks++
	const clickOk = await titleIs("Open")
	await note("defaults, Listen off: the panel's Open → Open", clickOk)

	const ok = steps.every(s => s.ok) && clicks <= 2 && toNoiseKeys <= 1
	return {
		ok,
		title: head.title,
		sub: head.sub,
		squelchMode: config.squelchMode ?? null,
		voiceOnly: config.voiceOnly ?? null,
		listenMode: config.listenMode ?? null,
		attaches: mainAttaches,
		steps,
		toNoise: { keys: toNoiseKeys, clicks, keyOk, clickOk },
	}
}
