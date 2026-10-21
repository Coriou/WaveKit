import { expect, it } from "vitest"
import pino from "pino"
import type { DecoderFactory } from "../../../../src/decoders/registry.js"
import type { BaseDecoder } from "../../../../src/decoders/base-decoder.js"
import { createAcarsdecDecoder } from "../../../../src/decoders/builtin/acarsdec.js"
import { createAisCatcherDecoder } from "../../../../src/decoders/builtin/ais-catcher.js"
import { createDirewolfDecoder } from "../../../../src/decoders/builtin/direwolf.js"
import { createDsdFmeDecoder } from "../../../../src/decoders/builtin/dsd-fme.js"
import { createDumpvdl2Decoder } from "../../../../src/decoders/builtin/dumpvdl2.js"
import { createLoraMeshtasticDecoder } from "../../../../src/decoders/builtin/lora-meshtastic.js"
import { createMultimonDecoder } from "../../../../src/decoders/builtin/multimon-ng.js"
import { createReadsbDecoder } from "../../../../src/decoders/builtin/readsb.js"
import { createRtl433Decoder } from "../../../../src/decoders/builtin/rtl433.js"
const logger = pino({ level: "silent" })
// src/decoders/registry.ts has no default-registry helper; src/index.ts registers these same factories inline.
const FACTORIES: Record<string, DecoderFactory> = {
	acarsdec: createAcarsdecDecoder,
	"ais-catcher": createAisCatcherDecoder,
	direwolf: createDirewolfDecoder,
	"dsd-fme": createDsdFmeDecoder,
	dumpvdl2: createDumpvdl2Decoder,
	"lora-meshtastic": createLoraMeshtasticDecoder,
	"multimon-ng": createMultimonDecoder,
	readsb: createReadsbDecoder,
	rtl433: createRtl433Decoder,
}
// lora-meshtastic validates its options strictly and has no defaults for these.
const REQUIRED_OPTIONS: Record<string, Record<string, unknown>> = {
	"lora-meshtastic": {
		region: "EU_868",
		preset: "LongFast",
		frequency: 869_525_000,
		channelKey: "AQ==",
	},
}
/** Builds a built-in decoder straight from its factory (no registry, no spawn). Tasks 28–31 reuse it. */
const make = (type: string, options: Record<string, unknown> = {}) => {
	const factory = FACTORIES[type]
	if (!factory) throw new Error(`no factory for ${type}`)
	return factory(
		{
			id: `t-${type}`,
			type,
			enabled: true,
			options: {
				inputSampleRate: 2_048_000,
				inputCenterFreq: 162e6,
				...REQUIRED_OPTIONS[type],
				...options,
			},
		},
		logger,
	)
}

it.each(Object.keys(FACTORIES))(
	"%s declares its physical reach without spawning",
	type => {
		const decoder = make(type) as BaseDecoder
		expect(decoder.reach()).toBe(
			type === "readsb"
				? "raw"
				: type === "lora-meshtastic"
					? "centre"
					: "channel",
		)
		expect(decoder.getStatus().running).toBe(false)
	},
)

it("bases default to raw when channel support is absent", async () => {
	const { BaseDecoder } =
		await import("../../../../src/decoders/base-decoder.js")
	const { AudioDemodDecoder } =
		await import("../../../../src/decoders/audio-demod-decoder.js")
	const { IqDecimateDecoder } =
		await import("../../../../src/decoders/iq-decimate-decoder.js")
	expect(BaseDecoder.prototype.reach.call({})).toBe("raw")
	for (const base of [AudioDemodDecoder, IqDecimateDecoder]) {
		expect(
			base.prototype.reach.call({ channelizerSupported: () => false }),
		).toBe("raw")
	}
})
