import { beforeAll, describe, expect, it } from "vitest"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { stripLine, type StripInput } from "../../../cli/source/ui/strip.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const base: StripInput = {
	api: { kind: "ok", restAgeMs: 2000 },
	iq: {
		glyph: "live",
		word: "streaming",
		ageMs: null,
		rateBytesPerSec: 3994 * 1024,
	},
	decoders: { up: 8, total: 9, failing: 0, restarting: 1, inWindow: 2 },
	drops: { ratio: 0.21, backpressure: true },
	rx: { centreHz: 445_970_700, halfSpanHz: 1_024_000, control: "external" },
	clockMs: Date.parse("2026-10-08T18:07:52Z"),
	old: { iq: false, decoders: false, rx: false },
}

const at = (input: StripInput, cols: number) => stripLine(input, cols - 1)

describe("R46: restarting decoders are visible in the strip", () => {
	it("renders `N restarting` in the attention role at 200/120/80/60", () => {
		expect(lineText(at(base, 200))).toContain(
			"decoders 8/9 up · 1 restarting · 2 in window",
		)
		expect(lineText(at(base, 120))).toContain("decoders 8/9 up · 1 restarting")
		expect(lineText(at(base, 80))).toContain("decoders 1 restarting")
		expect(lineText(at(base, 60))).toContain("decoders 1 restarting")
		for (const cols of [200, 120, 80, 60]) {
			const line = at(base, cols)
			expect(lineWidth(line)).toBeLessThanOrEqual(cols - 1)
			expect(line.find(s => s.text === "1 restarting")?.role).toBe("attention")
			expect(findBanned(lineText(line))).toEqual([])
		}
	})
	it("shows failing (fault) before restarting (attention) when both are present", () => {
		const both: StripInput = {
			...base,
			decoders: { up: 6, total: 9, failing: 2, restarting: 1, inWindow: 2 },
		}
		expect(lineText(at(both, 200))).toContain(
			"decoders 6/9 up · 2 failing · 1 restarting · 2 in window",
		)
		expect(lineText(at(both, 60))).toContain(
			"decoders 2 failing · 1 restarting",
		)
		const line = at(both, 200)
		expect(line.find(s => s.text === "2 failing")?.role).toBe("fault")
		expect(line.find(s => s.text === "1 restarting")?.role).toBe("attention")
	})
	it("is unchanged when restarting is 0 or absent", () => {
		const { restarting: _r, ...noField } = base.decoders!
		for (const decoders of [{ ...base.decoders!, restarting: 0 }, noField]) {
			const out = lineText(at({ ...base, decoders }, 200))
			expect(out).toContain("decoders 8/9 up · 2 in window")
			expect(out).not.toContain("restarting")
		}
	})
	it("dims the count when the decoders lane is old", () => {
		const line = at({ ...base, old: { ...base.old, decoders: true } }, 200)
		expect(line.find(s => s.text === "1 restarting")?.role).toBe("old")
	})
})
