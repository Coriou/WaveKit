// The placed-channel bound is derived from the config and option bounds it names.
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../../../src/config.js"
import {
	ACTIVITY_SLOTS_CONFIG_MAX,
	BANDPLAN_CHANNELS_CONFIG_MAX,
	DECODER_CHANNELS_HZ_MAX,
	MULTIMON_PAGING_MAX_CHANNELS,
	PLACED_CHANNELS_PER_DECODER_MAX,
} from "../../../../src/decoders/enablement/contract.js"
import { direwolfOptionsSchema } from "../../../../src/decoders/options/direwolf.js"
import { dsdFmeOptionsSchema } from "../../../../src/decoders/options/dsd-fme.js"
import { multimonNgOptionsSchema } from "../../../../src/decoders/options/multimon-ng.js"

const efficiency = (value: Record<string, unknown>) =>
	ConfigSchema.safeParse({ decoderPolicy: { efficiency: value } }).success

describe("placed channels per decoder", () => {
	it("is the largest placement set of any planner path", () => {
		expect(PLACED_CHANNELS_PER_DECODER_MAX).toBe(
			Math.max(
				DECODER_CHANNELS_HZ_MAX,
				MULTIMON_PAGING_MAX_CHANNELS + BANDPLAN_CHANNELS_CONFIG_MAX,
				ACTIVITY_SLOTS_CONFIG_MAX + 2,
			),
		)
		expect(PLACED_CHANNELS_PER_DECODER_MAX).toBe(49)
	})

	it("matches the config bounds of activity slots and band-plan channels", () => {
		for (const type of ["multimon-ng", "dsd-fme"]) {
			const slots = (n: number) =>
				efficiency({ activity: { slots: { [type]: n } } })
			expect(slots(ACTIVITY_SLOTS_CONFIG_MAX)).toBe(true)
			expect(slots(ACTIVITY_SLOTS_CONFIG_MAX + 1)).toBe(false)
		}
		expect(
			efficiency({ maxBandplanChannels: BANDPLAN_CHANNELS_CONFIG_MAX }),
		).toBe(true)
		expect(
			efficiency({ maxBandplanChannels: BANDPLAN_CHANNELS_CONFIG_MAX + 1 }),
		).toBe(false)
	})

	it("matches the explicit channelsHz bound of the channel decoders", () => {
		const list = (n: number) =>
			Array.from({ length: n }, (_, k) => 446_006_250 + k * 12_500)
		for (const schema of [
			multimonNgOptionsSchema,
			dsdFmeOptionsSchema,
			direwolfOptionsSchema,
		]) {
			expect(
				schema.safeParse({ channelsHz: list(DECODER_CHANNELS_HZ_MAX) }).success,
			).toBe(true)
			expect(
				schema.safeParse({ channelsHz: list(DECODER_CHANNELS_HZ_MAX + 1) })
					.success,
			).toBe(false)
		}
	})
})
