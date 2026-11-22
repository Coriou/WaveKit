import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	SOURCE_INTAKE_ENV,
	processSourceIntakeMode,
	resetProcessSourceIntakeModeForTests,
	sourceIntakeModeFrom,
} from "../../../../src/core/iq-hub/intake-mode.js"
import { SourceManager } from "../../../../src/core/source-manager.js"
import { ConfigValidationError } from "../../../../src/utils/errors.js"

afterEach(() => {
	vi.unstubAllEnvs()
	resetProcessSourceIntakeModeForTests()
})

describe("WAVEKIT_SOURCE_INTAKE (B1)", () => {
	it("unset, empty and socket read as today's socket path", () => {
		expect(sourceIntakeModeFrom(undefined)).toBe("socket")
		expect(sourceIntakeModeFrom("")).toBe("socket")
		expect(sourceIntakeModeFrom("socket")).toBe("socket")
	})

	it("hub is refused: hub intake is not yet available", () => {
		let error: unknown
		try {
			sourceIntakeModeFrom("hub")
		} catch (err: unknown) {
			error = err
		}
		expect(error).toBeInstanceOf(ConfigValidationError)
		expect((error as Error).message).toContain(SOURCE_INTAKE_ENV)
		expect((error as Error).message).toContain("not yet available")
	})

	it("any other value names the accepted values and never echoes the value", () => {
		for (const raw of ["Hub", "SOCKET", "tcp", "secret-token-value"]) {
			let error: unknown
			try {
				sourceIntakeModeFrom(raw)
			} catch (err: unknown) {
				error = err
			}
			expect(error).toBeInstanceOf(ConfigValidationError)
			const text = `${(error as Error).message} ${JSON.stringify((error as ConfigValidationError).zodError.issues)}`
			expect(text).toContain("socket, hub")
			expect(text).not.toContain(raw)
		}
	})

	it("the process mode logs only the variable and the accepted values on refusal, and caches nothing then", () => {
		const lines: string[] = []
		const log = pino(
			{ level: "debug" },
			{ write: (line: string) => void lines.push(line) },
		)
		expect(() =>
			processSourceIntakeMode(log, { [SOURCE_INTAKE_ENV]: "bogus-value" }),
		).toThrow(ConfigValidationError)
		expect(lines.join("")).not.toContain("bogus-value")
		expect(processSourceIntakeMode(log, {})).toBe("socket")
		expect(processSourceIntakeMode(log, { [SOURCE_INTAKE_ENV]: "hub" })).toBe(
			"socket",
		)
	})

	it("SourceManager fails at startup with hub or a bogus value, and keeps the socket path otherwise", () => {
		const log = pino({ level: "silent" })
		vi.stubEnv(SOURCE_INTAKE_ENV, "hub")
		expect(() => new SourceManager(log)).toThrow(ConfigValidationError)
		resetProcessSourceIntakeModeForTests()
		vi.stubEnv(SOURCE_INTAKE_ENV, "bogus")
		expect(() => new SourceManager(log)).toThrow(ConfigValidationError)
		resetProcessSourceIntakeModeForTests()
		vi.stubEnv(SOURCE_INTAKE_ENV, "socket")
		expect(() => new SourceManager(log)).not.toThrow()
		resetProcessSourceIntakeModeForTests()
		vi.stubEnv(SOURCE_INTAKE_ENV, "")
		expect(() => new SourceManager(log)).not.toThrow()
	})

	it("an injected intake does not read the variable", () => {
		vi.stubEnv(SOURCE_INTAKE_ENV, "hub")
		const intake = {
			create: vi.fn(),
			connect: vi.fn(),
			localPortOf: () => null,
			dispose: vi.fn(),
			disposeAll: () => Promise.resolve(),
		}
		expect(
			() => new SourceManager(pino({ level: "silent" }), { intake }),
		).not.toThrow()
	})
})
