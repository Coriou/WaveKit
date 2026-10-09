import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import pino from "pino"
import type { DecoderFactory } from "../../../src/decoders/registry.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import {
	AcarsdecDecoder,
	createAcarsdecDecoder,
} from "../../../src/decoders/builtin/acarsdec.js"
import { createAisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import { createDirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"
import {
	DsdFmeDecoder,
	createDsdFmeDecoder,
} from "../../../src/decoders/builtin/dsd-fme.js"
import {
	Dumpvdl2Decoder,
	createDumpvdl2Decoder,
} from "../../../src/decoders/builtin/dumpvdl2.js"
import { createLoraMeshtasticDecoder } from "../../../src/decoders/builtin/lora-meshtastic.js"
import { createMultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import { createReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"
import { createRtl433Decoder } from "../../../src/decoders/builtin/rtl433.js"
import {
	iqChannelRequest,
	readChannelHz,
} from "../../../src/decoders/iq-decimate-decoder.js"
import { audioChannelRequest } from "../../../src/decoders/audio-demod-decoder.js"

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
const pipelineOf = (decoder: unknown) =>
	(decoder as { buildPipelineCommand(): string }).buildPipelineCommand()

const config = (
	type: string,
	options: Record<string, unknown>,
): DecoderConfig => ({
	id: `t-${type}`,
	type,
	enabled: true,
	options: { inputSampleRate: 2_048_000, ...options },
})

// Test-only migrations: flip the flag a migration task (28–31) flips for real.
class ChannelisedDsdFme extends DsdFmeDecoder {
	protected override channelizerSupported(): boolean {
		return true
	}
}
class ChannelisedAcarsdec extends AcarsdecDecoder {
	protected override channelizerSupported(): boolean {
		return true
	}
}
class ChannelisedDumpvdl2 extends Dumpvdl2Decoder {
	protected override channelizerSupported(): boolean {
		return true
	}
}

describe("channel requests (addendum §1, §2)", () => {
	it("derives the default IQ passband from the output rate", () => {
		// AIS: the channel centre is the A/B pair centre 162.000 MHz (AIS-catcher expects ±25 kHz around it).
		expect(
			iqChannelRequest(
				{
					targetSampleRate: 384_000,
					inputSampleRate: 2_048_000,
					filterTransition: 0.05,
					channelHz: 162_000_000,
				},
				{ sampleRateHz: 2_048_000, centerHz: 161.9e6 },
			),
		).toEqual({
			centerHz: 162_000_000,
			bandwidthHz: 364_800,
			transitionHz: 9_600,
			outputRateHz: 384_000,
			format: "cu8",
		})
		expect(
			iqChannelRequest(
				{ targetSampleRate: 250_000, inputSampleRate: 2_048_000 },
				{ sampleRateHz: 2_048_000, centerHz: 433.92e6 },
			).centerHz,
		).toBe(433.92e6)
	})

	it("derives cf32 audio requests at the exact demod rate", () => {
		const r = audioChannelRequest(
			{
				bandwidth: 12_500,
				sampleRate: 22_050,
				demodSampleRate: 48_000,
				inputSampleRate: 2_048_000,
				deEmphasis: false,
				filterTransition: 0.012,
			},
			{ sampleRateHz: 2_048_000, centerHz: 1e8 },
		)
		expect(r).toMatchObject({ outputRateHz: 48_000, format: "cf32" })
		// 48000 * (1 - 0.012) and 48000 * 0.012 / 2 are not exact in binary floating point
		expect(r.bandwidthHz).toBeCloseTo(47_424, 6)
		expect(r.transitionHz).toBeCloseTo(288, 6)
	})

	it("derives the passband from the matched channel filter when filterTransition is unset (delta E9)", () => {
		// dsd-fme: raw path is `firdecimate 43 0.003052 --cutoff 0.1968`, flat to ±6 250 Hz, stopband at 12 500 Hz
		expect(
			audioChannelRequest(
				{
					bandwidth: 12_500,
					sampleRate: 48_000,
					demodSampleRate: 48_000,
					inputSampleRate: 2_048_000,
					deEmphasis: false,
				},
				{ sampleRateHz: 2_048_000, centerHz: 1e8 },
			),
		).toEqual({
			centerHz: 1e8,
			bandwidthHz: 12_500,
			transitionHz: 6_250,
			outputRateHz: 48_000,
			format: "cf32",
		})
		// acarsdec: 25 kHz channel at 24 kHz, stopband clamped to the 12 kHz Nyquist
		expect(
			audioChannelRequest(
				{
					modulation: "am",
					bandwidth: 25_000,
					sampleRate: 12_000,
					demodSampleRate: 24_000,
					inputSampleRate: 2_400_000,
					deEmphasis: false,
				},
				{ sampleRateHz: 2_400_000, centerHz: 131.55e6 },
			),
		).toMatchObject({ bandwidthHz: 12_000, transitionHz: 6_000 })
	})

	it("reads options.channelHz only when it is a positive finite number", () => {
		expect(readChannelHz({ channelHz: 162_025_000 })).toBe(162_025_000)
		expect(readChannelHz({})).toBeUndefined()
		expect(readChannelHz({ channelHz: "162e6" })).toBeUndefined()
		expect(readChannelHz({ channelHz: -1 })).toBeUndefined()
		expect(readChannelHz({ channelHz: Number.NaN })).toBeUndefined()
	})

	it("keeps every built-in non-channelisable until its migration task", () => {
		for (const type of [
			"ais-catcher",
			"dumpvdl2",
			"rtl433",
			"direwolf",
			"multimon-ng",
			"dsd-fme",
			"acarsdec",
			"lora-meshtastic",
			"readsb",
		]) {
			expect(
				make(type).getChannelRequest?.({
					sampleRateHz: 2_048_000,
					centerHz: 162e6,
				}),
			).toBeUndefined()
		}
	})

	it("cf32 input drops the leading convert and firdecimate from the audio tail", () => {
		const cmd = pipelineOf(
			make("multimon-ng", { inputSampleRate: 48_000, inputIqFormat: "cf32" }),
		)
		expect(cmd).not.toContain("csdr convert -i char -o float")
		expect(cmd).not.toContain("firdecimate")
		expect(cmd).toMatch(
			/^(csdr agc -f complex|csdr fmdemod)|\| ?csdr (agc -f complex|fmdemod)/,
		)
		// multimon-ng's IQ AGC stays and now runs on the channel IQ (addendum §3 risk)
		expect(
			cmd.startsWith("csdr agc -f complex -p slow -r 0.7 | csdr fmdemod"),
		).toBe(true)
		expect(pipelineOf(make("multimon-ng"))).toContain(
			"csdr convert -i char -o float",
		)
	})

	it("dsd-fme cf32 input starts at fmdemod with the voice A/B back chain (delta E8)", () => {
		const script = readFileSync(
			fileURLToPath(
				new URL("../../../scripts/dsd-fme-voice-ab.mjs", import.meta.url),
			),
			"utf8",
		)
		const backChain = /export const BACK_CHAIN = "([^"]+)"/.exec(script)?.[1]
		expect(backChain).toBeDefined()
		const cmd = pipelineOf(
			make("dsd-fme", { inputSampleRate: 48_000, inputIqFormat: "cf32" }),
		)
		expect(
			cmd.startsWith(
				`csdr fmdemod | ${backChain} | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t wav -r 48000 - | dsd-fme`,
			),
		).toBe(true)
		for (const stage of ["convert -i char", "shift", "dcblock", "firdecimate"])
			expect(cmd).not.toContain(stage)
	})

	it("never shifts or range-checks offsetHz on cf32 input (delta E8)", () => {
		// At 48 kHz validateChannelOffset would throw for |offset| > 17 750 Hz.
		for (const type of ["dsd-fme", "multimon-ng"]) {
			const cmd = pipelineOf(
				make(type, {
					inputSampleRate: 48_000,
					inputIqFormat: "cf32",
					offsetHz: 300_000,
				}),
			)
			expect(cmd).not.toContain("shift")
		}
		// The raw path still shifts the same offset to DC.
		expect(pipelineOf(make("dsd-fme", { offsetHz: 6000 }))).toContain(
			"csdr shift",
		)
	})

	it("absorbs offsetHz into the channel centre (delta E7)", () => {
		const options = { offsetHz: 6000 }
		const raw = pipelineOf(make("dsd-fme", options))
		const d = new ChannelisedDsdFme(config("dsd-fme", options), logger)
		expect(
			d.getChannelRequest({ sampleRateHz: 2_048_000, centerHz: 1e8 }),
		).toEqual({
			centerHz: 100_006_000,
			bandwidthHz: 12_500,
			transitionHz: 6_250,
			outputRateHz: 48_000,
			format: "cf32",
		})
		// Pure: computing the request leaves the raw pipeline untouched.
		expect(pipelineOf(d)).toBe(raw)
	})

	it("lets channelHz win over offsetHz with one warning (delta E7)", () => {
		const warn = vi.fn()
		const spyLogger = Object.assign(pino({ level: "silent" }), {
			child: () => spyLogger,
			warn,
		})
		const d = new ChannelisedDsdFme(
			config("dsd-fme", { offsetHz: 6000, channelHz: 100_025_000 }),
			spyLogger,
		)
		const input = { sampleRateHz: 2_048_000, centerHz: 1e8 }
		expect(d.getChannelRequest(input)).toMatchObject({
			centerHz: 100_025_000,
		})
		expect(d.getChannelRequest(input)).toMatchObject({
			centerHz: 100_025_000,
		})
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("requests offset 0 when the capture centre is unknown (PF12)", () => {
		const d = new ChannelisedDsdFme(
			config("dsd-fme", { offsetHz: 6000 }),
			logger,
		)
		expect(d.getChannelRequest({ sampleRateHz: 2_048_000 })).toMatchObject({
			centerHz: 0,
		})
	})

	it("acarsdec requests its single frequency and rejects several without channelHz", () => {
		const one = new ChannelisedAcarsdec(
			config("acarsdec", { frequencies: [131_550_000] }),
			logger,
		)
		expect(
			one.getChannelRequest({ sampleRateHz: 2_400_000, centerHz: 131.6e6 }),
		).toEqual({
			centerHz: 131_550_000,
			bandwidthHz: 12_000,
			transitionHz: 6_000,
			outputRateHz: 24_000,
			format: "cf32",
		})
		const two = new ChannelisedAcarsdec(config("acarsdec", {}), logger)
		expect(
			two.getChannelRequest({ sampleRateHz: 2_400_000, centerHz: 131.6e6 }),
		).toHaveProperty("invalid")
		const pinned = new ChannelisedAcarsdec(
			config("acarsdec", { channelHz: 131_725_000 }),
			logger,
		)
		expect(
			pinned.getChannelRequest({ sampleRateHz: 2_400_000, centerHz: 131.6e6 }),
		).toMatchObject({ centerHz: 131_725_000 })
	})

	it("dumpvdl2 requests the span midpoint, wide enough for every frequency", () => {
		const d = new ChannelisedDumpvdl2(
			config("dumpvdl2", {
				// 1 MHz span + 50 kHz exceeds the default 997 500 Hz passband
				frequencies: [136_000_000, 137_000_000],
				targetSampleRate: 1_050_000,
			}),
			logger,
		)
		expect(
			d.getChannelRequest({ sampleRateHz: 2_048_000, centerHz: 136.5e6 }),
		).toEqual({
			centerHz: 136_500_000,
			bandwidthHz: 1_050_000,
			transitionHz: 26_250,
			outputRateHz: 1_050_000,
			format: "cu8",
		})
		const follow = new ChannelisedDumpvdl2(
			config("dumpvdl2", { followCenter: true }),
			logger,
		)
		expect(
			follow.getChannelRequest({ sampleRateHz: 2_048_000, centerHz: 136.5e6 }),
		).toMatchObject({ centerHz: 136.5e6 })
	})
})
