import { describe, expect, it } from "vitest"
import { formatStartupFailure } from "../../../src/utils/startup-failure.js"
import { WaveKitError } from "../../../src/utils/errors.js"

describe("startup failure", () => {
	it("contains the trusted error class and code without leaking the thrown message", () => {
		const error = new WaveKitError(
			"secret /private/data password=abc",
			"ACCESS_STORAGE_BUSY",
		)
		const line = formatStartupFailure(error)
		expect(line).toContain("WaveKitError [ACCESS_STORAGE_BUSY]")
		expect(line.trim().split("\n")).toHaveLength(1)
		expect(line).not.toMatch(/secret|private|password/)
	})
})
