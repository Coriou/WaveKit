/**
 * The kill switch of the connect-time tuning write: `tuner.writeDeclaredTuningOnConnect`,
 * default true, settable from the environment.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ConfigSchema, loadConfig } from "../../../src/config.js"

describe("tuner.writeDeclaredTuningOnConnect", () => {
	let tempDir: string
	let originalEnv: NodeJS.ProcessEnv

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wavekit-tuner-connect-"))
		originalEnv = { ...process.env }
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
		process.env = originalEnv
	})

	it("defaults to true", () => {
		expect(ConfigSchema.parse({}).tuner.writeDeclaredTuningOnConnect).toBe(true)
	})

	it("WAVEKIT_TUNER__WRITE_DECLARED_TUNING_ON_CONNECT=false parses to false", () => {
		const configPath = path.join(tempDir, "tuner.yaml")
		fs.writeFileSync(configPath, "sources: []\n")
		process.env["WAVEKIT_TUNER__WRITE_DECLARED_TUNING_ON_CONNECT"] = "false"
		const config = loadConfig(configPath)
		expect(config.tuner.writeDeclaredTuningOnConnect).toBe(false)
		expect(config.tuner.reconnectPolicy).toBe("restore")
	})

	it("YAML false parses to false", () => {
		const configPath = path.join(tempDir, "tuner.yaml")
		fs.writeFileSync(
			configPath,
			"sources: []\ntuner:\n  writeDeclaredTuningOnConnect: false\n",
		)
		delete process.env["WAVEKIT_TUNER__WRITE_DECLARED_TUNING_ON_CONNECT"]
		expect(loadConfig(configPath).tuner.writeDeclaredTuningOnConnect).toBe(
			false,
		)
	})
})
