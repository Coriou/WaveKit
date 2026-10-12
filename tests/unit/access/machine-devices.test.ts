import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import { ConnectionLeases } from "../../../src/access/connection-leases.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { projectMachineAccessDevices } from "../../../src/access/machine-devices.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionFlows } from "../../../src/access/session-flows.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type { SessionSnapshot } from "../../../src/access/sessions.js"
import type { AccessRequest } from "../../../src/access/types.js"

const origin = "http://receiver.lan:9000"

async function setup() {
	let elapsed = 0
	let machineNow = 0
	let random = 10
	const token = generateMachineToken(() => Buffer.alloc(32, 7))
	const digest = digestMachineToken(token)
	const persist = vi.fn((_snapshot: SessionSnapshot) => Promise.resolve())
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist,
		epochNow: () => 1_000_000,
		monotonicNow: () => elapsed,
		random: size => Buffer.alloc(size, ++random),
	})
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: ["receiver.lan:9000"],
		allowedOrigins: [origin],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const flows = new SessionFlows({
		policy,
		sessions,
		monotonicNow: () => machineNow,
	})
	const created = await sessions.create()
	if (created.kind !== "created") throw new Error("Expected created session")
	persist.mockClear()
	const machine = (
		path = "/api/access/machine/devices",
		changes: Partial<AccessRequest> = {},
	): AccessRequest => ({
		method: path === "/api/access/machine/devices" ? "GET" : "POST",
		rawTarget: path,
		rawHeaders: [
			"Host",
			"receiver.lan:9000",
			"Authorization",
			`Bearer ${token}`,
		],
		transport: "http",
		surface: "api",
		remoteAddress: "127.0.0.1",
		...changes,
	})
	const browser = (path: string): AccessRequest => ({
		method: "POST",
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
	})
	return {
		token,
		sessions,
		policy,
		flows,
		created,
		persist,
		machine,
		browser,
		advanceSession: (ms: number) => {
			elapsed += ms
		},
		advanceMachine: (ms: number) => {
			machineNow += ms
		},
	}
}

function deferred() {
	let resolve = (): void => {}
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

describe("machine-credential device administration", () => {
	it("lists remembered devices with no current requester and does not renew", () => {
		const env = setup()
		return env.then(ready => {
			const before = ready.created.expiresAt
			const result = ready.flows.machineDevices(ready.machine())
			expect(result).toMatchObject({
				status: 200,
				body: {
					devices: [
						{
							deviceId: ready.created.principalId,
							createdAt: 1_000_000,
							renewedAt: 1_000_000,
							expiresAt: before,
							current: false,
						},
					],
				},
			})
			expect("cookie" in result).toBe(false)
			expect(ready.persist).not.toHaveBeenCalled()
			expect(JSON.stringify(result)).not.toContain(ready.created.cookieValue)
			expect(JSON.stringify(result)).not.toContain(ready.created.csrfToken)
			expect(JSON.stringify(ready.flows)).toBe("{}")
			expect(
				ready.sessions.lookupByPrincipal(ready.created.principalId)?.expiresAt,
			).toBe(before)
		})
	})

	it("rejects cookies, missing and invalid bearers, and the wrong host or origin", async () => {
		const env = await setup()
		expect(
			env.flows.machineDevices(
				env.machine("/api/access/machine/devices", {
					rawHeaders: [
						"Host",
						"receiver.lan:9000",
						"Origin",
						origin,
						"Cookie",
						`wavekit_session=${env.created.cookieValue}`,
						"X-WaveKit-CSRF",
						env.created.csrfToken,
					],
				}),
			),
		).toMatchObject({ status: 403, body: { code: "MACHINE_REQUIRED" } })
		expect(
			env.flows.machineDevices(
				env.machine(undefined, {
					rawHeaders: ["Host", "receiver.lan:9000"],
				}),
			),
		).toMatchObject({ status: 401, body: { code: "AUTH_REQUIRED" } })
		expect(
			env.flows.machineDevices(
				env.machine(undefined, {
					rawHeaders: [
						"Host",
						"receiver.lan:9000",
						"Authorization",
						"Bearer not-a-credential",
					],
				}),
			),
		).toMatchObject({ status: 401, body: { code: "AUTH_REQUIRED" } })
		expect(
			env.flows.machineDevices(
				env.machine(undefined, {
					rawHeaders: [
						"Host",
						"evil.lan:9000",
						"Authorization",
						`Bearer ${env.token}`,
					],
				}),
			),
		).toMatchObject({ status: 403, body: { code: "HOST_FORBIDDEN" } })
		await expect(
			env.flows.machineRevoke(
				env.machine("/api/access/machine/devices/revoke", {
					rawHeaders: [
						"Host",
						"receiver.lan:9000",
						"Origin",
						"http://evil.lan:9000",
						"Authorization",
						`Bearer ${env.token}`,
					],
				}),
				{ deviceId: env.created.principalId },
			),
		).resolves.toMatchObject({
			status: 403,
			body: { code: "ORIGIN_FORBIDDEN" },
		})
		expect(env.persist).not.toHaveBeenCalled()
	})

	it("accepts a machine bearer without origin, cookie, or CSRF and closes that device's leases", async () => {
		const env = await setup()
		const other = await env.sessions.create()
		if (other.kind !== "created") throw new Error("Expected second session")
		const closed = vi.fn()
		const kept = vi.fn()
		const leases = new ConnectionLeases(env.sessions, {
			timers: { set: () => ({}), clear: () => undefined },
		})
		const attached = leases.attach(env.created.principalId, closed)
		leases.attach(other.principalId, kept)
		expect(attached.kind).toBe("attached")
		const revoked = await env.flows.machineRevoke(
			env.machine("/api/access/machine/devices/revoke"),
			{ deviceId: env.created.principalId },
		)
		expect(revoked).toMatchObject({ status: 200, body: { revoked: true } })
		expect("cookie" in revoked).toBe(false)
		expect(closed).toHaveBeenCalledOnce()
		expect(kept).not.toHaveBeenCalled()
		expect(
			env.sessions.lookupByPrincipal(env.created.principalId),
		).toBeUndefined()
		expect(env.sessions.lookupByPrincipal(other.principalId)?.principalId).toBe(
			other.principalId,
		)
		if (attached.kind === "attached")
			expect(attached.lease.current()).toBeUndefined()
		leases.dispose()
	})

	it("revoke-all closes every live lease and leaves an empty inventory", async () => {
		const env = await setup()
		const other = await env.sessions.create()
		if (other.kind !== "created") throw new Error("Expected second session")
		const closed = vi.fn()
		env.sessions.onInvalidated(env.created.principalId, closed)
		env.sessions.onInvalidated(other.principalId, closed)
		const result = await env.flows.machineRevokeAll(
			env.machine("/api/access/machine/devices/revoke-all"),
		)
		expect(result).toMatchObject({ status: 200, body: { revoked: true } })
		expect(closed).toHaveBeenCalledTimes(2)
		expect(env.flows.machineDevices(env.machine())).toMatchObject({
			status: 200,
			body: { devices: [] },
		})
	})

	it("fails closed on persistence loss without an empty success or a secret", async () => {
		const env = await setup()
		const closed = vi.fn()
		env.sessions.onInvalidated(env.created.principalId, closed)
		env.persist.mockRejectedValueOnce(new Error("secret disk path"))
		const result = await env.flows.machineRevoke(
			env.machine("/api/access/machine/devices/revoke"),
			{ deviceId: env.created.principalId },
		)
		expect(result).toMatchObject({
			status: 503,
			body: { code: "ACCESS_UNAVAILABLE" },
		})
		expect(JSON.stringify(result)).not.toContain("secret disk path")
		expect(closed).toHaveBeenCalledOnce()
		expect(env.flows.machineDevices(env.machine())).toMatchObject({
			status: 503,
			body: { code: "ACCESS_UNAVAILABLE" },
		})
	})

	it("hides a queued revoke from the synchronous inventory until commit", async () => {
		const env = await setup()
		const gate = deferred()
		let entered = (): void => {}
		const atPersist = new Promise<void>(resolve => {
			entered = resolve
		})
		env.persist.mockImplementationOnce(async () => {
			entered()
			await gate.promise
		})
		const revoke = vi.spyOn(env.sessions, "revoke")
		const pending = env.flows.machineRevoke(
			env.machine("/api/access/machine/devices/revoke"),
			{ deviceId: env.created.principalId },
		)
		await atPersist
		expect(env.flows.machineDevices(env.machine()).body).toMatchObject({
			devices: [expect.objectContaining({ deviceId: env.created.principalId })],
		})
		gate.resolve()
		await pending
		expect(revoke).toHaveBeenCalledWith(env.created.principalId)
		expect(env.flows.machineDevices(env.machine())).toMatchObject({
			body: { devices: [] },
		})
	})

	it("serializes machine revocation behind an already queued browser refresh", async () => {
		const env = await setup()
		const gate = deferred()
		let entered = (): void => {}
		const atPersist = new Promise<void>(resolve => {
			entered = resolve
		})
		env.persist.mockImplementationOnce(async () => {
			entered()
			await gate.promise
		})
		const revoke = vi.spyOn(env.sessions, "revoke")
		env.advanceSession(1_000)
		const refresh = env.flows.refresh(
			env.browser("/api/access/session/refresh"),
		)
		await atPersist
		const pending = env.flows.machineRevoke(
			env.machine("/api/access/machine/devices/revoke"),
			{ deviceId: env.created.principalId },
		)
		expect(revoke).not.toHaveBeenCalled()
		expect(env.flows.machineDevices(env.machine())).toMatchObject({
			body: {
				devices: [
					expect.objectContaining({
						deviceId: env.created.principalId,
						renewedAt: 1_000_000,
					}),
				],
			},
		})
		gate.resolve()
		await refresh
		await pending
		expect(revoke).toHaveBeenCalledOnce()
		expect(
			env.sessions.lookupByPrincipal(env.created.principalId),
		).toBeUndefined()
	})

	it("rate-limits machine attempts like pairing redemption and ignores cookie denials", async () => {
		const env = await setup()
		for (let attempt = 0; attempt < 5; attempt++)
			expect(env.flows.machineDevices(env.machine()).status).toBe(200)
		expect(env.flows.machineDevices(env.machine())).toMatchObject({
			status: 429,
			body: { code: "MACHINE_RATE_LIMITED" },
			headers: { "Retry-After": "60" },
		})
		for (let attempt = 0; attempt < 5; attempt++)
			expect(
				env.flows.machineDevices(
					env.machine(undefined, {
						rawHeaders: [
							"Host",
							"receiver.lan:9000",
							"Cookie",
							`wavekit_session=${env.created.cookieValue}`,
						],
					}),
				).status,
			).toBe(403)
		expect(
			env.flows.machineDevices(
				env.machine(undefined, { remoteAddress: "10.0.0.8" }),
			).status,
		).toBe(200)
		env.advanceMachine(60_000)
		expect(env.flows.machineDevices(env.machine()).status).toBe(200)
	})

	it("rejects malformed revoke targets before persistence", async () => {
		const env = await setup()
		expect(
			await env.flows.machineRevoke(
				env.machine("/api/access/machine/devices/revoke"),
				{ deviceId: "device_nope", extra: true },
			),
		).toMatchObject({ status: 400, body: { code: "MALFORMED_REQUEST" } })
		expect(
			await env.flows.machineRevoke(
				env.machine("/api/access/machine/devices/revoke?x=1"),
				{ deviceId: env.created.principalId },
			),
		).toMatchObject({ status: 400 })
		expect(env.persist).not.toHaveBeenCalled()
		expect(
			env.sessions.lookupByPrincipal(env.created.principalId),
		).toBeDefined()
	})

	it("rejects an unknown device without closing other leases", async () => {
		const env = await setup()
		const closed = vi.fn()
		env.sessions.onInvalidated(env.created.principalId, closed)
		const missing = `device_${"A".repeat(43)}`
		expect(
			await env.flows.machineRevoke(
				env.machine("/api/access/machine/devices/revoke"),
				{ deviceId: missing },
			),
		).toMatchObject({ status: 200, body: { revoked: false } })
		expect(closed).not.toHaveBeenCalled()
		expect(env.persist).not.toHaveBeenCalled()
	})

	it("fails closed when the machine budget clock is unusable", async () => {
		const env = await setup()
		const broken = new SessionFlows({
			policy: env.policy,
			sessions: env.sessions,
			monotonicNow: () => NaN,
		})
		expect(broken.machineDevices(env.machine())).toMatchObject({
			status: 503,
			body: { code: "ACCESS_UNAVAILABLE" },
		})
		expect(JSON.stringify(broken.machineDevices(env.machine()))).not.toContain(
			"NaN",
		)
	})

	it("does not authorize a normalized machine tuple", () => {
		// Feature: browser-access-batch1, Property 3: No implicit machine privilege
		// Validates: browser-access-batch1 Decision 6
		return setup().then(env => {
			fc.assert(
				fc.property(fc.string({ minLength: 1, maxLength: 24 }), suffix => {
					expect(
						env.flows.machineDevices(
							env.machine(`/api/access/machine/devices${suffix}`, {
								method: "GET",
							}),
						).kind,
					).toBe("deny")
				}),
				{ numRuns: 100 },
			)
			for (const changes of [
				{ method: "POST" },
				{ transport: "websocket" as const },
				{ surface: "audio" as const },
				{ rawTarget: "/api/access/machine/devices/" },
			])
				expect(
					env.flows.machineDevices(env.machine(undefined, changes)).status,
				).toBe(400)
		})
	})
})

describe("machine device projection", () => {
	it("rejects a browser-shaped inventory and private extras", async () => {
		const env = await setup()
		const snapshot = env.sessions.snapshotActiveDevices(env.created.principalId)
		if (snapshot.kind !== "active") throw new Error("Expected snapshot")
		expect(() => projectMachineAccessDevices(snapshot.devices)).toThrow(
			"Device inventory unavailable",
		)
		const remembered = env.sessions.snapshotRememberedDevices()
		const projected = projectMachineAccessDevices(remembered)
		expect(projected.devices).toEqual(remembered)
		expect(Object.keys(projected.devices[0] ?? {}).sort()).toEqual([
			"createdAt",
			"current",
			"deviceId",
			"expiresAt",
			"renewedAt",
		])
		expect(() =>
			projectMachineAccessDevices([
				{ ...remembered[0], csrfToken: env.created.csrfToken },
			]),
		).not.toThrow()
		expect(
			JSON.stringify(
				projectMachineAccessDevices([
					{ ...remembered[0], csrfToken: env.created.csrfToken },
				]),
			),
		).not.toContain(env.created.csrfToken)
	})
})
