import { describe, expect, it } from "vitest"

import {
	CARD_PLACE_KEY,
	CardPlaceStore,
	loadCardAnchor,
} from "../../src/shell/card-place.ts"
import type { KeyValueStorage } from "../../src/shell/theme.ts"

const memory = (init: Record<string, string> = {}) => {
	const m = new Map(Object.entries(init))
	const s: KeyValueStorage = {
		getItem: k => m.get(k) ?? null,
		setItem: (k, v) => void m.set(k, v),
	}
	return { s, m }
}
const throwing: KeyValueStorage = {
	getItem: () => {
		throw new Error("blocked")
	},
	setItem: () => {
		throw new Error("blocked")
	},
}

const frame = {
	anchors: [
		{ id: "al" as const, name: "above Listen", x: 16, y: 504 },
		{ id: "tr" as const, name: "top right", x: 1104, y: 88 },
	],
	card: { x: 16, y: 504 },
	freeW: 1440,
	H: 900,
	cardH: 300,
}

describe("CardPlaceStore", () => {
	it("defaults to above Listen and reads the remembered anchor (bl alias too)", () => {
		expect(new CardPlaceStore().get().at).toBe("al")
		expect(loadCardAnchor(memory({ [CARD_PLACE_KEY]: "tr" }).s)).toBe("tr")
		expect(loadCardAnchor(memory({ [CARD_PLACE_KEY]: "bl" }).s)).toBe("al")
		expect(loadCardAnchor(memory({ [CARD_PLACE_KEY]: "junk" }).s)).toBe("al")
		expect(loadCardAnchor(throwing)).toBe("al")
		expect(() => new CardPlaceStore(throwing).setAt("tr")).not.toThrow()
	})

	it("drags clamped into the free area and snaps to the nearest anchor, remembered", () => {
		const { s, m } = memory()
		const p = new CardPlaceStore(s)
		p.frame = frame
		expect(p.startDrag(100, 600)).toBe(true)
		expect(p.get().drag).toEqual({ x: 16, y: 504 })
		p.moveDrag(5000, -5000)
		expect(p.get().drag).toEqual({ x: 1440 - 320, y: 0 })
		const a = p.endDrag()
		expect(a?.id).toBe("tr")
		expect(p.get()).toMatchObject({
			at: "tr",
			drag: null,
			announce: { text: "Card moved to top right", n: 1 },
		})
		expect(m.get(CARD_PLACE_KEY)).toBe("tr")
	})

	it("cancel puts the card back without moving it", () => {
		const p = new CardPlaceStore()
		p.frame = frame
		p.startDrag(0, 0)
		p.moveDrag(900, -400)
		p.cancelDrag()
		expect(p.get()).toMatchObject({ at: "al", drag: null })
		expect(p.dragging).toBe(false)
	})

	it("does not start while the card is hidden", () => {
		const p = new CardPlaceStore()
		p.frame = { ...frame, card: null }
		expect(p.startDrag(0, 0)).toBe(false)
		expect(p.get().drag).toBeNull()
	})
})
