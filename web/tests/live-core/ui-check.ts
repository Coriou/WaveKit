/**
 * `node scripts/ui-check.mjs`: the web app seen and driven without a person. It pairs a headless
 * Chrome with a core, loads a route and reports, as JSON on stdout (one section per line):
 * console errors, failed requests, access state, the spectrum's health readout, whether the trace
 * is drawn and the waterfall moving, the notes and chips on screen, and where it saved screenshots.
 *
 * Targets:
 * - `--target=fake` (default, the only one for lanes): the real core as a child process fed by an
 *   in-process fake receiver (harness.ts), in protected mode, behind the Vite dev server, all on
 *   loopback ports picked at run time.
 * - `--target=live --url=<preview>`: an already running web server. Refused unless
 *   WAVEKIT_UI_CHECK_LIVE=1. The machine token is read from `--token-file` or `--access-dir`, never
 *   from the command line or the environment, and never printed.
 *
 * Every pairing it makes is named "ui-check" and is signed out when the run ends.
 * Exit: 0 healthy, 1 unhealthy, 2 could not run.
 */
import type { ClientRequest, IncomingMessage } from "node:http"
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { chromium, type Browser, type Page } from "playwright-core"
import type { ProxyOptions, ViteDevServer } from "vite"
import {
	chromiumPath,
	loopbackPort,
	plotBand,
	traceDrawn,
	waterfallToneSide,
} from "./browser.ts"
import {
	FORBIDDEN_PORTS,
	LOOPBACK,
	assertAllowedPort,
	startRealCore,
	within,
	type RealCore,
} from "./harness.ts"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const webRoot = fileURLToPath(new URL("../../", import.meta.url))

/** The name every pairing made here carries (Settings › Devices). */
export const DEVICE_NAME = "ui-check"
/** How long the spectrum may take to draw before the run reports what it sees (ms). */
const DRAW_WAIT_MS = 60_000
/** Between the two looks at the waterfall on a target whose signal the run does not control (ms). */
const LOOK_GAP_MS = 2000
/** Mean luminance change (0–255) of the newest waterfall rows that counts as moving. */
const MOVING_LUMA = 0.3

export const ACTIONS = [
	"pause",
	"resume",
	"retune",
	"rate",
	"hide",
	"show",
	"reload",
	"wait",
] as const
export type ActionName = (typeof ACTIONS)[number]
export interface Action {
	name: ActionName
	/** Hz for retune and rate, seconds for wait. */
	value: number | null
}

export interface Options {
	target: "fake" | "live"
	url: string | null
	accessDir: string | null
	tokenFile: string | null
	gpu: "on" | "off" | "software"
	route: string
	screenshot: boolean
	out: string | null
	actions: Action[]
	allow: ActionName[]
}

/** The run cannot start or finish (exit 2); the message never holds a credential. */
export class CannotRun extends Error {}

const isAction = (name: string): name is ActionName =>
	(ACTIONS as readonly string[]).includes(name)

/** `pause,retune:100.2e6,wait:5` → actions; throws CannotRun on anything it does not know. */
export function parseActions(text: string): Action[] {
	return text
		.split(",")
		.filter(part => part !== "")
		.map(part => {
			const [name = "", raw] = part.split(":")
			if (!isAction(name)) throw new CannotRun(`Unknown action: ${name}`)
			const needsValue = name === "retune" || name === "rate" || name === "wait"
			const value = raw === undefined ? null : Number(raw)
			if (needsValue !== (value !== null) || (value !== null && !(value > 0)))
				throw new CannotRun(
					needsValue
						? `Action ${name} needs a positive number: ${name}:<value>`
						: `Action ${name} takes no value`,
				)
			return { name, value }
		})
}

export function parseOptions(argv: readonly string[]): Options {
	const options: Options = {
		target: "fake",
		url: null,
		accessDir: null,
		tokenFile: null,
		gpu: "software",
		route: "",
		screenshot: false,
		out: null,
		actions: [],
		allow: [],
	}
	for (const arg of argv) {
		const [flag = "", ...rest] = arg.split("=")
		const value = rest.join("=")
		if (flag === "--screenshot" && rest.length === 0) options.screenshot = true
		else if (flag === "--target" && (value === "fake" || value === "live"))
			options.target = value
		else if (
			flag === "--gpu" &&
			(value === "on" || value === "off" || value === "software")
		)
			options.gpu = value
		else if (flag === "--url" && value) options.url = value
		else if (flag === "--access-dir" && value) options.accessDir = value
		else if (flag === "--token-file" && value) options.tokenFile = value
		else if (flag === "--route" && rest.length > 0) options.route = value
		else if (flag === "--out" && value) options.out = value
		else if (flag === "--do" && rest.length > 0)
			options.actions = parseActions(value)
		else if (flag === "--allow" && rest.length > 0)
			options.allow = parseActions(
				value
					.split(",")
					.map(name =>
						name === "retune" || name === "rate" || name === "wait"
							? `${name}:1`
							: name,
					)
					.join(","),
			).map(action => action.name)
		else throw new CannotRun(`Unknown or incomplete option: ${flag}`)
	}
	if (options.route !== "" && !options.route.startsWith("#"))
		throw new CannotRun("--route is a hash route, e.g. --route=#/scanner")
	if (options.target === "live") {
		if (process.env["WAVEKIT_UI_CHECK_LIVE"] !== "1")
			throw new CannotRun(
				"The live target is for the session that owns the live core: set WAVEKIT_UI_CHECK_LIVE=1. Lanes use --target=fake.",
			)
		if (options.url === null)
			throw new CannotRun("--target=live needs --url=<the preview>")
		let preview: URL
		try {
			preview = new URL(options.url)
		} catch {
			throw new CannotRun("--url is not a URL")
		}
		// the machine token goes to this host: never in clear text beyond this machine
		if (
			preview.protocol !== "https:" &&
			!(
				preview.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(preview.hostname)
			)
		)
			throw new CannotRun(
				"--url must be https, or http on this machine (localhost, 127.0.0.1, [::1])",
			)
		const refused = options.actions.filter(
			action => action.name !== "wait" && !options.allow.includes(action.name),
		)
		if (refused.length > 0)
			throw new CannotRun(
				`On the live target every action must be named in --allow: ${refused.map(a => a.name).join(", ")}`,
			)
	} else if (
		options.url !== null ||
		options.accessDir !== null ||
		options.tokenFile !== null
	)
		throw new CannotRun(
			"--url, --access-dir and --token-file belong to --target=live",
		)
	return options
}

/** Whether `path` is inside the repository checkout (screenshots never go there). */
export async function insideRepository(path: string): Promise<boolean> {
	const root = await realpath(repository)
	let target = resolve(path)
	// the directory may not exist yet: resolve its nearest existing parent
	for (;;) {
		try {
			target = join(await realpath(target), "")
			break
		} catch {
			const parent = resolve(target, "..")
			if (parent === target) break
			target = parent
		}
	}
	const base = root.endsWith(sep) ? root : root + sep
	return target === root || (target + sep).startsWith(base)
}

/** The machine token from a file, or from the one token file of an access directory. */
export async function readToken(
	options: Pick<Options, "accessDir" | "tokenFile">,
): Promise<string> {
	let file = options.tokenFile
	if (file === null && options.accessDir !== null) {
		const names = (await readdir(options.accessDir)).filter(name =>
			/machine.*token/i.test(name),
		)
		const only = names.length === 1 ? names[0] : undefined
		if (only === undefined)
			throw new CannotRun(
				"--access-dir holds no single machine token file: name the file with --token-file",
			)
		file = join(options.accessDir, only)
	}
	if (file === null)
		throw new CannotRun(
			"A protected core needs the machine token: --token-file=<file> or --access-dir=<dir>",
		)
	let text: string
	try {
		text = await readFile(file, "utf8")
	} catch {
		throw new CannotRun("The token file cannot be read")
	}
	const token = (text.split("\n")[0] ?? "").trim()
	if (!/^[A-Za-z0-9_-]{43}$/.test(token))
		throw new CannotRun("The token file does not hold a machine token")
	return token
}

/**
 * What a run paired, and how it takes it back. One per run, shared with the signal handlers, the
 * deadline and the report, so a device is revoked however the run ends: through the machine
 * route (it needs no browser), else by signing the page out.
 */
export class Pairing {
	/** The pairing form was submitted: from here on a device may exist on the core. */
	submitted = false
	deviceId: string | null = null
	/** null: nothing was paired; true or false: whether the device is gone. */
	revoked: boolean | null = null
	/** POST with the machine token; the HTTP status. */
	machinePost: ((path: string, body: unknown) => Promise<number>) | null = null
	/** Whether the core still lists the device (asked with the machine token). */
	machineHolds: ((deviceId: string) => Promise<boolean>) | null = null
	/** The device id of the page's session, null when it has none. */
	readDeviceId: (() => Promise<string | null>) | null = null
	/** Signs the page's session out; whether it is gone. */
	logout: (() => Promise<boolean>) | null = null
	private running: Promise<boolean | null> | null = null

	/** Revokes what was paired, once; later calls wait for the same outcome. */
	revoke(): Promise<boolean | null> {
		this.running ??= this.run()
		return this.running
	}

	private async run(): Promise<boolean | null> {
		if (!this.submitted) return null
		if (this.deviceId === null && this.readDeviceId)
			this.deviceId = await this.readDeviceId().catch(() => null)
		const id = this.deviceId
		let gone = false
		if (id !== null && this.machinePost) {
			const status = await this.machinePost(
				"/api/access/machine/devices/revoke",
				{ deviceId: id },
			).catch(() => 0)
			gone = status >= 200 && status < 300
			if (gone && this.machineHolds)
				gone = !(await this.machineHolds(id).catch(() => false))
		}
		if (!gone && this.logout) gone = await this.logout().catch(() => false)
		this.revoked = gone
		return gone
	}
}

export interface SpectrumHealth {
	rendererKind: string
	rendererThread: string
	reason: string | null
	framesReceived: number
	framesDrawn: number
	link: string
	lastError: string | null
}

export interface Look {
	health: SpectrumHealth | null
	traceDrawn: boolean
	/** moving: rows drawn after the look began; still: drawn but not changing; empty: nothing there. */
	waterfall: "moving" | "still" | "empty"
	framesAdvancing: boolean
	notes: string[]
	chips: string[]
}

/** The one-line reading of a look, for a person. */
export function summaryLine(look: Look): string {
	const h = look.health
	if (h === null) return "spectrum: no health readout (the plot is not mounted)"
	const drawn = look.traceDrawn ? "" : ", trace NOT drawn"
	const why =
		h.rendererKind === "webgl2" || h.reason === null ? "" : ` (${h.reason})`
	return `spectrum: ${h.rendererKind}${why}, ${h.framesReceived} frames received, ${h.framesDrawn} drawn, waterfall ${look.waterfall}${drawn}`
}

export function lookHealthy(look: Look): boolean {
	return (
		look.health !== null &&
		look.health.rendererKind !== "none" &&
		look.traceDrawn &&
		look.framesAdvancing &&
		look.waterfall === "moving"
	)
}

const readHealth = (page: Page): Promise<SpectrumHealth | null> =>
	page.evaluate(
		() =>
			(
				window as unknown as {
					__wavekit?: { spectrumHealth?: () => SpectrumHealth }
				}
			).__wavekit?.spectrumHealth?.() ?? null,
	)

/** Mean luminance change of the newest waterfall rows between two shots. */
async function stripChange(page: Page): Promise<number> {
	const first = await plotBand(page, 0.56, 0.62)
	await delay(LOOK_GAP_MS)
	const second = await plotBand(page, 0.56, 0.62)
	const n = Math.min(first.luma.length, second.luma.length)
	let sum = 0
	for (let i = 0; i < n; i++)
		sum += Math.abs((first.luma[i] ?? 0) - (second.luma[i] ?? 0))
	return n === 0 ? 0 : sum / n
}

/** Looks at the plot. With `core` (the fake target) the test tone changes side to prove new rows are drawn. */
async function look(page: Page, core: RealCore | null): Promise<Look> {
	const hasPlot = (await page.locator(".wk-plot-body canvas").count()) > 0
	if (hasPlot) await within(DRAW_WAIT_MS, () => traceDrawn(page))
	const before = await readHealth(page)
	const trace = hasPlot && (await traceDrawn(page))
	let waterfall: Look["waterfall"] = "empty"
	if (hasPlot && core !== null) {
		// the band read lies a little under the newest rows: wait until the waterfall has reached it
		let side: "upper" | "lower" | null = null
		await within(DRAW_WAIT_MS, async () => {
			side = await waterfallToneSide(page)
			return side !== null
		})
		if (side !== null) {
			const other = (side as string) === "upper" ? "lower" : "upper"
			core.upstream.setToneSide(other)
			waterfall = (await within(
				DRAW_WAIT_MS,
				async () => (await waterfallToneSide(page)) === other,
			))
				? "moving"
				: "still"
		}
	} else if (hasPlot) {
		const change = await stripChange(page)
		const band = await plotBand(page, 0.56, 0.62)
		let lit = false
		for (const v of band.luma)
			if (v > 24) {
				lit = true
				break
			}
		waterfall = change > MOVING_LUMA ? "moving" : lit ? "still" : "empty"
	}
	const after = await readHealth(page)
	return {
		health: after,
		traceDrawn: trace,
		waterfall,
		framesAdvancing:
			before !== null &&
			after !== null &&
			after.framesReceived > before.framesReceived &&
			after.framesDrawn > before.framesDrawn,
		notes: await page.locator(".wk-plot-note").allInnerTexts(),
		chips: [
			...(await page.locator(".wkf-conn-chip").allInnerTexts()),
			...(await page.locator(".wk-plot-chip").allInnerTexts()),
		].map(text => text.replace(/\s+/g, " ").trim()),
	}
}

/** POSTs as the page does: with this browser's session and its CSRF token. */
const postFromPage = (
	page: Page,
	path: string,
	body: unknown,
): Promise<number> =>
	page.evaluate(
		async ({ path, body }) => {
			const session = await fetch("/api/access/session")
			const csrf = session.ok
				? ((await session.json()) as { csrfToken?: string }).csrfToken
				: undefined
			const answer = await fetch(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(csrf ? { "X-WaveKit-CSRF": csrf } : {}),
				},
				body: JSON.stringify(body),
			})
			return answer.status
		},
		{ path, body },
	)

async function act(page: Page, action: Action): Promise<string> {
	const source = await page.evaluate(async () => {
		const answer = await fetch("/api/sources")
		const rows = answer.ok ? ((await answer.json()) as { id?: string }[]) : []
		return rows[0]?.id ?? null
	})
	const id = encodeURIComponent(source ?? "")
	switch (action.name) {
		case "pause":
		case "resume":
			return `HTTP ${await postFromPage(page, `/api/sources/${id}/${action.name}`, {})}`
		case "retune":
			return `HTTP ${await postFromPage(page, `/api/tuner/${id}/frequency`, { hz: action.value })}`
		case "rate":
			return `HTTP ${await postFromPage(page, `/api/tuner/${id}/sample-rate`, { hz: action.value })}`
		case "hide":
		case "show": {
			// simulated: the page is told it went out of (or came back into) view
			const state = action.name === "hide" ? "hidden" : "visible"
			await page.evaluate(value => {
				Object.defineProperty(document, "visibilityState", {
					configurable: true,
					get: () => value,
				})
				document.dispatchEvent(new Event("visibilitychange"))
			}, state)
			return `visibility ${state} (simulated)`
		}
		case "reload":
			await page.reload({ waitUntil: "load" })
			return "reloaded"
		case "wait":
			await delay((action.value ?? 0) * 1000)
			return `waited ${action.value} s`
	}
}

/** The dev server as `pnpm dev` runs it, proxying to the fake core, which sees the browser's host name on its own port. */
async function startDevServer(
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

const GPU_ARGS: Readonly<Record<Options["gpu"], string[]>> = {
	on: [],
	software: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
	off: ["--disable-gpu", "--disable-software-rasterizer"],
}

/** One section per line, so a report reads and diffs line by line. */
export function formatReport(report: Record<string, unknown>): string {
	const lines = Object.entries(report).map(
		([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
	)
	return `{\n${lines.join(",\n")}\n}`
}

export async function run(
	options: Options,
	pairing: Pairing = new Pairing(),
): Promise<{
	report: Record<string, unknown>
	healthy: boolean
}> {
	const exe = chromiumPath()
	if (exe === null)
		throw new CannotRun(
			"No Chrome or Chromium found (PLAYWRIGHT_CHROMIUM_PATH names one)",
		)
	const scratch = await mkdtemp(join(tmpdir(), "wavekit-ui-check-"))
	let shotDir: string | null = null
	if (options.screenshot) {
		shotDir =
			options.out === null ? join(scratch, "shots") : resolve(options.out)
		if (await insideRepository(shotDir))
			throw new CannotRun("Screenshots are never saved inside the repository")
		await mkdir(shotDir, { recursive: true })
	}
	let core: RealCore | null = null
	let dev: ViteDevServer | null = null
	let browser: Browser | null = null
	try {
		let base: string
		let token: string | null = null
		if (options.target === "fake") {
			const port = await loopbackPort()
			base = `http://${LOOPBACK}:${port}/`
			core = await startRealCore({
				protectedOrigins: [`http://${LOOPBACK}:${port}`],
			})
			dev = await startDevServer(port, core.apiPort, join(scratch, "vite"))
		} else {
			base = new URL(options.url ?? "").origin + "/"
			if (options.accessDir !== null || options.tokenFile !== null)
				token = await readToken(options)
		}
		// the machine route revokes without a browser: wired as soon as there is a credential
		const machine = async (
			method: "GET" | "POST",
			path: string,
			body?: unknown,
		): Promise<{ status: number; text: string }> => {
			if (core !== null) {
				if (method === "GET")
					return { status: 200, text: JSON.stringify(await core.get(path)) }
				const answer = await core.post(path, body)
				return { status: answer.status, text: JSON.stringify(answer.body) }
			}
			if (token === null) token = await readToken(options)
			const answer = await fetch(base + path.replace(/^\//, ""), {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
			return { status: answer.status, text: await answer.text() }
		}
		if (core !== null || token !== null) {
			pairing.machinePost = async (path, body) =>
				(await machine("POST", path, body)).status
			pairing.machineHolds = async deviceId =>
				(await machine("GET", "/api/access/machine/devices")).text.includes(
					deviceId,
				)
		}
		browser = await chromium.launch({
			executablePath: exe,
			headless: true,
			args: GPU_ARGS[options.gpu],
		})
		const context = await browser.newContext({
			// wide: the tuned card must not lie over the waterfall columns the look reads
			viewport: { width: 2000, height: 900 },
		})
		if (options.target === "fake") {
			// only this machine, and never a port of the live receiver or its tools (harness.ts)
			const allowed = (href: string) => {
				const url = new URL(href)
				const secure = url.protocol === "https:" || url.protocol === "wss:"
				const port = Number(url.port || (secure ? 443 : 80))
				return url.hostname === LOOPBACK && !FORBIDDEN_PORTS.has(port)
			}
			await context.route("**/*", route =>
				allowed(route.request().url()) ? route.continue() : route.abort(),
			)
			await context.routeWebSocket(
				url => !allowed(url.href),
				ws => ws.close(),
			)
		}
		const page = await context.newPage()
		const consoleErrors: string[] = []
		const failed = new Map<string, number>()
		const count = (key: string) => failed.set(key, (failed.get(key) ?? 0) + 1)
		page.on("pageerror", error =>
			consoleErrors.push(`uncaught: ${error.message}`),
		)
		page.on("console", message => {
			if (message.type() === "error")
				consoleErrors.push(message.text().slice(0, 300))
		})
		page.on("requestfailed", request =>
			count(
				`${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? "failed"}`,
			),
		)
		page.on("response", response => {
			if (response.status() >= 400)
				count(
					`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`,
				)
		})
		await page.goto(base + options.route, { waitUntil: "load" })
		await page.locator("#root > *").first().waitFor({ timeout: DRAW_WAIT_MS })

		// access: legacy, or protected and paired or not
		const access = await page.evaluate(async () => {
			const bootstrap = await fetch("/api/access/bootstrap")
			const session = await fetch("/api/access/session")
			return { bootstrap: bootstrap.status, paired: session.ok }
		})
		const mode =
			access.bootstrap === 404
				? "legacy"
				: access.bootstrap === 200
					? "protected"
					: `refused (HTTP ${access.bootstrap})`
		let pairedByRun = false
		if (mode === "protected" && !access.paired) {
			let code: string
			if (core !== null) code = await core.pairingCode()
			else {
				if (token === null) token = await readToken(options)
				const issued = await fetch(`${base}api/access/pairing-codes`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: "{}",
				}).catch(() => null)
				const body = issued?.ok
					? ((await issued.json()) as { code?: unknown })
					: null
				if (typeof body?.code !== "string")
					throw new CannotRun(
						`The core issued no pairing code (HTTP ${issued?.status ?? "no answer"})`,
					)
				code = body.code
			}
			await page
				.locator("button.wkf-conn-chip")
				.click({ timeout: DRAW_WAIT_MS })
			await page.getByPlaceholder("ABCDE-FGHIJ").fill(code)
			await page.getByPlaceholder("Kitchen tablet").fill(DEVICE_NAME)
			pairing.readDeviceId = () =>
				page.evaluate(async () => {
					const session = await fetch("/api/access/session")
					return session.ok
						? (((await session.json()) as { deviceId?: string }).deviceId ??
								null)
						: null
				})
			pairing.logout = async () => {
				const status = await postFromPage(
					page,
					"/api/access/session/logout",
					{},
				)
				const still = await page.evaluate(
					async () => (await fetch("/api/access/session")).ok,
				)
				return status === 200 && !still
			}
			// from the click on, a device may exist: it is revoked however this run ends
			pairing.submitted = true
			await page.locator('button[type="submit"]').click()
			await within(DRAW_WAIT_MS, async () => {
				pairing.deviceId = (await pairing.readDeviceId?.()) ?? null
				return pairing.deviceId !== null
			})
			if (pairing.deviceId === null)
				throw new CannotRun("Pairing did not complete")
			if (process.env["WAVEKIT_UI_CHECK_FAULT"] === "after-pairing")
				throw new Error("fault injected after pairing")
			pairedByRun = true
			// what failed before the browser was paired is the pairing chip's business, not a finding
			failed.clear()
			consoleErrors.length = 0
		}

		const shots: string[] = []
		const shoot = async (name: string) => {
			if (shotDir === null) return
			const file = join(shotDir, `${name}.png`)
			await page.screenshot({ path: file })
			shots.push(file)
		}
		const first = await look(page, core)
		await shoot("1-loaded")
		const done: { action: string; result: string }[] = []
		for (const action of options.actions)
			done.push({
				action:
					action.value === null
						? action.name
						: `${action.name}:${action.value}`,
				result: await act(page, action),
			})
		const last = options.actions.length > 0 ? await look(page, core) : null
		if (last !== null) await shoot("2-after-actions")

		// what the page logged and failed, before the run's own sign-out adds to it
		const errors = [...consoleErrors]
		const failures = [...failed].map(([what, times]) => ({ what, times }))
		// leave no device behind (the finally below does the same when the run ends early)
		const revoked = await pairing.revoke()
		const final = last ?? first
		const healthy =
			lookHealthy(final) &&
			!errors.some(text => text.startsWith("uncaught:")) &&
			revoked !== false
		const report: Record<string, unknown> = {
			healthy,
			summary: summaryLine(final),
			target: {
				kind: options.target,
				url: base + options.route,
				gpu: options.gpu,
			},
			access: {
				mode,
				pairedBefore: access.paired,
				pairedByRun,
				device: pairedByRun ? DEVICE_NAME : null,
				revokedAtEnd: revoked,
			},
			consoleErrors: errors,
			failedRequests: failures,
			spectrum: first,
			...(last !== null ? { actions: done, spectrumAfterActions: last } : {}),
			screenshots: shots,
		}
		return { report, healthy }
	} finally {
		// first of all, while the core (and maybe the browser) is still there
		await pairing.revoke().catch(() => null)
		await browser?.close().catch(() => undefined)
		await dev?.close().catch(() => undefined)
		await core?.stop().catch(() => undefined)
		// the scratch directory goes, unless the screenshots were saved in it
		const keepShots = options.screenshot && options.out === null
		await rm(keepShots ? join(scratch, "vite") : scratch, {
			recursive: true,
			force: true,
		}).catch(() => undefined)
	}
}

/** A run that has not ended after this long (ms) is given up: its device is revoked and it exits 2. */
const DEADLINE_MS = 6 * 60_000

async function main(): Promise<void> {
	const pairing = new Pairing()
	/** Ends the process after revoking what was paired: a signal, or the deadline. */
	const giveUp = (why: string) => {
		void pairing
			.revoke()
			.catch(() => false)
			.then(() => {
				process.stdout.write(
					formatReport({
						healthy: false,
						cannotRun: why,
						revokedAtEnd: pairing.revoked,
					}) + "\n",
				)
				process.exit(2)
			})
	}
	process.once("SIGINT", () => giveUp("Interrupted"))
	process.once("SIGTERM", () => giveUp("Terminated"))
	const deadline = setTimeout(
		() => giveUp(`Not finished after ${DEADLINE_MS / 1000} s`),
		DEADLINE_MS,
	)
	try {
		const { report, healthy } = await run(
			parseOptions(process.argv.slice(2)),
			pairing,
		)
		process.stdout.write(formatReport(report) + "\n")
		process.stderr.write(String(report["summary"]) + "\n")
		process.exitCode = healthy ? 0 : 1
	} catch (error) {
		const message =
			error instanceof CannotRun
				? error.message
				: `ui-check failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`
		process.stdout.write(
			formatReport({
				healthy: false,
				cannotRun: message,
				revokedAtEnd: pairing.revoked,
			}) + "\n",
		)
		process.exitCode = 2
	} finally {
		clearTimeout(deadline)
	}
}

const invoked = process.argv[1]
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href)
	void main()
