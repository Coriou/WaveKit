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
	padLine,
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

describe("fix round 1: non-positive widths", () => {
	afterEach(() => setGlyphMode("utf8"))
	const line = [
		{ text: "api ", role: "label" as const },
		{ text: "● 2s", role: "live" as const },
	]
	for (const mode of ["utf8", "ascii"] as const) {
		it(`truncateLine and padLine return [] for w <= 0 (${mode})`, () => {
			setGlyphMode(mode)
			for (const w of [-1, 0]) {
				expect(truncateLine(line, w)).toEqual([])
				expect(padLine(line, w)).toEqual([])
			}
		})
	}
})

describe("fix round 1: ellipsis span", () => {
	it("keeps the role and bold of the span it continues", () => {
		const cut = truncateLine(
			[{ text: "readsb-long", role: "selected", bold: true }],
			6,
		)
		expect(cut).toEqual([
			{ text: "reads", role: "selected", bold: true },
			{ text: "…", role: "selected", bold: true },
		])
		const plain = truncateLine([{ text: "readsb-long", role: "value" }], 6)
		expect(plain[1]).toEqual({ text: "…", role: "value" })
	})
})

describe("fix round 1: wide, zero-width and hostile characters", () => {
	it("counts emoji outside the old ranges as 2 columns", () => {
		expect(cellWidth("🚀")).toBe(2) // U+1F680
		expect(cellWidth("🛸")).toBe(2) // U+1F6F8
		expect(cellWidth("🩺")).toBe(2) // U+1FA7A
		expect(cellWidth("🫠")).toBe(2) // U+1FAE0
		expect(cellWidth("⚡")).toBe(2) // U+26A1, emoji presentation
		expect(cellWidth("✅")).toBe(2) // U+2705, emoji presentation
	})
	it("keeps the dashboard glyphs one column wide", () => {
		for (const g of [
			"●",
			"○",
			"×",
			"—",
			"…",
			"·",
			"─",
			"↑",
			"↓",
			"▶",
			"▏",
			"–",
			"▁",
			"█",
			"☆",
			"✓",
		]) {
			expect(cellWidth(g)).toBe(1)
		}
	})
	it("counts word joiner, BOM and soft hyphen as zero width", () => {
		expect(cellWidth("a\u2060b")).toBe(2)
		expect(cellWidth("\uFEFFab")).toBe(2)
		expect(cellWidth("co\u00ADop")).toBe(4)
	})
	it("strips bidi controls and line/paragraph separators", () => {
		expect(sanitize("a\u202Eevil\u202Cb")).toBe("aevilb")
		expect(sanitize("x\u2066y\u2069z\u200F\u061C")).toBe("xyz")
		expect(sanitize("one\u2028two\u2029three")).toBe("onetwothree")
	})

	const HOSTILE =
		/[\u0000-\u001f\u007f-\u009f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/
	// Feature: cli-dashboard-overhaul, Property 7: sanitize and truncate
	// Validates: spec §5.2, Review Focus 4
	it("P7: sanitize removes bidi and separator vectors and stays idempotent", () => {
		const unit = fc.constantFrom(
			"a",
			"é",
			"漢",
			"❤",
			"\uFE0F",
			"🚀",
			"\t",
			"\r",
			"\x1b",
			"\u0085",
			"\u061C",
			"\u200E",
			"\u200F",
			"\u2028",
			"\u2029",
			"\u202A",
			"\u202B",
			"\u202C",
			"\u202D",
			"\u202E",
			"\u2066",
			"\u2067",
			"\u2068",
			"\u2069",
		)
		fc.assert(
			fc.property(
				fc.array(unit, { maxLength: 40 }).map(a => a.join("")),
				s => {
					const once = sanitize(s)
					expect(HOSTILE.test(once)).toBe(false)
					expect(sanitize(once)).toBe(once)
				},
			),
			{ numRuns: 100 },
		)
	})
})
