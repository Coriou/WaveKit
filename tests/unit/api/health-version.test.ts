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

	it("health.ts reads the define and holds no semver literal besides the unknown fallback", () => {
		const source = readFileSync(
			new URL("../../../src/api/routes/health.ts", import.meta.url),
			"utf8",
		)
		expect(source).toContain("__WAVEKIT_VERSION__")
		expect(source.match(/"\d+\.\d+\.\d+[^"]*"/g)).toEqual(
			["0.0.0-unknown"].map(v => `"${v}"`),
		)
	})

	it("the esbuild script and vitest config both define __WAVEKIT_VERSION__", () => {
		for (const file of ["scripts/build-file.mjs", "vitest.config.ts"]) {
			const text = readFileSync(
				new URL(`../../../${file}`, import.meta.url),
				"utf8",
			)
			expect(text).toContain("__WAVEKIT_VERSION__")
		}
	})
})
