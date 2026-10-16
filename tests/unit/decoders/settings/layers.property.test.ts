import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { DecoderSettingValue } from "@wavekit/api-types"
import { decoderOptionDescriptors } from "../../../../src/decoders/options/index.js"
import type { DecoderOverride } from "../../../../src/decoders/settings/contract.js"
import {
	buildDecoderSettingsView,
	effectiveDecoderConfig,
} from "../../../../src/decoders/settings/layers.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"

const TYPES = [
	"acarsdec",
	"ais-catcher",
	"direwolf",
	"dsd-fme",
	"dumpvdl2",
	"lora-meshtastic",
	"multimon-ng",
	"readsb",
	"rtl433",
	"no-schema-type",
]

function documentedKeys(type: string): string[] {
	return (decoderOptionDescriptors(type) ?? []).map(d => d.key)
}

const settingValue: fc.Arbitrary<DecoderSettingValue> = fc.oneof(
	fc.boolean(),
	fc.integer(),
	fc.double({ noNaN: true, noDefaultInfinity: true }),
	fc.string({ maxLength: 8 }),
	fc.array(fc.string({ maxLength: 4 }), { maxLength: 4 }),
	fc.array(fc.integer(), { maxLength: 4 }),
)

const anyValue: fc.Arbitrary<unknown> = fc.oneof(
	settingValue,
	fc.constant(null),
	fc.dictionary(fc.string({ maxLength: 4 }), fc.integer(), { maxKeys: 2 }),
)

/** Undocumented key names: a fixed marker so they are recognisable in JSON. */
const undocumentedKey = fc
	.string({ minLength: 1, maxLength: 6 })
	.map(s => `zzundoc_${s.replace(/[^a-z0-9]/gi, "")}_x`)

function keyFor(type: string): fc.Arbitrary<string> {
	const keys = documentedKeys(type)
	return keys.length > 0
		? fc.oneof(fc.constantFrom(...keys), fc.string({ maxLength: 6 }))
		: fc.string({ maxLength: 6 })
}

const scenario = fc.constantFrom(...TYPES).chain(type =>
	fc.record({
		config: fc.record({
			id: fc.string({ minLength: 1, maxLength: 8 }),
			type: fc.constant(type),
			enabled: fc.boolean(),
			options: fc.dictionary(keyFor(type), anyValue, { maxKeys: 8 }),
		}) as fc.Arbitrary<DecoderConfig>,
		override: fc.option(
			fc.record(
				{
					type: fc.oneof(fc.constant(type), fc.constantFrom(...TYPES)),
					enabled: fc.boolean(),
					options: fc.dictionary(keyFor(type), settingValue, { maxKeys: 8 }),
					updatedAt: fc.constant("2026-10-16T00:00:00.000Z"),
				},
				{ requiredKeys: ["type", "options", "updatedAt"] },
			) as fc.Arbitrary<DecoderOverride>,
			{ nil: undefined },
		),
	}),
)

describe("decoder settings layers properties", () => {
	// Feature: web-gaps-8, Property 1: Override layering
	// Validates: Requirements 1.1, 1.5
	it("override keys and enabled win, everything else is the config, inputs untouched", () => {
		fc.assert(
			fc.property(scenario, ({ config, override }) => {
				const configBefore = structuredClone(config)
				const overrideBefore = structuredClone(override)
				const out = effectiveDecoderConfig(config, override)
				expect(config).toEqual(configBefore)
				expect(override).toEqual(overrideBefore)
				expect(out).not.toBe(config)
				expect(out.options).not.toBe(config.options)
				expect(out.id).toBe(config.id)
				expect(out.type).toBe(config.type)
				expect(out.enabled).toBe(override?.enabled ?? config.enabled)
				const keys = new Set([
					...Object.keys(config.options),
					...Object.keys(override?.options ?? {}),
				])
				expect(new Set(Object.keys(out.options))).toEqual(keys)
				for (const key of keys) {
					const expected =
						override !== undefined && Object.hasOwn(override.options, key)
							? override.options[key]
							: config.options[key]
					expect(out.options[key]).toEqual(expected)
				}
			}),
			{ numRuns: 200 },
		)
	})

	// Feature: web-gaps-8, Property 5: View hides non-patchable values
	// Validates: Requirements 2.7
	it("no secret or non-patchable entry carries a value; undocumented keys are never named", () => {
		fc.assert(
			fc.property(
				scenario,
				fc.array(undocumentedKey, { maxLength: 4 }),
				fc.nat(1000),
				fc.boolean(),
				({ config, override }, extra, revision, pendingRestart) => {
					const options = { ...config.options }
					for (const key of extra) options[key] = 1
					const withExtra = { ...config, options }
					const view = buildDecoderSettingsView({
						config: withExtra,
						override,
						revision,
						pendingRestart,
					})
					const documented = new Set(documentedKeys(config.type))
					expect(view.options.map(o => o.key)).toEqual([...documented])
					for (const o of view.options) {
						if (!o.patchable || o.secret) expect(o).not.toHaveProperty("value")
					}
					const undocumented = Object.keys(options).filter(
						k => !documented.has(k),
					)
					expect(view.undocumentedKeys).toBe(undocumented.length)
					const json = JSON.stringify(view)
					for (const key of extra) expect(json).not.toContain(key)
				},
			),
			{ numRuns: 200 },
		)
	})
})
