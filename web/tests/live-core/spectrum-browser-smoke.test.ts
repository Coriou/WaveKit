/**
 * Browser smoke: the built web app in headless Chrome against the real core (harness.ts), through a
 * loopback server that serves the build and proxies /api, /health and /ws to the core. After a
 * receiver pause and resume, and again after the page's sockets drop during a pause, the waterfall
 * must show varied pixels that keep changing (rows arriving), and the core must count a spectrum
 * subscriber. Screenshots stay in memory; nothing is written to the repository.
 *
 * Opt-in: WAVEKIT_BROWSER_SMOKE=1 and a Chrome or Chromium (PLAYWRIGHT_CHROMIUM_PATH, the macOS
 * Google Chrome, or /opt/pw-browsers); skipped otherwise, so CI without a browser is unaffected.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	buildProduction,
	chromiumPath,
	serveWeb,
	waterfallAlive,
	type WebServer,
} from "./browser.ts"
import { LOOPBACK, startRealCore, within, type RealCore } from "./harness.ts"

const exe = chromiumPath()
const enabled = process.env["WAVEKIT_BROWSER_SMOKE"] === "1" && exe !== null
const webRoot = fileURLToPath(new URL("../../", import.meta.url))
const RECOVER_MS = 10_000

describe.skipIf(!enabled)(
	"web spectrum in a browser against the real core",
	() => {
		let core: RealCore
		let web: WebServer
		let browser: Browser
		let page: Page
		let outDir = ""

		beforeAll(async () => {
			core = await startRealCore()
			outDir = await mkdtemp(join(tmpdir(), "wavekit-web-smoke-"))
			await buildProduction(webRoot, outDir)
			web = await serveWeb(outDir, core.apiPort)
			browser = await chromium.launch({
				...(exe ? { executablePath: exe } : {}),
				headless: true,
				args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
			})
			const context = await browser.newContext({
				viewport: { width: 1280, height: 800 },
				serviceWorkers: "block",
			})
			const loopback = (href: string) => new URL(href).hostname === LOOPBACK
			await context.route("**/*", route =>
				loopback(route.request().url()) ? route.continue() : route.abort(),
			)
			await context.routeWebSocket(
				url => !loopback(url.href),
				ws => ws.close(),
			)
			page = await context.newPage()
			await page.goto(web.base, { waitUntil: "load" })
			await page
				.locator(".wk-plot-body canvas")
				.first()
				.waitFor({ timeout: 30_000 })
		}, 240_000)

		afterAll(async () => {
			await browser?.close()
			await web?.close()
			await core?.stop()
			if (outDir) await rm(outDir, { recursive: true, force: true })
		}, 60_000)

		const alive = async () => {
			const ok = await within(RECOVER_MS, () => waterfallAlive(page))
			const subscribers = await core.subscribers()
			expect({ ok, subscribed: subscribers >= 1 }).toEqual({
				ok: true,
				subscribed: true,
			})
		}

		it("draws a live waterfall", async () => {
			await alive()
		}, 60_000)

		it("draws again after a pause and resume", async () => {
			expect((await core.post("/api/sources/rtl/pause")).status).toBe(200)
			await page.waitForTimeout(4000)
			expect((await core.post("/api/sources/rtl/resume")).status).toBe(200)
			await alive()
		}, 60_000)

		it("draws again after the page's sockets drop during a pause", async () => {
			expect((await core.post("/api/sources/rtl/pause")).status).toBe(200)
			await page.waitForTimeout(2000)
			web.dropSockets()
			await page.waitForTimeout(2000)
			expect((await core.post("/api/sources/rtl/resume")).status).toBe(200)
			await alive()
		}, 60_000)
	},
)
