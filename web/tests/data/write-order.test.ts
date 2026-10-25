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
const k = (rev: number, read: number, seq = 0) => ({ rev, read, seq })

describe("WriteOrder", () => {
	it("orders on (rev, read, seq): a lower triple is refused, an equal or higher one applies", () => {
		const o = new WriteOrder<R>()
		expect(o.upsert("x", { hz: 1 }, k(2, 5, 3))).toBe("applied")
		expect(o.upsert("x", { hz: 1 }, k(1, 9, 9))).toBe("order")
		expect(o.upsert("x", { hz: 1 }, k(2, 4, 9))).toBe("order")
		// the same revision read at the same store revision: the later-started read wins
		expect(o.upsert("x", { hz: 1 }, k(2, 5, 2))).toBe("order")
		expect(o.upsert("x", { hz: 1 }, k(2, 5, 3))).toBe("applied")
		expect(o.upsert("x", { hz: 1 }, k(2, 5, 4))).toBe("applied")
		expect(o.upsert("x", { hz: 1 }, k(3, 3, 0))).toBe("applied")
	})

	it("a deletion is final: no keys bring the id back", () => {
		const o = new WriteOrder<R>()
		o.upsert("x", { hz: 1 }, k(2, 2))
		o.removeHard("x", 3)
		expect(o.upsert("x", { hz: 1 }, k(2, 2))).toBe("order")
		expect(o.upsert("x", { hz: 1 }, k(99, 99, 99))).toBe("order")
		// also for an id never cached, and one deleted without a known revision
		o.removeHard("y", 4)
		expect(o.upsert("y", { hz: 1 }, k(1, 9))).toBe("order")
		o.removeHard("z", Infinity)
		expect(o.upsert("z", { hz: 1 }, k(9, 9))).toBe("order")
	})

	it("a page removal keeps a newer cached record, and a later upsert at or above it returns", () => {
		const o = new WriteOrder<R>()
		o.upsert("x", { hz: 1 }, k(5, 5))
		expect(o.removeSoft("x", k(4, 4, 1))).toBe(false)
		expect(o.removeSoft("x", k(6, 6, 2))).toBe(true)
		expect(o.upsert("x", { hz: 50 }, k(4, 9))).toBe("order")
		expect(o.upsert("x", { hz: 50 }, k(5, 5))).toBe("order")
		expect(o.upsert("x", { hz: 50 }, k(5, 6, 3))).toBe("applied")
		expect(o.removeSoft("never", k(9, 9))).toBe(false)
	})

	it("a covered query refuses an upsert read before it of a record it matches but did not list", () => {
		const o = new WriteOrder<R>()
		o.cover(r => r.hz < 10, 5, new Set(["listed"]))
		expect(o.upsert("new", { hz: 5 }, k(1, 4))).toBe("order")
		expect(o.upsert("listed", { hz: 5 }, k(1, 4))).toBe("applied")
		expect(o.upsert("elsewhere", { hz: 50 }, k(1, 1))).toBe("applied")
		expect(o.upsert("new", { hz: 5 }, k(1, 5))).toBe("applied")
	})

	it("keeps tombstones up to the cap; past it the oldest leaves and the floor rises to its read", () => {
		const o = new WriteOrder<R>({ tombstones: 3 })
		for (const [i, at] of [10, 20, 30].entries()) o.removeHard(`g${i}`, at)
		expect(o.tombstoneCount).toBe(3)
		expect(o.upsert("g0", { hz: 1 }, k(1, 40))).toBe("order")
		expect(o.upsert("other", { hz: 1 }, k(1, 1))).toBe("applied")
		// one past the cap: g0 is forgotten; an answer read before its removal is refused by the floor
		o.removeHard("g3", 40)
		expect(o.tombstoneCount).toBe(3)
		expect(o.upsert("g0", { hz: 1 }, k(1, 9))).toBe("floor")
		expect(o.upsert("unseen", { hz: 1 }, k(1, 9))).toBe("floor")
		expect(o.upsert("unseen", { hz: 1 }, k(1, 10))).toBe("applied")
	})

	it("a deletion without the core's revision never raises the floor when it is evicted", () => {
		const o = new WriteOrder<R>({ tombstones: 1 })
		o.removeHard("a", Infinity)
		o.removeHard("b", Infinity)
		expect(o.upsert("fresh", { hz: 1 }, k(1, 1))).toBe("applied")
	})

	it("keeps coverages up to the cap; past it the oldest leaves and the floor rises to its read", () => {
		const o = new WriteOrder<R>({ coverages: 2 })
		o.cover(r => r.hz === 1, 10, none)
		o.cover(r => r.hz === 2, 20, none)
		expect(o.upsert("a", { hz: 1 }, k(3, 9))).toBe("order")
		expect(o.upsert("b", { hz: 3 }, k(1, 1))).toBe("applied")
		o.cover(r => r.hz === 3, 30, none)
		expect(o.upsert("a", { hz: 1 }, k(3, 9))).toBe("floor")
		expect(o.upsert("a", { hz: 1 }, k(3, 10))).toBe("applied")
	})

	it("an idle store past both caps: fresh reads at the same store revision still apply", () => {
		const o = new WriteOrder<R>({ tombstones: 2, coverages: 2 })
		const R = 7
		for (let i = 0; i < 33; i++) o.cover(r => r.hz === i, R, new Set([`p${i}`]))
		for (let i = 0; i < 3; i++) o.removeHard(`g${i}`, R)
		expect(o.upsert("fresh", { hz: 999 }, k(R, R))).toBe("applied")
		expect(o.upsert("old", { hz: 999 }, k(2, R))).toBe("applied")
		expect(o.upsert("stale", { hz: 999 }, k(2, R - 1))).toBe("floor")
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
