/**
 * Live audio AGC planner (web-gaps-4 lane A).
 */

import { readFileSync } from "node:fs"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	ConfigSchema,
	LiveDemodConfigSchema,
	validateConfig,
	type LiveDemodConfig,
} from "../../../src/config.js"
import {
	effectiveAgc,
	type LiveDemodAgcMode,
} from "../../../src/core/live-demod-pipeline.js"
import { ConfigValidationError } from "../../../src/utils/errors.js"
import {
	GOLDEN_MODULATIONS,
	goldenCases,
	planGoldenCase,
} from "./live-demod-pipeline-golden-cases.js"

const golden = JSON.parse(
	readFileSync(
		new URL("./fixtures/live-demod-pipeline-golden.json", import.meta.url),
		"utf8",
	),
) as Record<string, unknown>

const isAgc = (stage: string): boolean => stage.startsWith("csdr agc ")

function plan(overrides: Record<string, unknown>): string[] {
	const config = LiveDemodConfigSchema.parse(overrides)
	return planGoldenCase(config).backStages
}

/** The stage the AGC must directly follow, per requirement 4.3. */
function expectedPredecessor(
	stages: string[],
	config: LiveDemodConfig,
): string {
	switch (config.modulation) {
		case "am":
		case "cw":
		case "dsb":
			return "csdr amdemod"
		case "usb":
		case "lsb":
			return "csdr realpart"
		default: {
			const fm = stages.indexOf("csdr fmdemod")
			return config.deEmphasis ? (stages[fm + 1] ?? "") : "csdr fmdemod"
		}
	}
}

describe("effectiveAgc", () => {
	it("raw is always off", () => {
		expect(effectiveAgc("raw")).toBe("off")
		expect(effectiveAgc("raw", "fast")).toBe("off")
		expect(effectiveAgc("raw", "slow")).toBe("off")
	})

	it.each(["am", "cw", "dsb", "usb", "lsb"] as const)(
		"absent on %s is fast",
		modulation => {
			expect(effectiveAgc(modulation)).toBe("fast")
		},
	)

	it.each(["nfm", "wfm"] as const)("absent on %s is off", modulation => {
		expect(effectiveAgc(modulation)).toBe("off")
	})

	it("explicit wins", () => {
		expect(effectiveAgc("am", "off")).toBe("off")
		expect(effectiveAgc("am", "slow")).toBe("slow")
		expect(effectiveAgc("nfm", "fast")).toBe("fast")
		expect(effectiveAgc("wfm", "slow")).toBe("slow")
	})
})

describe("AGC stage placement", () => {
	it("AM default keeps fast after amdemod", () => {
		const stages = plan({ modulation: "am" })
		const i = stages.indexOf("csdr amdemod")
		expect(stages[i + 1]).toBe("csdr agc -f float -p fast -r 0.4")
	})

	it("explicit off on AM removes the stage", () => {
		const stages = plan({ modulation: "am", agc: "off" })
		expect(stages.some(isAgc)).toBe(false)
		expect(stages).toContain("csdr amdemod")
	})

	it("slow on USB follows realpart", () => {
		const stages = plan({ modulation: "usb", agc: "slow" })
		const i = stages.indexOf("csdr realpart")
		expect(stages[i + 1]).toBe("csdr agc -f float -p slow -r 0.4")
	})

	it("slow on NFM without de-emphasis follows fmdemod, before low-pass", () => {
		const stages = plan({ modulation: "nfm", agc: "slow", lowPass: 3000 })
		const i = stages.indexOf("csdr fmdemod")
		expect(stages[i + 1]).toBe("csdr agc -f float -p slow -r 0.4")
		expect(stages[i + 2]).toMatch(/^csdr lowpass /)
	})

	it("slow on NFM with de-emphasis follows de-emphasis, before low-pass", () => {
		const stages = plan({
			modulation: "nfm",
			agc: "slow",
			deEmphasis: true,
			lowPass: 3000,
		})
		const i = stages.indexOf("csdr fmdemod")
		expect(stages[i + 1]).not.toMatch(/^csdr agc /)
		expect(stages[i + 2]).toBe("csdr agc -f float -p slow -r 0.4")
		expect(stages[i + 3]).toMatch(/^csdr lowpass /)
	})

	it("fast on WFM inserts one stage", () => {
		const stages = plan({ modulation: "wfm", agc: "fast" })
		expect(stages.filter(isAgc)).toEqual(["csdr agc -f float -p fast -r 0.4"])
	})

	it("raw never gets AGC", () => {
		expect(plan({ modulation: "raw", agc: "fast" }).some(isAgc)).toBe(false)
	})
})

describe("AGC config validation", () => {
	it("LiveDemodConfigSchema accepts off/slow/fast and absent", () => {
		for (const agc of ["off", "slow", "fast"]) {
			expect(LiveDemodConfigSchema.parse({ agc }).agc).toBe(agc)
		}
		expect(LiveDemodConfigSchema.parse({}).agc).toBeUndefined()
	})

	it("ConfigSchema rejects an invalid agc value", () => {
		const result = ConfigSchema.safeParse({ liveDemod: { agc: "medium" } })
		expect(result.success).toBe(false)
	})

	it("validateConfig throws ConfigValidationError on an invalid agc", () => {
		expect(() => validateConfig({ liveDemod: { agc: "medium" } })).toThrow(
			ConfigValidationError,
		)
	})
})

describe("AGC planner property", () => {
	// Feature: web-gaps-4, Property 6: AGC planner
	// Validates: Requirements 4.1, 4.2, 4.3, 4.7
	it("absent equals golden; one stage iff effective is not off; placed per 4.3", () => {
		const cases = goldenCases()
		fc.assert(
			fc.property(
				fc.constantFrom(...cases),
				fc.constantFrom<LiveDemodAgcMode | undefined>(
					undefined,
					"off",
					"slow",
					"fast",
				),
				(c, agc) => {
					expect(GOLDEN_MODULATIONS).toContain(c.config.modulation)
					const config: LiveDemodConfig =
						agc === undefined ? c.config : { ...c.config, agc }
					const result = planGoldenCase(config)
					if (agc === undefined) {
						expect(result).toEqual(golden[c.key])
					}
					const mode = effectiveAgc(config.modulation, config.agc)
					const stages = result.backStages
					const agcStages = stages.filter(isAgc)
					if (mode === "off") {
						expect(agcStages).toHaveLength(0)
						return
					}
					expect(agcStages).toEqual([`csdr agc -f float -p ${mode} -r 0.4`])
					const at = stages.findIndex(isAgc)
					expect(at).toBeGreaterThan(0)
					expect(stages[at - 1]).toBe(expectedPredecessor(stages, config))
					const lowpass = stages.findIndex(s => s.startsWith("csdr lowpass"))
					if (lowpass >= 0) expect(at).toBeLessThan(lowpass)
					// 4.7: at most one CSDR process more or less than the default chain
					const base = planGoldenCase(c.config).backStages.length
					expect(Math.abs(stages.length - base)).toBeLessThanOrEqual(1)
				},
			),
			{ numRuns: 200 },
		)
	})
})
