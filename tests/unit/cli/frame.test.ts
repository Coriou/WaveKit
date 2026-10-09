import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	chromeRows,
	detailPlacement,
	heightClass,
	listBudget,
	overviewBudget,
	tooSmall,
	tooSmallText,
	widthClass,
} from "../../../cli/source/ui/frame.js"

describe("frame classes", () => {
	it("classifies sizes", () => {
		expect(tooSmall(59, 20)).toBe(true)
		expect(tooSmall(60, 16)).toBe(false)
		expect(tooSmallText(59, 15)).toBe(
			"wavekit: terminal 59×15 is too small (minimum 60×16)",
		)
		expect(tooSmallText(50, 12)).toBe("wavekit: 50×12 too small (min 60×16)")
		expect(tooSmallText(8, 4)).toBe("min 60×16")
		expect(heightClass(29)).toBe("compact")
		expect(heightClass(30)).toBe("roomy")
		expect([60, 80, 120, 160].map(widthClass)).toEqual([
			"narrow",
			"standard",
			"wide",
			"ultra",
		])
	})
	it("reserves rows-1 and the chrome rows", () => {
		expect(chromeRows(40, false)).toMatchObject({
			frame: 39,
			switcher: 1,
			blank: 1,
			content: 35,
		})
		expect(chromeRows(24, true)).toMatchObject({
			frame: 23,
			switcher: 0,
			blank: 0,
			banner: 1,
			content: 20,
		})
	})
	it("places the detail pane by size", () => {
		expect(detailPlacement(200, true, 45)).toEqual({
			kind: "right",
			width: 86,
			gutter: 2,
		})
		expect(detailPlacement(120, true, 35)).toEqual({
			kind: "bottom",
			height: 15,
		})
		expect(detailPlacement(80, false, 21)).toEqual({ kind: "overlay" })
	})
	it("matches the 80×24 and 60×20 mockups", () => {
		expect(
			overviewBudget(80, chromeRows(24, false).content, false, 9),
		).toMatchObject({
			layout: "stacked",
			decoderRows: 9,
			more: 0,
			messageRows: 8,
		})
		expect(
			overviewBudget(60, chromeRows(16, false).content, false, 9),
		).toMatchObject({
			decoderRows: 5,
			more: 1,
			hiddenDecoders: 4,
			messageRows: 3,
		})
		expect(
			overviewBudget(200, chromeRows(50, false).content, true, 9),
		).toMatchObject({ layout: "columns", rightWidth: 86 })
	})

	// Feature: cli-dashboard-overhaul, Property 5: frame budget
	// Validates: spec §5.1
	it("P5: regions fit rows-1, messages ≥ 3, decoders are all accounted for", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 60, max: 260 }),
				fc.integer({ min: 16, max: 90 }),
				fc.integer({ min: 0, max: 60 }),
				fc.boolean(),
				(cols, rows, n, banner) => {
					const c = chromeRows(rows, banner)
					const roomy = heightClass(rows) === "roomy"
					const b = overviewBudget(cols, c.content, roomy, n)
					const chrome = c.strip + c.switcher + c.blank + c.banner + c.footer
					const left =
						b.receiver +
						b.gapAfterReceiver +
						b.decoderHeader +
						b.decoderRows +
						b.more
					const stacked =
						left + b.gapAfterDecoders + b.messageHeader + b.messageRows
					const content =
						b.layout === "columns"
							? Math.max(left, b.messageHeader + b.messageRows)
							: stacked
					expect(chrome + content).toBeLessThanOrEqual(rows - 1)
					expect(b.messageRows).toBeGreaterThanOrEqual(3)
					if (n === 0) expect(b.decoderRows).toBe(1)
					else expect(b.decoderRows + b.hiddenDecoders).toBe(n)
					expect(b.more).toBe(b.hiddenDecoders > 0 ? 1 : 0)
					const l = listBudget(cols, c.content, roomy, 1, true)
					expect(
						l.header +
							l.listRows +
							l.gapRows +
							(l.placement.kind === "bottom" ? l.detailRows : 0),
					).toBeLessThanOrEqual(c.content)
				},
			),
			{ numRuns: 100 },
		)
	})
})
