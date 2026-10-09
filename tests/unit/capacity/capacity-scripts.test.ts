import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadConfig } from "../../../src/config.js"

it("validates the capacity script channelizer extensions", () => {
	const result = spawnSync(
		"python3",
		[resolve("tests/unit/capacity/test_capacity_channelizer.py")],
		{
			encoding: "utf8",
			timeout: 30000,
		},
	)
	expect(result.status, result.stdout + result.stderr).toBe(0)
}, 35000)

describe("run_capacity.py write_config", () => {
	const dirs: string[] = []
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true })
	})

	function generate(channelizer: boolean): string {
		const dir = mkdtempSync(join(tmpdir(), "wkcap-config-"))
		dirs.push(dir)
		const path = join(dir, "config.yaml")
		const script = [
			"import importlib.util, json, pathlib, sys",
			"spec = importlib.util.spec_from_file_location('run_capacity', sys.argv[1])",
			"run = importlib.util.module_from_spec(spec); spec.loader.exec_module(run)",
			"decoders = [(f'ais-catcher-ch{k}', 'ais-catcher', {'channelHz': hz})",
			"            for k, hz in enumerate(run.placements(162000000, 2048000, 0.8, 4, 'spread', 162000000, 384000))]",
			"run.write_config(pathlib.Path(sys.argv[2]), 2048000, decoders, 162000000, channelizer=sys.argv[3] == 'on')",
		].join("\n")
		const result = spawnSync(
			"python3",
			[
				"-c",
				script,
				resolve("scripts/capacity/run_capacity.py"),
				path,
				channelizer ? "on" : "off",
			],
			{ encoding: "utf8", timeout: 30000 },
		)
		expect(result.status, result.stdout + result.stderr).toBe(0)
		return path
	}

	it("generates a config the real ConfigSchema accepts, channelizer on", () => {
		const config = loadConfig(generate(true))
		expect(config.channelizer.enabled).toBe(true)
		expect(config.health?.bandSuspension).toBe(false)
		expect(config.digitalVoice?.enabled).toBe(false)
		expect(config.liveDemod?.enabled).toBe(false)
		expect(config.stateDir).toBe("/tmp/wkcap-state")
		expect(config.decoders).toHaveLength(4)
		for (const decoder of config.decoders) {
			expect(decoder.useChannelizer).toBe(true)
			expect(Number.isInteger(decoder.options["channelHz"])).toBe(true)
		}
	})

	it("generates a config the real ConfigSchema accepts, channelizer off", () => {
		const config = loadConfig(generate(false))
		expect(config.channelizer.enabled).toBe(false)
		expect(config.health?.bandSuspension).toBe(false)
		expect(config.decoders.every(d => !d.useChannelizer)).toBe(true)
	})
})
