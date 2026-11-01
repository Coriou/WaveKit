/**
 * The ACARS and VDL2 default channels (one source for the adapters, the catalogue and the ambient
 * targets) and the ACARS AM channel filter: its arithmetic, and its rate bound at and just past it.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	ACARS_CARRIER_TOLERANCE_HZ,
	ACARS_CHANNEL_BANDWIDTH_HZ,
	ACARS_CHANNEL_TRANSITION_HZ,
	ACARS_CHANNEL_MIN_RATE_HZ,
	ACARS_FRONT_BANDWIDTH_HZ,
	ACARS_OCCUPIED_HALF_HZ,
	AcarsdecDecoder,
	acarsChannelFilterStage,
	acarsdecDemodConfig,
} from "../../../src/decoders/builtin/acarsdec.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import { BAND_REGIONS } from "../../../src/decoders/band-region.js"
import { CATALOGUE_DEFAULT_OPTIONS } from "../../../src/decoders/enablement/catalogue.js"
import {
	ACARS_DEFAULT_CHANNELS_HZ,
	acarsDefaultChannelsHz,
} from "../../../src/decoders/options/acarsdec.js"
import {
	DUMPVDL2_BOUNDS,
	VDL2_COMMON_SIGNALLING_HZ,
	VDL2_REGION_CHANNELS_HZ,
	vdl2DefaultChannelsHz,
} from "../../../src/decoders/options/dumpvdl2.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
const config = (type: string): DecoderConfig =>
	({ id: type, type, enabled: true, options: {} }) as unknown as DecoderConfig

describe("ACARS AM channel", () => {
	it("is one block plus the carrier tolerance at 137 MHz: 2 × (3 600 + 1 000) = 9 200 Hz", () => {
		expect(ACARS_OCCUPIED_HALF_HZ).toBe(2_400 + 2_400 / 2)
		// aircraft 5 ppm + receiver 1 ppm + Doppler at 250 m/s, at 137 MHz
		const tolerance = 137e6 * 5e-6 + 137e6 * 1e-6 + (137e6 * 250) / 299_792_458
		expect(Math.round(tolerance)).toBe(936)
		expect(ACARS_CARRIER_TOLERANCE_HZ).toBeGreaterThanOrEqual(tolerance)
		expect(ACARS_CARRIER_TOLERANCE_HZ).toBe(1_000)
		expect(ACARS_CHANNEL_BANDWIDTH_HZ).toBe(9_200)
		// 8 kHz would leave less margin than the aircraft transmitter alone may be off
		expect(8_000 / 2 - ACARS_OCCUPIED_HALF_HZ).toBeLessThan(137e6 * 5e-6)
		// stop edge 5 600 Hz: short of an 8.33 kHz neighbour
		expect(ACARS_CHANNEL_BANDWIDTH_HZ / 2 + ACARS_CHANNEL_TRANSITION_HZ).toBe(
			5_600,
		)
		expect(acarsdecDemodConfig(2_400_000).bandwidth).toBe(
			ACARS_FRONT_BANDWIDTH_HZ,
		)
	})

	it("leaves the receiver about 2 ppm: 201 Hz flat, 601 Hz to the −3 dB point at 5 000 Hz", () => {
		const tx = 137e6 * 5e-6
		const doppler = (137e6 * 250) / 299_792_458
		const flat = ACARS_CHANNEL_BANDWIDTH_HZ / 2 - ACARS_OCCUPIED_HALF_HZ
		expect(Math.round(flat - tx - doppler)).toBe(201)
		expect(Math.round(5_000 - ACARS_OCCUPIED_HALF_HZ - tx - doppler)).toBe(601)
		expect(((flat - tx - doppler) / 137e6) * 1e6).toBeLessThan(2)
	})

	it("is a bounded firdecimate 1 with its −6 dB cutoff at 5 100 Hz and a 1 000 Hz transition, from 11 200 Hz", () => {
		expect(ACARS_CHANNEL_MIN_RATE_HZ).toBe(2 * 5_600)
		// 24 kHz: csdr builds floor(4 / 0.041667) | 1 = 95 taps
		expect(acarsChannelFilterStage(24_000)).toBe(
			"csdr firdecimate 1 0.041667 --cutoff 0.212500",
		)
		expect(acarsChannelFilterStage(48_000)).toBe(
			"csdr firdecimate 1 0.020833 --cutoff 0.106250",
		)
		// at the bound: the 5 600 Hz stop edge exactly at Nyquist
		expect(acarsChannelFilterStage(11_200)).toBe(
			"csdr firdecimate 1 0.089286 --cutoff 0.455357",
		)
		// just past it, and at rates that are not finite: no stage, never a throw
		for (const rate of [11_199, 10_000, 0, -24_000, Number.NaN, Infinity])
			expect(acarsChannelFilterStage(rate)).toBeNull()
	})
})

const pipelineOf = (decoder: AcarsdecDecoder): string => {
	const [, pipeline] = (decoder as unknown as { getArgs(): string[] }).getArgs()
	return pipeline ?? ""
}

type FrontStages = {
	convert: string | null
	shift: string | null
	decimate: string | null
}

const frontOf = (decoder: AcarsdecDecoder, rateHz: number): FrontStages =>
	(
		decoder as unknown as {
			buildIqFrontStages(
				config: ReturnType<typeof acarsdecDemodConfig>,
				inputSampleRate: number,
				decimation: number,
			): FrontStages
		}
	).buildIqFrontStages(
		acarsdecDemodConfig(rateHz),
		rateHz,
		Math.max(1, Math.round(rateHz / 24_000)),
	)

const acars = (
	options: Record<string, unknown>,
	log: pino.Logger = logger,
): AcarsdecDecoder =>
	new AcarsdecDecoder(
		{
			id: "acarsdec",
			type: "acarsdec",
			enabled: true,
			options,
		} as unknown as DecoderConfig,
		log,
	)

/** A warn-level logger whose records the test reads back. */
const capture = () => {
	const records: Array<Record<string, unknown>> = []
	const log = pino(
		{ level: "warn" },
		{
			write: (line: string) => {
				records.push(JSON.parse(line) as Record<string, unknown>)
			},
		},
	)
	return { log, records }
}

describe("ACARS channelFilter (opt-in)", () => {
	it("is off by default: the 25 kHz front feeds the envelope detector", () => {
		for (const options of [{}, { channelFilter: false }])
			expect(pipelineOf(acars(options))).toContain(
				"csdr firdecimate 100 0.002500 --cutoff 0.3750 | csdr amdemod",
			)
	})

	it("on: its own stage after the shared 25 kHz front and before the envelope detector", () => {
		expect(pipelineOf(acars({ channelFilter: true }))).toContain(
			"csdr firdecimate 100 0.002500 --cutoff 0.3750 | csdr firdecimate 1 0.041667 --cutoff 0.212500 | csdr amdemod",
		)
		expect(
			pipelineOf(
				acars({
					channelFilter: true,
					inputIqFormat: "cf32",
					inputSampleRate: 24_000,
				}),
			).startsWith(
				"csdr firdecimate 1 0.041667 --cutoff 0.212500 | csdr amdemod",
			),
		).toBe(true)
	})

	it("never puts two commands in one stage", () => {
		const variants: Array<[Record<string, unknown>, number]> = [
			[{}, 2_400_000],
			[{ channelFilter: true }, 2_400_000],
			[{ channelFilter: true }, 2_048_000],
			[{ channelFilter: true, offsetHz: 50_000 }, 2_400_000],
			[
				{ channelFilter: true, inputIqFormat: "cf32", inputSampleRate: 24_000 },
				24_000,
			],
			[
				{ channelFilter: true, inputIqFormat: "cf32", inputSampleRate: 48_000 },
				48_000,
			],
		]
		for (const [options, rate] of variants) {
			const front = frontOf(acars({ inputSampleRate: rate, ...options }), rate)
			for (const stage of Object.values(front))
				if (stage !== null) expect(stage).not.toContain("|")
		}
	})

	it("below 11 200 Hz is left out with one log line, never a throw", () => {
		const { log, records } = capture()
		const decoder = acars(
			{ channelFilter: true, inputIqFormat: "cf32", inputSampleRate: 11_199 },
			log,
		)
		expect(() => pipelineOf(decoder)).not.toThrow()
		expect(pipelineOf(decoder).startsWith("csdr amdemod | ")).toBe(true)
		const omitted = records.filter(r => r["reason"] === "rate")
		expect(omitted).toHaveLength(1)
		expect(omitted[0]).toMatchObject({ reason: "rate", minimumRateHz: 11_200 })
		// at the bound the stage is built
		expect(
			pipelineOf(
				acars({
					channelFilter: true,
					inputIqFormat: "cf32",
					inputSampleRate: 11_200,
				}),
			).startsWith(
				"csdr firdecimate 1 0.089286 --cutoff 0.455357 | csdr amdemod",
			),
		).toBe(true)
	})

	it("raw IQ with offsetHz has no free stage: left out with one log line", () => {
		const { log, records } = capture()
		const decoder = acars({ channelFilter: true, offsetHz: 50_000 }, log)
		const pipeline = pipelineOf(decoder)
		pipelineOf(decoder)
		expect(pipeline).toMatch(/^csdr convert -i char -o float \| csdr shift /)
		expect(pipeline).toContain("--cutoff 0.3750 | csdr amdemod")
		expect(pipeline).not.toContain("firdecimate 1 ")
		expect(records.filter(r => r["reason"] === "slot")).toHaveLength(1)
	})

	it("a value that is not a boolean is ignored with a key-only warning", () => {
		const { log, records } = capture()
		const decoder = acars({ channelFilter: "yes" }, log)
		expect(pipelineOf(decoder)).not.toContain("firdecimate 1 ")
		const warned = records.filter(r => r["key"] === "channelFilter")
		expect(warned).toHaveLength(1)
		expect(warned[0]).toMatchObject({ issue: "invalid" })
		expect(JSON.stringify(warned)).not.toContain("yes")
	})
})

describe("default channels", () => {
	it("VDL2: the EU list of Commission Implementing Regulation (EU) No 1079/2012, elsewhere the legacy default", () => {
		expect(VDL2_COMMON_SIGNALLING_HZ).toBe(136_975_000)
		expect(VDL2_REGION_CHANNELS_HZ.EU).toEqual([
			136_725_000, 136_775_000, 136_825_000, 136_875_000, 136_925_000,
			136_975_000,
		])
		for (const region of BAND_REGIONS) {
			const list = vdl2DefaultChannelsHz(region)
			expect(list).toContain(VDL2_COMMON_SIGNALLING_HZ)
			expect(list.length).toBeLessThanOrEqual(DUMPVDL2_BOUNDS.maxFrequencies)
			for (const hz of list) expect(hz % 25_000).toBe(0)
			// one dumpvdl2 window: span + 50 kHz guard fits the 512 kHz channel of a 1.024 Msps
			// capture, 512 000 × 0.95 = 486 400 Hz (EU 300 kHz, legacy 375 kHz)
			expect(
				Math.max(...list) - Math.min(...list) + 50_000,
			).toBeLessThanOrEqual(486_400)
			expect(CATALOGUE_DEFAULT_OPTIONS(region).dumpvdl2).toEqual({
				frequencies: [...list],
			})
		}
		// No region and every non-EU region keep the legacy default: no setup loses coverage.
		expect(vdl2DefaultChannelsHz()).toEqual([
			136_650_000, 136_700_000, 136_975_000,
		])
		for (const region of BAND_REGIONS)
			if (region !== "EU")
				expect(vdl2DefaultChannelsHz(region)).toEqual(vdl2DefaultChannelsHz())
		expect(
			new Dumpvdl2Decoder(config("dumpvdl2"), logger).getBandDeclaration(),
		).toEqual({
			intrinsic: {
				targetsHz: [...vdl2DefaultChannelsHz()],
				basis: "decoder-default",
			},
		})
	})

	it("ACARS: the EU catalogue list, else the adapter default, from one table", () => {
		expect(acarsDefaultChannelsHz()).toEqual(ACARS_DEFAULT_CHANNELS_HZ)
		expect(acarsDefaultChannelsHz("US")).toEqual(ACARS_DEFAULT_CHANNELS_HZ)
		for (const region of BAND_REGIONS)
			expect(CATALOGUE_DEFAULT_OPTIONS(region).acarsdec).toEqual({
				frequencies: [...acarsDefaultChannelsHz(region)],
			})
		expect(acarsDefaultChannelsHz("EU")).toEqual(
			expect.arrayContaining([...ACARS_DEFAULT_CHANNELS_HZ]),
		)
	})
})
