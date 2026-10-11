import { describe, expect, it } from "vitest"
import {
	accessLogMetadata,
	accessRequestLogLabel,
	childAccessEnvironment,
} from "../../../src/access/runtime-hygiene.js"

describe("access runtime hygiene projections", () => {
	it("strips the access namespace without changing unrelated or CSDR settings", () => {
		const env = {
			WAVEKIT_ACCESS_TOKEN: "secret",
			WAVEKIT_ACCESS__TOKEN: "secret",
			WAVEKIT_ACCESS_CREDENTIAL_FILE: "/private/path",
			WAVEKIT_ACCESS: "secret",
			wavekit_access_token: "secret",
			WAVEKIT_ACCESSORY: "unrelated",
			CSDR_FIXED_BUFSIZE: "1024",
			PATH: "/bin",
			OTHER_TOKEN: "other-tool-value",
			EMPTY: "",
			ABSENT: undefined,
		}
		const child = childAccessEnvironment(env)
		expect(child).toEqual({
			WAVEKIT_ACCESSORY: "unrelated",
			CSDR_FIXED_BUFSIZE: "1024",
			PATH: "/bin",
			OTHER_TOKEN: "other-tool-value",
			EMPTY: "",
			ABSENT: undefined,
		})
		child["PATH"] = "changed"
		expect(env.PATH).toBe("/bin")
		expect(env.WAVEKIT_ACCESS_TOKEN).toBe("secret")
	})

	it("returns only enumerated error metadata and handles hostile unknown errors", () => {
		const privateError = {
			code: "ACCESS_STORAGE_INVALID",
			message: "secret",
			cause: new Error("path-secret"),
			config: { token: "secret" },
		}
		expect(accessLogMetadata(privateError)).toEqual({
			code: "ACCESS_STORAGE_INVALID",
			category: "storage",
		})
		const hostile = Object.defineProperty({}, "code", {
			get: () => {
				throw new Error("SECRET")
			},
		})
		for (const error of [
			"secret",
			null,
			new Error("secret"),
			{ code: "SECRET", message: "SECRET" },
			hostile,
		]) {
			expect(accessLogMetadata(error)).toEqual({
				code: "ACCESS_UNAVAILABLE",
				category: "unavailable",
			})
			expect(JSON.stringify(accessLogMetadata(error))).not.toContain("secret")
		}
		expect(Object.isFrozen(accessLogMetadata(privateError))).toBe(true)
		for (const code of ["SESSION_CAPACITY", "ACCESS_CAPACITY"])
			expect(accessLogMetadata({ code })).toEqual({ code, category: "capacity" })
	})

	it("logs trusted templates or a constant, never URL fallback data", () => {
		expect(accessRequestLogLabel("/api/recordings/:id")).toBe(
			"/api/recordings/:id",
		)
		expect(accessRequestLogLabel("/api/*")).toBe("/api/*")
		for (const input of [
			undefined,
			null,
			"",
			"/api?token=SECRET",
			"http://host/SECRET",
			"/api/%53ECRET",
			"/api\nSECRET",
			"/" + "a".repeat(513),
			{ url: "/SECRET" },
		])
			expect(accessRequestLogLabel(input)).toBe("[unmatched route]")
	})
})
