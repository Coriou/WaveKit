import { describe, expect, it } from "vitest"
import {
	parsePcmFormat,
	parsePositiveInt,
	PcmDecoder,
	PcmRing,
} from "../../src/features/listen/pcm.ts"

// Seeded xorshift (fast-check is not a web dependency)
function rng(seed: number): () => number {
	let x = seed
	return () => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) / 0x1_0000_0000
	}
}

const s16 = (values: number[]): Uint8Array => {
	const b = new Uint8Array(values.length * 2)
	const v = new DataView(b.buffer)
	values.forEach((x, i) => v.setInt16(i * 2, x, true))
	return b
}

describe("stream headers", () => {
	it("reads the format, rate and channels", () => {
		expect(parsePcmFormat("s16le")).toBe("s16le")
		expect(parsePcmFormat(" F32LE ")).toBe("f32le")
		expect(parsePcmFormat("u8")).toBeNull()
		expect(parsePcmFormat(null)).toBeNull()
		expect(parsePositiveInt("16000")).toBe(16_000)
		expect(parsePositiveInt("0")).toBeNull()
		expect(parsePositiveInt("1.5")).toBeNull()
		expect(parsePositiveInt("")).toBeNull()
		expect(parsePositiveInt(null)).toBeNull()
	})
})

describe("PcmDecoder", () => {
	it("decodes s16le to −1…1", () => {
		const d = new PcmDecoder("s16le")
		expect(Array.from(d.push(s16([0, 16384, -32768, 32767])))).toEqual([
			0,
			0.5,
			-1,
			32767 / 32768,
		])
	})

	it("decodes f32le and zeroes non-finite samples", () => {
		const b = new Uint8Array(12)
		const v = new DataView(b.buffer)
		v.setFloat32(0, 0.25, true)
		v.setFloat32(4, Number.NaN, true)
		v.setFloat32(8, -0.5, true)
		expect(Array.from(new PcmDecoder("f32le").push(b))).toEqual([0.25, 0, -0.5])
	})

	it("averages channels to mono", () => {
		const d = new PcmDecoder("s16le", 2)
		expect(Array.from(d.push(s16([16384, 0, -16384, -16384])))).toEqual([
			0.25, -0.5,
		])
	})

	it("gives the same samples however the bytes are chunked", () => {
		const rand = rng(0x1234567)
		for (let run = 0; run < 200; run++) {
			const values = Array.from({ length: Math.floor(rand() * 64) }, () =>
				Math.round(rand() * 65535 - 32768),
			)
			const bytes = s16(values)
			const points = Array.from({ length: Math.floor(rand() * 8) }, () =>
				Math.floor(rand() * (bytes.length + 1)),
			).sort((x, y) => x - y)
			const d = new PcmDecoder("s16le")
			const out: number[] = []
			let at = 0
			for (const p of [...points, bytes.length]) {
				out.push(...d.push(bytes.slice(at, p)))
				at = p
			}
			expect(out).toEqual(values.map(x => x / 32768))
		}
	})
})

describe("PcmRing", () => {
	const RATE = 1000 // 1 sample per ms keeps the arithmetic readable
	const ramp = (n: number, from = 0) =>
		Float32Array.from({ length: n }, (_, i) => (from + i) / 10_000)

	it("is silent until the target is buffered, then plays in order", () => {
		const ring = new PcmRing({ rate: RATE, targetMs: 200, maxMs: 500 })
		const out = new Float32Array(50)
		ring.push(ramp(150))
		expect(ring.render(out)).toBe(false)
		expect(out.every(x => x === 0)).toBe(true)
		ring.push(ramp(100, 150))
		expect(ring.render(out)).toBe(true)
		expect(ring.playing).toBe(true)
		expect(out[0]).toBeCloseTo(0)
		expect(out[49]).toBeCloseTo(49 / 10_000)
		expect(ring.bufferedMs).toBe(200)
	})

	it("outputs silence on underrun and primes again", () => {
		const ring = new PcmRing({ rate: RATE, targetMs: 20, maxMs: 100 })
		ring.push(ramp(30))
		const out = new Float32Array(64)
		expect(ring.render(out)).toBe(true)
		expect(ring.underruns).toBe(1)
		expect(ring.playing).toBe(false)
		expect(out.subarray(40).every(x => x === 0)).toBe(true)
		ring.push(ramp(10))
		expect(ring.render(new Float32Array(8))).toBe(false)
	})

	it("drops the oldest audio back to the target when the buffer grows past the max", () => {
		const ring = new PcmRing({ rate: RATE, targetMs: 200, maxMs: 500 })
		ring.push(ramp(400))
		expect(ring.bufferedMs).toBe(400)
		ring.push(ramp(200, 400))
		expect(ring.bufferedMs).toBe(200)
		expect(ring.droppedSamples).toBe(400)
		const out = new Float32Array(1)
		ring.render(out)
		// the newest 200 samples remain: 400…599
		expect(out[0]).toBeCloseTo(400 / 10_000)
	})

	it("keeps the newest audio from a push larger than the whole ring", () => {
		const ring = new PcmRing({ rate: RATE, targetMs: 200, maxMs: 500 })
		ring.push(ramp(5000))
		expect(ring.bufferedMs).toBe(200)
		const out = new Float32Array(1)
		ring.render(out)
		expect(out[0]).toBeCloseTo(4800 / 10_000)
	})

	it("resamples linearly by the rate ratio", () => {
		const ring = new PcmRing({ rate: RATE, targetMs: 10, maxMs: 500 })
		ring.push(Float32Array.from({ length: 100 }, (_, i) => i))
		const out = new Float32Array(6)
		ring.render(out, 0.5) // stream at half the output rate
		expect(Array.from(out)).toEqual([0, 0.5, 1, 1.5, 2, 2.5])
		const fast = new PcmRing({ rate: RATE, targetMs: 10, maxMs: 500 })
		fast.push(Float32Array.from({ length: 100 }, (_, i) => i))
		fast.render(out, 3)
		expect(Array.from(out)).toEqual([0, 3, 6, 9, 12, 15])
	})

	it("consumes the stream at the ratio, so buffered time stays steady", () => {
		const rand = rng(0x7654321)
		for (let run = 0; run < 200; run++) {
			const streamRate = Math.round(8000 + rand() * 40_000)
			const ctxRate = Math.round(22_050 + rand() * 73_950)
			const ring = new PcmRing({ rate: streamRate, targetMs: 200, maxMs: 500 })
			const out = new Float32Array(128)
			ring.push(new Float32Array(Math.round(streamRate * 0.4)))
			const before = ring.bufferedMs
			// render ~100 ms of output: the buffer must shrink by ~100 ms of stream time
			const quanta = Math.round((ctxRate * 0.1) / 128)
			for (let i = 0; i < quanta; i++) ring.render(out, streamRate / ctxRate)
			const renderedMs = (quanta * 128 * 1000) / ctxRate
			expect(ring.underruns).toBe(0)
			expect(Math.abs(before - ring.bufferedMs - renderedMs)).toBeLessThan(1)
		}
	})
})
