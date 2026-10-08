import { describe, expect, it } from "vitest"
import type { DecoderRateRequirements } from "@wavekit/api-types"
import {
	assessDecoderRate,
	validateDecoderRateRequirements,
} from "../../../src/decoders/rate-resolver.js"

// Synthetic requirements exercise the policy; these are not builtin RF claims.
const requirements: DecoderRateRequirements = {
	version: 1,
	sourceKind: "iq",
	capture: {
		accepted: [{ kind: "range", minHz: 96_000, maxHz: 2_400_000 }],
		preferredHz: [2_400_000],
		minimum: {
			hz: 96_000,
			basis: "implementation",
			evidence: "synthetic-test-adapter",
		},
	},
	frontendIq: {
		preferredHz: 48_000,
		accepted: [{ kind: "range", minHz: 48_000, maxHz: 60_000 }],
	},
	decoderInput: {
		kind: "audio_pcm",
		format: "s16le",
		preferredHz: 22_050,
		accepted: [{ kind: "discrete", valuesHz: [22_050] }],
	},
}

const adapter = {
	adaptation: "integer-decimation" as const,
	frontendRateHz: 48_000,
	decoderInputKind: "audio_pcm" as const,
	decoderInputRateHz: 22_050,
	decoderInputFormat: "s16le",
}

describe("decoder rate assessment (reporting only)", () => {
	it("supports an audio-only declaration without a capture requirement", () => {
		const req: DecoderRateRequirements = {
			version: 1,
			sourceKind: "audio_pcm",
			decoderInput: {
				kind: "audio_pcm",
				preferredHz: 48_000,
				accepted: [{ kind: "discrete", valuesHz: [22_050, 48_000] }],
			},
		}
		for (const hz of [22_050, 48_000]) {
			expect(
				assessDecoderRate(req, {
					source: { kind: "audio_pcm", rateHz: hz },
					adapter: {
						adaptation: "none",
						decoderInputKind: "audio_pcm",
						decoderInputRateHz: hz,
					},
				}).verdict,
			).toBe(hz === 48_000 ? "best" : "acceptable")
		}
	})

	it("rejects a no-adaptation claim that changes rates within the same domain", () => {
		expect(() =>
			assessDecoderRate(requirements, {
				source: { kind: "iq", rateHz: 2_400_000 },
				adapter: { ...adapter, adaptation: "none" },
			}),
		).toThrow(/cannot change the rate/)
		const req: DecoderRateRequirements = {
			version: 1,
			sourceKind: "audio_pcm",
			decoderInput: requirements.decoderInput,
		}
		expect(() =>
			assessDecoderRate(req, {
				source: { kind: "audio_pcm", rateHz: 48_000 },
				adapter: {
					adaptation: "none",
					decoderInputKind: "audio_pcm",
					decoderInputRateHz: 22_050,
				},
			}),
		).toThrow(/cannot change the rate/)
	})

	it("rejects external and core-input declaration mismatches in both directions", () => {
		expect(() =>
			validateDecoderRateRequirements({
				...requirements,
				sourceKind: "external",
				frontendIq: undefined,
			}),
		).toThrow(/External/)
		expect(() =>
			validateDecoderRateRequirements({
				version: 1,
				sourceKind: "iq",
				decoderInput: { kind: "external" },
			}),
		).toThrow(/External/)
	})

	it("allows IQ-to-audio conversion without confusing the two rate domains", () => {
		const req = structuredClone(requirements)
		delete req.frontendIq
		expect(
			assessDecoderRate(req, {
				source: { kind: "iq", rateHz: 2_400_000 },
				adapter: { ...adapter, adaptation: "none", frontendRateHz: 2_400_000 },
			}).verdict,
		).toBe("best")
		expect(() =>
			validateDecoderRateRequirements({
				version: 1,
				sourceKind: "audio_pcm",
				decoderInput: { kind: "iq" },
			}),
		).toThrow(/PCM audio/)
	})

	it("keeps capture, adapted IQ and decoder audio rates separate", () => {
		expect(
			assessDecoderRate(requirements, {
				source: { kind: "iq", rateHz: 2_400_000 },
				adapter,
			}),
		).toEqual({
			verdict: "best",
			sourceKind: "iq",
			sourceRateHz: 2_400_000,
			frontendRateHz: 48_000,
			decoderInputKind: "audio_pcm",
			decoderInputRateHz: 22_050,
			adaptation: "integer-decimation",
		})
	})

	it("reports the integer-decimated realized rate instead of the target", () => {
		const result = assessDecoderRate(requirements, {
			source: { kind: "iq", rateHz: 2_048_000 },
			adapter: { ...adapter, frontendRateHz: 2_048_000 / 42 },
		})
		expect(result.verdict).toBe("acceptable")
		expect(result.frontendRateHz).toBe(2_048_000 / 42)
		expect(result.frontendRateHz).not.toBe(48_000)
	})

	it("does not make a missing capture band usable by upsampling stdin", () => {
		expect(
			assessDecoderRate(requirements, {
				source: { kind: "iq", rateHz: 48_000 },
				adapter: { ...adapter, adaptation: "resample" },
			}),
		).toMatchObject({
			verdict: "unusable",
			reasonCode: "insufficient-sample-rate",
			requiredMinimumHz: 96_000,
			requirementBasis: "implementation",
		})
	})

	it("does not invent requirements for unknown custom decoders", () => {
		expect(
			assessDecoderRate(undefined, { source: { kind: "iq", rateHz: 1 } }),
		).toMatchObject({
			verdict: "unknown",
			reasonCode: "unknown-requirements",
		})
	})

	it("keeps missing source and missing adapter evidence unknown", () => {
		expect(assessDecoderRate(requirements).reasonCode).toBe(
			"source-rate-unknown",
		)
		expect(
			assessDecoderRate(requirements, {
				source: { kind: "iq", rateHz: 2_400_000 },
			}).reasonCode,
		).toBe("adaptation-unknown")
		expect(
			assessDecoderRate(
				{
					...requirements,
					capture: undefined,
				} as unknown as DecoderRateRequirements,
				{
					source: { kind: "iq", rateHz: 2_400_000 },
					adapter,
				},
			).verdict,
		).toBe("unknown")
	})

	it("evaluates audio sources against their PCM contract", () => {
		const audio: DecoderRateRequirements = {
			version: 1,
			sourceKind: "audio_pcm",
			capture: {
				accepted: [{ kind: "discrete", valuesHz: [48_000] }],
				preferredHz: [48_000],
			},
			decoderInput: requirements.decoderInput,
		}
		expect(
			assessDecoderRate(audio, {
				source: { kind: "audio_pcm", rateHz: 48_000 },
				adapter: { ...adapter, adaptation: "resample" },
			}).verdict,
		).toBe("best")
	})

	it("does not apply a core source rate to an external-device decoder", () => {
		expect(
			assessDecoderRate(
				{
					version: 1,
					sourceKind: "external",
					decoderInput: { kind: "external" },
				},
				{
					source: { kind: "iq", rateHz: 1 },
				},
			),
		).toMatchObject({ verdict: "unknown", reasonCode: "external-input" })
	})

	it.each([
		[{ ...adapter, decoderInputKind: "iq" as const }, "unsupported-input-kind"],
		[{ ...adapter, decoderInputFormat: "f32le" }, "unsupported-input-format"],
		[{ ...adapter, frontendRateHz: 70_000 }, "unsupported-frontend-rate"],
		[
			{ ...adapter, decoderInputRateHz: 48_000 },
			"unsupported-decoder-input-rate",
		],
	])("identifies the incompatible domain", (actual, reasonCode) => {
		expect(
			assessDecoderRate(requirements, {
				source: { kind: "iq", rateHz: 2_400_000 },
				adapter: actual,
			}),
		).toMatchObject({ verdict: "unusable", reasonCode })
	})

	it("supports discrete source choices and stepped ranges", () => {
		const req = structuredClone(requirements)
		req.capture = {
			accepted: [
				{ kind: "discrete", valuesHz: [2_400_000] },
				{ kind: "range", minHz: 100_000, maxHz: 300_000, stepHz: 100_000 },
			],
			preferredHz: [2_400_000],
		}
		for (const hz of [100_000, 200_000, 300_000]) {
			expect(
				assessDecoderRate(req, { source: { kind: "iq", rateHz: hz }, adapter })
					.verdict,
			).toBe("acceptable")
		}
		for (const hz of [150_000, 400_000]) {
			expect(
				assessDecoderRate(req, { source: { kind: "iq", rateHz: hz }, adapter })
					.reasonCode,
			).toBe("unsupported-sample-rate")
		}
	})

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid observed or declared rates: %s",
		hz => {
			expect(() =>
				assessDecoderRate(requirements, { source: { kind: "iq", rateHz: hz } }),
			).toThrow()
			const req = structuredClone(requirements)
			req.capture!.preferredHz = [hz]
			expect(() => validateDecoderRateRequirements(req)).toThrow()
		},
	)

	it("rejects inverted ranges, impossible preferences and unsupported domains", () => {
		const req = structuredClone(requirements)
		req.capture!.accepted = [{ kind: "range", minHz: 200, maxHz: 100 }]
		expect(() => validateDecoderRateRequirements(req)).toThrow(/maximum/)
		req.capture!.accepted = [{ kind: "discrete", valuesHz: [1_000_000] }]
		expect(() => validateDecoderRateRequirements(req)).toThrow(/Preferred/)
		expect(() =>
			validateDecoderRateRequirements({
				...requirements,
				sourceKind: "audio_pcm",
			}),
		).toThrow(/IQ frontend/)
	})

	it("requires nonempty accepted sets and minimum evidence", () => {
		const req = structuredClone(requirements)
		req.capture!.accepted = []
		expect(() => validateDecoderRateRequirements(req)).toThrow()
		req.capture = structuredClone(requirements.capture!)
		req.capture.minimum!.evidence = " "
		expect(() => validateDecoderRateRequirements(req)).toThrow()
	})

	it("does not mutate declarations or observations", () => {
		const req = structuredClone(requirements)
		const context = {
			source: { kind: "iq" as const, rateHz: 2_400_000 },
			adapter: { ...adapter },
		}
		const before = structuredClone({ req, context })
		assessDecoderRate(req, context)
		expect({ req, context }).toEqual(before)
	})
})
