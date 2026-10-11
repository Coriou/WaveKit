import { describe, it, expect } from "vitest"
import { FmAudioDemod } from "../../../../src/core/scanner/channel/fm-audio.js"

function tone(hz: number, amplitude = 0.2, samples = 48_000): Float32Array {
	const iq = new Float32Array(samples * 2)
	let phase = 0
	for (let i = 0; i < samples; i++) {
		phase +=
			(2 *
				Math.PI *
				5000 *
				amplitude *
				Math.sin((2 * Math.PI * hz * i) / 48_000)) /
			48_000
		iq[2 * i] = Math.cos(phase)
		iq[2 * i + 1] = Math.sin(phase)
	}
	return iq
}
function rms(pcm: Int16Array): number {
	return Math.sqrt(
		pcm.slice(1000).reduce((sum, value) => sum + (value / 32767) ** 2, 0) /
			(pcm.length - 1000),
	)
}
describe("FM streaming audio", () => {
	it("has independent discriminator tone gain and suppresses frequencies above 3 kHz", () => {
		const pass = rms(
			new FmAudioDemod({ deemphasisUs: null }).process(tone(1000)),
		)
		const stop = rms(
			new FmAudioDemod({ deemphasisUs: null }).process(tone(6000)),
		)
		expect(pass).toBeCloseTo(0.2 / Math.sqrt(2), 3)
		expect(stop / pass).toBeLessThan(0.001)
	})
	it("applies the expected single pole deemphasis and makeup gain", () => {
		const actual = rms(new FmAudioDemod().process(tone(1000, 0.1)))
		const expected =
			((0.1 / Math.sqrt(2)) * 4) /
			Math.sqrt(1 + (2 * Math.PI * 1000 * 750e-6) ** 2)
		expect(actual).toBeCloseTo(expected, 3)
	})
	it("is exactly invariant across odd floats, empty chunks and reset", () => {
		const iq = tone(731, 0.2, 4800)
		const whole = new FmAudioDemod().process(iq)
		const demod = new FmAudioDemod()
		const result: number[] = []
		for (let offset = 0; offset < iq.length; ) {
			const count = (offset % 137) + 1
			result.push(...demod.process(iq.subarray(offset, offset + count)))
			expect(demod.process(new Float32Array())).toHaveLength(0)
			offset += count
		}
		expect(result).toEqual([...whole])
		demod.process(new Float32Array([1]))
		demod.reset()
		expect(demod.process(iq)).toEqual(whole)
	})
	it("rejects invalid options and nonfinite input without poisoning retained state", () => {
		for (const options of [
			{ inputRateHz: 8000 },
			{ maxDeviationHz: 0 },
			{ maxDeviationHz: NaN },
			{ deemphasisUs: -1 },
		])
			expect(() => new FmAudioDemod(options)).toThrow()
		const demod = new FmAudioDemod()
		demod.process(new Float32Array([1]))
		expect(() => demod.process(new Float32Array([NaN]))).toThrow()
		expect(
			demod.process(new Float32Array([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0])),
		).toEqual(new Int16Array([0]))
	})
})
