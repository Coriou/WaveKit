import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	pulseResponse,
	pulseSpectrum,
	receiveSpectrum as generatorReceiveSpectrum,
} from "../../../scripts/fixtures/fsk-iq.mjs"
import {
	DSD_FME_MODES,
	DsdFmeDecoder,
} from "../../../src/decoders/builtin/dsd-fme.js"
import {
	RECEIVE_FILTER_SPAN_SYMBOLS,
	RECEIVE_LOWPASS_EFFECT,
	receiveFilterEffect,
	receiveFilterPlan,
	receiveFilterTaps,
	receiveImpulse,
} from "../../../src/decoders/builtin/dsd-fme-filter.js"
import { dsdFmeOptionsSchema } from "../../../src/decoders/options/dsd-fme.js"

const { RX_FILTER } = (await import(
	new URL("../../../scripts/dsd-fme-voice-iq.mjs", import.meta.url).href
)) as { RX_FILTER: string }

const logger = pino({ level: "silent" })
const pipelineOf = (options: Record<string, unknown>) =>
	(
		new DsdFmeDecoder(
			{ id: "dsd", type: "dsd-fme", enabled: true, options },
			logger,
		) as unknown as { buildPipelineCommand(): string }
	).buildPipelineCommand()
const soxStage = (pipeline: string) =>
	pipeline.split(" | ").find(s => s.startsWith("sox "))!
const CHANNEL = { inputSampleRate: 48_000, inputIqFormat: "cf32" }
const SOX_48K = "sox -t raw -r 48000 -e signed -b 16 -c 1 - -t wav -r 48000 -"

/** Discrete convolution of a and b. */
function convolve(a: number[], b: number[]): number[] {
	const out = new Array<number>(a.length + b.length - 1).fill(0)
	a.forEach((x, i) => b.forEach((y, j) => (out[i + j]! += x * y)))
	return out
}

/** Closed-form root raised cosine, t in symbols (Proakis 9.2). */
function rootRaisedCosine(t: number, a: number): number {
	if (Math.abs(t) < 1e-12) return 1 - a + (4 * a) / Math.PI
	const num =
		Math.sin(Math.PI * t * (1 - a)) +
		4 * a * t * Math.cos(Math.PI * t * (1 + a))
	return num / (Math.PI * t * (1 - (4 * a * t) ** 2))
}

describe("dsd-fme receive filter design", () => {
	it("picks the filter by mode: low-pass at 4800 symbols/s, the standard FIR for NXDN and dPMR, none for ProVoice", () => {
		expect(DSD_FME_MODES.map(m => [m, receiveFilterPlan(m)])).toEqual([
			["auto", { kind: "lowpass" }],
			["dmr", { kind: "lowpass" }],
			["p25", { kind: "lowpass" }],
			["ysf", { kind: "lowpass" }],
			["dstar", { kind: "lowpass" }],
			["nxdn", { kind: "rrc", symbolRate: 4800, sinc: true }],
			["nxdn48", { kind: "rrc", symbolRate: 2400, sinc: true }],
			["dpmr", { kind: "rrc", symbolRate: 2400, sinc: false }],
			["provoice", undefined],
		])
		expect(receiveFilterEffect("auto", 47_000)).toBe("sinc -t 1000 -3000")
		expect(receiveFilterEffect("provoice", 48_000)).toBeUndefined()
	})

	it("is the textbook root raised cosine without sinc (closed form)", () => {
		for (const t of [0, 0.3, 1, 1.7, 2.5, 4, 7])
			expect(receiveImpulse(t, 0.2, false)).toBeCloseTo(
				rootRaisedCosine(t, 0.2),
				6,
			)
	})

	it("is the receive filter the synthetic generators' transmit filters assume", () => {
		// RRC (dPMR) and RRC x sin x / x (NXDN), the generators' receiveSpectrum.
		for (const shape of [
			{ shaping: "rrc" as const, alpha: 0.2 },
			{ shaping: "rrc" as const, alpha: 0.2, isinc: true },
		])
			for (const t of [0, 0.5, 1, 2.25])
				expect(receiveImpulse(t, 0.2, shape.isinc === true)).toBeCloseTo(
					pulseResponse(t, x => generatorReceiveSpectrum(x, shape), 0.2),
					6,
				)
	})

	it("cancels the transmit filter's intersymbol interference: dPMR RRC x RRC and NXDN (RRC x/sin x) x (RRC sin x/x)", () => {
		for (const { shape, sinc, symbolRate } of [
			{
				shape: { shaping: "rrc" as const, alpha: 0.2 },
				sinc: false,
				symbolRate: 2400,
			},
			{
				shape: { shaping: "rrc" as const, alpha: 0.2, isinc: true },
				sinc: true,
				symbolRate: 2400,
			},
		]) {
			const sps = 48_000 / symbolRate
			const half = RECEIVE_FILTER_SPAN_SYMBOLS * sps
			const tx: number[] = []
			for (let n = -half; n <= half; n++)
				tx.push(pulseResponse(n / sps, x => pulseSpectrum(x, shape), 0.2))
			const overall = convolve(
				tx,
				receiveFilterTaps(symbolRate, 48_000, { sinc }),
			)
			const centre = (overall.length - 1) / 2
			for (let k = 1; k <= 4; k++)
				for (const at of [centre + k * sps, centre - k * sps])
					// Truncation at +-8 symbols leaves under 2 % of the peak.
					expect(Math.abs(overall[at]! / overall[centre]!)).toBeLessThan(0.02)
		}
	})

	// Feature: dsd-fme decode margin, Property 1: the FIR keeps the level
	// Validates: unit DC gain, symmetry and length at any sox input rate
	it("has unit DC gain, symmetry and the stated length at any sox input rate", () => {
		fc.assert(
			fc.property(
				fc.double({ min: 9_600, max: 96_000, noNaN: true }),
				fc.constantFrom(2400, 4800),
				fc.boolean(),
				(rateHz, symbolRate, sinc) => {
					const taps = receiveFilterTaps(symbolRate, rateHz, { sinc })
					expect(taps).toHaveLength(
						2 *
							Math.floor((RECEIVE_FILTER_SPAN_SYMBOLS * rateHz) / symbolRate) +
							1,
					)
					expect(taps.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
					for (let i = 0; i < taps.length; i++)
						expect(taps[i]).toBeCloseTo(taps[taps.length - 1 - i]!, 12)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("equals the filter the in-image voice regression scripts apply", () => {
		expect(RX_FILTER).toBe(RECEIVE_LOWPASS_EFFECT)
	})
})

describe("dsd-fme receiveFilter option", () => {
	it("filters by default, as an effect of the sox wrapper", () => {
		expect(soxStage(pipelineOf({ ...CHANNEL }))).toBe(
			`${SOX_48K} sinc -t 1000 -3000`,
		)
		// The FIR is designed at the sox input rate: raw path at 2.048 Msps,
		// decimation 43, sox reads 47 627.9 Hz.
		expect(
			soxStage(pipelineOf({ mode: "dpmr", inputSampleRate: 2_048_000 })),
		).toBe(
			`sox -t raw -r ${2_048_000 / 43} -e signed -b 16 -c 1 - -t wav -r 48000 - ${receiveFilterEffect("dpmr", 2_048_000 / 43)}`,
		)
		expect(soxStage(pipelineOf({ ...CHANNEL, mode: "nxdn48" }))).toBe(
			`${SOX_48K} ${receiveFilterEffect("nxdn48", 48_000)}`,
		)
		expect(soxStage(pipelineOf({ ...CHANNEL, mode: "provoice" }))).toBe(SOX_48K)
	})

	it("false feeds dsd-fme exactly the unfiltered command line", () => {
		expect(pipelineOf({ ...CHANNEL, receiveFilter: false })).toBe(
			`csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | ${SOX_48K} | dsd-fme -i /dev/stdin -fa -o null`,
		)
	})

	it("keeps the default for null and non-boolean values", () => {
		const filtered = pipelineOf({ ...CHANNEL })
		for (const receiveFilter of [null, "off", 0, "false"])
			expect(pipelineOf({ ...CHANNEL, receiveFilter })).toBe(filtered)
	})

	it("is a boolean in the strict option schema", () => {
		for (const receiveFilter of [true, false, null])
			expect(dsdFmeOptionsSchema.safeParse({ receiveFilter }).success).toBe(
				true,
			)
		expect(
			dsdFmeOptionsSchema.safeParse({ receiveFilter: "off" }).success,
		).toBe(false)
	})
})
