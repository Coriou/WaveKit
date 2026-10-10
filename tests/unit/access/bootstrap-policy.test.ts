import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	accessCapabilities,
	resolveAccessBootstrap,
} from "../../../src/access/bootstrap-policy.js"

const protectedSettings = {
	mode: "protected",
	listenerScheme: "http",
	allowedAuthorities: ["RECEIVER.lan:9000"],
	allowedOrigins: ["http://receiver.lan:9000"],
	externalAudioOrigins: ["http://receiver.lan:8081"],
}

describe("unmounted public access bootstrap policy", () => {
	it("defaults only absent configuration to compatible legacy behavior", () => {
		expect(resolveAccessBootstrap()).toEqual({ mode: "legacy" })
		expect(resolveAccessBootstrap({})).toEqual({ mode: "legacy" })
		expect(resolveAccessBootstrap({ mode: "legacy" })).toEqual({
			mode: "legacy",
		})
		for (const input of [null, false, "protected", { mode: "typo" }])
			expect(() => resolveAccessBootstrap(input)).toThrow(
				"Invalid access configuration",
			)
	})

	it("normalizes exact trust without aliases and returns independent immutable settings", () => {
		const input = {
			...protectedSettings,
			allowedAuthorities: [
				"RECEIVER.lan:9000",
				"receiver.lan:9000",
				"[0:0:0:0:0:0:0:1]",
			],
			allowedOrigins: ["http://RECEIVER.lan:80", "http://receiver.lan"],
		}
		const result = resolveAccessBootstrap(input)
		expect(result).toEqual({
			...protectedSettings,
			allowedAuthorities: ["receiver.lan:9000", "[::1]:80"],
			allowedOrigins: ["http://receiver.lan"],
		})
		input.allowedAuthorities.push("evil.lan")
		if (result.mode !== "protected") throw new Error("Expected protected plan")
		expect(result.allowedAuthorities).toHaveLength(2)
		expect(Object.isFrozen(result)).toBe(true)
		expect(Object.isFrozen(result.allowedAuthorities)).toBe(true)
	})

	it.each([
		{ allowedAuthorities: [] },
		{ allowedAuthorities: ["*.lan"] },
		{ allowedAuthorities: ["0.0.0.0:9000"] },
		{ allowedAuthorities: ["[::]:9000"] },
		{ allowedAuthorities: ["receiver.lan/path"] },
		{ allowedAuthorities: Array<string>(65).fill("receiver.lan") },
		{ allowedOrigins: ["null"] },
		{ allowedOrigins: ["http://0.0.0.0:9000"] },
		{ allowedOrigins: ["http://receiver.lan/"] },
		{ allowedOrigins: Array<string>(65).fill("http://receiver.lan") },
		{ externalAudioOrigins: ["http://user:password@receiver.lan:8081"] },
		{ externalAudioOrigins: ["http://receiver.lan:8081/stream?token=secret"] },
		{
			externalAudioOrigins: Array<string>(17).fill("http://receiver.lan:8081"),
		},
		{ listenerScheme: "ws" },
	])("rejects unsafe protected settings without falling back: %j", changes => {
		expect(() =>
			resolveAccessBootstrap({ ...protectedSettings, ...changes }),
		).toThrow("Invalid access configuration")
	})

	it("rejects secret/private fields and never repeats their contents in errors", () => {
		for (const field of [
			"machineToken",
			"machineSecretDigest",
			"sessions",
			"privatePath",
		])
			for (const base of [protectedSettings, { mode: "legacy" }]) {
				let caught: unknown
				try {
					resolveAccessBootstrap({ ...base, [field]: "PRIVATE-secret-path" })
				} catch (error) {
					caught = error
				}
				expect(caught).toMatchObject({
					code: "ACCESS_CONFIG_INVALID",
					cause: undefined,
				})
				expect(String(caught)).not.toContain("PRIVATE")
				expect(JSON.stringify(caught)).not.toContain("PRIVATE")
			}
	})

	it("capabilities depend on mounted services and browser origins, never config alone", () => {
		const plan = resolveAccessBootstrap(protectedSettings)
		expect(
			accessCapabilities(plan, { sessions: false, pairing: true }),
		).toEqual({
			mode: "protected",
			sessionAvailable: false,
			pairingAvailable: false,
		})
		expect(accessCapabilities(plan, { sessions: true, pairing: true })).toEqual(
			{ mode: "protected", sessionAvailable: true, pairingAvailable: true },
		)
		expect(
			accessCapabilities(plan, { sessions: true, pairing: false })
				.pairingAvailable,
		).toBe(false)
		expect(
			accessCapabilities(resolveAccessBootstrap(), {
				sessions: true,
				pairing: true,
			}),
		).toEqual({
			mode: "legacy",
			sessionAvailable: false,
			pairingAvailable: false,
		})
		expect(
			accessCapabilities(
				resolveAccessBootstrap({ ...protectedSettings, allowedOrigins: [] }),
				{ sessions: true, pairing: true },
			).pairingAvailable,
		).toBe(false)
		expect(() =>
			accessCapabilities(plan, {
				sessions: true,
				pairing: true,
				token: "SECRET",
			}),
		).toThrow("Invalid access configuration")
	})

	// Feature: core-access-policy, Property 1: Exact trust boundary
	// Validates: Requirements 2.1, 2.2.
	it("preserves each selected effective port without expanding trust", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 65535 }), port => {
				const plan = resolveAccessBootstrap({
					...protectedSettings,
					allowedAuthorities: [`receiver.lan:${port}`],
				})
				if (plan.mode !== "protected")
					throw new Error("Expected protected plan")
				expect(plan.allowedAuthorities).toEqual([`receiver.lan:${port}`])
			}),
			{ numRuns: 100 },
		)
	})
})
