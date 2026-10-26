import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { admitChannel } from "../../../src/core/channelizer/admission.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import type {
	PlannerDecoder,
	PlannerSource,
} from "../../../src/decoders/enablement/contract.js"
import { fitsReach } from "../../../src/decoders/enablement/placement.js"
import type {
	DecoderChannelRequest,
	DecoderChannelRequestResult,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
const USABLE = 0.8
const EU = [136_650_000, 136_700_000, 136_975_000]

const vdl2 = (options: Record<string, unknown>) =>
	new Dumpvdl2Decoder(
		{ id: "vdl2", type: "dumpvdl2", enabled: true, options },
		logger,
	)

const source = (centreHz: number, sampleRateHz: number): PlannerSource => ({
	id: "s",
	centreHz,
	sampleRateHz,
	usableFraction: USABLE,
	dedicatedScanner: false,
	held: false,
	reservedBy: null,
	channelizerAvailable: true,
	order: 0,
})

const result = (
	options: Record<string, unknown>,
	sampleRateHz: number,
	centerHz: number,
): DecoderChannelRequestResult | undefined =>
	vdl2({ inputSampleRate: sampleRateHz, ...options }).getChannelRequest({
		sampleRateHz,
		centerHz,
	})

const request = (
	options: Record<string, unknown>,
	sampleRateHz: number,
	centerHz: number,
): DecoderChannelRequest => {
	const r = result(options, sampleRateHz, centerHz)
	if (!r || "invalid" in r)
		throw new Error(`expected a request: ${JSON.stringify(r)}`)
	return r
}

/** The planner's view of the request, as DecoderManager builds it. */
const planned = (r: DecoderChannelRequest): PlannerDecoder =>
	({
		type: "dumpvdl2",
		reach: "channel",
		channelBandwidthHz: r.bandwidthHz,
		channelTransitionHz: r.transitionHz,
	}) as Pick<
		PlannerDecoder,
		"type" | "reach" | "channelBandwidthHz" | "channelTransitionHz"
	> as PlannerDecoder

/** Placement reach and channelizer admission, the two gates a request meets. */
const gates = (r: DecoderChannelRequest, rate: number, centre: number) => ({
	placed: fitsReach(planned(r), source(centre, rate), r.centerHz),
	admitted: admitChannel(r, { sampleRateHz: rate, centerHz: centre }, USABLE)
		.admitted,
})

describe("dumpvdl2 channel request fits the capture (3.19)", () => {
	it("places and admits the EU list at 136.8125 MHz in a 1.024 Msps capture", () => {
		const r = request({ frequencies: EU }, 1_024_000, 136_812_500)
		// Capture / 2 = 512 kHz (D = 3 cannot hold 375 kHz); bw 2 × 162 500 +
		// 50 000; tr 512 000 × 0.025; reach 187 500 + 12 800 = 200 300 <= 409 600.
		expect(r).toEqual({
			centerHz: 136_812_500,
			bandwidthHz: 375_000,
			transitionHz: 12_800,
			outputRateHz: 512_000,
			format: "cu8",
		})
		expect(gates(r, 1_024_000, 136_812_500)).toEqual({
			placed: true,
			admitted: true,
		})
		expect(
			admitChannel(
				r,
				{ sampleRateHz: 1_024_000, centerHz: 136_812_500 },
				USABLE,
			),
		).toEqual({ admitted: true, offsetHz: 0 })
	})

	it("keeps 1.05 MHz at 2.4 Msps and is admitted", () => {
		const r = request({ frequencies: EU }, 2_400_000, 136_800_000)
		expect(r).toMatchObject({
			centerHz: 136_812_500,
			outputRateHz: 1_050_000,
			bandwidthHz: 375_000,
			transitionHz: 26_250,
		})
		expect(gates(r, 2_400_000, 136_800_000)).toEqual({
			placed: true,
			admitted: true,
		})
	})

	it("never exceeds a configured target rate", () => {
		const r = request(
			{ frequencies: EU, targetSampleRate: 525_000 },
			2_400_000,
			136_812_500,
		)
		expect(r.outputRateHz).toBe(525_000)
	})

	it("is invalid when no 105 kHz multiple fits the capture or the span", () => {
		expect(result({ frequencies: EU }, 100_000, 136_812_500)).toEqual({
			invalid:
				"capture rate 100000 Hz is below one VDL2 symbol rate (105000 Hz)",
		})
		// 315 kHz (N = 3) cannot carry the 375 kHz the EU list needs.
		expect(result({ frequencies: EU }, 320_000, 136_812_500)).toHaveProperty(
			"invalid",
		)
	})

	it("fits a span exactly at the 1.024 Msps bound and rejects one 100 Hz past it", () => {
		// Past 0.95 × 512 kHz the channel is the whole capture (D = 1, tr 25 600):
		// span/2 + 25 000 + 25 600 = 409 600  =>  span = 718 000.
		const lo = 136_000_000
		const at = request(
			{ frequencies: [lo, lo + 718_000] },
			1_024_000,
			lo + 359_000,
		)
		expect(at.outputRateHz).toBe(1_024_000)
		expect(gates(at, 1_024_000, lo + 359_000)).toEqual({
			placed: true,
			admitted: true,
		})
		const past = request(
			{ frequencies: [lo, lo + 718_100] },
			1_024_000,
			lo + 359_050,
		)
		expect(gates(past, 1_024_000, lo + 359_050)).toEqual({
			placed: false,
			admitted: false,
		})
	})

	it("covers off-midpoint channelHz at the narrowing, widening and invalid bounds", () => {
		// 2.4 Msps: rate 1.05 MHz, default passband 997 500 Hz.
		const c = 136_500_000
		const at = (farHz: number) =>
			result(
				{ frequencies: [c - 10_000, c + farHz], channelHz: c },
				2_400_000,
				c,
			)
		// Farthest target 473 750 Hz: 2 × 473 750 + 50 000 = 997 500, still narrowing.
		expect(at(473_750)).toMatchObject({
			centerHz: c,
			bandwidthHz: 997_500,
			transitionHz: 26_250,
		})
		// 474 000 Hz: 998 000 widens, transition (1 050 000 − 998 000) / 2.
		expect(at(474_000)).toMatchObject({
			bandwidthHz: 998_000,
			transitionHz: 26_000,
		})
		// 500 000 Hz: 1 050 000 reaches the rate, invalid.
		expect(at(500_000)).toHaveProperty("invalid")
		// Narrowing measures from channelHz, not the span midpoint.
		expect(at(100_000)).toMatchObject({ bandwidthHz: 250_000 })
	})

	it("resamples the delivered channel to 105 kHz × N and passes that N as --oversample", () => {
		const r = request({ frequencies: EU }, 1_024_000, 136_812_500)
		const d = vdl2({
			frequencies: EU,
			inputSampleRate: r.outputRateHz,
			inputCenterFreq: r.centerHz,
		}) as unknown as {
			getDecoderArgs(): string[]
			buildPipelineCommand(): string
		}
		const args = d.getDecoderArgs()
		const flag = (name: string) => args[args.indexOf(name) + 1]
		// 512 kHz -> 525 kHz (N = 5, the smallest 105 kHz multiple >= 512 kHz).
		expect(flag("--oversample")).toBe("5")
		expect(flag("--centerfreq")).toBe(String(r.centerHz))
		expect(args.slice(-3)).toEqual(EU.map(String))
		const pipeline = d.buildPipelineCommand()
		expect(pipeline).toMatch(/^sox .*-r 512000 .*-r 525000 .*\| dumpvdl2 /)
		// At 2.4 Msps the 1.05 MHz channel feeds dumpvdl2 directly (N = 10).
		const direct = vdl2({
			frequencies: EU,
			inputSampleRate: 1_050_000,
		}) as unknown as { buildPipelineCommand(): string }
		expect(direct.buildPipelineCommand()).toMatch(
			/^dumpvdl2 .*--oversample 10 /,
		)
		// The raw path at a non-multiple capture still resamples to the target.
		const raw = vdl2({
			frequencies: EU,
			inputSampleRate: 1_024_000,
		}) as unknown as {
			getDecoderArgs(): string[]
		}
		const rawArgs = raw.getDecoderArgs()
		expect(rawArgs[rawArgs.indexOf("--oversample") + 1]).toBe("10")
	})

	it("places and admits every target set that fits, its passband covering each target", () => {
		// Feature: decoder-enablement, Property 19: VDL2 channel covers its targets inside the capture
		// Validates: Requirements 3.14, 3.19
		fc.assert(
			fc.property(
				fc.constantFrom(1_024_000, 1_050_000, 2_048_000, 2_400_000),
				fc.integer({ min: 118_000_000, max: 137_000_000 }),
				fc.array(fc.integer({ min: -480_000, max: 480_000 }), {
					minLength: 1,
					maxLength: 8,
				}),
				(rate, centre, offsets) => {
					const freqs = offsets.map(o => centre + o)
					const mid = (Math.min(...freqs) + Math.max(...freqs)) / 2
					const half = (rate * USABLE) / 2
					const maxRate = Math.min(rate, 1_050_000)
					const neededHz = Math.max(...freqs) - Math.min(...freqs) + 50_000
					const r = result({ frequencies: freqs }, rate, centre)
					expect(r).toBeDefined()
					if (!r) return
					if ("invalid" in r) {
						// Only a span that reaches the channel rate is invalid.
						expect(neededHz).toBeGreaterThanOrEqual(maxRate)
						return
					}
					// The target at or above it, else an integer decimation of the
					// capture: never upsampled, always at least one symbol rate.
					expect(r.outputRateHz).toBeLessThanOrEqual(maxRate)
					expect(r.outputRateHz).toBeGreaterThanOrEqual(105_000)
					if (rate < 1_050_000)
						expect(Number.isInteger(rate / r.outputRateHz)).toBe(true)
					else expect(r.outputRateHz).toBe(1_050_000)
					const lo = r.centerHz - r.bandwidthHz / 2
					const hi = r.centerHz + r.bandwidthHz / 2
					for (const f of freqs) {
						expect(f - 25_000).toBeGreaterThanOrEqual(lo - 1e-6)
						expect(f + 25_000).toBeLessThanOrEqual(hi + 1e-6)
					}
					const { placed, admitted } = gates(r, rate, centre)
					expect(admitted).toBe(placed)
					if (placed) {
						expect(lo - r.transitionHz).toBeGreaterThanOrEqual(
							centre - half - 1e-6,
						)
						expect(hi + r.transitionHz).toBeLessThanOrEqual(
							centre + half + 1e-6,
						)
					}
					// No over-narrow refusal: a target set whose channels fit is placed.
					const need = Math.abs(mid - centre) + neededHz / 2 + r.transitionHz
					if (need <= half) expect(placed).toBe(true)
				},
			),
			{ numRuns: 200 },
		)
	})
})
