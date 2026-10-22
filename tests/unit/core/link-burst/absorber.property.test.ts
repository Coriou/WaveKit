import { describe, it, expect } from "vitest"
import fc from "fast-check"
import { createBurstAbsorber } from "../../../../src/core/link-burst/absorber.js"
import { ABSORBER_LAGGARD_MS } from "../../../../src/core/link-burst/contract.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { FakeFanout } from "./fake-fanout.js"

function setup(frameBytes: number, capacity: number) {
	const fanout = new FakeFanout()
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes,
		monoNow: () => fanout.tick,
		log: createLogger({ level: "fatal" }),
		recorder: null,
	})
	absorber.configure(capacity)
	return { fanout, absorber }
}
function payload(size: number, offset = 0): Buffer {
	const result = Buffer.allocUnsafe(size)
	for (let i = 0; i < size; i++)
		result[i] = ((i + offset) * 73 + Math.floor((i + offset) / 251)) % 256
	return result
}
const frame = fc.constantFrom(2, 4)
const lengths = fc.array(fc.integer({ min: 1, max: 70_000 }), {
	minLength: 1,
	maxLength: 12,
})

describe("BurstAbsorber properties", () => {
	// Feature: link-burst-resilience, Property 2: Pass-through identity (absorber half)
	// Validates: Requirements 1.3
	it("preserves pass-through identity and tick", () => {
		fc.assert(
			fc.property(frame, lengths, fc.boolean(), (bytes, sizes, disabled) => {
				const { absorber, fanout } = setup(bytes, disabled ? 0 : 1024)
				if (disabled) fanout.congest("a")
				for (const size of sizes) {
					fanout.tick++
					const chunk = Buffer.alloc(size)
					absorber.ingest(chunk)
					expect(fanout.delivered.at(-1)).toBe(chunk)
					expect(fanout.ticks.at(-1)).toBe(fanout.tick)
				}
			}),
			{ numRuns: 100 },
		)
	})
	// Feature: link-burst-resilience, Property 3: Byte conservation and order
	// Validates: Requirements 1.4, 1.6, 1.8
	it("conserves bytes through congestion, overflow, flush and wrapping", () => {
		const action = fc.record({
			kind: fc.constantFrom("congest", "drain", "ingest", "flush"),
			id: fc.constantFrom("a", "b"),
			size: fc.integer({ min: 1, max: 70_000 }),
		})
		fc.assert(
			fc.property(
				frame,
				fc.integer({ min: 1, max: 20000 }),
				fc.array(action, { minLength: 1, maxLength: 30 }),
				(bytes, frames, actions) => {
					const capacity = frames * bytes
					const { absorber, fanout } = setup(bytes, capacity)
					let held = Buffer.alloc(0)
					const expected: Buffer[] = []
					let lost = 0
					let lostChunks = 0
					let flushed = 0
					let input = 0
					let delivered = 0
					function checkRelease() {
						if (fanout.congested.size === 0) {
							const size = Math.floor(held.length / bytes) * bytes
							expected.push(Buffer.from(held.subarray(0, size)))
							held = held.subarray(size)
						}
						for (; delivered < fanout.delivered.length; delivered++) {
							const chunk = fanout.delivered[delivered]!
							expect(chunk.length % bytes).toBe(0)
							expect(chunk.length).toBeLessThanOrEqual(65_536)
						}
						expect(
							Buffer.concat(fanout.delivered).equals(Buffer.concat(expected)),
						).toBe(true)
					}
					for (const action of actions) {
						if (action.kind === "congest") fanout.congest(action.id)
						else if (action.kind === "drain") {
							fanout.drain(action.id)
							checkRelease()
						} else if (action.kind === "flush") {
							flushed += held.length
							held = Buffer.alloc(0)
							absorber.flush("disconnect")
						} else {
							const chunk = payload(action.size, input)
							input += chunk.length
							if (held.length === 0 && fanout.congested.size === 0) {
								absorber.ingest(chunk)
								expect(fanout.delivered.at(-1)).toBe(chunk)
								expected.push(chunk)
								delivered++
							} else {
								const free = capacity - held.length
								const accepted =
									chunk.length <= free
										? chunk.length
										: Math.floor(free / bytes) * bytes
								held = Buffer.concat([held, chunk.subarray(0, accepted)])
								lost += chunk.length - accepted
								if (accepted < chunk.length) lostChunks++
								absorber.ingest(chunk)
								checkRelease()
							}
						}
						expect(input).toBe(
							Buffer.concat(expected).length + held.length + lost + flushed,
						)
						expect(absorber.counters()).toMatchObject({
							heldBytes: held.length,
							overflowBytesTotal: lost,
							overflowChunksTotal: lostChunks,
							flushedBytesTotal: flushed,
						})
					}
					fanout.drain("a")
					checkRelease()
					fanout.drain("b")
					checkRelease()
					expect(held.length).toBeLessThan(bytes)
					expect(absorber.counters().heldBytes).toBe(held.length)
					expect(input).toBe(
						Buffer.concat(expected).length + held.length + lost + flushed,
					)
					if (held.length > 0) {
						const remainder = Buffer.from(held)
						const padding = payload(bytes - held.length, input)
						held = Buffer.concat([held, padding])
						absorber.ingest(padding)
						checkRelease()
						expect(fanout.delivered.at(-1)).toEqual(
							Buffer.concat([remainder, padding]),
						)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
	// Feature: link-burst-resilience, Property 4: Chunk-split invariance
	// Validates: Requirements 1.4
	it("preserves a held byte stream across arbitrary fitting splits", () => {
		fc.assert(
			fc.property(frame, lengths, (bytes, sizes) => {
				const total =
					Math.ceil(sizes.reduce((a, b) => a + b, 0) / bytes) * bytes
				const stream = payload(total)
				const first = setup(bytes, total)
				const second = setup(bytes, total)
				first.fanout.congest("a")
				second.fanout.congest("a")
				first.absorber.ingest(stream)
				let offset = 0
				for (const size of sizes) {
					second.absorber.ingest(stream.subarray(offset, offset + size))
					offset += size
				}
				if (offset < total) second.absorber.ingest(stream.subarray(offset))
				first.fanout.drain("a")
				second.fanout.drain("a")
				expect(
					Buffer.concat(first.fanout.delivered).equals(
						Buffer.concat(second.fanout.delivered),
					),
				).toBe(true)
				expect(Buffer.concat(first.fanout.delivered).equals(stream)).toBe(true)
				expect(first.absorber.counters()).toEqual(second.absorber.counters())
			}),
			{ numRuns: 200 },
		)
	})
	// Feature: link-burst-resilience, Property 4: Chunk-split invariance
	// Validates: Requirements 1.4
	it("preserves the accepted prefix across frame-aligned overflowing splits", () => {
		fc.assert(
			fc.property(frame, lengths, fc.nat(), (bytes, sizes, seed) => {
				const aligned = sizes.map(size => Math.ceil(size / bytes) * bytes)
				const total = aligned.reduce((a, b) => a + b, 0) + bytes
				const capacity = (1 + (seed % (total / bytes - 1))) * bytes
				const stream = payload(total, seed % 65536)
				const first = setup(bytes, capacity)
				const second = setup(bytes, capacity)
				for (const target of [first, second]) target.fanout.congest("a")
				first.absorber.ingest(stream)
				let offset = 0
				for (const size of aligned) {
					second.absorber.ingest(stream.subarray(offset, offset + size))
					offset += size
				}
				second.absorber.ingest(stream.subarray(offset))
				for (const target of [first, second]) {
					expect(target.absorber.counters().heldBytes).toBe(capacity)
					target.fanout.drain("a")
					expect(
						Buffer.concat(target.fanout.delivered).equals(
							stream.subarray(0, capacity),
						),
					).toBe(true)
					expect(target.absorber.counters()).toMatchObject({
						heldBytes: 0,
						absorbedBytesTotal: capacity,
						overflowBytesTotal: total - capacity,
					})
				}
				expect(
					Buffer.concat(first.fanout.delivered).equals(
						Buffer.concat(second.fanout.delivered),
					),
				).toBe(true)
				expect(first.absorber.counters().overflowBytesTotal).toBe(
					second.absorber.counters().overflowBytesTotal,
				)
			}),
			{ numRuns: 200 },
		)
	})
	// Feature: link-burst-resilience, Property 5: Within capacity, no loss
	// Validates: Requirements 1.4, 9.1
	it("loses no bytes when consumers drain between fitting bursts", () => {
		fc.assert(
			fc.property(frame, lengths, (bytes, sizes) => {
				const { absorber, fanout } = setup(bytes, 70_004)
				const expected: Buffer[] = []
				for (const size of sizes) {
					fanout.congest("a")
					const chunk = payload(
						Math.ceil(size / bytes) * bytes,
						expected.length,
					)
					expected.push(chunk)
					absorber.ingest(chunk)
					expect(absorber.counters().heldBytes).toBeLessThanOrEqual(70_004)
					fanout.drain("a")
					expect(absorber.counters().heldBytes).toBe(0)
					expect(
						Buffer.concat(fanout.delivered).equals(Buffer.concat(expected)),
					).toBe(true)
				}
				expect(absorber.counters().overflowBytesTotal).toBe(0)
				expect(fanout.drops.size).toBe(0)
			}),
			{ numRuns: 100 },
		)
	})
	// Feature: link-burst-resilience, Property 6: Laggard bound
	// Validates: Requirements 1.5, 9.2
	it("bounds laggard delay and never excludes a single active branch", () => {
		fc.assert(
			fc.property(
				frame,
				fc.integer({ min: 1, max: 100 }),
				(bytes, interval) => {
					for (const single of [false, true]) {
						const { absorber, fanout } = setup(bytes, 10000)
						if (single) fanout.active.delete("b")
						fanout.congest("a")
						for (
							let now = 0;
							now <= ABSORBER_LAGGARD_MS + interval;
							now += interval
						) {
							fanout.tick = now
							absorber.ingest(Buffer.alloc(bytes))
						}
						if (single) {
							expect(fanout.delivered).toHaveLength(0)
							expect(absorber.counters().window.maxLaggardExcludeMs).toBeNull()
						} else {
							expect(fanout.ticks[0]).toBeGreaterThanOrEqual(
								ABSORBER_LAGGARD_MS,
							)
							expect(fanout.ticks[0]).toBeLessThanOrEqual(
								ABSORBER_LAGGARD_MS + interval,
							)
							const chunk = Buffer.alloc(bytes)
							absorber.ingest(chunk)
							expect(fanout.delivered.at(-1)).toBe(chunk)
							expect(fanout.drops.get("b") ?? 0).toBe(0)
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
