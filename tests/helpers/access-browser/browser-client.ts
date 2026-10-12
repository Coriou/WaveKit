import { request as httpRequest } from "node:http"
import type { IncomingHttpHeaders, IncomingMessage } from "node:http"
import { WebSocket } from "ws"
import type { CookieJar } from "./cookie-jar.js"

/** TCP destination for one browser host, as if a hosts file pointed it at loopback. */
export interface LoopbackBinding {
	readonly host: string
	readonly port: number
}

export interface BrowserClientOptions {
	readonly jar: CookieJar
	/** Page origin. Same-site and the default Origin header. */
	readonly documentOrigin: string
	/** Canonical API origin the shell is configured to call. */
	readonly apiOrigin: string
	readonly bindings: readonly LoopbackBinding[]
}

export interface BrowserFetchInit {
	readonly method?: string
	readonly json?: unknown
	/** Send the in-memory CSRF token. Defaults to true for unsafe methods when one is stored. */
	readonly csrf?: boolean
	/** Replace the page Origin for this call. Also selects which cookies SameSite will attach. */
	readonly origin?: string
	/** Replace the Host header. The TCP binding still follows the URL. */
	readonly hostHeader?: string
	/** Extra page headers. Same-origin calls do not preflight; cross-origin calls do. */
	readonly headers?: Readonly<Record<string, string>>
	/** When false, ignore Set-Cookie. A browser using credentials: "omit". */
	readonly credentials?: boolean
	/** Read headers, store cookies, and discard the body. */
	readonly dropBody?: boolean
}

export interface BrowserExchange {
	readonly url: string
	readonly method: string
	readonly status: number
	readonly headers: IncomingHttpHeaders
	/** Bytes the page is allowed to read. Empty when CORS hides the response. */
	readonly body: string
	/** Wire body, including responses the page is not allowed to read. */
	readonly networkBody: string
	/** The page could not read this cross-origin response. */
	readonly corsBlocked: boolean
	/** The actual request was sent. False when a required preflight failed. */
	readonly sent: boolean
	readonly preflight:
		| { readonly status: number; readonly headers: IncomingHttpHeaders }
		| undefined
	readonly cookieHeader: string | undefined
	json(): unknown
}

export interface BrowserSocket {
	readonly opened: boolean
	readonly status: number
	readonly closeCode: Promise<number>
	send(data: string): void
	close(): void
}

export interface BrowserByteStream {
	readonly status: number
	readonly headers: IncomingHttpHeaders
	readonly corsBlocked: boolean
	readonly body: string
	readonly closed: Promise<void>
	close(): void
}

interface WireResult {
	readonly status: number
	readonly headers: IncomingHttpHeaders
	readonly body: string
}

const SIMPLE_CONTENT = new Set([
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"text/plain",
])

function headerList(headers: IncomingHttpHeaders, name: string): string[] {
	const value = headers[name.toLowerCase()]
	if (value === undefined) return []
	return typeof value === "string" ? [value] : value
}

function headerOne(
	headers: IncomingHttpHeaders,
	name: string,
): string | undefined {
	return headerList(headers, name)[0]
}

function bindingFor(
	target: URL,
	bindings: readonly LoopbackBinding[],
): LoopbackBinding {
	const found = bindings.find(item => item.host === target.host)
	if (!found) throw new Error(`No loopback binding for ${target.host}`)
	return found
}

function needsPreflight(
	method: string,
	headers: Readonly<Record<string, string>>,
): boolean {
	const normalized = method.toUpperCase()
	if (normalized !== "GET" && normalized !== "HEAD" && normalized !== "POST")
		return true
	for (const [name, value] of Object.entries(headers)) {
		const key = name.toLowerCase()
		if (key === "content-type") {
			const type = value.split(";")[0]?.trim().toLowerCase() ?? ""
			if (!SIMPLE_CONTENT.has(type)) return true
		} else if (
			key !== "accept" &&
			key !== "accept-language" &&
			key !== "content-language"
		)
			return true
	}
	return false
}

function allowsFollowUp(
	preflight: WireResult,
	requestOrigin: string,
	method: string,
	requested: readonly string[],
): boolean {
	if (preflight.status < 200 || preflight.status >= 300) return false
	if (
		headerOne(preflight.headers, "access-control-allow-origin") !==
		requestOrigin
	)
		return false
	if (
		headerOne(preflight.headers, "access-control-allow-credentials") !== "true"
	)
		return false
	const methods = (
		headerOne(preflight.headers, "access-control-allow-methods") ?? ""
	)
		.split(",")
		.map(value => value.trim().toUpperCase())
	if (!methods.includes(method.toUpperCase())) return false
	if (requested.length === 0) return true
	const allowed = (
		headerOne(preflight.headers, "access-control-allow-headers") ?? ""
	)
		.split(",")
		.map(value => value.trim().toLowerCase())
	return requested.every(name => allowed.includes(name))
}

function corsReadable(
	sameOrigin: boolean,
	headers: IncomingHttpHeaders,
	requestOrigin: string,
): boolean {
	if (sameOrigin) return true
	return (
		headerOne(headers, "access-control-allow-origin") === requestOrigin &&
		headerOne(headers, "access-control-allow-credentials") === "true"
	)
}

function wire(
	port: number,
	method: string,
	path: string,
	headers: Record<string, string>,
	body: string | undefined,
	dropBody: boolean,
): Promise<WireResult> {
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (result: WireResult) => {
			if (settled) return
			settled = true
			resolve(result)
		}
		const fail = (error: Error) => {
			if (settled) return
			settled = true
			reject(error)
		}
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				headers,
			},
			response => {
				if (dropBody) {
					response.resume()
					response.destroy()
					finish({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: "",
					})
					return
				}
				const chunks: Buffer[] = []
				response.on("data", (chunk: Buffer) => chunks.push(chunk))
				response.on("error", fail)
				response.on("end", () =>
					finish({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				)
			},
		)
		req.setTimeout(2000, () =>
			fail(new Error(`Loopback ${method} ${path} timed out`)),
		)
		req.on("error", fail)
		req.end(body)
	})
}

/** One browser tab: cookie jar may be shared; CSRF stays in this tab's memory. */
export class BrowserClient {
	readonly jar: CookieJar
	readonly documentOrigin: string
	readonly apiOrigin: string
	readonly requests: { method: string; url: string }[] = []
	csrf: string | undefined
	readonly #bindings: readonly LoopbackBinding[]
	#refreshing: Promise<BrowserExchange> | undefined

	constructor(options: BrowserClientOptions) {
		this.jar = options.jar
		this.documentOrigin = options.documentOrigin
		this.apiOrigin = options.apiOrigin
		this.#bindings = options.bindings
	}

	documentCookie(): string {
		return this.jar.documentCookie(this.documentOrigin)
	}

	/** One in-flight refresh shared by simultaneous triggers in this tab. */
	refresh(): Promise<BrowserExchange> {
		this.#refreshing ??= this.fetch(
			new URL("/api/access/session/refresh", this.apiOrigin).href,
			{ method: "POST" },
		).finally(() => {
			this.#refreshing = undefined
		})
		return this.#refreshing
	}

	fetch(url: string, init: BrowserFetchInit = {}): Promise<BrowserExchange> {
		const method = (
			init.method ?? (init.json === undefined ? "GET" : "POST")
		).toUpperCase()
		const target = new URL(url)
		const page = new URL(init.origin ?? this.documentOrigin)
		const sameOrigin = page.origin === target.origin
		const includeCookies = init.credentials !== false
		const cookieHeader = includeCookies
			? this.jar.cookieHeader(target.href, page.href)
			: undefined
		const pageHeaders: Record<string, string> = { ...init.headers }
		let encoded: string | undefined
		if (init.json !== undefined) {
			encoded = JSON.stringify(init.json)
			pageHeaders["Content-Type"] = "application/json"
		}
		const unsafe = method !== "GET" && method !== "HEAD"
		if (unsafe && init.csrf !== false && this.csrf !== undefined)
			pageHeaders["X-WaveKit-CSRF"] = this.csrf
		const send = async (): Promise<BrowserExchange> => {
			let preflight: BrowserExchange["preflight"]
			if (!sameOrigin && needsPreflight(method, pageHeaders)) {
				const requested = Object.keys(pageHeaders).map(name =>
					name.toLowerCase(),
				)
				const probeHeaders: Record<string, string> = {
					"Access-Control-Request-Method": method,
				}
				if (requested.length > 0)
					probeHeaders["Access-Control-Request-Headers"] = requested.join(", ")
				const probed = await this.#send(
					target,
					"OPTIONS",
					page,
					undefined,
					probeHeaders,
					undefined,
					false,
				)
				preflight = { status: probed.status, headers: probed.headers }
				if (!allowsFollowUp(probed, page.origin, method, requested))
					return this.#exchange(
						target,
						method,
						0,
						{},
						"",
						true,
						false,
						preflight,
						undefined,
					)
			}
			const response = await this.#send(
				target,
				method,
				page,
				init.hostHeader,
				pageHeaders,
				encoded,
				init.dropBody === true,
				cookieHeader,
			)
			if (includeCookies)
				this.jar.apply(target.href, headerList(response.headers, "set-cookie"))
			const blocked = !corsReadable(sameOrigin, response.headers, page.origin)
			const exchange = this.#exchange(
				target,
				method,
				response.status,
				response.headers,
				response.body,
				blocked,
				true,
				preflight,
				cookieHeader,
			)
			if (!blocked) this.#remember(exchange)
			return exchange
		}
		return send()
	}

	async openSocket(
		url: string,
		init: { readonly origin?: string; readonly hostHeader?: string } = {},
	): Promise<BrowserSocket> {
		const target = new URL(url)
		const page = new URL(init.origin ?? this.documentOrigin)
		const binding = bindingFor(target, this.#bindings)
		const cookieHeader = this.jar.cookieHeader(target.href, page.href)
		const headers: Record<string, string> = {
			Host: init.hostHeader ?? target.host,
			Origin: page.origin,
		}
		if (cookieHeader !== undefined) headers["Cookie"] = cookieHeader
		this.requests.push({ method: "GET", url: target.href })
		const socket = new WebSocket(
			`ws://127.0.0.1:${binding.port}${target.pathname}`,
			{ headers },
		)
		let handshake = 0
		const closeCode = new Promise<number>(resolve => {
			socket.once("close", (code: number) =>
				resolve(handshake === 101 ? code : 1006),
			)
		})
		const opened = await new Promise<number>(resolve => {
			let settled = false
			const succeed = (status: number) => {
				if (settled) return
				settled = true
				resolve(status)
			}
			socket.once("open", () => succeed(101))
			socket.once(
				"unexpected-response",
				(_request, response: IncomingMessage) => {
					response.resume()
					succeed(response.statusCode ?? 0)
				},
			)
			socket.once("error", () => setImmediate(() => succeed(0)))
		})
		handshake = opened
		socket.on("error", () => undefined)
		if (opened !== 101) socket.terminate()
		return {
			opened: opened === 101,
			status: opened,
			closeCode,
			send: data => {
				socket.send(data)
			},
			close: () => socket.close(),
		}
	}

	openStream(
		url: string,
		init: BrowserFetchInit = {},
	): Promise<BrowserByteStream> {
		const target = new URL(url)
		const page = new URL(init.origin ?? this.documentOrigin)
		const binding = bindingFor(target, this.#bindings)
		const cookieHeader = this.jar.cookieHeader(target.href, page.href)
		const headers: Record<string, string> = {
			Host: init.hostHeader ?? target.host,
			Origin: page.origin,
			Connection: "keep-alive",
		}
		if (cookieHeader !== undefined) headers["Cookie"] = cookieHeader
		this.requests.push({ method: "GET", url: target.href })
		return new Promise((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: binding.port,
					path: `${target.pathname}${target.search}`,
					method: "GET",
					headers,
				},
				response => {
					req.setTimeout(0)
					const chunks: Buffer[] = []
					let settled = false
					const closed = new Promise<void>(done => {
						response.once("close", () => done())
					})
					const finish = (body: string) => {
						if (settled) return
						settled = true
						resolve({
							status: response.statusCode ?? 0,
							headers: response.headers,
							corsBlocked: !corsReadable(
								page.origin === target.origin,
								response.headers,
								page.origin,
							),
							body,
							closed,
							close: () => req.destroy(),
						})
					}
					response.on("data", (chunk: Buffer) => {
						chunks.push(chunk)
						if ((response.statusCode ?? 0) === 200)
							finish(Buffer.concat(chunks).toString("utf8"))
					})
					response.on("error", reject)
					response.on("end", () =>
						finish(Buffer.concat(chunks).toString("utf8")),
					)
				},
			)
			req.setTimeout(2000, () =>
				req.destroy(new Error(`Audio stream ${target.href} timed out`)),
			)
			req.on("error", reject)
			req.end()
		})
	}

	async #send(
		target: URL,
		method: string,
		page: URL,
		hostHeader: string | undefined,
		pageHeaders: Readonly<Record<string, string>>,
		body: string | undefined,
		dropBody: boolean,
		cookieHeader?: string,
	): Promise<WireResult> {
		const binding = bindingFor(target, this.#bindings)
		const headers: Record<string, string> = {
			Host: hostHeader ?? target.host,
			Origin: page.origin,
			Connection: "close",
			...pageHeaders,
		}
		if (cookieHeader !== undefined) headers["Cookie"] = cookieHeader
		if (body !== undefined)
			headers["Content-Length"] = String(Buffer.byteLength(body))
		this.requests.push({ method, url: target.href })
		return wire(
			binding.port,
			method,
			`${target.pathname}${target.search}`,
			headers,
			body,
			dropBody,
		)
	}

	#exchange(
		target: URL,
		method: string,
		status: number,
		headers: IncomingHttpHeaders,
		body: string,
		corsBlocked: boolean,
		sent: boolean,
		preflight: BrowserExchange["preflight"],
		cookieHeader: string | undefined,
	): BrowserExchange {
		return {
			url: target.href,
			method,
			status,
			headers,
			body: corsBlocked ? "" : body,
			networkBody: body,
			corsBlocked,
			sent,
			preflight,
			cookieHeader,
			json: () => JSON.parse(body) as unknown,
		}
	}

	#remember(exchange: BrowserExchange): void {
		if (exchange.body.length === 0) return
		try {
			const parsed = JSON.parse(exchange.body) as { csrfToken?: unknown }
			if (typeof parsed.csrfToken === "string") this.csrf = parsed.csrfToken
		} catch {
			/* Not a session document. */
		}
		if (this.jar.cookieHeader(exchange.url, this.documentOrigin) === undefined)
			this.csrf = undefined
	}
}

/** Machine bearer call. No cookie jar and no browser Origin. */
export function machinePost(
	binding: LoopbackBinding,
	token: string,
	path: string,
): Promise<BrowserExchange> {
	const url = `http://${binding.host}${path}`
	return new Promise((resolve, reject) => {
		const body = "{}"
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port: binding.port,
				path,
				method: "POST",
				headers: {
					Host: binding.host,
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(body)),
					Connection: "close",
				},
			},
			response => {
				const chunks: Buffer[] = []
				response.on("data", (chunk: Buffer) => chunks.push(chunk))
				response.on("error", reject)
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8")
					resolve({
						url,
						method: "POST",
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: text,
						networkBody: text,
						corsBlocked: false,
						sent: true,
						preflight: undefined,
						cookieHeader: undefined,
						json: () => JSON.parse(text) as unknown,
					})
				})
			},
		)
		req.setTimeout(2000, () =>
			req.destroy(new Error("Machine request timed out")),
		)
		req.on("error", reject)
		req.end(body)
	})
}
