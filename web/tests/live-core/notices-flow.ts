/**
 * `node scripts/ui-check.mjs --flow=notices`: the link notices, driven on the web app's mock core (web/mock: its
 * link advisory is set through POST /__mock/link-advisory and sent in every `resources:snapshot`).
 *
 * Steps: the link drops samples (source) → one notice once 6 s of dropping are counted; it recovers and drops
 * again within the episode → still one; ✕, then it keeps dropping → no new notice (the Receiver chip still says
 * Samples lost); the episode ends and the link drops again → one new notice; a busy core → a notice that never
 * says "lower the sample rate"; the page reloads while it persists → the chip shows it, no notice. While a notice
 * shows, each toast's box (the condition and the receipt have their own slots in the status slot) is measured against
 * the Listen island, the dock, the tuned card, the other islands and the frequency readout at 1440×900 and 390×844:
 * none may intersect one, and each element that must exist at that
 * viewport (the Listen island and the frequency readout always; the dock and the tuned card at desktop width)
 * must be laid out. The report lists every element's rect (null when it is not laid out).
 *
 * Expanded Activity (Cards, full width): with the drawer covering the plot between the island rows, a new notice
 * is measured at 1440×900 against the same elements plus the drawer's card list, its first card, its header
 * controls (title, Live, ✕) and its Expand button; all must exist and none may intersect it. Then a receipt with
 * Undo joins it (⌘K `vol <n>`, a real action; on the top row the receipt sits by the Tuner, the condition by the
 * Receiver) and both toasts are measured the same way.
 *
 * Phone (390×844), each drawer open in turn (Activity expanded, Activity, Scanner, Recordings, Settings): every
 * drawer spans the window there, so the region docks in the drawer's notice slot under its header (`data-where`
 * drawer-slot). A new notice is raised per drawer and measured against that drawer's header (every child and
 * every control in it), its first content row (what follows the slot), the Listen island and the frequency
 * readout; all must exist, none may intersect it, and the notice must lie inside the window. With Activity
 * expanded, and with Recordings open, the same with a receipt with Undo stacked under the notice. Gated.
 *
 * A stacked measurement focuses the condition's ✕ first (that pauses both timers while it is measured) and needs
 * the condition's ✕ and the receipt's Undo laid out inside the window, and the focus still in the region after any
 * move (a move remounts the toasts; the region gives the focus back).
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
	/** Where the shell layout put the toasts (`data-where`: rail, strip, drawer-slot). */
	where?: string
	/** A condition and a receipt were both expected (stacked); its ✕ and Undo, and whether the focus stayed. */
	stacked?: {
		dismiss: Rect | null
		undo: Rect | null
		inWindow: boolean
		focusInRegion: boolean
	}
	notice: Rect | null
	/** Every element measured; `rect` is null when it is not laid out. */
	others: {
		name: string
		rect: Rect | null
		required: boolean
		intersects: boolean
	}[]
	/** Required elements that were not laid out. */
	missing: string[]
	ok: boolean
}

/** Below this width the shell hides the dock (see `settled`); the dock and the tuned card must exist from it up. */
const DESKTOP_MIN_WIDTH = 761

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

/** Extra elements a layout must keep clear of: every match of `sel`, named `name`, `name 2`, ... */
interface Extra {
	name: string
	sel: string
	/** Measured when laid out, never missing (a header's empty spacer or count). */
	optional?: true
}

/** The expanded Activity drawer's parts (all required while it is expanded). */
const EXPANDED_PARTS: Extra[] = [
	{ name: "drawer card list", sel: ".wk-shell-drawer[data-expanded] .wkg" },
	{
		name: "drawer first card",
		sel: ".wk-shell-drawer[data-expanded] .wkg-col:first-child > :first-child",
	},
	{
		name: "drawer header control",
		sel: ".wk-shell-drawer[data-expanded] .wk-drawer-head > :not(.wk-drawer-gap)",
	},
	{ name: "drawer Expand", sel: ".wk-shell-drawer[data-expanded] .wka-expand" },
]

/** An open drawer's parts on a phone (any drawer, all required): its header's children and controls (the kit
 * drawer's `.wk-drawer-head`, Settings' `.wkf-set-top`) and its first content row, the box after the notice slot. */
const PHONE_DRAWER_PARTS: Extra[] = [
	{
		name: "drawer header part",
		sel: ".wk-shell-drawer :is(.wk-drawer-head, .wkf-set-top) > :not(.wk-drawer-gap, .wkf-gap)",
		optional: true,
	},
	{
		name: "drawer header control",
		sel: ".wk-shell-drawer :is(.wk-drawer-head, .wkf-set-top) :is(button, a, input, select, [role='radio'], [role='button'])",
	},
	{
		name: "drawer first content row",
		sel: ".wk-shell-drawer .wk-drawer-notices + *",
	},
]

/** The drawers a phone opens in turn: the hash that opens each, and the drawer's own root once loaded. */
const PHONE_DRAWERS: { name: string; hash: string; ready: string }[] = [
	{ name: "activity", hash: "#/activity", ready: ".wka-drawer" },
	{ name: "scanner", hash: "#/scanner", ready: ".wks-drawer" },
	{ name: "recordings", hash: "#/recordings", ready: ".wkr-drawer" },
	{ name: "settings", hash: "#/settings", ready: ".wkf-set" },
]

/** The notice box and what it must keep clear of, now. */
async function measure(
	page: Page,
	viewport: string,
	width: number,
	extra: readonly Extra[] = [],
	stack = false,
): Promise<NoticeLayout> {
	const boxes = await page.evaluate(extra => {
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
		const region = document.querySelector("[data-wk-notice-region]")
		return {
			dismiss: rect(
				region?.querySelector(
					'.wk-notice[data-class="condition"] [data-control="dismiss"]',
				) ?? null,
			),
			undo: rect(
				region?.querySelector(
					'.wk-notice[data-class="receipt"] [data-control="undo"]',
				) ?? null,
			),
			focusInRegion: region !== null && region.contains(document.activeElement),
			vw: window.innerWidth,
			vh: window.innerHeight,
			// each toast has its own slot (the region is a layer, or the drawer slot's column)
			toasts: [...(region?.querySelectorAll(".wk-notice") ?? [])]
				.map(rect)
				.filter(r => r !== null),
			where: region?.getAttribute("data-where") ?? "",
			others: [
				...named.map(([name, sel]) => ({
					name,
					rect: rect(document.querySelector(sel)),
					extra: false,
				})),
				...extra.flatMap(({ name, sel, optional }) => {
					const all = [...document.querySelectorAll(sel)]
					return (all.length > 0 ? all : [null]).map((el, i) => ({
						name: i === 0 ? name : `${name} ${i + 1}`,
						rect: rect(el),
						extra: optional !== true,
					}))
				}),
			],
		}
	}, extra)
	const toasts = boxes.toasts
	const notice: Rect | null =
		toasts.length === 0
			? null
			: (() => {
					const x = Math.min(...toasts.map(t => t.x))
					const y = Math.min(...toasts.map(t => t.y))
					const r = Math.max(...toasts.map(t => t.x + t.w))
					const b = Math.max(...toasts.map(t => t.y + t.h))
					return { x, y, w: r - x, h: b - y }
				})()
	const desktop = width >= DESKTOP_MIN_WIDTH
	// the expanded drawer may cover the tuned card: it need not be laid out then
	const requiredHere = (name: string, isExtra: boolean) =>
		isExtra ||
		name === "listen" ||
		name === "frequency readout" ||
		(desktop &&
			(name === "dock" || (name === "tuned card" && extra.length === 0)))
	const inWindow =
		notice !== null &&
		notice.x >= 0 &&
		notice.y >= 0 &&
		notice.x + notice.w <= boxes.vw &&
		notice.y + notice.h <= boxes.vh
	const others = boxes.others.map(({ extra: isExtra, ...o }) => ({
		...o,
		required: requiredHere(o.name, isExtra),
		intersects:
			o.rect !== null &&
			toasts.some(t => o.rect !== null && intersects(t, o.rect)),
	}))
	const missing = others.filter(o => o.required && !o.rect).map(o => o.name)
	const inside = (r: Rect | null) =>
		r !== null &&
		r.x >= 0 &&
		r.y >= 0 &&
		r.x + r.w <= boxes.vw &&
		r.y + r.h <= boxes.vh
	const stacked = stack
		? {
				dismiss: boxes.dismiss,
				undo: boxes.undo,
				inWindow: inside(boxes.dismiss) && inside(boxes.undo),
				focusInRegion: boxes.focusInRegion,
			}
		: undefined
	return {
		viewport,
		where: boxes.where,
		notice,
		...(stacked ? { stacked } : {}),
		others,
		missing,
		ok:
			notice !== null &&
			inWindow &&
			missing.length === 0 &&
			others.every(o => !o.intersects) &&
			(!stacked || (stacked.inWindow && stacked.focusInRegion)),
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
	extra: readonly Extra[] = [],
	stack = false,
): Promise<NoticeLayout> {
	let last = await measure(page, viewport, width, extra, stack)
	const end = Date.now() + 5000
	while (Date.now() < end) {
		await new Promise(resolve => setTimeout(resolve, 250))
		const next = await measure(page, viewport, width, extra, stack)
		const inside = next.others.every(
			o => o.rect === null || o.rect.x + o.rect.w <= width,
		)
		if (inside && JSON.stringify(next) === JSON.stringify(last)) return next
		last = next
	}
	return last
}

/**
 * A receipt with Undo stacked under the shown condition: ⌘K `vol <percent>` (a real action: Undo returns the
 * volume), then the condition's ✕ focused, which pauses both timers while the stack is measured. True once both
 * toasts show and the focus is in the region.
 */
export async function stackReceipt(
	page: Page,
	percent: number,
): Promise<string> {
	let phase = "open the palette"
	try {
		await page.keyboard.press("Control+k")
		const input = page.locator(".wkp-input")
		await input.waitFor({ timeout: 8000 })
		phase = "type the volume"
		await input.fill(`vol ${percent}`)
		await page
			.locator(".wkp-row", { hasText: "Volume" })
			.first()
			.waitFor({ timeout: 8000 })
		phase = "run it"
		await input.press("Enter")
		phase = "wait for the receipt's Undo"
		await page
			.locator(
				'[data-wk-notice-region] .wk-notice[data-class="receipt"] [data-control="undo"]',
			)
			.waitFor({ timeout: 8000 })
		phase = "focus the condition's ✕"
		const dismiss = page.locator(
			'[data-wk-notice-region] .wk-notice[data-class="condition"] [data-control="dismiss"]',
		)
		if ((await dismiss.count()) === 0) return "no condition under the receipt"
		await dismiss.focus()
		const focused = await page.evaluate(
			() =>
				document
					.querySelector("[data-wk-notice-region]")
					?.contains(document.activeElement) ?? false,
		)
		return focused ? "" : "the focus is not in the region"
	} catch (error) {
		const rows = await page.evaluate(() =>
			[...document.querySelectorAll(".wkp-row")]
				.slice(0, 5)
				.map(r => r.textContent ?? ""),
		)
		const message = error instanceof Error ? error.message.split("\n")[0] : ""
		// Escape closes the palette; with none open it would close the drawer
		if ((await page.locator(".wkp-input").count()) > 0)
			await page.keyboard.press("Escape")
		return `${phase}: ${message ?? ""}; palette rows: ${JSON.stringify(rows)}`
	}
}

/** Blurs whatever has the focus, so the stacked toasts' timers run out again. */
const blurAll = (page: Page) =>
	page.evaluate(() => {
		const a = document.activeElement
		if (a instanceof HTMLElement) a.blur()
	})

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

	// 5b: Activity expanded (Cards, full width) over the plot → a new notice keeps off its cards and controls
	await page.evaluate(() => {
		location.hash = "#/activity"
	})
	await page.locator(".wk-shell-drawer .wka-drawer").waitFor()
	await page.getByRole("radio", { name: "Cards" }).click()
	await page.locator(".wk-shell-drawer .wka-expand").click()
	await page.locator(".wk-shell-drawer[data-expanded]").waitFor()
	await page
		.locator(".wk-shell-drawer .wkg-col > *")
		.first()
		.waitFor({ timeout: 10_000 })
	await control({ level: "none", endEpisode: true })
	await hold(2500)
	await control({ level: "dropping", lossReason: "source" })
	n = await waitCount(4, NOTICE_MS)
	const wide = await settled(page, "1440x900 expanded", 1440, EXPANDED_PARTS)
	layouts.push(wide)
	await step(
		"expanded Activity: one new notice, off the cards and the drawer's controls",
		n === 4 && wide.ok,
		`placed ${wide.where}`,
	)
	const wideWhy = await stackReceipt(page, 40)
	const wideStack =
		wideWhy === ""
			? await settled(
					page,
					"1440x900 expanded, stacked",
					1440,
					EXPANDED_PARTS,
					true,
				)
			: null
	if (wideStack) layouts.push(wideStack)
	await blurAll(page)
	await step(
		"expanded Activity, condition + receipt with Undo: the stack off the cards and the drawer's controls",
		wideStack?.ok === true,
		wideStack ? `placed ${wideStack.where}` : wideWhy,
	)

	// 5c: phone, each drawer open in turn (expanded Activity first) → a new notice docks under its header
	await page.setViewportSize({ width: 390, height: 844 })
	const fresh = async () => {
		const had = await count()
		await control({ level: "none", endEpisode: true })
		await hold(2500)
		await control({ level: "dropping", lossReason: "source" })
		return (await waitCount(had + 1, NOTICE_MS)) === had + 1
	}
	let volume = 50
	const phoneStep = async (
		name: string,
		extra: readonly Extra[],
		stack = false,
	) => {
		const one = await fresh()
		const l = await settled(page, `390x844 ${name}`, 390, extra)
		layouts.push(l)
		await step(
			`phone, ${name} open: a new notice docked under its header, clear of every control`,
			one && l.ok && l.where === "drawer-slot",
			`placed ${l.where}`,
		)
		if (!stack) return
		volume += 5
		const why = await stackReceipt(page, volume)
		const s =
			why === ""
				? await settled(page, `390x844 ${name}, stacked`, 390, extra, true)
				: null
		if (s) layouts.push(s)
		await blurAll(page)
		await step(
			`phone, ${name} open, condition + receipt with Undo: the stack docked under its header, ✕ and Undo inside the window`,
			s?.ok === true && s.where === "drawer-slot",
			s ? `placed ${s.where}` : why,
		)
	}
	await phoneStep(
		"activity expanded",
		[...EXPANDED_PARTS, ...PHONE_DRAWER_PARTS],
		true,
	)
	// back to the plain drawer and the List layout
	await page.locator(".wk-shell-drawer .wka-expand").click()
	await page.getByRole("radio", { name: "List" }).click()
	for (const d of PHONE_DRAWERS) {
		await page.evaluate(hash => {
			location.hash = hash
		}, d.hash)
		await page.locator(`.wk-shell-drawer ${d.ready}`).waitFor()
		await phoneStep(d.name, PHONE_DRAWER_PARTS, d.name === "recordings")
	}
	// closed, at desktop width, for the reload step
	await page.getByRole("button", { name: "Close settings" }).click()
	await page.setViewportSize({ width: 1440, height: 900 })

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
