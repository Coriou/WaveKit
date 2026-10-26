import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import setup from "../../global-setup.js"

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe.skipIf(process.env["WAVEKIT_TEST_TMP_GUARD"] === "0")(
	"per-run temporary root",
	() => {
		it("reaches workers and their child processes", () => {
			const root = process.env["WAVEKIT_TEST_TMP_ROOT"]
			expect(root).toBeTruthy()
			expect(tmpdir()).toBe(root)
			expect(process.env["TMP"]).toBe(root)
			expect(process.env["TEMP"]).toBe(root)
			expect(
				execFileSync(process.execPath, ["-p", "require('node:os').tmpdir()"], {
					encoding: "utf8",
				}).trim(),
			).toBe(root)
		})

		it("warns with leftover counts and prefixes, removes the root, and restores the environment", () => {
			vi.stubEnv("WAVEKIT_TEST_KEEP_TMP", "0")
			const previous = tmpdir()
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			const teardown = setup()!
			const root = tmpdir()
			try {
				mkdtempSync(join(root, "fixture-"))
				mkdtempSync(join(root, "fixture-"))
			} finally {
				teardown()
			}
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("2 entries left"),
			)
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("fixture-*: 2"))
			expect(existsSync(root)).toBe(false)
			expect(tmpdir()).toBe(previous)
		})

		it("can retain the root for measurement", () => {
			vi.stubEnv("WAVEKIT_TEST_KEEP_TMP", "1")
			const teardown = setup()!
			const root = tmpdir()
			try {
				teardown()
				expect(existsSync(root)).toBe(true)
			} finally {
				rmSync(root, { recursive: true, force: true })
			}
		})

		it("can bypass the guard to measure fixture cleanup", () => {
			vi.stubEnv("WAVEKIT_TEST_TMP_GUARD", "0")
			const previous = tmpdir()
			expect(setup()).toBeUndefined()
			expect(tmpdir()).toBe(previous)
		})
	},
)
