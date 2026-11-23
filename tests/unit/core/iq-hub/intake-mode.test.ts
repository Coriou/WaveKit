import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
	DEFAULT_IQHUB_BIN,
	IQHUB_BIN_ENV,
	IQHUB_STATS_DIR_ENV,
	SOURCE_INTAKE_ENV,
	hubIntakeSettingsFrom,
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

	it("hub is selectable (opt-in)", () => {
		expect(sourceIntakeModeFrom("hub")).toBe("hub")
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

	it("SourceManager fails at startup with hub and no usable binary, naming WAVEKIT_IQHUB_BIN only", () => {
		const lines: string[] = []
		const log = pino(
			{ level: "debug" },
			{ write: (line: string) => void lines.push(line) },
		)
		vi.stubEnv(SOURCE_INTAKE_ENV, "hub")
		vi.stubEnv(IQHUB_BIN_ENV, "/nonexistent/secret-hub-path")
		let error: unknown
		try {
			new SourceManager(log)
		} catch (err: unknown) {
			error = err
		}
		expect(error).toBeInstanceOf(ConfigValidationError)
		const text = `${(error as Error).message} ${JSON.stringify((error as ConfigValidationError).zodError.issues)}`
		expect(text).toContain(IQHUB_BIN_ENV)
		expect(text).not.toContain("secret-hub-path")
		expect(lines.join("")).not.toContain("secret-hub-path")
		expect(lines.join("")).toContain(IQHUB_BIN_ENV)
	})

	it("m3: an unusable stats directory fails startup naming WAVEKIT_IQHUB_STATS_DIR, never the binary's variable or the value", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wk-hubbin-"))
		const bin = path.join(dir, "wavekit-iqhub")
		fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
		const lines: string[] = []
		const log = pino(
			{ level: "debug" },
			{ write: (line: string) => void lines.push(line) },
		)
		try {
			vi.stubEnv(SOURCE_INTAKE_ENV, "hub")
			vi.stubEnv(IQHUB_BIN_ENV, bin)
			vi.stubEnv(IQHUB_STATS_DIR_ENV, "/nonexistent/secret-stats-dir")
			expect(() => new SourceManager(log)).toThrow(ConfigValidationError)
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
		const errors = lines
			.map(line => JSON.parse(line) as { level: number; variable?: string })
			.filter(line => line.level >= 50)
		expect(errors).toHaveLength(1)
		expect(errors[0]?.variable).toBe(IQHUB_STATS_DIR_ENV)
		expect(lines.join("")).not.toContain("secret-stats-dir")
	})

	it("SourceManager starts in hub mode with an executable binary (no hub spawned before a dial)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wk-hubbin-"))
		const bin = path.join(dir, "wavekit-iqhub")
		fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
		try {
			vi.stubEnv(SOURCE_INTAKE_ENV, "hub")
			vi.stubEnv(IQHUB_BIN_ENV, bin)
			const manager = new SourceManager(pino({ level: "silent" }))
			await manager.disconnectAll()
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it("hub settings: the default path, a non-executable file, the stats directory", () => {
		const seen: string[] = []
		expect(
			hubIntakeSettingsFrom({}, file => {
				seen.push(file)
				return true
			}),
		).toEqual({ bin: DEFAULT_IQHUB_BIN, statsDir: null })
		expect(seen).toEqual([DEFAULT_IQHUB_BIN])
		let error: unknown
		try {
			hubIntakeSettingsFrom({}, () => false)
		} catch (err: unknown) {
			error = err
		}
		expect(error).toBeInstanceOf(ConfigValidationError)
		expect((error as Error).message).toContain(IQHUB_BIN_ENV)
		expect(
			hubIntakeSettingsFrom(
				{ [IQHUB_BIN_ENV]: "/x/hub", [IQHUB_STATS_DIR_ENV]: "/stats" },
				() => true,
				dir => dir === "/stats",
			),
		).toEqual({ bin: "/x/hub", statsDir: "/stats" })
		expect(() =>
			hubIntakeSettingsFrom(
				{ [IQHUB_STATS_DIR_ENV]: "/not-a-dir" },
				() => true,
				() => false,
			),
		).toThrow(ConfigValidationError)
	})

	it("SourceManager fails at startup with a bogus value, and keeps the socket path otherwise", () => {
		const log = pino({ level: "silent" })
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
