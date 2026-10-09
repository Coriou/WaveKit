/**
 * Band-aware suspension: what each built-in instance declares it must receive.
 * Unknown (no configured or protocol-fixed frequency) must stay undefined so
 * the manager never suspends it for band.
 */
import { describe, expect, it } from "vitest"
import pino from "pino"
import { AcarsdecDecoder } from "../../../src/decoders/builtin/acarsdec.js"
import { AisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import { DirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import { LoraMeshtasticDecoder } from "../../../src/decoders/builtin/lora-meshtastic.js"
import { MultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import { ReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"
import { Rtl433Decoder } from "../../../src/decoders/builtin/rtl433.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })

function config(
	type: string,
	options: Record<string, unknown>,
	extra: Partial<DecoderConfig> = {},
): DecoderConfig {
	return { id: type, type, enabled: true, options, ...extra }
}

describe("centre demodulators without a protocol frequency", () => {
	const cases = [
		{
			name: "multimon-ng",
			make: (o: Record<string, unknown>, e?: Partial<DecoderConfig>) =>
				new MultimonDecoder(
					config("multimon-ng", { modes: ["POCSAG1200"], ...o }, e),
					logger,
				),
		},
		{
			name: "direwolf",
			make: (o: Record<string, unknown>, e?: Partial<DecoderConfig>) =>
				new DirewolfDecoder(config("direwolf", { ...o }, e), logger),
		},
		{
			name: "dsd-fme",
			make: (o: Record<string, unknown>, e?: Partial<DecoderConfig>) =>
				new DsdFmeDecoder(config("dsd-fme", { mode: "dmr", ...o }, e), logger),
		},
		{
			name: "rtl433",
			make: (o: Record<string, unknown>, e?: Partial<DecoderConfig>) =>
				new Rtl433Decoder(config("rtl433", { ...o }, e), logger),
		},
		{
			name: "acarsdec",
			make: (o: Record<string, unknown>, e?: Partial<DecoderConfig>) =>
				new AcarsdecDecoder(config("acarsdec", { ...o }, e), logger),
		},
	]

	for (const { name, make } of cases) {
		it(`${name} is unknown without a configured frequency`, () => {
			expect(make({}).getBandRequirements?.()).toBeUndefined()
		})

		it(`${name} declares its configured frequencies`, () => {
			expect(
				make(
					{},
					{ frequencies: [144_800_000, 144_390_000] },
				).getBandRequirements?.(),
			).toEqual({ targetsHz: [144_800_000, 144_390_000], basis: "configured" })
			expect(make({ frequency: 466_075_000 }).getBandRequirements?.()).toEqual({
				targetsHz: [466_075_000],
				basis: "configured",
			})
		})
	}

	it("acarsdec never declares its metadata-only default list", () => {
		// The built-in [131.55, 131.725] MHz default is not passed to the process.
		const decoder = new AcarsdecDecoder(config("acarsdec", {}), logger)
		expect(decoder.getBandRequirements?.()).toBeUndefined()
	})
})

describe("protocol-fixed decoders", () => {
	it("readsb (stdin) receives 1090 MHz by protocol", () => {
		const decoder = new ReadsbDecoder(
			config("readsb", { outputFormat: "sbs" }),
			logger,
		)
		expect(decoder.getBandRequirements?.()).toEqual({
			targetsHz: [1_090_000_000],
			basis: "protocol",
		})
	})

	it("readsb in rtlTcpHost mode owns its tuner: no declaration", () => {
		const decoder = new ReadsbDecoder(
			config("readsb", { outputFormat: "sbs", rtlTcpHost: "pi.local" }),
			logger,
		)
		expect(decoder.getBandRequirements?.()).toBeUndefined()
	})

	it("ais-catcher receives AIS 1/2 by protocol unless channels are overridden", () => {
		const make = (options: Record<string, unknown>) =>
			new AisCatcherDecoder(
				config("ais-catcher", { outputFormat: "json", ...options }),
				logger,
			)
		expect(make({}).getBandRequirements?.()).toEqual({
			targetsHz: [161_975_000, 162_025_000],
			basis: "protocol",
		})
		expect(
			make({ extraArgs: ["-c", "CD"] }).getBandRequirements?.(),
		).toBeUndefined()
		expect(
			make({ extraArgs: ["-c CD"] }).getBandRequirements?.(),
		).toBeUndefined()
		expect(
			make({ extraArgs: ["-cCD"] }).getBandRequirements?.(),
		).toBeUndefined()
		expect(
			make({ frequencies: [156_775_000] }).getBandRequirements?.(),
		).toEqual({ targetsHz: [156_775_000], basis: "configured" })
	})
})

describe("dumpvdl2", () => {
	it("declares the channel list the process decodes (configured)", () => {
		const decoder = new Dumpvdl2Decoder(
			config("dumpvdl2", {}, { frequencies: [136_725_000, 136_975_000] }),
			logger,
		)
		expect(decoder.getBandRequirements?.()).toEqual({
			targetsHz: [136_725_000, 136_975_000],
			basis: "configured",
		})
	})

	it("declares its built-in channel list, which the process really decodes", () => {
		const decoder = new Dumpvdl2Decoder(config("dumpvdl2", {}), logger)
		expect(decoder.getBandRequirements?.()).toEqual({
			targetsHz: [136_650_000, 136_700_000, 136_975_000],
			basis: "decoder-default",
		})
	})

	it("followCenter: the configured list bounds the band it follows", () => {
		const decoder = new Dumpvdl2Decoder(
			config(
				"dumpvdl2",
				{ followCenter: true, inputCenterFreq: 1_090_000_000 },
				{ frequencies: [136_975_000] },
			),
			logger,
		)
		expect(decoder.getBandRequirements?.()).toEqual({
			targetsHz: [136_975_000],
			basis: "configured",
			followCenter: true,
		})
	})

	it("followCenter without a configured list is unknown", () => {
		const decoder = new Dumpvdl2Decoder(
			config("dumpvdl2", { followCenter: true }),
			logger,
		)
		expect(decoder.getBandRequirements?.()).toBeUndefined()
	})
})

describe("lora-meshtastic", () => {
	const base = {
		region: "EU_868",
		preset: "LongFast",
		frequency: 869_525_000,
		channelKey: "AQ==",
	}

	it("declares its configured frequency", () => {
		const decoder = new LoraMeshtasticDecoder(
			config("lora-meshtastic", base),
			logger,
		)
		expect(decoder.getBandRequirements?.()).toEqual({
			targetsHz: [869_525_000],
			basis: "configured",
		})
	})

	it("followCenter without a declared band list is unknown (it decodes any centre)", () => {
		// The modem decodes the injected centre; options.frequency only seeds it.
		const decoder = new LoraMeshtasticDecoder(
			config("lora-meshtastic", { ...base, followCenter: true }),
			logger,
		)
		decoder.updateOptions({ inputCenterFreq: 868_100_000 })
		expect(decoder.getBandRequirements?.()).toBeUndefined()
	})

	it("followCenter with a top-level frequencies list follows that band", () => {
		const decoder = new LoraMeshtasticDecoder(
			config(
				"lora-meshtastic",
				{ ...base, followCenter: true },
				{ frequencies: [868_100_000, 869_525_000] },
			),
			logger,
		)
		expect(decoder.getBandRequirements?.()).toEqual({
			targetsHz: [868_100_000, 869_525_000],
			basis: "configured",
			followCenter: true,
		})
	})
})
