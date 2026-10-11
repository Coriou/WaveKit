import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { hannWindow } from "../../../../src/core/spectrum/fft.js"
import {
	bytesPerSample,
	type CounterRun,
	type Frame,
	FrameSource,
	MIN_COUNTER_RUN_BYTES,
} from "../../../../src/core/spectrum/frame-source.js"
import type { IqFormat } from "../../../../src/core/spectrum/types.js"
import {
	counterRun,
	gaussianNoise,
	mulberry32,
	packCu8,
	packF32,
	packS16,
} from "../../../mocks/scanner/signals.js"

const N = 64

interface Captured {
	frames: { startSample: number; re: number[]; im: number[]; clipped: number }[]
	runs: CounterRun[]
	order: string[]
}

function capture(): {
	sink: Captured
	onFrame: (f: Frame) => void
	onRun: (r: CounterRun) => void
} {
	const sink: Captured = { frames: [], runs: [], order: [] }
	return {
		sink,
		onFrame: f => {
			sink.frames.push({
				startSample: f.startSample,
				re: Array.from(f.re),
				im: Array.from(f.im),
				clipped: f.clipped,
			})
			sink.order.push(`f${f.startSample}`)
		},
		onRun: r => {
			sink.runs.push(r)
			sink.order.push(`r${r.startSample}-${r.endSample}`)
		},
	}
}

function randomBytes(seed: number, n: number): Uint8Array {
	const rng = mulberry32(seed)
	const out = new Uint8Array(n)
	for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256)
	return out
}

/** Expected windowed frame from U8 bytes of samples [s, s + N). */
function expectedU8(
	bytes: Uint8Array,
	s: number,
): { re: number[]; im: number[] } {
	const w = hannWindow(N)
	const re: number[] = []
	const im: number[] = []
	for (let i = 0; i < N; i++) {
		re.push(Math.fround((bytes[2 * (s + i)]! / 127.5 - 1) * w[i]!))
		im.push(Math.fround((bytes[2 * (s + i) + 1]! / 127.5 - 1) * w[i]!))
	}
	return { re, im }
}

describe("bytesPerSample", () => {
	it("is 2, 4 and 8 bytes per IQ pair", () => {
		expect(bytesPerSample("U8_IQ")).toBe(2)
		expect(bytesPerSample("S16_IQ")).toBe(4)
		expect(bytesPerSample("FLOAT32LE")).toBe(8)
	})
})

describe("FrameSource conversions", () => {
	it("maps U8 as u/127.5 − 1 and applies the periodic Hann window", () => {
		const bytes = randomBytes(1, 2 * N)
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		const c = capture()
		fsrc.push(0, bytes)
		fsrc.gap(N, 0) // a seam releases the frame held back for a possible counter run
		fsrc.drain(c.onFrame, c.onRun)
		expect(c.sink.frames).toHaveLength(1)
		const e = expectedU8(bytes, 0)
		expect(c.sink.frames[0]!.re).toEqual(e.re)
		expect(c.sink.frames[0]!.im).toEqual(e.im)
	})

	it("reads S16 and FLOAT32LE IQ to the same windowed samples", () => {
		const iq = gaussianNoise(mulberry32(2), N, 0.1)
		const w = hannWindow(N)
		for (const [format, bytes, tol] of [
			["S16_IQ", packS16(iq.re, iq.im), 1 / 32768],
			["FLOAT32LE", packF32(iq.re, iq.im), 1e-7],
		] as const) {
			const fsrc = new FrameSource({ format, fftSize: N })
			const c = capture()
			fsrc.push(10, bytes)
			fsrc.drain(c.onFrame, c.onRun)
			expect(c.sink.frames.map(f => f.startSample)).toEqual([10])
			for (let i = 0; i < N; i++) {
				expect(
					Math.abs(
						c.sink.frames[0]!.re[i]! -
							Math.max(-1, Math.min(1, iq.re[i]!)) * w[i]!,
					),
				).toBeLessThanOrEqual(tol)
				expect(
					Math.abs(
						c.sink.frames[0]!.im[i]! -
							Math.max(-1, Math.min(1, iq.im[i]!)) * w[i]!,
					),
				).toBeLessThanOrEqual(tol)
			}
		}
	})

	it("counts samples with a clipped component per format", () => {
		const re = new Float32Array(N)
		const im = new Float32Array(N)
		re[3] = 1.2 // clipped in every format
		im[3] = -1.2 // same sample: counted once
		im[9] = -1 // U8 0, S16 −32768, float −1
		re[20] = 0.99999 // S16 32767: clipped for S16 only; U8 255: clipped; float: not
		const cases: [IqFormat, Uint8Array, number][] = [
			["U8_IQ", packCu8(re, im), 3],
			["S16_IQ", packS16(re, im), 3],
			["FLOAT32LE", packF32(re, im), 2],
		]
		for (const [format, bytes, expected] of cases) {
			const fsrc = new FrameSource({ format, fftSize: N })
			const c = capture()
			fsrc.push(0, bytes)
			fsrc.gap(N, 0)
			fsrc.drain(c.onFrame, c.onRun)
			expect([format, c.sink.frames[0]!.clipped]).toEqual([format, expected])
		}
	})

	it("copies pushed bytes, so the caller may reuse its buffer before drain", () => {
		const bytes = randomBytes(3, 2 * N)
		const original = bytes.slice()
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		const c = capture()
		fsrc.push(0, bytes)
		bytes.fill(7)
		fsrc.gap(N, 0)
		fsrc.drain(c.onFrame, c.onRun)
		expect(c.sink.frames[0]!.re).toEqual(expectedU8(original, 0).re)
	})

	it("rejects invalid sizes and indices", () => {
		expect(() => new FrameSource({ format: "U8_IQ", fftSize: 1000 })).toThrow()
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		expect(() => fsrc.push(-1, new Uint8Array(2))).toThrow()
		expect(() => fsrc.gap(0, 1.5)).toThrow()
	})
})

describe("FrameSource alignment", () => {
	it("assembles frames across arbitrary chunk splits, including mid-sample splits", () => {
		fc.assert(
			fc.property(
				fc.constantFrom<IqFormat>("U8_IQ", "S16_IQ", "FLOAT32LE"),
				fc.array(fc.integer({ min: 1, max: 700 }), {
					minLength: 1,
					maxLength: 20,
				}),
				fc.integer({ min: 0, max: 1_000_000 }),
				(format, cuts, first) => {
					const bps = bytesPerSample(format)
					const iq = gaussianNoise(mulberry32(first), 5 * N + 7, 0.2)
					const all =
						format === "U8_IQ"
							? packCu8(iq.re, iq.im)
							: format === "S16_IQ"
								? packS16(iq.re, iq.im)
								: packF32(iq.re, iq.im)
					const whole = new FrameSource({ format, fftSize: N })
					const ref = capture()
					whole.push(first, all)
					whole.drain(ref.onFrame, ref.onRun)
					const split = new FrameSource({ format, fftSize: N })
					const got = capture()
					let at = 0
					for (const cut of cuts) {
						if (at >= all.length) break
						const end = Math.min(all.length, at + cut)
						split.push(first + Math.floor(at / bps), all.subarray(at, end))
						split.drain(got.onFrame, got.onRun)
						at = end
					}
					if (at < all.length) {
						split.push(first + Math.floor(at / bps), all.subarray(at))
						split.drain(got.onFrame, got.onRun)
					}
					expect(got.sink.frames).toEqual(ref.sink.frames)
					expect(ref.sink.frames.map(f => f.startSample)).toEqual(
						[0, 1, 2, 3, 4].map(k => first + k * N),
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("restarts assembly after a gap and drops the partial frame before it", () => {
		const bytes = randomBytes(4, 2 * 4 * N)
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		const c = capture()
		fsrc.push(0, bytes.subarray(0, 2 * (N + N / 2))) // 1.5 frames
		fsrc.gap(N + N / 2, 10)
		fsrc.push(N + N / 2 + 10, bytes.subarray(0, 2 * 2 * N))
		fsrc.gap(3 * N + N / 2 + 10, 0)
		fsrc.drain(c.onFrame, c.onRun)
		expect(c.sink.frames.map(f => f.startSample)).toEqual([
			0,
			N + N / 2 + 10,
			2 * N + N / 2 + 10,
		])
		expect(c.sink.frames[1]!.re).toEqual(expectedU8(bytes, 0).re)
	})

	it("treats a push that skips samples as a seam", () => {
		const bytes = randomBytes(5, 2 * 3 * N)
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		const c = capture()
		fsrc.push(0, bytes.subarray(0, 2 * (N + 5)))
		fsrc.drain(c.onFrame, c.onRun)
		fsrc.push(N + 9, bytes.subarray(0, 2 * N))
		fsrc.gap(2 * N + 9, 0)
		fsrc.drain(c.onFrame, c.onRun)
		expect(c.sink.frames.map(f => f.startSample)).toEqual([0, N + 9])
	})
})

describe("FrameSource counter runs", () => {
	/** Noise bytes, then a counter run of `runBytes` at byte `at`, guaranteed not to touch its neighbours. */
	function withRun(
		seed: number,
		totalBytes: number,
		at: number,
		runBytes: number,
	): Uint8Array {
		const bytes = randomBytes(seed, totalBytes)
		const start = (bytes[at - 1]! + 128) & 255
		bytes.set(counterRun(runBytes, start), at)
		const last = (start + runBytes - 1) & 255
		if (
			at + runBytes < totalBytes &&
			bytes[at + runBytes] === ((last + 1) & 255)
		)
			bytes[at + runBytes] = (last + 7) & 255
		return bytes
	}

	it("reports an aligned run once and keeps its samples out of every frame", () => {
		const runAt = 2 * (3 * N + 10)
		const bytes = withRun(6, 2 * 10 * N, runAt, 600)
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		const c = capture()
		fsrc.push(0, bytes)
		fsrc.drain(c.onFrame, c.onRun)
		const run = { startSample: 3 * N + 10, endSample: 3 * N + 10 + 300 }
		expect(c.sink.runs).toEqual([run])
		for (const f of c.sink.frames)
			expect(
				f.startSample + N <= run.startSample || f.startSample >= run.endSample,
			).toBe(true)
		expect(c.sink.frames.map(f => f.startSample)).toEqual([
			0,
			N,
			2 * N,
			run.endSample,
			run.endSample + N,
		])
		expect(
			c.sink.order.indexOf(`r${run.startSample}-${run.endSample}`),
		).toBeLessThan(c.sink.order.indexOf(`f${run.endSample}`))
	})

	it("widens an odd-byte run to whole samples", () => {
		const bytes = withRun(7, 2 * 8 * N, 2 * N + 1, 301)
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		const c = capture()
		fsrc.push(0, bytes)
		fsrc.drain(c.onFrame, c.onRun)
		// bytes [2N+1, 2N+302) → samples [N, N + 151)
		expect(c.sink.runs).toEqual([{ startSample: N, endSample: N + 151 }])
	})

	it("holds back only a frame that ends inside the trailing streak until the next push or seam", () => {
		const bytes = randomBytes(12, 2 * 2 * N)
		bytes[2 * 2 * N - 1] = (bytes[2 * 2 * N - 2]! + 1) & 255 // trailing two-byte streak
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		const c = capture()
		fsrc.push(0, bytes)
		fsrc.drain(c.onFrame, c.onRun)
		expect(c.sink.frames.map(f => f.startSample)).toEqual([0])
		const next = randomBytes(13, 2)
		next[0] = (bytes[2 * 2 * N - 1]! + 9) & 255
		fsrc.push(2 * N, next)
		fsrc.drain(c.onFrame, c.onRun)
		expect(c.sink.frames.map(f => f.startSample)).toEqual([0, N])
	})

	it("ignores an incrementing streak one byte short of the minimum", () => {
		const bytes = withRun(8, 2 * 8 * N, 2 * N, MIN_COUNTER_RUN_BYTES - 1)
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		const c = capture()
		fsrc.push(0, bytes)
		fsrc.drain(c.onFrame, c.onRun)
		expect(c.sink.runs).toEqual([])
		expect(c.sink.frames).toHaveLength(7) // the last frame waits for its trailing streak to break
	})

	it("never detects a run in random or low-level noise IQ", () => {
		for (const sigma of [0.004, 0.02, 0.3]) {
			const iq = gaussianNoise(mulberry32(9), 1 << 20, sigma)
			const fsrc = new FrameSource({ format: "U8_IQ", fftSize: 2048 })
			const c = capture()
			fsrc.push(0, packCu8(iq.re, iq.im))
			fsrc.drain(() => {}, c.onRun)
			expect(c.sink.runs).toEqual([])
		}
	}, 30_000)

	it("reports a long run while it lasts, without buffering it, and ends it on the first non-counter byte", () => {
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		const c = capture()
		const noise = randomBytes(10, 2 * N)
		fsrc.push(0, noise)
		const chunk = 4096
		let byte = (noise[noise.length - 1]! + 128) & 255
		for (let k = 0; k < 50; k++) {
			fsrc.push(N + (k * chunk) / 2, counterRun(chunk, byte))
			byte = (byte + chunk) & 255
			fsrc.drain(c.onFrame, c.onRun)
			expect(fsrc.activeCounterRun).toEqual({
				startSample: N,
				samples: ((k + 1) * chunk) / 2,
			})
		}
		expect(c.sink.runs).toEqual([])
		const tail = randomBytes(11, 2 * N)
		tail[0] = (byte + 100) & 255
		fsrc.push(N + (50 * chunk) / 2, tail)
		fsrc.drain(c.onFrame, c.onRun)
		expect(fsrc.activeCounterRun).toBeNull()
		expect(c.sink.runs).toEqual([
			{ startSample: N, endSample: N + (50 * chunk) / 2 },
		])
		expect(c.sink.frames.map(f => f.startSample)).toEqual([0])
	})

	it("ends a run at the last received sample when a gap cuts it", () => {
		const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
		const c = capture()
		fsrc.push(0, counterRun(1000, 3))
		fsrc.gap(500, 40)
		fsrc.drain(c.onFrame, c.onRun)
		expect(c.sink.runs).toEqual([{ startSample: 0, endSample: 500 }])
	})

	// Feature: signal-discovery-scanner, Property 6: Epoch and gap accounting (frame layer)
	// Validates: spec § 4.1, § 4.6
	it("never puts a gap or counter-run sample in a frame and keeps absolute indices", () => {
		const op = fc.oneof(
			fc.record({
				kind: fc.constant("noise" as const),
				samples: fc.integer({ min: 1, max: 300 }),
			}),
			fc.record({
				kind: fc.constant("gap" as const),
				samples: fc.integer({ min: 0, max: 200 }),
			}),
			fc.record({
				kind: fc.constant("run" as const),
				samples: fc.integer({ min: 128, max: 400 }),
			}),
		)
		fc.assert(
			fc.property(
				fc.array(op, { minLength: 1, maxLength: 25 }),
				fc.integer({ min: 0, max: 2 ** 31 - 1 }),
				(ops, seed) => {
					const rng = mulberry32(seed)
					const fsrc = new FrameSource({ format: "U8_IQ", fftSize: N })
					const c = capture()
					const truth = new Map<number, [number, number]>() // sample → (I, Q) bytes of good samples
					const bad: [number, number][] = [] // [start, end) of gap and run samples
					const runs: CounterRun[] = []
					let sample = 0
					let prev = -1
					for (const o of ops) {
						if (o.kind === "gap") {
							fsrc.gap(sample, o.samples)
							bad.push([sample, sample + o.samples])
							sample += o.samples
							prev = -1
							continue
						}
						const bytes = new Uint8Array(2 * o.samples)
						if (o.kind === "run") {
							const start = prev < 0 ? 0 : (prev + 128) & 255
							bytes.set(counterRun(bytes.length, start))
							bad.push([sample, sample + o.samples])
							runs.push({ startSample: sample, endSample: sample + o.samples })
						} else {
							const last = prev
							for (let i = 0; i < bytes.length; i++)
								bytes[i] = Math.floor(rng() * 256)
							// Never continue a preceding run, so run boundaries are exact.
							if (last >= 0 && bytes[0] === ((last + 1) & 255))
								bytes[0] = (last + 50) & 255
							for (let s = 0; s < o.samples; s++)
								truth.set(sample + s, [bytes[2 * s]!, bytes[2 * s + 1]!])
						}
						fsrc.push(sample, bytes)
						fsrc.drain(c.onFrame, c.onRun)
						prev = bytes[bytes.length - 1]!
						sample += o.samples
					}
					fsrc.gap(sample, 1) // flush: ends any run in progress
					fsrc.drain(c.onFrame, c.onRun)
					const w = hannWindow(N)
					let lastEnd = -1
					for (const f of c.sink.frames) {
						expect(f.startSample).toBeGreaterThanOrEqual(lastEnd)
						lastEnd = f.startSample + N
						for (const [a, b] of bad)
							expect(f.startSample + N <= a || f.startSample >= b).toBe(true)
						const re: number[] = []
						const im: number[] = []
						for (let i = 0; i < N; i++) {
							const t = truth.get(f.startSample + i)
							re.push(
								t === undefined
									? Number.NaN
									: Math.fround((t[0] / 127.5 - 1) * w[i]!),
							)
							im.push(
								t === undefined
									? Number.NaN
									: Math.fround((t[1] / 127.5 - 1) * w[i]!),
							)
						}
						expect(f.re).toEqual(re)
						expect(f.im).toEqual(im)
					}
					expect(c.sink.runs).toEqual(runs)
				},
			),
			{ numRuns: 100 },
		)
	}, 30_000)
})
