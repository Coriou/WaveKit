/**
 * Live demodulator pipeline plan: exact CSDR stage strings.
 */

import { describe, expect, it } from "vitest"
import {
	LiveDemodConfigSchema,
	type LiveDemodConfig,
} from "../../../src/config.js"
import {
	liveDemodRates,
	planLiveDemodPipeline,
} from "../../../src/core/live-demod-pipeline.js"
import { DISABLED_CSDR_BUFFER_POLICY } from "../../../src/decoders/csdr-buffers.js"

const silent = { info: () => undefined }

function plan(overrides: Partial<LiveDemodConfig>, iqSampleRate = 2_048_000) {
	const config = LiveDemodConfigSchema.parse(overrides)
	const rates = liveDemodRates(iqSampleRate, config)
	return planLiveDemodPipeline({
		config,
		iqSampleRate,
		iqFormat: "U8_IQ",
		decimation: rates.decimation,
		logger: silent,
		bufferPolicy: DISABLED_CSDR_BUFFER_POLICY,
	})
}

const NFM_FRONT = [
	"csdr convert -i char -o float",
	"csdr firdecimate 82 0.003046 --cutoff 0.3751",
]

describe("live demodulator defaults", () => {
	it("defaults to NFM gain 2, no I/Q dcblock and no offset", () => {
		const config = LiveDemodConfigSchema.parse({})
		expect(config.gain).toBe(2)
		expect(config.iqDcBlock).toBe(false)
		expect(config.offsetHz).toBe(0)
	})

	it("keeps the 25 kHz demod rate plan", () => {
		const config = LiveDemodConfigSchema.parse({})
		expect(liveDemodRates(2_048_000, config)).toEqual({
			iqSampleRate: 2_048_000,
			decimation: 82,
			effectiveSampleRate: 2_048_000 / 82,
		})
	})
})

describe("planLiveDemodPipeline", () => {
	it("builds the default NFM chain", () => {
		const result = plan({})
		expect(result.frontStages).toEqual(NFM_FRONT)
		expect(result.backStages).toEqual([
			"csdr fmdemod",
			"csdr dcblock",
			"csdr gain 2",
			"csdr limit",
			"csdr convert -i float -o s16",
		])
		expect(result.front).toBe(NFM_FRONT.join(" | "))
		expect(result.sox).toBeNull()
		expect(result.channelSampleRate).toBeCloseTo(24_975.6098, 3)
		expect(result.warnings).toEqual([])
	})

	it("shifts the channel before decimation when offsetHz is set", () => {
		const result = plan({ offsetHz: 6000 })
		expect(result.frontStages).toEqual([
			"csdr convert -i char -o float",
			"csdr shift -0.0029296875",
			"csdr firdecimate 82 0.003046 --cutoff 0.3751",
		])
	})

	it("rejects an offset that leaves the capture", () => {
		expect(() => plan({ offsetHz: 1_100_000 })).toThrow(/offsetHz/)
	})

	it("ignores iqDcBlock with a warning instead of corrupting I/Q", () => {
		const result = plan({ iqDcBlock: true })
		expect(result.frontStages).toEqual(NFM_FRONT)
		expect(result.warnings.join(" ")).toMatch(/iqDcBlock/)
	})

	it("adds crash-free NFM de-emphasis right after the discriminator", () => {
		const result = plan({ deEmphasis: true })
		expect(result.backStages).toEqual([
			"csdr fmdemod",
			"csdr deemphasis --wfm 24976 0.00075",
			"csdr dcblock",
			"csdr gain 2",
			"csdr limit",
			"csdr convert -i float -o s16",
		])
	})

	it("builds WFM with an integer-rate de-emphasis", () => {
		const result = plan({
			modulation: "wfm",
			bandwidth: 150_000,
			deEmphasis: true,
		})
		expect(result.frontStages).toEqual([
			"csdr convert -i char -o float",
			"csdr firdecimate 7 0.034807 --cutoff 0.3782",
		])
		expect(result.backStages).toEqual([
			"csdr fmdemod",
			"csdr deemphasis --wfm 292571 0.00005",
			"csdr dcblock",
			"csdr gain 2",
			"csdr limit",
			"csdr convert -i float -o s16",
		])
	})

	it("builds AM with AGC headroom for the default gain", () => {
		const result = plan({ modulation: "am", bandwidth: 10_000 })
		expect(result.frontStages).toEqual([
			"csdr convert -i char -o float",
			"csdr firdecimate 102 0.002441 --cutoff 0.3735",
		])
		expect(result.backStages).toEqual([
			"csdr amdemod",
			"csdr agc -f float -p fast -r 0.4",
			"csdr dcblock",
			"csdr gain 2",
			"csdr limit",
			"csdr convert -i float -o s16",
		])
	})

	it("does not put the squelch in the CSDR chain (it runs on channel IQ in Node)", () => {
		expect(plan({ squelch: -50 }).backStages).toEqual(plan({}).backStages)
		expect(plan({ squelch: -50 }).frontStages).toEqual(NFM_FRONT)
	})

	it("keeps the low-pass in CSDR and hands high-pass to sox", () => {
		expect(plan({ lowPass: 3000 }).backStages).toEqual([
			"csdr fmdemod",
			"csdr lowpass -f float 0.1201",
			"csdr dcblock",
			"csdr gain 2",
			"csdr limit",
			"csdr convert -i float -o s16",
		])
		const sox = plan({ noiseReduction: "voice" })
		expect(sox.backStages).toEqual([
			"csdr fmdemod",
			"csdr dcblock",
			"csdr gain 2",
			"csdr limit",
		])
		expect(sox.sox).toBe(
			`sox -t raw -r ${2_048_000 / 82} -e floating-point -b 32 -c 1 - -t raw -r ${2_048_000 / 82} -e signed -b 16 -c 1 - highpass 300 lowpass 3000`,
		)
		expect(sox.back.endsWith(` | ${sox.sox}`)).toBe(true)
	})

	it("emits float audio without the final conversion", () => {
		expect(plan({ audioFormat: "f32le" }).backStages.at(-1)).toBe("csdr limit")
	})

	it("reads S16 IQ sources", () => {
		const config = LiveDemodConfigSchema.parse({})
		const result = planLiveDemodPipeline({
			config,
			iqSampleRate: 2_400_000,
			iqFormat: "S16_IQ",
			decimation: 96,
			logger: silent,
			bufferPolicy: DISABLED_CSDR_BUFFER_POLICY,
		})
		expect(result.frontStages[0]).toBe("csdr convert -i s16 -o float")
	})
})
