/**
 * The Vite dev server (vite.config.ts as `pnpm dev` runs it, not a build) in headless Chrome
 * against the real core (harness.ts) under the conditions of a busy receiver: 1.024 Msps, the
 * scanner on, the 2048-bin profile, and a link that starts losing samples (the core then opens new
 * epochs and labels the tuning unverified). The trace must be drawn and the waterfall must show
 * rows that arrived after each change (the test tone changes side), on the open page and on a
 * fresh one. A fixed scale the signal is not on must say so and offer Auto.
 *
 * Opt-in like the smoke: WAVEKIT_BROWSER_SMOKE=1 and a Chrome or Chromium.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
} from "playwright-core"
import type { ViteDevServer } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	chromiumPath,
	loopbackPort,
	traceDrawn,
	waterfallToneSide,
} from "./browser.ts"
import {
	LOOPBACK,
	assertAllowedPort,
	startRealCore,
	within,
	type RealCore,
} from "./harness.ts"

const exe = chromiumPath()
const enabled = process.env["WAVEKIT_BROWSER_SMOKE"] === "1" && exe !== null
const webRoot = fileURLToPath(new URL("../../", import.meta.url))
/** How long a change may take to show. Generous: headless Chrome draws with a software GPU, whose renderer takes seconds to start on a busy host. */
const RECOVER_MS = 60_000
/** The share of its samples the link delivers once it is "dropping samples" (about 1987 of 2048 kB/s). */
const LOSSY = 0.97

describe.skipIf(!enabled)(
	"the dev server in a browser, on a busy receiver",
	() => {
		let core: RealCore
		let dev: ViteDevServer
		let browser: Browser
		let context: BrowserContext
		let page: Page
		let tmp = ""
		let base = ""
		const problems: string[] = []

		const open = async (device: Record<string, unknown>): Promise<Page> => {
			const p = await context.newPage()
			p.on("pageerror", error => problems.push(error.message))
			await p.addInitScript(
				prefs => localStorage.setItem("wavekit.web.device", prefs),
				JSON.stringify(device),
			)
			await p.goto(base, { waitUntil: "load" })
			await p
				.locator(".wk-plot-body canvas")
				.first()
				.waitFor({ timeout: 60_000 })
			return p
		}
		/** The trace is drawn and the newest waterfall rows show the tone on `side`. */
		const draws = async (p: Page, side: "upper" | "lower") => {
			let seen: unknown = null
			const ok = await within(RECOVER_MS, async () => {
				seen = {
					trace: await traceDrawn(p),
					tone: await waterfallToneSide(p),
				}
				return (
					(seen as { trace: boolean }).trace &&
					(seen as { tone: string | null }).tone === side
				)
			})
			expect({
				ok,
				seen,
				notes: await p.locator(".wk-plot-note").allInnerTexts(),
			}).toEqual({ ok: true, seen: { trace: true, tone: side }, notes: [] })
			expect(await core.subscribers()).toBeGreaterThanOrEqual(1)
		}

		beforeAll(async () => {
			core = await startRealCore({ scanner: true, sampleRate: 1_024_000 })
			tmp = await mkdtemp(join(tmpdir(), "wavekit-web-devsmoke-"))
			const port = await loopbackPort()
			assertAllowedPort(port)
			const { createServer } = await import("vite")
			const api = `http://${LOOPBACK}:${core.apiPort}`
			dev = await createServer({
				root: webRoot,
				logLevel: "silent",
				cacheDir: join(tmp, "vite"),
				server: {
					host: LOOPBACK,
					port,
					strictPort: true,
					proxy: {
						"/api": { target: api, changeOrigin: false },
						"/health": { target: api, changeOrigin: false },
						"/ws": { target: api.replace(/^http/, "ws"), ws: true },
					},
				},
			})
			await dev.listen()
			base = `http://${LOOPBACK}:${port}/`
			browser = await chromium.launch({
				...(exe ? { executablePath: exe } : {}),
				headless: true,
				args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
			})
			context = await browser.newContext({
				// wide: the tuned card must not lie over the lower tone's column (waterfallToneSide)
				viewport: { width: 2000, height: 900 },
			})
			const loopback = (href: string) => new URL(href).hostname === LOOPBACK
			await context.route("**/*", route =>
				loopback(route.request().url()) ? route.continue() : route.abort(),
			)
			await context.routeWebSocket(
				url => !loopback(url.href),
				ws => ws.close(),
			)
			page = await open({ fftSize: 2048 })
		}, 240_000)

		afterAll(async () => {
			await browser?.close()
			await dev?.close()
			await core?.stop()
			if (tmp) await rm(tmp, { recursive: true, force: true })
		}, 60_000)

		it("draws the trace and the waterfall, and follows the signal", async () => {
			await draws(page, "upper")
			core.upstream.setToneSide("lower")
			await draws(page, "lower")
		}, 120_000)

		it("keeps drawing when the receiver link starts losing samples", async () => {
			core.upstream.setDelivery(LOSSY)
			// the core notices, opens a new epoch and labels the tuning unverified
			await expect
				.poll(
					async () =>
						(
							(await core.get("/api/spectrum")) as {
								sources: { tuningTrust: string }[]
							}
						).sources[0]?.tuningTrust,
					{ timeout: 2 * RECOVER_MS },
				)
				.toBe("unverified")
			core.upstream.setToneSide("upper")
			await draws(page, "upper")
		}, 180_000)

		it("draws on a page opened while the link is losing samples", async () => {
			const fresh = await open({ fftSize: 2048 })
			await draws(fresh, "upper")
			core.upstream.setToneSide("lower")
			await draws(fresh, "lower")
			await fresh.close()
		}, 180_000)

		it("says so when a fixed scale no longer holds the signal, and Auto brings it back", async () => {
			// a scale fixed on a stronger receiver: this one's floor is far below its bottom
			const fixed = await open({
				fftSize: 2048,
				spectrumRange: "fixed",
				fixedLevels: { minDb: -30, maxDb: 0 },
			})
			const note = fixed.locator(".wk-plot-note")
			// first "Starting the spectrum…" while the renderer comes up, then the scale
			await expect
				.poll(() => note.allInnerTexts(), { timeout: RECOVER_MS })
				.toEqual([
					expect.stringContaining("The noise floor is below the fixed scale"),
				])
			await note.getByRole("button", { name: "Use Auto range" }).click()
			await draws(fixed, "lower")
			await fixed.close()
		}, 180_000)

		it("raised no page error on the way", () => {
			expect(problems).toEqual([])
		})
	},
)
