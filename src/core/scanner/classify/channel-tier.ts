import type { Classification, ScannerClass, ScannerProtocol } from "../types.js"
import { applyPriors, CLASS_HYPOTHESES } from "./classifier.js"
import type { ChannelFeatureResult } from "./channel-features.js"
import { MAX_CHANNEL_FEATURE_SAMPLES, MIN_CHANNEL_FEATURE_MS } from "./channel-features.js"

export interface ChannelTierContext {
	readonly priors: Partial<Record<ScannerProtocol, number>>
	readonly protocols: ScannerProtocol[]
	/** Established by current spectral/capture provenance, never by these features. */
	readonly rfTrusted: boolean
	readonly obwHz: number
}

export type ChannelTierFallbackReason =
	| "feature-unknown"
	| "rf-untrusted"
	| "unsupported-bandwidth"
	| "ambiguous"
	| "invalid-evidence"
	| "unsupported-waveform"
	| "protocol-filtered"

export type ChannelTierResult =
	| { readonly kind: "fallback"; readonly reason: ChannelTierFallbackReason; readonly classification: Classification }
	| { readonly kind: "refined"; readonly classification: Classification; readonly ctcssHz?: number }

/** Conservative waveform refinement; hypotheses remain hypotheses, never decoded identity. */
export function refineChannelClassification(
	spectral: Classification,
	features: ChannelFeatureResult,
	context: ChannelTierContext,
): ChannelTierResult {
	const fallback = (reason: ChannelTierFallbackReason): ChannelTierResult => ({
		kind: "fallback",
		reason,
		classification: spectral,
	})
	if (!context.rfTrusted) return fallback("rf-untrusted")
	if (!Number.isFinite(context.obwHz) || context.obwHz <= 0 || context.obwHz > 16_000)
		return fallback("unsupported-bandwidth")
	if (features.kind === "unknown") return fallback("feature-unknown")
	const d = features.discriminator
	if (
		features.sampleCount > MAX_CHANNEL_FEATURE_SAMPLES ||
		!Number.isInteger(features.sampleCount) ||
		features.onSamples !== features.sampleCount ||
		features.onDurationMs < MIN_CHANNEL_FEATURE_MS ||
		features.durationMs !== features.sampleCount / 48 ||
		features.onDurationMs !== features.onSamples / 48 ||
		!Number.isFinite(features.onDurationMs) ||
		d.histogram.length !== 128 ||
		d.peaksHz.length > 128 ||
		d.peaksHz.length !== d.peakStdHz.length ||
		d.peakSpacingHz.length !== Math.max(0, d.peaksHz.length - 1) ||
		![d.binWidthHz, d.centerOffsetHz, d.deviationHz, d.stdHz, d.voiceBandFraction,
			...d.histogram, ...d.peaksHz, ...d.peakStdHz, ...d.peakSpacingHz,
			features.afsk.markFraction, features.afsk.spaceFraction,
			...Object.values(context.priors)].every(Number.isFinite)
		|| d.stdHz < 0 || d.deviationHz < 0 || d.voiceBandFraction < 0 || d.voiceBandFraction > 1
		|| d.histogram.some(count => count < 0)
		|| d.peakStdHz.some(std => std < 0)
		|| d.peakSpacingHz.some(spacing => spacing <= 0)
		|| (features.ctcss.kind === "tone" && (!Number.isFinite(features.ctcss.hz) || features.ctcss.hz < 67 || features.ctcss.hz > 254.1 || !Number.isFinite(features.ctcss.fraction)))
		|| (features.symbolRate.kind === "supported" && (!Number.isFinite(features.symbolRate.fraction) || ![2400, 4800, 9600].includes(features.symbolRate.baud)))
	) return fallback("invalid-evidence")
	if (features.afsk.kind === "pair" && (features.afsk.markFraction < 0.08 || features.afsk.spaceFraction < 0.08 || features.afsk.markFraction + features.afsk.spaceFraction < 0.4))
		return fallback("invalid-evidence")
	if (features.afsk.kind === "ambiguous" || features.ctcss.kind === "ambiguous" || features.symbolRate.kind === "ambiguous")
		return fallback("ambiguous")
	let cls: ScannerClass | undefined
	if (features.afsk.kind === "pair") {
		cls = "afsk-fm"
	} else if (
		d.peaksHz.length === 4 &&
		d.stdHz < 2000 &&
		d.peakStdHz.every(std => std < 500) &&
		d.peakSpacingHz.every(spacing => spacing >= 700) &&
		Math.max(...d.peakSpacingHz) <= Math.min(...d.peakSpacingHz) * 1.2
	) {
		cls = context.obwHz <= 5500 ? "fsk4-6k25" : "fsk4-12k5"
	} else if (
		d.peaksHz.length === 2 &&
		d.peaksHz[0]! >= -5000 && d.peaksHz[0]! <= -4000 &&
		d.peaksHz[1]! >= 4000 && d.peaksHz[1]! <= 5000 &&
		d.peakStdHz.every(std => std < 500)
	) {
		cls = "fsk2-wide"
	} else if (
		d.peaksHz.length === 1 &&
		d.stdHz >= 1000 && d.stdHz <= 5000 &&
		d.deviationHz <= 7500 &&
		d.voiceBandFraction >= 0.3
	) {
		cls = "analog-fm"
	}
	if (!cls) return fallback("unsupported-waveform")
	const hypotheses = applyPriors(CLASS_HYPOTHESES[cls], context)
	if (hypotheses.length === 0) return fallback("protocol-filtered")
	return {
		kind: "refined",
		classification: { ...spectral, class: cls, hypotheses, tier: "channel" },
		...(cls === "analog-fm" && features.ctcss.kind === "tone"
			? { ctcssHz: features.ctcss.hz } : {}),
	}
}
