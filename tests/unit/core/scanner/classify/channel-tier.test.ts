import { describe, expect, it } from "vitest"
import type { Classification } from "../../../../../src/core/scanner/types.js"
import type { ChannelFeatureEvidence } from "../../../../../src/core/scanner/classify/channel-features.js"
import { extractChannelFeatures } from "../../../../../src/core/scanner/classify/channel-features.js"
import { refineChannelClassification } from "../../../../../src/core/scanner/classify/channel-tier.js"
import type { ChannelTierContext } from "../../../../../src/core/scanner/classify/channel-tier.js"

const spectral: Classification = {
	class: "unknown",
	hypotheses: [{ protocol: "unknown", score: 0.3 }],
	tier: "spectral",
}
const context: ChannelTierContext = {
	priors: {},
	protocols: [],
	rfTrusted: true,
	obwHz: 5000,
}
function evidence(): ChannelFeatureEvidence {
	return {
		kind: "evidence",
		sampleCount: 24_000,
		onSamples: 24_000,
		durationMs: 500,
		onDurationMs: 500,
		discriminator: {
			histogram: new Array<number>(128).fill(0),
			binWidthHz: 187.5,
			centerOffsetHz: 0,
			peaksHz: [-1800, -600, 600, 1800],
			peakStdHz: [150, 150, 150, 150],
			peakSpacingHz: [1200, 1200, 1200],
			deviationHz: 1800,
			stdHz: 1341,
			voiceBandFraction: 0.1,
		},
		afsk: { kind: "absent", markFraction: 0, spaceFraction: 0 },
		ctcss: { kind: "absent" },
		symbolRate: { kind: "absent" },
	}
}

describe("conservative channel refinement", () => {
	it("refines four levels to a family, retains priors/filtering, and does not mutate spectral evidence", () => {
		const result = refineChannelClassification(spectral, evidence(), {
			...context,
			priors: { nxdn48: 1.5 },
			protocols: ["nxdn48"],
		})
		expect(result).toEqual({
			kind: "refined",
			classification: {
				class: "fsk4-6k25",
				tier: "channel",
				hypotheses: [{ protocol: "nxdn48", score: 0.75 }],
			},
		})
		expect(spectral.tier).toBe("spectral")
		expect(spectral.class).toBe("unknown")
		expect(result).not.toHaveProperty("identity")
		expect(result).not.toHaveProperty("encrypted")
	})

	it("keeps multiple 12.5k four-level hypotheses instead of declaring DMR or YSF", () => {
		const result = refineChannelClassification(spectral, evidence(), {
			...context,
			obwHz: 9000,
		})
		expect(result.kind).toBe("refined")
		if (result.kind !== "refined") return
		expect(result.classification.class).toBe("fsk4-12k5")
		expect(result.classification.hypotheses.map(h => h.protocol)).toEqual([
			"dmr",
			"ysf",
			"p25p1",
			"nxdn96",
		])
		expect(result.classification.hypotheses.every(h => h.score < 1)).toBe(true)
	})

	it.each(["adjacent-leak", "suspected-intermod"] as const)(
		"preserves the existing %s cap through refinement",
		cap => {
			const result = refineChannelClassification(
				{ ...spectral, cap },
				evidence(),
				context,
			)
			expect(result).toMatchObject({
				kind: "refined",
				classification: { cap, tier: "channel" },
			})
		},
	)

	it("cannot repair an untrusted RF identity even with strong channel features", () => {
		expect(
			refineChannelClassification(spectral, evidence(), {
				...context,
				rfTrusted: false,
			}),
		).toEqual({
			kind: "fallback",
			reason: "rf-untrusted",
			classification: spectral,
		})
	})

	it("supports pager-like two levels only at the bounded ±4–5 kHz deviation", () => {
		const features = evidence()
		const pager = {
			...features,
			discriminator: {
				...features.discriminator,
				peaksHz: [-4500, 4500],
				peakStdHz: [150, 150],
				peakSpacingHz: [9000],
				stdHz: 4500,
			},
		}
		expect(
			refineChannelClassification(spectral, pager, {
				...context,
				obwHz: 12_000,
			}),
		).toMatchObject({ kind: "refined", classification: { class: "fsk2-wide" } })
		expect(
			refineChannelClassification(
				spectral,
				{
					...pager,
					discriminator: {
						...pager.discriminator,
						peaksHz: [-3000, 3000],
						peakSpacingHz: [6000],
					},
				},
				context,
			),
		).toMatchObject({ kind: "fallback", reason: "unsupported-waveform" })
	})

	it("adds only existing CTCSS metadata for supported analog FM, never DCS", () => {
		const features = evidence()
		const analog: ChannelFeatureEvidence = {
			...features,
			discriminator: {
				...features.discriminator,
				peaksHz: [0],
				peakStdHz: [2000],
				peakSpacingHz: [],
				stdHz: 2000,
				deviationHz: 5000,
				voiceBandFraction: 0.6,
			},
			ctcss: { kind: "tone", hz: 100, fraction: 0.2 },
		}
		const result = refineChannelClassification(spectral, analog, {
			...context,
			obwHz: 12_000,
		})
		expect(result).toMatchObject({
			kind: "refined",
			ctcssHz: 100,
			classification: { class: "analog-fm" },
		})
		expect(result).not.toHaveProperty("dcs")
		expect(result.classification).not.toHaveProperty("ctcssHz")
	})

	it("accepts AFSK pair evidence as a filtered hypothesis, without claiming APRS frames", () => {
		const features = evidence()
		const result = refineChannelClassification(
			spectral,
			{
				...features,
				afsk: { kind: "pair", markFraction: 0.25, spaceFraction: 0.25 },
			},
			{ ...context, protocols: ["aprs"] },
		)
		expect(result).toMatchObject({
			kind: "refined",
			classification: {
				class: "afsk-fm",
				hypotheses: [{ protocol: "aprs", score: 0.7 }],
			},
		})
		expect(result).not.toHaveProperty("validated")
	})

	it.each(["afsk", "ctcss", "symbolRate"] as const)(
		"leaves spectral evidence intact when %s is ambiguous",
		feature => {
			const ambiguous = { kind: "ambiguous" } as const
			const features: ChannelFeatureEvidence =
				feature === "afsk"
					? {
							...evidence(),
							afsk: { ...ambiguous, markFraction: 0, spaceFraction: 0 },
						}
					: feature === "ctcss"
						? { ...evidence(), ctcss: ambiguous }
						: { ...evidence(), symbolRate: ambiguous }
			const result = refineChannelClassification(spectral, features, context)
			expect(result).toMatchObject({ kind: "fallback", reason: "ambiguous" })
			expect(result.classification).toBe(spectral)
		},
	)

	it("unknown, too few samples, nonfinite values, and an empty protocol match preserve the original object", () => {
		const features = evidence()
		const results = [
			refineChannelClassification(
				spectral,
				{ kind: "unknown", reason: "gaps" },
				context,
			),
			refineChannelClassification(
				spectral,
				{ ...features, onSamples: 12_000, onDurationMs: 250 },
				context,
			),
			refineChannelClassification(
				spectral,
				{
					...features,
					discriminator: { ...features.discriminator, stdHz: Number.NaN },
				},
				context,
			),
			refineChannelClassification(spectral, features, {
				...context,
				obwHz: 17_000,
			}),
			refineChannelClassification(spectral, features, {
				...context,
				priors: { nxdn48: Number.NaN },
			}),
			refineChannelClassification(spectral, features, {
				...context,
				protocols: ["aprs"],
			}),
		]
		for (const result of results) {
			expect(result.kind).toBe("fallback")
			expect(result.classification).toBe(spectral)
		}
	})

	it("a real unmodulated channel cannot promote a spectral carrier into analog evidence", () => {
		const samples = new Float32Array(48_000)
		for (let i = 0; i < samples.length; i += 2) samples[i] = 1
		const features = extractChannelFeatures(samples, {
			outputRateHz: 48_000,
			format: "cf32",
			snrDb: 30,
		})
		const carrier: Classification = {
			class: "carrier",
			tier: "spectral",
			hypotheses: [{ protocol: "carrier", score: 0.8 }],
		}
		expect(refineChannelClassification(carrier, features, context)).toEqual({
			kind: "fallback",
			reason: "unsupported-waveform",
			classification: carrier,
		})
	})
})
