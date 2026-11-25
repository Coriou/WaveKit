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
import { RecordingsStore } from "../../src/data/recordings-store.ts"
import { ActivityDisc } from "../../src/features/activity/ActivityPlayback.tsx"
import { fileErrorText } from "../../src/features/playback/service.ts"
import { json, scripted } from "./fake-fetch.ts"

const KEY = "dsd~20261125_101500_00001_YSF.wav"

function row(producedAt: string, id = KEY): ActivitySummary {
	return {
		eventId: `evt_${id}`,
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
})
