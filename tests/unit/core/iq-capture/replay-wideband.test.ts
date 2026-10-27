import { narrowestPriors } from "../../../../src/core/scanner/classify/priors.js"
import { bandplansFor } from "../../../../src/core/scanner/bandplan/index.js"
import { describe, it, expect } from "vitest"
import {
	capturePassbandHz,
	captureRateFor,
	replayRateHz,
} from "../../../../src/core/iq-capture/rates.js"
import { replayOutputBytes } from "../../../../src/core/iq-capture/service.js"
import { probeReplayShapes } from "../../../../src/core/iq-capture/shapes.js"
import { REPLAY_INPUT_DECODERS } from "../../../../src/core/scanner/iq-capture-contract.js"
import { IQ_REPLAY_WIDEBAND_MODES } from "../../../../src/core/scanner/replay-plan.js"

describe("wideband replay clocks", () => {
	it("captures LoRa at 192 kHz only when its prior reaches one", () => {
		expect(captureRateFor({ priors: { lora: 1 }, track: null })).toBe(192_000)
		for (const prior of [0, 0.999, NaN, Infinity])
			expect(captureRateFor({ priors: { lora: prior }, track: null })).toBe(
				48_000,
			)
		expect(capturePassbandHz(47_424, 192_000)).toBe(150_000)
		expect(capturePassbandHz(37_500, 192_000)).toBe(150_000)
		expect(capturePassbandHz(37_500.25, 192_000)).toBe(150_000)
		expect(capturePassbandHz(47_424, 96_000)).toBe(47_424)
		expect(capturePassbandHz(47_424, 192_001)).toBe(47_424)
	})
	it("provides shapes and exact decoder clocks", () => {
		const shapes = probeReplayShapes()
		expect(shapes.dumpvdl2).toEqual({
			bandwidthHz: 25_000,
			transitionHz: 5_000,
		})
		expect(shapes["lora-meshtastic"]).toEqual({
			bandwidthHz: 125_000,
			transitionHz: 12_500,
		})
		for (const rate of [48_000, 96_000, 192_000] as const) {
			expect(replayRateHz("dumpvdl2", rate)).toBe(105_000)
			expect(replayOutputBytes(rate * 4 * 8, rate, 105_000)).toBe(
				105_000 * 4 * 8,
			)
		}
		expect(replayRateHz("lora-meshtastic", 192_000)).toBe(250_000)
		expect(replayOutputBytes(97 * 8, 192_000, 250_000)).toBe(127 * 8)
		expect(replayOutputBytes(96 * 8, 192_000, 250_000)).toBe(125 * 8)
		expect(replayOutputBytes(192_000 * 4 * 8, 192_000, 250_000)).toBe(
			250_000 * 4 * 8,
		)
		expect(() =>
			replayOutputBytes(192_000 * 4 * 8 + 8, 192_000, 250_000),
		).toThrow()
		for (const bytes of [-8, 1, NaN, Infinity])
			expect(() => replayOutputBytes(bytes, 192_000, 250_000)).toThrow()
		for (const mode of Object.values(IQ_REPLAY_WIDEBAND_MODES))
			expect(REPLAY_INPUT_DECODERS.has(mode.decoderType)).toBe(true)
		expect(IQ_REPLAY_WIDEBAND_MODES.lora.options).toEqual({
			preset: "LongModerate",
			bandwidth: 125_000,
			oversampling: 2,
		})
	})
})

describe("EU LoRa candidate capture rate", () => {
	const ranges = bandplansFor("EU").flatMap(p => p.ranges)
	it.each([867_000_000, 868_600_000, 869_400_000, 869_650_000])(
		"honours an explicit LoRa exclusion at %s Hz",
		rfHz => {
			expect(captureRateFor({ rfHz, priors: { lora: 0 }, track: null })).toBe(
				48_000,
			)
		},
	)
	it.each([undefined, NaN, Infinity, -Infinity])(
		"does not raise for missing or non-finite frequency %s",
		rfHz => {
			expect(
				captureRateFor({
					...(rfHz === undefined ? {} : { rfHz }),
					priors: {},
					track: null,
				}),
			).toBe(48_000)
		},
	)
	it.each([
		[866_999_999, 96_000],
		[867_000_000, 192_000],
		[868_600_000, 192_000],
		[868_600_001, 96_000],
		[869_399_999, 96_000],
		[869_400_000, 192_000],
		[869_650_000, 192_000],
		[869_650_001, 96_000],
	])("selects capture rate at %s Hz", (hz, rate) => {
		expect(
			captureRateFor({
				rfHz: hz,
				priors: narrowestPriors(ranges, hz),
				track: null,
			}),
		).toBe(rate)
	})
})
