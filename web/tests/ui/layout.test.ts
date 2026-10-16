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
		})
		expect(L.rxRight).toBe(G + 420 + G)
		expect(L.dockX + 460).toBeLessThanOrEqual(1440 - 420 - G - G)
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
})
