import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { APP_VERSION } from "../../../src/api/routes/health.js"

describe("APP_VERSION (WG7 10.4)", () => {
	it("is the root package.json version", () => {
		const pkg = JSON.parse(
			readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
		) as { version: string }
		expect(APP_VERSION).toBe(pkg.version)
	})

	it("comes from the build-time define, not a literal", () => {
		expect(typeof __WAVEKIT_VERSION__).toBe("string")
		expect(APP_VERSION).toBe(__WAVEKIT_VERSION__)
	})
})
