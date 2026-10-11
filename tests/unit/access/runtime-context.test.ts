import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveAccessBootstrap } from "../../../src/access/bootstrap-policy.js"
import { ConnectionLeases } from "../../../src/access/connection-leases.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type {
	AccessRuntimeContext,
	AccessRuntimeOptions,
	NamedAccessRuntimeContext,
	NamedAccessRuntimeOptions,
} from "../../../src/access/runtime-context.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type { AccessRequest } from "../../../src/access/types.js"

const roots: string[] = []
const contexts: (AccessRuntimeContext | NamedAccessRuntimeContext)[] = []
const ownership = "single-host-pid-namespace" as const
const origin = "https://receiver.lan:9000"
const resolvedBootstrap = resolveAccessBootstrap({
	mode: "protected",
	listenerScheme: "https",
	allowedAuthorities: ["receiver.lan:9000", "receiver.lan:9001"],
	allowedOrigins: [origin],
	externalAudioOrigins: ["https://receiver.lan:9001"],
})
if (resolvedBootstrap.mode !== "protected")
	throw new Error("Invalid test bootstrap")
const bootstrap = resolvedBootstrap

afterEach(async () => {
	vi.restoreAllMocks()
	for (const context of contexts.splice(0))
		await context.close().catch(() => undefined)
	vi.useRealTimers()
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true })
})

async function location() {
	const root = await fs.mkdtemp(join(tmpdir(), "wavekit-access-runtime-"))
	roots.push(root)
	return { root, directory: join(root, "private") }
}

function options(directory: string): AccessRuntimeOptions {
	return {
		bootstrap,
		audio: {
			listenerScheme: "https",
			allowedAuthorities: ["receiver.lan:9001"],
		},
		directory,
		ownership,
	}
}

function namedOptions(directory: string): NamedAccessRuntimeOptions {
	return {
		...options(directory),
		bootstrap: {
			...bootstrap,
			allowedAuthorities: ["receiver.lan:9000"],
			// Deliberately reverse advertised order; listener roles are explicit.
			externalAudioOrigins: [
				"https://receiver.lan:9002",
				"https://receiver.lan:9001",
			],
		},
		audio: {
			analog: {
				listenerScheme: "https",
				allowedAuthorities: ["receiver.lan:9001"],
			},
			digital: {
				listenerScheme: "https",
				allowedAuthorities: ["receiver.lan:9002"],
			},
		},
	}
}

async function provision() {
	const fixture = await location()
	const storage = await PrivateAccessStorage.open({
		directory: fixture.directory,
		mode: "provision",
		ownership,
	})
	const token = storage.useMachineCredential(value => value)
	await storage.close()
	return { ...fixture, token }
}

async function open(directory: string) {
	const context = await openAccessRuntime(options(directory))
	contexts.push(context)
	return context
}

function request(
	headers: string[] = [],
	changes: Partial<AccessRequest> = {},
): AccessRequest {
	return {
		method: "GET",
		rawTarget: "/api/status",
		rawHeaders: ["Host", "receiver.lan:9000", "Origin", origin, ...headers],
		transport: "http",
		surface: "api",
		remoteAddress: "127.0.0.1",
		...changes,
	}
}

function audioRequest(cookie: string): AccessRequest {
	return request([], {
		surface: "audio",
		rawTarget: "/audio.wav",
		rawHeaders: [
			"Host",
			"receiver.lan:9001",
			"Origin",
			origin,
			"Cookie",
			`wavekit_session=${cookie}`,
		],
	})
}

describe("unmounted protected runtime lifecycle", () => {
	it("keeps named listener Host boundaries distinct while sharing durable renewal and revocation", async () => {
		const { directory, token } = await provision()
		const storageOpen = vi.spyOn(PrivateAccessStorage, "open")
		const context = await openAccessRuntime(namedOptions(directory))
		contexts.push(context)
		expect(storageOpen).toHaveBeenCalledTimes(1)
		expect(storageOpen).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "load" }),
		)
		const listeners = [context.api, context.analogAudio, context.digitalAudio]
		for (const listener of listeners) {
			expect(listener.sessions).toBe(context.api.sessions)
			expect(listener.leases).toBe(context.api.leases)
		}
		const authorities = [
			"receiver.lan:9000",
			"receiver.lan:9001",
			"receiver.lan:9002",
		]
		for (const [index, listener] of listeners.entries()) {
			for (const [hostIndex, host] of authorities.entries()) {
				const result = listener.policy.evaluate(
					request([], {
						surface: index === 0 ? "api" : "audio",
						rawHeaders: ["Host", host, "Authorization", `Bearer ${token}`],
					}),
				)
				expect(result).toMatchObject(
					index === hostIndex
						? { kind: "authenticated" }
						: { code: "HOST_FORBIDDEN" },
				)
			}
		}
		const session = await context.api.sessions.create()
		if (session.kind !== "created") throw new Error("Missing session")
		const cookies = [
			"Cookie",
			`wavekit_session=${session.cookieValue}`,
			"X-WaveKit-CSRF",
			session.csrfToken,
		]
		const closed = listeners.map(listener => {
			const callback = vi.fn()
			expect(listener.leases.attach(session.principalId, callback).kind).toBe(
				"attached",
			)
			return callback
		})
		const browserRequests = authorities.map(host =>
			request([], {
				surface: "audio",
				rawHeaders: [
					"Host",
					host,
					"Origin",
					origin,
					"Cookie",
					`wavekit_session=${session.cookieValue}`,
				],
			}),
		)
		for (const [index, listener] of listeners.entries()) {
			const original = browserRequests[index]
			if (!original) throw new Error("Missing test request")
			expect(listener.policy.evaluate(original).kind).toBe("authenticated")
		}
		const refresh = await context.services.flows.refresh(
			request(cookies, {
				method: "POST",
				rawTarget: "/api/access/session/refresh",
			}),
		)
		expect(refresh).toMatchObject({
			kind: "success",
			cookie: { value: session.cookieValue },
		})
		for (const callback of closed) expect(callback).not.toHaveBeenCalled()
		const logout = await context.services.flows.logout(
			request(cookies, {
				method: "POST",
				rawTarget: "/api/access/session/logout",
			}),
		)
		expect(logout.kind).toBe("success")
		for (const callback of closed) expect(callback).toHaveBeenCalledOnce()
		for (const [index, listener] of listeners.entries()) {
			const original = browserRequests[index]
			if (!original) throw new Error("Missing test request")
			expect(listener.policy.evaluate(original)).toMatchObject({
				code: "AUTH_REQUIRED",
			})
		}
		await context.close()
		const restarted = await openAccessRuntime(namedOptions(directory))
		contexts.push(restarted)
		expect(restarted.api.sessions.lookup(session.cookieValue)).toBeUndefined()
	})

	it.each([
		{ externalAudioOrigins: ["https://receiver.lan:9003"] },
		{ externalAudioOrigins: ["http://receiver.lan:9001"] },
		{ externalAudioOrigins: ["https://receiver.lan:9000"] },
	])(
		"rejects advertised audio outside the named boundary union before storage I/O: %o",
		async delta => {
			const { directory } = await location()
			const config = namedOptions(directory)
			const storageOpen = vi.spyOn(PrivateAccessStorage, "open")
			await expect(
				openAccessRuntime({
					...config,
					bootstrap: { ...config.bootstrap, ...delta },
				}),
			).rejects.toMatchObject({ code: "ACCESS_RUNTIME_UNAVAILABLE" })
			expect(storageOpen).not.toHaveBeenCalled()
		},
	)

	it("rejects a named audio scheme inconsistent with API before storage I/O", async () => {
		const { directory } = await location()
		const config = namedOptions(directory)
		const storageOpen = vi.spyOn(PrivateAccessStorage, "open")
		await expect(
			openAccessRuntime({
				...config,
				audio: {
					...config.audio,
					digital: { ...config.audio.digital, listenerScheme: "http" },
				},
			}),
		).rejects.toMatchObject({ code: "ACCESS_RUNTIME_UNAVAILABLE" })
		expect(storageOpen).not.toHaveBeenCalled()
	})

	// Feature: core-access-policy, Property 4: Durable renewable lifecycle
	// Validates: Requirements 4.1, 4.4, 6.1
	it("composes one committed authority and restores a paired browser without logout on restart", async () => {
		const { directory, token } = await provision()
		const context = await open(directory)
		expect(context.api.sessions).toBe(context.audio.sessions)
		expect(context.api.leases).toBe(context.audio.leases)
		expect(context.api.policy.usesSessionStore(context.api.sessions)).toBe(true)
		expect(context.audio.policy.usesSessionStore(context.api.sessions)).toBe(
			true,
		)
		expect(context.api.leases.usesSessionStore(context.api.sessions)).toBe(true)
		const issued = context.services.pairing.issue(
			request(["Authorization", `Bearer ${token}`], {
				method: "POST",
				rawTarget: "/api/access/pairing-codes",
			}),
		)
		expect(issued.kind).toBe("success")
		if (issued.kind !== "success") throw new Error("Missing pairing code")
		const paired = await context.services.pairing.redeem(
			request([], { method: "POST", rawTarget: "/api/access/pair" }),
			{ code: issued.body.code },
		)
		expect(paired.kind).toBe("success")
		if (paired.kind !== "success" || !paired.cookie)
			throw new Error("Missing paired session")
		const cookie = paired.cookie.value
		expect(paired.cookie.secure).toBe(true)
		expect(context.audio.policy.evaluate(audioRequest(cookie)).kind).toBe(
			"authenticated",
		)
		const firstClose = context.close()
		expect(context.close()).toBe(firstClose)
		await firstClose
		expect(await fs.readdir(directory)).toEqual(
			expect.arrayContaining(["initialized", "access-state.json"]),
		)
		const restarted = await open(directory)
		const status = restarted.services.flows.status(
			request(["Cookie", `wavekit_session=${cookie}`], {
				rawTarget: "/api/access/session",
			}),
		)
		expect(status).toMatchObject({ kind: "success", body: paired.body })
		expect(restarted.audio.policy.evaluate(audioRequest(cookie)).kind).toBe(
			"authenticated",
		)
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).not.toContain(cookie)
		expect(JSON.stringify(restarted)).not.toContain(token)
		expect(JSON.stringify(restarted)).not.toContain(directory)
	})

	it("uses explicit listener authorities rather than deriving audio roles from advertised origins", async () => {
		const { directory, token } = await provision()
		const context = await openAccessRuntime({
			...options(directory),
			bootstrap: {
				...bootstrap,
				allowedAuthorities: [...bootstrap.allowedAuthorities, "127.0.0.1:9123"],
				externalAudioOrigins: [],
			},
			audio: {
				listenerScheme: "https",
				allowedAuthorities: ["127.0.0.1:9123"],
			},
		})
		contexts.push(context)
		const headers = ["Authorization", `Bearer ${token}`]
		expect(context.api.policy.evaluate(request(headers)).kind).toBe(
			"authenticated",
		)
		expect(
			context.audio.policy.evaluate(
				request([], {
					surface: "audio",
					rawHeaders: ["Host", "127.0.0.1:9123", ...headers],
				}),
			).kind,
		).toBe("authenticated")
		expect(
			context.audio.policy.evaluate(request(headers, { surface: "audio" })),
		).toMatchObject({ code: "HOST_FORBIDDEN" })
		expect(
			context.audio.policy.evaluate(
				request([], {
					surface: "audio",
					rawHeaders: ["Host", "receiver.lan:9001", ...headers],
				}),
			),
		).toMatchObject({ code: "HOST_FORBIDDEN" })
		expect(
			context.audio.policy.evaluate(
				request([], {
					surface: "audio",
					rawTarget: "/health",
					rawHeaders: ["Host", "127.0.0.1:9123"],
				}),
			),
		).toMatchObject({ code: "AUTH_REQUIRED" })
	})

	it("durable API logout immediately invalidates API and audio leases on the same authority", async () => {
		const { directory } = await provision()
		const context = await open(directory)
		const session = await context.api.sessions.create()
		if (session.kind !== "created") throw new Error("Missing session")
		const apiClosed = vi.fn()
		const audioClosed = vi.fn()
		expect(context.api.leases.attach(session.principalId, apiClosed).kind).toBe(
			"attached",
		)
		expect(
			context.audio.leases.attach(session.principalId, audioClosed).kind,
		).toBe("attached")
		const logout = await context.services.flows.logout(
			request(
				[
					"Cookie",
					`wavekit_session=${session.cookieValue}`,
					"X-WaveKit-CSRF",
					session.csrfToken,
				],
				{ method: "POST", rawTarget: "/api/access/session/logout" },
			),
		)
		expect(logout).toMatchObject({ kind: "success", body: { revoked: true } })
		expect(apiClosed).toHaveBeenCalledOnce()
		expect(audioClosed).toHaveBeenCalledOnce()
		expect(
			context.audio.policy.evaluate(audioRequest(session.cookieValue)),
		).toMatchObject({ code: "AUTH_REQUIRED" })
		expect(context.api.leases.attach(session.principalId, vi.fn())).toEqual({
			kind: "rejected",
			reason: "invalidated",
		})
		await context.close()
		const restored = await open(directory)
		expect(
			restored.audio.policy.evaluate(audioRequest(session.cookieValue)),
		).toMatchObject({ code: "AUTH_REQUIRED" })
	})

	it("disposes every shared lease before releasing storage, without persisting automatic revocation", async () => {
		const { directory } = await provision()
		const context = await open(directory)
		const session = await context.api.sessions.create()
		if (session.kind !== "created") throw new Error("Missing session")
		const before = await fs.readFile(
			join(directory, "access-state.json"),
			"utf8",
		)
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const order: string[] = []
		let reentrantClose: Promise<void> | undefined
		context.api.leases.attach(session.principalId, () => {
			order.push("api")
			reentrantClose = context.close()
			throw new Error("Native secret")
		})
		context.audio.leases.attach(session.principalId, () => {
			order.push("audio")
		})
		expect(vi.getTimerCount()).toBe(1)
		const originalClose = PrivateAccessStorage.prototype.close
		vi.spyOn(PrivateAccessStorage.prototype, "close").mockImplementation(
			function (this: PrivateAccessStorage) {
				order.push("storage")
				return originalClose.call(this)
			},
		)
		const closing = context.close()
		await closing
		expect(reentrantClose).toBe(closing)
		expect(order).toEqual(["api", "audio", "storage"])
		expect(vi.getTimerCount()).toBe(0)
		expect(context.api.leases.attach(session.principalId, vi.fn())).toEqual({
			kind: "rejected",
			reason: "disposed",
		})
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).toBe(before)
		expect(
			(await fs.readdir(directory)).filter(entry => entry.startsWith("owner-")),
		).toEqual([])
	})

	it("never creates missing startup storage or provisions a credential", async () => {
		const { root, directory } = await location()
		const mkdir = vi.spyOn(fs, "mkdir")
		const write = vi.spyOn(fs, "writeFile")
		await expect(openAccessRuntime(options(directory))).rejects.toMatchObject({
			code: "ACCESS_RUNTIME_UNAVAILABLE",
			cause: undefined,
		})
		expect(mkdir).not.toHaveBeenCalled()
		expect(write).not.toHaveBeenCalled()
		expect(await fs.readdir(root)).toEqual([])
	})

	it("preserves corrupt initialized state and releases acquired ownership after failure", async () => {
		const { directory, token } = await provision()
		const corrupted = `corrupt private state ${token}`
		await fs.writeFile(join(directory, "access-state.json"), corrupted, {
			mode: 0o600,
		})
		const error: unknown = await openAccessRuntime(options(directory)).catch(
			value => value,
		)
		expect(error).toMatchObject({
			message: "Access runtime unavailable",
			code: "ACCESS_RUNTIME_UNAVAILABLE",
			cause: undefined,
		})
		expect(JSON.stringify(error)).not.toContain(token)
		expect(JSON.stringify(error)).not.toContain(directory)
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).toBe(corrupted)
		expect(
			(await fs.readdir(directory)).filter(entry => entry.startsWith("owner-")),
		).toEqual([])
	})

	it.each(
		[
			{ bootstrap: { mode: "legacy" } },
			{ bootstrap: { ...bootstrap, unexpected: "private-secret" } },
			{ bootstrap: { ...bootstrap, allowedAuthorities: ["0.0.0.0:9000"] } },
			{
				bootstrap: {
					...bootstrap,
					externalAudioOrigins: ["https://evil.invalid/path"],
				},
			},
			{ audio: { listenerScheme: "https", allowedAuthorities: ["[::]:9001"] } },
			{
				audio: {
					listenerScheme: "http",
					allowedAuthorities: ["receiver.lan:9001"],
				},
			},
			{
				audio: {
					listenerScheme: "https",
					allowedAuthorities: ["receiver.lan:9199"],
				},
			},
			{
				bootstrap: {
					...bootstrap,
					externalAudioOrigins: ["https://receiver.lan:9000"],
				},
			},
			{
				bootstrap: {
					...bootstrap,
					externalAudioOrigins: ["http://receiver.lan:9001"],
				},
			},
			{
				audio: {
					listenerScheme: "https",
					allowedAuthorities: ["receiver.lan:9001"],
					unknown: true,
				},
			},
			{ directory: "relative-private-secret" },
			{ sessionCookieName: "bad;cookie" },
			{
				bootstrap: { ...bootstrap, listenerScheme: "http" },
				sessionCookieName: "__Host-session",
			},
			{ ownership: "unverified" },
		].map(delta => ({ delta })),
	)(
		"validates the exact protected configuration before filesystem I/O: $delta",
		async ({ delta }) => {
			const { directory } = await location()
			const storageOpen = vi.spyOn(PrivateAccessStorage, "open")
			await expect(
				openAccessRuntime({
					...options(directory),
					...delta,
				} as AccessRuntimeOptions),
			).rejects.toMatchObject({ code: "ACCESS_RUNTIME_UNAVAILABLE" })
			expect(storageOpen).not.toHaveBeenCalled()
		},
	)

	it("awaits restored session authority before exposing listener dependencies", async () => {
		const { directory } = await provision()
		let release = () => {}
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		const original = SessionStore.open
		vi.spyOn(SessionStore, "open").mockImplementation(async config => {
			await gate
			return original.call(SessionStore, config)
		})
		let handedOff = false
		const pending = open(directory).then(context => {
			handedOff = true
			return context
		})
		await vi.waitFor(() => expect(SessionStore.open).toHaveBeenCalledOnce())
		expect(handedOff).toBe(false)
		release()
		await pending
		expect(handedOff).toBe(true)
	})

	it("cleans both resources if service construction fails after the shared lease manager exists", async () => {
		const { directory } = await provision()
		const order: string[] = []
		const dispose = ConnectionLeases.prototype.dispose
		const close = PrivateAccessStorage.prototype.close
		vi.spyOn(ConnectionLeases.prototype, "dispose").mockImplementation(
			function (this: ConnectionLeases) {
				order.push("leases")
				dispose.call(this)
			},
		)
		vi.spyOn(PrivateAccessStorage.prototype, "close").mockImplementation(
			function (this: PrivateAccessStorage) {
				order.push("storage")
				return close.call(this)
			},
		)
		vi.spyOn(AccessPolicy.prototype, "usesSessionStore").mockReturnValue(false)
		await expect(openAccessRuntime(options(directory))).rejects.toMatchObject({
			code: "ACCESS_RUNTIME_UNAVAILABLE",
		})
		expect(order).toEqual(["leases", "storage"])
		expect(
			(await fs.readdir(directory)).filter(entry => entry.startsWith("owner-")),
		).toEqual([])
		vi.restoreAllMocks()
		await open(directory)
	})

	it("startup persistence failure while pruning expired browsers fails closed and releases ownership", async () => {
		const { directory } = await provision()
		const initial = await open(directory)
		const session = await initial.api.sessions.create()
		if (session.kind !== "created") throw new Error("Missing session")
		await initial.close()
		const statePath = join(directory, "access-state.json")
		const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
			sessions: {
				sessions: { createdAt: number; renewedAt: number; expiresAt: number }[]
			}
		}
		const record = state.sessions.sessions[0]
		if (!record) throw new Error("Missing stored session")
		record.createdAt = record.renewedAt = Date.now() - 31 * 24 * 60 * 60 * 1000
		record.expiresAt = record.renewedAt + 30 * 24 * 60 * 60 * 1000
		const before = JSON.stringify(state)
		await fs.writeFile(statePath, before)
		vi.spyOn(fs, "rename").mockRejectedValue(
			new Error("native secret filesystem cause"),
		)
		await expect(openAccessRuntime(options(directory))).rejects.toMatchObject({
			code: "ACCESS_RUNTIME_UNAVAILABLE",
			cause: undefined,
		})
		expect(await fs.readFile(statePath, "utf8")).toBe(before)
		expect(
			(await fs.readdir(directory)).filter(entry => entry.startsWith("owner-")),
		).toEqual([])
		vi.restoreAllMocks()
		const restarted = await open(directory)
		expect(restarted.api.sessions.lookup(session.cookieValue)).toBeUndefined()
	})

	it("a failed durable mutation invalidates both surfaces without a memory-only success", async () => {
		const { directory } = await provision()
		const context = await open(directory)
		const session = await context.api.sessions.create()
		if (session.kind !== "created") throw new Error("Missing session")
		const closed = [vi.fn(), vi.fn()] as const
		context.api.leases.attach(session.principalId, closed[0])
		context.audio.leases.attach(session.principalId, closed[1])
		vi.spyOn(fs, "rename").mockRejectedValue(new Error("private native error"))
		await expect(
			context.api.sessions.renew(session.principalId),
		).rejects.toMatchObject({ code: "ACCESS_UNAVAILABLE" })
		for (const callback of closed) expect(callback).toHaveBeenCalledOnce()
		expect(context.api.sessions.unavailable).toBe(true)
		expect(
			context.api.policy.evaluate(
				request(["Cookie", `wavekit_session=${session.cookieValue}`]),
			),
		).toMatchObject({ code: "ACCESS_UNAVAILABLE" })
		expect(
			context.audio.policy.evaluate(audioRequest(session.cookieValue)),
		).toMatchObject({ code: "ACCESS_UNAVAILABLE" })
	})

	it("still releases ownership and sanitizes close failure if lease disposal throws", async () => {
		const { directory } = await provision()
		const context = await open(directory)
		vi.spyOn(context.api.leases, "dispose").mockImplementation(() => {
			throw new Error(`secret ${directory}`)
		})
		const first = context.close()
		expect(context.close()).toBe(first)
		await expect(first).rejects.toMatchObject({
			message: "Access runtime unavailable",
			code: "ACCESS_RUNTIME_UNAVAILABLE",
			cause: undefined,
		})
		expect(
			(await fs.readdir(directory)).filter(entry => entry.startsWith("owner-")),
		).toEqual([])
	})
})
