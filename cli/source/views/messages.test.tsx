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

	it("copies JSON with OSC 52 and walks the Esc chain", async () => {
		const writeRaw = vi.fn()
		const h = await renderApp({
			state: scenarioState("live", deps),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
			writeRaw,
		})
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		await h.press("y")
		expect(String(writeRaw.mock.calls[0]?.[0])).toMatch(/^\u001b\]52;c;/)
		expect(h.frame().at(-1)).toContain("copy sent (OSC 52)")
		const detailHead = /^ \S+ · \S+ · \d\d:\d\d:\d\d\.\d{3}\s*$/m
		expect(h.text()).toMatch(detailHead)
		// Esc: detail, then selection, then (with a filter) the filter.
		await h.press(KEYS.esc)
		expect(h.text()).not.toMatch(detailHead)
		expect(h.text()).toContain("paused")
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
