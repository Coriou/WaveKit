import { Text } from "ink"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DecoderRow } from "./data/types.js"
import { renderApp } from "./test/app-harness.js"
import { scenarioState } from "./test/fixtures.js"
import { KEYS } from "./test/harness.js"
import { EMPTY_VIEW_CTX } from "./ui/actions.js"
import type { ViewModule } from "./views/types.js"

const stubDecoders: ViewModule = {
	id: "decoders",
	title: "Decoders",
	Component: () => <Text>stub decoders</Text>,
	keyInfo: () => ({
		rowIds: ["a"],
		pageSize: 1,
		ctx: { ...EMPTY_VIEW_CTX, hasSelection: true, decoderRunning: true },
	}),
	onAction: (a, _s, ui) =>
		a.type === "decoder-op"
			? {
					ui: {
						...ui,
						confirm: {
							kind: "decoder",
							prompt: "restart a",
							yes: "restart",
							no: "cancel",
							intent: { kind: "decoder", op: "restart", decoderId: "a" },
						},
					},
					effects: [],
				}
			: undefined,
}
const stubOverview: ViewModule = {
	id: "overview",
	title: "Overview",
	Component: () => <Text>stub overview</Text>,
	keyInfo: () => ({ rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }),
}
const stubMessages: ViewModule = {
	id: "messages",
	title: "Messages",
	Component: ({ ui }) => <Text>{`draft:${ui.messages.draft ?? "none"}`}</Text>,
	keyInfo: () => ({ rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }),
}
const stubSystem: ViewModule = {
	id: "system",
	title: "System",
	Component: () => <Text>stub system</Text>,
	keyInfo: () => ({
		rowIds: [],
		pageSize: 1,
		ctx: { ...EMPTY_VIEW_CTX, audioRunning: true },
	}),
}
const views = {
	overview: stubOverview,
	decoders: stubDecoders,
	messages: stubMessages,
	system: stubSystem,
}
const QUIET = { expectWrite: false } as const

describe("App shell", () => {
	it("frames chrome in rows−1 with the strip, switcher and footer", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "overview",
			cols: 120,
			rows: 40,
		})
		const f = h.frame()
		expect(f).toHaveLength(39)
		expect(f.at(-1)).toMatch(/\? help/)
		expect(f[0]).toMatch(/^ api ● 2s {2}iq ● streaming/)
		expect(f[1]).toBe(
			" 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System",
		)
		for (const l of f) expect([...l].length).toBeLessThanOrEqual(120)
		expect(h.text()).toContain("stub overview")
		h.unmount()
	})
	it("switches views, opens and closes help", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "overview",
			cols: 120,
			rows: 40,
		})
		await h.press("2")
		expect(h.text()).toContain("stub decoders")
		await h.press("?")
		expect(h.text()).toContain("keys · Decoders")
		await h.press("x")
		expect(h.text()).toContain("stub decoders")
		expect(h.frame().some(l => l.includes("▶"))).toBe(false)
		expect(h.runtime.sent).toEqual([])
		h.unmount()
	})
	it("shows a banner when the API is down", async () => {
		const h = await renderApp({
			state: scenarioState("api-down-cached"),
			views,
			view: "overview",
			cols: 80,
			rows: 24,
		})
		expect(h.frame()[1]).toMatch(/^ ! API unreachable · ECONNREFUSED/)
		h.unmount()
	})
	it("keeps a pending confirm across too-small resizes and writes only on y (review focus 2)", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "decoders",
			cols: 120,
			rows: 40,
		})
		await h.press("R")
		expect(h.frame().at(-1)).toContain("▶ restart a")
		await h.resize(50, 12)
		expect(h.frame()).toEqual(["wavekit: 50×12 too small (min 60×16)"])
		// A5 fix 1: nothing is visible, so y must not send the hidden confirm.
		await h.press("y", QUIET)
		expect(h.runtime.sent).toEqual([])
		await h.resize(120, 40)
		expect(h.frame().at(-1)).toContain("▶ restart a")
		expect(h.runtime.sent).toEqual([])
		await h.press("y")
		expect(h.runtime.sent).toEqual([
			{ kind: "decoder", op: "restart", decoderId: "a" },
		])
		expect(h.frame().at(-1)).not.toContain("▶")
		h.unmount()
	})
	it("cancels confirms with Esc and reconnects on r", async () => {
		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "decoders",
			cols: 120,
			rows: 40,
		})
		await h.press("R")
		await h.press(KEYS.esc)
		expect(h.frame().at(-1)).not.toContain("▶")
		await h.press("r")
		expect(h.runtime.reconnects).toBe(1)
		expect(h.runtime.sent).toEqual([])
		h.unmount()
	})
	it("drops every key but quit while too small: no blind audio write, draft unchanged (review focus 2)", async () => {
		const sys = await renderApp({
			state: scenarioState("live"),
			views,
			view: "system",
			cols: 50,
			rows: 12,
		})
		await sys.press("a", QUIET)
		expect(sys.runtime.sent).toEqual([])
		await sys.resize(120, 40)
		// The write changes no frame, so do not wait for one.
		await sys.press("a", QUIET)
		expect(sys.runtime.sent).toEqual([{ kind: "audio", op: "stop" }])
		sys.unmount()

		const h = await renderApp({
			state: scenarioState("live"),
			views,
			view: "messages",
			cols: 120,
			rows: 40,
		})
		await h.press("/")
		await h.press("a")
		await h.press("b")
		expect(h.text()).toContain("draft:ab")
		await h.resize(60, 15)
		await h.press("c", QUIET)
		await h.press(KEYS.esc, QUIET)
		await h.resize(120, 40)
		expect(h.text()).toContain("draft:ab")
		expect(h.runtime.sent).toEqual([])
		h.unmount()
	})
	it("renders the banner directly under the strip in roomy layouts (§5.1)", async () => {
		const h = await renderApp({
			state: scenarioState("api-down-cached"),
			views,
			view: "overview",
			cols: 120,
			rows: 40,
		})
		const f = h.frame()
		expect(f[1]).toMatch(/^ ! API unreachable/)
		expect(f[2]).toBe(
			" 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System",
		)
		h.unmount()
	})
})

describe("App error boundary (spec §6.6)", () => {
	let spy: ReturnType<typeof vi.spyOn>
	beforeEach(() => {
		spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
	})
	afterEach(() => {
		spy.mockRestore()
	})
	it("wraps the whole frame: a throw in the strip shows the fallback and keys stay live", async () => {
		const live = scenarioState("live")
		const broken = {
			...live,
			decoders: { ...live.decoders, value: [null as unknown as DecoderRow] },
		}
		const h = await renderApp({
			state: broken,
			views,
			view: "overview",
			cols: 120,
			rows: 40,
		})
		expect(h.frame()[0]).toMatch(/^ wavekit: render error · .+ · q quit$/)
		await h.press("r")
		expect(h.runtime.reconnects).toBe(1)
		await h.press("q", QUIET)
		await h.waitFor(() => h.exited())
		h.unmount()
	})
})
