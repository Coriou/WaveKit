import { describe, expect, it } from "vitest"

import {
	GALLERY_GAP,
	dealColumns,
	galleryColumns,
} from "../../src/features/messages/gallery.ts"

describe("Messages view gallery", () => {
	it("fits 340 px columns, one to three", () => {
		expect(galleryColumns(200)).toBe(1)
		expect(galleryColumns(693)).toBe(1)
		expect(galleryColumns(694)).toBe(2)
		expect(galleryColumns(1048)).toBe(3)
		expect(galleryColumns(3000)).toBe(3)
	})

	it("deals cards newest first across the top, then to the shortest column", () => {
		const h: Record<string, number> = { a: 300, b: 100, c: 100, d: 50, e: 50 }
		const cols = dealColumns(["a", "b", "c", "d", "e"], 3, x => h[x] ?? 0)
		expect(cols).toEqual([["a"], ["b", "d"], ["c", "e"]])
	})

	it("keeps every card once, in order within a column", () => {
		const items = Array.from({ length: 40 }, (_, i) => i)
		const cols = dealColumns(items, 3, i => 100 + ((i * 37) % 90))
		expect(cols.flat().sort((a, b) => a - b)).toEqual(items)
		for (const c of cols) expect([...c].sort((a, b) => a - b)).toEqual(c)
		const tall = cols.map(c =>
			c.reduce((n, i) => n + 100 + ((i * 37) % 90) + GALLERY_GAP, 0),
		)
		expect(Math.max(...tall) - Math.min(...tall)).toBeLessThan(200)
	})

	it("treats a zero column count as one", () => {
		expect(dealColumns([1, 2], 0, () => 10)).toEqual([[1, 2]])
	})
})
