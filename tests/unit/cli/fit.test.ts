import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { fitGroups, fitGroupsDetailed } from "../../../cli/source/ui/fit.js"
import type { Group } from "../../../cli/source/ui/line.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"

const g = (priority: number, ...variants: string[]): Group => ({
	priority,
	variants: variants.map(t => [{ text: t, role: "value" as const }]),
})

describe("fitGroups", () => {
	const strip = [
		g(1, "api ● 2s"),
		g(2, "iq ● streaming", "iq ● streaming · 4.1 MB/s"),
		g(5, "rx 445.971 MHz", "rx 445.971 MHz ±1.024"),
		g(3, "decoders 1 failing", "decoders 8/9 up · 1 failing"),
		g(4, "drops 34%", "drops 34% now"),
		g(6, "18:07"),
	]
	it("removes lanes in reverse priority, then enriches in priority order", () => {
		expect(lineText(fitGroups(strip, 200))).toBe(
			"api ● 2s  iq ● streaming · 4.1 MB/s  rx 445.971 MHz ±1.024  decoders 8/9 up · 1 failing  drops 34% now  18:07",
		)
		expect(lineText(fitGroups(strip, 60))).toBe(
			"api ● 2s  iq ● streaming  decoders 1 failing  drops 34% now",
		)
	})
	it("right-aligns the last group", () => {
		const out = lineText(
			fitGroups([g(1, "left"), g(2, "clock")], 20, { rightAlignLast: true }),
		)
		expect(out).toBe("left           clock")
	})
	it("appends a drop marker when segments were dropped", () => {
		const out = lineText(
			fitGroups([g(0, "TG 2350"), g(1, "SRC 2341234"), g(5, "CC 1")], 25, {
				dropMarker: { text: "…", role: "label" },
			}),
		)
		expect(out).toBe("TG 2350  SRC 2341234  …")
	})
	it("cuts the last group at width-1 with … when even it overflows", () => {
		expect(lineText(fitGroups([g(0, "abcdefghij")], 6))).toBe("abcde…")
	})
	it("treats a non-positive width as empty instead of throwing", () => {
		expect(lineWidth(fitGroups([g(0, "abc")], -3))).toBe(0)
	})

	const arbGroups = fc
		.array(
			fc.record({
				priority: fc.integer({ min: 0, max: 6 }),
				variants: fc.array(
					fc
						.string({ minLength: 1, maxLength: 20 })
						.map(s => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "x")),
					{ minLength: 1, maxLength: 3 },
				),
			}),
			{ minLength: 1, maxLength: 7 },
		)
		.map(gs => gs.map(x => g(x.priority, ...x.variants)))

	// Feature: cli-dashboard-overhaul, Property 1: fitGroups width
	// Validates: spec §5.2
	it("P1: output width ≤ width for every width ≥ 1", () => {
		fc.assert(
			fc.property(
				arbGroups,
				fc.integer({ min: 1, max: 220 }),
				fc.boolean(),
				(groups, w, right) => {
					expect(
						lineWidth(
							fitGroups(groups, w, {
								rightAlignLast: right,
								dropMarker: { text: "…", role: "label" },
							}),
						),
					).toBeLessThanOrEqual(w)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 2: fitGroups priority
	// Validates: spec §4.2
	it("P2: a present group implies every higher-priority group is present", () => {
		fc.assert(
			fc.property(arbGroups, fc.integer({ min: 1, max: 220 }), (groups, w) => {
				const r = fitGroupsDetailed(groups, w)
				groups.forEach((gi, i) => {
					if (!r.present[i]) return
					groups.forEach((gj, j) => {
						if (gj.priority < gi.priority) expect(r.present[j]).toBe(true)
					})
				})
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 3: fitGroups monotone presence
	// Validates: spec §4.2
	it("P3: widening never removes a group", () => {
		fc.assert(
			fc.property(
				arbGroups,
				fc.integer({ min: 1, max: 200 }),
				fc.integer({ min: 0, max: 50 }),
				(groups, w, d) => {
					const a = fitGroupsDetailed(groups, w).present
					const b = fitGroupsDetailed(groups, w + d).present
					a.forEach((p, i) => {
						if (p) expect(b[i]).toBe(true)
					})
				},
			),
			{ numRuns: 100 },
		)
	})
})
