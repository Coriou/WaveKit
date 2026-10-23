import { describe, expect, it, vi } from "vitest"
import { createBurstAbsorber } from "../../../../src/core/link-burst/absorber.js"
import { ABSORBER_LAGGARD_MS } from "../../../../src/core/link-burst/contract.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { FakeFanout } from "./fake-fanout.js"

function setup(frameBytes = 2, capacity = 128) {
	const fanout = new FakeFanout()
	let now = 0
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes,
		monoNow: () => now,
		log: createLogger({ level: "fatal" }),
		recorder: null,
	})
	absorber.configure(capacity)
	return {
		fanout,
		absorber,
		time: (value: number) => {
			now = value
		},
	}
}

describe("BurstAbsorber pass-through fast path", () => {
	it("passes chunks through without reading the active set while nothing is congested", () => {
		const { fanout, absorber } = setup()
		const active = vi.spyOn(fanout, "activeBranchIds")
		const chunk = Buffer.alloc(4)
		for (let i = 0; i < 10; i++) absorber.ingest(chunk)
		expect(active).not.toHaveBeenCalled()
		expect(fanout.delivered).toHaveLength(10)
		expect(fanout.delivered.every(value => value === chunk)).toBe(true)
	})

	it("still holds on congestion that raised no backpressure event", () => {
		const { fanout, absorber } = setup()
		// Congested by stream state only (destroyed or past its mark): no event.
		fanout.congested.add("a")
		absorber.ingest(Buffer.alloc(4))
		expect(fanout.delivered).toHaveLength(0)
		expect(absorber.counters().heldBytes).toBe(4)
	})

	it("ignores a congested branch that is not active, as the full pass does", () => {
		const { fanout, absorber } = setup()
		fanout.active.delete("b")
		fanout.congested.add("b")
		absorber.ingest(Buffer.alloc(4))
		expect(fanout.delivered).toHaveLength(1)
	})

	it.each([
		[ABSORBER_LAGGARD_MS - 1, 0],
		[ABSORBER_LAGGARD_MS, 4],
	])(
		"after a laggard congested for %i ms, a sibling receives %i bytes on the next chunk",
		(ms, delivered) => {
			const { fanout, absorber, time } = setup()
			fanout.congest("a")
			absorber.ingest(Buffer.alloc(4))
			time(ms)
			absorber.ingest(Buffer.alloc(4))
			// Excluded: both held chunks released; otherwise both still held.
			expect(absorber.counters().heldBytes).toBe(delivered ? 0 : 8)
			expect(fanout.delivered.reduce((n, c) => n + c.length, 0)).toBe(
				delivered ? 8 : 0,
			)
		},
	)

	it("keeps per-slot window counters across fast-path chunks and slot changes", () => {
		const { fanout, absorber, time } = setup(2, 8)
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(4))
		fanout.drain("a")
		time(1_000)
		absorber.ingest(Buffer.alloc(4))
		time(30_000)
		absorber.ingest(Buffer.alloc(4))
		const window = absorber.counters().window
		expect(window.absorbedBytes).toBe(4)
		expect(window.peakHeldBytes).toBe(4)
	})
})
