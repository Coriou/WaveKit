/**
 * ui-check's look at a list panel (Activity, Recordings): what it shows (state, rows mounted, counts, the
 * notice), and with `--measure` the panel budgets: click to shell and to rows, scrolling the whole list
 * (long tasks, rows mounted), and the page's heap. Also the synthetic recordings a fake core starts with
 * (`--seed-recordings=N`): scanner analog WAVs under its own temporary state directory.
 */
import { mkdir, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Page } from "playwright-core"

/** Drawers that are list panels, by their hash route segment and the drawer's title. */
export const PANELS: Readonly<Record<string, string>> = Object.freeze({
	activity: "Activity",
	recordings: "Recordings",
	scanner: "Scanner",
})

/** The panel a hash route opens (`#/recordings`, `#/activity/...?view=map`), or null. */
export function panelOfRoute(route: string): string | null {
	const head = route.replace(/^#\/?/, "").split("?")[0]?.split("/")[0] ?? ""
	return PANELS[head] ?? null
}

/** The view a panel route opens over (`#/recordings?view=messages` → `#/messages`; none: `#/`). */
export function viewOfRoute(route: string): string {
	const query = route.split("?")[1] ?? ""
	const view = new URLSearchParams(query).get("view")
	return view === null || view === "spectrum" ? "#/" : `#/${view}`
}

export interface PanelLook {
	panel: string
	/** rows | loading | busy | error | empty | none (the drawer is not open). */
	state: string
	/** List items mounted in the DOM (the virtual list's window). */
	rowsMounted: number
	/** aria-setsize of the rows: what the list says it holds. */
	setSize: number | null
	count: string | null
	notice: string | null
	footer: string | null
}

/** Reads what the open panel shows. */
export function readPanel(page: Page, title: string): Promise<PanelLook> {
	return page.evaluate(label => {
		const text = (el: Element | null | undefined) => {
			const t = el?.textContent?.replace(/\s+/g, " ").trim() ?? ""
			return t === "" ? null : t
		}
		const drawer = document.querySelector(
			`section.wk-drawer[aria-label="${label}"]`,
		)
		if (!drawer)
			return {
				panel: label,
				state: "none",
				rowsMounted: 0,
				setSize: null,
				count: null,
				notice: null,
				footer: null,
			}
		const rows = drawer.querySelectorAll('[role="listitem"]')
		const caption = drawer.querySelector(".wk-skel-caption")
		const state = drawer.querySelector(".wk-panel-failed")
			? "error"
			: drawer.querySelector(".wk-skel")
				? caption?.hasAttribute("data-busy")
					? "busy"
					: "loading"
				: rows.length > 0
					? "rows"
					: drawer.querySelector(".wkr-empty, .wka-empty, .wk-empty")
						? "empty"
						: "unknown"
		const size = rows[0]?.getAttribute("aria-setsize")
		const notices = [...drawer.querySelectorAll(".wk-panel-notice, .wka-note")]
			.map(n => text(n))
			.filter((t): t is string => t !== null)
		return {
			panel: label,
			state,
			rowsMounted: rows.length,
			setSize: size === null || size === undefined ? null : Number(size),
			count: text(drawer.querySelector(".wkr-count, .wka-count")),
			notice: notices.length > 0 ? notices.join(" | ") : null,
			footer: text(drawer.querySelector(".wkr-footer, .wka-footer")),
		}
	}, title)
}

/** Waits until the panel shows rows or its empty state, at most `ms` (then reports what it shows). */
export async function settlePanel(
	page: Page,
	title: string,
	ms: number,
): Promise<PanelLook> {
	const end = Date.now() + ms
	let look = await readPanel(page, title)
	while (
		Date.now() < end &&
		// an error may be retried by itself (a read refused before the run paired): wait for it too
		look.state !== "rows" &&
		look.state !== "empty"
	) {
		await page.waitForTimeout(250)
		look = await readPanel(page, title)
	}
	return look
}

export interface Stats {
	runs: number
	p50: number | null
	p95: number | null
	max: number | null
}

export function stats(values: readonly (number | null)[]): Stats {
	const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b)
	const at = (q: number) =>
		v.length === 0
			? null
			: Math.round(v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)] ?? 0)
	return { runs: v.length, p50: at(0.5), p95: at(0.95), max: at(1) }
}

/**
 * One open from the dock, in ms from the click: the drawer and its first row in the DOM (React's commit,
 * seen by a MutationObserver: what the page's own work costs), and the first frame after the row (paint,
 * which also waits on whatever else draws: on a loaded host the software-GL waterfall).
 */
async function openOnce(
	page: Page,
	title: string,
): Promise<{
	shell: number | null
	rows: number | null
	paint: number | null
}> {
	return page.evaluate(async label => {
		const button = document.querySelector<HTMLButtonElement>(
			`button[aria-label="${label}"][aria-pressed]`,
		)
		if (!button) return { shell: null, rows: null, paint: null }
		let shell: number | null = null
		let rows: number | null = null
		let paint: number | null = null
		const t0 = performance.now()
		const done = new Promise<void>(resolve => {
			const check = () => {
				const d = document.querySelector(
					`section.wk-drawer[aria-label="${label}"]`,
				)
				const now = performance.now()
				if (d && shell === null) shell = now - t0
				if (d && rows === null && d.querySelector('[role="listitem"]')) {
					rows = now - t0
					requestAnimationFrame(f => {
						paint = f - t0
						resolve()
					})
					observer.disconnect()
				}
			}
			const observer = new MutationObserver(check)
			observer.observe(document.body, { childList: true, subtree: true })
			setTimeout(() => {
				observer.disconnect()
				resolve()
			}, 15_000)
		})
		button.click()
		await done
		return { shell, rows, paint }
	}, title)
}

async function closePanel(page: Page, title: string): Promise<void> {
	await page.evaluate(label => {
		document
			.querySelector<HTMLButtonElement>(
				`section.wk-drawer[aria-label="${label}"] .wk-drawer-close`,
			)
			?.click()
	}, title)
	await page
		.locator(`section.wk-drawer[aria-label="${title}"]`)
		.waitFor({ state: "detached", timeout: 10_000 })
		.catch(() => undefined)
}

export interface ScrollBench {
	/** Rows the list said it holds after scrolling to its end (the last aria-posinset seen). */
	rowsReached: number
	/** Most list items mounted at once while scrolling. */
	maxMounted: number
	/** Main-thread tasks over 50 ms while paging in (scroll to the end, the next page loads). */
	loadingLongTasks: number
	loadingLongestMs: number
	/** Main-thread tasks over 50 ms while scrolling back through every loaded row, a viewport a frame. */
	scrollLongTasks: number
	scrollLongestMs: number
	scrollFrames: number
	seconds: number
}

/** Scrolls the open panel's list to its end until `target` rows are loaded, then back up through all of them. */
async function scrollBench(
	page: Page,
	title: string,
	target: number,
): Promise<ScrollBench> {
	return page.evaluate(
		async ({ label, want }) => {
			const started = performance.now()
			const tasks: { start: number; duration: number }[] = []
			const po = new PerformanceObserver(list => {
				for (const e of list.getEntries())
					tasks.push({ start: e.startTime, duration: e.duration })
			})
			po.observe({ type: "longtask", buffered: false })
			const frame = () =>
				new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
			const drawer = document.querySelector(
				`section.wk-drawer[aria-label="${label}"]`,
			)
			const list = drawer?.querySelector<HTMLElement>('[role="list"]')
			let maxMounted = 0
			let reached = 0
			const sample = () => {
				const rows = list?.querySelectorAll('[role="listitem"]') ?? []
				maxMounted = Math.max(maxMounted, rows.length)
				for (const r of rows)
					reached = Math.max(
						reached,
						Number(r.getAttribute("aria-posinset") ?? 0),
					)
			}
			if (!list)
				return {
					rowsReached: 0,
					maxMounted: 0,
					loadingLongTasks: 0,
					loadingLongestMs: 0,
					scrollLongTasks: 0,
					scrollLongestMs: 0,
					scrollFrames: 0,
					seconds: 0,
				}
			// page in: to the end, again and again, until the rows stop growing for 5 s
			let lastGrowth = performance.now()
			let before = -1
			while (performance.now() - started < 180_000) {
				list.scrollTop = list.scrollHeight
				await frame()
				await frame()
				sample()
				if (reached > before) {
					before = reached
					lastGrowth = performance.now()
				}
				if (reached >= want || performance.now() - lastGrowth > 5000) break
				await new Promise(resolve => setTimeout(resolve, 50))
			}
			const loadEnd = performance.now()
			// then back up through every loaded row, one viewport a frame
			const step = Math.max(200, list.clientHeight)
			let frames = 0
			while (list.scrollTop > 0) {
				list.scrollTop = Math.max(0, list.scrollTop - step)
				await frame()
				sample()
				frames += 1
			}
			await frame()
			await new Promise(resolve => setTimeout(resolve, 200))
			po.disconnect()
			const loading = tasks.filter(t => t.start < loadEnd)
			const scrolling = tasks.filter(t => t.start >= loadEnd)
			const longest = (l: typeof tasks) =>
				Math.round(l.reduce((m, t) => Math.max(m, t.duration), 0))
			return {
				rowsReached: reached,
				maxMounted,
				loadingLongTasks: loading.length,
				loadingLongestMs: longest(loading),
				scrollLongTasks: scrolling.length,
				scrollLongestMs: longest(scrolling),
				scrollFrames: frames,
				seconds: Math.round((performance.now() - started) / 100) / 10,
			}
		},
		{ label: title, want: target },
	)
}

/** The page's JavaScript heap after a collection, in MB (Chrome DevTools protocol). */
async function heapMb(page: Page): Promise<number | null> {
	try {
		const cdp = await page.context().newCDPSession(page)
		await cdp.send("HeapProfiler.collectGarbage")
		const usage = (await cdp.send("Runtime.getHeapUsage")) as {
			usedSize: number
		}
		await cdp.detach()
		return Math.round((usage.usedSize / 1e6) * 10) / 10
	} catch {
		return null
	}
}

export interface PanelBench {
	panel: string
	note: string
	/** First open after the page loaded: the drawer's code, then fresh rows. */
	coldOpen: {
		shellMs: number | null
		rowsMs: number | null
		paintMs: number | null
	}
	/** Later opens (code loaded, rows cached and refreshed behind them): DOM commit, and the painted frame. */
	shellMs: Stats
	rowsMs: Stats
	rowsPaintMs: Stats
	/** Opens after a page reload (code from the HTTP cache, rows fresh from the core). */
	freshRowsMs: Stats
	scroll: ScrollBench
	heapMbAfterScroll: number | null
	heapMbBaseline: number | null
}

/**
 * The panel budgets on the page as it is (paired, on the dev server): `runs` opens from the dock, a few
 * after reloads, one scroll through the whole list, and the heap.
 */
export async function benchPanel(
	page: Page,
	title: string,
	options: {
		runs: number
		reloads: number
		scrollTarget: number
		/** The production build (vite preview), else the dev server. */
		built: boolean
	},
): Promise<PanelBench> {
	const route = new URL(page.url())
	// the view the route opens the panel over (`?view=messages`: no spectrum behind the panel)
	const view = viewOfRoute(route.hash)
	await page.goto(`${route.origin}/${view}`, { waitUntil: "load" })
	await page.locator("#root > *").first().waitFor({ timeout: 60_000 })
	await page.waitForTimeout(1500)
	const heapMbBaseline = await heapMb(page)
	const cold = await openOnce(page, title)
	await settlePanel(page, title, 60_000)
	const shells: (number | null)[] = []
	const rows: (number | null)[] = []
	const paints: (number | null)[] = []
	for (let i = 0; i < options.runs; i++) {
		await closePanel(page, title)
		await page.waitForTimeout(150)
		const r = await openOnce(page, title)
		shells.push(r.shell)
		rows.push(r.rows)
		paints.push(r.paint)
	}
	const fresh: (number | null)[] = []
	for (let i = 0; i < options.reloads; i++) {
		await page.goto(`${route.origin}/${view}`, { waitUntil: "load" })
		await page.locator("#root > *").first().waitFor({ timeout: 60_000 })
		await page.waitForTimeout(1000)
		fresh.push((await openOnce(page, title)).rows)
	}
	await settlePanel(page, title, 60_000)
	const scroll = await scrollBench(page, title, options.scrollTarget)
	return {
		panel: title,
		note: options.built
			? "production build (vite preview), headless Chrome on this host"
			: "Vite dev server (React development build: an upper bound), headless Chrome on this host; --built measures the production build",
		coldOpen: { shellMs: cold.shell, rowsMs: cold.rows, paintMs: cold.paint },
		shellMs: stats(shells),
		rowsMs: stats(rows),
		rowsPaintMs: stats(paints),
		freshRowsMs: stats(fresh),
		scroll,
		heapMbAfterScroll: await heapMb(page),
		heapMbBaseline,
	}
}

/** Most synthetic recordings a run may seed (the catalogue's bound is larger; this keeps a run short). */
export const SEED_RECORDINGS_MAX = 50_000
/** Recordings per synthetic discovery folder (10 000 recordings are 1 250 folders). */
const PER_FOLDER = 8
/** The seeded files span this long before now, newest first (day groups over three days). */
const SPAN_MS = 3 * 86_400_000

const folderName = (f: number) => `d_seed${String(f).padStart(6, "0")}`

/** A 44-byte PCM WAV header (8 kHz, 16-bit mono) and `dataBytes` of silence. */
function wav(dataBytes: number): Buffer {
	const b = Buffer.alloc(44 + dataBytes)
	b.write("RIFF", 0, "ascii")
	b.writeUInt32LE(36 + dataBytes, 4)
	b.write("WAVE", 8, "ascii")
	b.write("fmt ", 12, "ascii")
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(1, 22)
	b.writeUInt32LE(8000, 24)
	b.writeUInt32LE(16_000, 28)
	b.writeUInt16LE(2, 32)
	b.writeUInt16LE(16, 34)
	b.write("data", 36, "ascii")
	b.writeUInt32LE(dataBytes, 40)
	return b
}

/**
 * Writes `count` synthetic scanner analog recordings into a fake core's state directory (before it starts):
 * `<state>/scanner/recordings/analog/d_<id>/seed-<n>.wav`, modification times spread over three days.
 * Synthetic only: silence, made-up discovery ids.
 */
export async function seedRecordings(
	stateDir: string,
	count: number,
	now = Date.now(),
): Promise<void> {
	const root = join(stateDir, "scanner", "recordings", "analog")
	const body = wav(1600)
	const folders = Math.ceil(count / PER_FOLDER)
	for (let f = 0; f < folders; f++)
		await mkdir(join(root, folderName(f)), { recursive: true })
	// 64 files at a time: fast enough on a loaded host, gentle on its file system
	for (let start = 0; start < count; start += 64) {
		const batch: Promise<void>[] = []
		for (let n = start; n < Math.min(count, start + 64); n++) {
			const file = join(
				root,
				folderName(Math.floor(n / PER_FOLDER)),
				`seed-${String(n).padStart(6, "0")}.wav`,
			)
			const at = new Date(now - 60_000 - (n * SPAN_MS) / count)
			batch.push(writeFile(file, body).then(() => utimes(file, at, at)))
		}
		await Promise.all(batch)
	}
}
