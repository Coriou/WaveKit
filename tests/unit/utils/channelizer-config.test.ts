import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
	ChannelizerConfigSchema,
	ConfigSchema,
	DecoderConfigSchema,
	loadConfig,
} from "../../../src/config.js"

describe("channelizer config (addendum §6, §7)", () => {
	let tempDir: string
	let originalEnv: NodeJS.ProcessEnv

	beforeEach(() => {
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "wavekit-chan-config-test-"),
		)
		originalEnv = { ...process.env }
	})

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true })
		}
		process.env = originalEnv
	})

	it("defaults off with the documented budgets", () => {
		expect(ChannelizerConfigSchema.parse({})).toEqual({
			enabled: false,
			binaryPath: "wavekit-chan",
			socketDir: "/var/run/wavekit/chan",
			usableFraction: 0.8,
			channelQueueMs: 250,
			inputHighWaterMark: 262144,
			blockSamples: 16384,
		})
		expect(ConfigSchema.parse({}).channelizer.enabled).toBe(false)
		expect(
			DecoderConfigSchema.parse({
				id: "a",
				type: "x",
				enabled: true,
				options: {},
			}).useChannelizer,
		).toBe(false)
	})

	it("bounds every budget", () => {
		for (const bad of [
			{ usableFraction: 0.49 },
			{ usableFraction: 0.96 },
			{ channelQueueMs: 49 },
			{ channelQueueMs: 2001 },
			{ blockSamples: 100 },
			{ binaryPath: "" },
		]) {
			expect(ChannelizerConfigSchema.safeParse(bad).success).toBe(false)
		}
	})

	it("enables the channelizer from WAVEKIT_CHANNELIZER__ENABLED", () => {
		const configPath = path.join(tempDir, "chan.yaml")
		fs.writeFileSync(configPath, "sources: []\n")
		process.env["WAVEKIT_CHANNELIZER__ENABLED"] = "true"

		const config = loadConfig(configPath)
		expect(config.channelizer.enabled).toBe(true)
		expect(config.channelizer.usableFraction).toBe(0.8)
	})
})
