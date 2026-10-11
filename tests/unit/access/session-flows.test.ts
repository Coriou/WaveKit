import { describe, expect, it, vi } from "vitest"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionFlows } from "../../../src/access/session-flows.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type {
	SessionSnapshot,
	SessionStoreOptions,
} from "../../../src/access/sessions.js"
import type { AccessRequest } from "../../../src/access/types.js"

const DAY = 24 * 60 * 60_000
const origin = "http://receiver.lan:9000"

async function setup() {
	let elapsed = 0
	let random = 10
	let durable: SessionSnapshot | undefined
	const token = generateMachineToken(() => Buffer.alloc(32, 7))
	const digest = digestMachineToken(token)
	const persist = vi.fn((snapshot: SessionSnapshot) => {
		durable = structuredClone(snapshot)
		return Promise.resolve()
	})
	const options: SessionStoreOptions = {
		credentialBinding: sessionCredentialBinding(digest),
		persist,
		epochNow: () => 1_000_000,
		monotonicNow: () => elapsed,
		random: size => Buffer.alloc(size, ++random),
	}
	const sessions = await SessionStore.open(options)
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: ["receiver.lan:9000"],
		allowedOrigins: [origin],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const flows = new SessionFlows({ policy, sessions })
	const created = await sessions.create()
	if (created.kind !== "created") throw new Error("Expected created session")
	persist.mockClear()
	const request = (
		path = "/api/access/session",
		changes: Partial<AccessRequest> = {},
	): AccessRequest => ({
		method: path === "/api/access/session" ? "GET" : "POST",
		rawTarget: path,
		rawHeaders: [
			"Host",
			"receiver.lan:9000",
			"Origin",
			origin,
			"Cookie",
			`wavekit_session=${created.cookieValue}`,
			"X-WaveKit-CSRF",
			created.csrfToken,
		],
		transport: "http",
		surface: "api",
		remoteAddress: "127.0.0.1",
		...changes,
	})
	return {
		token,
		sessions,
		policy,
		flows,
		created,
		request,
		persist,
		options,
		advance: (ms: number) => {
			elapsed += ms
		},
		durable: () => durable,
	}
}

function deferred() {
	let resolve: () => void = () => {}
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

describe("original-request remembered-browser session flows", () => {
	it("returns only committed public metadata without renewing or exporting cookie secrets", async () => {
		const env = await setup()
		const result = env.flows.status(env.request())
		expect(result).toMatchObject({
			kind: "success",
			body: {
				deviceId: env.created.principalId,
				expiresAt: env.created.expiresAt,
				csrfToken: env.created.csrfToken,
			},
		})
		expect(env.persist).not.toHaveBeenCalled()
		expect(JSON.stringify(result)).not.toContain(env.created.cookieValue)
		expect("cookie" in result).toBe(false)
		expect(JSON.stringify(env.flows)).toBe("{}")
	})

	it("renews at day 29 to day 59, reissues the same cookie only after durable success, and restores it", async () => {
		const env = await setup()
		const pending = deferred()
		let persistedSnapshot: SessionSnapshot | undefined
		env.persist.mockImplementationOnce(async snapshot => {
			await pending.promise
			persistedSnapshot = structuredClone(snapshot)
		})
		env.advance(29 * DAY)
		const renewing = env.flows.refresh(
			env.request("/api/access/session/refresh"),
		)
		await vi.waitFor(() => expect(env.persist).toHaveBeenCalledOnce())
		expect(env.sessions.lookup(env.created.cookieValue)?.expiresAt).toBe(
			env.created.expiresAt,
		)
		pending.resolve()
		const result = await renewing
		expect(result).toMatchObject({
			kind: "success",
			body: { expiresAt: 1_000_000 + 59 * DAY },
		})
		if (result.kind !== "success") throw new Error("Expected renewal")
		expect(result.cookie?.value).toBe(env.created.cookieValue)
		expect(result.cookie?.maxAgeSeconds).toBe((30 * DAY) / 1000)
		expect(JSON.stringify(result)).not.toContain(env.created.cookieValue)
		expect(persistedSnapshot).toBeDefined()
		const restarted = await SessionStore.open({
			...env.options,
			persist: () => Promise.resolve(),
			epochNow: () => 1_000_000 + 29 * DAY,
			snapshot: persistedSnapshot,
		})
		expect(restarted.lookup(env.created.cookieValue)?.expiresAt).toBe(
			1_000_000 + 59 * DAY,
		)
	})

	it("closes leases and clears cookie on durable logout; queued refresh cannot resurrect", async () => {
		const env = await setup()
		const close = vi.fn()
		env.sessions.onInvalidated(env.created.principalId, close)
		const pending = deferred()
		env.persist.mockImplementationOnce(() => pending.promise)
		const logout = env.flows.logout(env.request("/api/access/session/logout"))
		const refresh = env.flows.refresh(
			env.request("/api/access/session/refresh"),
		)
		await vi.waitFor(() => expect(env.persist).toHaveBeenCalledOnce())
		expect(close).not.toHaveBeenCalled()
		pending.resolve()
		const loggedOut = await logout
		expect(loggedOut).toMatchObject({
			kind: "success",
			body: { revoked: true },
		})
		if (loggedOut.kind === "success")
			expect(loggedOut.cookie).toMatchObject({ value: "", maxAgeSeconds: 0 })
		expect(close).toHaveBeenCalledOnce()
		expect(await refresh).toMatchObject({
			status: 401,
			body: { code: "AUTH_REQUIRED" },
		})
		expect(env.sessions.lookup(env.created.cookieValue)).toBeUndefined()
	})

	it("rejects refresh when a direct committed revocation wins the store queue", async () => {
		const env = await setup()
		const revoke = env.sessions.revoke(env.created.principalId)
		const refresh = env.flows.refresh(
			env.request("/api/access/session/refresh"),
		)
		await revoke
		expect(await refresh).toMatchObject({ status: 401 })
		expect(env.sessions.exportSnapshot().sessions).toHaveLength(0)
	})

	it("rechecks committed state after asynchronous renewal before returning metadata or cookies", async () => {
		const env = await setup()
		const renew = env.sessions.renew.bind(env.sessions)
		vi.spyOn(env.sessions, "renew").mockImplementation(async id => {
			const result = await renew(id)
			await env.sessions.revoke(id)
			return result
		})
		const result = await env.flows.refresh(
			env.request("/api/access/session/refresh"),
		)
		expect(result).toMatchObject({ status: 401 })
		expect("cookie" in result).toBe(false)
	})

	it.each(["refresh", "logout", "revoke", "revokeAll"] as const)(
		"requires a session, Origin and CSRF for %s; machine cannot bypass",
		async action => {
			const env = await setup()
			const path = {
				refresh: "/api/access/session/refresh",
				logout: "/api/access/session/logout",
				revoke: "/api/access/devices/revoke",
				revokeAll: "/api/access/devices/revoke-all",
			}[action]
			const call = (request: AccessRequest) =>
				action === "revoke"
					? env.flows.revoke(request, { deviceId: env.created.principalId })
					: env.flows[action](request)
			const headers = [
				"Host",
				"receiver.lan:9000",
				"Cookie",
				`wavekit_session=${env.created.cookieValue}`,
			]
			for (const rawHeaders of [
				headers,
				[...headers, "Origin", origin],
				[...headers, "Origin", origin, "X-WaveKit-CSRF", "wrong"],
			])
				expect(await call(env.request(path, { rawHeaders }))).toMatchObject({
					status: 403,
					body: { code: "CSRF_REQUIRED" },
				})
			expect(
				await call(
					env.request(path, {
						rawHeaders: [
							"Host",
							"receiver.lan:9000",
							"Authorization",
							`Bearer ${env.token}`,
						],
					}),
				),
			).toMatchObject({ status: 403, body: { code: "SESSION_REQUIRED" } })
			expect(env.persist).not.toHaveBeenCalled()
		},
	)

	it("requires browser navigation metadata for a no-Origin status read", async () => {
		const env = await setup()
		const rawHeaders = [
			"Host",
			"receiver.lan:9000",
			"Cookie",
			`wavekit_session=${env.created.cookieValue}`,
		]
		expect(
			env.flows.status(env.request(undefined, { rawHeaders })),
		).toMatchObject({ status: 403 })
		expect(
			env.flows.status(
				env.request(undefined, {
					rawHeaders: [...rawHeaders, "Sec-Fetch-Site", "same-origin"],
				}),
			),
		).toMatchObject({ kind: "success" })
	})

	it.each([
		{ method: "GET" },
		{ transport: "websocket" as const },
		{ surface: "audio" as const },
		{ rawTarget: "/api/access/session/refresh?token=x" },
		{ rawTarget: "/api/access/session/logout" },
	])("does not authorize method/path/surface aliases %j", async changes => {
		const env = await setup()
		expect(
			await env.flows.refresh(
				env.request("/api/access/session/refresh", changes),
			),
		).toMatchObject({ status: 400 })
		expect(env.persist).not.toHaveBeenCalled()
	})

	it("rechecks the captured original request while queued and ignores later caller header changes", async () => {
		const env = await setup()
		const pending = deferred()
		env.persist.mockImplementationOnce(() => pending.promise)
		const first = env.flows.refresh(env.request("/api/access/session/refresh"))
		const request = env.request("/api/access/session/refresh", {
			rawHeaders: ["Host", "receiver.lan:9000", "Origin", origin],
		})
		const queued = env.flows.refresh(request)
		request.rawHeaders = [
			...env.request("/api/access/session/refresh").rawHeaders,
		]
		pending.resolve()
		expect(await first).toMatchObject({ kind: "success" })
		expect(await queued).toMatchObject({ status: 401 })
	})

	it("strictly validates device targets, revokes another device without clearing the current cookie", async () => {
		const env = await setup()
		const second = await env.sessions.create()
		if (second.kind !== "created") throw new Error("Expected second session")
		env.persist.mockClear()
		for (const body of [
			null,
			{},
			{ deviceId: "other" },
			{ deviceId: second.principalId, authorized: true },
		])
			expect(
				await env.flows.revoke(env.request("/api/access/devices/revoke"), body),
			).toMatchObject({ status: 400 })
		expect(env.persist).not.toHaveBeenCalled()
		const result = await env.flows.revoke(
			env.request("/api/access/devices/revoke"),
			{ deviceId: second.principalId },
		)
		expect(result).toMatchObject({ kind: "success", body: { revoked: true } })
		expect("cookie" in result).toBe(false)
		expect(env.sessions.lookup(second.cookieValue)).toBeUndefined()
		expect(env.sessions.lookup(env.created.cookieValue)).toBeDefined()
	})

	it("captures the validated device target before queueing and clears the cookie for self-revocation", async () => {
		const env = await setup()
		const target = { deviceId: env.created.principalId }
		const revoked = env.flows.revoke(
			env.request("/api/access/devices/revoke"),
			target,
		)
		target.deviceId = "device_" + "A".repeat(43)
		const result = await revoked
		expect(result).toMatchObject({ kind: "success", body: { revoked: true } })
		if (result.kind === "success") expect(result.cookie?.maxAgeSeconds).toBe(0)
		expect(env.sessions.lookup(env.created.cookieValue)).toBeUndefined()
	})

	it("revokes all devices through normal session leases and clears the initiating browser", async () => {
		const env = await setup()
		const second = await env.sessions.create()
		if (second.kind !== "created") throw new Error("Expected second session")
		const firstClose = vi.fn()
		const secondClose = vi.fn()
		env.sessions.onInvalidated(env.created.principalId, firstClose)
		env.sessions.onInvalidated(second.principalId, secondClose)
		const result = await env.flows.revokeAll(
			env.request("/api/access/devices/revoke-all"),
		)
		expect(result).toMatchObject({ kind: "success", body: { revoked: true } })
		if (result.kind === "success") expect(result.cookie?.maxAgeSeconds).toBe(0)
		expect(firstClose).toHaveBeenCalledOnce()
		expect(secondClose).toHaveBeenCalledOnce()
		expect(env.sessions.exportSnapshot().sessions).toHaveLength(0)
	})

	it.each(["refresh", "logout", "revoke", "revokeAll"] as const)(
		"reports durable %s failures as unavailable with no cookie or leaked cause",
		async action => {
			const env = await setup()
			const close = vi.fn()
			env.sessions.onInvalidated(env.created.principalId, close)
			env.persist.mockRejectedValueOnce(new Error("SECRET-private-path"))
			const path = {
				refresh: "/api/access/session/refresh",
				logout: "/api/access/session/logout",
				revoke: "/api/access/devices/revoke",
				revokeAll: "/api/access/devices/revoke-all",
			}[action]
			const result = await (action === "revoke"
				? env.flows.revoke(env.request(path), {
						deviceId: env.created.principalId,
					})
				: env.flows[action](env.request(path)))
			expect(result).toMatchObject({
				status: 503,
				body: { code: "ACCESS_UNAVAILABLE" },
			})
			expect("cookie" in result).toBe(false)
			expect(JSON.stringify(result)).not.toContain("SECRET")
			expect(close).toHaveBeenCalledOnce()
			expect(env.flows.status(env.request())).toMatchObject({ status: 503 })
		},
	)

	it("does not refresh an expired session and rejects a mismatched authority", async () => {
		const env = await setup()
		env.advance(30 * DAY)
		expect(
			await env.flows.refresh(env.request("/api/access/session/refresh")),
		).toMatchObject({ status: 401 })
		expect(env.persist).not.toHaveBeenCalled()
		const other = await setup()
		expect(
			() => new SessionFlows({ policy: env.policy, sessions: other.sessions }),
		).toThrow("Invalid session flow configuration")
	})
})

describe("session-only device read flows", () => {
	it.each(["GET", "HEAD"])("reauthorizes %s and returns detached committed inventory without renewal", async method => {
		const env = await setup()
		const before = env.sessions.exportSnapshot()
		const result = env.flows.devices(env.request("/api/access/devices", { method }))
		expect(result).toMatchObject({ kind: "success", status: 200, body: { devices: [{ deviceId: env.created.principalId, current: true }] } })
		expect(env.sessions.exportSnapshot()).toEqual(before)
		expect(env.persist).not.toHaveBeenCalled()
		expect(JSON.stringify(result)).not.toContain(env.created.csrfToken)
		expect(JSON.stringify(result)).not.toContain(env.created.cookieValue)
	})

	it("gives machine identity precedence over a valid session cookie", async () => {
		const env = await setup()
		const request = env.request("/api/access/devices", { method: "GET" })
		request.rawHeaders.push("Authorization", `Bearer ${env.token}`)
		expect(env.flows.devices(request)).toMatchObject({ kind: "deny", status: 403, body: { code: "SESSION_REQUIRED" } })
	})

	it("revalidates requester at the snapshot boundary and returns no inventory after revoke or expiry", async () => {
		const env = await setup()
		const original = env.sessions.snapshotActiveDevices.bind(env.sessions)
		vi.spyOn(env.sessions, "snapshotActiveDevices").mockImplementationOnce(id => {
			env.advance(30 * DAY)
			return original(id)
		})
		expect(env.flows.devices(env.request("/api/access/devices", { method: "GET" }))).toMatchObject({ status: 401, body: { code: "AUTH_REQUIRED" } })
		await env.sessions.revoke(env.created.principalId)
		expect(env.flows.devices(env.request("/api/access/devices", { method: "GET" }))).toMatchObject({ status: 401 })
	})

	it("sanitizes a snapshot fault as 503 rather than a successful empty inventory", async () => {
		const env = await setup()
		vi.spyOn(env.sessions, "snapshotActiveDevices").mockImplementation(() => { throw new Error("private path and token") })
		const result = env.flows.devices(env.request("/api/access/devices", { method: "GET" }))
		expect(result).toMatchObject({ status: 503, body: { code: "ACCESS_UNAVAILABLE" } })
		expect(JSON.stringify(result)).not.toContain("private path")
	})

	it.each([
		{ method: "POST" },
		{ method: "GET", rawTarget: "/api/access/devices?x=1" },
		{ method: "GET", transport: "websocket" as const },
	])("does not authorize a normalized or nonread tuple (%#)", async changes => {
		const env = await setup()
		const result = env.flows.devices(env.request("/api/access/devices", changes))
		expect(result.kind).toBe("deny")
	})
})

describe("device safe-read context", () => {
	it.each(["same-origin", "none"])("accepts existing Origin-less %s fetch metadata without CSRF", async site => {
		const env = await setup()
		const rawHeaders = ["Host", "receiver.lan:9000", "Cookie", `wavekit_session=${env.created.cookieValue}`, "Sec-Fetch-Site", site]
		expect(env.flows.devices(env.request("/api/access/devices", { method: "GET", rawHeaders }))).toMatchObject({ status: 200 })
	})

	it("retains safe-read rejection without Origin or qualifying fetch metadata", async () => {
		const env = await setup()
		const rawHeaders = ["Host", "receiver.lan:9000", "Cookie", `wavekit_session=${env.created.cookieValue}`]
		expect(env.flows.devices(env.request("/api/access/devices", { method: "HEAD", rawHeaders }))).toMatchObject({ status: 403 })
	})
})
