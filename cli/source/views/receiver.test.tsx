import { describe, expect, it } from "vitest"
import { laneOk } from "../data/freshness.js"
import type { AppState } from "../data/types.js"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { KEYS } from "../test/harness.js"
import { receiverView } from "./receiver.js"

const views = { receiver: receiverView }
function internal(s: AppState): AppState {
	const t = s.tuner.value![0]!
	return {
		...s,
		tuner: laneOk([{ ...t, controlMode: "internal" }], s.now - 1000, "rest"),
	}
}

describe("Receiver view (spec §6.4)", () => {
	it("golden: 120x40 under external control", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "receiver",
			cols: 120,
			rows: 40,
		})
		expect(h.frame().at(-1)).toContain("c take control")
		expect(h.frame().length).toBeLessThanOrEqual(39)
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})
	it("golden: 80x24", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "receiver",
			cols: 80,
			rows: 24,
		})
		expect(h.frame().length).toBeLessThanOrEqual(23)
		for (const l of h.frame()) expect([...l].length).toBeLessThanOrEqual(80)
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})
	it("refuses to edit under external control and confirms take-over", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "receiver",
			cols: 120,
			rows: 40,
		})
		await h.press("e")
		expect(h.frame().at(-1)).toContain(
			"controlled externally · c to take control",
		)
		await h.press("c")
		expect(h.frame().at(-1)).toBe(
			" ▶ take tuner control from relay client-3 192.0.2.1? its next tuning command is refused   y take  n cancel",
		)
		expect(h.runtime.sent).toEqual([])
		await h.press("y")
		expect(h.runtime.sent).toEqual([
			{
				kind: "tuner",
				sourceId: "pi-iq",
				commands: [
					{
						setting: "control-mode",
						body: { mode: "internal" },
						label: "control",
					},
				],
			},
		])
		h.unmount()
	})
	it("sends nothing while editing; n goes back, Esc discards, y sends", async () => {
		const h = await renderApp({
			state: internal(scenarioState("live")),
			views,
			view: "receiver",
			cols: 120,
			rows: 40,
		})
		await h.press("e")
		expect(h.text()).toContain(
			"EDIT · wavekit control · nothing sent until confirmed",
		)
		await h.press(KEYS.up)
		await h.press(KEYS.enter)
		expect(h.frame().at(-1)).toContain(
			"▶ send 1 command to pi-iq: frequency 445 971 700 Hz (+1.0 kHz)",
		)
		await h.press("n")
		expect(h.text()).toContain("EDIT · wavekit control")
		await h.press(KEYS.esc)
		expect(h.text()).not.toContain("EDIT")
		expect(h.runtime.sent).toEqual([])
		await h.press("e")
		await h.press(KEYS.up)
		await h.press(KEYS.enter)
		await h.press("y")
		expect(h.runtime.sent).toEqual([
			{
				kind: "tuner",
				sourceId: "pi-iq",
				commands: [
					{ setting: "frequency", body: { hz: 445971700 }, label: "frequency" },
				],
			},
		])
		expect(h.text()).not.toContain("EDIT")
		h.unmount()
	})
	it("holds the review while the frequency is out of range (R42)", async () => {
		const h = await renderApp({
			state: internal(scenarioState("live")),
			views,
			view: "receiver",
			cols: 120,
			rows: 40,
		})
		await h.press("e")
		for (let i = 0; i < 6; i++) await h.press(KEYS.left, { expectWrite: false })
		await h.press(KEYS.up)
		await h.press(KEYS.up)
		await h.press(KEYS.enter)
		expect(h.text()).toContain("frequency outside 24–1 900 MHz")
		expect(h.text()).not.toContain("▶ send")
		expect(h.runtime.sent).toEqual([])
		h.unmount()
	})
	for (const [cols, rows] of [
		[80, 24],
		[120, 40],
	] as const) {
		it(`confirm bar keeps the action, the bias-t warning and who enters at ${cols}x${rows} (R71)`, async () => {
			const h = await renderApp({
				state: internal(scenarioState("live")),
				views,
				view: "receiver",
				cols,
				rows,
			})
			await h.press("e")
			for (let i = 0; i < 5; i++)
				await h.press(KEYS.left, { expectWrite: false })
			for (const d of "433920") await h.press(d)
			for (let i = 0; i < 6; i++)
				await h.press(KEYS.tab, { expectWrite: false })
			await h.press(KEYS.space)
			await h.press(KEYS.enter)
			const bar = h.frame().at(-1) ?? ""
			expect([...bar].length).toBeLessThanOrEqual(cols)
			expect(bar).toMatch(/send 2 (commands )?to pi-iq/)
			expect(bar).toMatch(
				/bias-t (DC on antenna|supplies DC on the antenna port)/,
			)
			expect(bar).toContain("rtl433 enters")
			expect(bar).toMatch(/y send {2}n back$/)
			if (cols >= 120)
				expect(bar).toContain("bias-t supplies DC on the antenna port")
			expect(h.runtime.sent).toEqual([])
			h.unmount()
		})
	}
})
