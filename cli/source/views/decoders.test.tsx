import { describe, expect, it } from "vitest"
import { reduce } from "../data/reducers.js"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { KEYS } from "../test/harness.js"
import { formatMessage } from "../ui/messages/index.js"
import { decodersView } from "./decoders.js"

const deps = { summarize: formatMessage }
const views = { decoders: decodersView }
type Handle = Awaited<ReturnType<typeof renderApp>>
/** Rows are dsd-fme, multimon-ng, rtl433, readsb, acarsdec, …; the first ↓ selects the first row. */
const selectRow = async (h: Handle, n: number): Promise<void> => {
	for (let i = 0; i < n; i++) await h.press(KEYS.down)
}

describe("Decoders view (spec §6.2)", () => {
	it("golden: 120x40 with readsb detail as a bottom pane", async () => {
		const h = await renderApp({
			state: scenarioState("live", deps),
			views,
			view: "decoders",
			cols: 120,
			rows: 40,
		})
		await selectRow(h, 4)
		await h.press(KEYS.enter)
		expect(h.frame().length).toBeLessThanOrEqual(39)
		expect(h.text()).toContain("readsb    ADS-B · network producer")
		expect(h.frame().at(-1)).toContain("x stop")
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})

	it("golden: crash-loop 120x40", async () => {
		const h = await renderApp({
			state: scenarioState("crash-loop", deps),
			views,
			view: "decoders",
			cols: 120,
			rows: 40,
		})
		expect(h.text()).toMatch(/× acarsdec +crash-loop\b/)
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})

	it("golden: 200x50 with the detail as a right pane", async () => {
		const h = await renderApp({
			state: scenarioState("live", deps),
			views,
			view: "decoders",
			cols: 200,
			rows: 50,
		})
		await selectRow(h, 4)
		await h.press(KEYS.enter)
		for (const line of h.frame()) expect(line.length).toBeLessThanOrEqual(200)
		expect(h.frame().length).toBeLessThanOrEqual(49)
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})

	it("confirms before restarting and sends only on y", async () => {
		const h = await renderApp({
			state: scenarioState("live", deps),
			views,
			view: "decoders",
			cols: 120,
			rows: 40,
		})
		await selectRow(h, 4)
		await h.press("R")
		expect(h.frame().at(-1)).toBe(
			" ▶ restart readsb · up 51s · out of window · dropping 38%   y restart  n cancel",
		)
		await h.press("n")
		expect(h.runtime.sent).toEqual([])
		await h.press("R")
		await h.press(KEYS.enter, { expectWrite: false })
		expect(h.runtime.sent).toEqual([])
		await h.press("y")
		expect(h.runtime.sent).toEqual([
			{ kind: "decoder", op: "restart", decoderId: "readsb" },
		])
		h.unmount()
	})

	it("offers s only for a decoder that is not running", async () => {
		const h = await renderApp({
			state: scenarioState("live", deps),
			views,
			view: "decoders",
			cols: 120,
			rows: 40,
		})
		await selectRow(h, 5)
		expect(h.frame().at(-1)).not.toContain("x stop")
		await h.press("x", { expectWrite: false })
		expect(h.frame().at(-1)).not.toContain("▶")
		await h.press("s")
		expect(h.frame().at(-1)).toContain("▶ start acarsdec")
		// R100: this core reports no start mode, so the confirm claims no pin.
		expect(h.frame().at(-1)).not.toContain("pinned")
		h.unmount()
	})

	describe("R100 band defaults and the operator pin", () => {
		/** band-defaults rows: dsd-fme, multimon-ng, rtl433, readsb, acarsdec, ais-catcher, dumpvdl2, direwolf, lora-meshtastic. */
		const open = () =>
			renderApp({
				state: scenarioState("band-defaults", deps),
				views,
				view: "decoders",
				cols: 120,
				rows: 40,
			})
		it("says a start pins when this core reports start modes", async () => {
			const h = await open()
			await selectRow(h, 7)
			expect(h.frame().at(-1)).toContain("s start")
			await h.press("s")
			expect(h.frame().at(-1)).toMatch(
				/^ ▶ start dumpvdl2 · pinned against band suspension · .* {3}y start {2}n cancel$/,
			)
			await h.press("y")
			expect(h.runtime.sent).toEqual([
				{ kind: "decoder", op: "start", decoderId: "dumpvdl2" },
			])
			h.unmount()
		})
		it("runs a band-suspended decoder anyway, and never offers a start on a rate suspension", async () => {
			const h = await open()
			await selectRow(h, 4)
			expect(h.frame().at(-1)).toContain("s run anyway")
			await h.press("s")
			expect(h.frame().at(-1)).toBe(
				" ▶ run readsb out of band · pinned · out of window   y run  n cancel",
			)
			await h.press("y")
			expect(h.runtime.sent).toEqual([
				{ kind: "decoder", op: "start", decoderId: "readsb" },
			])
			await selectRow(h, 2)
			expect(h.frame().at(-1)).not.toMatch(/\bs (start|run anyway)/)
			await h.press("s", { expectWrite: false })
			expect(h.frame().at(-1)).not.toContain("▶")
			h.unmount()
		})
		it("returns a pinned decoder to auto with u", async () => {
			const h = await open()
			await selectRow(h, 3)
			expect(h.frame().at(-1)).toContain("u return to auto")
			await h.press("u")
			expect(h.frame().at(-1)).toMatch(
				/^ ▶ return rtl433 to auto · may suspend out of band · .* {3}y return {2}n cancel$/,
			)
			await h.press("n")
			expect(h.runtime.sent).toEqual([])
			await h.press("u")
			await h.press("y")
			expect(h.runtime.sent).toEqual([
				{ kind: "decoder", op: "unpin", decoderId: "rtl433" },
			])
			h.unmount()
		})
	})

	it("fits 60x16 and 80x24 without wrapping", async () => {
		for (const [cols, rows] of [
			[60, 16],
			[80, 24],
		] as const) {
			const h = await renderApp({
				state: scenarioState("live", deps),
				views,
				view: "decoders",
				cols,
				rows,
			})
			expect(h.frame().length).toBeLessThanOrEqual(rows - 1)
			for (const line of h.frame())
				expect(line.length).toBeLessThanOrEqual(cols)
			h.unmount()
		}
	})

	it("R64/R75: a write from the list shows its result in the footer, failures included", async () => {
		const h = await renderApp({
			state: scenarioState("live", deps),
			views,
			view: "decoders",
			cols: 120,
			rows: 40,
		})
		await selectRow(h, 4)
		await h.press("R")
		await h.press("y")
		expect(h.runtime.sent).toEqual([
			{ kind: "decoder", op: "restart", decoderId: "readsb" },
		])
		const st = h.runtime.store.get()
		const intent = {
			kind: "decoder",
			op: "restart",
			decoderId: "readsb",
		} as const
		h.runtime.store.set(
			reduce(
				st,
				[
					{
						kind: "action:sent",
						at: st.now,
						id: 1,
						key: "decoder:readsb",
						intent,
					},
				],
				st.now,
			),
		)
		// R75: the result is the footer (the last frame row), not a list row.
		await h.waitFor(f => (f.at(-1) ?? "").includes("readsb · restart sent"))
		const sent = h.runtime.store.get()
		h.runtime.store.set(
			reduce(
				sent,
				[
					{
						kind: "action:result",
						at: sent.now + 10,
						id: 1,
						key: "decoder:readsb",
						outcomes: [
							{
								label: "restart",
								result: {
									ok: false,
									outcome: "failed",
									status: 502,
									message: "bad gateway",
								},
								at: sent.now + 10,
							},
						],
					},
				],
				sent.now + 10,
			),
		)
		await h.waitFor(f =>
			(f.at(-1) ?? "").includes(
				'readsb · restart failed · 502 · "bad gateway"',
			),
		)
		// With the detail open the result sits in the detail, and the footer shows keys.
		await h.press(KEYS.enter)
		expect(h.frame().at(-1)).not.toContain("restart failed")
		expect(h.text()).toContain('action    restart failed · 502 · "bad gateway"')
		h.unmount()
	})

	it("PgUp answers at once after scrolling past the end of the detail (final review)", async () => {
		const live = scenarioState("live", deps)
		// A long core error wraps over several rows, so the 60x16 detail scrolls.
		const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")
		const state = {
			...live,
			decoders: {
				...live.decoders,
				value: (live.decoders.value ?? []).map(d =>
					d.id === "readsb"
						? {
								...d,
								lastError: {
									kind: "exit" as const,
									message: words,
									at: new Date(live.now - 5000).toISOString(),
								},
							}
						: d,
				),
			},
		}
		const h = await renderApp({
			state,
			views,
			view: "decoders",
			cols: 60,
			rows: 16,
		})
		await selectRow(h, 4)
		await h.press(KEYS.enter)
		expect(h.text()).toMatch(/rows · PgDn/)
		for (let i = 0; i < 20; i++)
			await h.press(KEYS.pgdn, { expectWrite: false })
		const bottom = h.text()
		expect(bottom).not.toMatch(/rows · PgDn/)
		await h.press(KEYS.pgup)
		expect(h.text()).not.toBe(bottom)
		h.unmount()
	})
})
