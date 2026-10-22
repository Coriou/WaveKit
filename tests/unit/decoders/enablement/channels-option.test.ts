import { expect, it } from "vitest"
import { validateDecoderPatch } from "../../../../src/decoders/settings/patch-policy.js"

it.each(["dsd-fme", "multimon-ng", "direwolf"])(
	"%s channelsHz accepts 16 entries and rejects 17",
	type => {
		expect(
			validateDecoderPatch(
				type,
				{},
				{ options: { channelsHz: Array.from({ length: 16 }, () => 123) } },
			).options["channelsHz"],
		).toHaveLength(16)
		expect(() =>
			validateDecoderPatch(
				type,
				{},
				{ options: { channelsHz: Array.from({ length: 17 }, () => 123) } },
			),
		).toThrow()
	},
)
it.each(["dsd-fme", "multimon-ng", "direwolf"])(
	"%s rejects zero, negative and non-finite",
	type => {
		for (const value of [0, -1, NaN, Infinity, -Infinity])
			expect(() =>
				validateDecoderPatch(type, {}, { options: { channelsHz: [value] } }),
			).toThrow()
	},
)
