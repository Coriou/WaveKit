/**
 * WG9 5.2: stored frequency overrides the configuration shadows are dropped at load.
 */

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DECODER_SETTINGS_FILE_NAME } from "@wavekit/api-types"
import {
	isFrequencyKeyShadowed,
	sanitizeStoredOptions,
} from "../../../../src/decoders/settings/patch-policy.js"
import { openDecoderSettingsService } from "../../../../src/decoders/settings/service.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { makeTmp, removeTmp, stubLogger } from "../../core/station/helpers.js"

const DROP_MESSAGE =
	"Decoder settings stored options dropped (no longer patchable, invalid, or shadowed by configured frequencies)"

describe("sanitizeStoredOptions shadowed frequency keys", () => {
	it("without a configuration argument a lone frequency key is kept (golden)", () => {
		expect(
			sanitizeStoredOptions("acarsdec", { frequency: 131_725_000 }),
		).toEqual({ options: { frequency: 131_725_000 }, dropped: 0, shadowed: 0 })
		expect(
			sanitizeStoredOptions("acarsdec", { frequencies: [131_550_000] }),
		).toEqual({
			options: { frequencies: [131_550_000] },
			dropped: 0,
			shadowed: 0,
		})
	})

	it("top-level frequencies drops both stored keys", () => {
		const out = sanitizeStoredOptions(
			"acarsdec",
			{ frequencies: [131_550_000], frequency: 131_725_000 },
			[130_025_000],
			{},
		)
		expect(out.options).not.toHaveProperty("frequencies")
		expect(out.options).not.toHaveProperty("frequency")
		expect(out.dropped).toBe(2)
		expect(out.shadowed).toBe(2)
	})

	it("a kept stored frequencies shadows a stored frequency", () => {
		const out = sanitizeStoredOptions(
			"acarsdec",
			{ frequencies: [131_550_000], frequency: 131_725_000 },
			undefined,
			{},
		)
		expect(out).toEqual({
			options: { frequencies: [131_550_000] },
			dropped: 1,
			shadowed: 1,
		})
	})

	it("a configured options.frequencies shadows a stored frequency", () => {
		const out = sanitizeStoredOptions(
			"acarsdec",
			{ frequency: 131_725_000 },
			undefined,
			{ frequencies: [131_550_000] },
		)
		expect(out).toEqual({ options: {}, dropped: 1, shadowed: 1 })
	})

	it("an invalid stored frequencies is dropped and does not shadow frequency", () => {
		const out = sanitizeStoredOptions(
			"acarsdec",
			{ frequencies: "nope", frequency: 131_725_000 },
			undefined,
			{},
		)
		expect(out).toEqual({
			options: { frequency: 131_725_000 },
			dropped: 1,
			shadowed: 0,
		})
	})

	it("unshadowed keys are kept as before", () => {
		const out = sanitizeStoredOptions(
			"acarsdec",
			{ frequency: 131_725_000 },
			undefined,
			{ extraArgs: ["-v"] },
		)
		expect(out).toEqual({
			options: { frequency: 131_725_000 },
			dropped: 0,
			shadowed: 0,
		})
	})
})

// Feature: web-gaps-9, Property 10: Shadowed keys dropped
// Validates: Requirements 5.2
describe("Property 10: shadowed keys dropped", () => {
	const freqs = fc.array(fc.integer({ min: 1_000_000, max: 1_700_000_000 }), {
		minLength: 1,
		maxLength: 4,
	})
	const maybe = <T>(arb: fc.Arbitrary<T>) =>
		fc.option(arb, { nil: undefined, freq: 2 })
	const stored = fc.record(
		{
			frequencies: freqs,
			frequency: fc.integer({ min: 1_000_000, max: 1_700_000_000 }),
			gain: fc.integer({ min: 0, max: 50 }),
		},
		{ requiredKeys: [] },
	)

	it("no shadowed key survives and the rest equals the unshadowed sanitize", () => {
		fc.assert(
			fc.property(
				stored,
				maybe(freqs),
				maybe(freqs),
				(options, top, configFreqs) => {
					const configOptions =
						configFreqs === undefined ? {} : { frequencies: configFreqs }
					const base = sanitizeStoredOptions("acarsdec", options)
					const out = sanitizeStoredOptions(
						"acarsdec",
						options,
						top,
						configOptions,
					)
					// Effective options as the resolver sees them after load.
					const effective = { ...configOptions, ...out.options }
					for (const key of Object.keys(out.options))
						expect(isFrequencyKeyShadowed(key, top, effective)).toBe(false)
					let removed = 0
					for (const key of Object.keys(base.options)) {
						if (Object.hasOwn(out.options, key)) {
							expect(out.options[key]).toEqual(base.options[key])
						} else {
							expect(["frequencies", "frequency"]).toContain(key)
							removed += 1
						}
					}
					expect(out.dropped).toBe(base.dropped + removed)
					expect(out.shadowed).toBe(base.shadowed + removed)
					if (top === undefined && configFreqs === undefined) {
						const storedFreqs = Object.hasOwn(base.options, "frequencies")
						if (!storedFreqs) expect(out).toEqual(base)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("decoder settings service drops shadowed stored keys at load", () => {
	let stateDir: string

	beforeEach(async () => {
		stateDir = await makeTmp()
	})
	afterEach(async () => {
		await removeTmp(stateDir)
	})

	it("top-level frequencies added after a PATCH: one warn with the count, no values logged", async () => {
		const config: DecoderConfig = {
			id: "acars",
			type: "acarsdec",
			enabled: true,
			frequencies: [130_025_000],
			options: {},
		}
		await writeFile(
			join(stateDir, DECODER_SETTINGS_FILE_NAME),
			JSON.stringify({
				schemaVersion: 1,
				revision: 3,
				decoders: {
					acars: {
						type: "acarsdec",
						options: { frequencies: [131_550_000], frequency: 131_725_000 },
						updatedAt: "2026-10-01T00:00:00.000Z",
					},
				},
			}),
		)
		const raw = await readFile(
			join(stateDir, DECODER_SETTINGS_FILE_NAME),
			"utf8",
		)
		const { logger, warn } = stubLogger()
		const service = await openDecoderSettingsService({
			configs: [config],
			stateDir,
			logger,
		})
		const effective = service.effectiveConfig(config).options
		expect(effective).not.toHaveProperty("frequencies")
		expect(effective).not.toHaveProperty("frequency")
		const drops = warn.mock.calls.filter(c => c[1] === DROP_MESSAGE)
		expect(drops).toEqual([[{ dropped: 2, shadowed: 2 }, DROP_MESSAGE]])
		expect(JSON.stringify(warn.mock.calls)).not.toContain("131550000")
		expect(JSON.stringify(warn.mock.calls)).not.toContain("131725000")
		// Load never rewrites the file.
		expect(
			await readFile(join(stateDir, DECODER_SETTINGS_FILE_NAME), "utf8"),
		).toBe(raw)
		await service.close()
	})

	it("an unshadowed stored frequency stays effective (golden)", async () => {
		const config: DecoderConfig = {
			id: "acars",
			type: "acarsdec",
			enabled: true,
			options: {},
		}
		await writeFile(
			join(stateDir, DECODER_SETTINGS_FILE_NAME),
			JSON.stringify({
				schemaVersion: 1,
				revision: 3,
				decoders: {
					acars: {
						type: "acarsdec",
						options: { frequency: 131_725_000 },
						updatedAt: "2026-10-01T00:00:00.000Z",
					},
				},
			}),
		)
		const { logger, warn } = stubLogger()
		const service = await openDecoderSettingsService({
			configs: [config],
			stateDir,
			logger,
		})
		expect(service.effectiveConfig(config).options["frequency"]).toBe(
			131_725_000,
		)
		expect(warn.mock.calls.filter(c => c[1] === DROP_MESSAGE)).toEqual([])
		await service.close()
	})
})
