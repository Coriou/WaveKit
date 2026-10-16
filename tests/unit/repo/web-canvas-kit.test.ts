/**
 * Drift check between the UI kit source and the design canvas.
 *
 * `packages/brand/tokens/ui.css` is the one source of the WaveKit UI kit; the canvas Kit
 * board carries it verbatim (synced by scripts/web-canvas-kit.mjs) and every board imports
 * the Kit board. This fails when either side moved without the other: a canvas edit that
 * skipped the brand file, or a brand edit never synced to the canvas.
 */
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

const BEGIN = "/* wk-ui begin */\n"
const END = "/* wk-ui end */"

describe("design canvas Kit board", () => {
	it("carries packages/brand/tokens/ui.css verbatim", () => {
		const board = read("docs/web/canvas/Kit.dc.html")
		const start = board.indexOf(BEGIN)
		const end = board.indexOf(END, start)
		expect(start, "wk-ui begin marker").toBeGreaterThanOrEqual(0)
		expect(end, "wk-ui end marker").toBeGreaterThan(start)
		const section = board.slice(start + BEGIN.length, end)
		const kit = read("packages/brand/tokens/ui.css")
		// Run `node scripts/web-canvas-kit.mjs docs/web/canvas/Kit.dc.html` and republish the
		// Kit board when this fails after a ui.css change.
		expect(section === kit, "Kit board and ui.css differ").toBe(true)
	})
})
