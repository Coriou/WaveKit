/** Bounded waveform evidence, not decoder output or a calibrated protocol detector. */
export const CHANNEL_FEATURE_RATE_HZ = 48_000
export const MAX_CHANNEL_FEATURE_SAMPLES = 96_000
export const MAX_CHANNEL_FEATURE_BYTES = 768_000
export const MIN_CHANNEL_FEATURE_MS = 500

export type ChannelFeatureUnknownReason =
	| "unsupported-realisation"
	| "invalid-window"
	| "sample-bound"
	| "incomplete-sample"
	| "nonfinite"
	| "gaps"
	| "ambiguous"
	| "insufficient-snr"
	| "insufficient-on-samples"
	| "unsupported-deviation"

export interface ChannelFeatureInput {
	readonly outputRateHz: number
	readonly format: string
	/** Must come from a compatible current observation; this helper cannot establish RF trust. */
	readonly snrDb: number
	readonly minMs?: number
	readonly gaps?: boolean
	readonly ambiguous?: boolean
	/** Linear complex power, in the actual channel sample domain. */
	readonly onPowerThreshold?: number
}

export interface ChannelDiscriminatorEvidence {
	readonly histogram: readonly number[]
	readonly binWidthHz: number
	readonly centerOffsetHz: number
	readonly peaksHz: readonly number[]
	readonly peakStdHz: readonly number[]
	readonly peakSpacingHz: readonly number[]
	readonly deviationHz: number
	readonly stdHz: number
	readonly voiceBandFraction: number
}

export type ChannelToneEvidence =
	| { readonly kind: "absent" }
	| { readonly kind: "ambiguous" }
	| { readonly kind: "tone"; readonly hz: number; readonly fraction: number }

interface SupportedChannelSymbol {
	readonly kind: "supported"
	readonly baud: 2400 | 4800 | 9600
	readonly fraction: number
}
export type ChannelSymbolEvidence =
	| { readonly kind: "absent" }
	| { readonly kind: "ambiguous" }
	| SupportedChannelSymbol

export interface ChannelFeatureEvidence {
	readonly kind: "evidence"
	/** Counts complex samples, not interleaved floats or wall-clock time. */
	readonly sampleCount: number
	readonly onSamples: number
	readonly durationMs: number
	readonly onDurationMs: number
	readonly discriminator: ChannelDiscriminatorEvidence
	readonly afsk: {
		readonly kind: "pair" | "absent" | "ambiguous"
		readonly markFraction: number
		readonly spaceFraction: number
	}
	readonly ctcss: ChannelToneEvidence
	readonly symbolRate: ChannelSymbolEvidence
}

export type ChannelFeatureResult =
	| { readonly kind: "unknown"; readonly reason: ChannelFeatureUnknownReason }
	| ChannelFeatureEvidence

const HISTOGRAM_BINS = 128
const HISTOGRAM_HALF_HZ = 12_000
const BIN_HZ = (2 * HISTOGRAM_HALF_HZ) / HISTOGRAM_BINS
const AUDIO_RATE = 8000
const CTCSS_HZ = [
	67, 69.3, 71.9, 74.4, 77, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100,
	103.5, 107.2, 110.9, 114.8, 118.8, 123, 127.3, 131.8, 136.5, 141.3, 146.2,
	151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5,
	186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1,
	233.6, 241.8, 250.3, 254.1,
] as const

const unknown = (
	reason: ChannelFeatureUnknownReason,
): ChannelFeatureResult => ({
	kind: "unknown",
	reason,
})

/** Normalised coherent line energy. Fixed banks avoid an FFT or an unbounded frequency search. */
function lineFraction(
	values: Float64Array,
	hz: number,
	rate: number,
	energy: number,
): number {
	if (energy <= 0 || values.length === 0) return 0
	const coefficient = 2 * Math.cos((2 * Math.PI * hz) / rate)
	let previous = 0
	let before = 0
	for (const value of values) {
		const current = value + coefficient * previous - before
		before = previous
		previous = current
	}
	const power =
		previous * previous + before * before - coefficient * previous * before
	return Math.max(0, Math.min(1, (2 * power) / (values.length * energy)))
}

function ctcssEvidence(
	audio: Float64Array,
	energy: number,
): ChannelToneEvidence {
	const lines = CTCSS_HZ.map(hz => ({
		hz,
		fraction: lineFraction(audio, hz, AUDIO_RATE, energy),
	})).sort((a, b) => b.fraction - a.fraction)
	const best = lines[0]!
	if (best.fraction < 0.12) return { kind: "absent" }
	if (lines[1]!.fraction > best.fraction * 0.65) return { kind: "ambiguous" }
	return { kind: "tone", ...best }
}

function symbolEvidence(discriminator: Float64Array): ChannelSymbolEvidence {
	const changes = new Float64Array(discriminator.length - 1)
	let mean = 0
	for (let i = 0; i < changes.length; i++) {
		changes[i] = Math.abs(discriminator[i + 1]! - discriminator[i]!)
		mean += changes[i]!
	}
	mean /= changes.length
	let energy = 0
	for (let i = 0; i < changes.length; i++) {
		changes[i] = changes[i]! - mean
		energy += changes[i]! ** 2
	}
	const lines = ([2400, 4800, 9600] as const)
		.map(baud => ({
			baud,
			fraction: lineFraction(changes, baud, CHANNEL_FEATURE_RATE_HZ, energy),
		}))
		.sort((a, b) => b.fraction - a.fraction)
	const best = lines[0]!
	if (best.fraction < 0.06) return { kind: "absent" }
	if (lines[1]!.fraction > best.fraction * 0.4) return { kind: "ambiguous" }
	return { kind: "supported", ...best }
}

function alternatingAfsk(audio: Float64Array): boolean {
	const width = 160 // 20 ms at 8 kHz; bounded coarse tone occupancy, not bit decoding.
	let marks = 0
	let spaces = 0
	const windows = Math.floor(audio.length / width)
	for (let i = 0; i < windows; i++) {
		const window = audio.subarray(i * width, (i + 1) * width)
		let energy = 0
		for (const value of window) energy += value * value
		const mark = lineFraction(window, 1200, AUDIO_RATE, energy)
		const space = lineFraction(window, 2200, AUDIO_RATE, energy)
		if (mark > 0.4 && space < 0.15) marks++
		if (space > 0.4 && mark < 0.15) spaces++
	}
	return marks >= windows * 0.15 && spaces >= windows * 0.15
}

/**
 * The caller supplies complete interleaved cf32 collected under its own current-binding fence.
 * No clock, stream, provider, decoder, or persistence effect occurs here. Thresholds are conservative
 * synthetic-fixture heuristics; production enabling still requires an accepted measured profile.
 */
export function extractChannelFeatures(
	samples: Float32Array,
	input: ChannelFeatureInput,
): ChannelFeatureResult {
	if (input.outputRateHz !== CHANNEL_FEATURE_RATE_HZ || input.format !== "cf32")
		return unknown("unsupported-realisation")
	const minMs = input.minMs ?? MIN_CHANNEL_FEATURE_MS
	if (!Number.isInteger(minMs) || minMs < 300 || minMs > 2000)
		return unknown("invalid-window")
	if (
		samples.length > 2 * MAX_CHANNEL_FEATURE_SAMPLES ||
		samples.byteLength > MAX_CHANNEL_FEATURE_BYTES
	)
		return unknown("sample-bound")
	if (samples.length % 2 !== 0) return unknown("incomplete-sample")
	if (input.gaps) return unknown("gaps")
	if (input.ambiguous) return unknown("ambiguous")
	if (!Number.isFinite(input.snrDb) || input.snrDb < 10)
		return unknown("insufficient-snr")
	const threshold = input.onPowerThreshold ?? 1e-8
	if (!Number.isFinite(threshold) || threshold < 0) return unknown("nonfinite")
	for (const value of samples)
		if (!Number.isFinite(value)) return unknown("nonfinite")
	const count = samples.length / 2
	const required = Math.ceil(
		(Math.max(MIN_CHANNEL_FEATURE_MS, minMs) * CHANNEL_FEATURE_RATE_HZ) / 1000,
	)
	if (count < required) return unknown("insufficient-on-samples")
	const frequencies = new Float64Array(count - 1)
	const on = new Uint8Array(count)
	let onSamples = 0
	for (let n = 0; n < count; n++) {
		if (samples[2 * n]! ** 2 + samples[2 * n + 1]! ** 2 > threshold) {
			on[n] = 1
			onSamples++
		}
	}
	if (onSamples < required) return unknown("insufficient-on-samples")
	// Do not join separated bursts or insert zeros into tone/symbol calculations.
	// This first increment requires the complete window to be on, preserving a contiguous timebase.
	if (onSamples !== count) return unknown("insufficient-on-samples")
	let mean = 0
	for (let n = 1; n < count; n++) {
		const re = samples[2 * n]!
		const im = samples[2 * n + 1]!
		const previousRe = samples[2 * n - 2]!
		const previousIm = samples[2 * n - 1]!
		const hz =
			(Math.atan2(
				im * previousRe - re * previousIm,
				re * previousRe + im * previousIm,
			) *
				CHANNEL_FEATURE_RATE_HZ) /
			(2 * Math.PI)
		frequencies[n - 1] = hz
		mean += hz
	}
	mean /= frequencies.length
	const histogram = new Array<number>(HISTOGRAM_BINS).fill(0)
	let energy = 0
	let deviation = 0
	for (let n = 0; n < frequencies.length; n++) {
		const hz = frequencies[n]! - mean
		if (Math.abs(hz) >= HISTOGRAM_HALF_HZ)
			return unknown("unsupported-deviation")
		frequencies[n] = hz
		energy += hz * hz
		deviation = Math.max(deviation, Math.abs(hz))
		const bin = Math.floor((hz + HISTOGRAM_HALF_HZ) / BIN_HZ)
		histogram[bin] = histogram[bin]! + 1
	}
	const smoothed = histogram.map(
		(_, i) =>
			((histogram[i - 1] ?? 0) + histogram[i]! + (histogram[i + 1] ?? 0)) / 3,
	)
	const peakFloor = Math.max(...smoothed) * 0.1
	const peaksHz: number[] = []
	const peakStdHz: number[] = []
	for (let i = 0; i < smoothed.length; i++) {
		if (smoothed[i]! <= peakFloor) continue
		let weight = 0
		let sum = 0
		let square = 0
		while (i < smoothed.length && smoothed[i]! > peakFloor) {
			const hz = (i + 0.5) * BIN_HZ - HISTOGRAM_HALF_HZ
			weight += smoothed[i]!
			sum += smoothed[i]! * hz
			square += smoothed[i]! * hz * hz
			i++
		}
		const center = sum / weight
		peaksHz.push(center)
		peakStdHz.push(Math.sqrt(Math.max(0, square / weight - center * center)))
	}
	const audio = new Float64Array(Math.floor(frequencies.length / 6))
	let audioEnergy = 0
	let bandEnergy = 0
	let low = 0
	let band = 0
	const lowAlpha = 1 - Math.exp((-2 * Math.PI * 300) / AUDIO_RATE)
	const bandAlpha = 1 - Math.exp((-2 * Math.PI * 3000) / AUDIO_RATE)
	for (let n = 0; n < audio.length; n++) {
		let value = 0
		for (let k = 0; k < 6; k++) value += frequencies[n * 6 + k]! / 6
		audio[n] = value
		audioEnergy += value * value
		low += lowAlpha * (value - low)
		band += bandAlpha * (value - low - band)
		bandEnergy += band * band
	}
	const markFraction = lineFraction(audio, 1200, AUDIO_RATE, audioEnergy)
	const spaceFraction = lineFraction(audio, 2200, AUDIO_RATE, audioEnergy)
	const pair =
		markFraction >= 0.08 &&
		spaceFraction >= 0.08 &&
		markFraction + spaceFraction >= 0.4 &&
		alternatingAfsk(audio)
	const afskKind = pair
		? "pair"
		: Math.max(markFraction, spaceFraction) >= 0.08
			? "ambiguous"
			: "absent"
	return {
		kind: "evidence",
		sampleCount: count,
		onSamples,
		durationMs: (count * 1000) / CHANNEL_FEATURE_RATE_HZ,
		onDurationMs: (onSamples * 1000) / CHANNEL_FEATURE_RATE_HZ,
		discriminator: {
			histogram,
			binWidthHz: BIN_HZ,
			centerOffsetHz: mean,
			peaksHz,
			peakStdHz,
			peakSpacingHz: peaksHz.slice(1).map((hz, i) => hz - peaksHz[i]!),
			deviationHz: deviation,
			stdHz: Math.sqrt(energy / frequencies.length),
			voiceBandFraction:
				audioEnergy > 0 ? Math.min(1, bandEnergy / audioEnergy) : 0,
		},
		afsk: { kind: afskKind, markFraction, spaceFraction },
		ctcss: ctcssEvidence(audio, audioEnergy),
		symbolRate: symbolEvidence(frequencies),
	}
}
