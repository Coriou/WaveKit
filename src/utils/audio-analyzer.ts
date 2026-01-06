import type { Logger } from "./logger.js"

export type DetectedFormat = "FLOAT32LE" | "S16LE" | "UNKNOWN"

/**
 * Analyzes a buffer to detect if it contains Float32LE or S16LE audio data.
 * Uses statistical heuristics based on value ranges and distribution.
 *
 * @param buffer - The buffer to analyze
 * @param parsedLogger - Optional logger
 * @returns Detected format
 */
export function detectAudioFormat(
	buffer: Buffer,
	logger?: Logger,
): DetectedFormat {
	if (buffer.length < 4) {
		return "UNKNOWN"
	}

	// 1. Analyze as Float32LE
	// Float32 audio samples are usually in range [-1.0, 1.0].
	// Valid floats should probably not be NaN or Infinity.
	// We'll check a subset of samples to avoid performance hit on large buffers.
	let validSamples = 0
	let clippedSamples = 0
	let invalidSamples = 0 // NaN, Inf, or extremely large values
	let zeroSamples = 0

	// Check every 4 bytes (stride 1 sample)
	const float32Count = Math.floor(buffer.length / 4)
	const samplesToCheck = Math.min(float32Count, 1024) // Check max 1024 samples

	for (let i = 0; i < samplesToCheck; i++) {
		const val = buffer.readFloatLE(i * 4)

		if (Number.isNaN(val) || !Number.isFinite(val)) {
			invalidSamples++
			continue
		}

		if (val === 0) {
			zeroSamples++
		}

		if (Math.abs(val) <= 1.0) {
			validSamples++
		} else if (Math.abs(val) < 100.0) {
			// Allow some headroom for over-amplified signals,
			// but if it's huge, it's likely not audio (or it's int16 interpreted as float)
			clippedSamples++
		} else {
			// Values > 100.0 are very unlikely for normalized float audio
			// S16LE values interpreted as float can be huge or tiny depending on bit pattern
			invalidSamples++
		}
	}

	const float32Confidence = (validSamples + clippedSamples) / samplesToCheck

	// 2. Analyze as S16LE
	// S16LE samples are -32768 to 32767.
	// Real world audio often centers around 0 but uses the full range.
	// If we interpret Float32 (0.0001) as Int16, it might look like noise or specific patterns.
	// If we interpret Int16 (30000) as Float, it looks like a huge number (4.2e-41 or similar depending on mantissa).

	// Heuristic Decision:
	// If > 90% of samples look like valid Float32 audio ranges, it's likely Float32.
	// Unless it's all zeros (silence), which is ambiguous.

	if (samplesToCheck > 10 && float32Confidence > 0.9) {
		// Differentiate silence
		if (zeroSamples === samplesToCheck) {
			// All zeros is valid for both, but we can return UNKNOWN or default to one.
			// Currently returning UNKNOWN to let caller decide or wait for more data.
			return "UNKNOWN"
		}
		return "FLOAT32LE"
	}

	// If failed float check, likely S16LE (or garbage)
	// We could do S16LE specific checks here (e.g. check for DC offset, reasonable amplitude),
	// but mostly if it is NOT float, we assume S16LE for our use case.

	return "S16LE"
}
