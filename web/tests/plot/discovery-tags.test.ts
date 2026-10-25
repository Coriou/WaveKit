import { describe, expect, it } from "vitest"
import type { Discovery } from "@wavekit/api-types"

import { ApiClient } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import { ScannerStore } from "../../src/data/scanner-store.ts"
import {
	discoveryFetchSpan,
	discoveryTagFilter,
	identifiedAt,
	identifiedLabel,
	discoveryTier,
	hasTaggable,
	placeDiscoveryTags,
	RECENT_MS,
} from "../../src/plot/discovery-tags.ts"
import { fakeSockets } from "../data/fake-socket.ts"

/** Discovery fields to override; `undefined` removes an optional one. */
type Over = { [K in keyof Discovery]?: Discovery[K] | undefined }

const NOW = Date.parse("2026-10-17T08:00:00.000Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const view = { startHz: 160_000_000, endHz: 162_000_000 } // 2 MHz
const W = 1000 // 2 kHz a pixel
const at = (px: number) => view.startHz + px * 2000

function disc(id: string, px: number, over: Over = {}): Discovery {
	const stats = { peakDbfs: -40, meanDbfs: -50, snrDb: 20, floorDbfs: -70 }
	const d = {
		id,
		frequencyHz: at(px),
		frequencyKey: String(at(px)),
		measuredOffsetHz: 0,
		bandwidthHz: 12_500,
		protocol: "dmr",
		family: "digital-voice",
		class: "fsk4-12k5",
		confidence: "decoded",
		identity: { kind: "dmr-cc", value: "1" },
		encrypted: false,
		coChannel: [],
		firstSeenAt: ago(RECENT_MS * 3),
		lastSeenAt: ago(60_000),
		observationCount: 1,
		airtimeMs: 1000,
		signal: { best: stats, last: stats },
		metadata: {
			talkgroups: [],
			sources: [],
			slots: [],
			callsigns: [],
			capcodes: [],
			ismModels: [],
		},
		sourceIds: ["pi"],
		jobIds: [],
		tuningTrust: "commanded",
		evidence: { recordings: 0, psd: false, iq: false },
		...over,
	} as Discovery
	for (const k of Object.keys(over) as (keyof Discovery)[])
		if (over[k] === undefined) delete d[k]
	return d
}

const opts = (over: object = {}) => ({
	widthPx: W,
	activeNow: new Set<string>(),
	now: NOW,
	...over,
})

describe("discovery tag tiers", () => {
	it("active now, heard in the last hour, older", () => {
		const active = new Set(["a"])
		expect(discoveryTier(disc("a", 0), active, NOW)).toBe("active")
		expect(discoveryTier(disc("r", 0), active, NOW)).toBe("recent")
		expect(
			discoveryTier(
				disc("o", 0, { lastSeenAt: ago(RECENT_MS + 1) }),
				active,
				NOW,
			),
		).toBe("older")
	})

	it("labels like the drawer, solid when decoded, grey when only heard", () => {
		const placed = placeDiscoveryTags(
			[
				disc("dmr", 100),
				disc("maybe", 400, {
					confidence: "candidate",
					protocol: "analog-fm",
					identity: undefined,
				}),
				disc("heard", 700, {
					confidence: "activity",
					protocol: "unknown",
					identity: undefined,
				}),
			],
			view,
			opts(),
		)
		expect(placed.map(t => [t.label, t.solid, t.heard, t.labelled])).toEqual([
			["DMR · CC 1", true, false, true],
			["Maybe FM voice", false, false, true],
			["Heard", false, true, true],
		])
		// the dot sits on the frequency, 7 px into the chip
		expect(placed[0]?.x).toBeCloseTo(93, 6)
		expect(placed[0]?.title).toBe("DMR · CC 1 · 160.2000 MHz · heard 60 s ago")
	})

	it("never tags an ignored (locked-out) discovery, one out of view, or one already saved", () => {
		const placed = placeDiscoveryTags(
			[
				disc("ignored", 100, { operator: { lockout: true } }),
				disc("out", 100, { frequencyHz: 170e6 }),
				disc("saved", 500),
				disc("kept", 800),
			],
			view,
			opts({ savedHz: [at(500) + 3000] }),
		)
		expect(placed.map(t => t.id)).toEqual(["kept"])
	})

	it("decoded only drops the rest", () => {
		const placed = placeDiscoveryTags(
			[disc("d", 100), disc("c", 600, { confidence: "candidate" })],
			view,
			opts({ only: "decoded" }),
		)
		expect(placed.map(t => t.id)).toEqual(["d"])
	})

	it("co-located discoveries share one group tag; a label only where it fits before the next tag", () => {
		const placed = placeDiscoveryTags(
			[
				disc("old", 100, { lastSeenAt: ago(RECENT_MS * 2) }),
				disc("live", 130),
				disc("onTop", 101, { lastSeenAt: ago(RECENT_MS * 3) }),
			],
			view,
			opts({ activeNow: new Set(["live"]) }),
		)
		// old and onTop (1 px apart) form one group named by old (more recent); its label would run
		// into live, so it keeps the dot; live (active) has its label
		expect(placed.map(t => [t.id, t.tier, t.labelled])).toEqual([
			["old", "older", false],
			["live", "active", true],
		])
	})

	it("two discoveries on the same Hz share one tag", () => {
		const placed = placeDiscoveryTags(
			[disc("a", 300), disc("b", 300, { confidence: "candidate" })],
			view,
			opts(),
		)
		expect(placed.map(t => t.id)).toEqual(["a"])
	})

	it("hasTaggable ignores locked-out discoveries", () => {
		expect(hasTaggable(new Map())).toBe(false)
		expect(
			hasTaggable(
				new Map([["x", disc("x", 0, { operator: { lockout: true } })]]),
			),
		).toBe(false)
		expect(hasTaggable(new Map([["y", disc("y", 0)]]))).toBe(true)
	})
})

describe("discovery fetch span", () => {
	it("asks for the view plus half a view each side, then not again while it is covered and fresh", () => {
		const first = discoveryFetchSpan(view, null, NOW)
		expect(first).toEqual({ startHz: 159_000_000, endHz: 163_000_000 })
		const last = { ...first!, at: NOW }
		// a small pan stays inside
		expect(
			discoveryFetchSpan(
				{ startHz: 160_500_000, endHz: 162_500_000 },
				last,
				NOW + 1000,
			),
		).toBeNull()
		// past the fetched edge, or a minute later, asks again
		expect(
			discoveryFetchSpan({ startHz: 162e6, endHz: 164e6 }, last, NOW + 1000),
		).not.toBeNull()
		expect(discoveryFetchSpan(view, last, NOW + 60_000)).not.toBeNull()
		expect(discoveryFetchSpan({ startHz: 1, endHz: 1 }, null, NOW)).toBeNull()
	})
})

describe("ScannerStore.fetchDiscoveries", () => {
	it("fills byId for a span without touching the list or its query", async () => {
		const urls: string[] = []
		const api = new ApiClient({
			fetch: async url => {
				urls.push(url)
				return new Response(
					JSON.stringify({ items: [disc("s", 10)], nextCursor: null }),
				)
			},
		})
		const events = new EventsClient({ createSocket: fakeSockets().factory })
		const store = new ScannerStore(api, events)
		const items = await store.fetchDiscoveries({
			freqMinHz: 159e6,
			freqMaxHz: 163e6,
			sort: "lastSeen",
			limit: 300,
		})
		expect(items.map(d => d.id)).toEqual(["s"])
		const params = Object.fromEntries(
			new URLSearchParams(urls[0]?.split("?")[1]),
		)
		expect(params).toEqual({
			freqMinHz: "159000000",
			freqMaxHz: "163000000",
			sort: "lastSeen",
			limit: "300",
		})
		const d = store.get().discoveries
		expect(d.byId.has("s")).toBe(true)
		expect(d.items).toEqual([])
		expect(d.query).toEqual({})
		expect(d.loaded).toBe(false)
		store.dispose()
	})
})

describe("discovery tags follow Signal labels", () => {
	it("Named tags decoded discoveries only; Clear and All tag them all", () => {
		expect(discoveryTagFilter("named")).toBe("decoded")
		expect(discoveryTagFilter("clear")).toBe("all")
		expect(discoveryTagFilter("all")).toBe("all")
	})
})

describe("identified signal", () => {
	it("names a signal by the closest decoded discovery, never a guess or an ignored one", () => {
		const list = [
			disc("maybe", 100, { confidence: "candidate" }),
			disc("far", 110),
			disc("near", 102),
			disc("ignored", 100, { operator: { lockout: true } }),
		]
		expect(identifiedAt(list, at(100), 12_500)?.id).toBe("near")
		expect(identifiedAt(list, at(100), 2_000)).toBeNull()
		expect(identifiedAt([list[0]!], at(100), 12_500)).toBeNull()
	})

	it("labels it with the decoder's words, not an operator's name", () => {
		const d = disc("x", 0, { operator: { label: "DMR repeater" } })
		expect(identifiedLabel(d)).toBe("DMR · CC 1")
	})
})
