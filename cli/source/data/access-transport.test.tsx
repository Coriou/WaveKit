import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { once } from "node:events"
import { WebSocketServer } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createFileCredentialProvider,
	MachineCredential,
} from "./access-credentials.js"
import { discover } from "./config.js"
import {
	createCliFetch,
	createCliProbeFetch,
	createCliWsFactory,
} from "./access-transport.js"
import { createWsClient, HANDSHAKE_TIMEOUT_MS } from "./ws-client.js"
import type { Inbound } from "./types.js"
import type { WsHandle, WsHandlers } from "./ws-client.js"

const token = randomBytes(32).toString("base64url")
const servers: Server[] = []
const sockets: WsHandle[] = []
const wsServers: WebSocketServer[] = []
async function listen(server: Server): Promise<string> {
	servers.push(server)
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
afterEach(async () => {
	vi.useRealTimers()
	for (const socket of sockets.splice(0)) socket.close()
	for (const server of wsServers.splice(0)) {
		for (const client of server.clients) client.terminate()
		await new Promise<void>(resolve => server.close(() => resolve()))
	}
	for (const server of servers.splice(0)) {
		server.closeAllConnections()
		await new Promise<void>(resolve => server.close(() => resolve()))
	}
	vi.restoreAllMocks()
})
function credentials() {
	return vi.fn(async () => new MachineCredential(token))
}
function events(): WsHandlers & {
	closed: Promise<void>
	opened: Promise<void>
} {
	let opened!: () => void
	let closed!: () => void
	return {
		opened: new Promise<void>(resolve => {
			opened = resolve
		}),
		closed: new Promise<void>(resolve => {
			closed = resolve
		}),
		open: vi.fn(() => opened()),
		message: vi.fn(),
		error: vi.fn(),
		close: vi.fn(() => closed()),
	}
}

describe("CLI destination-bound transports", () => {
	it("sends a credential only to the explicit REST authority", async () => {
		const seen: string[] = []
		const origin = await listen(
			createServer((req, res) => {
				seen.push(req.headers.authorization ?? "")
				res.setHeader("Content-Type", "application/json")
				res.end('{"ok":true}')
			}),
		)
		const provider = credentials()
		const request = createCliFetch({
			policy: { origin, credentials: provider },
		})
		expect(
			await (await request(`${origin}/api/sources?offset=1`)).json(),
		).toEqual({ ok: true })
		expect(seen).toEqual([`Bearer ${token}`])
		expect(provider).toHaveBeenCalledTimes(1)
	})
	it("wrong REST port is rejected before provider or network", async () => {
		const reached = vi.fn((_req: IncomingMessage, res: ServerResponse) =>
			res.end("{}"),
		)
		const wrong = await listen(createServer(reached))
		const provider = credentials()
		await expect(
			createCliFetch({
				policy: { origin: "http://127.0.0.1:1", credentials: provider },
			})(wrong),
		).rejects.toMatchObject({ code: "ACCESS_DESTINATION_FORBIDDEN" })
		expect(provider).not.toHaveBeenCalled()
		expect(reached).not.toHaveBeenCalled()
	})
	it.each(["http://0.0.0.0:9000", "http://[::]:9000"])(
		"rejects unspecified trusted destination %s before credentials",
		origin => {
			const provider = credentials()
			expect(() =>
				createCliFetch({ policy: { origin, credentials: provider } }),
			).toThrow("CLI access unavailable")
			expect(() =>
				createCliWsFactory({ policy: { origin, credentials: provider } }),
			).toThrow("CLI access unavailable")
			expect(provider).not.toHaveBeenCalled()
		},
	)
	it("races REST credential lookup against the original signal without forwarding its reason", async () => {
		const reached = vi.fn((_req: IncomingMessage, res: ServerResponse) =>
			res.end("{}"),
		)
		const origin = await listen(createServer(reached))
		let resolve!: (value: MachineCredential) => void
		const provider = vi.fn(
			() =>
				new Promise<MachineCredential>(done => {
					resolve = done
				}),
		)
		const controller = new AbortController()
		const request = createCliFetch({
			policy: { origin, credentials: provider },
		})(origin, { signal: controller.signal })
		controller.abort(new Error(token))
		await expect(request).rejects.toMatchObject({
			name: "AbortError",
			message: "CLI access unavailable",
		})
		resolve(new MachineCredential(token))
		await new Promise<void>(done => setImmediate(done))
		expect(reached).not.toHaveBeenCalled()
		expect(provider).toHaveBeenCalledTimes(1)
	})
	it("does not consult credentials for a pre-aborted REST request", async () => {
		const provider = credentials()
		const controller = new AbortController()
		controller.abort(token)
		await expect(
			createCliFetch({
				policy: { origin: "http://localhost", credentials: provider },
			})("http://localhost/api", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" })
		expect(provider).not.toHaveBeenCalled()
	})
	it.each([
		"Authorization",
		"aUtHoRiZaTiOn",
		"Cookie",
		"HOST",
		"Forwarded",
		"X-Forwarded-Host",
	])(
		"rejects caller %s before reading credentials, including probes",
		async name => {
			const provider = credentials()
			const request = createCliFetch({
				policy: { origin: "http://localhost:9000", credentials: provider },
			})
			await expect(
				request("http://localhost:9000/api", { headers: { [name]: token } }),
			).rejects.toMatchObject({ code: "ACCESS_HEADERS_FORBIDDEN" })
			await expect(
				createCliProbeFetch()("http://localhost:9000/health", {
					headers: { [name]: token },
				}),
			).rejects.toMatchObject({ code: "ACCESS_HEADERS_FORBIDDEN" })
			expect(provider).not.toHaveBeenCalled()
		},
	)
	it("never follows HTTP redirects carrying a credential", async () => {
		const destination = vi.fn((_req: IncomingMessage, res: ServerResponse) =>
			res.end("{}"),
		)
		const other = await listen(createServer(destination))
		const origin = await listen(
			createServer((_req, res) => {
				res.writeHead(302, { Location: `${other}/secret` })
				res.end(token)
			}),
		)
		await expect(
			createCliFetch({ policy: { origin, credentials: credentials() } })(
				origin,
			),
		).rejects.toMatchObject({ code: "ACCESS_TRANSPORT_FAILED" })
		expect(destination).not.toHaveBeenCalled()
	})
	it("probe and optional legacy mode stay uncredentialed", async () => {
		const seen: unknown[] = []
		const origin = await listen(
			createServer((req, res) => {
				seen.push(req.headers.authorization, req.headers.cookie)
				res.end('{"status":"ok"}')
			}),
		)
		await createCliProbeFetch()(`${origin}/health`)
		await createCliFetch()(origin)
		expect(seen).toEqual([undefined, undefined, undefined, undefined])
	})
	it("preserves legacy discover with an answered 503 health probe and no private details", async () => {
		const request = vi.fn(
			async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response(
					JSON.stringify({ status: "ok", details: token, message: token }),
					{ status: 503 },
				),
		)
		const probe = createCliProbeFetch(request)
		expect(await discover(probe, ["http://127.0.0.1:9000"])).toEqual({
			target: {
				base: "http://127.0.0.1:9000",
				ws: "ws://127.0.0.1:9000/ws",
				explicit: false,
			},
			tried: ["127.0.0.1:9000"],
		})
		const response = await probe("http://127.0.0.1:9000/health")
		expect(response.status).toBe(503)
		expect(await response.json()).toEqual({ status: "ok" })
		expect(request.mock.calls[0]?.[1]).not.toHaveProperty(
			"headers.Authorization",
		)
	})
	it("discovers a core whose 503 health probe says unhealthy, projecting only the status", async () => {
		const request = vi.fn(
			async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						status: "unhealthy",
						reason: "all_decoders_down",
						details: token,
					}),
					{ status: 503 },
				),
		)
		const probe = createCliProbeFetch(request)
		expect(
			(await discover(probe, ["http://127.0.0.1:9000"])).target?.base,
		).toBe("http://127.0.0.1:9000")
		const response = await probe("http://127.0.0.1:9000/health")
		expect(response.status).toBe(503)
		expect(await response.json()).toEqual({ status: "unhealthy" })
	})
	it("does not expose failed health details through the protected transport or other probe paths", async () => {
		const request = async () =>
			new Response(JSON.stringify({ status: "ok", details: token }), {
				status: 503,
			})
		expect(
			await (
				await createCliFetch({ fetch: request })("http://localhost/health")
			).json(),
		).toEqual({ message: "HTTP 503" })
		for (const path of ["/api/status", "/health?secret=1"]) {
			expect(
				await (
					await createCliProbeFetch(request)(`http://localhost${path}`)
				).json(),
			).toEqual({ message: "HTTP 503" })
		}
	})
	it("sanitizes provider, underlying fetch and response JSON failures", async () => {
		const provider = vi.fn(() =>
			Promise.reject(new Error(`${token} /private/token`)),
		)
		await expect(
			createCliFetch({
				policy: { origin: "http://localhost", credentials: provider },
			})("http://localhost"),
		).rejects.toMatchObject({
			message: "CLI access unavailable",
			code: "ACCESS_CREDENTIAL_UNAVAILABLE",
		})
		const fail = vi.fn(() =>
			Promise.reject(new Error(`${token} /private/token`)),
		)
		await expect(
			createCliFetch({ fetch: fail })("http://localhost"),
		).rejects.toMatchObject({
			message: "CLI access unavailable",
			code: "ACCESS_TRANSPORT_FAILED",
		})
		const origin = await listen(
			createServer((_req, res) => {
				res.statusMessage = token
				res.end(token)
			}),
		)
		const response = await createCliProbeFetch()(origin)
		expect(response.statusText).toBe("")
		expect(await response.json()).toBeUndefined()
	})
	it("keeps failed HTTP response bodies and status text out of client errors", async () => {
		const origin = await listen(
			createServer((_req, res) => {
				res.statusCode = 401
				res.statusMessage = token
				res.end(JSON.stringify({ message: token, code: token }))
			}),
		)
		const response = await createCliFetch({
			policy: { origin, credentials: credentials() },
		})(origin)
		expect(response.statusText).toBe("")
		expect(await response.json()).toEqual({ message: "HTTP 401" })
	})
	it.each(["AUTH_REQUIRED", "ACCESS_UNAVAILABLE", "SESSION_CAPACITY"])(
		"preserves only explicitly known safe denial code %s",
		async code => {
			const origin = await listen(
				createServer((_req, res) => {
					res.statusCode = 403
					res.end(JSON.stringify({ code, message: token, details: { token } }))
				}),
			)
			const response = await createCliProbeFetch()(origin)
			expect(await response.json()).toEqual({ message: "HTTP 403", code })
		},
	)
	it("bounds failed response bodies before decoding allowlisted codes", async () => {
		const origin = await listen(
			createServer((_req, res) => {
				res.statusCode = 403
				res.end(
					JSON.stringify({ code: "AUTH_REQUIRED", message: token.repeat(200) }),
				)
			}),
		)
		expect(await (await createCliProbeFetch()(origin)).json()).toEqual({
			message: "HTTP 403",
		})
	})
	it.each(["TimeoutError", "AbortError", "reset"])(
		"preserves safe uncertain-write classification for %s without raw causes",
		async kind => {
			const underlying = new Error(token)
			if (kind === "reset")
				underlying.cause = { code: "ECONNRESET", secret: token }
			else underlying.name = kind
			const request = createCliFetch({
				fetch: () => Promise.reject(underlying),
			})
			try {
				await request("http://localhost/api", { method: "POST" })
				expect.fail("must reject")
			} catch (error) {
				expect(error).toMatchObject({
					name: kind === "reset" ? "AbortError" : kind,
					message: "CLI access unavailable",
				})
				expect(error).not.toHaveProperty("cause")
				expect(JSON.stringify(error)).not.toContain(token)
			}
		},
	)
	it.each([
		"http://user:secret@localhost",
		"http://localhost/",
		"http://localhost?x=1",
		"http://localhost#secret",
		"http://*",
		"ws://localhost",
		"http://127.1",
		"http://0x7f000001",
		"http://localhost.",
		"http://localhost:0",
	])("rejects invalid trusted origin %s", origin => {
		expect(() =>
			createCliFetch({ policy: { origin, credentials: credentials() } }),
		).toThrow("CLI access unavailable")
	})
	it.each([
		"http://user:secret@localhost/api",
		"http://127.1/api",
		"http://localhost/#secret",
		" http://localhost",
		"http://localhost\\@foreign/api",
		"http://localhost:65536",
		"https://localhost",
	])(
		"rejects mismatched/ambiguous REST destination before lookup",
		async destination => {
			const provider = credentials()
			await expect(
				createCliFetch({
					policy: { origin: "http://localhost", credentials: provider },
				})(destination),
			).rejects.toMatchObject({ code: "ACCESS_DESTINATION_FORBIDDEN" })
			expect(provider).not.toHaveBeenCalled()
		},
	)
	it("canonicalizes effective ports, DNS case and IPv6 without DNS aliases", async () => {
		const request = vi.fn(async () => new Response("{}"))
		for (const [origin, destination] of [
			["http://EXAMPLE.test:80", "http://example.test/api"],
			["https://[0:0:0:0:0:0:0:1]:443", "https://[::1]/api"],
		]) {
			await createCliFetch({
				policy: { origin: origin!, credentials: credentials() },
				fetch: request,
			})(destination!)
		}
		expect(request).toHaveBeenCalledTimes(2)
	})
	it("authenticates real WebSocket and sends after its deferred open", async () => {
		const origin = await listen(createServer())
		const server = new WebSocketServer({ server: servers[0]! })
		wsServers.push(server)
		const received = new Promise<string>(resolve =>
			server.once("connection", (socket, req) => {
				expect(req.headers.authorization).toBe(`Bearer ${token}`)
				socket.once("message", data => resolve(data.toString()))
			}),
		)
		const handlers = events()
		const socket = createCliWsFactory({
			policy: { origin, credentials: credentials() },
		})(origin.replace("http:", "ws:") + "/ws", handlers)
		sockets.push(socket)
		socket.send("dropped before open")
		await handlers.opened
		socket.send("subscribe")
		expect(await received).toBe("subscribe")
	})
	it("rejects WS wrong destination synchronously before provider", () => {
		const provider = credentials()
		expect(() =>
			createCliWsFactory({
				policy: { origin: "https://localhost:9000", credentials: provider },
			})("ws://localhost:9000/ws", events()),
		).toThrow("CLI access unavailable")
		expect(provider).not.toHaveBeenCalled()
	})
	it("cancellation while provider is pending prevents a later connection", async () => {
		const reached = vi.fn()
		const origin = await listen(createServer(reached))
		let resolve!: (value: MachineCredential) => void
		const provider = () =>
			new Promise<MachineCredential>(done => {
				resolve = done
			})
		const handlers = events()
		const socket = createCliWsFactory({
			policy: { origin, credentials: provider },
		})(origin.replace("http:", "ws:"), handlers)
		socket.close()
		resolve(new MachineCredential(token))
		await new Promise<void>(done => setImmediate(done))
		expect(reached).not.toHaveBeenCalled()
		expect(handlers.open).not.toHaveBeenCalled()
		expect(handlers.error).not.toHaveBeenCalled()
	})
	it("bounds WS credential waiting and cannot connect after late fulfillment", async () => {
		const reached = vi.fn((_req: IncomingMessage, res: ServerResponse) =>
			res.end("{}"),
		)
		const origin = await listen(createServer(reached))
		vi.useFakeTimers()
		let resolve!: (value: MachineCredential) => void
		const provider = () =>
			new Promise<MachineCredential>(done => {
				resolve = done
			})
		const handlers = events()
		sockets.push(
			createCliWsFactory({ policy: { origin, credentials: provider } })(
				origin.replace("http:", "ws:"),
				handlers,
			),
		)
		await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)
		await handlers.closed
		expect(handlers.error).toHaveBeenCalledWith("CLI access transport failed")
		expect(handlers.close).toHaveBeenCalledExactlyOnceWith(0, "")
		expect(vi.getTimerCount()).toBe(0)
		resolve(new MachineCredential(token))
		await Promise.resolve()
		vi.useRealTimers()
		await new Promise<void>(done => setImmediate(done))
		expect(reached).not.toHaveBeenCalled()
		expect(handlers.open).not.toHaveBeenCalled()
	})
	it("provider failure emits sanitized error and close so existing client retries", async () => {
		const handlers = events()
		const socket = createCliWsFactory({
			policy: {
				origin: "http://localhost",
				credentials: () => Promise.reject(new Error(token)),
			},
		})("ws://localhost/ws", handlers)
		sockets.push(socket)
		await handlers.closed
		expect(handlers.error).toHaveBeenCalledWith("CLI access transport failed")
		expect(handlers.close).toHaveBeenCalledExactlyOnceWith(0, "")
	})
	it("does not follow WS redirects or disclose handshake body", async () => {
		const reached = vi.fn((_req: IncomingMessage, res: ServerResponse) =>
			res.end(token),
		)
		const other = await listen(createServer(reached))
		const origin = await listen(
			createServer((_req, res) => {
				res.writeHead(302, { Location: other.replace("http:", "ws:") })
				res.end(token)
			}),
		)
		const handlers = events()
		sockets.push(
			createCliWsFactory({ policy: { origin, credentials: credentials() } })(
				origin.replace("http:", "ws:"),
				handlers,
			),
		)
		await handlers.closed
		expect(reached).not.toHaveBeenCalled()
		expect(handlers.error).toHaveBeenCalledWith("CLI access transport failed")
		expect(handlers.close).toHaveBeenCalledWith(1006, "")
	})
	it("suppresses server supplied close reasons", async () => {
		const origin = await listen(createServer())
		const server = new WebSocketServer({ server: servers[0]! })
		wsServers.push(server)
		server.on("connection", socket => socket.close(1008, token))
		const handlers = events()
		sockets.push(createCliWsFactory()(origin.replace("http:", "ws:"), handlers))
		await handlers.closed
		expect(handlers.close).toHaveBeenCalledWith(1008, "")
	})
})

// Validates: core-access-policy requirements 6.3, 6.4.
describe("native WebSocket access pause", () => {
	it.each([401, 403])(
		"reports a safe access signal for HTTP %s before any open event",
		async status => {
			const origin = await listen(
				createServer((_req, res) => {
					res.writeHead(status, { "Content-Type": "text/plain" })
					res.end(token)
				}),
			)
			const h = events()
			const accessBlocked = vi.fn()
			sockets.push(
				createCliWsFactory({ policy: { origin, credentials: credentials() } })(
					origin.replace("http:", "ws:") + "/ws",
					{ ...h, accessBlocked },
				),
			)
			await h.closed
			expect(accessBlocked).toHaveBeenCalledExactlyOnceWith(
				status === 401 ? "unauthorized" : "forbidden",
			)
			expect(h.open).not.toHaveBeenCalled()
			expect(h.error).not.toHaveBeenCalled()
			expect(h.close).toHaveBeenCalledExactlyOnceWith(0, "")
			expect(JSON.stringify(accessBlocked.mock.calls)).not.toContain(token)
		},
	)
	it("provider rejection pauses without opening a socket or disclosing its exception", async () => {
		const reached = vi.fn((_req: IncomingMessage, res: ServerResponse) =>
			res.end("{}"),
		)
		const origin = await listen(createServer(reached))
		const h = events()
		const accessBlocked = vi.fn()
		sockets.push(
			createCliWsFactory({
				policy: { origin, credentials: () => Promise.reject(new Error(token)) },
			})(origin.replace("http:", "ws:") + "/ws", { ...h, accessBlocked }),
		)
		await h.closed
		expect(accessBlocked).toHaveBeenCalledExactlyOnceWith(
			"credential-unavailable",
		)
		expect(reached).not.toHaveBeenCalled()
		expect(h.error).not.toHaveBeenCalled()
		expect(h.close).toHaveBeenCalledExactlyOnceWith(0, "")
	})
	it.each([429, 503])(
		"HTTP %s remains a transport retry rather than an access pause",
		async status => {
			const origin = await listen(
				createServer((_req, res) => {
					res.writeHead(status)
					res.end(token)
				}),
			)
			const emitted: Inbound[] = []
			const retry = vi.fn((fn: () => void, ms: number) => {
				const timer = setTimeout(fn, ms)
				timer.unref()
				return timer
			})
			const client = createWsClient({
				url: () => origin.replace("http:", "ws:") + "/ws",
				factory: createCliWsFactory({
					policy: { origin, credentials: credentials() },
				}),
				emit: item => emitted.push(item),
				now: () => Date.now(),
				random: () => 0.5,
				setTimeout: retry,
				clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
			})
			try {
				client.start()
				await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
				expect(emitted.at(-1)).toMatchObject({
					kind: "ws:close",
					reason: "CLI access transport failed",
				})
				expect(emitted.at(-1)).not.toMatchObject({ nextRetryAt: null })
				expect(JSON.stringify(emitted)).not.toContain(token)
			} finally {
				client.stop()
			}
		},
	)
	it("operator retry rereads a rotated private token after a real 401 pause", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wavekit-cli-wiring-"))
		await chmod(directory, 0o700)
		const path = join(directory, "credential")
		const rotated = randomBytes(32).toString("base64url")
		await writeFile(path, token, { mode: 0o600 })
		const wss = new WebSocketServer({ noServer: true })
		wsServers.push(wss)
		let requests = 0
		const server = createServer()
		server.on("upgrade", (req, socket, head) => {
			requests++
			if (req.headers.authorization !== `Bearer ${rotated}`) {
				socket.end(
					`HTTP/1.1 401 Unauthorized\r\nContent-Length: ${token.length}\r\nConnection: close\r\n\r\n${token}`,
				)
				return
			}
			wss.handleUpgrade(req, socket, head, peer => {
				peer.on("message", () =>
					peer.send('{"type":"subscribed","data":{"channels":[]}}'),
				)
			})
		})
		const origin = await listen(server)
		const emitted: Inbound[] = []
		const retry = vi.fn((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms)
			timer.unref()
			return timer
		})
		const client = createWsClient({
			url: () => origin.replace("http:", "ws:") + "/ws",
			factory: createCliWsFactory({
				policy: {
					origin,
					credentials: createFileCredentialProvider({ path, format: "token" }),
				},
			}),
			emit: item => emitted.push(item),
			now: () => Date.now(),
			random: () => 0.5,
			setTimeout: retry,
			clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
		})
		try {
			client.start()
			await vi.waitFor(() =>
				expect(emitted.at(-1)).toMatchObject({
					kind: "ws:close",
					nextRetryAt: null,
				}),
			)
			expect(requests).toBe(1)
			expect(retry).not.toHaveBeenCalled()
			await writeFile(path, rotated, { mode: 0o600 })
			client.reconnectNow()
			await vi.waitFor(() => expect(emitted.at(-1)?.kind).toBe("ws:open"))
			expect(requests).toBe(2)
			expect(retry).not.toHaveBeenCalled()
			expect(JSON.stringify(emitted)).not.toContain(token)
			expect(JSON.stringify(emitted)).not.toContain(rotated)
		} finally {
			client.stop()
			await rm(directory, { recursive: true, force: true })
		}
	})
})

describe("identify synchronous dispatch fence", () => {
	it.each([false, true])(
		"honors the fence and strips private options (protected=%s)",
		async protectedMode => {
			const native = vi.fn<typeof fetch>(async (_url, init) => {
				expect(init).not.toHaveProperty("beforeDispatch")
				expect(init?.redirect).toBe("error")
				expect(init?.credentials).toBe("omit")
				return new Response("{}")
			})
			const beforeDispatch = vi.fn(() => true)
			const request = createCliFetch({
				fetch: native,
				...(protectedMode
					? {
							policy: {
								origin: "http://127.0.0.1:9100",
								credentials: credentials(),
							},
						}
					: {}),
			})
			await request("http://127.0.0.1:9100/api/scanner/identify", {
				method: "POST",
				beforeDispatch,
			})
			expect(beforeDispatch).toHaveBeenCalledTimes(1)
			expect(native).toHaveBeenCalledTimes(1)
		},
	)
	it.each(["false", "throw", "abort"])(
		"refuses after deferred credential acquisition: %s",
		async mode => {
			let resolve!: (value: MachineCredential) => void
			const provider = () =>
				new Promise<MachineCredential>(r => {
					resolve = r
				})
			const native = vi.fn<typeof fetch>(async () => new Response("{}"))
			const controller = new AbortController()
			const request = createCliFetch({
				fetch: native,
				policy: { origin: "http://127.0.0.1:9100", credentials: provider },
			})
			const pending = request("http://127.0.0.1:9100/api/scanner/identify", {
				signal: controller.signal,
				beforeDispatch: () => {
					if (mode === "throw") throw new Error(token)
					if (mode === "abort") {
						controller.abort()
						return true
					}
					return false
				},
			})
			resolve(new MachineCredential(token))
			await expect(pending).rejects.toMatchObject({
				name: "DispatchNotSent",
				message: "Identify request not sent",
			})
			expect(native).not.toHaveBeenCalled()
		},
	)
	it.each(["destination", "headers", "credential", "aborted"])(
		"types proven pre-native refusal %s",
		async reason => {
			const native = vi.fn<typeof fetch>(async () => new Response("{}"))
			const controller = new AbortController()
			if (reason === "aborted") controller.abort()
			const request = createCliFetch({
				fetch: native,
				policy: {
					origin: "http://127.0.0.1:9100",
					credentials:
						reason === "credential"
							? async () => {
									throw new Error(token)
								}
							: credentials(),
				},
			})
			await expect(
				request(
					reason === "destination"
						? "http://127.0.0.1:9101/api/scanner/identify"
						: "http://127.0.0.1:9100/api/scanner/identify",
					{
						beforeDispatch: () => true,
						signal: controller.signal,
						...(reason === "headers"
							? { headers: { Authorization: token } }
							: {}),
					},
				),
			).rejects.toMatchObject({ name: "DispatchNotSent", reason })
			expect(native).not.toHaveBeenCalled()
		},
	)
	it("native failure remains sanitized and possibly sent", async () => {
		const native = vi.fn<typeof fetch>(async () => {
			throw new Error(token)
		})
		await expect(
			createCliFetch({ fetch: native })(
				"http://127.0.0.1:9100/api/scanner/identify",
				{ beforeDispatch: () => true },
			),
		).rejects.toMatchObject({ code: "ACCESS_TRANSPORT_FAILED" })
		expect(native).toHaveBeenCalledTimes(1)
	})
})
