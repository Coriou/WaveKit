import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

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
		// docked with no slot yet: the layer, where it waits out of sight
		expect(guestTarget(true, null, layer)).toBe(layer)
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
