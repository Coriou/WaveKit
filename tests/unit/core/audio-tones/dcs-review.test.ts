import { describe, expect, it } from "vitest"
import { DcsDecoder } from "../../../../src/core/audio-tones/dcs.js"
import { ToneDetector } from "../../../../src/core/audio-tones/tone-detector.js"
import { dcsAudio, dcsBitStream, nrz } from "./dcs-synth.js"

function f32(samples: ArrayLike<number>): Buffer {
	const out = Buffer.alloc(samples.length * 4)
	for (let i = 0; i < samples.length; i++)
		out.writeFloatLE(samples[i] ?? 0, i * 4)
	return out
}

/** Upsample by holding each 8 kHz sample `factor` times. */
function hold(samples: Float64Array, factor: number): Float64Array {
	const out = new Float64Array(samples.length * factor)
	for (let i = 0; i < out.length; i++)
		out[i] = samples[Math.floor(i / factor)] ?? 0
	return out
}

function rotatingWords(words: number): Uint8Array {
	const out = new Uint8Array(words * 23)
	for (let w = 0; w < words; w++) {
		out.set(dcsBitStream({ code: 0o23, bits: 23, startBit: 2 * w }), w * 23)
	}
	return out
}

describe("DCS review regressions", () => {
	it("does not confirm words whose rotation drifts between check points", () => {
		const decoder = new DcsDecoder()
		for (const x of nrz(rotatingWords(6))) decoder.pushSample(x)
		for (let i = 0; i < 4_000; i++) decoder.pushSample(0)
		expect(decoder.result()).toBeNull()
	})

	it("rotation-drift words through the tone detector give null", () => {
		const detector = new ToneDetector()
		const fmt = { rate: 8_000, format: "f32le" as const }
		detector.push(f32(nrz(rotatingWords(8))), fmt)
		detector.push(f32(new Float64Array(8_000)), fmt)
		expect(detector.result().dcs).toBeNull()
	})

	it("still confirms a steady stream (control)", () => {
		const detector = new ToneDetector()
		const fmt = { rate: 8_000, format: "f32le" as const }
		detector.push(f32(nrz(dcsBitStream({ code: 0o23, bits: 120 }))), fmt)
		expect(detector.result().dcs).toEqual({ code: "023", polarity: "normal" })
	})

	it("an unsupported-format block breaks DCS evidence", () => {
		const detector = new ToneDetector()
		const fmt = { rate: 8_000, format: "f32le" as const }
		const audio = nrz(dcsBitStream({ code: 0o23, bits: 100 }))
		detector.push(f32(audio.subarray(0, 3_000)), fmt)
		detector.push(Buffer.alloc(64), {
			rate: 8_000,
			format: "u8" as unknown as "f32le",
		})
		detector.push(f32(audio.subarray(3_000)), fmt)
		detector.push(f32(new Float64Array(4_000)), fmt)
		expect(detector.result().dcs).toBeNull()
	})

	it("counts DCS audio time at each block's own rate", () => {
		const detector = new ToneDetector()
		detector.push(f32(new Float64Array(2_400)), {
			rate: 8_000,
			format: "f32le",
		})
		const audio = hold(nrz(dcsBitStream({ code: 0o23, bits: 81 })), 6)
		detector.push(f32(audio), { rate: 48_000, format: "f32le" })
		expect(detector.durationSeconds()).toBeLessThan(0.75)
		expect(detector.result().dcs).toEqual({ code: "023", polarity: "normal" })
	})

	it("withholds DCS below 0.75 s even with a confirmed word", () => {
		const detector = new ToneDetector()
		const fmt = { rate: 8_000, format: "f32le" as const }
		detector.push(f32(nrz(dcsBitStream({ code: 0o23, bits: 80 }))), fmt)
		expect(detector.result().dcs).toBeNull()
	})

	it("a held split sample before unreadable audio cannot misframe DCS", () => {
		const s16 = (x: Float64Array): Buffer => {
			const out = Buffer.alloc(x.length * 2)
			for (let i = 0; i < x.length; i++)
				out.writeInt16LE(Math.round((x[i] ?? 0) * 32_767), i * 2)
			return out
		}
		const fmt = { rate: 8_000, format: "s16le" as const }
		const audio = s16(nrz(dcsBitStream({ code: 0o23, bits: 160 })))
		const detector = new ToneDetector()
		detector.push(Buffer.from([0]), fmt)
		detector.push(Buffer.alloc(64), {
			rate: 8_000,
			format: "u8" as unknown as "s16le",
		})
		detector.push(audio, fmt)
		expect(detector.result().dcs).toBeNull()
		// Re-arming the format (here a rate change and back) clears the hold.
		detector.push(audio, { rate: 16_000, format: "s16le" })
		detector.push(audio, fmt)
		expect(detector.result().dcs).toEqual({ code: "023", polarity: "normal" })
		const fresh = new ToneDetector()
		fresh.push(audio, fmt)
		expect(fresh.result().dcs).toEqual({ code: "023", polarity: "normal" })
	})

	it.each([8_000, 16_000, 44_100, 48_000])(
		"counts exactly 0.75 s of audio at %i Hz as enough",
		rate => {
			const detector = new ToneDetector()
			const n = Math.round(rate * 0.75)
			detector.push(f32(new Float64Array(n)), { rate, format: "f32le" })
			expect(
				(detector as unknown as { dcsSeconds(): number }).dcsSeconds(),
			).toBe(0.75)
			const short = new ToneDetector()
			short.push(f32(new Float64Array(n - 1)), { rate, format: "f32le" })
			expect(
				(short as unknown as { dcsSeconds(): number }).dcsSeconds(),
			).toBeLessThan(0.75)
		},
	)

	it("reports at the 16 kHz 0.75 s boundary", () => {
		const audio = dcsAudio({
			code: 0o23,
			seconds: 0.75,
			seed: 42,
			rate: 16_000,
		})
		const detector = new ToneDetector()
		detector.push(f32(audio), { rate: 16_000, format: "f32le" })
		expect(detector.result().dcs).toEqual({ code: "023", polarity: "normal" })
	})
})
