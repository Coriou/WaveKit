import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ActivitySummary } from "@wavekit/api-types"
import { RECORDINGS_IN_PROGRESS_MS } from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import {
	RECORDING_SETTLE_GRACE_MS,
	RECORDING_SETTLE_MS,
	RecordingReadiness,
	recordingReadiness,
	settleDelay,
} from "../../src/data/recording-readiness.ts"
import { ActivityFeed } from "../../src/data/activity-feed.ts"
import { ApiClient } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import { RecordingsStore } from "../../src/data/recordings-store.ts"
import { ActivityRow } from "../../src/features/activity/ActivityList.tsx"
import {
	ActivityDisc,
	SavingWave,
} from "../../src/features/activity/ActivityPlayback.tsx"
import type { ActivityStack } from "../../src/features/activity/fold.ts"
import { fileErrorText } from "../../src/features/playback/service.ts"
import { json, scripted } from "./fake-fetch.ts"
import { fakeSockets } from "./fake-socket.ts"

const KEY = "dsd~20261125_101500_00001_YSF.wav"

function row(
	producedAt: string,
	id = KEY,
	eventId = `evt_${id}`,
): ActivitySummary {
	return {
		eventId,
		commitSeq: "1",
		kind: "decoder-reception",
		producedAt,
		receivedAt: producedAt,
		decoderId: "dsd-fme",
		sourceId: "src-0",
		protocol: "ysf",
		category: "voice",
		frequencyHz: null,
		entityKey: "talkgroup:1",
		title: "TG 1",
		fields: [],
		recording: { id, durationMs: 8000 },
	} as ActivitySummary
}

/** A clock the test moves (timers fire as it passes them). */
function fakeClock(start: number) {
	let now = start
	let seq = 0
	const timers = new Map<number, { at: number; fn: () => void }>()
	return {
		now: () => now,
		setTimeout: (fn: () => void, ms: number) => {
			seq += 1
			timers.set(seq, { at: now + ms, fn })
			return seq
		},
		clearTimeout: (h: unknown) => {
			timers.delete(h as number)
		},
		advance(ms: number) {
			const end = now + ms
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, t]) => t.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0]
				if (due === undefined) break
				timers.delete(due[0])
				now = due[1].at
				due[1].fn()
			}
			now = end
		},
	}
}

const T0 = Date.UTC(2026, 10, 25, 10, 15, 0)
const iso = (ms: number) => new Date(ms).toISOString()

describe("recording readiness", () => {
	it("a link on a row this young is saving until the core can list its file", () => {
		const clock = fakeClock(T0)
		const r = new RecordingReadiness(clock)
		r.note([row(iso(T0))])
		expect(r.isSaving(KEY)).toBe(true)
		clock.advance(RECORDING_SETTLE_MS - 1)
		expect(r.isSaving(KEY)).toBe(true)
		clock.advance(1)
		expect(r.isSaving(KEY)).toBe(false)
	})

	it("an older row (history, a replay) is settled at once", () => {
		const clock = fakeClock(T0)
		const r = new RecordingReadiness(clock)
		r.note([row(iso(T0 - RECORDING_SETTLE_MS - 1))])
		expect(r.isSaving(KEY)).toBe(false)
		expect(r.retryIn(KEY)).toBeNull()
	})

	it("waits only the rest of the settle time, never more than it (a core clock ahead)", () => {
		expect(settleDelay(iso(T0 - 4_000), T0)).toBe(RECORDING_SETTLE_MS - 4_000)
		expect(settleDelay(iso(T0 + 60_000), T0)).toBe(RECORDING_SETTLE_MS)
		expect(settleDelay("garbage", T0)).toBe(0)
	})

	it("the catalogue listing the file makes it playable at once", () => {
		const clock = fakeClock(T0)
		const r = new RecordingReadiness(clock)
		r.note([row(iso(T0))])
		r.listed(["dsd:0~whatever.wav", KEY])
		expect(r.isSaving(KEY)).toBe(false)
	})

	it("a second sighting of the same link does not restart it", () => {
		const clock = fakeClock(T0)
		const r = new RecordingReadiness(clock)
		r.note([row(iso(T0))])
		clock.advance(RECORDING_SETTLE_MS)
		r.note([row(iso(clock.now()))])
		expect(r.isSaving(KEY)).toBe(false)
	})

	it("a refused fetch of a just-linked file is tried again for a bounded while", () => {
		const clock = fakeClock(T0)
		const r = new RecordingReadiness(clock)
		r.note([row(iso(T0))])
		expect(r.retryIn(KEY)).toBe(RECORDING_SETTLE_MS)
		clock.advance(RECORDING_SETTLE_MS + RECORDING_SETTLE_GRACE_MS)
		expect(r.retryIn(KEY)).toBeNull()
		expect(r.retryIn("never-seen")).toBeNull()
	})
})

describe("recording readiness against a skewed or late link", () => {
	it("a live link on a row the core dated 20 s ago (its clock behind) is still tried again", () => {
		const clock = fakeClock(T0)
		const r = new RecordingReadiness(clock)
		r.note([row(iso(T0 - 20_000))], { live: true })
		// the Saving display stays age-based: the row looks settled
		expect(r.isSaving(KEY)).toBe(false)
		expect(r.retryIn(KEY)).not.toBeNull()
		clock.advance(RECORDING_SETTLE_MS + RECORDING_SETTLE_GRACE_MS - 1)
		expect(r.retryIn(KEY)).not.toBeNull()
		clock.advance(1)
		expect(r.retryIn(KEY)).toBeNull()
	})

	it("the same old row read from a snapshot is settled (a 404 is the truth)", () => {
		const clock = fakeClock(T0)
		const r = new RecordingReadiness(clock)
		r.note([row(iso(T0 - 20_000))])
		expect(r.retryIn(KEY)).toBeNull()
	})

	it("a link newly found on a row seen before without one gets a retry window from now", () => {
		const clock = fakeClock(T0)
		const r = new RecordingReadiness(clock)
		const bare = { ...row(iso(T0 - 60_000)) }
		delete bare.recording
		r.note([bare])
		clock.advance(30_000)
		// the late call file: the core adds it to the same row (same eventId, old producedAt)
		r.note([row(iso(T0 - 60_000))])
		expect(r.retryIn(KEY)).not.toBeNull()
		clock.advance(RECORDING_SETTLE_MS + RECORDING_SETTLE_GRACE_MS)
		expect(r.retryIn(KEY)).toBeNull()
	})

	it("reset forgets the rows seen without a link too", () => {
		const clock = fakeClock(T0)
		const r = new RecordingReadiness(clock)
		const bare = { ...row(iso(T0 - 60_000)) }
		delete bare.recording
		r.note([bare])
		r.reset()
		r.note([row(iso(T0 - 60_000))])
		expect(r.retryIn(KEY)).toBeNull()
	})
})

describe("the file of a recording still being saved", () => {
	afterEach(() => vi.useRealTimers())

	it("is fetched again until served: the 404 of a file being finalised never reaches the player", async () => {
		vi.useFakeTimers({ now: T0 })
		const r = new RecordingReadiness()
		r.note([row(iso(T0))])
		let served = false
		const { api, calls } = scripted(() =>
			served
				? new Response(new Uint8Array([1, 2, 3]), { status: 200 })
				: json(404, {
						error: "Not Found",
						code: "RECORDING_NOT_FOUND",
						message: "Recording not found",
					}),
		)
		const store = new RecordingsStore(api, null, {}, r)
		let error: unknown = null
		const got = store.file(KEY).catch((e: unknown) => {
			error = e
			return null
		})
		await vi.advanceTimersByTimeAsync(RECORDINGS_IN_PROGRESS_MS)
		expect(calls.length).toBeGreaterThanOrEqual(1)
		served = true
		await vi.advanceTimersByTimeAsync(RECORDING_SETTLE_MS)
		const blob = await got
		expect(error).toBeNull()
		expect(blob?.size).toBe(3)
		expect(calls.length).toBeGreaterThanOrEqual(2)
	})

	it("a live row whose core clock is 20 s behind: the 404 is tried again and the file plays once served", async () => {
		vi.useFakeTimers({ now: T0 })
		const sockets = fakeSockets()
		const events = new EventsClient({ createSocket: sockets.factory })
		events.connect()
		sockets.last().open()
		const feedApi = new ApiClient({
			fetch: async () =>
				new Response(
					JSON.stringify({
						items: [],
						nextPageToken: null,
						replayCursor: "c:0",
						snapshot: { lowBarrier: "0", highWater: "0", expiresAt: "x" },
						searchCoverage: "bounded-projection",
					}),
					{ status: 200 },
				),
		})
		const feed = new ActivityFeed(feedApi, events, { flushMs: 50, id: "skew" })
		await feed.setQuery({})
		const sub = sockets
			.last()
			.sent.find(
				m => (m as { type?: string }).type === "activity:subscribe",
			) as { id: string } | undefined
		expect(sub).toBeDefined()
		sockets.last().receive({
			type: "activity:records",
			channel: "activity",
			data: {
				id: sub?.id ?? "",
				items: [row(iso(T0 - 20_000))],
				scannedThrough: "1",
				cursor: "c:1",
			},
		})
		let served = false
		const { api, calls } = scripted(() =>
			served
				? new Response(new Uint8Array([1, 2, 3]), { status: 200 })
				: json(404, {
						error: "Not Found",
						code: "RECORDING_NOT_FOUND",
						message: "Recording not found",
					}),
		)
		const store = new RecordingsStore(api, null, {}, recordingReadiness)
		let error: unknown = null
		const got = store.file(KEY).catch((e: unknown) => {
			error = e
			return null
		})
		await vi.advanceTimersByTimeAsync(RECORDINGS_IN_PROGRESS_MS)
		expect(calls.length).toBeGreaterThanOrEqual(2)
		served = true
		await vi.advanceTimersByTimeAsync(5_000)
		const blob = await got
		expect(error).toBeNull()
		expect(blob?.size).toBe(3)
		feed.dispose()
		events.disconnect()
		recordingReadiness.reset()
	})

	it("aborting while it waits rejects and stops fetching", async () => {
		vi.useFakeTimers({ now: T0 })
		const r = new RecordingReadiness()
		r.note([row(iso(T0))])
		const { api, calls } = scripted(() =>
			json(404, {
				error: "Not Found",
				code: "RECORDING_NOT_FOUND",
				message: "Recording not found",
			}),
		)
		const store = new RecordingsStore(api, null, {}, r)
		const stop = new AbortController()
		const got = store.file(KEY, stop.signal).catch((e: unknown) => e)
		await vi.advanceTimersByTimeAsync(0)
		expect(calls).toHaveLength(1)
		stop.abort(new DOMException("stopped", "AbortError"))
		const e = await got
		expect((e as DOMException).name).toBe("AbortError")
		await vi.advanceTimersByTimeAsync(
			RECORDING_SETTLE_MS + RECORDING_SETTLE_GRACE_MS,
		)
		expect(calls).toHaveLength(1)
	})

	it("a file never linked here still fails at once with the core's answer", async () => {
		const r = new RecordingReadiness()
		const { api, calls } = scripted(() =>
			json(404, {
				error: "Not Found",
				code: "RECORDING_NOT_FOUND",
				message: "Recording not found",
			}),
		)
		const store = new RecordingsStore(api, null, {}, r)
		const e: unknown = await store.file(KEY).catch((x: unknown) => x)
		expect(calls).toHaveLength(1)
		expect(fileErrorText(e)).toBe("This recording is no longer on the receiver")
	})
})

describe("the Activity row's play control", () => {
	let services: AppServices | null = null
	afterEach(() => {
		services?.dispose()
		services = null
		recordingReadiness.reset()
	})

	const render = (item: ActivitySummary) => {
		services ??= createServices()
		return renderToStaticMarkup(
			createElement(
				ServicesContext.Provider,
				{ value: services },
				createElement(ActivityDisc, {
					item,
					queue: () => ({ source: "activity" as const, ids: [] }),
				}),
			),
		)
	}

	it("shows Saving, not Play, while the file is not listed yet; never the gone text", () => {
		recordingReadiness.note([row(new Date().toISOString())])
		const html = render(row(new Date().toISOString()))
		expect(html).toContain("data-saving")
		expect(html).toContain("Saving")
		expect(html).not.toContain("<button")
		expect(html).not.toContain("no longer")
	})

	it("shows Play once the catalogue lists it", () => {
		recordingReadiness.note([row(new Date().toISOString())])
		recordingReadiness.listed([KEY])
		const html = render(row(new Date().toISOString()))
		expect(html).toContain("<button")
		expect(html).toContain('aria-label="Play TG 1"')
		expect(html).not.toContain("data-saving")
	})

	it("an old row plays at once", () => {
		const html = render(row("2026-01-01T00:00:00.000Z"))
		expect(html).toContain("<button")
		expect(html).not.toContain("Saving")
	})

	it("the waveform's place while saving is the waveform's own well and times line (same height)", () => {
		const html = renderToStaticMarkup(createElement(SavingWave))
		expect(html).toContain('class="wkp-wave-wrap wka-saving-wave"')
		expect(html).toContain('class="wkp-wave"')
		expect(html).toContain('class="wkp-wave-times"')
	})

	const stackOf = (members: ActivitySummary[]): ActivityStack =>
		({
			key: "k",
			foldKey: "k",
			family: "voice",
			members,
			byTime: [...members].reverse(),
			latest: members[0],
			view: members[0],
			known: { title: null, fields: [] },
			firstMs: T0,
			lastMs: T0,
			receptions: members.length,
			channelsHz: [],
		}) as unknown as ActivityStack

	const renderRow = (item: ActivitySummary, stack: ActivityStack) => {
		services ??= createServices()
		return renderToStaticMarkup(
			createElement(
				ServicesContext.Provider,
				{ value: services },
				createElement(ActivityRow, {
					item,
					measure: () => undefined,
					cursor: false,
					current: false,
					fresh: false,
					onOpen: () => undefined,
					stack,
				}),
			),
		)
	}

	it("a stacked row without audio keeps the disc column empty, after its stack count", () => {
		const a = { ...row("2026-01-01T00:00:00.000Z", KEY, "evt_a") }
		delete a.recording
		const b = { ...a, eventId: "evt_b", commitSeq: "0" }
		const html = renderRow(a, stackOf([a, b]))
		expect(html).toContain("wka-disc-slot")
		expect(html.indexOf("wka-stack")).toBeLessThan(
			html.indexOf("wka-disc-slot"),
		)
		expect(html).not.toContain('<button type="button" class="wkp-disc')
	})

	it("a stacked row with audio puts its disc in that column, no empty slot", () => {
		const a = row("2026-01-01T00:00:00.000Z", KEY, "evt_a")
		const b = { ...a, eventId: "evt_b", commitSeq: "0" }
		const html = renderRow(a, stackOf([a, b]))
		expect(html).not.toContain("wka-disc-slot")
		expect(html.indexOf("wka-stack")).toBeLessThan(html.indexOf("wka-disc"))
		expect(html).toContain('aria-label="Play TG 1"')
	})
})
