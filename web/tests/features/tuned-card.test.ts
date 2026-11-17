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
	attachRecordings,
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

	describe("a scanner recording rides on its transmission", () => {
		const tx = (at: string, over: Partial<ActivitySummary> = {}) =>
			summary({
				kind: "analog-transmission",
				protocol: "analog",
				category: "voice",
				title: null,
				producedAt: at,
				receivedAt: at,
				fields: [
					{ key: "durationMs", label: "Duration", value: 9000 },
					{ key: "ctcssHz", label: "CTCSS", value: 88.5, unit: "Hz" },
					{ key: "transcript", label: "Transcript", value: "on my way" },
				],
				...over,
			})
		const rec = (at: string, id: string, over: Partial<ActivitySummary> = {}) =>
			summary({
				kind: "recording-change",
				protocol: "analog",
				category: "voice",
				decoderId: null,
				title: "Recording 160.45 MHz",
				producedAt: at,
				receivedAt: at,
				fields: [
					{ key: "durationMs", label: "Duration", value: 9000, unit: "ms" },
				],
				recording: { id, durationMs: 9000 },
				...over,
			})

		it("keeps the latest a transmission, with its tone, transcript and the disc", () => {
			const older = tx("2026-10-17T12:00:00.000Z")
			const latest = tx("2026-10-17T12:02:39.000Z")
			const v = nowView(
				input({
					items: [
						rec("2026-10-17T12:02:45.000Z", "scan:d~b.wav"),
						latest,
						rec("2026-10-17T12:00:05.000Z", "scan:d~a.wav"),
						older,
					],
					channelName: "Ch 16",
				}),
			)
			expect(v.kind).toBe("tx")
			expect(v.latest?.eventId).toBe(latest.eventId)
			expect(v.latest?.recording?.id).toBe("scan:d~b.wav")
			expect(v.body).toBe("“on my way”")
			expect(v.chips).toEqual([{ k: "CTCSS", v: "88.5 Hz" }])
			expect(v.latestRow?.item.recording?.id).toBe("scan:d~b.wav")
			// the earlier row is the older transmission carrying its own file, never a recording row of its own
			expect(v.earlier.map(r => r.id)).toEqual([older.eventId])
			expect(v.earlier[0]?.a).toBe("Transmission")
			expect(v.earlier[0]?.item.recording?.id).toBe("scan:d~a.wav")
		})

		it("never pairs a file with another channel's transmission", () => {
			const other = tx("2026-10-17T12:02:39.000Z", { frequencyHz: 161_000_000 })
			const v = nowView(
				input({
					items: [rec("2026-10-17T12:02:45.000Z", "scan:d~b.wav"), other],
				}),
			)
			expect(v.latest?.kind).toBe("recording-change")
			// a recording without its transmission reads as one, not as a call
			expect(v.kind).toBe("tx")
			expect(v.latestRow?.item.recording?.id).toBe("scan:d~b.wav")
			expect(v.earlier[0]?.item.recording).toBeUndefined()
		})

		// times on 2026-10-17 12:00 (seconds, fractions allowed); a transmission's producedAt is its end
		const T = (sec: number) =>
			new Date(
				Date.parse("2026-10-17T12:00:00.000Z") + sec * 1000,
			).toISOString()
		const txOf = (
			startS: number,
			endS: number,
			over: Partial<ActivitySummary> = {},
		) =>
			tx(T(endS), {
				fields: [
					{
						key: "durationMs",
						label: "Duration",
						value: (endS - startS) * 1000,
					},
				],
				...over,
			})
		const recOf = (
			keptS: number,
			id: string,
			lenS: number,
			startS: number | null = null,
		) =>
			rec(T(keptS), id, {
				fields: [
					{
						key: "durationMs",
						label: "Duration",
						value: lenS * 1000,
						unit: "ms",
					},
					...(startS === null
						? []
						: [
								{
									key: "observationStartedAt",
									label: "Started",
									value: T(startS),
								},
							]),
				],
				recording: { id, durationMs: lenS * 1000 },
			})
		const rows = (items: ActivitySummary[]) =>
			attachRecordings(
				[...items].sort(
					(a, b) => Date.parse(b.producedAt) - Date.parse(a.producedAt),
				),
			)

		it("pairs a file with its own transmission, not a later one on the channel still going when it was kept", () => {
			// A 12:00:00–:09, B :11–:20 without a file; A's file kept at :16
			for (const start of [null, 0]) {
				const a = txOf(0, 9)
				const b = txOf(11, 20)
				const out = rows([a, b, recOf(16, "scan:d~a.wav", 9, start)])
				expect(out.map(r => r.eventId)).toEqual([b.eventId, a.eventId])
				expect(out[1]?.recording?.id).toBe("scan:d~a.wav")
				expect(out[0]?.recording).toBeUndefined()
			}
		})

		it("without the start, a file kept after two open transmissions rides only on the one its length matches", () => {
			// A :00–:09 (9 s), B :11–:23 (12 s); A's 9 s file kept at :25, after both ended
			const a = txOf(0, 9)
			const b = txOf(11, 23)
			const alone = rows([a, b, recOf(25, "scan:d~a.wav", 9)])
			expect(alone.map(r => r.eventId)).toEqual([b.eventId, a.eventId])
			expect(alone[1]?.recording?.id).toBe("scan:d~a.wav")
			expect(alone[0]?.recording).toBeUndefined()
			// B recorded too (its 12 s file kept at :26): each keeps its own, no swap
			const both = rows([
				a,
				b,
				recOf(25, "scan:d~a.wav", 9),
				recOf(26, "scan:d~b.wav", 12),
			])
			expect(both.map(r => r.eventId)).toEqual([b.eventId, a.eventId])
			expect(both[0]?.recording?.id).toBe("scan:d~b.wav")
			expect(both[1]?.recording?.id).toBe("scan:d~a.wav")
		})

		it("without the start, a file two equal-length transmissions could close stays its own row", () => {
			// A :00–:09 and B :11–:20 (both 9 s); A's 9 s file kept at :25
			const a = txOf(0, 9)
			const b = txOf(11, 20)
			const ra = recOf(25, "scan:d~a.wav", 9)
			const out = rows([a, b, ra])
			expect(out.map(r => r.eventId)).toEqual([
				ra.eventId,
				b.eventId,
				a.eventId,
			])
			expect(out[0]?.recording?.id).toBe("scan:d~a.wav")
			expect(out[1]?.recording).toBeUndefined()
			expect(out[2]?.recording).toBeUndefined()
			// B recorded too (kept at :26): neither file is laid on the other's transmission
			const rb = recOf(26, "scan:d~b.wav", 9)
			const both = rows([a, b, ra, rb])
			expect(both.map(r => r.eventId)).toEqual([
				rb.eventId,
				ra.eventId,
				b.eventId,
				a.eventId,
			])
			expect(both[2]?.recording).toBeUndefined()
			expect(both[3]?.recording).toBeUndefined()
		})

		it("a file kept before its transmission's row arrives stands alone, then rides on it", () => {
			const r = recOf(12, "scan:d~a.wav", 9, 0)
			expect(rows([r]).map(x => x.eventId)).toEqual([r.eventId])
			const a = txOf(0, 9)
			const out = rows([r, a])
			expect(out.map(x => x.eventId)).toEqual([a.eventId])
			expect(out[0]?.recording?.id).toBe("scan:d~a.wav")
		})

		it("a rollover's parts all ride on their one transmission, which plays the first part", () => {
			// one transmission :00–:30, three 10 s files kept as it rolled over and at its end
			for (const start of [null, 0]) {
				const a = txOf(0, 30)
				const out = rows([
					a,
					recOf(10, "scan:d~p1.wav", 10, start),
					recOf(20, "scan:d~p2.wav", 10, start),
					recOf(30.5, "scan:d~p3.wav", 10, start),
				])
				expect(out.map(x => x.eventId)).toEqual([a.eventId])
				expect(out[0]?.recording?.id).toBe("scan:d~p1.wav")
			}
		})

		it("a file without its transmission in the list stays one row beside a later transmission", () => {
			// its transmission (≈ :07–:16) is not in the list; B :11–:20 was still going when it was kept
			const b = txOf(11, 20)
			const r = recOf(16, "scan:d~x.wav", 9)
			const out = rows([b, r])
			expect(out.map(x => x.eventId)).toEqual([b.eventId, r.eventId])
			expect(out[0]?.recording).toBeUndefined()
			expect(out[1]?.recording?.id).toBe("scan:d~x.wav")
		})

		it("matches the observation start within 2 s and the keep from 1 s before the end to 120 s after", () => {
			const one = (r: ActivitySummary) => {
				const a = txOf(0, 9)
				const out = rows([a, r])
				return out.find(x => x.eventId === a.eventId)?.recording?.id ?? null
			}
			// start: tx start :00, observation at +2 s attaches, past it does not
			expect(one(recOf(10, "s~ok.wav", 9, 2))).toBe("s~ok.wav")
			expect(one(recOf(10, "s~ok.wav", 9, -2))).toBe("s~ok.wav")
			expect(one(recOf(10, "s~late.wav", 9, 2.001))).toBeNull()
			// keep: from end − 1 s (:08) to end + 120 s (:129)
			expect(one(recOf(8, "s~ok.wav", 9, 0))).toBe("s~ok.wav")
			expect(one(recOf(7.999, "s~early.wav", 9, 0))).toBeNull()
			expect(one(recOf(129, "s~ok.wav", 9, 0))).toBe("s~ok.wav")
			expect(one(recOf(129.001, "s~stale.wav", 9, 0))).toBeNull()
			// without the start: the keep window, and a file no longer than the transmission + 2 s
			expect(one(recOf(129, "s~ok.wav", 11))).toBe("s~ok.wav")
			expect(one(recOf(129.001, "s~stale.wav", 9))).toBeNull()
			expect(one(recOf(10, "s~long.wav", 11.001))).toBeNull()
		})

		it("gives the latest no disc without a recording", () => {
			const v = nowView(input({ items: [tx("2026-10-17T12:02:39.000Z")] }))
			expect(v.latestRow).toBeNull()
		})
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
