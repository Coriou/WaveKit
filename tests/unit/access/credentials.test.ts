import fc from "fast-check"
import {
	digestMachineToken,
	generateMachineToken,
	isCanonicalToken,
	verifyMachineToken,
} from "../../../src/access/credentials.js"
import { WaveKitError } from "../../../src/utils/errors.js"

describe("machine credentials", () => {
	it("uses 32 random bytes and verifies their SHA-256 digest", () => {
		// Feature: core-access-policy, Property 2: Credential canonicality
		// Validates: Requirements 3.1
		fc.assert(
			fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), bytes => {
				const token = generateMachineToken(size => {
					expect(size).toBe(32)
					return bytes
				})
				expect(isCanonicalToken(token)).toBe(true)
				const digest = digestMachineToken(token)
				expect(digest).toHaveLength(32)
				expect(verifyMachineToken(token, digest)).toBe(true)
				expect(verifyMachineToken(token, Buffer.alloc(31))).toBe(false)
			}),
			{ numRuns: 100 },
		)
	})

	it("rejects distinct secrets, padding and noncanonical last bits", () => {
		const token = generateMachineToken(() => Buffer.alloc(32))
		const other = generateMachineToken(() => Buffer.alloc(32, 1))
		const digest = digestMachineToken(token)
		for (const invalid of [
			other,
			`${token}=`,
			`${token.slice(0, -1)}B`,
			` ${token}`,
			"x".repeat(8192),
		]) {
			expect(verifyMachineToken(invalid, digest)).toBe(false)
		}
	})

	it("reports malformed credentials and random failures without retaining input", () => {
		const secret = "private-input-must-never-appear"
		for (const operation of [
			() => digestMachineToken(secret),
			() =>
				generateMachineToken(() => {
					throw new Error(secret)
				}),
			() => generateMachineToken(() => Buffer.alloc(31)),
		]) {
			try {
				operation()
				assert.fail("Expected a safe credential error")
			} catch (error) {
				expect(error).toBeInstanceOf(WaveKitError)
				expect(String(error)).not.toContain(secret)
				expect(JSON.stringify(error)).not.toContain(secret)
				expect((error as WaveKitError).cause).toBeUndefined()
			}
		}
	})
})
import { assert, describe, expect, it } from "vitest"
