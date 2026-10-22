import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, afterEach, vi } from "vitest"
import * as fc from "fast-check"
import {
	SourceConfigSchema,
	CHANNELS_RESERVED_MESSAGE,
	loadConfig,
	parseEnvironmentVariables,
} from "../../../src/config.js"
import { ConfigValidationError } from "../../../src/utils/errors.js"

const baseSource = {
	id: "test",
	type: "rtl_tcp",
	host: "localhost",
	caps: { kind: "iq", format: "U8_IQ", sampleRate: 2048000 },
}
afterEach(() => vi.unstubAllEnvs())

describe("link burst configuration", () => {
	// Feature: link-burst-resilience, Property 14: Delivery hook (config half)
	// Validates: Requirements 7.1, 8.2
	it("auto and raw parse, channels fails, absent defaults to auto", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("raw", "auto", "channels", undefined),
				delivery => {
					const result = SourceConfigSchema.safeParse({
						...baseSource,
						...(delivery ? { delivery } : {}),
					})
					if (delivery === "channels") {
						expect(result.success).toBe(false)
						if (!result.success)
							expect(result.error.issues).toContainEqual(
								expect.objectContaining({
									path: ["delivery"],
									message: CHANNELS_RESERVED_MESSAGE,
								}),
							)
					} else
						expect(result.success && result.data.delivery).toBe(
							delivery ?? "auto",
						)
				},
			),
			{ numRuns: 100 },
		)
	})
	it.each([0, 2, 10])("accepts absorber seconds %s", seconds => {
		expect(
			SourceConfigSchema.parse({ ...baseSource, burstAbsorber: { seconds } })
				.burstAbsorber?.seconds,
		).toBe(seconds)
	})
	it.each([-0.1, 10.1, NaN, Infinity, "2", null])(
		"rejects absorber seconds %s",
		seconds => {
			expect(
				SourceConfigSchema.safeParse({
					...baseSource,
					burstAbsorber: { seconds },
				}).success,
			).toBe(false)
		},
	)
	it("rejects unknown absorber keys and invalid delivery modes", () => {
		expect(
			SourceConfigSchema.safeParse({
				...baseSource,
				burstAbsorber: { seconds: 2, extra: true },
			}).success,
		).toBe(false)
		expect(
			SourceConfigSchema.safeParse({ ...baseSource, delivery: "invalid" })
				.success,
		).toBe(false)
	})
	it("env override sets absorber seconds and startup rejects channels", () => {
		const dir = mkdtempSync(join(tmpdir(), "wavekit-link-config-"))
		try {
			const path = join(dir, "config.yaml")
			writeFileSync(
				path,
				JSON.stringify({
					sources: [{ ...baseSource, burstAbsorber: { seconds: 2 } }],
				}),
			)
			vi.stubEnv("WAVEKIT_SOURCES_0_BURST_ABSORBER__SECONDS", "0")
			expect(parseEnvironmentVariables()).toHaveProperty(
				"sources.0.burstAbsorber.seconds",
				0,
			)
			expect(loadConfig(path).sources[0]?.burstAbsorber?.seconds).toBe(0)
			vi.stubEnv("WAVEKIT_SOURCES_0_DELIVERY", "channels")
			expect(() => loadConfig(path)).toThrow(ConfigValidationError)
			expect(() => loadConfig(path)).toThrow(CHANNELS_RESERVED_MESSAGE)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
