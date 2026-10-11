import { describe, expect, it } from "vitest"
import { decideRawListeners } from "../../../src/access/raw-listener-policy.js"

const listeners = {
	audio: { enabled: true },
	relay: { enabled: false, host: "0.0.0.0" },
}

describe("raw listener exposure decisions", () => {
	it("preserves legacy listener choices without opening a socket", () => {
		expect(decideRawListeners({ mode: "legacy", ...listeners })).toEqual({
			audio: { kind: "legacy", enabled: true },
			relay: { kind: "legacy", enabled: false, host: "0.0.0.0" },
		})
	})

	it("disables both raw protocols in protected mode regardless of legacy enable flags", () => {
		expect(
			decideRawListeners({
				mode: "protected",
				audio: { enabled: true },
				relay: { enabled: true, host: "127.0.0.1" },
			}),
		).toEqual({ audio: { kind: "disabled" }, relay: { kind: "disabled" } })
	})

	it.each(["127.0.0.1", "::1"])(
		"a literal %s exception remains pending real boundary verification",
		host => {
			const result = decideRawListeners({
				mode: "protected",
				...listeners,
				exceptions: { audio: { host }, relay: { host } },
			})
			expect(result.audio).toEqual({
				kind: "needs-verification",
				host,
				protocol: "unauthenticated",
			})
			expect(result.relay).toEqual({ kind: "disabled" })
			expect("enabled" in result.audio).toBe(false)
			expect(Object.isFrozen(result)).toBe(true)
			expect(Object.isFrozen(result.audio)).toBe(true)
		},
	)

	it.each([
		"localhost",
		"127.1",
		"127.0.0.2",
		"0.0.0.0",
		"::",
		"[::1]",
		"::ffff:127.0.0.1",
		"192.168.1.2",
		"127.0.0.1:8080",
		" 127.0.0.1",
	])("rejects unverified exception host %s", host => {
		expect(() =>
			decideRawListeners({
				mode: "protected",
				...listeners,
				exceptions: { audio: { host } },
			}),
		).toThrow("Invalid raw listener policy")
	})

	it("accepts no YAML boolean or network assertion as verification", () => {
		for (const exception of [
			true,
			{ host: "127.0.0.1", verified: true },
			{ host: "127.0.0.1", docker: true },
			{ host: "127.0.0.1", readOnly: true },
		])
			expect(() =>
				decideRawListeners({
					mode: "protected",
					...listeners,
					exceptions: { relay: exception },
				}),
			).toThrow("Invalid raw listener policy")
		expect(() => decideRawListeners({ mode: "typo", ...listeners })).toThrow(
			"Invalid raw listener policy",
		)
	})
})
