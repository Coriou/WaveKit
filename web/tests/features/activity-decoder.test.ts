// Activity's decoder filter: one decoder's events (the core's `decoderIds`), set by the tuned card's "Last decode"
// and shown as a removable chip in the drawer's search like every other filter.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActivitySearchPage, DecoderInfo } from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import { ApiClient } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import type { DataLayer } from "../../src/data/index.ts"
import { ActivityController } from "../../src/features/activity/controller.ts"
import { setActivityPaneOpen } from "../../src/features/activity/pane.ts"
import { scopedQuery, ANY_TIME } from "../../src/features/activity/scope.ts"
import {
	buildQuery,
	decoderToken,
	frequencyToken,
	searchTitle,
	token,
} from "../../src/features/activity/search.ts"
import { BandDecoders } from "../../src/features/tuned/BandDecoders.tsx"
import type { SummaryItem } from "../../src/features/tuned/band-table.ts"
import { DecoderVerdictsFeed } from "../../src/features/tuned/verdicts.ts"
import { shellStore } from "../../src/shell/store.ts"
import { fakeSockets } from "../data/fake-socket.ts"

describe("activity decoder filter (query)", () => {
	it("a decoder token names the decoder and queries its id, never as text", () => {
		const t = decoderToken("adsb-1", "ADS-B")
		expect(t).toEqual({
			kind: "decoder",
			value: "adsb-1",
			label: "Decoder ADS-B",
		})
		expect(decoderToken("adsb-1").label).toBe("Decoder adsb-1")
		expect(decoderToken("adsb-1", "  ").label).toBe("Decoder adsb-1")
		expect(buildQuery([t], null)).toEqual({ decoderIds: ["adsb-1"] })
		expect(searchTitle([t], null)).toBe("Decoder ADS-B")
	})

	it("combines with the other filters and the scope; two decoders match nothing", () => {
		const t = decoderToken("pager", "Pager")
		expect(
			buildQuery(
				[t, frequencyToken(160_450_000), token("text", "fire")],
				"paging",
			),
		).toEqual({
			decoderIds: ["pager"],
			categories: ["paging"],
			frequencyHz: { min: 160_443_750, max: 160_456_250 },
			text: "fire",
		})
		expect(buildQuery([t, t], null)).toEqual({ decoderIds: ["pager"] })
		expect(buildQuery([t, decoderToken("adsb-1")], null)).toBeNull()
		expect(
			scopedQuery(
				buildQuery([t], null),
				{ range: { kind: "1h" }, audio: false },
				7_200_000,
			),
		).toEqual({
			decoderIds: ["pager"],
			producedAt: { from: new Date(3_600_000).toISOString() },
		})
		expect(
			scopedQuery(buildQuery([t], null), { range: ANY_TIME, audio: false }, 0),
		).toEqual({
			decoderIds: ["pager"],
		})
	})
})

describe("activity decoder filter (controller)", () => {
	const page: ActivitySearchPage = {
		items: [],
		nextPageToken: null,
		replayCursor: "c:0",
		snapshot: { lowBarrier: "0", highWater: "0", expiresAt: "x" },
		searchCoverage: "bounded-projection",
	}
	function setup() {
		const urls: string[] = []
		const api = new ApiClient({
			fetch: async url => {
				urls.push(String(url))
				const body = String(url).includes("facets")
					? { facets: { category: [] } }
					: page
				return new Response(JSON.stringify(body), { status: 200 })
			},
		})
		const sockets = fakeSockets()
		const events = new EventsClient({ createSocket: sockets.factory })
		events.connect()
		sockets.last().open()
		return {
			c: new ActivityController({ api, events } as unknown as DataLayer),
			urls,
		}
	}
	beforeEach(() => {
		const map = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => void map.set(k, v),
			removeItem: (k: string) => void map.delete(k),
			clear: () => map.clear(),
		})
		setActivityPaneOpen(false)
		shellStore.closeDrawer()
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("showDecoder replaces the search with the decoder, opens the drawer and reads only its rows", async () => {
		const { c, urls } = setup()
		const off = c.attach()
		c.setSearch([token("talkgroup", "2081")], "voice")
		c.showDecoder("adsb-1", "ADS-B")
		expect(c.get()).toMatchObject({
			tokens: [{ kind: "decoder", value: "adsb-1", label: "Decoder ADS-B" }],
			chip: null,
			view: "all",
			editing: null,
		})
		expect(c.query()).toEqual({ decoderIds: ["adsb-1"] })
		expect(c.title()).toBe("Decoder ADS-B")
		expect(shellStore.getState().drawer).toBe("activity")
		await vi.waitFor(() =>
			expect(urls.some(u => u.includes("decoderIds=adsb-1"))).toBe(true),
		)
		// clearable like every chip: removing it lists all activity again
		c.removeToken(0)
		expect(c.get().tokens).toEqual([])
		expect(c.query()).toEqual({})
		off()
	})
})

describe("tuned card: Last decode opens that decoder in Activity", () => {
	let services: AppServices | null = null
	afterEach(() => {
		services?.dispose()
		services = null
	})
	const HZ = 1_090_000_000
	const decoder = (id: string): DecoderInfo => ({
		id,
		type: id,
		running: true,
		health: "running",
		uptime: 10,
		stats: { bytesIn: 0, eventsOut: 3, errors: 0 },
		restartCount: 0,
		suspended: false,
		targetFrequenciesHz: [HZ],
	})
	const item = (over: Partial<SummaryItem> & { id: string }): SummaryItem => ({
		name: "ADS-B",
		protocol: "readsb",
		verdict: { code: "decoding", text: "ADS-B decoding", actions: [] },
		lastOutputAt: Date.parse("2026-10-17T11:59:58Z"),
		eventsOut: 3,
		coversHz: true,
		...over,
	})
	function render(items: readonly SummaryItem[]) {
		services = createServices({
			fetch: async () => {
				throw new TypeError("offline")
			},
			createSocket: () => ({
				readyState: 0,
				onopen: null,
				onclose: null,
				onerror: null,
				onmessage: null,
				send: () => undefined,
				close: () => undefined,
			}),
		})
		const feed = new DecoderVerdictsFeed(services.data)
		const html = renderToStaticMarkup(
			createElement(
				ServicesContext.Provider,
				{ value: services },
				createElement(BandDecoders, {
					hz: HZ,
					decoders: items.map(i => decoder(i.id)),
					items,
					feed,
					now: Date.parse("2026-10-17T12:00:00Z"),
					readOnly: false,
				}),
			),
		)
		feed.dispose()
		return html
	}

	it("links every decoder that decoded, whatever its program; a decoder that never did has no link", () => {
		const html = render([
			item({ id: "adsb-1" }),
			// a program no Activity category chip stands for still gets its link
			item({ id: "custom-1", name: "Custom", protocol: "custom-program" }),
			item({
				id: "pager-1",
				name: "Pager",
				protocol: "multimon-ng",
				lastOutputAt: null,
			}),
		])
		expect(html).toContain('title="ADS-B in Activity"')
		expect(html).toContain('title="Custom in Activity"')
		expect(html).not.toContain('title="Pager in Activity"')
	})
})
