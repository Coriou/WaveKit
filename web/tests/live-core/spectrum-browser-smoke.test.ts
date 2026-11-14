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
import { existsSync, readdirSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import * as http from "node:http"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { inflateSync } from "node:zlib"
import { chromium, type Browser, type Page } from "playwright-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	LOOPBACK,
	assertAllowedPort,
	startRealCore,
	within,
	type RealCore,
} from "./harness.ts"

function chromiumPath(): string | null {
	const env = process.env["PLAYWRIGHT_CHROMIUM_PATH"]
	if (env) return env
	const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	if (existsSync(mac)) return mac
	const root = "/opt/pw-browsers"
	if (!existsSync(root)) return null
	const dir = readdirSync(root).find(d => /^chromium-\d+$/.test(d))
	const bin = dir ? join(root, dir, "chrome-linux", "chrome") : null
	return bin && existsSync(bin) ? bin : null
}

const exe = chromiumPath()
const enabled = process.env["WAVEKIT_BROWSER_SMOKE"] === "1" && exe !== null
const webRoot = fileURLToPath(new URL("../../", import.meta.url))
const RECOVER_MS = 10_000

const TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webmanifest": "application/manifest+json",
	".woff2": "font/woff2",
}

interface WebServer {
	base: string
	/** Drops every proxied WebSocket (the page's data and spectrum sockets). */
	dropSockets(): void
	close(): Promise<void>
}

/** Serves `dir` (SPA fallback) and proxies the core's routes and its /ws upgrade, on an ephemeral loopback port. */
async function serveWeb(dir: string, corePort: number): Promise<WebServer> {
	assertAllowedPort(corePort)
	const upgraded = new Set<net.Socket>()
	const server = http.createServer((req, res) => {
		const url = req.url ?? "/"
		if (url.startsWith("/api/") || url.startsWith("/health")) {
			const upstream = http.request(
				{
					host: LOOPBACK,
					port: corePort,
					path: url,
					method: req.method,
					headers: req.headers,
				},
				answer => {
					res.writeHead(answer.statusCode ?? 502, answer.headers)
					answer.pipe(res)
				},
			)
			upstream.on("error", () => {
				if (!res.headersSent) res.writeHead(502)
				res.end()
			})
			req.pipe(upstream)
			return
		}
		const path = normalize(decodeURIComponent(url.split("?")[0] ?? "/"))
		const file = join(dir, path.endsWith("/") ? "index.html" : path)
		const inside = file.startsWith(dir)
		readFile(inside && existsSync(file) ? file : join(dir, "index.html")).then(
			body => {
				const type =
					inside && existsSync(file) ? TYPES[extname(file)] : "text/html"
				res.writeHead(200, {
					"content-type": type ?? "application/octet-stream",
				})
				res.end(body)
			},
			() => {
				res.writeHead(404)
				res.end()
			},
		)
	})
	server.on("upgrade", (req, socket, head) => {
		const upstream = net.connect(corePort, LOOPBACK, () => {
			const lines = [`${req.method} ${req.url} HTTP/1.1`]
			for (let i = 0; i < req.rawHeaders.length; i += 2)
				lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
			upstream.write(lines.join("\r\n") + "\r\n\r\n")
			if (head.length) upstream.write(head)
			socket.pipe(upstream)
			upstream.pipe(socket)
		})
		const s = socket as net.Socket
		upgraded.add(s)
		upgraded.add(upstream)
		const end = () => {
			s.destroy()
			upstream.destroy()
			upgraded.delete(s)
			upgraded.delete(upstream)
		}
		s.on("error", end)
		upstream.on("error", end)
		s.on("close", end)
		upstream.on("close", end)
	})
	await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
	const port = (server.address() as net.AddressInfo).port
	assertAllowedPort(port)
	return {
		base: `http://${LOOPBACK}:${port}/`,
		dropSockets: () => {
			for (const s of upgraded) s.destroy()
			upgraded.clear()
		},
		close: () =>
			new Promise<void>(resolve => {
				for (const s of upgraded) s.destroy()
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}

/** Decodes an 8-bit RGB or RGBA, non-interlaced PNG (what Chrome's screenshots are) to luminance. */
function pngLuma(png: Buffer): {
	width: number
	height: number
	luma: Float64Array
} {
	let pos = 8
	let width = 0
	let height = 0
	let channels = 4
	const idat: Buffer[] = []
	while (pos < png.length) {
		const len = png.readUInt32BE(pos)
		const type = png.toString("ascii", pos + 4, pos + 8)
		const data = png.subarray(pos + 8, pos + 8 + len)
		if (type === "IHDR") {
			width = data.readUInt32BE(0)
			height = data.readUInt32BE(4)
			if (data[8] !== 8 || data[12] !== 0)
				throw new Error("unexpected PNG format")
			channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0
			if (channels === 0) throw new Error("unexpected PNG colour type")
		} else if (type === "IDAT") idat.push(data)
		pos += 12 + len
	}
	const raw = inflateSync(Buffer.concat(idat))
	const stride = width * channels
	const prev = new Uint8Array(stride)
	const cur = new Uint8Array(stride)
	const luma = new Float64Array(width * height)
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? cur[x - channels]! : 0
			const b = prev[x]!
			const c = x >= channels ? prev[x - channels]! : 0
			let v = line[x]!
			if (filter === 1) v += a
			else if (filter === 2) v += b
			else if (filter === 3) v += Math.floor((a + b) / 2)
			else if (filter === 4) {
				const p = a + b - c
				const pa = Math.abs(p - a)
				const pb = Math.abs(p - b)
				const pc = Math.abs(p - c)
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
			}
			cur[x] = v & 0xff
		}
		for (let x = 0; x < width; x++)
			luma[y * width + x] =
				0.299 * cur[x * channels]! +
				0.587 * cur[x * channels + 1]! +
				0.114 * cur[x * channels + 2]!
		prev.set(cur)
	}
	return { width, height, luma }
}

/** The waterfall: the plot canvas below its trace (the lower half), as luminance. */
async function waterfall(page: Page): Promise<Float64Array> {
	const box = await page.locator(".wk-plot-body canvas").first().boundingBox()
	if (!box) throw new Error("no plot canvas")
	const png = await page.screenshot({
		clip: {
			x: box.x,
			y: box.y + box.height * 0.5,
			width: box.width,
			height: box.height * 0.45,
		},
	})
	return pngLuma(png).luma
}

function stddev(v: Float64Array): number {
	let sum = 0
	for (const x of v) sum += x
	const mean = sum / v.length
	let sq = 0
	for (const x of v) sq += (x - mean) ** 2
	return Math.sqrt(sq / v.length)
}

/** Mean absolute pixel change between two shots of the same region. */
function change(a: Float64Array, b: Float64Array): number {
	const n = Math.min(a.length, b.length)
	let d = 0
	for (let i = 0; i < n; i++) d += Math.abs(a[i]! - b[i]!)
	return d / n
}

/** Varied (not one flat colour) and moving (two shots 1.5 s apart differ). */
async function waterfallAlive(page: Page): Promise<boolean> {
	const first = await waterfall(page)
	await page.waitForTimeout(1500)
	const second = await waterfall(page)
	return stddev(second) > 3 && change(first, second) > 0.5
}

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
			const { build } = await import("vite")
			await build({
				root: webRoot,
				logLevel: "silent",
				build: { outDir, emptyOutDir: true, sourcemap: false },
			})
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
