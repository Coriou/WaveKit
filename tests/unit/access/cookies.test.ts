import { describe, expect, it } from "vitest"
import {
	flowSuccess,
	SessionCookies,
	serializeSessionCookie,
} from "../../../src/access/cookies.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"

async function cookies(scheme: "http" | "https", name = "wavekit_session") {
	const token = generateMachineToken(() => Buffer.alloc(32, 7))
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: () => Promise.resolve(),
	})
	return {
		token,
		cookies: new SessionCookies(
			new AccessPolicy({
				listenerScheme: scheme,
				allowedAuthorities: ["receiver.lan:9000"],
				allowedOrigins: [],
				sessionCookieName: name,
				machineSecretDigest: digest,
				sessions,
			}),
		),
	}
}

describe("private host-only cookie transport directives", () => {
	it.each(["http", "https"] as const)(
		"uses trusted %s listener configuration and matching clear scope",
		async scheme => {
			const { cookies: helper, token } = await cookies(scheme)
			const issued = helper.issue(token, 30 * 24 * 60 * 60)
			expect(issued).toMatchObject({
				name: "wavekit_session",
				path: "/",
				httpOnly: true,
				sameSite: "strict",
				secure: scheme === "https",
			})
			expect(issued.value).toBe(token)
			const header = serializeSessionCookie(issued)
			expect(header).toBe(
				`wavekit_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${scheme === "https" ? "; Secure" : ""}`,
			)
			expect(header).not.toContain("Domain")
			expect(serializeSessionCookie(helper.clear())).toBe(
				`wavekit_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${scheme === "https" ? "; Secure" : ""}`,
			)
		},
	)

	it("keeps cookie credentials out of accidental JSON while retaining explicit transport access", async () => {
		const { cookies: helper, token } = await cookies("http")
		const directive = helper.issue(token, 100)
		const result = flowSuccess(
			{ deviceId: "device-public" },
			{ "Cache-Control": "no-store" },
			directive,
		)
		expect(JSON.stringify(directive)).not.toContain(token)
		expect(JSON.stringify(result)).not.toContain(token)
		expect(JSON.stringify(result)).not.toContain('"cookie"')
		expect(result.kind).toBe("success")
		if (result.kind === "success") expect(result.cookie?.value).toBe(token)
		expect(Object.isFrozen(directive)).toBe(true)
	})

	it("rejects malformed credentials and unbounded cookie lifetimes", async () => {
		const { cookies: helper, token } = await cookies("http")
		for (const value of [
			"",
			"secret; Domain=evil.lan",
			"B".repeat(43),
			token + "=",
		])
			expect(() => helper.issue(value, 60)).toThrow("Invalid session cookie")
		for (const ttl of [0, -1, 1.5, NaN, Infinity, 2592001])
			expect(() => helper.issue(token, ttl)).toThrow("Invalid session cookie")
	})

	it("enforces browser __Host- semantics rather than silently emitting an unusable cookie", async () => {
		await expect(cookies("http", "__Host-wavekit")).rejects.toThrow(
			"Invalid cookie configuration",
		)
		const { cookies: helper, token } = await cookies("https", "__Host-wavekit")
		expect(serializeSessionCookie(helper.issue(token, 60))).toContain(
			"; Secure",
		)
	})
})
