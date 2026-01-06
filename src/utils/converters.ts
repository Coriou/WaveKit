/**
 * Converts a buffer of Float32LE samples to S16LE samples.
 * Resulting buffer is half the size of the input.
 *
 * @param buffer - Buffer containing Float32LE audio data
 * @returns Buffer containing S16LE audio data
 */
export function convertFloat32ToS16LE(buffer: Buffer): Buffer {
	const sampleCount = Math.floor(buffer.length / 4)
	const output = Buffer.allocUnsafe(sampleCount * 2)

	for (let i = 0; i < sampleCount; i++) {
		const floatVal = buffer.readFloatLE(i * 4)

		// Clamp to [-1.0, 1.0]
		const clamped = Math.max(-1.0, Math.min(1.0, floatVal))

		// Scale to Int16 range
		// Multiply by 32767.5 to distribute evenly?
		// Standard is usually 32767.
		let intVal = Math.round(clamped * 32767)

		// Only required if we didn't clamp strictly or there are edge cases
		if (intVal > 32767) intVal = 32767
		if (intVal < -32768) intVal = -32768

		output.writeInt16LE(intVal, i * 2)
	}

	return output
}
