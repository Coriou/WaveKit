import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActivitySearchPage, ActivitySummary } from "@wavekit/api-types"
import { ApiClient } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import type { DataLayer } from "../../src/data/index.ts"
import type { ActivityColumn } from "../../src/features/activity/columns.ts"
import {
	COL_MIN,
	columnQuery,
	dropColumn,
	heardMost,
	moveColumn,
	paneColumns,
} from "../../src/features/activity/columns.ts"
import {
	ActivityController,
	readColumns,
} from "../../src/features/activity/controller.ts"
import {
	activityPane,
	setActivityPaneOpen,
} from "../../src/features/activity/pane.ts"
import { frequencyToken, token } from "../../src/features/activity/search.ts"
import { shellStore } from "../../src/shell/store.ts"
import { fakeSockets } from "../data/fake-socket.ts"

const col = (
	id: string,
	over: Partial<ActivityColumn> = {},
): ActivityColumn => ({
	id,
	title: id,
	named: false,
	tokens: [],
	chip: null,
	categories: null,
	...over,
})

const item = (
	seq: number,
	over: Partial<ActivitySummary> = {},
): ActivitySummary => ({
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
	...over,
})

describe("activity columns model", () => {
	it("narrows a column's search by the drawer's search", () => {
		const tg = col("tg", { tokens: [token("talkgroup", "2081")] })
		expect(columnQuery(tg, { tokens: [], chip: null })).toEqual({
			categories: ["voice"],
			text: "2081",
		})
		expect(
			columnQuery(tg, { tokens: [token("text", "fire")], chip: null }),
		).toEqual({ categories: ["voice"], text: "2081 fire" })
		// a talkgroup column cannot match pagers
		expect(columnQuery(tg, { tokens: [], chip: "paging" })).toBeNull()
		const positions = col("pos", {
			categories: ["aircraft", "marine", "aprs"],
		})
		expect(columnQuery(positions, { tokens: [], chip: "marine" })).toEqual({
			categories: ["marine"],
		})
		const voice = col("voice", { chip: "voice" })
		expect(columnQuery(voice, { tokens: [], chip: "voice" })).toEqual({
			categories: ["voice"],
		})
		expect(columnQuery(voice, { tokens: [], chip: "marine" })).toBeNull()
		// the drawer's frequency on a frequency column: two frequencies cannot match together
		const ch16 = col("ch16", { tokens: [frequencyToken(156_800_000)] })
		expect(
			columnQuery(ch16, {
				tokens: [frequencyToken(156_800_000)],
				chip: null,
			}),
		).toEqual({ frequencyHz: { min: 156_793_750, max: 156_806_250 } })
		expect(
			columnQuery(ch16, {
				tokens: [frequencyToken(156_650_000)],
				chip: null,
			}),
		).toBeNull()
	})

	it("moves and drops columns", () => {
		const cols = [col("a"), col("b"), col("c")]
		expect(moveColumn(cols, "a", 1).map(c => c.id)).toEqual(["b", "a", "c"])
		expect(moveColumn(cols, "a", -1)).toBe(cols)
		expect(moveColumn(cols, "c", 1)).toBe(cols)
		expect(dropColumn(cols, "a", "c").map(c => c.id)).toEqual(["b", "c", "a"])
		expect(dropColumn(cols, "c", "a").map(c => c.id)).toEqual(["c", "a", "b"])
		expect(dropColumn(cols, "a", "a")).toBe(cols)
	})

	it("offers what is heard more than once, most first, not yet a column", () => {
		const tg = (n: number, v: string) =>
			item(n, { fields: [{ key: "talkgroup", label: "TG", value: v }] })
		const cap = (n: number) =>
			item(n, {
				category: "paging",
				fields: [{ key: "address", label: "Capcode", value: "1234567" }],
			})
		const items = [
			tg(1, "9"),
			tg(2, "9"),
			tg(3, "9"),
			cap(4),
			cap(5),
			tg(6, "1"),
		]
		expect(heardMost(items, []).map(h => [h.title, h.count])).toEqual([
			["TG 9", 3],
			["Capcode 1234567", 2],
		])
		expect(heardMost(items, ["TG 9"]).map(h => h.title)).toEqual([
			"Capcode 1234567",
		])
		// analog voice: the channel
		const analog = [item(7), item(8)]
		expect(heardMost(analog, [])[0]?.tokens[0]?.kind).toBe("frequency")
	})

	it("fills the pane, then lets the next column peek in", () => {
		expect(paneColumns(1000, 2, 184)).toMatchObject({ grow: true, over: false })
		const over = paneColumns(900, 4, 184)
		expect(over.over).toBe(true)
		expect(over.fit).toBe(2)
		// two whole columns and a peek on each side fill the inner width
		expect(over.colW * 2 + 8 * 2 + 52 * 2).toBeLessThanOrEqual(880)
		expect(over.colW).toBeGreaterThanOrEqual(COL_MIN)
		// a pane narrower than one column still shows one
		expect(paneColumns(200, 3).fit).toBe(1)
	})

	it("reads older pinned searches as columns and drops broken ones", () => {
		const raw = JSON.stringify([
			{
				id: "p1",
				title: "TG 2081",
				tokens: [token("talkgroup", "2081")],
				chip: null,
			},
			{ id: "p2", title: "Voice", tokens: [], chip: "voice" },
			{ id: "p3", title: "Bad", tokens: [{ kind: 1 }], chip: null },
			{ id: "p4", title: "Nothing", tokens: [], chip: "nope" },
			{
				id: "p5",
				title: "Pos",
				tokens: [],
				chip: null,
				categories: ["marine"],
				named: true,
			},
			{ id: "p6", title: "Six", tokens: [token("text", "a")], chip: null },
			{ id: "p7", title: "Seven", tokens: [token("text", "b")], chip: null },
			{ id: "p8", title: "Eight", tokens: [token("text", "c")], chip: null },
		])
		const cols = readColumns(raw)
		expect(cols.map(c => c.id)).toEqual(["p1", "p2", "p5", "p6", "p7"])
		expect(cols[2]).toMatchObject({ named: true, categories: ["marine"] })
		expect(readColumns("not json")).toEqual([])
		expect(readColumns(null)).toEqual([])
	})
})

describe("activity controller columns", () => {
	const page = (items: ActivitySummary[]): ActivitySearchPage => ({
		items,
		nextPageToken: null,
		replayCursor: "c:9",
		snapshot: { lowBarrier: "0", highWater: "9", expiresAt: "x" },
		searchCoverage: "bounded-projection",
	})

	function setup() {
		const urls: string[] = []
		const api = new ApiClient({
			fetch: async url => {
				urls.push(String(url))
				const body = String(url).includes("facets")
					? { facets: { category: [] } }
					: page([item(5), item(4)])
				return new Response(JSON.stringify(body), { status: 200 })
			},
		})
		const sockets = fakeSockets()
		const events = new EventsClient({ createSocket: sockets.factory })
		events.connect()
		sockets.last().open()
		const c = new ActivityController({ api, events } as unknown as DataLayer)
		return { c, urls, sockets }
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
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("showEvent opens one event by id in the drawer, the search kept", () => {
		const { c } = setup()
		c.addToken(token("talkgroup", "2081"))
		c.open(item(5))
		c.showEvent("evt_last")
		expect(c.get()).toMatchObject({
			openId: "evt_last",
			openItem: null,
			view: "all",
			editing: null,
		})
		expect(c.get().tokens).toHaveLength(1)
		expect(shellStore.getState().drawer).toBe("activity")
	})

	it("pins the search as a column, clears the search and opens the pane", async () => {
		const { c, urls } = setup()
		const off = c.attach()
		c.addToken(token("talkgroup", "2081"))
		const id = c.pinSearch(true)
		expect(id).not.toBeNull()
		expect(c.get().columns).toHaveLength(1)
		expect(c.get().columns[0]).toMatchObject({ title: "TG 2081", chip: null })
		expect(c.get().tokens).toEqual([])
		expect(activityPane.get().open).toBe(true)
		// remembered in this browser
		expect(
			readColumns(localStorage.getItem("wavekit.web.activity.pins")),
		).toHaveLength(1)
		await vi.waitFor(() =>
			expect(c.columnFeed(id ?? "")?.get().status).toBe("live"),
		)
		expect(urls.some(u => u.includes("text=2081"))).toBe(true)
		// the same search again is not a second column
		c.addToken(token("talkgroup", "2081"))
		expect(c.currentColumn()?.id).toBe(id)
		expect(c.pinSearch(true)).toBe(id)
		expect(c.get().columns).toHaveLength(1)
		off()
		c.dispose()
	})

	it("narrows every column by the drawer's search", async () => {
		const { c, urls } = setup()
		const off = c.attach()
		c.addColumn(
			{ title: "Voice", tokens: [], chip: "voice", categories: null },
			true,
		)
		c.addToken(token("text", "fire"))
		await vi.waitFor(() =>
			expect(
				urls.some(
					u => u.includes("categories=voice") && u.includes("text=fire"),
				),
			).toBe(true),
		)
		off()
		c.dispose()
	})

	it("while editing, only the edited column follows the search", async () => {
		const { c, urls } = setup()
		const off = c.attach()
		c.addColumn(
			{ title: "Positions", tokens: [], chip: null, categories: ["marine"] },
			true,
		)
		const id =
			c.addColumn(
				{
					title: "TG 9",
					tokens: [token("talkgroup", "9")],
					chip: null,
					categories: null,
				},
				true,
			) ?? ""
		c.editColumn(id)
		urls.length = 0
		c.addToken(token("text", "fire"))
		await vi.waitFor(() =>
			expect(
				urls.some(
					u => u.includes("text=9+fire") || u.includes("text=9%20fire"),
				),
			).toBe(true),
		)
		// the marine column is not narrowed by the edit
		expect(urls.filter(u => u.includes("categories=marine"))).toEqual([])
		off()
		c.dispose()
	})

	it("edits a column's search, keeping a typed name", () => {
		const { c } = setup()
		const id =
			c.addColumn(
				{
					title: "TG 2081",
					tokens: [token("talkgroup", "2081")],
					chip: null,
					categories: null,
				},
				true,
			) ?? ""
		c.renameColumn(id, "  Fire ops ")
		c.editColumn(id)
		expect(c.get().editing).toBe(id)
		expect(c.get().tokens.map(t => t.value)).toEqual(["2081"])
		c.addToken(token("talkgroup", "9"))
		c.pinSearch(true)
		const updated = c.get().columns[0]
		expect(updated?.title).toBe("Fire ops")
		expect(updated?.tokens.map(t => t.value)).toEqual(["2081", "9"])
		expect(c.get().editing).toBeNull()
		expect(c.get().tokens).toEqual([])
		c.dispose()
	})

	it("removes a column with an undo that puts it back in place", () => {
		const { c } = setup()
		const add = (t: string) =>
			c.addColumn(
				{ title: t, tokens: [token("text", t)], chip: null, categories: null },
				true,
			) ?? ""
		add("a")
		const b = add("b")
		add("c")
		const undo = c.removeColumn(b)
		expect(c.get().columns.map(x => x.title)).toEqual(["a", "c"])
		undo?.()
		expect(c.get().columns.map(x => x.title)).toEqual(["a", "b", "c"])
		c.dispose()
	})

	it("stops at five columns", () => {
		const { c } = setup()
		for (const t of ["a", "b", "c", "d", "e"])
			expect(
				c.addColumn(
					{
						title: t,
						tokens: [token("text", t)],
						chip: null,
						categories: null,
					},
					true,
				),
			).not.toBeNull()
		expect(
			c.addColumn(
				{
					title: "f",
					tokens: [token("text", "f")],
					chip: null,
					categories: null,
				},
				true,
			),
		).toBeNull()
		c.dispose()
	})

	it("without room, a pinned column shows in the switcher and counts what arrives", async () => {
		const { c, sockets } = setup()
		const off = c.attach()
		c.addToken(token("text", "x"))
		const id = c.pinSearch(false) ?? ""
		expect(activityPane.get().open).toBe(false)
		expect(c.get().view).toBe(id)
		await vi.waitFor(() => expect(c.get().seen[id]).toBe("5"))
		c.pickView("all")
		const sub = (
			sockets
				.last()
				.sent.filter(
					m => (m as { type?: string }).type === "activity:subscribe",
				) as { id: string; query: { text?: string } }[]
		).findLast(m => m.query.text === "x")
		sockets.last().receive({
			type: "activity:records",
			channel: "activity",
			data: {
				id: sub?.id,
				items: [item(7), item(6)],
				scannedThrough: "9",
				cursor: "c:9",
			},
		})
		await vi.waitFor(() => expect(c.newInColumn(id)).toBe(2))
		c.pickView(id)
		expect(c.newInColumn(id)).toBe(0)
		off()
		c.dispose()
	})
})
