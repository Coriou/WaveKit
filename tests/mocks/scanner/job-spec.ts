import type {
	Hop,
	HopPlan,
	NormalisedJobSpec,
} from "../../../src/core/scanner/types.js"
import { DEFAULT_CAPTURE } from "../../../src/core/scanner/evidence/capture-spec.js"

export function makeNormalisedSpec(
	patch: Partial<NormalisedJobSpec> = {},
): NormalisedJobSpec {
	return {
		sourceId: "src-1",
		sensitivity: "normal",
		priority: 50,
		mode: "sweep",
		kind: "discover",
		ranges: [
			{
				startHz: 400_000_000,
				endHz: 470_000_000,
				rasters: [{ spacingHz: 12_500, firstChannelHz: 400_006_250 }],
				obwHz: [9_000],
			},
		],
		exclusions: [],
		protocols: [],
		fftSize: 2048,
		integrationMs: 50,
		thresholdDb: null,
		dwellMs: 185,
		settleMs: 35,
		hold: {
			policy: "hold",
			confirmHoldMs: { "tdma-ms": 1_800 },
			maxHoldMs: 60_000,
			hangMs: 2_000,
		},
		revisit: { share: 0.3, maxIntervalMs: null },
		record: { voice: true, analog: true, data: true },
		evidence: { psd: true, iq: false },
		tuner: {
			sampleRateHz: null,
			gainTenthsDb: 496,
			agc: false,
			overload: "flag",
		},
		stop: { afterSweeps: null, afterMs: null, onFirstDecoded: false },
		takeover: true,
		resume: { autoAfterIdleMs: 60_000, onBoot: false },
		txDurationHintMs: 5_000,
		capture: { ...DEFAULT_CAPTURE },
		provenance: { dwellMs: "default" },
		...patch,
	}
}

export function makeHopPlan(
	centresHz: number[],
	halfSpanHz = 819_200,
): HopPlan {
	return {
		hops: centresHz.map(
			(centreHz, index): Hop => ({
				index,
				centreHz,
				covered: {
					startHz: centreHz - halfSpanHz,
					endHz: centreHz + halfSpanHz,
				},
				channelCount: Math.round((2 * halfSpanHz) / 12_500),
				dcAdjacentChannelsHz: [],
				excluded: [],
				dcMinEdgeHz: 1_750,
			}),
		),
		usableHalfSpanHz: halfSpanHz,
		dcGuardHz: 1_500,
		ppmMarginHz: 900,
	}
}
