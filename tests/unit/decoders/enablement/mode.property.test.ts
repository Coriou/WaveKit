import { expect, it } from "vitest"
import fc from "fast-check"
import { resolveDecoderMode } from "../../../../src/decoders/enablement/mode.js"

const mode = fc.constantFrom("auto" as const, "always" as const, "off" as const)
const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined })

// Feature: decoder-enablement, Property 2: Mode precedence
// Validates: Requirements 2.1, 2.2, 2.3
it("resolves each precedence rung independently", () => {
	fc.assert(
		fc.property(
			fc.record({
				settingsMode: optional(mode),
				settingsEnabled: optional(fc.boolean()),
				configMode: optional(mode),
				configEnabled: fc.boolean(),
				configBandSuspension: optional(fc.boolean()),
				apiBandSuspension: optional(fc.boolean()),
			}),
			input => {
				const table = [
					[input.settingsMode !== undefined, input.settingsMode, "settings"],
					[input.settingsEnabled === false, "off", "settings"],
					[input.configMode !== undefined, input.configMode, "config"],
					[!input.configEnabled, "off", "legacy-enabled"],
					[
						input.configBandSuspension === false ||
							input.apiBandSuspension === false,
						"always",
						"legacy-band",
					],
					[true, "auto", "default"],
				]
				const expected = table.find(row => row[0])!
				expect(resolveDecoderMode(input)).toEqual({
					mode: expected[1],
					source: expected[2],
				})
			},
		),
		{ numRuns: 100 },
	)
})

it.each([
	[{ settingsMode: "auto", settingsEnabled: false }, "auto", "settings"],
	[{ settingsEnabled: false, configMode: "always" }, "off", "settings"],
	[{ configMode: "always", configEnabled: false }, "always", "config"],
	[
		{ configEnabled: false, configBandSuspension: false },
		"off",
		"legacy-enabled",
	],
	[{ configBandSuspension: false }, "always", "legacy-band"],
	[{ apiBandSuspension: false }, "always", "legacy-band"],
	[{}, "auto", "default"],
] as const)("covers precedence %j", (input, mode, source) => {
	expect(resolveDecoderMode({ configEnabled: true, ...input })).toEqual({
		mode,
		source,
	})
})
