import { describe, expect, it } from "vitest"

import {
	DEFAULT_GEOMETRY,
	G,
	shellLayout,
	type ShellGeometry,
} from "../../src/shell/layout.ts"

const at = (
	W: number,
	H = 900,
	extra: Partial<ShellGeometry> = {},
): ShellGeometry => ({ ...DEFAULT_GEOMETRY, W, H, dockW: 460, ...extra })

describe("shellLayout", () => {
	it("1440 x 900, nothing open: Receiver on the top gutter, dock centred, card above Listen", () => {
		const L = shellLayout(at(1440), null)
		expect(L.drawer).toBeNull()
		expect(L.rxRight).toBe(G)
		expect(L.rxTop).toBe(G)
		expect(L.dockX).toBe((1440 - 460) / 2)
		expect(L.card).toEqual({ x: G, y: 900 - G - 64 - G - 300 })
	})

	it("from 1100 px a drawer is full height and the Receiver slides left to clear it", () => {
		const L = shellLayout(at(1440), "activity")
		expect(L.full).toBe(true)
		expect(L.drawer).toEqual({
			top: G,
			bottom: G,
			right: G,
			width: 420,
			full: true,
			resizable: true,
			maxW: 1440 - G - (G + 440 + G + 300 + G),
		})
		expect(L.rxRight).toBe(G + 420 + G)
		expect(L.dockX + 460).toBeLessThanOrEqual(1440 - 420 - G - G)
	})

	it("a resized drawer takes its wanted width; the Receiver and dock follow", () => {
		const L = shellLayout(at(1440), "activity", null, { drawerW: 520 })
		expect(L.drawer?.width).toBe(520)
		expect(L.rxRight).toBe(G + 520 + G)
		expect(L.freeW).toBe(1440 - 520 - G)
		expect(L.dockX + 460).toBeLessThanOrEqual(1440 - 520 - G - G)
	})

	it("a wanted width beyond the room left is capped where the Receiver would reach the Tuner", () => {
		const L = shellLayout(at(1280), "activity", null, { drawerW: 640 })
		const drMax = 1280 - G - (G + 440 + G + 300 + G)
		expect(L.drawer).toMatchObject({ width: drMax, maxW: drMax })
	})

	it("between the rows the drawer keeps its grip; spanning from the left gutter it has none", () => {
		// 1150 px: no room for 360 px beside the Receiver, so the drawer sits between the rows at its wanted width
		const mid = shellLayout(at(1150), "activity", null, { drawerW: 480 })
		expect(mid.full).toBe(false)
		expect(mid.drawer).toMatchObject({
			width: 480,
			resizable: true,
			maxW: 640,
		})
		const narrow = shellLayout(at(1000), "scanner", null, { drawerW: 480 })
		expect(narrow.drawer).toMatchObject({ width: null, resizable: false })
	})

	it("the drawer gives up width before the Receiver reaches the Tuner", () => {
		const L = shellLayout(at(1280), "settings")
		const drMax = 1280 - G - (G + 440 + G + 300 + G)
		expect(L.drawer?.width).toBe(drMax)
	})

	it("below 1100 px the drawer overlays between the island rows", () => {
		const L = shellLayout(at(1000), "scanner")
		expect(L.full).toBe(false)
		expect(L.drawer).toMatchObject({
			top: G + 56 + G,
			bottom: G + 64 + G,
			width: null,
		})
		expect(L.card).toBeNull()
	})

	it("narrow windows stack the Receiver under the Tuner and hide the dock", () => {
		const L = shellLayout(at(700), null)
		expect(L.rxTop).toBe(G + 56 + 8)
		expect(L.dockHidden).toBe(true)
	})

	describe("drawer + attached pane", () => {
		const want = { want: true, pushIn: true }

		it("attaches left of a full-height drawer, between the island rows, one px over its border", () => {
			const L = shellLayout(at(1440), "scanner", want)
			expect(L.full).toBe(true)
			expect(L.pushed).toBe(false)
			expect(L.pane).toEqual({
				top: G + 56 + G,
				bottom: G + 64 + G,
				left: G,
				right: G + 420 - 1,
				width: 1440 - G - (G + 420 - 1),
			})
			// the tuned card hides while the pane covers the plot
			expect(L.card).toBeNull()
		})

		it("attaches from about 1164 px with the default islands", () => {
			expect(shellLayout(at(1164), "scanner", want).pane).not.toBeNull()
			const narrow = shellLayout(at(1163), "scanner", want)
			expect(narrow.pane).toBeNull()
			expect(narrow.pushed).toBe(true)
		})

		it("needs more room while the Tuner is wider (a scan row): about 1196 px", () => {
			const scan = { tuner: { w: 472, h: 92 } }
			expect(shellLayout(at(1195, 900, scan), "scanner", want).pane).toBeNull()
			const L = shellLayout(at(1196, 900, scan), "scanner", want)
			expect(L.pane?.top).toBe(G + 92 + G)
		})

		it("without room the plan is pushed into a full-width drawer between the rows", () => {
			const L = shellLayout(at(1150), "scanner", want)
			expect(L.pushed).toBe(true)
			expect(L.pane).toBeNull()
			expect(L.drawer).toMatchObject({
				width: null,
				top: L.topRow,
				full: false,
			})
			expect(L.card).toBeNull()
		})

		it("a pane that does not push in shows nothing when there is no room", () => {
			const L = shellLayout(at(1000), "activity", { want: true, pushIn: false })
			expect(L.pane).toBeNull()
			expect(L.pushed).toBe(false)
		})

		it("a pane not wanted changes nothing", () => {
			const a = shellLayout(at(1440), "scanner", { want: false, pushIn: true })
			const b = shellLayout(at(1440), "scanner")
			expect(a).toEqual({ ...b })
			expect(a.pane).toBeNull()
		})
	})
})
