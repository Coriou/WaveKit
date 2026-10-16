import { describe, expect, it, vi } from "vitest"

import { ShellStore } from "../../src/shell/store.ts"

describe("ShellStore", () => {
	it("starts on the spectrum with nothing open", () => {
		expect(new ShellStore().getState()).toEqual({
			panel: null,
			drawer: null,
			view: "spectrum",
			palette: false,
		})
	})

	it("keeps one island panel open at a time", () => {
		const s = new ShellStore()
		s.openPanel("tuner")
		s.togglePanel("receiver")
		expect(s.getState().panel).toBe("receiver")
		s.togglePanel("receiver")
		expect(s.getState().panel).toBeNull()
	})

	it("opening a drawer closes the panel and the palette; the dock toggles it", () => {
		const s = new ShellStore()
		s.openPanel("listen")
		s.openPalette()
		s.toggleDrawer("activity")
		expect(s.getState()).toMatchObject({
			panel: null,
			drawer: "activity",
			palette: false,
		})
		s.toggleDrawer("scanner")
		expect(s.getState().drawer).toBe("scanner")
		s.toggleDrawer("scanner")
		expect(s.getState().drawer).toBeNull()
	})

	it("an island panel can open beside an open drawer", () => {
		const s = new ShellStore()
		s.openDrawer("settings")
		s.openPanel("tuner")
		expect(s.getState()).toMatchObject({ panel: "tuner", drawer: "settings" })
	})

	it("changing the view keeps the drawer", () => {
		const s = new ShellStore()
		s.openDrawer("recordings")
		s.setView("map")
		expect(s.getState()).toMatchObject({ view: "map", drawer: "recordings" })
	})

	it("Escape closes the palette, then the panel, then the drawer, and says what closed", () => {
		const s = new ShellStore()
		s.openDrawer("activity")
		s.openPanel("receiver")
		s.openPalette()
		expect(s.escape()).toEqual({ kind: "palette" })
		expect(s.escape()).toEqual({ kind: "panel", id: "receiver" })
		expect(s.escape()).toEqual({ kind: "drawer", id: "activity" })
		expect(s.escape()).toBeNull()
		expect(s.getState()).toMatchObject({
			panel: null,
			drawer: null,
			palette: false,
		})
	})

	it("notifies only on real changes and keeps the snapshot stable otherwise", () => {
		const s = new ShellStore()
		const l = vi.fn()
		const off = s.subscribe(l)
		const before = s.getState()
		s.closePanel()
		s.setView("spectrum")
		expect(l).not.toHaveBeenCalled()
		expect(s.getState()).toBe(before)
		s.openPanel("tuner")
		expect(l).toHaveBeenCalledTimes(1)
		expect(s.getState()).not.toBe(before)
		off()
		s.closePanel()
		expect(l).toHaveBeenCalledTimes(1)
	})
})
