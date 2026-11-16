/**
 * `node scripts/ui-check.mjs --flow=notices`: the link notices, driven on the web app's mock core (web/mock: its
 * link advisory is set through POST /__mock/link-advisory and sent in every `resources:snapshot`).
 *
 * Steps: the link drops samples (source) → one notice once 6 s of dropping are counted; it recovers and drops
 * again within the episode → still one; ✕, then it keeps dropping → no new notice (the Receiver chip still says
 * Samples lost); the episode ends and the link drops again → one new notice; a busy core → a notice that never
 * says "lower the sample rate"; the page reloads while it persists → the chip shows it, no notice. While a notice
 * shows, its box is measured against the Listen island, the dock, the tuned card, the other islands and the
 * frequency readout at 1440×900 and 390×844: none may intersect it.
 */
import type { Page } from "playwright-core"
import { within } from "./harness.ts"

/** Onset (6 s of core time) plus the snapshot cadence and a margin (ms). */
const NOTICE_MS = 15_000
/** How long a step watches for a notice that must not come (ms): past the onset. */
const QUIET_MS = 9000

export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

export interface NoticeLayout {
	viewport: string
	notice: Rect | null
	others: { name: string; rect: Rect; intersects: boolean }[]
	ok: boolean
}

export interface NoticeStep {
	step: string
	ok: boolean
	/** Link notices shown so far on this page load. */
	notices: number
	detail: string
}

export interface NoticesReport {
	ok: boolean
	steps: NoticeStep[]
	layouts: NoticeLayout[]
	/** Every link notice text seen, in order (both page loads). */
	texts: string[]
}

type Control =
	| { level: "dropping"; lossReason?: "source" | "core-busy" | "unknown" }
	| { level: "none"; endEpisode?: true }

/** Counts every link notice element the page inserts (a new element per notice). */
async function watchNotices(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { __wkNotices?: string[] }
		w.__wkNotices = []
		const seen = new WeakSet<Element>()
		const scan = () => {
			for (const el of document.querySelectorAll(
				'.wk-notice[data-class="condition"][data-key^="link:"]',
			)) {
				if (seen.has(el)) continue
				seen.add(el)
				w.__wkNotices?.push(el.textContent ?? "")
			}
		}
		new MutationObserver(scan).observe(document.body, {
			childList: true,
			subtree: true,
		})
		scan()
	})
}

const noticesSeen = (page: Page): Promise<string[]> =>
	page.evaluate(
		() => (window as unknown as { __wkNotices?: string[] }).__wkNotices ?? [],
	)

const chipLabel = (page: Page): Promise<string> =>
	page.evaluate(() => document.querySelector(".wkf-rx-loss")?.textContent ?? "")

const intersects = (a: Rect, b: Rect) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The notice box and what it must keep clear of, now. */
async function measure(page: Page, viewport: string): Promise<NoticeLayout> {
	const boxes = await page.evaluate(() => {
		const rect = (el: Element | null) => {
			if (!el) return null
			const r = el.getBoundingClientRect()
			if (r.width === 0 || r.height === 0) return null
			return { x: r.x, y: r.y, w: r.width, h: r.height }
		}
		const named: [string, string][] = [
			["listen", '.wk-shell-island[data-island="listen"]'],
			["tuner", '.wk-shell-island[data-island="tuner"]'],
			["receiver", '.wk-shell-island[data-island="receiver"]'],
			["dock", ".wk-dock"],
			["tuned card", ".wk-shell-cardslot"],
			["frequency readout", ".wkf-digits"],
		]
		return {
			notice: rect(document.querySelector("[data-wk-notice-region]")),
			others: named.flatMap(([name, sel]) => {
				const r = rect(document.querySelector(sel))
				return r ? [{ name, rect: r }] : []
			}),
		}
	})
	const others = boxes.others.map(o => ({
		...o,
		intersects: boxes.notice !== null && intersects(boxes.notice, o.rect),
	}))
	return {
		viewport,
		notice: boxes.notice,
		others,
		ok: boxes.notice !== null && others.every(o => !o.intersects),
	}
}

/**
 * The layout once the shell has laid out for `width` (a loaded host may take a while after a resize): the same
 * boxes twice in a row, 250 ms apart, and nothing laid out past the window (the dock hides below 761 px).
 * Within 5 s, else what it last saw.
 */
async function settled(
	page: Page,
	viewport: string,
	width: number,
): Promise<NoticeLayout> {
	let last = await measure(page, viewport)
	const end = Date.now() + 5000
	while (Date.now() < end) {
		await new Promise(resolve => setTimeout(resolve, 250))
		const next = await measure(page, viewport)
		const inside = next.others.every(o => o.rect.x + o.rect.w <= width)
		if (inside && JSON.stringify(next) === JSON.stringify(last)) return next
		last = next
	}
	return last
}

export async function noticesFlow(
	page: Page,
	mockApi: string,
	reload: () => Promise<void>,
): Promise<NoticesReport> {
	const steps: NoticeStep[] = []
	const layouts: NoticeLayout[] = []
	const control = async (body: Control) => {
		const answer = await fetch(`${mockApi}/__mock/link-advisory`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})
		if (!answer.ok)
			throw new Error(`mock link advisory refused: HTTP ${answer.status}`)
	}
	const count = async () => (await noticesSeen(page)).length
	const waitCount = async (n: number, ms: number) => {
		await within(ms, async () => (await count()) >= n)
		return count()
	}
	const step = async (name: string, ok: boolean, detail: string) => {
		steps.push({ step: name, ok, notices: await count(), detail })
	}
	const hold = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

	await page.setViewportSize({ width: 1440, height: 900 })
	await watchNotices(page)

	// 1: dropping on the receiver link → one notice after the onset
	await control({ level: "dropping", lossReason: "source" })
	let n = await waitCount(1, NOTICE_MS)
	const first = (await noticesSeen(page))[0] ?? ""
	await step(
		"dropping (source) → one notice",
		n === 1 && first.includes("lower the sample rate"),
		first,
	)
	layouts.push(await settled(page, "1440x900", 1440))

	// 2: recovered, then dropping again within the episode → still one
	await control({ level: "none" })
	await hold(2500)
	await control({ level: "dropping", lossReason: "source" })
	await hold(QUIET_MS)
	n = await count()
	await step("recovered → dropping in the episode: still one", n === 1, "")

	// 3: ✕, then it persists → no re-toast; the chip keeps it
	const close = page.locator(
		'.wk-notice[data-class="condition"] button[aria-label="Dismiss"]',
	)
	if ((await close.count()) > 0) await close.first().click()
	await hold(QUIET_MS)
	n = await count()
	const chip = await chipLabel(page)
	await step(
		"dismiss, condition persists: no re-toast, chip shows it",
		n === 1 && chip.includes("Samples lost"),
		`chip: ${chip}`,
	)

	// 4: the episode ends and the link drops again → one new notice
	await control({ level: "none", endEpisode: true })
	await hold(2500)
	await control({ level: "dropping", lossReason: "source" })
	n = await waitCount(2, NOTICE_MS)
	await step("episode ended and returned: one new notice", n === 2, "")

	// 5: a busy core (a new episode) → a notice without the rate advice; measured on a phone too
	await control({ level: "none", endEpisode: true })
	await hold(2500)
	await control({ level: "dropping", lossReason: "core-busy" })
	n = await waitCount(3, NOTICE_MS)
	const busy = (await noticesSeen(page))[2] ?? ""
	await page.setViewportSize({ width: 390, height: 844 })
	layouts.push(await settled(page, "390x844", 390))
	await page.setViewportSize({ width: 1440, height: 900 })
	const busyChip = await chipLabel(page)
	await step(
		"core-busy: no 'lower the sample rate'",
		n === 3 &&
			busy !== "" &&
			!/lower|sample rate/i.test(busy) &&
			!/lower|sample rate/i.test(busyChip),
		busy,
	)

	const before = await noticesSeen(page)

	// 6: reload while it persists → the chip shows it, no notice
	await reload()
	await watchNotices(page)
	await within(NOTICE_MS, async () =>
		(await chipLabel(page)).includes("Samples lost"),
	)
	await hold(QUIET_MS)
	const after = await count()
	const reloadedChip = await chipLabel(page)
	await step(
		"reload while it persists: chip shows it, no notice",
		after === 0 && reloadedChip.includes("Samples lost"),
		`chip: ${reloadedChip}`,
	)
	const texts = [...before, ...(await noticesSeen(page))]
	await control({ level: "none", endEpisode: true })
	return {
		ok: steps.every(s => s.ok) && layouts.every(l => l.ok),
		steps,
		layouts,
		texts,
	}
}
