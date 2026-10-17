import { describe, expect, it } from "vitest"

import {
	clampDrawerW,
	DRAWER_WIDTH_KEY,
	DrawerWidthStore,
	loadDrawerWidths,
	wantedDrawerW,
} from "../../src/shell/drawer-width.ts"
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

describe("drawer widths", () => {
	it("clamps to 360–640 px and to the room the layout has", () => {
		expect(clampDrawerW(100)).toBe(360)
		expect(clampDrawerW(900)).toBe(640)
		expect(clampDrawerW(500.6)).toBe(501)
		expect(clampDrawerW(600, 520)).toBe(520)
		// no room for the minimum: the minimum still wins
		expect(clampDrawerW(600, 200)).toBe(360)
	})

	it("defaults per drawer until resized", () => {
		expect(wantedDrawerW({}, "activity")).toBe(420)
		expect(wantedDrawerW({}, "settings")).toBe(560)
		expect(wantedDrawerW({ activity: 500 }, "activity")).toBe(500)
	})

	it("remembers each drawer's width and forgets it on reset", () => {
		const { s, m } = memory()
		const store = new DrawerWidthStore(s)
		store.setWidth("activity", 512)
		store.setWidth("scanner", 2000)
		expect(store.get()).toEqual({ activity: 512, scanner: 640 })
		expect(JSON.parse(m.get(DRAWER_WIDTH_KEY) ?? "{}")).toEqual({
			activity: 512,
			scanner: 640,
		})
		expect(new DrawerWidthStore(s).get()).toEqual({
			activity: 512,
			scanner: 640,
		})
		store.reset("activity")
		expect(store.get()).toEqual({ scanner: 640 })
		expect(loadDrawerWidths(s)).toEqual({ scanner: 640 })
	})

	it("ignores junk and unknown drawers in storage, and survives blocked storage", () => {
		const { s } = memory({
			[DRAWER_WIDTH_KEY]: JSON.stringify({
				activity: "wide",
				recordings: 9999,
				palette: 500,
			}),
		})
		expect(loadDrawerWidths(s)).toEqual({ recordings: 640 })
		expect(loadDrawerWidths(memory({ [DRAWER_WIDTH_KEY]: "{" }).s)).toEqual({})
		const store = new DrawerWidthStore(throwing)
		store.setWidth("settings", 600)
		expect(store.get()).toEqual({ settings: 600 })
	})

	it("does not notify when the width does not change", () => {
		const store = new DrawerWidthStore(null)
		let n = 0
		store.subscribe(() => n++)
		store.setWidth("activity", 500)
		store.setWidth("activity", 500.2)
		store.reset("scanner")
		expect(n).toBe(1)
	})
})
