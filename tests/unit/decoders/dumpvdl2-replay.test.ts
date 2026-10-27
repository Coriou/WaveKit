import { it, expect } from "vitest"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { LORA_REGION_RANGES_HZ } from "../../../src/decoders/band-defaults.js"
import { configureNativeReplayDecoder } from "../../../src/core/iq-capture/replay-decoder.js"
import {
	buildDecoderArgs,
	parseLoraMeshtasticOptions,
} from "../../../src/decoders/builtin/lora-meshtastic.js"
import { buildDumpvdl2ReplayArgs } from "../../../src/decoders/builtin/dumpvdl2.js"
import { DUMPVDL2_BOUNDS } from "../../../src/decoders/options/dumpvdl2.js"

it("builds the pinned dumpvdl2 U8 stdin command at oversample one", () => {
	expect(buildDumpvdl2ReplayArgs(1)).toEqual([
		"--iq-file",
		"-",
		"--sample-format",
		"U8",
		"--oversample",
		"1",
		"--centerfreq",
		"1",
		"--output",
		"decoded:json:file:path=-",
		"1",
	])
	const { min, max } = DUMPVDL2_BOUNDS.frequencyHz
	for (const center of [min, max])
		expect(buildDumpvdl2ReplayArgs(center)).toContain(String(center))
	for (const center of [min - 1, max + 1, NaN, Infinity, 1.5])
		expect(() => buildDumpvdl2ReplayArgs(center)).toThrow()
})

it("feeds the LoRa script U8 at an exact integer multiple of its bandwidth", () => {
	const args = buildDecoderArgs(
		parseLoraMeshtasticOptions({
			region: "EU_868",
			preset: "LongModerate",
			frequency: 1,
			channelKey: "AQ==",
			oversampling: 2,
			inputSampleRate: 250_000,
		}),
	)
	expect(args.slice(1, 9)).toEqual([
		"--bw",
		"125000",
		"--sf",
		"11",
		"--cr",
		"8",
		"--samp-rate",
		"250000",
	])
})

it("configures native replay without live channelization or a second resampler", () => {
	const base: DecoderConfig = {
		id: "offline",
		type: "dumpvdl2",
		enabled: true,
		options: {},
	}
	const vdl = configureNativeReplayDecoder(base, 1, 105_000)
	expect(vdl).toMatchObject({
		useChannelizer: false,
		options: {
			inputSampleRate: 105_000,
			targetSampleRate: 105_000,
			inputCenterFreq: 1,
			followCenter: true,
		},
	})
	expect(() => configureNativeReplayDecoder(base, 1, 104_999)).toThrow()
	expect(() => configureNativeReplayDecoder(base, 1, 105_001)).toThrow()
	const hz = LORA_REGION_RANGES_HZ.EU_868.minHz
	const lora = configureNativeReplayDecoder(
		{ ...base, type: "lora-meshtastic" },
		hz,
		250_000,
	)
	expect(lora?.useChannelizer).toBe(false)
	const options = parseLoraMeshtasticOptions(lora?.options ?? {})
	expect(options.effectiveTargetRate).toBe(250_000)
	expect(options.inputSampleRate).toBe(250_000)
	expect(() =>
		configureNativeReplayDecoder(
			{ ...base, type: "lora-meshtastic" },
			NaN,
			250_000,
		),
	).toThrow()
})
