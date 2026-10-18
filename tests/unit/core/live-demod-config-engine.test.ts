import { describe, expect, it } from "vitest"
import { LiveDemodConfigSchema } from "../../../src/config.js"

const base = {
	enabled: false,
	httpPort: 8081,
	modulation: "nfm" as const,
	bandwidth: 12500,
	squelch: 0,
	noiseReduction: "off" as const,
	lowPass: 0,
	highPass: 0,
	gain: 2,
	deEmphasis: false,
	deEmphasisTau: 50 as const,
	audioFormat: "s16le" as const,
	iqDcBlock: false,
	offsetHz: 0,
}

describe("LiveDemodConfigSchema engine", () => {
	it("omits engine and chanBinaryPath from parsed config", () => {
		const parsed = LiveDemodConfigSchema.parse({})
		// Absence is the csdr runtime default. A schema default would land in snapshots.
		expect(parsed.engine).toBeUndefined()
		expect(Object.hasOwn(parsed, "engine")).toBe(false)
		expect(parsed.chanBinaryPath).toBeUndefined()
		expect(Object.hasOwn(parsed, "chanBinaryPath")).toBe(false)
		expect(parsed).toMatchObject(base)
	})

	it("accepts rust and an explicit binary path", () => {
		const parsed = LiveDemodConfigSchema.parse({
			engine: "rust",
			chanBinaryPath: "wavekit-chan",
		})
		expect(parsed.engine).toBe("rust")
		expect(parsed.chanBinaryPath).toBe("wavekit-chan")
	})

	it("rejects an unknown engine and an empty binary path", () => {
		expect(() => LiveDemodConfigSchema.parse({ engine: "dsp" })).toThrow()
		expect(() => LiveDemodConfigSchema.parse({ chanBinaryPath: "" })).toThrow()
	})

	it("accepts demod bandwidth at the rust bounds", () => {
		expect(LiveDemodConfigSchema.parse({ bandwidth: 2500 }).bandwidth).toBe(
			2500,
		)
		expect(LiveDemodConfigSchema.parse({ bandwidth: 40000 }).bandwidth).toBe(
			40000,
		)
	})

	it("rejects bandwidth past the schema bound and still parses values rust would refuse", () => {
		expect(() => LiveDemodConfigSchema.parse({ bandwidth: -1 })).toThrow()
		expect(() => LiveDemodConfigSchema.parse({ bandwidth: 1.5 })).toThrow()
		// 2499 and 40001 stay valid config. The rust engine falls back at runtime
		// instead of rejecting the file, so existing narrow channels still load.
		expect(LiveDemodConfigSchema.parse({ bandwidth: 2499 }).bandwidth).toBe(
			2499,
		)
		expect(LiveDemodConfigSchema.parse({ bandwidth: 40001 }).bandwidth).toBe(
			40001,
		)
	})
})
