import { describe, expect, it } from "vitest"
import { FrameSource } from "../../../../src/core/spectrum/frame-source.js"
import {
	gaussianNoise,
	mulberry32,
	packF32,
} from "../../../mocks/scanner/signals.js"

const N = 64

function collect(
	overlap: 0 | 0.5,
	bytes: Uint8Array,
	chunk: number,
): { start: number; re: number[] }[] {
	const src = new FrameSource({ format: "FLOAT32LE", fftSize: N, overlap })
	const out: { start: number; re: number[] }[] = []
	for (let off = 0; off < bytes.length; off += chunk) {
		src.push(off / 8, bytes.subarray(off, Math.min(bytes.length, off + chunk)))
		src.drain(
			f => out.push({ start: f.startSample, re: Array.from(f.re) }),
			() => undefined,
		)
	}
	return out
}

describe("FrameSource overlap", () => {
	const iq = gaussianNoise(mulberry32(3), 1000, 0.1)
	const bytes = packF32(iq.re, iq.im)

	it("emits a frame every N/2 samples with 50 % overlap, identical to the unoverlapped frames at even indices", () => {
		const plain = collect(0, bytes, 8 * 100)
		const half = collect(0.5, bytes, 8 * 100)
		expect(plain.map(f => f.start)).toEqual(
			Array.from({ length: Math.floor(1000 / N) }, (_, i) => i * N),
		)
		expect(half.map(f => f.start)).toEqual(
			Array.from(
				{ length: Math.floor((1000 - N) / (N / 2)) + 1 },
				(_, i) => (i * N) / 2,
			),
		)
		plain.forEach((f, i) => expect(half[2 * i]?.re).toEqual(f.re))
	})

	it("does not depend on how the bytes are chunked", () => {
		expect(collect(0.5, bytes, 8 * 7).map(f => f.start)).toEqual(
			collect(0.5, bytes, 8 * 333).map(f => f.start),
		)
	})

	it("restarts the overlapped grid after a gap", () => {
		const src = new FrameSource({
			format: "FLOAT32LE",
			fftSize: N,
			overlap: 0.5,
		})
		const starts: number[] = []
		src.push(0, bytes.subarray(0, 8 * 100))
		src.gap(100, 50)
		src.push(150, bytes.subarray(8 * 150, 8 * 300))
		src.drain(
			f => starts.push(f.startSample),
			() => undefined,
		)
		expect(starts).toEqual([0, 32, 150, 182, 214])
	})
})
