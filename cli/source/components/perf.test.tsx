import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { sp } from "../ui/line.js"
import { styleRuns } from "./lines.js"

describe("D3 performance guards", () => {
	it("cli.tsx sets NODE_ENV before anything can load React or Ink", () => {
		const src = readFileSync(new URL("../cli.tsx", import.meta.url), "utf8")
		// No static import: those would load (and pick React's build) before any statement runs.
		expect(src).not.toMatch(/^import\s/m)
		const env = src.indexOf('process.env["NODE_ENV"] ??= "production"')
		const load = src.indexOf('import("./main.js")')
		expect(env).toBeGreaterThan(-1)
		expect(load).toBeGreaterThan(env)
	})

	it("adjacent spans with one resolved style render as one run; unstyled runs are bare strings", () => {
		const line = [
			sp("api ", "label"),
			sp("● ", "label"),
			sp("2s", "value"),
			sp("  ", "value"),
			sp("iq ", "label"),
		]
		expect(styleRuns(line, false)).toEqual([
			{ text: "api ● ", props: { dimColor: true }, plain: false },
			{ text: "2s  ", props: {}, plain: true },
			{ text: "iq ", props: { dimColor: true }, plain: false },
		])
		// With colour, live and value differ, so they stay apart.
		expect(
			styleRuns([sp("●", "live"), sp(" up", "value")], true).map(r => r.text),
		).toEqual(["●", " up"])
	})
})
