import { describe, expect, it, vi } from "vitest"
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

	it.each(["lock-held", "invalid", "oversized", "permissions", "io"])(
		"includes safe reason %s",
		reason => {
			const error = Object.assign(
				new WaveKitError("secret", "BANDPLANS_UNAVAILABLE"),
				{ reason },
			)
			expect(formatStartupFailure(error)).toContain(
				`[BANDPLANS_UNAVAILABLE/${reason}]`,
			)
		},
	)
	it("omits unsafe reasons and does not invoke getters", () => {
		for (const reason of ["secret/path", "io\nsecret", undefined]) {
			expect(
				formatStartupFailure({ code: "BANDPLANS_UNAVAILABLE", reason }),
			).not.toContain("/")
		}
		const getter = vi.fn(() => "io")
		expect(
			formatStartupFailure(
				Object.defineProperty({}, "reason", { get: getter }),
			),
		).not.toContain("/io")
		expect(getter).not.toHaveBeenCalled()
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(formatStartupFailure(proxy)).toContain("UNKNOWN")
	})
})
