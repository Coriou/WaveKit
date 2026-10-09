/**
 * Band-aware suspension: pure in-band resolver.
 * Roadmap item 8; admission rule from
 * docs/superpowers/specs/2026-10-09-core-channelizer-prototype-addendum.md §6
 * (usable fraction 0.8 of the window the pipeline actually sees).
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	USABLE_WINDOW_FRACTION,
	assessDecoderBand,
	distanceToRange,
	type DecoderBandRequirements,
} from "../../../src/decoders/band-resolver.js"

const ADSB = { targetsHz: [1_090_000_000], basis: "protocol" as const }

describe("assessDecoderBand", () => {
	it("is unknown without a declaration (unknown is never out of band)", () => {
		expect(
			assessDecoderBand(undefined, {
				centerHz: 1_090_000_000,
				sampleRateHz: 2_048_000,
			}),
		).toEqual({ verdict: "unknown", reasonCode: "no-target-frequency" })
	})

	it("is unknown when the source centre is unknown", () => {
		expect(assessDecoderBand(ADSB, { sampleRateHz: 2_048_000 })).toEqual({
			verdict: "unknown",
			reasonCode: "source-center-unknown",
			targetsHz: [1_090_000_000],
			basis: "protocol",
		})
	})

	it("reports in-band with the usable window around the centre", () => {
		expect(
			assessDecoderBand(ADSB, {
				centerHz: 1_090_200_000,
				sampleRateHz: 2_048_000,
			}),
		).toEqual({
			verdict: "in-band",
			targetsHz: [1_090_000_000],
			basis: "protocol",
			captureCenterHz: 1_090_200_000,
			windowHalfWidthHz: 819_200,
		})
	})

	it("reports out-of-band when every target lies outside the window", () => {
		expect(
			assessDecoderBand(ADSB, {
				centerHz: 162_000_000,
				sampleRateHz: 2_048_000,
			}),
		).toMatchObject({
			verdict: "out-of-band",
			reasonCode: "frequency-out-of-band",
			captureCenterHz: 162_000_000,
		})
	})

	it("is in band when any one of several targets fits", () => {
		const acars = {
			targetsHz: [131_550_000, 131_725_000],
			basis: "configured" as const,
		}
		const plan = assessDecoderBand(acars, {
			centerHz: 131_725_000,
			sampleRateHz: 2_400_000,
			frontendRateHz: 24_000,
		})
		expect(plan.verdict).toBe("in-band")
	})

	it("uses the narrower pipeline frontend, never more than the capture", () => {
		// Audio demod at 48 kHz: only ±19.2 kHz around the centre is decodable.
		const pocsag = { targetsHz: [466_075_000], basis: "configured" as const }
		const ctx = { sampleRateHz: 2_400_000, frontendRateHz: 48_000 }
		expect(
			assessDecoderBand(pocsag, { ...ctx, centerHz: 466_060_000 }),
		).toMatchObject({ verdict: "in-band", windowHalfWidthHz: 19_200 })
		expect(
			assessDecoderBand(pocsag, { ...ctx, centerHz: 466_000_000 }).verdict,
		).toBe("out-of-band")
		// A resampler cannot add RF span: 2.4 Msps stdin from a 2.048 Msps capture.
		expect(
			assessDecoderBand(ADSB, {
				centerHz: 1_090_000_000,
				sampleRateHz: 2_048_000,
				frontendRateHz: 2_400_000,
			}).windowHalfWidthHz,
		).toBe(819_200)
	})

	it("followCenter: in band anywhere across the declared span, not just near a target", () => {
		const follow = {
			targetsHz: [868_100_000, 869_525_000],
			basis: "configured" as const,
			followCenter: true as const,
		}
		const ctx = { sampleRateHz: 2_048_000, frontendRateHz: 1_000_000 }
		// ±400 kHz window; 868.8 MHz is ≥700 kHz from either channel but inside the span.
		expect(
			assessDecoderBand(follow, { ...ctx, centerHz: 868_800_000 }).verdict,
		).toBe("in-band")
		expect(
			assessDecoderBand(follow, { ...ctx, centerHz: 870_000_000 }).verdict,
		).toBe("out-of-band")
		expect(
			assessDecoderBand(follow, { ...ctx, centerHz: 869_900_000 }).verdict,
		).toBe("in-band")
	})

	it("treats an invalid declaration as unknown", () => {
		expect(
			assessDecoderBand(
				{ targetsHz: [Number.NaN], basis: "configured" },
				{ centerHz: 1, sampleRateHz: 2_048_000 },
			),
		).toEqual({ verdict: "unknown", reasonCode: "no-target-frequency" })
		expect(
			assessDecoderBand(
				{ targetsHz: [], basis: "configured" },
				{ centerHz: 1, sampleRateHz: 2_048_000 },
			).verdict,
		).toBe("unknown")
	})

	it("matches the admission rule for any target, centre and rate", () => {
		// Feature: band-aware-suspension, Property 1: in band iff some target is within the usable half-window
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 24_000_000, max: 1_900_000_000 }), {
					minLength: 1,
					maxLength: 4,
				}),
				fc.integer({ min: 24_000_000, max: 1_900_000_000 }),
				fc.integer({ min: 225_001, max: 3_200_000 }),
				fc.option(fc.integer({ min: 12_000, max: 3_200_000 }), {
					nil: undefined,
				}),
				(targetsHz, centerHz, sampleRateHz, frontendRateHz) => {
					const plan = assessDecoderBand(
						{ targetsHz, basis: "configured" },
						{
							centerHz,
							sampleRateHz,
							...(frontendRateHz !== undefined ? { frontendRateHz } : {}),
						},
					)
					const half =
						(Math.min(sampleRateHz, frontendRateHz ?? sampleRateHz) *
							USABLE_WINDOW_FRACTION) /
						2
					const fits = targetsHz.some(t => Math.abs(t - centerHz) <= half)
					expect(plan.verdict).toBe(fits ? "in-band" : "out-of-band")
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("assessDecoderBand ranges (band defaults §2)", () => {
	const ISM = { minHz: 433_050_000, maxHz: 434_790_000 }
	const ctx = { sampleRateHz: 2_400_000, frontendRateHz: 48_000 } // ±19.2 kHz

	it("is in band anywhere inside a range and within the window of its edges", () => {
		const band = { rangesHz: [ISM], basis: "region-default" as const }
		expect(assessDecoderBand(band, { ...ctx, centerHz: 434_000_000 })).toEqual({
			verdict: "in-band",
			rangesHz: [ISM],
			basis: "region-default",
			captureCenterHz: 434_000_000,
			windowHalfWidthHz: 19_200,
		})
		expect(
			assessDecoderBand(band, { ...ctx, centerHz: 433_040_000 }).verdict,
		).toBe("in-band")
		expect(
			assessDecoderBand(band, { ...ctx, centerHz: 433_000_000 }).verdict,
		).toBe("out-of-band")
	})

	it("echoes ranges, region and override source, and mixes targets with ranges", () => {
		const band: DecoderBandRequirements = {
			targetsHz: [144_800_000],
			rangesHz: [ISM],
			basis: "override",
			overrideSource: "api",
			region: { code: "EU", source: "guessed:tz" },
		}
		expect(
			assessDecoderBand(band, { ...ctx, centerHz: 144_800_000 }),
		).toMatchObject({
			verdict: "in-band",
			targetsHz: [144_800_000],
			rangesHz: [ISM],
			basis: "override",
			overrideSource: "api",
			region: { code: "EU", source: "guessed:tz" },
		})
		expect(assessDecoderBand(band, { sampleRateHz: 2_400_000 })).toMatchObject({
			verdict: "unknown",
			reasonCode: "source-center-unknown",
			rangesHz: [ISM],
		})
	})

	it("treats an inverted or empty range list as no declaration", () => {
		expect(
			assessDecoderBand(
				{ rangesHz: [{ minHz: 2, maxHz: 1 }], basis: "override" },
				{ ...ctx, centerHz: 1 },
			),
		).toEqual({ verdict: "unknown", reasonCode: "no-target-frequency" })
		expect(
			assessDecoderBand(
				{ rangesHz: [], basis: "override" },
				{ ...ctx, centerHz: 1 },
			).verdict,
		).toBe("unknown")
	})

	const freq = fc.integer({ min: 24_000_000, max: 1_900_000_000 })
	const rangeArb = fc
		.tuple(freq, fc.integer({ min: 0, max: 50_000_000 }))
		.map(([minHz, width]) => ({ minHz, maxHz: minHz + width }))
	const rate = fc.integer({ min: 225_001, max: 3_200_000 })

	it("admits a range iff the centre is within the half-window of it", () => {
		// Feature: decoder-band-defaults, Property 1: Range admission
		// Validates: §2
		fc.assert(
			fc.property(rangeArb, freq, rate, (range, centerHz, sampleRateHz) => {
				const half = (sampleRateHz * USABLE_WINDOW_FRACTION) / 2
				const plan = assessDecoderBand(
					{ rangesHz: [range], basis: "override" },
					{ centerHz, sampleRateHz },
				)
				expect(plan.verdict).toBe(
					distanceToRange(centerHz, range) <= half ? "in-band" : "out-of-band",
				)
				const point = range.minHz
				const degenerate = assessDecoderBand(
					{ rangesHz: [{ minHz: point, maxHz: point }], basis: "override" },
					{ centerHz, sampleRateHz },
				).verdict
				const target = assessDecoderBand(
					{ targetsHz: [point], basis: "override" },
					{ centerHz, sampleRateHz },
				).verdict
				expect(degenerate).toBe(target)
			}),
			{ numRuns: 100 },
		)
	})

	it("is monotone: widening or adding never leaves the band; no centre is never out of band", () => {
		// Feature: decoder-band-defaults, Property 2: Monotonicity
		// Validates: §2
		fc.assert(
			fc.property(
				fc.array(rangeArb, { minLength: 1, maxLength: 3 }),
				fc.array(freq, { maxLength: 3 }),
				freq,
				rate,
				fc.integer({ min: 0, max: 10_000_000 }),
				rangeArb,
				freq,
				(
					rangesHz,
					targetsHz,
					centerHz,
					sampleRateHz,
					widen,
					extra,
					extraTarget,
				) => {
					const ctx2 = { centerHz, sampleRateHz }
					const base: DecoderBandRequirements = {
						rangesHz,
						...(targetsHz.length ? { targetsHz } : {}),
						basis: "override",
					}
					const before = assessDecoderBand(base, ctx2).verdict
					const widened = assessDecoderBand(
						{
							...base,
							rangesHz: rangesHz.map(r => ({
								minHz: Math.max(1, r.minHz - widen),
								maxHz: r.maxHz + widen,
							})),
						},
						ctx2,
					).verdict
					const added = assessDecoderBand(
						{
							...base,
							rangesHz: [...rangesHz, extra],
							targetsHz: [...targetsHz, extraTarget],
						},
						ctx2,
					).verdict
					if (before === "in-band") {
						expect(widened).toBe("in-band")
						expect(added).toBe("in-band")
					}
					expect(assessDecoderBand(base, { sampleRateHz }).verdict).not.toBe(
						"out-of-band",
					)
					expect(assessDecoderBand(base, { centerHz }).verdict).not.toBe(
						"out-of-band",
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
