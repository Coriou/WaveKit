import { expect, it } from "vitest"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	createBurstAbsorber,
	hasOverflowGates,
} from "../../../../src/core/link-burst/absorber.js"
import { FakeFanout } from "./fake-fanout.js"

function setup() {
	const fanout = new FakeFanout()
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes: 2,
		monoNow: () => 0,
		log: createLogger({ level: "fatal" }),
		recorder: null,
	})
	absorber.configure(128)
	return { fanout, absorber }
}

// Capacity 128 bytes, 2-byte frames: a 200-byte chunk held by a
// congested branch keeps 128 and loses 72.
it("charges overflow to the congested branch holding the absorber", () => {
	const { absorber, fanout } = setup()
	expect(hasOverflowGates(absorber)).toBe(true)
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(200))
	expect(absorber.counters().overflowBytesTotal).toBe(72)
	expect(absorber.overflowGatedBy()).toEqual({ a: 72 })
	// Both congested: each held it, each is charged with the loss.
	fanout.congest("b")
	absorber.ingest(Buffer.alloc(4))
	expect(absorber.overflowGatedBy()).toEqual({ a: 76, b: 4 })
})

it("charges no branch for loss without a hold and forgets a removed branch", () => {
	const { absorber, fanout } = setup()
	absorber.ingest(Buffer.alloc(200))
	expect(absorber.counters().overflowBytesTotal).toBe(0)
	expect(absorber.overflowGatedBy()).toEqual({})
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(200))
	expect(absorber.overflowGatedBy()).toEqual({ a: 72 })
	fanout.active.delete("a")
	fanout.emit("branch-removed", "a")
	expect(absorber.overflowGatedBy()).toEqual({})
})

// The laggard deadline (500 ms) expires at the very ingest that overflows,
// before its timer ran: that ingest excludes the branch, yet its hold filled
// the queue, so the loss is still its own.
it("charges overflow to a laggard whose deadline expires at that instant", () => {
	const fanout = new FakeFanout()
	let now = 0
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes: 2,
		monoNow: () => now,
		log: createLogger({ level: "fatal" }),
		recorder: null,
	})
	absorber.configure(128)
	try {
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(128))
		expect(absorber.counters().heldBytes).toBe(128)
		now = 500
		absorber.ingest(Buffer.alloc(4))
		expect(absorber.counters().overflowBytesTotal).toBe(4)
		expect(absorber.overflowGatedBy()).toEqual({ a: 4 })
	} finally {
		absorber.dispose()
	}
})
