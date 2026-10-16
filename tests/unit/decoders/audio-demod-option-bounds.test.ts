// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import {
	AudioDemodDecoder,
	FM_GAIN_MAX,
	boundDemodConfig,
} from "../../../src/decoders/audio-demod-decoder.js"
import {
	IqDecimateDecoder,
	SAMPLE_RATE_MAX_HZ,
	boundIqDecimationConfig,
	type IqDecimationConfig,
} from "../../../src/decoders/iq-decimate-decoder.js"
import {
	channelDecimationStage,
	csdrNumber,
	deemphasisStage,
	shiftStage,
} from "../../../src/decoders/csdr-stages.js"
import {
	MULTIMON_FM_GAIN_MAX,
	MULTIMON_SAMPLE_RATE_MAX_HZ,
} from "../../../src/decoders/options/multimon-ng.js"
import {
	DSD_FME_FM_GAIN_MAX,
	DSD_FME_SAMPLE_RATE_MAX_HZ,
} from "../../../src/decoders/options/dsd-fme.js"
import { RTL433_INPUT_SAMPLE_RATE_MAX_HZ } from "../../../src/decoders/options/rtl433.js"
import type {
	DecoderConfig,
	DecoderOutput,
	DemodulationConfig,
} from "../../../src/decoders/types.js"

function capture() {
	const warn: Record<string, unknown>[] = []
	const logger = pino(
		{ level: "warn" },
		{ write: (line: string) => void warn.push(JSON.parse(line)) },
	)
	return { warn, logger }
}

const CONFIG = {
	id: "t",
	type: "test",
	enabled: true,
	options: {},
} as unknown as DecoderConfig

/** A demod subclass whose config comes straight from (untrusted) values. */
class RawDemod extends AudioDemodDecoder {
	constructor(
		private readonly raw: Record<string, unknown>,
		logger: pino.Logger,
	) {
		super(CONFIG, logger)
	}
	protected getDemodConfig(): DemodulationConfig {
		return {
			bandwidth: 12_500,
			sampleRate: 22_050,
			demodSampleRate: 48_000,
			inputSampleRate: 2_400_000,
			deEmphasis: false,
			...this.raw,
		} as DemodulationConfig
	}
	protected getDecoderCommand(): string {
		return "dec"
	}
	protected getDecoderArgs(): string[] {
		return []
	}
	protected parseOutput(): DecoderOutput | null {
		return null
	}
	pipeline(): string {
		return this.getArgs()[1] ?? ""
	}
}

class RawIq extends IqDecimateDecoder {
	constructor(
		private readonly raw: Record<string, unknown>,
		logger: pino.Logger,
	) {
		super(CONFIG, logger)
	}
	protected getIqDecimationConfig(): IqDecimationConfig {
		return {
			inputSampleRate: 2_048_000,
			targetSampleRate: 1_000_000,
			...this.raw,
		} as IqDecimationConfig
	}
	protected getDecoderCommand(): string {
		return "dec"
	}
	protected getDecoderArgs(): string[] {
		return []
	}
	protected parseOutput(): DecoderOutput | null {
		return null
	}
	pipeline(): string {
		return this.getArgs()[1] ?? ""
	}
}

const GARBAGE: unknown[] = [
	"abc",
	"1; rm -rf /",
	"$(reboot)",
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	true,
	{},
]

describe("audio-demod shell string (requirement 9.4)", () => {
	it("fmGain text never reaches sh -c; the csdr default gain is used", () => {
		const { logger, warn } = capture()
		const cmd = new RawDemod({ fmGain: "1; rm -rf /" }, logger).pipeline()
		expect(cmd).not.toContain("rm -rf")
		expect(cmd).toContain("csdr gain 10 |")
		const keyed = warn.filter(w => w["key"] === "fmGain")
		expect(keyed).toEqual([
			expect.objectContaining({ key: "fmGain", issue: "invalid" }),
		])
		expect(JSON.stringify(warn)).not.toContain("rm -rf")
	})

	it("fmGain at and past each bound", () => {
		const gain = (v: unknown) =>
			/csdr gain (\S+)/.exec(
				new RawDemod({ fmGain: v }, capture().logger).pipeline(),
			)?.[1]
		expect(gain(0)).toBe("0")
		expect(gain(FM_GAIN_MAX)).toBe("1000")
		expect(gain(FM_GAIN_MAX + 1)).toBe("1000")
		expect(gain(-1)).toBe("0")
		for (const g of GARBAGE) expect(gain(g)).toBe("10")
	})

	it("filterTransition, filterCutoff and audioLowPass are bounded numbers", () => {
		const cmd = (raw: Record<string, unknown>) =>
			new RawDemod(raw, capture().logger).pipeline()
		expect(cmd({ filterTransition: 0.5, filterCutoff: 0.5 })).toContain(
			"csdr firdecimate 50 0.5 --cutoff 0.5",
		)
		expect(cmd({ filterTransition: 0.9, filterCutoff: 7 })).toContain(
			"csdr firdecimate 50 0.5 --cutoff 0.5",
		)
		for (const g of GARBAGE) {
			const text = cmd({
				filterTransition: g,
				filterCutoff: g,
				audioLowPass: g,
			})
			expect(text).not.toMatch(/NaN|Infinity|rm -rf|reboot|abc/)
		}
		expect(cmd({ audioLowPass: 1e9 })).toContain("csdr lowpass -f float 2.0000")
	})

	it("garbage sample rates fall back to defaults; huge ones clamp", () => {
		const cmd = (raw: Record<string, unknown>) =>
			new RawDemod(raw, capture().logger).pipeline()
		const baseline = cmd({})
		for (const g of GARBAGE) expect(cmd({ inputSampleRate: g })).toBe(baseline)
		expect(cmd({ inputSampleRate: 0 })).toBe(baseline)
		expect(cmd({ inputSampleRate: 1e18 })).toBe(
			cmd({ inputSampleRate: SAMPLE_RATE_MAX_HZ }),
		)
		for (const g of GARBAGE) {
			const text = cmd({ sampleRate: g, demodSampleRate: g, bandwidth: g })
			expect(text).not.toMatch(/NaN|Infinity|rm -rf|reboot/)
		}
	})

	it("boundDemodConfig returns in-range configs unchanged", () => {
		const config: DemodulationConfig = {
			bandwidth: 12_500,
			sampleRate: 22_050,
			demodSampleRate: 48_000,
			inputSampleRate: 2_048_000,
			deEmphasis: true,
			fmGain: 3,
			filterTransition: 0.012,
			audioLowPass: 3000,
		}
		const warned: string[] = []
		expect(boundDemodConfig(config, k => void warned.push(k))).toEqual(config)
		expect(warned).toEqual([])
	})
})

describe("iq-decimate shell string", () => {
	it("a 0 or garbage target rate never yields Infinity/NaN in the pipeline", () => {
		for (const v of [0, -5, ...GARBAGE]) {
			const text = new RawIq(
				{ targetSampleRate: v },
				capture().logger,
			).pipeline()
			expect(text).not.toMatch(/NaN|Infinity|rm -rf|reboot/)
		}
	})

	it("filter numbers are bounded; in-range configs are unchanged", () => {
		const text = new RawIq(
			{ filterTransition: 9, filterCutoff: "1; rm -rf /" },
			capture().logger,
		).pipeline()
		expect(text).toContain("csdr firdecimate 2 0.5 |")
		expect(text).not.toContain("rm -rf")
		const config: IqDecimationConfig = {
			inputSampleRate: 2_048_000,
			targetSampleRate: 1_000_000,
			filterTransition: 0.05,
		}
		expect(boundIqDecimationConfig(config, () => undefined)).toEqual(config)
	})
})

describe("csdr-stages finite guard", () => {
	it("csdrNumber formats finite numbers like a template literal and throws otherwise", () => {
		expect(csdrNumber(3)).toBe("3")
		expect(csdrNumber(47627.90697674418)).toBe(`${47627.90697674418}`)
		for (const v of [Number.NaN, Infinity, -Infinity, "3" as unknown as number])
			expect(() => csdrNumber(v)).toThrow()
	})

	it("stage builders refuse non-finite inputs", () => {
		expect(() => channelDecimationStage(Number.NaN, 2, 12_500)).toThrow()
		expect(() => channelDecimationStage(2_048_000, Infinity, 12_500)).toThrow()
		expect(() => shiftStage(Infinity, 2_048_000)).toThrow()
		expect(() => deemphasisStage("wfm", Number.NaN)).toThrow()
		expect(() => deemphasisStage("wfm", 48_000, Infinity)).toThrow()
		expect(channelDecimationStage(2_048_000, 43, 12_500)).toBe(
			"csdr firdecimate 43 0.003052 --cutoff 0.1968",
		)
	})

	it("option schema constants equal the base bounds", () => {
		expect(MULTIMON_FM_GAIN_MAX).toBe(FM_GAIN_MAX)
		expect(DSD_FME_FM_GAIN_MAX).toBe(FM_GAIN_MAX)
		expect(MULTIMON_SAMPLE_RATE_MAX_HZ).toBe(SAMPLE_RATE_MAX_HZ)
		expect(DSD_FME_SAMPLE_RATE_MAX_HZ).toBe(SAMPLE_RATE_MAX_HZ)
		expect(RTL433_INPUT_SAMPLE_RATE_MAX_HZ).toBe(SAMPLE_RATE_MAX_HZ)
	})
})

const anyValue = fc.oneof(
	fc.double(),
	fc.integer({ min: -1e12, max: 1e12 }),
	fc.constantFrom(...GARBAGE, undefined),
	fc.string().map(s => `ZZ${s}`),
)

describe("Property 14: audio-demod and iq-decimate bases", () => {
	it("every number in the demod pipeline is finite and bounded; no option text reaches the shell", () => {
		fc.assert(
			fc.property(
				fc.record(
					{
						inputSampleRate: anyValue,
						sampleRate: anyValue,
						demodSampleRate: anyValue,
						bandwidth: anyValue,
						fmGain: anyValue,
						filterTransition: anyValue,
						filterCutoff: anyValue,
						audioLowPass: anyValue,
					},
					{ requiredKeys: [] },
				),
				raw => {
					const cmd = new RawDemod(raw, capture().logger).pipeline()
					expect(cmd).not.toContain("ZZ")
					expect(cmd).not.toMatch(/NaN|Infinity|e\+|rm -rf|reboot/)
					const gain = Number(/csdr gain (\S+)/.exec(cmd)?.[1])
					expect(gain).toBeGreaterThanOrEqual(0)
					expect(gain).toBeLessThanOrEqual(FM_GAIN_MAX)
					for (const m of cmd.matchAll(/-r (\S+)/g)) {
						expect(Number(m[1])).toBeGreaterThan(0)
						expect(Number(m[1])).toBeLessThanOrEqual(SAMPLE_RATE_MAX_HZ)
					}
					const dec = Number(/csdr firdecimate (\S+)/.exec(cmd)?.[1])
					expect(Number.isInteger(dec)).toBe(true)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("every number in the IQ pipeline is finite and bounded", () => {
		fc.assert(
			fc.property(
				fc.record(
					{
						inputSampleRate: anyValue,
						targetSampleRate: anyValue,
						filterTransition: anyValue,
						filterCutoff: anyValue,
					},
					{ requiredKeys: [] },
				),
				raw => {
					const cmd = new RawIq(raw, capture().logger).pipeline()
					expect(cmd).not.toContain("ZZ")
					expect(cmd).not.toMatch(/NaN|Infinity|e\+|rm -rf|reboot/)
					const m = /csdr firdecimate (\S+) (\S+)/.exec(cmd)
					if (m) {
						expect(Number.isInteger(Number(m[1]))).toBe(true)
						expect(Number(m[2])).toBeGreaterThanOrEqual(0)
						expect(Number(m[2])).toBeLessThanOrEqual(0.5)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
