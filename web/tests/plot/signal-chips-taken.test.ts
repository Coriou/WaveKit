// A leaving chip fades where an older layout put it: it must still keep off the shell's chrome (the plot contract's
// exclusions, `taken`), as a placed chip does. Seen in a real browser at 390×844: a leaving chip placed before the
// status strip came stood under the strip, and stayed there while the label gate waited for the next frame.
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { chipRect, layoutChips } from "../../src/plot/signal-chips.ts"

type Rect = [number, number, number, number]
const hits = (a: Rect, b: Rect) =>
	a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

const chip = (x: number, top: number) => ({
	x,
	top,
	label: "433.920",
	sub: null,
})

describe("layoutChips and the shell's chrome", () => {
	it("drops a leaving chip under a taken rectangle", () => {
		// the status strip under a phone's top rail, in plot-body px
		const strip: Rect = [16, -4, 374, 100]
		const laid = layoutChips([], [chip(120, 43)], undefined, [strip])
		expect(laid.leaving).toEqual([])
	})

	it("keeps a leaving chip clear of the chrome", () => {
		const strip: Rect = [16, -4, 374, 100]
		const laid = layoutChips([], [chip(120, 140)], undefined, [strip])
		expect(laid.leaving).toHaveLength(1)
	})

	it("no leaving chip drawn ever meets a taken rectangle", () => {
		const r = fc.tuple(
			fc.integer({ min: 0, max: 1400 }),
			fc.integer({ min: -20, max: 600 }),
			fc.integer({ min: 1, max: 400 }),
			fc.integer({ min: 1, max: 200 }),
		)
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.integer({ min: 0, max: 1400 }),
						fc.integer({ min: 0, max: 500 }),
					),
					{ maxLength: 12 },
				),
				fc.array(r, { maxLength: 6 }),
				(leaving, boxes) => {
					const taken: Rect[] = boxes.map(([x, y, w, h]) => [
						x,
						y,
						x + w,
						y + h,
					])
					const laid = layoutChips(
						[],
						leaving.map(([x, top]) => chip(x, top)),
						undefined,
						taken,
					)
					for (const l of laid.leaving)
						for (const t of taken) expect(hits(chipRect(l), t)).toBe(false)
				},
			),
			{ numRuns: 150 },
		)
	})
})
