import { describe, expect, it, vi } from "vitest"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { PairingService } from "../../../src/access/pairing.js"
import type { IssuedPairingCode } from "../../../src/access/pairing.js"
import type { AccessFlowResult } from "../../../src/access/cookies.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type { SessionSnapshot } from "../../../src/access/sessions.js"
import type { AccessRequest } from "../../../src/access/types.js"

const origin = "http://receiver.lan:9000"

async function setup(
	options: {
		maxSessions?: number
		persist?: (snapshot: SessionSnapshot) => Promise<void>
	} = {},
) {
	let elapsed = 0
	let sessionRandom = 10
	let codeRandom = 10
	const token = generateMachineToken(() => Buffer.alloc(32, 7))
	const digest = digestMachineToken(token)
	const persist = vi.fn(options.persist ?? (() => Promise.resolve()))
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist,
		epochNow: () => 1_000_000,
		monotonicNow: () => elapsed,
		random: size => Buffer.alloc(size, ++sessionRandom),
		...(options.maxSessions === undefined
			? {}
			: { maxSessions: options.maxSessions }),
	})
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: ["receiver.lan:9000"],
		allowedOrigins: [origin],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const service = new PairingService({
		policy,
		sessions,
		monotonicNow: () => elapsed,
		random: size => Buffer.alloc(size, codeRandom++),
	})
	const request = (
		path = "/api/access/pair",
		headers: string[] = [],
		changes: Partial<AccessRequest> = {},
	): AccessRequest => ({
		method: "POST",
		rawTarget: path,
		rawHeaders: ["Host", "receiver.lan:9000", "Origin", origin, ...headers],
		transport: "http",
		surface: "api",
		remoteAddress: "127.0.0.1",
		...changes,
	})
	const issue = () =>
		service.issue(
			request("/api/access/pairing-codes", [
				"Authorization",
				`Bearer ${token}`,
			]),
		)
	return {
		token,
		sessions,
		policy,
		service,
		request,
		issue,
		persist,
		advance: (ms: number) => {
			elapsed += ms
		},
		now: () => elapsed,
	}
}

function code(result: AccessFlowResult<IssuedPairingCode>): string {
	if (result.kind !== "success") throw new Error("Expected pairing issuance")
	return result.body.code
}

function deferred() {
	let resolve: () => void = () => {}
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

describe("machine-issued single-use pairing", () => {
	it("issues a formatted 50-bit code, normalizes ASCII lowercase, and consumes only after durable session creation", async () => {
		const env = await setup()
		const issued = env.issue()
		const value = code(issued)
		expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
		expect(issued).toMatchObject({
			status: 201,
			body: { expiresInSeconds: 600 },
		})
		const paired = await env.service.redeem(env.request(), {
			code: value.toLowerCase(),
		})
		expect(paired).toMatchObject({ kind: "success", status: 201 })
		expect(env.persist).toHaveBeenCalledOnce()
		if (paired.kind !== "success") throw new Error("Expected pairing success")
		const cookie = paired.cookie?.value
		expect(cookie).toBeDefined()
		expect(env.sessions.lookup(cookie ?? "")?.principalId).toBe(
			paired.body.deviceId,
		)
		expect(JSON.stringify(paired.body)).not.toContain(cookie)
		expect(JSON.stringify(paired)).not.toContain(cookie)
		expect(JSON.stringify(env.service)).toBe("{}")
		expect(JSON.stringify(env.sessions.exportSnapshot())).not.toContain(cookie)
		expect(JSON.stringify(env.sessions.exportSnapshot())).not.toContain(value)
		expect(
			await env.service.redeem(env.request(), { code: value.replace("-", "") }),
		).toMatchObject({ status: 401, body: { code: "PAIRING_INVALID" } })
	})

	it("requires a machine on the exact issuance endpoint; browser, health, WS and audio cannot mint codes", async () => {
		const env = await setup()
		const session = await env.sessions.create()
		if (session.kind !== "created") throw new Error("Expected session")
		expect(
			env.service.issue(
				env.request("/api/access/pairing-codes", [
					"Cookie",
					`wavekit_session=${session.cookieValue}`,
					"X-WaveKit-CSRF",
					session.csrfToken,
				]),
			),
		).toMatchObject({ status: 403, body: { code: "MACHINE_REQUIRED" } })
		expect(
			env.service.issue(env.request("/api/access/pairing-codes")),
		).toMatchObject({ status: 401 })
		for (const changes of [
			{ method: "GET" },
			{ transport: "websocket" as const },
			{ surface: "audio" as const },
			{ rawTarget: "/health" },
			{ rawTarget: "/api/access/pairing-codes?code=x" },
		])
			expect(
				env.service.issue(
					env.request(
						"/api/access/pairing-codes",
						["Authorization", `Bearer ${env.token}`],
						changes,
					),
				),
			).toMatchObject({ status: 400 })
	})

	it("does not accept a pair code as bearer access and keeps normal pair-route admission protected", async () => {
		const env = await setup()
		const value = code(env.issue())
		expect(env.policy.evaluate(env.request())).toMatchObject({
			kind: "deny",
			status: 401,
		})
		expect(
			env.policy.evaluate(
				env.request("/api/status", ["Authorization", `Bearer ${value}`], {
					method: "GET",
				}),
			),
		).toMatchObject({ kind: "deny", status: 401 })
	})

	it.each([
		["missing origin", ["Host", "receiver.lan:9000"], 403],
		["wrong host", ["Host", "evil.lan:9000", "Origin", origin], 403],
		[
			"wrong origin",
			["Host", "receiver.lan:9000", "Origin", "http://evil.lan:9000"],
			403,
		],
		["opaque origin", ["Host", "receiver.lan:9000", "Origin", "null"], 403],
		[
			"duplicate origin",
			["Host", "receiver.lan:9000", "Origin", origin, "origin", origin],
			400,
		],
		[
			"duplicate host",
			[
				"Host",
				"receiver.lan:9000",
				"host",
				"receiver.lan:9000",
				"Origin",
				origin,
			],
			400,
		],
		[
			"duplicate cookie",
			[
				"Host",
				"receiver.lan:9000",
				"Origin",
				origin,
				"Cookie",
				"wavekit_session=a; wavekit_session=b",
			],
			400,
		],
		[
			"combined authorization",
			[
				"Host",
				"receiver.lan:9000",
				"Origin",
				origin,
				"Authorization",
				"Bearer a, Bearer b",
			],
			400,
		],
	] as const)(
		"rejects %s before code lookup or session creation",
		async (_label, rawHeaders, status) => {
			const env = await setup()
			const value = code(env.issue())
			expect(
				await env.service.redeem(
					env.request(undefined, [], { rawHeaders: [...rawHeaders] }),
					{ code: value },
				),
			).toMatchObject({ status })
			expect(env.persist).not.toHaveBeenCalled()
			expect(
				await env.service.redeem(env.request(), { code: value }),
			).toMatchObject({ kind: "success" })
		},
	)

	it.each([
		{ method: "GET" },
		{ transport: "websocket" as const },
		{ surface: "audio" as const },
		{ rawTarget: "/api/access/pair?code=123" },
		{ rawTarget: "/api/access/pair/" },
		{ rawTarget: "/api/access/session" },
		{ rawTarget: "/api/access/%70air" },
	])("rejects exchange route aliases %j", async changes => {
		const env = await setup()
		expect(
			await env.service.redeem(env.request(undefined, [], changes), {
				code: code(env.issue()),
			}),
		).toMatchObject({ status: 400 })
		expect(env.persist).not.toHaveBeenCalled()
	})

	it.each([
		null,
		{},
		{ code: "11111-11111", extra: true },
		{ code: "11111--11111" },
		{ code: "1111I-11111" },
		{ code: "1111L-11111" },
		{ code: "1111O-11111" },
		{ code: "1111U-11111" },
		{ code: "１１１１１-11111" },
		{ code: " 11111-11111" },
		{ code: "x".repeat(10000) },
	])("strictly bounds and validates the original body %j", async body => {
		const env = await setup()
		expect(await env.service.redeem(env.request(), body)).toMatchObject({
			status: 400,
		})
		expect(env.persist).not.toHaveBeenCalled()
	})

	it("reserves before await so concurrent redemption creates exactly one durable session", async () => {
		const pending = deferred()
		const env = await setup({ persist: () => pending.promise })
		const value = code(env.issue())
		const first = env.service.redeem(env.request(), { code: value })
		expect(
			await env.service.redeem(env.request(), { code: value }),
		).toMatchObject({ status: 401 })
		await vi.waitFor(() => expect(env.persist).toHaveBeenCalledOnce())
		expect(env.sessions.exportSnapshot().sessions).toHaveLength(0)
		pending.resolve()
		expect(await first).toMatchObject({ kind: "success" })
		expect(env.sessions.exportSnapshot().sessions).toHaveLength(1)
	})

	it("expires at ten minutes, ignores backward clock changes, and loses codes on process restart", async () => {
		const env = await setup()
		const value = code(env.issue())
		env.advance(600_000)
		expect(
			await env.service.redeem(env.request(), { code: value }),
		).toMatchObject({ status: 401 })
		env.advance(-600_000)
		expect(
			await env.service.redeem(env.request(), { code: value }),
		).toMatchObject({ status: 401 })
		const fresh = code(env.issue())
		const restarted = new PairingService({
			policy: env.policy,
			sessions: env.sessions,
		})
		expect(
			await restarted.redeem(env.request(), { code: fresh }),
		).toMatchObject({ status: 401 })
	})

	it("permits an already reserved redemption to finish after code expiry without freeing its capacity early", async () => {
		const pending = deferred()
		const env = await setup({ persist: () => pending.promise })
		const value = code(env.issue())
		for (let i = 0; i < 3; i++) code(env.issue())
		const first = env.service.redeem(env.request(), { code: value })
		env.advance(600_000)
		for (let i = 0; i < 3; i++) code(env.issue())
		expect(env.issue()).toMatchObject({
			status: 429,
			body: { code: "PAIRING_CAPACITY" },
		})
		pending.resolve()
		expect(await first).toMatchObject({ kind: "success" })
		expect(env.issue()).toMatchObject({ kind: "success" })
	})

	it("bounds outstanding codes and frees expired unreserved entries", async () => {
		const env = await setup()
		for (let i = 0; i < 4; i++) code(env.issue())
		expect(env.issue()).toMatchObject({ status: 429 })
		env.advance(600_000)
		expect(env.issue()).toMatchObject({ kind: "success" })
	})

	it("releases reservation on session capacity without consuming an unexpired code", async () => {
		const env = await setup({ maxSessions: 1 })
		const occupied = await env.sessions.create()
		if (occupied.kind !== "created") throw new Error("Expected session")
		const value = code(env.issue())
		const result = await env.service.redeem(env.request(), { code: value })
		expect(result).toMatchObject({
			status: 429,
			body: { code: "SESSION_CAPACITY" },
		})
		expect("cookie" in result).toBe(false)
		await env.sessions.revoke(occupied.principalId)
		expect(
			await env.service.redeem(env.request(), { code: value }),
		).toMatchObject({ kind: "success" })
	})

	it("fails closed on persistence errors without code, cookie or cause leakage", async () => {
		const env = await setup({
			persist: () => Promise.reject(new Error("SECRET-storage-path")),
		})
		const value = code(env.issue())
		const result = await env.service.redeem(env.request(), { code: value })
		expect(result).toMatchObject({
			status: 503,
			body: { code: "ACCESS_UNAVAILABLE" },
		})
		expect("cookie" in result).toBe(false)
		expect(JSON.stringify(result)).not.toContain("SECRET")
		expect(JSON.stringify(result)).not.toContain(value)
		expect(env.issue()).toMatchObject({ status: 503 })
		expect(
			await env.service.redeem(env.request(), { code: value }),
		).toMatchObject({ status: 503 })
	})

	it("limits lookup attempts per connection address before lookup, including malformed bodies", async () => {
		const env = await setup()
		const value = code(env.issue())
		for (let i = 0; i < 5; i++)
			expect(await env.service.redeem(env.request(), {})).toMatchObject({
				status: 400,
			})
		expect(
			await env.service.redeem(env.request(), { code: value }),
		).toMatchObject({ status: 429, body: { code: "PAIRING_RATE_LIMITED" } })
		expect(
			await env.service.redeem(
				env.request(undefined, ["X-Forwarded-For", "other"]),
				{ code: value },
			),
		).toMatchObject({ status: 429 })
		env.advance(60_000)
		expect(
			await env.service.redeem(env.request(), { code: value }),
		).toMatchObject({ kind: "success" })
	})

	it("enforces the global budget and bounded address capacity without evicting active buckets", async () => {
		const env = await setup()
		for (let batch = 0; batch < 2; batch++) {
			for (let i = 0; i < 60; i++)
				expect(
					await env.service.redeem(
						env.request(undefined, [], {
							remoteAddress: `address-${batch * 60 + i}`,
						}),
						{ code: "ZZZZZ-ZZZZZ" },
					),
				).toMatchObject({ status: 401 })
			expect(
				await env.service.redeem(
					env.request(undefined, [], { remoteAddress: "global-overflow" }),
					{},
				),
			).toMatchObject({ status: 429 })
			env.advance(60_000)
		}
		for (let i = 120; i < 128; i++)
			expect(
				await env.service.redeem(
					env.request(undefined, [], { remoteAddress: `address-${i}` }),
					{},
				),
			).toMatchObject({ status: 400 })
		expect(
			await env.service.redeem(
				env.request(undefined, [], { remoteAddress: "capacity-overflow" }),
				{},
			),
		).toMatchObject({ status: 429 })
		expect(
			await env.service.redeem(
				env.request(undefined, [], { remoteAddress: "address-0" }),
				{},
			),
		).toMatchObject({ status: 400 })
		env.advance(600_000)
		expect(
			await env.service.redeem(
				env.request(undefined, [], { remoteAddress: "capacity-overflow" }),
				{},
			),
		).toMatchObject({ status: 400 })
	})

	it("rejects mismatched policy/session authorities and hides random/clock failures", async () => {
		const env = await setup()
		const other = await setup()
		expect(
			() =>
				new PairingService({ policy: env.policy, sessions: other.sessions }),
		).toThrow("Invalid pairing configuration")
		const failed = new PairingService({
			policy: env.policy,
			sessions: env.sessions,
			random: () => {
				throw new Error("SECRET")
			},
		})
		expect(
			JSON.stringify(
				failed.issue(
					env.request("/api/access/pairing-codes", [
						"Authorization",
						`Bearer ${env.token}`,
					]),
				),
			),
		).not.toContain("SECRET")
		const clock = new PairingService({
			policy: env.policy,
			sessions: env.sessions,
			monotonicNow: () => NaN,
		})
		expect(
			clock.issue(
				env.request("/api/access/pairing-codes", [
					"Authorization",
					`Bearer ${env.token}`,
				]),
			),
		).toMatchObject({ status: 503 })
		expect(
			await clock.redeem(env.request(), { code: "ZZZZZ-ZZZZZ" }),
		).toMatchObject({ status: 503 })
	})
})
