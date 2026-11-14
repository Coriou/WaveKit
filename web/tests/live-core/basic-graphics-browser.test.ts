/**
 * A browser without WebGL2 (graphics acceleration off: Chrome does that by itself after GPU
 * crashes) against the real core (harness.ts), through the dev server: the spectrum must still
 * draw, with the 2D-canvas renderer, say that it does, and report it in its health readout.
 * Chrome is launched with its GPU and its software rasteriser disabled, so getContext("webgl2")
 * returns null as it does there.
 *
 * Opt-in like the smoke: WAVEKIT_BROWSER_SMOKE=1 and a Chrome or Chromium.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright-core"
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
const RECOVER_MS = 60_000

interface Health {
	rendererKind: string
	rendererThread: string
	reason: string | null
	framesReceived: number
	framesDrawn: number
	link: string
	lastError: string | null
}

describe.skipIf(!enabled)("a browser without WebGL2", () => {
	let core: RealCore
	let dev: ViteDevServer
	let browser: Browser
	let page: Page
	let tmp = ""
	const problems: string[] = []

	const health = () =>
		page.evaluate(
			() =>
				(
					window as unknown as {
						__wavekit?: { spectrumHealth?: () => Health }
					}
				).__wavekit?.spectrumHealth?.() ?? null,
		)

	beforeAll(async () => {
		core = await startRealCore()
		tmp = await mkdtemp(join(tmpdir(), "wavekit-web-basic-"))
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
		browser = await chromium.launch({
			...(exe ? { executablePath: exe } : {}),
			headless: true,
			args: ["--disable-gpu", "--disable-software-rasterizer"],
		})
		const context = await browser.newContext({
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
		page = await context.newPage()
		page.on("pageerror", error => problems.push(error.message))
		await page.goto(`http://${LOOPBACK}:${port}/`, { waitUntil: "load" })
		await page
			.locator(".wk-plot-body canvas")
			.first()
			.waitFor({ timeout: 60_000 })
	}, 240_000)

	afterAll(async () => {
		await browser?.close()
		await dev?.close()
		await core?.stop()
		if (tmp) await rm(tmp, { recursive: true, force: true })
	}, 60_000)

	it("has no WebGL2, as the browser this is about", async () => {
		expect(
			await page.evaluate(
				() => document.createElement("canvas").getContext("webgl2") === null,
			),
		).toBe(true)
	})

	it("draws the trace and the waterfall all the same, and follows the signal", async () => {
		const drawn = async (side: "upper" | "lower") => {
			let seen: unknown = null
			const ok = await within(RECOVER_MS, async () => {
				seen = {
					trace: await traceDrawn(page),
					tone: await waterfallToneSide(page),
				}
				return (
					(seen as { trace: boolean }).trace &&
					(seen as { tone: string | null }).tone === side
				)
			})
			expect({ ok, seen }).toEqual({
				ok: true,
				seen: { trace: true, tone: side },
			})
		}
		await drawn("upper")
		core.upstream.setToneSide("lower")
		await drawn("lower")
	}, 180_000)

	it("says that it draws in basic mode, and where to look", async () => {
		const chip = page.locator(".wk-plot-basic")
		expect(await chip.innerText()).toBe(
			"Graphics acceleration is off · basic mode",
		)
		expect(await chip.getAttribute("title")).toContain("chrome://gpu")
	})

	it("reports it in the health readout, with frames received and drawn", async () => {
		const first = await health()
		expect(first).toMatchObject({
			rendererKind: "canvas2d",
			rendererThread: "main",
			reason: expect.stringContaining("WebGL2 is unavailable"),
			link: "live",
			lastError: null,
		})
		// both counters move while the stream flows
		await expect
			.poll(
				async () => {
					const now = await health()
					return (
						now !== null &&
						first !== null &&
						now.framesReceived > first.framesReceived &&
						now.framesDrawn > first.framesDrawn
					)
				},
				{ timeout: RECOVER_MS },
			)
			.toBe(true)
	}, 120_000)

	it("raised no page error on the way", () => {
		expect(problems).toEqual([])
	})
})
