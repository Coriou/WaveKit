// tests/unit/core/spectrum/iq-ring.test.ts
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { IqRing } from "../../../../src/core/spectrum/iq-ring.js"

/** Two bytes per sample encoding the sample index, so reads can be checked exactly. */
function samples(from: number, count: number): Uint8Array {
	const out = new Uint8Array(2 * count)
	for (let i = 0; i < count; i++) {
		out[2 * i] = (from + i) & 255
		out[2 * i + 1] = ((from + i) >> 8) & 255
	}
	return out
}

function decode(bytes: Uint8Array): number[] {
	const out: number[] = []
	for (let i = 0; i < bytes.length; i += 2)
		out.push(bytes[i]! | (bytes[i + 1]! << 8))
	return out
}

function range(from: number, to: number): number[] {
	return Array.from({ length: to - from }, (_, i) => (from + i) & 0xffff)
}

describe("IqRing", () => {
	it("returns exactly the requested samples", () => {
		const ring = new IqRing({ bytesPerSample: 2, capacitySamples: 1000 })
		ring.write(100, samples(100, 300))
		const r = ring.read(150, 250)!
		expect(r.startSample).toBe(150)
		expect(decode(r.bytes)).toEqual(range(150, 250))
		expect([ring.oldestSample, ring.newestSample]).toEqual([100, 400])
	})

	it("keeps the newest capacity samples across wrap-around", () => {
		const ring = new IqRing({ bytesPerSample: 2, capacitySamples: 1000 })
		for (let s = 0; s < 2500; s += 300)
			ring.write(s, samples(s, Math.min(300, 2500 - s)))
		expect([ring.oldestSample, ring.newestSample]).toEqual([1500, 2500])
		const r = ring.read(1400, 2600)!
		expect(r.startSample).toBe(1500)
		expect(decode(r.bytes)).toEqual(range(1500, 2500))
		expect(ring.read(0, 1500)).toBeNull()
	})

	it("keeps only the tail of a write larger than the ring", () => {
		const ring = new IqRing({ bytesPerSample: 2, capacitySamples: 100 })
		ring.write(0, samples(0, 350))
		expect(decode(ring.read(0, 350)!.bytes)).toEqual(range(250, 350))
	})

	it("returns only the contiguous part after a gap, explicit or implied by a jump", () => {
		const ring = new IqRing({ bytesPerSample: 2, capacitySamples: 10_000 })
		ring.write(0, samples(0, 500))
		ring.markGap(500, 100)
		ring.write(600, samples(600, 300))
		ring.write(1000, samples(1000, 100)) // implied gap [900, 1000)
		expect(ring.read(400, 800)).toEqual({
			startSample: 600,
			bytes: samples(600, 200),
		})
		expect(ring.read(0, 450)).toEqual({
			startSample: 0,
			bytes: samples(0, 450),
		})
		expect(ring.read(700, 1050)).toEqual({
			startSample: 1000,
			bytes: samples(1000, 50),
		})
		expect(ring.read(520, 580)).toBeNull()
		expect(ring.read(1050, 5000)).toEqual({
			startSample: 1050,
			bytes: samples(1050, 50),
		})
	})

	it("forgets gaps that have left the ring", () => {
		const ring = new IqRing({ bytesPerSample: 2, capacitySamples: 1000 })
		ring.write(0, samples(0, 100))
		ring.markGap(100, 50)
		ring.write(150, samples(150, 2000))
		expect(ring.read(0, 3000)!.startSample).toBe(1150)
	})

	it("returns copies", () => {
		const ring = new IqRing({ bytesPerSample: 2, capacitySamples: 100 })
		ring.write(0, samples(0, 10))
		ring.read(0, 10)!.bytes.fill(0)
		expect(decode(ring.read(0, 10)!.bytes)).toEqual(range(0, 10))
	})

	it("rejects partial samples, overlapping writes and bad sizes", () => {
		const ring = new IqRing({ bytesPerSample: 2, capacitySamples: 100 })
		expect(() => ring.write(0, new Uint8Array(3))).toThrow()
		ring.write(0, samples(0, 10))
		expect(() => ring.write(5, samples(5, 10))).toThrow()
		expect(() => ring.markGap(9, 1)).toThrow()
		expect(
			() => new IqRing({ bytesPerSample: 2, capacitySamples: 0 }),
		).toThrow()
	})

	// Feature: signal-discovery-scanner, Property 11: Bounded state (IQ ring)
	// Validates: spec § 4.8, § 9
	it("holds at most capacity samples and agrees with a reference model for any writes, gaps and reads", () => {
		const op = fc.oneof(
			fc.record({
				kind: fc.constant("write" as const),
				skip: fc.integer({ min: 0, max: 30 }),
				count: fc.integer({ min: 1, max: 400 }),
			}),
			fc.record({
				kind: fc.constant("gap" as const),
				count: fc.integer({ min: 0, max: 200 }),
			}),
			fc.record({
				kind: fc.constant("read" as const),
				from: fc.integer({ min: -100, max: 3000 }),
				len: fc.integer({ min: 0, max: 1500 }),
			}),
		)
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 700 }),
				fc.array(op, { maxLength: 40 }),
				(capacity, ops) => {
					const ring = new IqRing({
						bytesPerSample: 2,
						capacitySamples: capacity,
					})
					const valid = new Set<number>()
					let end = 0
					for (const o of ops) {
						if (o.kind === "write") {
							const start = end + o.skip
							ring.write(start, samples(start, o.count))
							for (let s = start; s < start + o.count; s++) valid.add(s)
							end = start + o.count
						} else if (o.kind === "gap") {
							ring.markGap(end, o.count)
							end += o.count
						} else {
							const from = Math.max(0, o.from)
							const to = from + o.len
							const oldest = Math.max(0, end - capacity)
							const hi = Math.min(to, end)
							let lo = Math.max(from, oldest)
							for (let s = hi - 1; s >= lo; s--) {
								if (!valid.has(s)) {
									lo = s + 1
									break
								}
							}
							const r = ring.read(from, to)
							if (lo >= hi) expect(r).toBeNull()
							else
								expect(r).toEqual({
									startSample: lo,
									bytes: samples(lo, hi - lo),
								})
						}
						expect(ring.newestSample - ring.oldestSample).toBeLessThanOrEqual(
							capacity,
						)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
