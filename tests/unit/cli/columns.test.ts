import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	layoutColumns,
	padCell,
	pickVariant,
	renderHeader,
	renderRow,
	type ColumnSpec,
} from "../../../cli/source/ui/columns.js"
import { cell, sp } from "../../../cli/source/ui/line.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"

const col = (
	id: string,
	min: number,
	pref: number,
	priority: number,
	flex = false,
): ColumnSpec => ({
	id,
	min,
	pref,
	priority,
	align: "left",
	flex,
	header: cell([sp(id, "label")]),
})

describe("layoutColumns", () => {
	const cols = [
		col("glyph", 1, 1, 0),
		col("name", 12, 16, 0),
		col("process", 6, 18, 0),
		col("decodes", 8, 16, 1),
		col("drop", 4, 8, 1),
		col("window", 6, 6, 2),
		col("nominal", 15, 15, 3),
		col("lifetime", 8, 8, 4),
	]
	it("drops the highest priority number first and grows toward pref", () => {
		const at60 = layoutColumns(59, cols).map(c => c.id)
		expect(at60).toEqual([
			"glyph",
			"name",
			"process",
			"decodes",
			"drop",
			"window",
		])
		const at120 = layoutColumns(119, cols)
		expect(at120.map(c => c.id)).toContain("lifetime")
		expect(at120.find(c => c.id === "name")?.width).toBe(16)
	})
	it("gives leftover space to the flex column", () => {
		const r = layoutColumns(50, [
			col("t", 5, 8, 0),
			col("summary", 10, 10, 0, true),
		])
		expect(r.find(c => c.id === "summary")?.width).toBe(50 - 8 - 2)
	})

	const arbCols = fc
		.array(
			fc.record({
				min: fc.integer({ min: 1, max: 20 }),
				extra: fc.integer({ min: 0, max: 10 }),
				priority: fc.integer({ min: 0, max: 6 }),
				flex: fc.boolean(),
			}),
			{ minLength: 1, maxLength: 12 },
		)
		.map(xs =>
			xs.map((x, i) =>
				col(`c${i}`, x.min, x.min + x.extra, x.priority, x.flex),
			),
		)

	// Feature: cli-dashboard-overhaul, Property 4: layoutColumns
	// Validates: spec §5.2
	it("P4: fits, keeps a priority prefix, respects mins, monotone presence", () => {
		fc.assert(
			fc.property(
				arbCols,
				fc.integer({ min: 0, max: 220 }),
				fc.integer({ min: 0, max: 60 }),
				(columns, w, d) => {
					const r = layoutColumns(w, columns)
					const used =
						r.reduce((a, c) => a + c.width, 0) + Math.max(0, r.length - 1) * 2
					expect(used).toBeLessThanOrEqual(Math.max(0, w))
					const ids = new Set(r.map(c => c.id))
					for (const c of columns) {
						if (!ids.has(c.id)) continue
						for (const o of columns)
							if (o.priority < c.priority) expect(ids.has(o.id)).toBe(true)
						expect(r.find(x => x.id === c.id)!.width).toBeGreaterThanOrEqual(
							c.min,
						)
					}
					const wider = new Set(layoutColumns(w + d, columns).map(c => c.id))
					for (const id of ids) expect(wider.has(id)).toBe(true)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("cells", () => {
	it("uses the richest variant that fits, then truncates the minimal one", () => {
		const c = cell([sp("up 51s")], [sp("up 51s · 1 restart")])
		expect(lineText(pickVariant(c, 20))).toBe("up 51s · 1 restart")
		expect(lineText(pickVariant(c, 8))).toBe("up 51s")
		expect(lineText(pickVariant(c, 4))).toBe("up …")
	})
	it("renders aligned rows of exact width", () => {
		const layout = [
			{ id: "a", width: 6, align: "left" as const },
			{ id: "b", width: 5, align: "right" as const },
		]
		const row = renderRow(layout, { a: cell([sp("ab")]), b: cell([sp("12%")]) })
		expect(lineText(row)).toBe("ab        12%")
		expect(lineWidth(row)).toBe(13)
	})
	it("renders the header row through the same layout", () => {
		const columns = [col("time", 5, 8, 0), col("decoder", 10, 12, 0)]
		const header = renderHeader(layoutColumns(22, columns), columns)
		expect(lineText(header)).toBe("time      decoder     ")
	})
	it("treats a non-positive cell width as empty instead of throwing", () => {
		expect(lineWidth(pickVariant(cell([sp("abc")]), -2))).toBe(0)
		expect(lineWidth(padCell([sp("abc")], -2, "right"))).toBe(0)
	})
})
