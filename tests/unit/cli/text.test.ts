import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import {
	cellWidth,
	padEnd,
	sanitize,
	stripAnsi,
	truncate,
	truncateLine,
	lineWidth,
} from "../../../cli/source/ui/text.js"
import { setGlyphMode } from "../../../cli/source/ui/theme.js"

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

describe("cellWidth", () => {
	it("counts ASCII, glyphs, wide and combining characters", () => {
		expect(cellWidth("api ● 2s")).toBe(8)
		expect(cellWidth("漢字")).toBe(4)
		expect(cellWidth("é")).toBe(1)
		expect(cellWidth("\x1b[31mred\x1b[0m")).toBe(3)
		expect(stripAnsi("\x1b]52;c;Zm9v\x07x")).toBe("x")
	})
})

describe("sanitize", () => {
	it("strips controls, expands tabs and replaces emoji", () => {
		expect(sanitize("a\tb\x1b[2Jc\r\nd\u0085e")).toBe("a b[2Jcde")
		expect(sanitize("hi 🚀")).toBe("hi ?")
	})

	// Feature: cli-dashboard-overhaul, Property 7: sanitize and truncate
	// Validates: spec §5.2
	// fast-check pays a one-time ~5 s warm-up the first time it builds a
	// "binary" string arbitrary, which exceeds the default 5 s test timeout.
	it("P7: sanitize output has no C0, C1, ESC or DEL and is idempotent", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), s => {
				const once = sanitize(s)
				expect(CONTROL.test(once)).toBe(false)
				expect(sanitize(once)).toBe(once)
			}),
			{ numRuns: 100 },
		)
	}, 60_000)

	// Feature: cli-dashboard-overhaul, Property 7: sanitize and truncate
	// Validates: spec §5.2
	it("P7: truncate(s, w) fits w and ends in … iff the input was wider", () => {
		fc.assert(
			fc.property(
				fc.string({ unit: "grapheme" }).map(sanitize),
				fc.integer({ min: 1, max: 80 }),
				(s, w) => {
					const out = truncate(s, w)
					expect(cellWidth(out)).toBeLessThanOrEqual(w)
					if (cellWidth(s) > w) expect(out.endsWith("…")).toBe(true)
					else expect(out).toBe(s)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("truncate in ASCII mode", () => {
	afterEach(() => setGlyphMode("utf8"))
	it("uses a 3-column ellipsis and still fits", () => {
		setGlyphMode("ascii")
		expect(truncate("abcdefghij", 6)).toBe("abc...")
		expect(cellWidth(truncate("abcdefghij", 2))).toBeLessThanOrEqual(2)
	})
})

describe("line helpers", () => {
	it("truncates a span line to width with a trailing ellipsis", () => {
		const line = [
			{ text: "api ", role: "label" as const },
			{ text: "● 2s", role: "live" as const },
		]
		const cut = truncateLine(line, 5)
		expect(lineWidth(cut)).toBe(5)
		expect(cut.map(s => s.text).join("")).toBe("api …")
		expect(padEnd("ab", 4)).toBe("ab  ")
	})
})
