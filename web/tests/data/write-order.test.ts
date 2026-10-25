import { describe, expect, it } from "vitest"
import {
	WRITE_ORDER_COVERAGES_MAX,
	WRITE_ORDER_TOMBSTONES_MAX,
	WriteOrder,
} from "../../src/data/write-order.ts"

interface R {
	hz: number
}
const none = new Set<string>()

describe("WriteOrder", () => {
	it("an upsert applies only when its version is newer than the cached one", () => {
		const o = new WriteOrder<R>()
		expect(o.upsert("x", { hz: 1 }, 2)).toBe(true)
		expect(o.upsert("x", { hz: 1 }, 1)).toBe(false)
		expect(o.upsert("x", { hz: 1 }, 2)).toBe(false)
		expect(o.upsert("x", { hz: 1 }, 3)).toBe(true)
	})

	it("a deletion is final: no version brings the id back", () => {
		const o = new WriteOrder<R>()
		o.upsert("x", { hz: 1 }, 2)
		o.removeHard("x", 3)
		expect(o.upsert("x", { hz: 1 }, 2)).toBe(false)
		expect(o.upsert("x", { hz: 1 }, 99)).toBe(false)
		// also for an id never cached
		o.removeHard("y", 4)
		expect(o.upsert("y", { hz: 1 }, 1)).toBe(false)
	})

	it("a page removal keeps a newer cached record, and a later upsert at or above it returns", () => {
		const o = new WriteOrder<R>()
		o.upsert("x", { hz: 1 }, 5)
		expect(o.removeSoft("x", 4)).toBe(false)
		expect(o.removeSoft("x", 6)).toBe(true)
		expect(o.upsert("x", { hz: 50 }, 4)).toBe(false)
		expect(o.upsert("x", { hz: 50 }, 5)).toBe(true)
		expect(o.removeSoft("never", 9)).toBe(false)
	})

	it("a covered query refuses older upserts of records it matches but did not list", () => {
		const o = new WriteOrder<R>()
		o.cover(r => r.hz < 10, 5, new Set(["listed"]))
		expect(o.upsert("new", { hz: 5 }, 5)).toBe(false)
		expect(o.upsert("listed", { hz: 5 }, 5)).toBe(true)
		expect(o.upsert("elsewhere", { hz: 50 }, 1)).toBe(true)
		expect(o.upsert("new", { hz: 5 }, 6)).toBe(true)
	})

	it("keeps tombstones up to the cap; past it the oldest leaves and the floor rises to its seenAt", () => {
		const o = new WriteOrder<R>({ tombstones: 3 })
		for (const [i, at] of [10, 20, 30].entries()) o.removeHard(`g${i}`, at)
		// at the cap: all three remembered, anything seen after 0 may still write
		expect(o.tombstoneCount).toBe(3)
		expect(o.upsert("g0", { hz: 1 }, 1, 40)).toBe(false)
		expect(o.upsert("other", { hz: 1 }, 1, 1)).toBe(true)
		// one past the cap: g0 is forgotten; nothing seen at or before its removal may write
		o.removeHard("g3", 40)
		expect(o.tombstoneCount).toBe(3)
		expect(o.upsert("g0", { hz: 1 }, 1, 10)).toBe(false)
		expect(o.upsert("unseen", { hz: 1 }, 1, 10)).toBe(false)
		expect(o.upsert("unseen", { hz: 1 }, 1, 11)).toBe(true)
		// the forgotten deletion no longer guards g0 against an answer seen later
		expect(o.upsert("g0", { hz: 1 }, 1, 11)).toBe(true)
	})

	it("keeps coverages up to the cap; past it the oldest leaves and the floor rises to its seenAt", () => {
		const o = new WriteOrder<R>({ coverages: 2 })
		o.cover(r => r.hz === 1, 10, none)
		o.cover(r => r.hz === 2, 20, none)
		expect(o.upsert("a", { hz: 1 }, 10, 15)).toBe(false)
		expect(o.upsert("b", { hz: 3 }, 1, 1)).toBe(true)
		o.cover(r => r.hz === 3, 30, none)
		// the first left: its range is guarded by the floor (10) instead
		expect(o.upsert("a", { hz: 1 }, 10, 10)).toBe(false)
		expect(o.upsert("a", { hz: 1 }, 10, 11)).toBe(true)
	})

	it("defaults stay bounded", () => {
		expect(WRITE_ORDER_TOMBSTONES_MAX).toBe(2048)
		expect(WRITE_ORDER_COVERAGES_MAX).toBe(32)
		const o = new WriteOrder<R>()
		for (let i = 0; i <= WRITE_ORDER_TOMBSTONES_MAX; i++)
			o.removeHard(`g${i}`, i + 1)
		expect(o.tombstoneCount).toBe(WRITE_ORDER_TOMBSTONES_MAX)
	})
})
