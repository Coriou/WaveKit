import { describe, expect, it } from "vitest"
import { sp } from "../../../cli/source/ui/line.js"
import { lineText } from "../../../cli/source/ui/text.js"
import {
	essential,
	gapRow,
	grouped,
	keep,
	optional,
	shed,
	type Row,
} from "../../../cli/source/view-models/shed.js"

const row = (t: string): Row => keep([sp(t)])
const opt = (t: string, drop: number): Row => optional([sp(t)], drop)
const text = (rows: Row[], height: number, capped = {}) =>
	shed(rows, height, capped).map(lineText)

describe("shed (spec §5.1)", () => {
	it("returns everything that fits, gaps and all", () => {
		expect(text([row("A"), gapRow(9), row("B")], 3)).toEqual(["A", "", "B"])
	})
	it("drops gaps first and never counts them as hidden", () => {
		expect(
			text([row("A"), gapRow(9), row("B"), gapRow(9), row("C")], 3),
		).toEqual(["A", "B", "C"])
	})
	it("sheds the highest drop first and, on ties, the last such row, then marks it", () => {
		const rows = [row("A"), opt("x1", 2), opt("y", 1), opt("x2", 2), row("B")]
		expect(text(rows, 5)).toEqual(["A", "x1", "y", "x2", "B"])
		// height 4: dropping x2 alone adds a marker (still 5), so x1 goes too.
		expect(text(rows, 4)).toEqual(["A", "y", "B", "          +2 rows hidden"])
	})
	it("folds a group's hidden rows, capped ones included, into its own marker", () => {
		const rows = [
			row("head"),
			grouped([sp("w1")], "warn", 5),
			grouped([sp("w2")], "warn", 5),
			row("CORE"),
		]
		expect(text(rows, 10, { warn: 3 })).toEqual([
			"head",
			"w1",
			"w2",
			"          +3 more",
			"CORE",
		])
		expect(text(rows, 4, { warn: 3 })).toEqual([
			"head",
			"w1",
			"          +4 more",
			"CORE",
		])
	})
	it("gives a capped-only group (no rows) its marker", () => {
		expect(text([row("head")], 5, { errors: 2 })).toEqual([
			"head",
			"          +2 more",
		])
	})
	it("hides plain kept rows (last first) before essential heads, with a marker", () => {
		const rows = [
			essential([sp("CONTAINER")]),
			row("cpu"),
			row("mem"),
			essential([sp("CORE")]),
		]
		expect(text(rows, 3)).toEqual([
			"CONTAINER",
			"CORE",
			"          +2 rows hidden",
		])
	})
	it("when essential heads alone overflow, keeps the first lines and still ends with a marker", () => {
		const rows = [
			essential([sp("A")]),
			essential([sp("B")]),
			essential([sp("C")]),
		]
		expect(text(rows, 2)).toEqual(["A", "          +2 rows hidden"])
		expect(text(rows, 0)).toEqual([])
	})
})
