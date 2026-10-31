import fc from "fast-check"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import WebSocket from "ws"
import {
	SOURCE_RESUME_FAILED_MESSAGE,
	type ExtendedSourceStatus,
	type SourceFeed,
	type SourceFeedState,
} from "@wavekit/api-types"
import { ServicesContext } from "../../src/app/context.ts"
import { createServices } from "../../src/app/services.ts"
import type { SocketLike } from "../../src/data/events-client.ts"
import type { AppServices } from "../../src/app/services.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"
import { runAction } from "../../src/features/palette/actions.ts"
import {
	ReceiverPausedBadge,
	receiverSlot,
} from "../../src/features/receiver/ReceiverIsland.tsx"
import {
	FEED_UNSAVED_TEXT,
	feedControllerFor,
	feedOf,
	feedTarget,
	pausedDecoders,
	toggleFeed,
	type FeedEntry,
} from "../../src/features/receiver/feed.ts"
import type { IslandContext } from "../../src/shell/ShellIsland.tsx"

const ctx: IslandContext = {
	open: true,
	toggle: () => undefined,
	trigger: {
		"aria-expanded": true,
		"aria-controls": "rx",
		onClick: () => undefined,
		ref: null,
	},
}

const inContext = (services: AppServices, node: unknown) =>
	renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: services },
			node as Parameters<typeof createElement>[2],
		),
	)
const panel = (services: AppServices) =>
	inContext(services, receiverSlot.panel?.(ctx))
const head = (services: AppServices) =>
	inContext(services, receiverSlot.head(ctx))
const badge = (services: AppServices) =>
	inContext(
		services,
		createElement(ReceiverPausedBadge, {
			data: services.data,
			sourceId: "rtl-0",
		}),
	)

async function loaded(
	options: { socketOmitsFeed?: boolean; socket?: boolean } = {},
): Promise<{
	services: AppServices
	server: MockServer
	refresh: () => Promise<void>
	close: () => Promise<void>
}> {
	const server = await buildMockServer({
		port: 0,
		resumeMs: 0,
		...(options.socketOmitsFeed === true ? { socketOmitsFeed: true } : {}),
	})
	await server.app.ready()
	// a real socket to the in-process mock (ephemeral port) when the test reads `source:status`
	const port = options.socket === true ? (await server.listen()).port : null
	const services = createServices({
		fetch: async (input, init) => {
			const res = await server.app.inject({
				method: (init?.method ?? "GET") as "GET" | "POST",
				url: input,
			})
			return new Response(res.body, {
				status: res.statusCode,
				headers: { "content-type": "application/json" },
			})
		},
		createSocket: (): SocketLike =>
			port !== null
				? // the `ws` client has the browser socket's handlers (its event types are wider)
					(new WebSocket(`ws://127.0.0.1:${port}/ws`) as unknown as SocketLike)
				: {
						readyState: 0,
						onopen: null,
						onclose: null,
						onerror: null,
						onmessage: null,
						send: () => undefined,
						close: () => undefined,
					},
	})
	const { data } = services
	// no socket in tests: what `source:status` / `decoder:status` would push, read again
	const refresh = async () => {
		await Promise.all([data.sources.load(), services.decoders.load()])
	}
	await Promise.all([refresh(), data.tuner.load()])
	await data.receiver.loadCaps("rtl-0")
	await data.receiver.loadRelay()
	return {
		services,
		server,
		refresh,
		close: async () => {
			services.dispose()
			await server.close()
		},
	}
}

const STATES: readonly SourceFeedState[] = [
	"live",
	"paused",
	"resuming",
	"error",
]
const arbFeed = fc.record({
	state: fc.constantFrom(...STATES),
	since: fc
		.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 })
		.map(t => new Date(t).toISOString()),
})

describe("receiver feed: what is shown", () => {
	it("shows the newest known feed, and a connected source without a feed is never paused", () => {
		// Validates: a source:status without `feed` (an older core's socket) keeps the feed known here
		fc.assert(
			fc.property(
				fc.option(arbFeed, { nil: undefined }),
				fc.option(arbFeed, { nil: null }),
				fc.boolean(),
				(own, cached, connected) => {
					const entry: FeedEntry = {
						feed: cached,
						pending: null,
						error: null,
						unsaved: null,
					}
					const source = own ? { connected, feed: own } : { connected }
					const shown = feedOf(source, entry)
					if (!own && !cached) return shown === null
					if (!own && cached && connected && cached.state !== "live")
						return shown?.state === "live"
					// equal times: the cache took in every row, so it is the later to arrive
					if (own && cached && own.since === cached.since)
						return shown === cached
					const candidates = [own, cached].filter(
						(f): f is SourceFeed => f !== undefined && f !== null,
					)
					const newest = Math.max(...candidates.map(f => Date.parse(f.since)))
					return shown !== null && Date.parse(shown.since) === newest
				},
			),
			{ numRuns: 200 },
		)
	})

	it("counts only this source's decoders held back by the pause", () => {
		const base = { type: "x", running: false, health: "running" } as const
		const list = [
			{
				...base,
				id: "a",
				sourceId: "s",
				suspended: true,
				suspension: { reasonCode: "source-paused" as const, since: "" },
			},
			{
				...base,
				id: "b",
				sourceId: "s",
				suspended: true,
				suspension: { reasonCode: "tuner-scanning" as const, since: "" },
			},
			{
				...base,
				id: "c",
				sourceId: "t",
				suspended: true,
				suspension: { reasonCode: "source-paused" as const, since: "" },
			},
		] as unknown as Parameters<typeof pausedDecoders>[0]
		expect(pausedDecoders(list, "s").map(d => d.id)).toEqual(["a"])
		expect(pausedDecoders(list, null)).toEqual([])
	})
})

describe("receiver feed: pause and resume", () => {
	it("pauses and resumes through the core's routes; a repeated call changes nothing", async () => {
		const { services, close } = await loaded()
		const feeds = feedControllerFor(services.data)
		expect(feedControllerFor(services.data)).toBe(feeds)
		const p = await feeds.pause("rtl-0")
		expect(p).toMatchObject({
			ok: true,
			changed: true,
			feed: { state: "paused" },
		})
		expect((await feeds.pause("rtl-0")).changed).toBe(false)
		const r = await feeds.resume("rtl-0")
		expect(r).toMatchObject({
			ok: true,
			changed: true,
			feed: { state: "live" },
		})
		expect(feeds.entry("rtl-0")).toMatchObject({ pending: null, error: null })
		await close()
	})

	it("refuses a second call while one is in flight", async () => {
		const { services, close } = await loaded()
		const feeds = feedControllerFor(services.data)
		const first = feeds.pause("rtl-0")
		expect(feeds.entry("rtl-0").pending).toBe("pause")
		const second = await feeds.resume("rtl-0")
		expect(second).toMatchObject({ ok: false, error: "Already pausing" })
		expect((await first).ok).toBe(true)
		await close()
	})

	it("keeps a failed resume as the feed's error, then a retry makes it live", async () => {
		const { services, server, close } = await loaded()
		const feeds = feedControllerFor(services.data)
		await feeds.pause("rtl-0")
		server.feed.failNextResumes(1)
		const failed = await feeds.resume("rtl-0")
		expect(failed).toMatchObject({
			ok: false,
			feed: { state: "error", error: SOURCE_RESUME_FAILED_MESSAGE },
			error: SOURCE_RESUME_FAILED_MESSAGE,
		})
		expect(feeds.entry("rtl-0").feed?.state).toBe("error")
		expect((await feeds.resume("rtl-0")).feed?.state).toBe("live")
		await close()
	})

	it("says why for an unknown source", async () => {
		const { services, close } = await loaded()
		const r = await feedControllerFor(services.data).pause("nope")
		expect(r).toMatchObject({ ok: false, error: "The receiver is gone" })
		await close()
	})

	it("warns when a pause is not saved, and a repeated pause saves it", async () => {
		// Validates: HTTP 200 with persisted:false is not shown as plain success
		const { services, server, refresh, close } = await loaded()
		const feeds = feedControllerFor(services.data)
		server.feed.failNextSaves(1)
		const unsaved = await feeds.pause("rtl-0")
		expect(unsaved).toMatchObject({
			ok: false,
			changed: true,
			persisted: false,
			feed: { state: "paused" },
			error: FEED_UNSAVED_TEXT.pause,
		})
		expect(feeds.entry("rtl-0")).toMatchObject({
			unsaved: "pause",
			error: null,
		})
		await refresh()
		let html = panel(services)
		expect(html).toContain("Receiver paused")
		expect(html).toContain('data-unsaved="pause"')
		expect(html).toContain(FEED_UNSAVED_TEXT.pause)
		expect(html).toMatch(/data-unsaved="pause"[^]*>Retry<\/button>/)
		// Retry repeats the pause: the core changes nothing and saves it this time
		const saved = await feeds.pause("rtl-0")
		expect(saved).toMatchObject({
			ok: true,
			changed: false,
			persisted: true,
			error: null,
		})
		expect(feeds.entry("rtl-0").unsaved).toBeNull()
		html = panel(services)
		expect(html).not.toContain(FEED_UNSAVED_TEXT.pause)
		expect(html).toContain("Receiver paused")
		await close()
	})

	it("warns when a resume is not saved, and drops the warning once the feed moves on", async () => {
		const { services, server, refresh, close } = await loaded()
		const feeds = feedControllerFor(services.data)
		await feeds.pause("rtl-0")
		server.feed.failNextSaves(1)
		const r = await feeds.resume("rtl-0")
		expect(r).toMatchObject({
			ok: false,
			persisted: false,
			feed: { state: "live" },
			error: FEED_UNSAVED_TEXT.resume,
		})
		await refresh()
		expect(panel(services)).toContain(FEED_UNSAVED_TEXT.resume)
		// the palette says so too, with no Undo
		server.feed.failNextSaves(1)
		const palette = await runAction(
			services,
			{ kind: "feed", op: "pause", sourceId: "rtl-0" },
			"Receiver paused",
		)
		expect(palette).toMatchObject({
			text: FEED_UNSAVED_TEXT.pause,
			tone: "warn",
		})
		expect(palette.undo).toBeUndefined()
		// the receiver is paused now: the unsaved resume no longer applies, the unsaved pause does
		await refresh()
		const html = panel(services)
		expect(html).not.toContain(FEED_UNSAVED_TEXT.resume)
		expect(html).toContain(FEED_UNSAVED_TEXT.pause)
		await close()
	})

	it("reads an answer without persisted (an older core) as saved", async () => {
		const feeds = feedControllerFor({
			api: {
				post: async () => ({
					id: "s",
					changed: true,
					feed: { state: "paused", since: "2027-01-01T00:00:00.000Z" },
				}),
			} as never,
		})
		expect(await feeds.pause("s")).toMatchObject({
			ok: true,
			persisted: true,
			error: null,
		})
		expect(feeds.entry("s").unsaved).toBeNull()
	})

	it("toggles the tuner's receiver (the P key)", async () => {
		const { services, refresh, close } = await loaded()
		expect(feedTarget(services.data)).toMatchObject({
			sourceId: "rtl-0",
			feed: { state: "live" },
		})
		const pause = toggleFeed(services.data)
		expect(pause?.op).toBe("pause")
		expect(toggleFeed(services.data)).toBeNull() // in flight
		await pause?.result
		await refresh()
		const resume = toggleFeed(services.data)
		expect(resume?.op).toBe("resume")
		expect((await resume?.result)?.feed?.state).toBe("live")
		await close()
	})

	it("runs the palette's commands with Undo on pause and a warning on a failed resume", async () => {
		const { services, server, close } = await loaded()
		const paused = await runAction(
			services,
			{ kind: "feed", op: "pause", sourceId: "rtl-0" },
			"Receiver paused",
		)
		expect(paused.text).toBe("Receiver paused")
		expect(paused.undo).toBeTypeOf("function")
		const again = await runAction(
			services,
			{ kind: "feed", op: "pause", sourceId: "rtl-0" },
			"Receiver paused",
		)
		expect(again.text).toBe("The receiver was already paused")
		server.feed.failNextResumes(1)
		const failed = await runAction(
			services,
			{ kind: "feed", op: "resume", sourceId: "rtl-0" },
			"Receiver resumed",
		)
		expect(failed).toMatchObject({
			text: SOURCE_RESUME_FAILED_MESSAGE,
			tone: "warn",
		})
		const ok = await runAction(
			services,
			{ kind: "feed", op: "resume", sourceId: "rtl-0" },
			"Receiver resumed",
		)
		expect(ok).toMatchObject({ text: "Receiver resumed" })
		expect(ok.undo).toBeUndefined()
		await close()
	})
})

describe("receiver feed: the island", () => {
	it("offers Pause while live and no paused label on the plot", async () => {
		const { services, close } = await loaded()
		const html = panel(services)
		expect(html).toContain("Receiver feed")
		expect(html).toMatch(/aria-keyshortcuts="P"[^>]*>Pause</)
		expect(html).not.toContain("Receiver paused")
		expect(badge(services)).toBe("")
		await close()
	})

	it("shows the paused receiver with Resume, its waiting decoders and locked tuner controls", async () => {
		const { services, refresh, close } = await loaded()
		await feedControllerFor(services.data).pause("rtl-0")
		await refresh()
		const waiting = pausedDecoders(
			services.decoders.get().decoders,
			"rtl-0",
		).length
		expect(waiting).toBeGreaterThan(0)
		const html = panel(services)
		expect(html).toContain("Receiver paused")
		expect(html).toContain(
			`waterfall frozen · ${waiting} decoder${waiting === 1 ? "" : "s"} waiting`,
		)
		expect(html).toMatch(/>Resume<\/button>/)
		expect(html).toContain('role="status" data-state="paused"')
		expect(html).toContain("Receiver paused: resume it to change the tuner.")
		expect(html).toMatch(/<input type="range"[^>]*disabled=""/)
		expect(html).toMatch(/data-variant="amber">Paused</)
		expect(head(services)).toContain(">Paused<")
		const b = badge(services)
		expect(b).toContain("Receiver paused")
		expect(b).toContain("The waterfall is frozen")
		await close()
	})

	it("shows a failed resume as an alert with Retry", async () => {
		const { services, server, refresh, close } = await loaded()
		const feeds = feedControllerFor(services.data)
		await feeds.pause("rtl-0")
		server.feed.failNextResumes(1)
		await feeds.resume("rtl-0")
		await refresh()
		const html = panel(services)
		expect(html).toContain('role="alert" data-state="error"')
		expect(html).toContain("Resume failed")
		expect(html).toContain(SOURCE_RESUME_FAILED_MESSAGE)
		expect(html).toMatch(/>Retry<\/button>/)
		expect(badge(services)).toContain("Resume failed")
		await close()
	})

	it("the services keep a pause from the first source rows, before anything renders", async () => {
		// Validates: createServices makes the feed controller, so no render order loses a feed
		const { services, server, close } = await loaded()
		const { data } = services
		await server.app.inject({ method: "POST", url: "/api/sources/rtl-0/pause" })
		await data.sources.load()
		const row = data.sources.byId("rtl-0")
		expect(row?.feed?.state).toBe("paused")
		// an older core's row without feed replaces it before the island or palette first render
		const { feed: _dropped, ...withoutFeed } = row!
		data.sources.update(s => ({ ...s, sources: [withoutFeed] }))
		expect(feedControllerFor(data).entry("rtl-0").feed?.state).toBe("paused")
		await close()
	})

	it("keeps a pause known only from GET /api/sources when the socket's source:status lacks feed", async () => {
		// Validates: an already paused receiver (paused elsewhere, then this page loads) keeps Resume
		const { services, server, close } = await loaded({
			socket: true,
			socketOmitsFeed: true,
		})
		const { data } = services
		// the shell's island and palette create the controller on their first render
		const feeds = feedControllerFor(data)
		// paused by another client before this page loaded: no call went through its controller
		await server.app.inject({ method: "POST", url: "/api/sources/rtl-0/pause" })
		await data.sources.load()
		expect(data.sources.byId("rtl-0")?.feed?.state).toBe("paused")
		const subscribed = new Promise<void>(resolve => {
			const off = data.events.onAny(e => {
				if (e.type !== "subscribed") return
				off()
				resolve()
			})
		})
		data.events.connect()
		await subscribed
		const events: ExtendedSourceStatus[] = []
		const off = data.events.on("source:status", s => events.push(s))
		// another client's resume fails: the core pushes rows without feed, the source stays down
		server.feed.failNextResumes(1)
		await server.app.inject({
			method: "POST",
			url: "/api/sources/rtl-0/resume",
		})
		await vi.waitFor(
			() => {
				expect(events.length).toBeGreaterThan(0)
				expect(data.sources.byId("rtl-0")).toBe(events.at(-1))
			},
			{ timeout: 5000 },
		)
		off()
		const row = data.sources.byId("rtl-0")
		expect(row?.connected).toBe(false)
		expect(row).not.toHaveProperty("feed")
		expect(feeds.entry("rtl-0").feed?.state).toBe("paused")
		expect(feedTarget(data)).toMatchObject({
			sourceId: "rtl-0",
			feed: { state: "paused" },
		})
		const html = panel(services)
		expect(html).toContain("Receiver paused")
		expect(html).toMatch(/>Resume<\/button>/)
		expect(toggleFeed(data)?.op).toBe("resume")
		await close()
	})

	it("learns the feed from source rows: the newest wins, the later on equal times, and a row without feed changes nothing", () => {
		// Validates: FeedController.remember keeps the newest feed any row carried; ties go to arrival order
		// a few times only, so equal `since` values (with different states) are common
		const arbTied = fc.record({
			state: fc.constantFrom(...STATES),
			since: fc
				.integer({ min: 0, max: 3 })
				.map(t => new Date(1_800_000_000_000 + t).toISOString()),
		})
		fc.assert(
			fc.property(
				fc.array(fc.option(fc.oneof(arbFeed, arbTied), { nil: undefined }), {
					maxLength: 8,
				}),
				rows => {
					const feeds = feedControllerFor({ api: {} as never })
					for (const feed of rows)
						feeds.remember([feed ? { id: "s", feed } : { id: "s" }])
					const seen = rows.filter((f): f is SourceFeed => f !== undefined)
					const known = feeds.entry("s").feed
					if (seen.length === 0) return known === null
					const newest = Math.max(...seen.map(f => Date.parse(f.since)))
					const last = seen.filter(f => Date.parse(f.since) === newest).at(-1)
					return known === last
				},
			),
			{ numRuns: 200 },
		)
	})

	it("follows ordered source:status rows with equal times: resuming then live reads live", async () => {
		// Validates: a resume that reconnects within the same millisecond does not strand "Resuming…"
		const { services, close } = await loaded()
		const { data } = services
		const feeds = feedControllerFor(data)
		const row = data.sources.byId("rtl-0")
		if (!row) throw new Error("no source")
		const since = "2027-01-01T00:00:00.000Z"
		const push = (state: SourceFeedState, connected: boolean) =>
			data.sources.set({
				...data.sources.get(),
				sources: [{ ...row, connected, feed: { state, since } }],
			})
		push("paused", false)
		expect(feedTarget(data)?.feed.state).toBe("paused")
		push("resuming", false)
		expect(feedTarget(data)?.feed.state).toBe("resuming")
		push("live", true)
		expect(feeds.entry("rtl-0").feed?.state).toBe("live")
		expect(feedTarget(data)?.feed).toEqual({ state: "live", since })
		expect(head(services)).not.toContain("Resuming")
		expect(toggleFeed(data)?.op).toBe("pause")
		await close()
	})

	it("takes the later of two equal-time feeds whatever their states", () => {
		const feeds = feedControllerFor({ api: {} as never })
		const since = "2027-01-01T00:00:00.000Z"
		feeds.remember([{ id: "s", feed: { state: "live", since } }])
		feeds.remember([{ id: "s", feed: { state: "resuming", since } }])
		expect(feeds.entry("s").feed?.state).toBe("resuming")
		// the source's own row is older in arrival than the cache on equal times
		expect(
			feedOf(
				{ connected: false, feed: { state: "live", since } },
				feeds.entry("s"),
			)?.state,
		).toBe("resuming")
	})

	it("keeps the pause it was told about when a status arrives without a feed", async () => {
		const { services, close } = await loaded()
		await feedControllerFor(services.data).pause("rtl-0")
		// the core's source:status carries no `feed`: the source reads not connected, the pause stays
		const s = services.data.sources.get().sources[0]
		if (!s) throw new Error("no source")
		const { feed: _drop, ...rest } = s
		void _drop
		services.data.sources.set({
			...services.data.sources.get(),
			sources: [{ ...rest, connected: false }],
		})
		expect(panel(services)).toContain("Receiver paused")
		await close()
	})
})
