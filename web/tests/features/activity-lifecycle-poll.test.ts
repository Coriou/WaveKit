import { afterEach, describe, expect, it, vi } from "vitest"
import type { ActivitySearchPage } from "@wavekit/api-types"

import { ActivityFeed } from "../../src/data/activity-feed.ts"
import { ApiClient } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import { fakeSockets } from "../data/fake-socket.ts"
import type { ActivityAvailability } from "../../src/features/activity/lifecycle.ts"
import {
	ACTIVITY_LIFECYCLE_POLL_MS,
	activityFeedNeedsReload,
	lifecycleNotice,
	pollActivityAvailability,
} from "../../src/features/activity/lifecycle.ts"

const emptyPage = {
	items: [],
	nextPageToken: null,
	replayCursor: "c:0",
	snapshot: { lowBarrier: "0", highWater: "0", expiresAt: "x" },
	searchCoverage: "bounded-projection",
} as unknown as ActivitySearchPage

type Answer = { status: number; body: unknown } | "network"

const lifecycle = (state: string) => ({
	status: 200,
	body: {
		enabled: true,
		stats: {
			lifecycle: {
				state,
				reason: null,
				attempts: 1,
				nextAttemptAt: null,
				droppedWhileClosed: 0,
			},
		},
	},
})

/** A poller over scripted status answers (the last repeats) on manual timers. */
function poller(answers: Answer[]) {
	let calls = 0
	const api = new ApiClient({
		fetch: async () => {
			const answer = answers[Math.min(calls, answers.length - 1)]!
			calls += 1
			if (answer === "network") throw new TypeError("Failed to fetch")
			return new Response(JSON.stringify(answer.body), {
				status: answer.status,
			})
		},
	})
	const seen: ActivityAvailability[] = []
	let reloads = 0
	const pending: { run: () => void; ms: number }[] = []
	const stop = pollActivityAvailability(
		api,
		a => seen.push(a),
		() => {
			reloads += 1
		},
		() => true,
		{
			setTimeout: (run, ms) => {
				pending.push({ run, ms })
				return pending.length
			},
			clearTimeout: () => {
				pending.length = 0
			},
		},
	)
	const settle = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve()
		await new Promise(resolve => setTimeout(resolve, 0))
	}
	/** Fires the one pending poll timer, then lets the request settle. */
	const tick = async () => {
		const next = pending.shift()
		expect(next?.ms).toBe(ACTIVITY_LIFECYCLE_POLL_MS)
		next!.run()
		await settle()
	}
	return {
		seen,
		pending,
		stop,
		settle,
		tick,
		reloads: () => reloads,
		calls: () => calls,
	}
}

describe("Activity availability polling", () => {
	it("keeps polling and reloading while the list still meets a 503 after available", async () => {
		const p = poller([lifecycle("opening"), lifecycle("available")])
		await p.settle()
		expect(p.seen.at(-1)).toMatchObject({ lifecycle: { state: "opening" } })
		await p.tick()
		expect(p.reloads()).toBe(1)
		// The reload met a 503, so the drawer still polls: the next available reloads again.
		expect(p.pending).toHaveLength(1)
		await p.tick()
		expect(p.reloads()).toBe(2)
		p.stop()
		expect(p.pending).toHaveLength(0)
	})

	it("shows a neutral unreachable notice on a network error and keeps polling", async () => {
		const p = poller(["network", lifecycle("available")])
		await p.settle()
		const unreachable = p.seen.at(-1)!
		expect(unreachable).toEqual({ kind: "unknown" })
		expect(lifecycleNotice(unreachable)).toEqual({
			text: "Can’t reach the receiver",
			tone: "warn",
		})
		expect(lifecycleNotice(unreachable)?.text).not.toMatch(/starting/)
		await p.tick()
		expect(p.reloads()).toBe(1)
		p.stop()
	})

	it("stops on off and on a permanent failure", async () => {
		const off = poller([{ status: 404, body: { code: "ACTIVITY_DISABLED" } }])
		await off.settle()
		expect(off.seen).toEqual([{ kind: "off" }])
		expect(off.pending).toHaveLength(0)
		const failed = poller([lifecycle("unavailable")])
		await failed.settle()
		expect(failed.pending).toHaveLength(0)
		expect(failed.calls()).toBe(1)
	})

	it("never starts a reload while its own reload is pending", async () => {
		const api = new ApiClient({
			fetch: async () =>
				new Response(JSON.stringify(lifecycle("available").body), {
					status: 200,
				}),
		})
		let started = 0
		let finish = () => {}
		const pending: (() => void)[] = []
		const stop = pollActivityAvailability(
			api,
			() => {},
			() => {
				started += 1
				return new Promise<void>(resolve => {
					finish = resolve
				})
			},
			// The feed check alone would allow a reload each poll.
			() => true,
			{
				setTimeout: run => {
					pending.push(run)
					return pending.length
				},
				clearTimeout: () => {
					pending.length = 0
				},
			},
		)
		const settle = async () => {
			for (let i = 0; i < 20; i++) await Promise.resolve()
			await new Promise(resolve => setTimeout(resolve, 0))
		}
		await settle()
		expect(started).toBe(1)
		for (let i = 0; i < 3; i++) {
			pending.shift()!()
			await settle()
		}
		expect(started).toBe(1)
		finish()
		await settle()
		pending.shift()!()
		await settle()
		expect(started).toBe(2)
		stop()
	})

	it("shows nothing before the first answer", () => {
		expect(lifecycleNotice({ kind: "checking" })).toBeNull()
	})
})

describe("Activity recovery with a slow list", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("recovers when the store is available at once but each list read takes 4 s (longer than a poll)", async () => {
		vi.useFakeTimers()
		const LIST_MS = 4_000
		let listCalls = 0
		const api = new ApiClient({
			fetch: async url => {
				if (url.includes("/api/activity/status"))
					return new Response(JSON.stringify(lifecycle("available").body), {
						status: 200,
					})
				listCalls += 1
				if (listCalls === 1)
					return new Response(
						JSON.stringify({ code: "ACTIVITY_UNAVAILABLE" }),
						{ status: 503 },
					)
				await new Promise(resolve => setTimeout(resolve, LIST_MS))
				return new Response(JSON.stringify(emptyPage), { status: 200 })
			},
		})
		const sockets = fakeSockets()
		const events = new EventsClient({ createSocket: sockets.factory })
		events.connect()
		sockets.last().open()
		const feed = new ActivityFeed(api, events, { flushMs: 20, id: "slow" })
		await feed.setQuery({})
		expect(feed.get()).toMatchObject({ available: false, status: "error" })
		const stop = pollActivityAvailability(
			api,
			() => {},
			() => feed.reload(),
			() => activityFeedNeedsReload(feed.get()),
		)
		// Five poll intervals: room for several polls while one slow read is pending.
		for (let t = 0; t < 5; t++)
			await vi.advanceTimersByTimeAsync(ACTIVITY_LIFECYCLE_POLL_MS)
		stop()
		expect(feed.get()).toMatchObject({ available: true, status: "live" })
		// One 503, then one slow read that was never superseded.
		expect(listCalls).toBe(2)
		feed.dispose()
		events.disconnect()
	})
})
