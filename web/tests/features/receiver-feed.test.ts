import fc from "fast-check"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
	SOURCE_RESUME_FAILED_MESSAGE,
	type SourceFeed,
	type SourceFeedState,
} from "@wavekit/api-types"
import { ServicesContext } from "../../src/app/context.ts"
import { createServices } from "../../src/app/services.ts"
import type { AppServices } from "../../src/app/services.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"
import { runAction } from "../../src/features/palette/actions.ts"
import {
	ReceiverPausedBadge,
	receiverSlot,
} from "../../src/features/receiver/ReceiverIsland.tsx"
import {
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

async function loaded(): Promise<{
	services: AppServices
	server: MockServer
	refresh: () => Promise<void>
	close: () => Promise<void>
}> {
	const server = await buildMockServer({ port: 0, resumeMs: 0 })
	await server.app.ready()
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
		// Validates: a source:status without `feed` (the core's socket) keeps the feed known here
		fc.assert(
			fc.property(
				fc.option(arbFeed, { nil: undefined }),
				fc.option(arbFeed, { nil: null }),
				fc.boolean(),
				(own, cached, connected) => {
					const entry: FeedEntry = { feed: cached, pending: null, error: null }
					const source = own ? { connected, feed: own } : { connected }
					const shown = feedOf(source, entry)
					if (!own && !cached) return shown === null
					if (!own && cached && connected && cached.state !== "live")
						return shown?.state === "live"
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
