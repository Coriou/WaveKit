import { describe, expect, it } from "vitest"
import {
	WRITE_ORDER_COVERAGES_MAX,
	WRITE_ORDER_TOMBSTONES_MAX,
	WriteOrder,
} from "../../src/data/write-order.ts"

interface R {
	hz: number
}

describe("WriteOrder", () => {
	it("applies a write only when it is strictly newer than the id's last", () => {
		const o = new WriteOrder<R>()
		const a = o.next()
		const b = o.next()
		expect(o.upsert("x", { hz: 1 }, b)).toBe(true)
		expect(o.upsert("x", { hz: 1 }, a)).toBe(false)
		expect(o.upsert("x", { hz: 1 }, b)).toBe(false)
		expect(o.remove("x", a)).toBe(false)
		const c = o.next()
		expect(o.remove("x", c)).toBe(true)
		expect(o.upsert("x", { hz: 1 }, b)).toBe(false)
		expect(o.upsert("x", { hz: 1 }, o.next())).toBe(true)
	})

	it("a covered query refuses older upserts of records it matches, seen or not", () => {
		const o = new WriteOrder<R>()
		const a = o.next()
		const b = o.next()
		o.cover(r => r.hz < 10, b)
		expect(o.upsert("new", { hz: 5 }, a)).toBe(false)
		expect(o.upsert("elsewhere", { hz: 50 }, a)).toBe(true)
		expect(o.upsert("new", { hz: 5 }, o.next())).toBe(true)
	})

	it("keeps tombstones up to the cap; past it the oldest leaves and the floor rises to it", () => {
		const o = new WriteOrder<R>({ tombstones: 3 })
		const before = o.next()
		const at = [o.next(), o.next(), o.next()]
		for (const [i, s] of at.entries()) expect(o.remove(`g${i}`, s)).toBe(true)
		// at the cap: all three remembered, unknown ids still open to the oldest request
		expect(o.tombstoneCount).toBe(3)
		expect(o.upsert("g0", { hz: 1 }, before)).toBe(false)
		expect(o.upsert("other", { hz: 1 }, before)).toBe(true)
		// one past the cap: g0 is forgotten, but nothing started at or before it may write
		const d = o.next()
		expect(o.remove("g3", d)).toBe(true)
		expect(o.tombstoneCount).toBe(3)
		expect(o.last("g0")).toBe(at[0])
		expect(o.upsert("g0", { hz: 1 }, at[0]!)).toBe(false)
		expect(o.upsert("unseen", { hz: 1 }, before)).toBe(false)
		expect(o.upsert("g0", { hz: 1 }, at[1]!)).toBe(true)
	})

	it("keeps coverages up to the cap; past it the oldest leaves and the floor rises to it", () => {
		const o = new WriteOrder<R>({ coverages: 2 })
		const before = o.next()
		const c1 = o.next()
		const c2 = o.next()
		o.cover(r => r.hz === 1, c1)
		o.cover(r => r.hz === 2, c2)
		expect(o.upsert("a", { hz: 3 }, before)).toBe(true)
		expect(o.upsert("b", { hz: 1 }, before)).toBe(false)
		const c3 = o.next()
		o.cover(r => r.hz === 3, c3)
		// c1 left: its range is now guarded by the floor (c1) instead
		expect(o.last("b", { hz: 1 })).toBe(c1)
		expect(o.upsert("b", { hz: 1 }, c1)).toBe(false)
		expect(o.upsert("b", { hz: 1 }, c2)).toBe(true)
	})

	it("defaults stay bounded", () => {
		expect(WRITE_ORDER_TOMBSTONES_MAX).toBe(2048)
		expect(WRITE_ORDER_COVERAGES_MAX).toBe(32)
		const o = new WriteOrder<R>()
		for (let i = 0; i <= WRITE_ORDER_TOMBSTONES_MAX; i++)
			o.remove(`g${i}`, o.next())
		expect(o.tombstoneCount).toBe(WRITE_ORDER_TOMBSTONES_MAX)
	})
})
