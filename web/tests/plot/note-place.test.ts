import { describe, expect, it } from "vitest"

import {
	NOTE_GAP,
	NOTE_SIDE,
	NOTE_STEP,
	placeNote,
} from "../../src/plot/note-place.ts"
import { computeLayout, DEFAULT_SIZES } from "../../src/shell/layout/compute.ts"

const NOTE = { w: 420, h: 32 }
const BODY = { w: 1440, h: 816 }

describe("plot status notes keep off the chrome", () => {
	it("stands centred on the note row when it is free", () => {
		// 40 % of 816 = 326.4, less half the note
		expect(placeNote(NOTE, BODY, 720, 1440, [])).toEqual({ x: 510, y: 310 })
	})

	it("a card parked on top centre over the note row: the nearest free spot along the row", () => {
		const card = { x: 550, y: 4, w: 340, h: 440 }
		const at = placeNote(NOTE, BODY, 720, 1440, [card])
		expect(at).not.toBeNull()
		// it keeps a gap from the card, on the same row, and moved by whole steps
		expect(at?.y).toBe(310)
		const right = at!.x >= card.x + card.w + NOTE_GAP
		const left = at!.x + NOTE.w + NOTE_GAP <= card.x
		expect(right || left).toBe(true)
		expect(Math.abs(at!.x - 510) % NOTE_STEP).toBe(0)
	})

	it("the shell's real layout: a top-centre card at 1440 x 900 never covers the note", () => {
		const L = computeLayout({
			viewport: { w: 1440, h: 900 },
			tuner: { w: 440, h: 56 },
			receiver: { w: 300, h: 56 },
			listen: { w: 340, h: 64 },
			dock: DEFAULT_SIZES.dock,
			player: null,
			card: {
				expanded: { w: 340, h: 440 },
				line: { w: 340, h: 52 },
				minimised: false,
				anchor: "tc",
			},
			status: [],
			drawer: null,
			panels: [],
		})
		expect(L.card?.anchor).toBe("tc")
		const p = L.plot
		const at = placeNote(NOTE, p.visible, p.noteCx, p.visible.w, p.exclusions)
		expect(at).not.toBeNull()
		for (const e of p.exclusions) {
			const n = { x: at!.x, y: at!.y, ...NOTE }
			const clear =
				n.x + n.w <= e.x ||
				e.x + e.w <= n.x ||
				n.y + n.h <= e.y ||
				e.y + e.h <= n.y
			expect(clear).toBe(true)
		}
	})

	it("keeps 16 px from the visible plot's sides: at the bound it fits, one wider it has no spot", () => {
		const w = 1440 - 2 * NOTE_SIDE
		expect(placeNote({ w, h: 32 }, BODY, 720, 1440, [])).toEqual({
			x: NOTE_SIDE,
			y: 310,
		})
		expect(placeNote({ w: w + 1, h: 32 }, BODY, 720, 1440, [])).toBeNull()
	})

	it("no free spot on any row (a sheet covers the plot): null, the note goes to the status slot", () => {
		const sheet = { x: 0, y: 0, w: 1440, h: 816 }
		expect(placeNote(NOTE, BODY, 720, 1440, [sheet])).toBeNull()
	})
})
