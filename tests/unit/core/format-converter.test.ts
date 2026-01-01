/**
 * Format Converter Property-Based Tests
 *
 * Tests for audio format conversion transforms (F32↔S16, resampling).
 * Requirements: 3.1, 3.2, 3.3
 */

import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import {
	createF32ToS16Transform,
	createS16ToF32Transform,
	createResampleTransform,
	s16ToF32,
	f32ToS16,
} from "../../../src/core/format-converter.js"

describe("Format Converter", () => {
	describe("Helper Functions", () => {
		it("should convert S16 to F32 correctly", () => {
			expect(s16ToF32(0)).toBe(0)
			expect(s16ToF32(32767)).toBeCloseTo(0.999969, 5)
			expect(s16ToF32(-32768)).toBe(-1)
		})

		it("should convert F32 to S16 correctly", () => {
			expect(f32ToS16(0)).toBe(0)
			expect(f32ToS16(1.0)).toBe(32767)
			expect(f32ToS16(-1.0)).toBe(-32767)
		})

		it("should clamp F32 values outside [-1, 1] range", () => {
			expect(f32ToS16(1.5)).toBe(32767)
			expect(f32ToS16(-1.5)).toBe(-32767)
			expect(f32ToS16(100)).toBe(32767)
			expect(f32ToS16(-100)).toBe(-32767)
		})
	})

	describe("Transform Streams", () => {
		it("should create F32 to S16 transform stream", () => {
			const transform = createF32ToS16Transform()
			expect(transform).toBeDefined()
			expect(transform.readable).toBe(true)
			expect(transform.writable).toBe(true)
		})

		it("should create S16 to F32 transform stream", () => {
			const transform = createS16ToF32Transform()
			expect(transform).toBeDefined()
			expect(transform.readable).toBe(true)
			expect(transform.writable).toBe(true)
		})

		it("should create resample transform stream", () => {
			const transform = createResampleTransform(48000, 44100)
			expect(transform).toBeDefined()
			expect(transform.readable).toBe(true)
			expect(transform.writable).toBe(true)
		})
	})
})

describe("Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 7: Format Conversion Round-Trip
	 * Validates: Requirements 3.1, 3.2
	 *
	 * For any 16-bit signed integer value V in range [-32768, 32767],
	 * converting V to float and back to S16 should produce a value
	 * within ±1 of V (accounting for floating-point precision).
	 */
	describe("Property 7: Format Conversion Round-Trip", () => {
		it("should round-trip S16 values within ±1 using helper functions", () => {
			fc.assert(
				fc.property(fc.integer({ min: -32768, max: 32767 }), s16Value => {
					const f32 = s16ToF32(s16Value)
					const roundTrip = f32ToS16(f32)
					const diff = Math.abs(roundTrip - s16Value)
					return diff <= 1
				}),
				{ numRuns: 100 },
			)
		})

		it("should round-trip S16 values within ±1 using transform streams", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate array of S16 samples (even number for proper buffer alignment)
					fc
						.array(fc.integer({ min: -32768, max: 32767 }), {
							minLength: 2,
							maxLength: 100,
						})
						.filter(arr => arr.length % 2 === 0 || arr.length === 1),
					async samples => {
						// Create input buffer with S16 samples
						const inputBuffer = Buffer.alloc(samples.length * 2)
						samples.forEach((sample, i) => {
							inputBuffer.writeInt16LE(sample, i * 2)
						})

						// Convert S16 → F32 → S16
						const s16ToF32Transform = createS16ToF32Transform()
						const f32ToS16Transform = createF32ToS16Transform()

						// Process through transforms
						const f32Result = await processTransform(
							s16ToF32Transform,
							inputBuffer,
						)
						const roundTripResult = await processTransform(
							f32ToS16Transform,
							f32Result,
						)

						// Verify round-trip produces values within ±1
						const outputSamples = Math.floor(roundTripResult.length / 2)
						for (let i = 0; i < Math.min(samples.length, outputSamples); i++) {
							const original = samples[i]!
							const roundTripped = roundTripResult.readInt16LE(i * 2)
							const diff = Math.abs(roundTripped - original)
							if (diff > 1) {
								return false
							}
						}
						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should preserve F32 values in valid range after round-trip", () => {
			fc.assert(
				fc.property(
					// Generate F32 values in valid range [-1.0, 1.0]
					fc.float({ min: -1.0, max: 1.0, noNaN: true }),
					f32Value => {
						const s16 = f32ToS16(f32Value)
						const roundTrip = s16ToF32(s16)
						// The round-trip should be close to original (within quantization error)
						// S16 has ~16 bits of precision, so error should be < 1/32768 ≈ 0.00003
						const diff = Math.abs(roundTrip - f32Value)
						return diff < 0.001 // Allow for quantization error
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	/**
	 * Feature: wavekit-core, Property 8: Resample Length Ratio
	 * Validates: Requirements 3.3
	 *
	 * For any audio buffer of length L samples at rate R1, resampling to rate R2
	 * should produce a buffer of length approximately L * (R2 / R1) samples
	 * (within ±1 sample for rounding).
	 */
	describe("Property 8: Resample Length Ratio", () => {
		it("should produce output length proportional to sample rate ratio", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate source sample rate (common audio rates)
					fc.constantFrom(8000, 16000, 22050, 44100, 48000, 96000),
					// Generate target sample rate (common audio rates)
					fc.constantFrom(8000, 16000, 22050, 44100, 48000, 96000),
					// Generate input sample count (reasonable range for testing)
					fc.integer({ min: 10, max: 1000 }),
					async (fromRate, toRate, inputSampleCount) => {
						// Create input buffer with S16 samples
						const inputBuffer = Buffer.alloc(inputSampleCount * 2)
						for (let i = 0; i < inputSampleCount; i++) {
							// Generate a simple sine wave for realistic audio data
							const sample = Math.round(Math.sin(i * 0.1) * 16000)
							inputBuffer.writeInt16LE(sample, i * 2)
						}

						const transform = createResampleTransform(fromRate, toRate)
						const outputBuffer = await processTransform(transform, inputBuffer)

						const outputSampleCount = Math.floor(outputBuffer.length / 2)
						const expectedSampleCount = Math.round(
							inputSampleCount * (toRate / fromRate),
						)

						// Allow ±2 samples tolerance for rounding and interpolation edge effects
						const diff = Math.abs(outputSampleCount - expectedSampleCount)
						return diff <= 2
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should maintain ratio for upsampling (increasing sample rate)", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate lower source rate
					fc.constantFrom(8000, 16000, 22050),
					// Generate higher target rate
					fc.constantFrom(44100, 48000, 96000),
					// Generate input sample count
					fc.integer({ min: 50, max: 500 }),
					async (fromRate, toRate, inputSampleCount) => {
						// Ensure we're upsampling
						if (fromRate >= toRate) return true

						const inputBuffer = Buffer.alloc(inputSampleCount * 2)
						for (let i = 0; i < inputSampleCount; i++) {
							const sample = Math.round(Math.sin(i * 0.05) * 10000)
							inputBuffer.writeInt16LE(sample, i * 2)
						}

						const transform = createResampleTransform(fromRate, toRate)
						const outputBuffer = await processTransform(transform, inputBuffer)

						const outputSampleCount = Math.floor(outputBuffer.length / 2)
						const ratio = toRate / fromRate

						// Output should be larger than input for upsampling
						// And approximately ratio times the input length
						const expectedMin = Math.floor(inputSampleCount * ratio) - 2
						const expectedMax = Math.ceil(inputSampleCount * ratio) + 2

						return (
							outputSampleCount >= expectedMin &&
							outputSampleCount <= expectedMax
						)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should maintain ratio for downsampling (decreasing sample rate)", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate higher source rate
					fc.constantFrom(44100, 48000, 96000),
					// Generate lower target rate
					fc.constantFrom(8000, 16000, 22050),
					// Generate input sample count
					fc.integer({ min: 100, max: 1000 }),
					async (fromRate, toRate, inputSampleCount) => {
						// Ensure we're downsampling
						if (fromRate <= toRate) return true

						const inputBuffer = Buffer.alloc(inputSampleCount * 2)
						for (let i = 0; i < inputSampleCount; i++) {
							const sample = Math.round(Math.sin(i * 0.02) * 15000)
							inputBuffer.writeInt16LE(sample, i * 2)
						}

						const transform = createResampleTransform(fromRate, toRate)
						const outputBuffer = await processTransform(transform, inputBuffer)

						const outputSampleCount = Math.floor(outputBuffer.length / 2)
						const ratio = toRate / fromRate

						// Output should be smaller than input for downsampling
						// And approximately ratio times the input length
						const expectedMin = Math.floor(inputSampleCount * ratio) - 2
						const expectedMax = Math.ceil(inputSampleCount * ratio) + 2

						return (
							outputSampleCount >= expectedMin &&
							outputSampleCount <= expectedMax
						)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should produce same length when sample rates are equal", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate sample rate
					fc.constantFrom(8000, 16000, 44100, 48000),
					// Generate input sample count
					fc.integer({ min: 10, max: 500 }),
					async (sampleRate, inputSampleCount) => {
						const inputBuffer = Buffer.alloc(inputSampleCount * 2)
						for (let i = 0; i < inputSampleCount; i++) {
							const sample = Math.round(Math.sin(i * 0.1) * 12000)
							inputBuffer.writeInt16LE(sample, i * 2)
						}

						const transform = createResampleTransform(sampleRate, sampleRate)
						const outputBuffer = await processTransform(transform, inputBuffer)

						const outputSampleCount = Math.floor(outputBuffer.length / 2)

						// When rates are equal, output should equal input (±1 for rounding)
						const diff = Math.abs(outputSampleCount - inputSampleCount)
						return diff <= 1
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})

/**
 * Helper function to process data through a transform stream
 */
function processTransform(
	transform: NodeJS.ReadWriteStream,
	input: Buffer,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []

		transform.on("data", (chunk: Buffer) => {
			chunks.push(chunk)
		})

		transform.on("end", () => {
			resolve(Buffer.concat(chunks))
		})

		transform.on("error", reject)

		transform.write(input)
		transform.end()
	})
}
