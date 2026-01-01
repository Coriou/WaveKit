// Format Converter - Transform streams for audio format conversion
// Requirements: 3.1, 3.2, 3.3, 3.4

import { Transform, type TransformCallback } from "node:stream"

/**
 * Convert 32-bit float [-1.0, 1.0] to 16-bit signed integer [-32768, 32767]
 * Implements Requirement 3.1
 */
export function createF32ToS16Transform(): Transform {
	return new Transform({
		objectMode: false,
		transform(
			chunk: Buffer,
			_encoding: BufferEncoding,
			callback: TransformCallback,
		) {
			// F32 samples are 4 bytes each, S16 samples are 2 bytes each
			const sampleCount = Math.floor(chunk.length / 4)
			const output = Buffer.alloc(sampleCount * 2)

			for (let i = 0; i < sampleCount; i++) {
				const f32Sample = chunk.readFloatLE(i * 4)
				// Clamp to [-1.0, 1.0] range, then scale to S16 range
				const clamped = Math.max(-1.0, Math.min(1.0, f32Sample))
				const s16Sample = Math.round(clamped * 32767)
				// Clamp to S16 range [-32768, 32767]
				const clampedS16 = Math.max(-32768, Math.min(32767, s16Sample))
				output.writeInt16LE(clampedS16, i * 2)
			}

			callback(null, output)
		},
	})
}

/**
 * Convert 16-bit signed integer [-32768, 32767] to 32-bit float [-1.0, 1.0]
 * Implements Requirement 3.2
 */
export function createS16ToF32Transform(): Transform {
	return new Transform({
		objectMode: false,
		transform(
			chunk: Buffer,
			_encoding: BufferEncoding,
			callback: TransformCallback,
		) {
			// S16 samples are 2 bytes each, F32 samples are 4 bytes each
			const sampleCount = Math.floor(chunk.length / 2)
			const output = Buffer.alloc(sampleCount * 4)

			for (let i = 0; i < sampleCount; i++) {
				const s16Sample = chunk.readInt16LE(i * 2)
				// Divide by 32768 to normalize to [-1.0, 1.0) range
				const f32Sample = s16Sample / 32768
				output.writeFloatLE(f32Sample, i * 4)
			}

			callback(null, output)
		},
	})
}

/**
 * Resample audio using linear interpolation
 * Converts audio from source sample rate to target sample rate
 * Implements Requirement 3.3
 */
export function createResampleTransform(
	fromRate: number,
	toRate: number,
): Transform {
	const ratio = toRate / fromRate
	let lastSample = 0
	let fractionalPosition = 0

	return new Transform({
		objectMode: false,
		transform(
			chunk: Buffer,
			_encoding: BufferEncoding,
			callback: TransformCallback,
		) {
			// Assuming S16LE input (2 bytes per sample)
			const inputSampleCount = Math.floor(chunk.length / 2)

			if (inputSampleCount === 0) {
				callback(null, Buffer.alloc(0))
				return
			}

			// Calculate expected output samples
			const outputSampleCount = Math.round(inputSampleCount * ratio)
			const output = Buffer.alloc(outputSampleCount * 2)

			let outputIndex = 0

			for (let i = 0; i < outputSampleCount; i++) {
				// Calculate the position in the input buffer
				const inputPosition = fractionalPosition + i / ratio
				const inputIndex = Math.floor(inputPosition)
				const fraction = inputPosition - inputIndex

				// Get samples for interpolation
				let sample1: number
				let sample2: number

				if (inputIndex < 0) {
					sample1 = lastSample
					sample2 = inputSampleCount > 0 ? chunk.readInt16LE(0) : lastSample
				} else if (inputIndex >= inputSampleCount - 1) {
					sample1 = chunk.readInt16LE(
						Math.min(inputIndex, inputSampleCount - 1) * 2,
					)
					sample2 = sample1
				} else {
					sample1 = chunk.readInt16LE(inputIndex * 2)
					sample2 = chunk.readInt16LE((inputIndex + 1) * 2)
				}

				// Linear interpolation
				const interpolated = Math.round(
					sample1 + fraction * (sample2 - sample1),
				)
				const clamped = Math.max(-32768, Math.min(32767, interpolated))

				if (outputIndex < outputSampleCount) {
					output.writeInt16LE(clamped, outputIndex * 2)
					outputIndex++
				}
			}

			// Store last sample for next chunk continuity
			if (inputSampleCount > 0) {
				lastSample = chunk.readInt16LE((inputSampleCount - 1) * 2)
			}

			// Update fractional position for next chunk
			fractionalPosition = (fractionalPosition + inputSampleCount) % 1

			callback(null, output.subarray(0, outputIndex * 2))
		},
	})
}

// Helper functions for direct sample conversion (useful for testing)

/**
 * Convert a single S16 sample to F32
 */
export function s16ToF32(s16Value: number): number {
	return s16Value / 32768
}

/**
 * Convert a single F32 sample to S16
 */
export function f32ToS16(f32Value: number): number {
	const clamped = Math.max(-1.0, Math.min(1.0, f32Value))
	const s16 = Math.round(clamped * 32767)
	return Math.max(-32768, Math.min(32767, s16))
}
