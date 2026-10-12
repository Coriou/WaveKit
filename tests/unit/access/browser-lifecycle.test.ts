import { EventEmitter } from "node:events"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import fc from "fast-check"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
	accessBootstrapDtoSchema,
	accessDevicesDtoSchema,
} from "@wavekit/api-types"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeContext } from "../../../src/access/runtime-context.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import {
	AudioClientRegistry,
	AudioHttpServer,
} from "../../../src/core/audio-stream-server.js"
import {
	BrowserClient,
	machinePost,
} from "../../helpers/access-browser/browser-client.js"
import type {
	BrowserByteStream,
	BrowserSocket,
} from "../../helpers/access-browser/browser-client.js"
import { CookieJar } from "../../helpers/access-browser/cookie-jar.js"

const DAY = 24 * 60 * 60 * 1000
const API_HOST = "receiver.lan:9000"
const ANALOG_HOST = "receiver.lan:9001"
const DIGITAL_HOST = "receiver.lan:9002"

const sessionSchema = z
	.object({
		deviceId: z.string(),
		expiresAt: z.number(),
		csrfToken: z.string(),
	})
	.strict()
const codeSchema = z
	.object({ code: z.string(), expiresInSeconds: z.number() })
	.strict()

const servers: ApiServer[] = []
const contexts: NamedAccessRuntimeContext[] = []
const audios: AudioHttpServer[] = []
const roots: string[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	for (const audio of audios.splice(0)) await audio.close()
	for (const server of servers.splice(0)) await server.stop()
	for (const context of contexts.splice(0)) await context.close()
	for (const root of roots.splice(0)) {
		await chmod(root, 0o700).catch(() => undefined)
		await rm(root, { recursive: true, force: true })
	}
})

function drop<T>(list: T[], item: T): void {
	const index = list.indexOf(item)
	if (index >= 0) list.splice(index, 1)
}

async function reservePort(): Promise<number> {
	const probe = createNetServer()
	await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", () => resolve()))
	const address = probe.address()
	await new Promise<void>(resolve => probe.close(() => resolve()))
	if (!address || typeof address === "string") throw new Error("Missing port")
	return address.port
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
	if (!requestPath.startsWith(cookiePath)) return false
	if (requestPath.length === cookiePath.length || cookiePath.endsWith("/"))
		return true
	return requestPath[cookiePath.length] === "/"
}

interface Stack {
	readonly directory: string
	readonly privateDirectory: string
	readonly token: string
	readonly scheme: "http" | "https"
	readonly apiOrigin: string
	readonly analogOrigin: string
	readonly digitalOrigin: string
	readonly server: ApiServer
	readonly context: NamedAccessRuntimeContext
	browser(jar?: CookieJar): BrowserClient
	releaseListeners(): Promise<void>
}

async function setup(
	options: {
		readonly scheme?: "http" | "https"
		readonly directory?: string
		readonly token?: string
	} = {},
): Promise<Stack> {
	const scheme = options.scheme ?? "http"
	const apiOrigin = `${scheme}://${API_HOST}`
	const analogOrigin = `${scheme}://${ANALOG_HOST}`
	const digitalOrigin = `${scheme}://${DIGITAL_HOST}`
	let directory = options.directory
	let token = options.token
	if (directory === undefined || token === undefined) {
		const root = await mkdtemp(join(tmpdir(), "wavekit-browser-access-"))
		roots.push(root)
		directory = join(root, "private")
		const provisioned = await PrivateAccessStorage.open({
			directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		token = provisioned.useMachineCredential(value => value)
		await provisioned.close()
	}
	const context = await openAccessRuntime({
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap: {
			mode: "protected",
			listenerScheme: scheme,
			allowedAuthorities: [API_HOST],
			allowedOrigins: [apiOrigin],
			externalAudioOrigins: [analogOrigin, digitalOrigin],
		},
		audio: {
			analog: { listenerScheme: scheme, allowedAuthorities: [ANALOG_HOST] },
			digital: { listenerScheme: scheme, allowedAuthorities: [DIGITAL_HOST] },
		},
	})
	contexts.push(context)
	const logger = pino({ level: "silent" })
	const sourceManager = Object.assign(new EventEmitter(), {
		connect: vi.fn(),
		disconnect: vi.fn(),
		getStatus: vi.fn(),
		getAllStatus: vi.fn(() => []),
		getStream: vi.fn(),
		getSourceAssignments: vi.fn(() => []),
		isSourceAvailable: vi.fn(() => true),
		assignDecoder: vi.fn(),
		unassignDecoder: vi.fn(),
		getAssignedSource: vi.fn(),
		getCaps: vi.fn(),
		isCompatible: vi.fn(() => true),
	})
	const decoderManager = Object.assign(new EventEmitter(), {
		createDecoder: vi.fn(),
		startDecoder: vi.fn(),
		stopDecoder: vi.fn(),
		restartDecoder: vi.fn(),
		getDecoder: vi.fn(),
		getAllDecoders: vi.fn(() => []),
		getStatus: vi.fn(),
		getAllStatus: vi.fn(() => []),
		getAllHealth: vi.fn(() => new Map()),
	})
	const fanoutManager = Object.assign(new EventEmitter(), {
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		addBranch: vi.fn(),
		removeBranch: vi.fn(),
		getBranchIds: vi.fn(() => []),
		getBranchStatus: vi.fn(),
		getBranchTelemetry: vi.fn(),
		getTelemetrySnapshot: vi.fn(() => ({
			timestamp: new Date().toISOString(),
			branches: [],
			backpressureActiveCount: 0,
			droppedBytesTotal: 0,
			droppedChunksTotal: 0,
		})),
		destroy: vi.fn(),
	})
	const dependencies: ApiServerDependencies = {
		access: context,
		logger,
		liveDemod: {
			getStatus: () => ({ running: false }),
		} as unknown as ApiServerDependencies["liveDemod"],
		digitalVoice: {
			getStatus: () => ({ running: false }),
		} as unknown as ApiServerDependencies["digitalVoice"],
		sourceManager:
			sourceManager as unknown as ApiServerDependencies["sourceManager"],
		decoderManager:
			decoderManager as unknown as ApiServerDependencies["decoderManager"],
		fanoutManager:
			fanoutManager as unknown as ApiServerDependencies["fanoutManager"],
		audioOutput: Object.assign(new EventEmitter(), {
			start: vi.fn(),
			stop: vi.fn(),
			attachSource: vi.fn(),
			detachSource: vi.fn(),
			getConnectedClients: vi.fn(() => 0),
			getPort: vi.fn(() => 8080),
		}) as unknown as ApiServerDependencies["audioOutput"],
	}
	const server = new ApiServer(dependencies, {
		host: "127.0.0.1",
		port: 0,
		accessBootstrap: {
			mode: "protected",
			listenerScheme: scheme,
			allowedAuthorities: [API_HOST],
			allowedOrigins: [apiOrigin],
			externalAudioOrigins: [analogOrigin, digitalOrigin],
		},
		publicOrigins: {
			api: apiOrigin,
			analogAudio: analogOrigin,
			digitalAudio: digitalOrigin,
		},
	})
	servers.push(server)
	await server.start()
	const bound = server.getApp().addresses()[0]
	if (!bound) throw new Error("Missing API listener")
	const [analogPort, digitalPort] = await Promise.all([
		reservePort(),
		reservePort(),
	])
	const stream = { rate: 16000, format: "s16le" as const }
	const analogRegistry = new AudioClientRegistry(logger, {
		stallTimeoutMs: 60_000,
		label: "analog",
		stream,
	})
	const digitalRegistry = new AudioClientRegistry(logger, {
		stallTimeoutMs: 60_000,
		label: "digital",
		stream,
	})
	const analog = new AudioHttpServer(
		logger,
		"analog",
		request => {
			const path = (request.url ?? "").split("?")[0] ?? ""
			const wav = path.endsWith(".wav")
			const base = wav ? path.slice(0, -4) : path
			if (base !== "/stream") return null
			return { registry: analogRegistry, stream, wav }
		},
		() => undefined,
		context.analogAudio,
	)
	const digital = new AudioHttpServer(
		logger,
		"digital",
		request => {
			const path = (request.url ?? "").split("?")[0] ?? ""
			const wav = path.endsWith(".wav")
			const base = wav ? path.slice(0, -4) : path
			if (base !== "/stream") return null
			return { registry: digitalRegistry, stream, wav }
		},
		() => undefined,
		context.digitalAudio,
	)
	audios.push(analog, digital)
	await analog.start(analogPort, "127.0.0.1")
	await digital.start(digitalPort, "127.0.0.1")
	const bindings = [
		{ host: API_HOST, port: bound.port },
		{ host: ANALOG_HOST, port: analogPort },
		{ host: DIGITAL_HOST, port: digitalPort },
	]
	const privateDirectory = directory
	const machineToken = token
	return {
		directory,
		privateDirectory,
		token: machineToken,
		scheme,
		apiOrigin,
		analogOrigin,
		digitalOrigin,
		server,
		context,
		browser(jar = new CookieJar()) {
			return new BrowserClient({
				jar,
				documentOrigin: apiOrigin,
				apiOrigin,
				bindings,
			})
		},
		async releaseListeners() {
			await analog.close()
			await digital.close()
			drop(audios, analog)
			drop(audios, digital)
			await server.stop()
			drop(servers, server)
			await context.close()
			drop(contexts, context)
		},
	}
}

function cookieValue(client: BrowserClient): string {
	const header = client.jar.cookieHeader(
		`${client.apiOrigin}/api/access/session`,
		client.documentOrigin,
	)
	const value = header?.split("=")[1]
	if (!value) throw new Error("Missing session cookie")
	return value
}

function assertNoPrivate(
	response: { networkBody: string; headers: IncomingHttpHeaders },
	secrets: readonly string[],
): void {
	const headers = Object.entries(response.headers)
		.filter(([name]) => name !== "set-cookie")
		.flatMap(([, value]) =>
			value === undefined ? [] : typeof value === "string" ? [value] : value,
		)
		.join("\n")
	const text = `${response.networkBody}\n${headers}`
	for (const secret of secrets)
		if (secret.length > 0) expect(text).not.toContain(secret)
}

async function issuedCode(env: Stack): Promise<string> {
	const issued = await machinePost(
		{ host: API_HOST, port: env.server.getApp().addresses()[0]?.port ?? 0 },
		env.token,
		"/api/access/pairing-codes",
	)
	expect(issued.status).toBe(201)
	assertNoPrivate(issued, [env.token, env.privateDirectory])
	return codeSchema.parse(issued.json()).code
}

async function signIn(env: Stack, client: BrowserClient) {
	const bootstrap = await client.fetch(`${env.apiOrigin}/api/access/bootstrap`)
	expect(bootstrap.status).toBe(200)
	expect(bootstrap.headers["set-cookie"]).toBeUndefined()
	const dto = accessBootstrapDtoSchema.parse(bootstrap.json())
	expect(dto).toMatchObject({
		version: 1,
		apiOrigin: env.apiOrigin,
		webSocketUrl: `${env.apiOrigin.replace(/^http/, "ws")}/ws`,
		analogAudioOrigin: env.analogOrigin,
		digitalAudioOrigin: env.digitalOrigin,
		access: { mode: "protected", sessionAvailable: true, pairingAvailable: true },
	})
	const anonymous = await client.fetch(`${env.apiOrigin}/api/access/session`)
	expect(anonymous.status).toBe(401)
	expect(anonymous.json()).toEqual({ code: "AUTH_REQUIRED" })
	const code = await issuedCode(env)
	const paired = await client.fetch(`${env.apiOrigin}/api/access/pair`, {
		method: "POST",
		json: { code },
	})
	expect(paired.status).toBe(201)
	expect(paired.preflight).toBeUndefined()
	const body = sessionSchema.parse(paired.json())
	const setCookie = headerList(paired.headers).join("\n")
	expect(setCookie).toContain("wavekit_session=")
	expect(paired.networkBody).not.toContain(cookieValue(client))
	expect(client.documentCookie()).toBe("")
	const confirmed = await client.fetch(`${env.apiOrigin}/api/access/session`)
	expect(confirmed.status).toBe(200)
	expect(sessionSchema.parse(confirmed.json())).toEqual(body)
	expect(confirmed.headers["set-cookie"]).toBeUndefined()
	return { body, bootstrap: dto, setCookie }
}

async function expectSocketClosed(
	socket: BrowserSocket,
	code: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<number>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("WebSocket stayed open")), 1500)
	})
	try {
		expect(await Promise.race([socket.closeCode, timeout])).toBe(code)
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function expectStreamClosed(stream: BrowserByteStream): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<void>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("audio stream stayed open")), 1500)
	})
	try {
		await Promise.race([stream.closed, timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

describe("browser cookie jar", () => {
	it("follows Path, Secure, SameSite and HttpOnly for the origin", () => {
		// Feature: browser-access-batch1, Property 1: cookie eligibility follows Path, Secure, SameSite and HttpOnly
		// Validates: browser-access-batch1 acceptance cookie jar
		fc.assert(
			fc.property(
				fc.record({
					path: fc.constantFrom("/", "/api", "/api/access"),
					requestPath: fc.constantFrom(
						"/",
						"/api",
						"/api/access",
						"/api/access/session",
						"/other",
					),
					requestPort: fc.constantFrom(9000, 9001),
					secure: fc.boolean(),
					httpOnly: fc.boolean(),
					sameSite: fc.constantFrom("strict" as const, "lax" as const, "none" as const),
					crossSite: fc.boolean(),
					https: fc.boolean(),
					topLevelGet: fc.boolean(),
				}),
				input => {
					const jar = new CookieJar()
					const scheme = input.https ? "https" : "http"
					const attributes = [
						`Path=${input.path}`,
						`SameSite=${input.sameSite}`,
						input.secure ? "Secure" : "",
						input.httpOnly ? "HttpOnly" : "",
					].filter(attribute => attribute.length > 0)
					jar.apply(`${scheme}://receiver.lan:9000/api/access/pair`, [
						`wavekit_session=token; ${attributes.join("; ")}`,
					])
					const stored =
						!(input.sameSite === "none" && !input.secure) &&
						!(input.secure && !input.https)
					const requestUrl = `${scheme}://receiver.lan:${input.requestPort}${input.requestPath}`
					const documentUrl = `${scheme}://${input.crossSite ? "evil.example" : "receiver.lan"}/`
					const header = jar.cookieHeader(requestUrl, documentUrl, {
						topLevelGet: input.topLevelGet,
					})
					const siteOk =
						input.sameSite === "none" ||
						!input.crossSite ||
						(input.topLevelGet && input.sameSite === "lax")
					const sent =
						stored &&
						pathMatches(input.path, input.requestPath) &&
						(!input.secure || input.https) &&
						siteOk
					expect(header).toBe(sent ? "wavekit_session=token" : undefined)
					const visible =
						stored &&
						!input.httpOnly &&
						pathMatches(input.path, "/") &&
						(!input.secure || input.https)
					expect(jar.documentCookie(`${scheme}://receiver.lan/`)).toBe(
						visible ? "wavekit_session=token" : "",
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("browser client preflight", () => {
	it("sends a CORS preflight only for a cross-origin non-simple request", async () => {
		const hits: string[] = []
		const server = createServer((request, response) => {
			hits.push(request.method ?? "")
			const origin = request.headers["origin"]
			if (origin === "http://evil.example") {
				response.writeHead(403)
				response.end()
				return
			}
			const headers: Record<string, string> = {
				"Access-Control-Allow-Origin": typeof origin === "string" ? origin : "",
				"Access-Control-Allow-Credentials": "true",
				"Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "content-type, x-wavekit-csrf",
				Vary: "Origin",
			}
			if (request.method === "OPTIONS") {
				response.writeHead(204, headers)
				response.end()
				return
			}
			response.writeHead(200, { ...headers, "Content-Type": "application/json" })
			response.end("{}")
		})
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()))
		const address = server.address()
		if (!address || typeof address === "string") throw new Error("Missing port")
		try {
			const binding = { host: `127.0.0.1:${address.port}`, port: address.port }
			const url = `http://${binding.host}/submit`
			const same = new BrowserClient({
				jar: new CookieJar(),
				documentOrigin: `http://${binding.host}`,
				apiOrigin: `http://${binding.host}`,
				bindings: [binding],
			})
			same.csrf = "csrf-token"
			hits.length = 0
			const direct = await same.fetch(url, { method: "POST", json: { ok: true } })
			expect(direct.status).toBe(200)
			expect(direct.preflight).toBeUndefined()
			expect(hits).toEqual(["POST"])
			const cross = new BrowserClient({
				jar: new CookieJar(),
				documentOrigin: "http://page.example",
				apiOrigin: `http://${binding.host}`,
				bindings: [binding],
			})
			cross.csrf = "csrf-token"
			hits.length = 0
			const preflighted = await cross.fetch(url, {
				method: "POST",
				json: { ok: true },
			})
			expect(preflighted.preflight?.status).toBe(204)
			expect(preflighted.sent).toBe(true)
			expect(hits).toEqual(["OPTIONS", "POST"])
			hits.length = 0
			const blocked = await cross.fetch(url, {
				method: "POST",
				json: { ok: true },
				origin: "http://evil.example",
			})
			expect(blocked.sent).toBe(false)
			expect(blocked.corsBlocked).toBe(true)
			expect(blocked.preflight?.status).toBe(403)
			expect(hits).toEqual(["OPTIONS"])
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()))
		}
	})
})

describe("browser lifecycle against the assembled access server", () => {
	it("bootstraps, pairs a machine-issued code, and confirms the cookie through session status", async () => {
		const env = await setup()
		const client = env.browser()
		const { body, setCookie } = await signIn(env, client)
		expect(body.deviceId.startsWith("device_")).toBe(true)
		expect(setCookie).toContain("Path=/")
		expect(setCookie).toContain("HttpOnly")
		expect(setCookie).toContain("SameSite=Strict")
		expect(setCookie).not.toContain("Secure")
		expect(client.documentCookie()).toBe("")
		expect(
			client.jar.cookieHeader(
				`${env.apiOrigin}/api/access/session`,
				env.apiOrigin,
			),
		).toMatch(/^wavekit_session=\S+$/)
	})

	it("keeps HttpOnly, Path, SameSite and Secure on the real Set-Cookie", async () => {
		const httpEnv = await setup()
		const httpClient = httpEnv.browser()
		const httpSession = await signIn(httpEnv, httpClient)
		const httpCookie = httpSession.setCookie
		expect(httpCookie).toContain("Path=/")
		expect(httpCookie).toContain("HttpOnly")
		expect(httpCookie).toContain("SameSite=Strict")
		expect(httpCookie).toContain("Max-Age=2592000")
		expect(httpCookie).not.toContain("Secure")
		expect(httpClient.documentCookie()).toBe("")
		expect(
			httpClient.jar.cookieHeader(
				"http://evil.example/api/access/session",
				httpEnv.apiOrigin,
			),
		).toBeUndefined()
		expect(
			httpClient.jar.cookieHeader(
				`${httpEnv.analogOrigin}/stream.wav`,
				httpEnv.apiOrigin,
			),
		).toMatch(/^wavekit_session=/)

		const httpsEnv = await setup({ scheme: "https" })
		const httpsClient = httpsEnv.browser()
		const httpsSession = await signIn(httpsEnv, httpsClient)
		expect(httpsSession.setCookie).toContain("Secure")
		expect(
			httpsClient.jar.cookieHeader(
				"http://receiver.lan:9000/api/access/session",
				httpsEnv.apiOrigin,
			),
		).toBeUndefined()
		const again = await httpsClient.fetch(
			`${httpsEnv.apiOrigin}/api/access/session`,
		)
		expect(again.status).toBe(200)
	})

	it("requires CSRF for unsafe calls and still answers a preflight where a browser would send one", async () => {
		const env = await setup()
		const client = env.browser()
		await signIn(env, client)
		client.requests.length = 0
		const missing = await client.fetch(
			`${env.apiOrigin}/api/access/session/refresh`,
			{ method: "POST", csrf: false },
		)
		expect(missing.status).toBe(403)
		expect(missing.json()).toEqual({ code: "CSRF_REQUIRED" })
		expect(missing.preflight).toBeUndefined()
		expect(client.requests.map(entry => entry.method)).toEqual(["POST"])
		const logout = await client.fetch(
			`${env.apiOrigin}/api/access/session/logout`,
			{ method: "POST", csrf: false },
		)
		expect(logout.status).toBe(403)
		expect(
			(await client.fetch(`${env.apiOrigin}/api/access/session`)).status,
		).toBe(200)
		const refreshed = await client.refresh()
		expect(refreshed.status).toBe(200)
		const audio = await client.fetch(`${env.analogOrigin}/stream`, {
			method: "POST",
			json: {},
		})
		expect(audio.preflight?.status).toBe(204)
		expect(audio.sent).toBe(true)
		expect(audio.status).toBe(404)
		const blocked = await client.fetch(`${env.analogOrigin}/stream`, {
			method: "POST",
			json: {},
			origin: "http://evil.example",
		})
		expect(blocked.preflight?.status).toBe(403)
		expect(blocked.sent).toBe(false)
	})

	it("renews near day 30 on a fake clock and expires after 30 days without refresh", async () => {
		const real = performance.now.bind(performance)
		let offset = 0
		const spy = vi
			.spyOn(performance, "now")
			.mockImplementation(() => real() + offset)
		try {
			const env = await setup()
			const client = env.browser()
			const { body } = await signIn(env, client)
			offset += 29 * DAY
			const renewed = await client.refresh()
			expect(renewed.status).toBe(200)
			const next = sessionSchema.parse(renewed.json())
			expect(next.deviceId).toBe(body.deviceId)
			expect(next.csrfToken).toBe(body.csrfToken)
			expect(next.expiresAt).toBeGreaterThanOrEqual(body.expiresAt + 29 * DAY - 1000)
			expect(next.expiresAt).toBeLessThanOrEqual(body.expiresAt + 29 * DAY + 5000)
			const devices = accessDevicesDtoSchema.parse(
				(await client.fetch(`${env.apiOrigin}/api/access/devices`)).json(),
			)
			expect(devices.devices[0]?.renewedAt).toBeGreaterThan(
				devices.devices[0]?.createdAt ?? 0,
			)
			offset += 31 * DAY
			const expired = await client.fetch(`${env.apiOrigin}/api/access/session`)
			expect(expired.status).toBe(401)
			expect(expired.json()).toEqual({ code: "AUTH_REQUIRED" })
			const refresh = await client.fetch(
				`${env.apiOrigin}/api/access/session/refresh`,
				{ method: "POST" },
			)
			expect(refresh.status).toBe(401)
		} finally {
			spy.mockRestore()
		}
	})

	it("does not renew a session when a WebSocket receives only passive frames", async () => {
		const env = await setup()
		const client = env.browser()
		const { bootstrap } = await signIn(env, client)
		const before = accessDevicesDtoSchema.parse(
			(await client.fetch(`${env.apiOrigin}/api/access/devices`)).json(),
		)
		const row = before.devices[0]
		if (!row) throw new Error("Missing device")
		expect(row.renewedAt).toBe(row.createdAt)
		const socket = await client.openSocket(bootstrap.webSocketUrl)
		expect(socket.opened).toBe(true)
		socket.send(JSON.stringify({ type: "subscribe", channels: ["status"] }))
		socket.send("{\"type\":\"ping\"}")
		await delay(400)
		const after = accessDevicesDtoSchema.parse(
			(await client.fetch(`${env.apiOrigin}/api/access/devices`)).json(),
		)
		expect(after.devices[0]).toEqual(row)
		socket.close()
	})

	it("keeps one session when two tabs refresh together and coalesces a tab's own triggers", async () => {
		const env = await setup()
		const tabA = env.browser()
		const { body } = await signIn(env, tabA)
		const tabB = env.browser(tabA.jar)
		const primed = await tabB.fetch(`${env.apiOrigin}/api/access/session`)
		expect(primed.status).toBe(200)
		expect(tabB.csrf).toBe(body.csrfToken)
		const [left, right] = await Promise.all([
			tabA.fetch(`${env.apiOrigin}/api/access/session/refresh`, {
				method: "POST",
			}),
			tabB.fetch(`${env.apiOrigin}/api/access/session/refresh`, {
				method: "POST",
			}),
		])
		expect(left.status).toBe(200)
		expect(right.status).toBe(200)
		expect(sessionSchema.parse(left.json()).deviceId).toBe(body.deviceId)
		expect(sessionSchema.parse(right.json()).deviceId).toBe(body.deviceId)
		expect(
			(await tabA.fetch(`${env.apiOrigin}/api/access/session`)).status,
		).toBe(200)
		expect(
			(await tabB.fetch(`${env.apiOrigin}/api/access/session`)).status,
		).toBe(200)
		tabA.requests.length = 0
		const first = tabA.refresh()
		const second = tabA.refresh()
		expect(second).toBe(first)
		expect((await first).status).toBe(200)
		expect(
			tabA.requests.filter(entry => entry.url.endsWith("/session/refresh")),
		).toHaveLength(1)
	})

	it("resolves a lost pairing response through session status and keeps the code single-use", async () => {
		const env = await setup()
		const client = env.browser()
		const code = await issuedCode(env)
		const lost = await client.fetch(`${env.apiOrigin}/api/access/pair`, {
			method: "POST",
			json: { code },
			dropBody: true,
		})
		expect(lost.status).toBe(201)
		expect(lost.networkBody).toBe("")
		expect(client.csrf).toBeUndefined()
		expect(client.documentCookie()).toBe("")
		const status = await client.fetch(`${env.apiOrigin}/api/access/session`)
		expect(status.status).toBe(200)
		const body = sessionSchema.parse(status.json())
		expect(client.csrf).toBe(body.csrfToken)
		const reused = await client.fetch(`${env.apiOrigin}/api/access/pair`, {
			method: "POST",
			json: { code },
		})
		expect(reused.status).toBe(401)
		expect(reused.json()).toEqual({ code: "PAIRING_INVALID" })

		const omitted = env.browser()
		const second = await issuedCode(env)
		const ignored = await omitted.fetch(`${env.apiOrigin}/api/access/pair`, {
			method: "POST",
			json: { code: second },
			credentials: false,
		})
		expect(ignored.status).toBe(201)
		expect(
			omitted.jar.cookieHeader(
				`${env.apiOrigin}/api/access/session`,
				env.apiOrigin,
			),
		).toBeUndefined()
		expect(
			(await omitted.fetch(`${env.apiOrigin}/api/access/session`)).status,
		).toBe(401)
		const retry = await omitted.fetch(`${env.apiOrigin}/api/access/pair`, {
			method: "POST",
			json: { code: second },
		})
		expect(retry.status).toBe(401)
		expect(retry.json()).toEqual({ code: "PAIRING_INVALID" })
	})

	it("streams credentialed cross-port audio and rejects foreign Origin and Host on REST, WebSocket and audio", async () => {
		const env = await setup()
		const client = env.browser()
		const { bootstrap, body } = await signIn(env, client)
		const secrets = [env.token, env.privateDirectory, cookieValue(client), body.csrfToken]
		const socket = await client.openSocket(bootstrap.webSocketUrl)
		expect(socket.opened).toBe(true)
		const analog = await client.openStream(`${env.analogOrigin}/stream.wav`)
		const digital = await client.openStream(`${env.digitalOrigin}/stream.wav`)
		expect(analog.status).toBe(200)
		expect(digital.status).toBe(200)
		expect(analog.corsBlocked).toBe(false)
		expect(digital.corsBlocked).toBe(false)
		expect(analog.headers["access-control-allow-origin"]).toBe(env.apiOrigin)
		expect(analog.headers["access-control-allow-credentials"]).toBe("true")
		expect(digital.headers["access-control-allow-origin"]).toBe(env.apiOrigin)
		expect(analog.body.startsWith("RIFF")).toBe(true)
		expect(digital.body.startsWith("RIFF")).toBe(true)
		expect(client.requests.map(entry => entry.method).filter(method => method === "OPTIONS")).toEqual([])

		const deniedOrigin = await client.fetch(
			`${env.apiOrigin}/api/access/session`,
			{ origin: "http://evil.example" },
		)
		expect(deniedOrigin.status).toBe(403)
		expect(deniedOrigin.json()).toEqual({ code: "ORIGIN_FORBIDDEN" })
		assertNoPrivate(deniedOrigin, secrets)
		const deniedHost = await client.fetch(`${env.apiOrigin}/api/access/session`, {
			hostHeader: "evil.example:9000",
		})
		expect(deniedHost.status).toBe(403)
		expect(deniedHost.json()).toEqual({ code: "HOST_FORBIDDEN" })
		assertNoPrivate(deniedHost, secrets)
		const deniedSocket = await client.openSocket(bootstrap.webSocketUrl, {
			origin: "http://evil.example",
		})
		expect(deniedSocket.opened).toBe(false)
		expect(deniedSocket.status).toBe(403)
		const deniedSocketHost = await client.openSocket(bootstrap.webSocketUrl, {
			hostHeader: "evil.example:9000",
		})
		expect(deniedSocketHost.opened).toBe(false)
		expect(deniedSocketHost.status).toBe(403)
		const deniedAudio = await client.openStream(`${env.analogOrigin}/stream.wav`, {
			origin: "http://evil.example",
		})
		expect(deniedAudio.status).toBe(403)
		expect(deniedAudio.body).toContain("ORIGIN_FORBIDDEN")
		const deniedAudioHost = await client.openStream(
			`${env.digitalOrigin}/stream.wav`,
			{ hostHeader: "evil.example:9002" },
		)
		expect(deniedAudioHost.status).toBe(403)
		expect(deniedAudioHost.body).toContain("HOST_FORBIDDEN")
		for (const response of [deniedAudio, deniedAudioHost])
			assertNoPrivate(
				{ networkBody: response.body, headers: response.headers },
				secrets,
			)
		socket.close()
		analog.close()
		digital.close()
	})

	it("closes open WebSocket and audio streams on logout, revoke and revoke-all", async () => {
		const env = await setup()
		const client = env.browser()
		const { bootstrap, body } = await signIn(env, client)
		const openTransports = async () => {
			const socket = await client.openSocket(bootstrap.webSocketUrl)
			const analog = await client.openStream(`${env.analogOrigin}/stream.wav`)
			const digital = await client.openStream(`${env.digitalOrigin}/stream.wav`)
			expect(socket.opened).toBe(true)
			expect(analog.status).toBe(200)
			expect(digital.status).toBe(200)
			return { socket, analog, digital }
		}
		const first = await openTransports()
		const logout = await client.fetch(`${env.apiOrigin}/api/access/session/logout`, {
			method: "POST",
		})
		expect(logout.status).toBe(200)
		expect(logout.json()).toEqual({ revoked: true })
		await expectSocketClosed(first.socket, 1008)
		await expectStreamClosed(first.analog)
		await expectStreamClosed(first.digital)
		expect(
			(await client.fetch(`${env.apiOrigin}/api/access/session`)).status,
		).toBe(401)
		expect(client.csrf).toBeUndefined()

		const revoked = await signIn(env, client)
		const second = await openTransports()
		const revoke = await client.fetch(`${env.apiOrigin}/api/access/devices/revoke`, {
			method: "POST",
			json: { deviceId: revoked.body.deviceId },
		})
		expect(revoke.status).toBe(200)
		expect(revoke.json()).toEqual({ revoked: true })
		await expectSocketClosed(second.socket, 1008)
		await expectStreamClosed(second.analog)
		await expectStreamClosed(second.digital)

		await signIn(env, client)
		const third = await openTransports()
		const revokeAll = await client.fetch(
			`${env.apiOrigin}/api/access/devices/revoke-all`,
			{ method: "POST" },
		)
		expect(revokeAll.status).toBe(200)
		await expectSocketClosed(third.socket, 1008)
		await expectStreamClosed(third.analog)
		await expectStreamClosed(third.digital)
		expect(body.deviceId).not.toBe(revoked.body.deviceId)
	})

	it("fail-closes open leases when persistence stops accepting writes", async () => {
		const env = await setup()
		const client = env.browser()
		const { bootstrap } = await signIn(env, client)
		const socket = await client.openSocket(bootstrap.webSocketUrl)
		const analog = await client.openStream(`${env.analogOrigin}/stream.wav`)
		expect(socket.opened).toBe(true)
		expect(analog.status).toBe(200)
		await chmod(env.privateDirectory, 0o555)
		try {
			const failed = await client.fetch(
				`${env.apiOrigin}/api/access/session/refresh`,
				{ method: "POST" },
			)
			expect(failed.status).toBe(503)
			expect(failed.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
			assertNoPrivate(failed, [env.token, env.privateDirectory, cookieValue(client)])
			await expectSocketClosed(socket, 1008)
			await expectStreamClosed(analog)
			const later = await client.fetch(`${env.apiOrigin}/api/access/session`)
			expect(later.status).toBe(503)
			expect(later.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
		} finally {
			await chmod(env.privateDirectory, 0o700)
		}
	})

	it("keeps a paired session across a restart of the private snapshot", async () => {
		const env = await setup()
		const client = env.browser()
		const { body } = await signIn(env, client)
		const secret = cookieValue(client)
		await env.releaseListeners()
		const restarted = await setup({
			directory: env.directory,
			token: env.token,
		})
		const returning = restarted.browser(client.jar)
		expect(returning.csrf).toBeUndefined()
		const status = await returning.fetch(
			`${restarted.apiOrigin}/api/access/session`,
		)
		expect(status.status).toBe(200)
		expect(sessionSchema.parse(status.json())).toEqual(body)
		const snapshot = await readFile(
			join(env.privateDirectory, "access-state.json"),
			"utf8",
		)
		expect(snapshot).not.toContain(secret)
	})

	it("never echoes a credential or private path from a public denial", async () => {
		// Feature: browser-access-batch1, Property 2: public denials do not echo credentials or private paths
		// Validates: browser-access-batch1 acceptance public responses
		const env = await setup()
		const client = env.browser()
		const { body } = await signIn(env, client)
		const secrets = [
			env.token,
			env.privateDirectory,
			cookieValue(client),
			body.csrfToken,
		]
		await fc.assert(
			fc.asyncProperty(
				fc.stringMatching(/^[a-z]{3,12}$/),
				fc.constantFrom(
					"/api/access/session",
					"/api/access/bootstrap",
					"/api/status",
					"/ws",
				),
				async (label, path) => {
					const response = await client.fetch(
						`${env.apiOrigin}${path}?note=${encodeURIComponent(env.privateDirectory)}`,
						{
							origin: `http://${label}.example`,
							hostHeader: label.endsWith("a")
								? `evil-${label}.example:9000`
								: API_HOST,
						},
					)
					expect(response.sent).toBe(true)
					expect(response.status).toBeGreaterThanOrEqual(400)
					assertNoPrivate(response, secrets)
					expect(response.networkBody).not.toContain("csrfToken")
				},
			),
			{ numRuns: 100 },
		)
	}, 20_000)
})

function headerList(headers: IncomingHttpHeaders): string[] {
	const value = headers["set-cookie"]
	if (value === undefined) return []
	return typeof value === "string" ? [value] : value
}
