import { beforeAll, describe, expect, it, vi } from "vitest"
import { reduce } from "../data/reducers.js"
import type { Inbound } from "../data/types.js"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { KEYS } from "../test/harness.js"
import { formatMessage } from "../ui/messages/index.js"
import { messagesView } from "./messages.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const deps = { summarize: formatMessage }
const views = { messages: messagesView }
type Handle = Awaited<ReturnType<typeof renderApp>>
const typeText = async (h: Handle, text: string): Promise<void> => {
	for (const ch of text) await h.press(ch)
}

describe("Messages view (spec §6.3)", () => {
	it("golden: burst 120x40 following, then paused + filtered + detail open", async () => {
		const h = await renderApp({
			state: scenarioState("burst", deps),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
		})
		expect(h.text()).toMatchSnapshot("following")
		await h.press("p")
		await h.press("/")
		await typeText(h, "readsb,ais")
		await h.press(KEYS.enter)
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		expect(h.text()).toContain("MESSAGES  paused · 0 new · filter readsb,ais")
		expect(h.text()).toMatch(/readsb · aircraft · \d\d:\d\d:\d\d\.\d{3}/)
		expect(h.frame().length).toBeLessThanOrEqual(39)
		expect(h.text()).toMatchSnapshot("paused-filtered-detail")
		h.unmount()
	})

	it("types q and digits into the filter instead of quitting or switching views", async () => {
		const h = await renderApp({
			state: scenarioState("live", deps),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
		})
		await h.press("/")
		await typeText(h, "q1")
		expect(h.text()).toContain("/ q1▏")
		expect(h.frame().at(-1)).toContain("Enter apply  Esc cancel")
		expect(h.frame().at(-1)).toContain("!emerg = emergencies only")
		expect(h.exited()).toBe(false)
		await h.press(KEYS.esc)
		expect(h.text()).not.toContain("/ q1")
		expect(h.text()).not.toContain("filter q1")
		h.unmount()
	})

	it("counts new messages while paused and resumes with G", async () => {
		const state = scenarioState("live", deps)
		const h = await renderApp({
			state,
			views,
			view: "messages",
			cols: 120,
			rows: 40,
		})
		await h.press("p")
		const at = state.now + 500
		const items: Inbound[] = [0, 1].map(i => ({
			kind: "ws",
			at: at + i,
			event: {
				type: "decoder:output",
				decoderId: "dsd-fme",
				output: {
					type: "call_end",
					decoder: "dsd-fme",
					timestamp: new Date(at + i).toISOString(),
					data: { talkgroup: 9 + i },
				},
			},
		}))
		h.runtime.store.set(reduce(state, items, at + 2, deps))
		await h.waitFor(f => f.join("\n").includes("paused · 2 new"))
		await h.press("G")
		expect(h.text()).toMatch(/MESSAGES {2}\d+ in 60s · \d+ total/)
		expect(h.text()).not.toContain("paused")
		h.unmount()
	})

	it("copies the selected entry's JSON with OSC 52 (M9)", async () => {
		const writeRaw = vi.fn()
		const state = scenarioState("live", deps)
		const newest = state.messages.ring.entries.at(-1)!
		const h = await renderApp({
			state,
			views,
			view: "messages",
			cols: 120,
			rows: 40,
			writeRaw,
		})
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		await h.press("y")
		const raw = String(writeRaw.mock.calls[0]?.[0])
		const m = /^\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007$/.exec(raw)
		expect(m).not.toBeNull()
		expect(Buffer.from(m![1]!, "base64").toString("utf8")).toBe(
			JSON.stringify(newest.output.data, null, 2),
		)
		expect(h.frame().at(-1)).toContain("copy sent (OSC 52)")
		h.unmount()
	})

	it("does not send a copy over 100 KB and says so (R67 M1)", async () => {
		const writeRaw = vi.fn()
		const live = scenarioState("live", deps)
		const at = live.now
		const big: Inbound = {
			kind: "ws",
			at,
			event: {
				type: "decoder:output",
				decoderId: "multimon-ng",
				output: {
					type: "message",
					decoder: "multimon-ng",
					timestamp: new Date(at).toISOString(),
					data: { message: "x".repeat(150_000) },
				},
			},
		}
		const h = await renderApp({
			state: reduce(live, [big], at, deps),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
			writeRaw,
		})
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		await h.press("y")
		expect(writeRaw).not.toHaveBeenCalled()
		expect(h.frame().at(-1)).toMatch(/copy not sent · 150\.\d KB over 100 KB/)
		h.unmount()
	})

	it("PgUp answers at once after scrolling past the end of the detail (R73 M3)", async () => {
		const live = scenarioState("live", deps)
		const at = live.now
		const data = Object.fromEntries(
			Array.from({ length: 60 }, (_, i) => [`key${i}`, i]),
		)
		const tall: Inbound = {
			kind: "ws",
			at,
			event: {
				type: "decoder:output",
				decoderId: "rtl433",
				output: {
					type: "signal",
					decoder: "rtl433",
					timestamp: new Date(at).toISOString(),
					data,
				},
			},
		}
		const h = await renderApp({
			state: reduce(live, [tall], at, deps),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
		})
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		for (let i = 0; i < 20; i++)
			await h.press(KEYS.pgdn, { expectWrite: false })
		expect(h.text()).toContain('"key59": 59')
		const bottom = h.text()
		await h.press(KEYS.pgup)
		expect(h.text()).not.toBe(bottom)
		expect(h.text()).not.toContain('"key59": 59')
		h.unmount()
	})

	it("walks the whole Esc chain: detail, selection, filter (M9)", async () => {
		const h = await renderApp({
			state: scenarioState("live", deps),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
		})
		await h.press("/")
		await typeText(h, "dsd")
		await h.press(KEYS.enter)
		const head = (): string | undefined =>
			/(\S+ · \S+ · \d\d:\d\d:\d\d\.\d{3})/.exec(h.text())?.[1]
		// Select the second row and open it.
		await h.press(KEYS.down)
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		const second = head()
		expect(second).toBeDefined()
		await h.press(KEYS.esc)
		expect(head()).toBeUndefined()
		// Esc clears the selection: Enter now opens the first row, not the second.
		await h.press(KEYS.esc, { expectWrite: false })
		await h.press(KEYS.enter)
		const first = head()
		expect(first).toBeDefined()
		expect(first).not.toBe(second)
		await h.press(KEYS.esc)
		await h.press(KEYS.esc, { expectWrite: false })
		expect(h.text()).toContain("filter dsd")
		await h.press(KEYS.esc)
		expect(h.text()).not.toContain("filter dsd")
		h.unmount()
	})

	it("Esc clears an applied filter once nothing else is open", async () => {
		const h = await renderApp({
			state: scenarioState("burst", deps),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
		})
		await h.press("/")
		await typeText(h, "nothing-matches")
		await h.press(KEYS.enter)
		expect(h.text()).toMatch(/0 of \d+ match "nothing-matches"/)
		await h.press(KEYS.esc)
		expect(h.text()).not.toContain("nothing-matches")
		h.unmount()
	})

	it("keeps the selected message across resizes, by seq (spec §13.2)", async () => {
		const h = await renderApp({
			state: scenarioState("live", deps),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
		})
		await h.press(KEYS.down)
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		const header = (): string | undefined =>
			h
				.frame()
				.join("\n")
				// Not anchored: at ultra width the detail sits right of the list.
				.match(/(\S+ · \S+ · \d\d:\d\d:\d\d\.\d{3})/)?.[1]
		const before = header()
		expect(before).toBeDefined()
		await h.resize(60, 16)
		expect(header()).toBe(before)
		await h.resize(200, 50)
		expect(header()).toBe(before)
		h.unmount()
	})

	it("keeps hostile payloads inside the frame at 60x20 (review focus 4)", async () => {
		const h = await renderApp({
			state: scenarioState("long-text", deps),
			views,
			view: "messages",
			cols: 60,
			rows: 20,
		})
		for (const l of h.frame()) expect([...l].length).toBeLessThanOrEqual(60)
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		for (const l of h.frame()) expect([...l].length).toBeLessThanOrEqual(60)
		expect(h.writes().join("")).not.toMatch(/\u0007|\u009b|\u001b\]/)
		h.unmount()
	})
})
