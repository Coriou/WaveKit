// The Activity header total never outlives its search: a new search, range or audio filter drops the core's
// counts until the new read answers, and a failed read drops them, so the header falls back to the loaded
// events with "+".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActivitySearchPage, ActivitySummary } from "@wavekit/api-types"

import { ApiClient } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import type { DataLayer } from "../../src/data/index.ts"
import { ActivityController } from "../../src/features/activity/controller.ts"
import { headerCount } from "../../src/features/activity/count.ts"
import { setActivityPaneOpen } from "../../src/features/activity/pane.ts"
import { token } from "../../src/features/activity/search.ts"
import { fakeSockets } from "../data/fake-socket.ts"

const item = (seq: number): ActivitySummary => ({
	eventId: `e${seq}`,
	commitSeq: String(seq),
	kind: "decoder-reception",
	producedAt: "2026-10-17T08:00:00.000Z",
	receivedAt: "2026-10-17T08:00:00.000Z",
	decoderId: "d",
	sourceId: "s",
	protocol: "dmr",
	category: "voice",
	frequencyHz: 446_006_250,
	entityKey: null,
	title: null,
	fields: [],
})

const page = (items: ActivitySummary[]): ActivitySearchPage => ({
	items,
	nextPageToken: "more",
	replayCursor: "c:9",
	snapshot: { lowBarrier: "0", highWater: "9", expiresAt: "x" },
	searchCoverage: "bounded-projection",
})

function setup() {
	const facets = { mode: "ok" as "ok" | "fail" | "hold", reads: 0 }
	let release: (() => void) | null = null
	const held: (() => void)[] = []
	const api = new ApiClient({
		fetch: async (url, init) => {
			if (String(url).includes("facets")) {
				facets.reads += 1
				if (facets.mode === "fail") return new Response("{}", { status: 503 })
				if (facets.mode === "hold")
					await new Promise<void>(r => {
						release = r
						held.push(r)
					})
				// a search for "fire" counts 5, any other 812
				const sent = typeof init?.body === "string" ? init.body : ""
				const count = sent.includes("fire") ? 5 : 812
				return new Response(
					JSON.stringify({
						facets: { category: [{ value: "voice", count }] },
					}),
					{ status: 200 },
				)
			}
			return new Response(JSON.stringify(page([item(5), item(4)])), {
				status: 200,
			})
		},
	})
	const sockets = fakeSockets()
	const events = new EventsClient({ createSocket: sockets.factory })
	events.connect()
	sockets.last().open()
	const c = new ActivityController({ api, events } as unknown as DataLayer)
	const header = () => {
		const s = c.get()
		return headerCount({
			counts: s.counts,
			total: s.total,
			chip: s.chip,
			column: false,
			events: 2,
			more: true,
		})
	}
	return { c, facets, header, held, release: () => release?.() }
}

describe("activity header count", () => {
	beforeEach(() => {
		const map = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => void map.set(k, v),
			removeItem: (k: string) => void map.delete(k),
			clear: () => map.clear(),
		})
		setActivityPaneOpen(false)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("drops the total when the search, range or audio filter changes, until the new read answers", async () => {
		const { c, facets, header, release } = setup()
		const off = c.attach()
		await vi.waitFor(() => expect(c.get().total).toBe(812))
		expect(header()).toMatchObject({ text: "812", core: true })

		facets.mode = "hold"
		c.addToken(token("text", "fire"))
		expect(c.get().total).toBeNull()
		expect(header()).toMatchObject({ text: "2+", core: false })
		await vi.waitFor(() => expect(facets.reads).toBe(2))
		facets.mode = "ok"
		release()
		await vi.waitFor(() => expect(c.get().total).toBe(5))
		c.clear()
		await vi.waitFor(() => expect(c.get().total).toBe(812))

		c.setAudio(true)
		expect(header().text).toBe("2+")
		await vi.waitFor(() => expect(c.get().total).toBe(812))

		c.setRange({ kind: "1h" })
		expect(header().text).toBe("2+")
		await vi.waitFor(() => expect(c.get().total).toBe(812))

		// a chip alone keeps the counts (they are read without it): its own count shows at once
		c.setChip("voice")
		expect(header()).toMatchObject({ text: "812", core: true })
		off()
		c.dispose()
	})

	it("never writes an old search's counts back when its read answers late", async () => {
		const { c, facets, held } = setup()
		const off = c.attach()
		await vi.waitFor(() => expect(c.get().total).toBe(812))
		facets.mode = "hold"
		c.addToken(token("text", "fire"))
		await vi.waitFor(() => expect(held).toHaveLength(1))
		// the search moves on before the "fire" read answers; it answers before the new read starts
		c.clear()
		held[0]?.()
		await new Promise(r => setTimeout(r, 0))
		await vi.waitFor(() => expect(held).toHaveLength(2))
		expect(c.get().total).toBeNull()
		facets.mode = "ok"
		held[1]?.()
		await vi.waitFor(() => expect(c.get().total).toBe(812))
		off()
		c.dispose()
	})

	it("keeps the total when the search is set to the same tokens", async () => {
		const { c } = setup()
		const off = c.attach()
		c.addToken(token("text", "fire"))
		await vi.waitFor(() => expect(c.get().total).toBe(5))
		c.setSearch([token("text", "fire")], null)
		expect(c.get().total).toBe(5)
		c.setSearch([token("text", "fire")], "voice")
		expect(c.get().total).toBe(5)
		off()
		c.dispose()
	})

	it("drops the total when a counts read fails", async () => {
		const { c, facets, header } = setup()
		const off = c.attach()
		await vi.waitFor(() => expect(c.get().total).toBe(812))
		facets.mode = "fail"
		c.addToken(token("text", "fire"))
		await vi.waitFor(() => expect(facets.reads).toBe(2))
		await vi.waitFor(() => expect(header()).toMatchObject({ text: "2+" }))
		expect(c.get().counts).toBeNull()
		off()
		c.dispose()
	})
})
