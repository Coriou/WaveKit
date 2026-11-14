/**
 * The set-up a user has, in headless Chrome: a protected core (harness.ts) behind the web server's
 * proxy, opened under the wrong loopback name, paired through the sheet, signed out and paired
 * again, and an address that changed from a production build (with its service worker) to the dev
 * server. Each case ends on the current code with a live waterfall, or on a chip that says where to
 * go. Everything is on 127.0.0.1 / localhost, on ports this run picked; nothing is written to the
 * repository.
 *
 * Opt-in like the smoke: WAVEKIT_BROWSER_SMOKE=1 and a Chrome or Chromium.
 */
import { mkdtemp, rm } from "node:fs/promises"
import type { ClientRequest, IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
} from "playwright-core"
import type { ProxyOptions, ViteDevServer } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	buildProduction,
	chromiumPath,
	loopbackPort,
	serveWeb,
	waterfallAlive,
	type WebServer,
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
const RECOVER_MS = 20_000

/**
 * The dev server as `pnpm dev` runs it (vite.config.ts and its plugins) on `port`, proxying to the
 * test core. The core gets the browser's host name on its own port, as a published container port
 * does, so it accepts 127.0.0.1 and refuses localhost.
 */
async function startDev(
	port: number,
	corePort: number,
	cacheDir: string,
): Promise<ViteDevServer> {
	assertAllowedPort(port)
	assertAllowedPort(corePort)
	const { createServer } = await import("vite")
	const api = `http://${LOOPBACK}:${corePort}`
	const withCorePort = (outgoing: ClientRequest, incoming: IncomingMessage) => {
		const host = incoming.headers.host
		if (host) outgoing.setHeader("host", host.replace(/:\d+$/, `:${corePort}`))
	}
	const entry = (target: string, ws: boolean): ProxyOptions => ({
		target,
		ws,
		changeOrigin: false,
		configure: proxy => {
			proxy.on("proxyReq", withCorePort)
			proxy.on("proxyReqWs", withCorePort)
		},
	})
	const server = await createServer({
		root: webRoot,
		logLevel: "silent",
		cacheDir,
		server: {
			host: LOOPBACK,
			port,
			strictPort: true,
			proxy: {
				"/api": entry(api, false),
				"/health": entry(api, false),
				"/ws": entry(api.replace(/^http/, "ws"), true),
			},
		},
	})
	await server.listen()
	return server
}

describe.skipIf(!enabled)(
	"a protected core, a browser and the address bar",
	() => {
		let core: RealCore
		let browser: Browser
		let context: BrowserContext
		let tmp = ""
		let devPort = 0
		let buildPort = 0
		let dev: ViteDevServer | null = null
		let built: WebServer | null = null
		let page: Page

		const pairBySheet = async (p: Page) => {
			await p.locator("button.wkf-conn-chip").click({ timeout: RECOVER_MS })
			await p.getByPlaceholder("ABCDE-FGHIJ").fill(await core.pairingCode())
			await p.locator('button[type="submit"]').click()
		}
		const streaming = async (p: Page) => {
			const alive = await within(RECOVER_MS, () => waterfallAlive(p))
			expect({
				alive,
				subscribed: (await core.subscribers()) >= 1,
				notes: await p.locator(".wk-plot-note").allInnerTexts(),
			}).toEqual({ alive: true, subscribed: true, notes: [] })
		}

		beforeAll(async () => {
			devPort = await loopbackPort()
			buildPort = await loopbackPort()
			core = await startRealCore({
				protectedOrigins: [
					`http://${LOOPBACK}:${devPort}`,
					`http://${LOOPBACK}:${buildPort}`,
				],
			})
			tmp = await mkdtemp(join(tmpdir(), "wavekit-web-setup-"))
			browser = await chromium.launch({
				...(exe ? { executablePath: exe } : {}),
				headless: true,
				args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
			})
			context = await browser.newContext({
				viewport: { width: 1280, height: 800 },
			})
			const local = (href: string) =>
				[LOOPBACK, "localhost"].includes(new URL(href).hostname)
			await context.route("**/*", route =>
				local(route.request().url()) ? route.continue() : route.abort(),
			)
			await context.routeWebSocket(
				url => !local(url.href),
				ws => ws.close(),
			)
			page = await context.newPage()
		}, 240_000)

		afterAll(async () => {
			await browser?.close()
			await dev?.close()
			await built?.close()
			await core?.stop()
			if (tmp) await rm(tmp, { recursive: true, force: true })
		}, 60_000)

		it("opened as localhost, the dev server sends the browser to the address the core accepts", async () => {
			dev = await startDev(devPort, core.apiPort, join(tmp, "vite-dev"))
			await page.goto(`http://localhost:${devPort}/#/scanner`, {
				waitUntil: "load",
			})
			expect(page.url()).toBe(`http://${LOOPBACK}:${devPort}/#/scanner`)
			await expect
				.poll(() => page.locator(".wkf-conn-chip").allInnerTexts(), {
					timeout: RECOVER_MS,
				})
				.toEqual(["Pair this browser\nRead-only until paired · Enter a code"])
		}, 120_000)

		it("paired through the sheet, it draws the spectrum without a reload", async () => {
			await pairBySheet(page)
			await streaming(page)
		}, 120_000)

		it("signed out and paired again, the spectrum comes back without a reload", async () => {
			const status = await page.evaluate(async () => {
				const session = (await (await fetch("/api/access/session")).json()) as {
					csrfToken: string
				}
				const answer = await fetch("/api/access/session/logout", {
					method: "POST",
					headers: { "X-WaveKit-CSRF": session.csrfToken },
				})
				return answer.status
			})
			expect(status).toBe(200)
			// the core closes the stream; the plot says why
			await expect
				.poll(() => page.locator(".wk-plot-note").allInnerTexts(), {
					timeout: 2 * RECOVER_MS,
				})
				.toEqual([expect.stringContaining("no longer signed in")])
			expect(await core.subscribers()).toBe(0)
			await pairBySheet(page)
			await streaming(page)
		}, 180_000)

		it("a production build opened as localhost says which address to open, and the chip goes there", async () => {
			await dev?.close()
			dev = null
			const outDir = join(tmp, "dist")
			await buildProduction(webRoot, outDir)
			built = await serveWeb(outDir, core.apiPort, {
				port: buildPort,
				corePortInHost: true,
			})
			await page.goto(`http://localhost:${buildPort}/`, { waitUntil: "load" })
			const chip = page.locator("a.wkf-conn-chip")
			await chip.waitFor({ timeout: RECOVER_MS })
			expect(await chip.innerText()).toBe(
				`This address is not accepted\nOpen ${LOOPBACK}:${buildPort} instead`,
			)
			await chip.click()
			await page.waitForURL(`http://${LOOPBACK}:${buildPort}/`)
			await expect
				.poll(() => page.locator(".wkf-conn-chip").allInnerTexts(), {
					timeout: RECOVER_MS,
				})
				.toEqual([])
			await streaming(page)
		}, 240_000)

		it("the production build's worker is removed once the address serves the dev server", async () => {
			const state = () =>
				page.evaluate(async () => ({
					workers: (await navigator.serviceWorker.getRegistrations()).length,
					shells: (await caches.keys()).filter(k =>
						k.startsWith("wavekit-shell-"),
					).length,
					dev: document.querySelector('script[src="/src/main.tsx"]') !== null,
				}))
			// the production page registered its worker; it controls the page after a reload
			await expect
				.poll(
					() =>
						page.evaluate(async () =>
							(await navigator.serviceWorker.getRegistrations()).some(
								r => r.active !== null,
							),
						),
					{ timeout: RECOVER_MS },
				)
				.toBe(true)
			await page.reload({ waitUntil: "load" })
			expect(
				await page.evaluate(() => navigator.serviceWorker.controller !== null),
			).toBe(true)
			expect(await state()).toMatchObject({ workers: 1, shells: 1, dev: false })

			await built?.close()
			built = null
			dev = await startDev(buildPort, core.apiPort, join(tmp, "vite-build"))
			// The open page still runs the old build. Its worker's next update check (asked for here
			// rather than waited for) gets the dev server's /sw.js, which removes the worker and reloads
			// the page: no reload by hand.
			await page.evaluate(async () => {
				const registration = await navigator.serviceWorker.getRegistration()
				await registration?.update()
			})
			await expect
				.poll(
					async () => {
						try {
							return await state()
						} catch {
							return null // navigating
						}
					},
					{ timeout: 3 * RECOVER_MS },
				)
				.toEqual({ workers: 0, shells: 0, dev: true })
			await streaming(page)
		}, 240_000)
	},
)
