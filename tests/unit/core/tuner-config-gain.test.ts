import { readFileSync } from "node:fs"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { SourceTunerConfigSchema } from "../../../src/config.js"
import type { SourceTunerConfig } from "../../../src/config.js"
import {
	CONFIG_AGC_MODE_COMMAND,
	CONFIG_GAIN_COMMAND,
	CONFIG_GAIN_MODE_COMMAND,
	configuredTuningFrames,
} from "../../../src/core/tuner-config-gain.js"

const frames = (t: SourceTunerConfig) => configuredTuningFrames(t)

describe("configuredTuningFrames", () => {
	it("manual 49.6 dB writes mode 1 and 496 tenths", () => {
		expect(frames({ gainMode: "manual", gainDb: 49.6 })).toEqual([
			[0x03, 1],
			[0x04, 496],
		])
	})

	it("manual with agcMode true or false appends the AGC frame", () => {
		expect(frames({ gainMode: "manual", gainDb: 49.6, agcMode: true })).toEqual(
			[
				[0x03, 1],
				[0x04, 496],
				[0x08, 1],
			],
		)
		expect(
			frames({ gainMode: "manual", gainDb: 49.6, agcMode: false }),
		).toEqual([
			[0x03, 1],
			[0x04, 496],
			[0x08, 0],
		])
	})

	it("agc mode writes mode 0 and no gain", () => {
		expect(frames({ gainMode: "agc" })).toEqual([[0x03, 0]])
		expect(frames({ gainMode: "agc", agcMode: true })).toEqual([
			[0x03, 0],
			[0x08, 1],
		])
	})

	it("bounds 0 and 50 dB map to 0 and 500 tenths", () => {
		expect(frames({ gainMode: "manual", gainDb: 0 })[1]).toEqual([0x04, 0])
		expect(frames({ gainMode: "manual", gainDb: 50 })[1]).toEqual([0x04, 500])
	})

	it.each([
		[0.3, 3],
		[12.7, 127],
		[49.9, 499],
		[0.1, 1],
		[1.1, 11],
		[2.3, 23],
		[4.35 * 2, 87],
	])("%f dB is exactly %i tenths", (db, tenths) => {
		expect(frames({ gainMode: "manual", gainDb: db })[1]).toEqual([
			0x04,
			tenths,
		])
	})
})

describe("SourceTunerConfigSchema bounds", () => {
	it.each([
		["above 50", { gainMode: "manual", gainDb: 50.1 }],
		["below 0", { gainMode: "manual", gainDb: -0.1 }],
		["not a 0.1 step", { gainMode: "manual", gainDb: 0.05 }],
		["manual without gainDb", { gainMode: "manual" }],
		["agc with gainDb", { gainMode: "agc", gainDb: 10 }],
	])("refuses %s", (_name, value) => {
		expect(SourceTunerConfigSchema.safeParse(value).success).toBe(false)
	})

	it("accepts the bounds", () => {
		expect(
			SourceTunerConfigSchema.safeParse({ gainMode: "manual", gainDb: 0 })
				.success,
		).toBe(true)
		expect(
			SourceTunerConfigSchema.safeParse({ gainMode: "manual", gainDb: 50 })
				.success,
		).toBe(true)
	})
})

describe("opcode pin", () => {
	it("matches RTL_TCP_COMMANDS in tuner-controller.ts", () => {
		const src = readFileSync(
			new URL("../../../src/core/tuner-controller.ts", import.meta.url),
			"utf8",
		)
		const op = (name: string) =>
			Number(new RegExp(`\\b${name}:\\s*(0x[0-9a-fA-F]+)`).exec(src)?.[1])
		expect(CONFIG_GAIN_MODE_COMMAND).toBe(op("SET_GAIN_MODE"))
		expect(CONFIG_GAIN_COMMAND).toBe(op("SET_GAIN"))
		expect(CONFIG_AGC_MODE_COMMAND).toBe(op("SET_AGC_MODE"))
	})
})

describe("property", () => {
	// Feature: web-gaps-11, Property: configured gain frames order and range
	// Validates: Requirements 4.1, 4.2
	it("valid configs yield ordered, in-range frames; gain iff manual", () => {
		const arb = fc.oneof(
			fc.record(
				{
					gainMode: fc.constant("manual" as const),
					gainDb: fc.integer({ min: 0, max: 500 }).map(n => n / 10),
					agcMode: fc.boolean(),
				},
				{ requiredKeys: ["gainMode", "gainDb"] },
			),
			fc.record(
				{ gainMode: fc.constant("agc" as const), agcMode: fc.boolean() },
				{ requiredKeys: ["gainMode"] },
			),
		)
		fc.assert(
			fc.property(arb, raw => {
				const parsed = SourceTunerConfigSchema.parse(raw)
				const out = frames(parsed)
				expect(out[0]?.[0]).toBe(0x03)
				const manual = parsed.gainMode === "manual"
				expect(out.some(f => f[0] === 0x04)).toBe(manual)
				const order = out.map(f => f[0])
				expect(order).toEqual([...order].sort((a, b) => a - b))
				for (const [cmd, v] of out) {
					if (cmd === 0x04) expect(v).toBeGreaterThanOrEqual(0)
					if (cmd === 0x04) expect(v).toBeLessThanOrEqual(500)
					if (cmd !== 0x04) expect([0, 1]).toContain(v)
				}
				if (manual)
					expect(out[1]?.[1]).toBe(Math.round((parsed.gainDb ?? 0) * 10))
				expect(out.some(f => f[0] === 0x08)).toBe(parsed.agcMode !== undefined)
			}),
			{ numRuns: 200 },
		)
	})
})
