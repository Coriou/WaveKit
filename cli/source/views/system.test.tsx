import { describe, expect, it } from "vitest"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { systemView } from "./system.js"

const views = { system: systemView }

describe("System view (spec §6.5)", () => {
	it("golden: 120x40", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "system",
			cols: 120,
			rows: 40,
		})
		expect(h.frame().at(-1)).toContain("a start audio  P preset")
		expect(h.frame().length).toBeLessThanOrEqual(39)
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})
	it("golden: 80x24", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "system",
			cols: 80,
			rows: 24,
		})
		expect(h.frame().length).toBeLessThanOrEqual(23)
		for (const l of h.frame()) expect([...l].length).toBeLessThanOrEqual(80)
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})
	it("starts audio without a confirm (T9)", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "system",
			cols: 120,
			rows: 40,
		})
		await h.press("a", { expectWrite: false })
		expect(h.runtime.sent).toEqual([{ kind: "audio", op: "start" }])
		h.unmount()
	})
	it("confirms presets, cycles with P and sends the modulation with the preset", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "system",
			cols: 120,
			rows: 40,
		})
		await h.press("P")
		expect(h.frame().at(-1)).toBe(
			' ▶ apply audio preset "wfm" (wfm 150 kHz)?   y apply  n cancel  P next',
		)
		await h.press("P")
		expect(h.frame().at(-1)).toContain('apply audio preset "am" (am 10 kHz)?')
		expect(h.runtime.sent).toEqual([])
		await h.press("y")
		expect(h.runtime.sent).toEqual([
			{
				kind: "preset",
				name: "am",
				patch: { modulation: "am", bandwidth: 10000, deEmphasis: false },
			},
		])
		h.unmount()
	})
})
