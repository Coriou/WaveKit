import { describe, expect, it } from "vitest"
import {
	placeSavedTags,
	savedTagWidth,
	SAVED_TAG_MAX_LABEL_PX,
} from "../../src/plot/saved-tags.ts"

const view = { startHz: 160_000_000, endHz: 162_000_000 } // 2 MHz
const W = 1000 // 2 kHz a pixel
const at = (px: number) => view.startHz + px * 2000
const tag = (id: string, px: number, name = id) => ({
	id,
	name,
	frequencyHz: at(px),
})

describe("saved tag layout", () => {
	it("sizes a chip from its name, capped, as the board does", () => {
		expect(savedTagWidth("Port ops")).toBe(Math.round(24 + 8 * 6.6))
		expect(savedTagWidth("x".repeat(128))).toBe(24 + SAVED_TAG_MAX_LABEL_PX)
	})

	it("places tags in view at their frequency, left to right", () => {
		const placed = placeSavedTags(
			[
				tag("b", 600),
				tag("a", 100),
				{ id: "out", name: "out", frequencyHz: 170e6 },
			],
			view,
			{ widthPx: W, showLabels: true },
		)
		expect(placed.map(p => [p.id, Math.round(p.x), p.labelled])).toEqual([
			["a", 100, true],
			["b", 600, true],
		])
	})

	it("drops the name of a crowded tag, then the tag itself", () => {
		// "Bravo station" needs 110 px; "Charlie" sits 70 px to its right, so Bravo keeps its bookmark only.
		// "Delta" 5 px past Charlie cannot even show a bookmark.
		const placed = placeSavedTags(
			[
				tag("Alpha", 100),
				tag("Bravo station", 180),
				tag("Charlie", 250),
				tag("Delta", 255),
			],
			view,
			{ widthPx: W, showLabels: true },
		)
		expect(placed.map(p => [p.id, p.labelled, p.width])).toEqual([
			["Alpha", true, savedTagWidth("Alpha")],
			["Bravo station", false, 20],
			["Charlie", true, savedTagWidth("Charlie")],
		])
		// no two placed chips overlap (4 px gap)
		for (let i = 1; i < placed.length; i++) {
			const prev = placed[i - 1]
			const cur = placed[i]
			if (!prev || !cur) continue
			expect(cur.x).toBeGreaterThanOrEqual(prev.x + prev.width + 4)
		}
	})

	it("lets the tuned tag win a clash", () => {
		const items = [tag("Left", 100), tag("Tuned", 110)]
		const free = placeSavedTags(items, view, { widthPx: W, showLabels: true })
		expect(free.map(p => p.id)).toEqual(["Left"])
		const tuned = placeSavedTags(items, view, {
			widthPx: W,
			showLabels: true,
			tunedHz: at(110),
		})
		expect(tuned.map(p => [p.id, p.labelled])).toEqual([["Tuned", true]])
	})

	it("draws bookmarks only when labels are off, and one tag per frequency", () => {
		const placed = placeSavedTags(
			[tag("Zulu", 100), { ...tag("Alpha", 100), id: "dup" }, tag("Far", 500)],
			view,
			{ widthPx: W, showLabels: false },
		)
		expect(placed.map(p => [p.id, p.labelled])).toEqual([
			["dup", false],
			["Far", false],
		])
	})

	it("does not draw a name past the right edge", () => {
		const placed = placeSavedTags([tag("Edge name", 990)], view, {
			widthPx: W,
			showLabels: true,
		})
		expect(placed[0]).toMatchObject({ labelled: false, width: 20 })
		expect(
			placeSavedTags([tag("a", 1)], view, { widthPx: 0, showLabels: true }),
		).toEqual([])
	})
})
