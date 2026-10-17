import fc from "fast-check"
import {
	ACCESS_DEVICE_KINDS,
	accessPairRequestSchema,
} from "@wavekit/api-types"
import { describe, expect, it, vi } from "vitest"
import type { AccessFlowResult } from "../../../src/access/cookies.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { serializeSessionCookie } from "../../../src/access/cookies.js"
import { PairingService } from "../../../src/access/pairing.js"
import type { IssuedPairingCode } from "../../../src/access/pairing.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type { AccessRequest } from "../../../src/access/types.js"

const origin = "http://receiver.lan:9000"

async function setup() {
	let elapsed = 0
	let sessionRandom = 10
	let codeRandom = 10
	let address = 0
	const token = generateMachineToken(() => Buffer.alloc(32, 7))
	const digest = digestMachineToken(token)
	const persist = vi.fn(() => Promise.resolve())
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist,
		epochNow: () => 1_000_000,
		monotonicNow: () => elapsed,
		random: size => Buffer.alloc(size, ++sessionRandom % 256),
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
		random: size => Buffer.alloc(size, codeRandom++ % 256),
	})
	const request = (path: string, headers: string[] = []): AccessRequest => ({
		method: "POST",
		rawTarget: path,
		rawHeaders: ["Host", "receiver.lan:9000", "Origin", origin, ...headers],
		transport: "http",
		surface: "api",
		// A fresh address per call keeps the per-address limit out of the way.
		remoteAddress: `10.0.0.${++address % 100}`,
	})
	const issue = (): string => {
		const result: AccessFlowResult<IssuedPairingCode> = service.issue(
			request("/api/access/pairing-codes", [
				"Authorization",
				`Bearer ${token}`,
			]),
		)
		if (result.kind !== "success") throw new Error("Expected pairing code")
		return result.body.code
	}
	const pair = (body: unknown) =>
		service.redeem(request("/api/access/pair"), body)
	return {
		sessions,
		persist,
		issue,
		pair,
		advance: (ms: number) => {
			elapsed += ms
		},
	}
}

const malformed = {
	kind: "deny",
	status: 400,
	body: { code: "MALFORMED_REQUEST" },
	headers: {
		"Cache-Control": "no-store",
		Vary: "Origin",
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Credentials": "true",
	},
}

describe("pair body name and kind (WG9 req 1.5)", () => {
	it("keeps the golden 201 and 400 without name/kind", async () => {
		const env = await setup()
		const code = env.issue()
		expect(await env.pair({ code, extra: 1 })).toStrictEqual(malformed)
		const paired = await env.pair({ code })
		expect(JSON.parse(JSON.stringify(paired))).toStrictEqual({
			kind: "success",
			status: 201,
			body: {
				deviceId: "device_DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0",
				expiresAt: 2_593_000_000,
				csrfToken: "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw",
			},
			headers: malformed.headers,
		})
		if (paired.kind !== "success") throw new Error("Expected success")
		expect(Object.keys(paired.body)).toStrictEqual([
			"deviceId",
			"expiresAt",
			"csrfToken",
		])
		expect(paired.cookie).toBeDefined()
		if (!paired.cookie) throw new Error("Expected cookie")
		expect(serializeSessionCookie(paired.cookie)).toMatch(
			/^wavekit_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/,
		)
		expect(env.sessions.snapshotRememberedDevices()[0]).toMatchObject({
			name: null,
			kind: null,
		})
	})

	it("commits name and kind in the single create write", async () => {
		const env = await setup()
		const paired = await env.pair({
			code: env.issue(),
			name: "Kitchen tablet",
			kind: "tablet",
		})
		expect(paired).toMatchObject({ kind: "success", status: 201 })
		if (paired.kind !== "success") throw new Error("Expected success")
		expect(Object.keys(paired.body)).toStrictEqual([
			"deviceId",
			"expiresAt",
			"csrfToken",
		])
		expect(env.persist).toHaveBeenCalledOnce()
		expect(
			env.sessions.snapshotActiveDevices(paired.body.deviceId),
		).toMatchObject({
			kind: "active",
			devices: [
				{
					deviceId: paired.body.deviceId,
					name: "Kitchen tablet",
					kind: "tablet",
				},
			],
		})
	})

	it("bounds the name and refuses hostile bodies without consuming the code", async () => {
		const env = await setup()
		const code = env.issue()
		const refused: unknown[] = [
			{ code, name: "a".repeat(65) },
			{ code, name: "é".repeat(65) },
			{ code, name: "€".repeat(43) }, // 129 bytes, 43 chars
			{ code, name: "evil‮exe" },
			{ code, name: "a\u0000b" },
			{ code, name: "a\u0085b" },
			{ code, name: "a\u001bb" },
			{ code, name: "a\ud800b" }, // lone high surrogate
			{ code, name: "\udc00" }, // lone low surrogate
			{ code, name: " padded" },
			{ code, name: "padded " },
			{ code, name: "" },
			{ code, name: 5 },
			{ code, name: null },
			{ code, name: ["x"] },
			{ code, kind: "toaster" },
			{ code, kind: null },
			{ code, kind: 1 },
			JSON.parse(`{"code":"${code}","__proto__":{"name":"x"}}`),
			{ code, constructor: "x" },
			{ code, prototype: {} },
			null,
			"code",
			[code],
		]
		for (const body of refused)
			expect(await env.pair(body)).toStrictEqual(malformed)
		expect(env.persist).not.toHaveBeenCalled()
		const ok = await env.pair({ code, name: "a".repeat(64), kind: "phone" })
		expect(ok).toMatchObject({ kind: "success", status: 201 })
	})

	it("accepts a 128-byte name and stores it", async () => {
		const env = await setup()
		const name = "€".repeat(42) + "ab" // 126 + 2 = 128 bytes
		expect(new TextEncoder().encode(name).length).toBe(128)
		const paired = await env.pair({ code: env.issue(), name })
		if (paired.kind !== "success") throw new Error("Expected success")
		expect(env.sessions.snapshotRememberedDevices()[0]?.name).toBe(name)
		expect(paired.body).not.toHaveProperty("name")
	})

	it("store create refuses an invalid label directly", async () => {
		const env = await setup()
		await expect(env.sessions.create({ name: " x" })).rejects.toThrow()
		expect(env.persist).not.toHaveBeenCalled()
	})

	it("store create writes the label it validated even if the caller mutates it", async () => {
		const env = await setup()
		const options: { name?: string } = { name: "valid" }
		const pending = env.sessions.create(options)
		options.name = " padded"
		expect((await pending).kind).toBe("created")
		expect(env.sessions.snapshotRememberedDevices()[0]?.name).toBe("valid")
	})

	// Feature: web-gaps-9, Property 2: Pair body fails closed
	// Validates: Requirements 1.5
	it("accepts exactly what accessPairRequestSchema accepts; refusals leave the code usable", async () => {
		const env = await setup()
		const name = fc.oneof(
			fc.string({ minLength: 1, maxLength: 70 }),
			fc.constantFrom(" x", "x‮", "\u0007", "", "ok"),
			fc.integer(),
			fc.constant(null),
		)
		const kind = fc.oneof(
			fc.constantFrom(...ACCESS_DEVICE_KINDS),
			fc.constantFrom("toaster", "", "BROWSER"),
			fc.integer(),
		)
		const extra = fc.constantFrom("extra", "__proto__", "constructor", "id")
		await fc.assert(
			fc.asyncProperty(
				fc.option(name, { nil: undefined }),
				fc.option(kind, { nil: undefined }),
				fc.option(extra, { nil: undefined }),
				async (n, k, x) => {
					const code = env.issue()
					const body: Record<string, unknown> = { code }
					if (n !== undefined) body["name"] = n
					if (k !== undefined) body["kind"] = k
					if (x !== undefined)
						Object.defineProperty(body, x, {
							value: 1,
							enumerable: true,
							writable: true,
							configurable: true,
						})
					const writes = env.persist.mock.calls.length
					const result = await env.pair(body)
					if (accessPairRequestSchema.safeParse(body).success) {
						expect(result).toMatchObject({ kind: "success", status: 201 })
						if (result.kind !== "success") return
						const devices = env.sessions.snapshotActiveDevices(
							result.body.deviceId,
						)
						expect(devices).toMatchObject({
							kind: "active",
							devices: expect.arrayContaining([
								expect.objectContaining({
									deviceId: result.body.deviceId,
									name: n ?? null,
									kind: k ?? null,
								}),
							]) as unknown,
						})
						await env.sessions.revoke(result.body.deviceId)
					} else {
						expect(result).toStrictEqual(malformed)
						expect(env.persist.mock.calls.length).toBe(writes)
						const retried = await env.pair({ code })
						expect(retried).toMatchObject({ status: 201 })
						if (retried.kind === "success")
							await env.sessions.revoke(retried.body.deviceId)
					}
					env.advance(61_000)
				},
			),
			{ numRuns: 100 },
		)
	}, 20_000)
})
