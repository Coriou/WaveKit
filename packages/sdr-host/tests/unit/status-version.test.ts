import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { SDR_HOST_VERSION } from "../../src/api/routes/status.js"

describe("SDR host status version", () => {
	it("matches the package.json version", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { version: string }
		expect(SDR_HOST_VERSION).toBe(manifest.version)
	})
})
