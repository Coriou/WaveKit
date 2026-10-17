import { afterEach, describe, expect, it, vi } from "vitest"
import type { ActivitySearchPage, ActivitySummary } from "@wavekit/api-types"

import { ApiClient } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import {
	spanQuery,
	TunedActivity,
	TUNED_MAX_ITEMS,
} from "../../src/features/tuned/feed.ts"
import {
	agoText,
	chipsOf,
	nowView,
	type NowInput,
} from "../../src/features/tuned/now.ts"
import { fakeSockets } from "../data/fake-socket.ts"

const NOW = Date.parse("2026-10-17T12:03:17.000Z")

let seq = 0
const summary = (over: Partial<ActivitySummary> = {}): ActivitySummary => {
	seq += 1
	return {
		eventId: `e${seq}`,
		commitSeq: String(seq),
		kind: "decoder-reception",
		producedAt: "2026-10-17T12:02:39.000Z",
		receivedAt: "2026-10-17T12:02:39.000Z",
		decoderId: "d",
		sourceId: "rtl-0",
		protocol: "pocsag",
		category: "paging",
		frequencyHz: 160_450_000,
		entityKey: null,
		title: "Capcode 1234567",
		fields: [],
		...over,
	}
}

const input = (over: Partial<NowInput> = {}): NowInput => ({
	items: [],
	decoderTypes: [],
	modulation: "nfm",
	channelName: null,
	hz: 160_450_000,
	count: null,
	live: false,
	now: NOW,
	...over,
})

afterEach(() => {
	vi.useRealTimers()
})

describe("tuned card now block", () => {
	it("says how long ago, then the clock past an hour", () => {
		expect(agoText("2026-10-17T12:02:39.000Z", NOW)).toBe("38 s ago")
		expect(agoText("2026-10-17T11:59:17.000Z", NOW)).toBe("4 min ago")
		expect(agoText("2026-10-17T10:00:00.000Z", NOW)).toMatch(/^at \d\d:00$/)
	})

	it("shows a page: who in bold, the message, and when the last one came", () => {
		const v = nowView(
			input({
				items: [
					summary({
						fields: [
							{ key: "message", label: "Message", value: "Test page 0412" },
						],
					}),
					summary({
						title: "Capcode 1234560",
						producedAt: "2026-10-17T12:01:00.000Z",
					}),
				],
				decoderTypes: ["multimon-ng"],
			}),
		)
		expect(v.kind).toBe("msg")
		expect(v.title).toContain("Capcode 1234567")
		expect(v.body).toBe("Test page 0412")
		expect(v.quiet).toBe("Listening · last page 38 s ago")
		expect(v.earlier).toHaveLength(1)
		expect(v.earlier[0]?.a).toBe("Capcode 1234560")
		expect(v.shortId).toContain("Capcode 1234567")
	})

	it("says Tone only for a page without a body", () => {
		const v = nowView(input({ items: [summary()] }))
		expect(v.body).toBe("Tone only")
	})

	it("shows sensor readings as chips, measurements by value alone", () => {
		const chips = chipsOf([
			{ key: "temperature_C", label: "Temperature", value: 18.4, unit: "°C" },
			{ key: "battery", label: "Battery", value: "OK" },
			{ key: "humidity", label: "Humidity", value: 61, unit: "%" },
			{
				key: "model",
				label: "Model",
				value: "a very long model name that never fits",
			},
		])
		expect(chips).toEqual([
			{ k: "", v: "18.4 °C" },
			{ k: "", v: "61 %" },
			{ k: "Battery", v: "OK" },
		])
	})

	it("shows a DMR call with the talkgroup large and encryption locked", () => {
		const call = summary({
			kind: "call-lifecycle",
			protocol: "dmr",
			category: "voice",
			title: "TG 2081",
			fields: [
				{ key: "source", label: "Radio", value: 2081045 },
				{ key: "durationMs", label: "Duration", value: 8000 },
			],
		})
		const v = nowView(input({ items: [call], decoderTypes: ["dsd-fme"] }))
		expect(v.kind).toBe("call")
		expect(v.big).toBe("TG 2081")
		expect(
			nowView(input({ items: [{ ...call, title: "TG 9 · radio 2081045" }] })),
		).toMatchObject({
			big: "TG 9",
			line: expect.stringMatching(/^From radio 2081045/),
		})
		expect(v.locked).toBe(false)
		expect(v.quiet).toMatch(/^Quiet · last call \d\d:02 · 0:08$/)

		const p25 = summary({
			kind: "call-lifecycle",
			protocol: "p25",
			category: "voice",
			title: "TG 1201",
			fields: [{ key: "encrypted", label: "Encrypted", value: true }],
		})
		const locked = nowView(input({ items: [p25] }))
		expect(locked.locked).toBe(true)
		expect(locked.body).toBe("Encrypted. There is no audio to play or record.")
	})

	it("shows the last analog transmission with its time, length and tone", () => {
		const tx = summary({
			kind: "analog-transmission",
			protocol: "analog",
			category: "voice",
			title: null,
			fields: [
				{ key: "modulation", label: "Modulation", value: "nfm" },
				{ key: "durationMs", label: "Duration", value: 9000 },
				{ key: "ctcssHz", label: "CTCSS", value: 88.5, unit: "Hz" },
			],
		})
		const v = nowView(input({ items: [tx], channelName: "Ch 16" }))
		expect(v.kind).toBe("tx")
		expect(v.eyebrow).toBe("Last transmission")
		expect(v.big).toBe("Ch 16")
		expect(v.line).toMatch(/^\d\d:02:39 · 0:09$/)
		expect(v.chips).toEqual([{ k: "CTCSS", v: "88.5 Hz" }])
		expect(v.quiet).toBe("Quiet · last heard 38 s ago")
		expect(nowView(input({ items: [tx], live: true })).eyebrow).toBe(
			"Transmission",
		)
	})

	it("counts vessels in range with the latest report and a message rate", () => {
		const reports = [0, 1, 2, 30].map(s =>
			summary({
				protocol: "ais",
				category: "marine",
				title: "Kerlouan",
				receivedAt: new Date(NOW - s * 1000).toISOString(),
				producedAt: new Date(NOW - s * 1000).toISOString(),
			}),
		)
		const old = summary({
			protocol: "ais",
			category: "marine",
			receivedAt: new Date(NOW - 90_000).toISOString(),
		})
		const v = nowView(
			input({
				items: [...reports, old],
				decoderTypes: ["ais-catcher"],
				count: { fleet: "vessels", n: 14 },
			}),
		)
		expect(v.kind).toBe("count")
		expect(v.big).toBe("14")
		expect(v.bigUnit).toBe("vessels")
		expect(v.line).toMatch(/^Latest: Kerlouan/)
		expect(v.rate).toBe("4 msg/min")
		expect(v.rateBars).toHaveLength(30)
		expect(v.rateBars?.[29]).toBe(1)
		expect(v.map).toBe(true)
		expect(v.shortId).toBe("AIS · 14 vessels")
	})

	it("counts aircraft before any report arrives", () => {
		const v = nowView(input({ decoderTypes: ["readsb"], hz: 1_090_000_000 }))
		expect(v.kind).toBe("count")
		expect(v.big).toBe("—")
		expect(v.line).toBe("No report yet")
		expect(v.quiet).toBe("Listening · no report yet")
	})

	it("calls broadcast FM audio only, and keeps the band block when nothing was heard", () => {
		const fm = nowView(input({ modulation: "wfm", hz: 93_500_000 }))
		expect(fm.kind).toBe("audio")
		expect(fm.line).toBe("No decoder for this signal. Audio only.")
		expect(
			nowView(input({ modulation: "nfm", bandMode: "wfm", hz: 93_500_000 }))
				.kind,
		).toBe("audio")
		const plain = nowView(input({ decoderTypes: ["multimon-ng"] }))
		expect(plain.kind).toBe("plain")
		expect(plain.quiet).toBe("Listening · no message yet")
		expect(nowView(input()).quiet).toBeNull()
	})

	it("ignores gaps, scanner results and recordings", () => {
		const v = nowView(
			input({
				items: [
					summary({ kind: "ingestion-gap", category: "other" }),
					summary({ kind: "scanner-result", category: "other" }),
				],
			}),
		)
		expect(v.kind).toBe("plain")
		expect(v.latest).toBeNull()
	})

	it("links an APRS packet to its Map item", () => {
		const v = nowView(
			input({
				items: [
					summary({
						protocol: "aprs",
						category: "aprs",
						title: "F4ABC-9",
						entityKey: "aprs:F4ABC-9",
					}),
				],
			}),
		)
		expect(v.kind).toBe("msg")
		expect(v.quiet).toBe("Listening · last packet 38 s ago")
		expect(v.map).toBe(v.mapId !== null)
	})
})

function page(items: ActivitySummary[]): ActivitySearchPage {
	return {
		items,
		nextPageToken: null,
		replayCursor: "c:1",
		snapshot: { lowBarrier: "0", highWater: "1", expiresAt: "x" },
		searchCoverage: "bounded-projection",
	}
}

describe("tuned card activity", () => {
	it("asks for the channel ± its tolerance", () => {
		expect(spanQuery({ hz: 161_150_000, toleranceHz: 6250 })).toEqual({
			frequencyHz: { min: 161_143_750, max: 161_156_250 },
		})
	})

	it("follows the frequency once it settles, not every step of a drag", async () => {
		vi.useFakeTimers()
		const urls: string[] = []
		const api = new ApiClient({
			fetch: async url => {
				urls.push(url)
				return new Response(JSON.stringify(page([summary()])), { status: 200 })
			},
		})
		const sockets = fakeSockets()
		const events = new EventsClient({ createSocket: sockets.factory })
		events.connect()
		sockets.last().open()
		const tuned = new TunedActivity({ api, events }, { settleMs: 250 })
		tuned.follow({ hz: 160_000_000, toleranceHz: 6250 })
		await vi.advanceTimersByTimeAsync(100)
		tuned.follow({ hz: 160_012_500, toleranceHz: 6250 })
		await vi.advanceTimersByTimeAsync(100)
		tuned.follow({ hz: 160_450_000, toleranceHz: 6250 })
		expect(urls).toHaveLength(0)
		await vi.advanceTimersByTimeAsync(300)
		expect(urls).toHaveLength(1)
		expect(urls[0]).toContain("frequencyMin=160443750")
		expect(tuned.span.get()?.hz).toBe(160_450_000)
		expect(tuned.feed.get().items).toHaveLength(1)
		// the same span again is not a new request
		tuned.follow({ hz: 160_450_000, toleranceHz: 6250 })
		await vi.advanceTimersByTimeAsync(300)
		expect(urls).toHaveLength(1)
		tuned.dispose()
	})

	it("keeps a small list", () => {
		expect(TUNED_MAX_ITEMS).toBeLessThanOrEqual(200)
	})
})
