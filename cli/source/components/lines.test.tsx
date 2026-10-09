import { describe, expect, it } from "vitest"
import { renderAt } from "../test/harness.js"
import { stripLine } from "../ui/strip.js"
import { lineText } from "../ui/text.js"
import { ColorContext, Lines, styledSegments } from "./lines.js"

describe("Lines", () => {
	it("renders one row per line with a 1-column gutter, keeping empty rows", async () => {
		const lines = [
			[
				{ text: "api ", role: "label" as const },
				{ text: "● 2s", role: "live" as const },
			],
			[],
			[{ text: "x", role: "value" as const }],
		]
		const h = await renderAt(
			<ColorContext.Provider value={false}>
				<Lines lines={lines} width={20} />
			</ColorContext.Provider>,
			{ cols: 20, rows: 10 },
		)
		expect(h.frame()).toEqual([" api ● 2s", "", " x"])
		h.unmount()
	})

	it("M1: every bold/dim boundary passes through an unstyled cell (Ink drops shared SGR 22)", () => {
		const strip = stripLine(
			{
				api: { kind: "ok", restAgeMs: 0 },
				iq: {
					glyph: "live",
					word: "streaming",
					ageMs: null,
					rateBytesPerSec: 4_096_000,
				},
				decoders: { up: 8, total: 9, failing: 0, restarting: 1, inWindow: 2 },
				drops: { ratio: 0.21, backpressure: true },
				rx: {
					centreHz: 445_970_700,
					halfSpanHz: 1_024_000,
					control: "external",
				},
				clockMs: 0,
				old: { iq: false, decoders: false, rx: false },
			},
			119,
		)
		const segs = styledSegments(strip, true)
		const intensity = (p: (typeof segs)[number]["props"]): string =>
			p.bold === true ? "bold" : p.dimColor === true ? "dim" : "none"
		for (let i = 1; i < segs.length; i++) {
			const a = intensity(segs[i - 1]!.props)
			const b = intensity(segs[i]!.props)
			if (a !== "none" && b !== "none") expect(a).toBe(b)
		}
		expect(segs.map(x => x.text).join("")).toBe(lineText(strip))
	})
})
