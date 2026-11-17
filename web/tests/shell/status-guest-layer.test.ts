import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { guestPlacement } from "../../src/shell/layout/StatusGuest.tsx"
import { guestTarget } from "../../src/shell/layout/stores.ts"

const src = (path: string) =>
	readFileSync(
		fileURLToPath(new URL(`../../src/${path}`, import.meta.url)),
		"utf8",
	)

// stand-ins for the shell's guest layer and a drawer's notice slot (only their identity matters)
const layer = { id: "layer" } as unknown as HTMLElement
const slot = { id: "slot" } as unknown as HTMLElement

describe("status guests render inside the shell, under its panels and the palette", () => {
	it("goes to the drawer's notice slot while docked, else the shell's guest layer", () => {
		expect(guestTarget(false, null, layer)).toBe(layer)
		expect(guestTarget(false, slot, layer)).toBe(layer)
		expect(guestTarget(true, slot, layer)).toBe(slot)
		// docked with no slot yet: the layer, where guestPlacement marks it pending (out of sight, not at 0,0)
		expect(guestTarget(true, null, layer)).toBe(layer)
	})

	it("a guest is pending (out of sight) unless it is placed or in the drawer's slot", () => {
		const at = { x: 600, y: 22, w: 200, h: 44 }
		// docked before the slot mounts: pending, no rectangle
		const early = guestPlacement("connection", true, null, null, false)
		expect(early["data-pending"]).toBe("")
		expect(early["data-wk-rect"]).toBeUndefined()
		// docked in the slot: laid out by the slot, shown
		const inSlot = guestPlacement("connection", true, slot, null, false)
		expect(inSlot["data-pending"]).toBeUndefined()
		expect(inSlot.style).toBeUndefined()
		// placed: at its rectangle; held while the card glides through it
		const placed = guestPlacement("connection", false, null, at, false)
		expect(placed["data-wk-rect"]).toBe("600,22,200,44")
		expect(placed["data-pending"]).toBeUndefined()
		expect(placed.style).toMatchObject({ left: 600, top: 22 })
		expect(
			guestPlacement("connection", false, null, at, true)["data-held"],
		).toBe("")
		// waiting (not placed, not docked): pending
		expect(
			guestPlacement("connection", false, slot, null, false)["data-pending"],
		).toBe("")
	})

	it("stacks the guest layer under an open island panel and the palette's scrim", () => {
		const z = (css: string, sel: string) =>
			Number(
				/z-index:\s*(\d+)/.exec(
					new RegExp(
						`${sel.replace(/[.[\]]/g, m => `\\${m}`)} \\{([^}]*)\\}`,
					).exec(css)?.[1] ?? "",
				)?.[1] ?? NaN,
			)
		const slots = src("shell/layout/slots.css")
		const shellCss = src("styles/shell.css")
		const layerZ = z(slots, ".wk-status-layer")
		const scrimZ = z(shellCss, ".wk-shell-scrim")
		const shell = src("shell/Shell.tsx")
		const panelZ = Number(
			/zIndex: state\.panel === id \? (\d+) : \d+/.exec(shell)?.[1] ?? NaN,
		)
		expect(layerZ).toBe(3)
		expect(layerZ).toBeLessThan(panelZ)
		expect(layerZ).toBeLessThan(scrimZ)
		// the palette renders after the guest layer in the same stacking context
		expect(shell.indexOf("setGuestLayer}")).toBeLessThan(
			shell.indexOf("<Palette onClose"),
		)
	})

	it("shows nowhere while the layer is gone (no shell, or the palette open), even when docked", () => {
		expect(guestTarget(false, null, null)).toBeNull()
		expect(guestTarget(true, slot, null)).toBeNull()
	})

	it("never portals to the document body, and the shell drops the layer while the palette is open", () => {
		for (const file of [
			"shell/layout/StatusGuest.tsx",
			"features/connection/ConnectionChip.tsx",
		]) {
			const text = src(file)
			expect(text).not.toContain("document.body")
			expect(text).toContain("guestTarget(")
		}
		const shell = src("shell/Shell.tsx")
		expect(shell).toMatch(
			/\{!state\.palette && \(\s*<div\s+ref=\{setGuestLayer\}\s+className="wk-status-layer"/,
		)
	})

	it("places a guest absolutely in the shell's stacking context, not fixed above it", () => {
		const css = src("shell/layout/slots.css")
		const rule = /\.wk-status-guest \{([^}]*)\}/.exec(css)?.[1] ?? ""
		expect(rule).toContain("position: absolute")
		expect(rule).not.toContain("position: fixed")
		expect(rule).not.toContain("z-index")
	})
})
