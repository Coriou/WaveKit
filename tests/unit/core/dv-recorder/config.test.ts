import { describe, expect, it } from "vitest"
import {
	DigitalVoiceConfigSchema,
	DvRecordCallsConfigSchema,
} from "../../../../src/config.js"

const GIB = 1024 * 1024 * 1024

describe("digitalVoice.recordCalls config", () => {
	it("defaults: on, 1 s minimum voice, 5 min cap, 2 GiB, 7 days", () => {
		expect(DigitalVoiceConfigSchema.parse({}).recordCalls).toEqual({
			enabled: true,
			minVoiceMs: 1000,
			maxCallMs: 300_000,
			retentionBytes: 2 * GIB,
			retentionDays: 7,
		})
	})

	it.each([
		["minVoiceMs", 0, true],
		["minVoiceMs", -1, false],
		["minVoiceMs", 60_000, true],
		["minVoiceMs", 60_001, false],
		["maxCallMs", 1000, true],
		["maxCallMs", 999, false],
		["maxCallMs", 3_600_000, true],
		["maxCallMs", 3_600_001, false],
		["retentionBytes", 16 * 1024 * 1024, true],
		["retentionBytes", 16 * 1024 * 1024 - 1, false],
		["retentionBytes", 1024 * GIB, true],
		["retentionBytes", 1024 * GIB + 1, false],
		["retentionDays", 1, true],
		["retentionDays", 0, false],
		["retentionDays", 365, true],
		["retentionDays", 366, false],
	] as const)("%s = %d accepted: %s", (key, value, ok) => {
		const over = key === "minVoiceMs" ? { maxCallMs: 3_600_000 } : {}
		expect(
			DvRecordCallsConfigSchema.safeParse({ ...over, [key]: value }).success,
		).toBe(ok)
	})

	it("maxCallMs at minVoiceMs is accepted, below it rejected", () => {
		expect(
			DvRecordCallsConfigSchema.safeParse({ minVoiceMs: 2000, maxCallMs: 2000 })
				.success,
		).toBe(true)
		expect(
			DvRecordCallsConfigSchema.safeParse({ minVoiceMs: 2001, maxCallMs: 2000 })
				.success,
		).toBe(false)
	})

	it("takes an explicit directory", () => {
		expect(DvRecordCallsConfigSchema.parse({ dir: "/data/dv-calls" }).dir).toBe(
			"/data/dv-calls",
		)
		expect(DvRecordCallsConfigSchema.safeParse({ dir: "" }).success).toBe(false)
	})
})
