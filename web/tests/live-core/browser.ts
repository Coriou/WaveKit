/**
 * Shared by the browser suites: finding a Chrome, a loopback server for a built app that proxies the
 * core's routes, and reading the waterfall off a screenshot. Screenshots stay in memory.
 */
import { existsSync, readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import * as http from "node:http"
import * as net from "node:net"
import { extname, join, normalize } from "node:path"
import { inflateSync } from "node:zlib"
import type { Page } from "playwright-core"
import { FORBIDDEN_PORTS, LOOPBACK, assertAllowedPort } from "./harness.ts"

export function chromiumPath(): string | null {
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

export interface WebServerOptions {
	/** Listen on this loopback port instead of an ephemeral one. */
	port?: number
	/**
	 * Send the core the browser's host name on the core's own port, as a published container port
	 * does: a protected test core accepts 127.0.0.1:<its port> only, so localhost stays refused.
	 */
	corePortInHost?: boolean
}

export interface WebServer {
	base: string
	/** Drops every proxied WebSocket (the page's data and spectrum sockets). */
	dropSockets(): void
	close(): Promise<void>
}

/** A loopback port that was free when probed and is not one of the forbidden ones. */
export async function loopbackPort(): Promise<number> {
	for (;;) {
		const probe = net.createServer()
		await new Promise<void>(resolve => probe.listen(0, LOOPBACK, resolve))
		const port = (probe.address() as net.AddressInfo).port
		await new Promise<void>(resolve => probe.close(() => resolve()))
		if (!FORBIDDEN_PORTS.has(port)) return port
	}
}

/**
 * Serves `dir` (SPA fallback) and proxies the core's routes and its /ws upgrade, on a loopback port
 * (ephemeral unless `listenPort` names one).
 */
export async function serveWeb(
	dir: string,
	corePort: number,
	options: WebServerOptions = {},
): Promise<WebServer> {
	const listenPort = options.port ?? 0
	/** The Host the core gets: the browser's, on the core's port when `corePortInHost`. */
	const hostFor = (host: string | undefined): string | undefined =>
		options.corePortInHost && host !== undefined
			? host.replace(/:\d+$/, `:${corePort}`)
			: host
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
					headers: { ...req.headers, host: hostFor(req.headers.host) },
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
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				const name = req.rawHeaders[i] ?? ""
				const value = req.rawHeaders[i + 1]
				lines.push(
					`${name}: ${name.toLowerCase() === "host" ? hostFor(value) : value}`,
				)
			}
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
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(listenPort, LOOPBACK, resolve)
	})
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

/** `vite build` of the web app as a production build (vitest's NODE_ENV=test would make a development one). */
export async function buildProduction(
	webRoot: string,
	outDir: string,
): Promise<void> {
	const { build } = await import("vite")
	const before = process.env["NODE_ENV"]
	process.env["NODE_ENV"] = "production"
	try {
		await build({
			root: webRoot,
			logLevel: "silent",
			build: { outDir, emptyOutDir: true, sourcemap: false },
		})
	} finally {
		if (before === undefined) delete process.env["NODE_ENV"]
		else process.env["NODE_ENV"] = before
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

/** A screenshot of a horizontal band of the plot canvas (fractions of its height), as luminance. */
export async function plotBand(
	page: Page,
	from: number,
	to: number,
): Promise<{ width: number; height: number; luma: Float64Array }> {
	const box = await page.locator(".wk-plot-body canvas").first().boundingBox()
	if (!box) throw new Error("no plot canvas")
	return pngLuma(
		await page.screenshot({
			clip: {
				x: box.x,
				y: box.y + box.height * from,
				width: box.width,
				height: box.height * (to - from),
			},
		}),
	)
}

/**
 * Whether the spectrum trace is drawn: its light line crosses most of the plot's width (a column
 * counts when it holds a pixel far lighter than the ground). An empty plot has the grid only.
 */
export async function traceDrawn(page: Page): Promise<boolean> {
	const { width, height, luma } = await plotBand(page, 0.02, 0.45)
	let lit = 0
	for (let x = 0; x < width; x++) {
		let max = 0
		for (let y = 0; y < height; y++) {
			const v = luma[y * width + x] ?? 0
			if (v > max) max = v
		}
		if (max > 140) lit++
	}
	return lit > width * 0.6
}

/**
 * Which side of the centre the waterfall's brightest column is on, in a band of rows under the
 * newest ones: the side of the test tone. It changes only when rows that arrived after the tone
 * moved are drawn. The middle (the tuned-frequency marker) and the left edge (the tuned card lies
 * over it) are left out, so the page needs a viewport at least 1600 px wide.
 */
export async function waterfallToneSide(
	page: Page,
): Promise<"upper" | "lower" | null> {
	const { width, height, luma } = await plotBand(page, 0.6, 0.64)
	let best = -1
	let bestX = 0
	let total = 0
	let columns = 0
	for (let x = Math.ceil(width * 0.22); x < width; x++) {
		if (Math.abs(x - width / 2) < width * 0.03) continue
		let sum = 0
		for (let y = 0; y < height; y++) sum += luma[y * width + x] ?? 0
		total += sum
		columns++
		if (sum > best) {
			best = sum
			bestX = x
		}
	}
	// a flat band has no tone to place
	if (columns === 0 || best < (total / columns) * 1.5 + height) return null
	return bestX > width / 2 ? "upper" : "lower"
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
export async function waterfallAlive(page: Page): Promise<boolean> {
	const first = await waterfall(page)
	await page.waitForTimeout(1500)
	const second = await waterfall(page)
	return stddev(second) > 3 && change(first, second) > 0.5
}
