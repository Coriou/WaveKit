import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import {
	cellWidth,
	padEnd,
	sanitize,
	stripAnsi,
	stripSequences,
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
		expect(sanitize("a\tb\x1b[2Jc\r\nd\u0085e")).toBe("a bcde")
		expect(sanitize("hi 🚀")).toBe("hi ?")
	})
	it("strips whole CSI, OSC and string sequences, leaving no residue (R27)", () => {
		expect(sanitize("a\x1b[2Jb")).toBe("ab")
		expect(sanitize("x\x1b[38;5;196mred\x1b[0m")).toBe("xred")
		expect(sanitize("a\x1b[?1049hb")).toBe("ab")
		expect(sanitize("t\x1b]0;title\x07u")).toBe("tu")
		expect(sanitize("t\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("tlink")
		expect(sanitize("a\x1bPq#0;1\x1b\\b")).toBe("ab")
		expect(sanitize("a\x9b2Jb\x9d0;t\x9cc")).toBe("abc")
		expect(sanitize("a\x1b]0;never terminated")).toBe("a")
		expect(sanitize("\x1b\x1b[0m[2J")).toBe("")
	})

	it("strips nested escape runs in one linear pass (B2 fix 2)", () => {
		for (const k of [6_667, 33_333]) {
			for (const s of [
				"\x1b".repeat(k) + "[m".repeat(k),
				"\x9b".repeat(k) + "m".repeat(k),
			]) {
				const r = stripSequences(s)
				expect(r.text).toBe("")
				expect(r.steps).toBeLessThanOrEqual(3 * s.length)
				expect(sanitize(s)).toBe("")
			}
		}
		const mixed = "a\x1b\x1b[0m[2Jb\x9d0;t\x07".repeat(5_000)
		const r = stripSequences(mixed)
		expect(r.text).toBe("ab".repeat(5_000))
		expect(r.steps).toBeLessThanOrEqual(3 * mixed.length)
	})

	const ESCAPE_BITS = [
		"\x1b",
		"[",
		"]",
		"2",
		"J",
		";",
		"0",
		"m",
		"?",
		"\x07",
		"\\",
		"\x9b",
		"\x9c",
		"\x9d",
		"P",
		"a",
		" ",
	]

	// Feature: cli-dashboard-overhaul, Property 7: sanitize and truncate
	// Validates: spec §5.2
	it("P7: escape soup sanitises to no ESC/C1, no CSI residue, idempotently", () => {
		fc.assert(
			fc.property(
				fc
					.array(fc.constantFrom(...ESCAPE_BITS), { maxLength: 40 })
					.map(a => a.join("")),
				s => {
					const once = sanitize(s)
					expect(CONTROL.test(once)).toBe(false)
					expect(sanitize(once)).toBe(once)
				},
			),
			{ numRuns: 100 },
		)
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
