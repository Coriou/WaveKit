import { describe, expect, it, vi } from "vitest"
import { ConfigSchema } from "../../../src/config.js"
import type { SourceTunerConfig } from "../../../src/config.js"
import { applyConfiguredTuning } from "../../../src/core/tuner-config-gain.js"
import { readFileSync } from "node:fs"
import { parse } from "yaml"

const tuner: SourceTunerConfig = { gainMode: "manual", gainDb: 49.6 }

function run(
	sources: Array<{ id: string; type: string; tuner?: SourceTunerConfig }>,
) {
	const set = vi.fn()
	const warn = vi.fn()
	applyConfiguredTuning(sources, { setConfiguredTuning: set }, warn)
	return { set, warn }
}

describe("applyConfiguredTuning", () => {
	it("rtl_tcp with tuner is set", () => {
		const { set, warn } = run([{ id: "a", type: "rtl_tcp", tuner }])
		expect(set).toHaveBeenCalledExactlyOnceWith("a", tuner)
		expect(warn).not.toHaveBeenCalled()
	})

	it("rtl_tcp without tuner is not called at all", () => {
		const { set, warn } = run([{ id: "a", type: "rtl_tcp" }])
		expect(set).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})

	it("non-rtl_tcp with tuner warns once, no set", () => {
		const { set, warn } = run([{ id: "s", type: "sdrpp-network", tuner }])
		expect(set).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledExactlyOnceWith("s")
	})

	it("non-rtl_tcp without tuner does nothing", () => {
		const { set, warn } = run([{ id: "r", type: "recording" }])
		expect(set).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})
})

describe("config/default.yaml", () => {
	it("carries no source tuner (defaults unchanged)", () => {
		const raw = parse(
			readFileSync(
				new URL("../../../config/default.yaml", import.meta.url),
				"utf8",
			),
		)
		const config = ConfigSchema.parse(raw)
		expect(config.sources.filter(s => s.tuner !== undefined)).toEqual([])
	})
})
