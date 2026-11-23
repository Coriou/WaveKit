import { describe, expect, it, vi } from "vitest"
import { formatStartupFailure } from "../../../src/utils/startup-failure.js"
import { ZodError } from "zod"
import {
	ConfigValidationError,
	WaveKitError,
} from "../../../src/utils/errors.js"
import {
	channelInputModeFrom,
	unknownChannelInputModeError,
} from "../../../src/decoders/channel-input-mode.js"

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

	it("an unknown WAVEKIT_CHANNEL_INPUT names the variable and the accepted values, never the value", () => {
		let thrown: unknown
		try {
			channelInputModeFrom("secret-RELAY /private/path")
		} catch (error: unknown) {
			thrown = error
		}
		const text = formatStartupFailure(thrown)
		expect(text).toBe(
			"WaveKit startup failed: ConfigValidationError [CONFIG_VALIDATION_ERROR]: startup could not complete\n" +
				"  - WAVEKIT_CHANNEL_INPUT: Invalid value. Expected one of: direct, relay\n",
		)
		expect(text).not.toMatch(/secret|private/)
	})

	it("other config issues, and look-alikes with another message or a forged class, add no line", () => {
		const custom = (path: (string | number)[], message: string) =>
			new ConfigValidationError(
				new ZodError([{ code: "custom", path, message }]),
			)
		for (const error of [
			custom(["sources", 0, "host"], "secret host 10.0.0.1"),
			custom(["WAVEKIT_CHANNEL_INPUT"], "secret value given: Relay"),
			custom(["WAVEKIT_CHANNEL_INPUT", "x"], "secret"),
			custom(["secret\nWAVEKIT_CHANNEL_INPUT"], "secret"),
			{
				zodError: unknownChannelInputModeError().zodError,
				code: "CONFIG_VALIDATION_ERROR",
			},
		]) {
			const text = formatStartupFailure(error)
			expect(text.trim().split("\n")).toHaveLength(1)
			expect(text).not.toMatch(/secret|10\.0\.0\.1|WAVEKIT_CHANNEL_INPUT/)
		}
		// Repeated issues print once; a getter on the issues is never invoked.
		const twice = unknownChannelInputModeError()
		const issue = twice.zodError.issues[0]!
		twice.zodError.issues.push(issue)
		expect(formatStartupFailure(twice).trim().split("\n")).toHaveLength(2)
		const getter = vi.fn(() => [issue])
		const guarded = unknownChannelInputModeError()
		Object.defineProperty(guarded.zodError, "issues", { get: getter })
		expect(formatStartupFailure(guarded).trim().split("\n")).toHaveLength(1)
		expect(getter).not.toHaveBeenCalled()
	})
})
