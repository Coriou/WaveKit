// The Transmission view's merge-gate round: an empty live tone reading is "Not measured" (only the recorder's
// stored null says "No tone heard"), a file kept for its own tone reads "A tone was heard (not stored)", the
// header tile carries the kind's icon, the required read gives up with Retry, one recordings read per open and a
// bounded cache for the player's steps, a later part's own start, no Tone row for AM, the Recordings switch hidden
// under the view, and the known kept value handed to Keep.
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
	ActivitySummary,
	RecordingChangePayload,
	RecordingInventoryItem,
} from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import type { ApiClient } from "../../src/data/api-client.ts"
import {
	keptFileStartOf,
	LATER_PART_GAP_MS,
	recordStarts,
} from "../../src/features/activity/row-time.ts"
import { RecordingsDrawer } from "../../src/features/recordings/RecordingsDrawer.tsx"
import type {
	TransmissionDto,
	TransmissionTone,
} from "../../src/features/transmission/contract.ts"
import { parseFacts } from "../../src/features/transmission/contract.ts"
import {
	cachedTransmission,
	clearTransmissionCache,
	liveToneOf,
	loadTransmission,
	modulationOfRow,
	recorderTone,
	TRANSMISSION_CACHE_MAX,
	TRANSMISSION_CACHE_MS,
	transmissionCacheSize,
	TransmissionTimeoutError,
} from "../../src/features/transmission/load.ts"
import {
	replaceTransmission,
	transmissionNav,
} from "../../src/features/transmission/nav.ts"
import {
	knownRows,
	playAllQueue,
	transmissionIcon,
} from "../../src/features/transmission/TransmissionView.tsx"
import {
	NOT_MEASURED_WORDS,
	recordingChangeFields,
	TONE_NOT_STORED,
	toneRow,
} from "../../src/features/transmission/words.ts"
import { json, scripted } from "../data/fake-fetch.ts"

const src = (path: string) =>
	readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8")

const KEY = "scan:d_A~analog-1.wav"

const item = (
	over: Partial<RecordingInventoryItem> = {},
): RecordingInventoryItem => ({
	id: KEY,
	key: KEY,
	kind: "scanner-analog",
	decoderId: null,
	discoveryId: "d_A",
	ownerDiscoveryId: "d_A",
	startedAtLocal: null,
	modifiedAt: "2026-11-23T17:30:40.000Z",
	bytes: 128_000,
	durationMs: 8000,
	callType: null,
	talkgroup: null,
	source: null,
	frequencyHz: 145_562_500,
	startedAt: "2026-11-23T17:30:21.000Z",
	...over,
})

const FACTS = {
	version: 1,
	operationId: "00000000-0000-4000-8000-000000000001",
	discoveryId: "d_A",
	observationId: "o_A",
	frequencyHz: 145_562_753,
	startedAt: "2026-11-23T17:30:21.000Z",
	endedAt: "2026-11-23T17:30:29.000Z",
	keptAt: "2026-11-23T17:30:40.000Z",
	durationMs: 8000,
	finish: {
		cut: "completed",
		keptBy: "content",
		speechHeard: true,
		cutActive: null,
	},
	admission: null,
}

let seq = 0
function row(over: Partial<ActivitySummary> = {}): ActivitySummary {
	seq += 1
	return {
		eventId: `evt_f${seq}`,
		commitSeq: String(seq),
		kind: "analog-transmission",
		producedAt: "2026-11-23T17:30:40.000Z",
		receivedAt: "2026-11-23T17:30:40.000Z",
		decoderId: null,
		sourceId: "rx",
		protocol: "analog",
		category: "voice",
		frequencyHz: 145_562_500,
		entityKey: null,
		title: "NFM 145.5625 MHz",
		fields: [],
		...over,
	}
}

/** A live record as the core stores it, with `tone` as given (absent when undefined). */
function liveRecord(eventId: string, tone: unknown, modulation = "nfm") {
	return {
		version: 1,
		eventId,
		commitSeq: "1",
		producedAt: "2026-11-23T17:30:40.000Z",
		receivedAt: "2026-11-23T17:30:40.000Z",
		kind: "analog-transmission",
		payload: {
			transmissionId: "t1",
			sourceId: "rx",
			modulation,
			frequency: { hz: 145_562_500 },
			startedAt: "2026-11-23T17:30:21.000Z",
			endedAt: "2026-11-23T17:30:29.000Z",
			durationMs: 8000,
			bandwidthHz: 12_500,
			squelchMode: "manual",
			peakChannelPowerDbfs: -20,
			closeReason: "squelch",
			...(tone === undefined ? {} : { tone }),
		},
	}
}

let services: AppServices | null = null
afterEach(() => {
	vi.useRealTimers()
	transmissionNav.set(null)
	clearTransmissionCache()
	recordStarts.set(new Map())
	services?.dispose()
	services = null
})

describe("B1. an empty live tone reading is not measured", () => {
	// the shapes the core writes (src/core/analog-transmission.ts): gateTone under 0.75 s of audio, the detector
	// failing at creation or throwing at the end, and records from cores before the DCS check (no dcs key)
	const shapes: [string, unknown][] = [
		["under 0.75 s of audio", { ctcssHz: null, dtmf: null, dcs: null }],
		["short audio, DTMF heard", { ctcssHz: null, dtmf: "12", dcs: null }],
		["the detector failed", { ctcssHz: null, dtmf: null, dcs: null }],
		["an old record without dcs", { ctcssHz: null, dtmf: null }],
	]
	for (const [name, raw] of shapes)
		it(`${name}: Not measured, with the hint`, () => {
			const t = liveToneOf(raw)
			expect(t).toMatchObject({
				state: "not-measured",
				from: "live-demod",
				why: "live-none",
			})
			const r = toneRow(t)
			expect(r.value).toBe("Not measured")
			expect(r.hint).toBe(
				"The live demodulator stores no tone when the audio was too short, the detector failed, or the core predates the check",
			)
		})

	it("an old record is not taken as having checked DCS", () => {
		expect(liveToneOf({ ctcssHz: null, dtmf: null })).toMatchObject({
			dcsChecked: false,
		})
		expect(liveToneOf({ ctcssHz: null, dtmf: null, dcs: null })).toMatchObject({
			dcsChecked: true,
		})
	})

	it("through the loader: a live record's empty tone is Not measured", async () => {
		const summary = row()
		const { api } = scripted(() =>
			json(200, liveRecord(summary.eventId, { ctcssHz: null, dcs: null })),
		)
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary },
		)
		expect(knownRows(t).find(r => r.term === "Tone")?.value).toBe(
			"Not measured",
		)
	})

	it('"No tone heard" comes only from the recorder\'s stored null', () => {
		const facts = parseFacts({ ...FACTS, tone: null })
		expect(toneRow(recorderTone(facts))).toMatchObject({
			value: "No tone heard",
		})
		// a "none" from any other source never says it
		const none: TransmissionTone = {
			state: "none",
			ctcssHz: null,
			dcs: null,
			dcsChecked: true,
			from: "live-demod",
			why: null,
		}
		expect(toneRow(none).value).toBe("Not measured")
		expect(toneRow({ ...none, from: null }).value).toBe("Not measured")
	})

	it("a heard live tone still reads as its value", () => {
		expect(toneRow(liveToneOf({ ctcssHz: 88.5, dcs: null })).value).toBe(
			"CTCSS 88.5 Hz",
		)
	})
})

describe("M2. the recorder's tone follows keptBy", () => {
	it("kept for its own tone with no stored tone: a tone was heard (not stored)", () => {
		const absent = parseFacts({ ...FACTS, finish: { ...FACTS.finish } })
		for (const t of [
			recorderTone(absent, "own-tone"),
			recorderTone(null, "own-tone"),
			recorderTone(
				parseFacts({
					...FACTS,
					finish: { ...FACTS.finish, keptBy: "own-tone" },
				}),
			),
		]) {
			const r = toneRow(t)
			expect(r).toEqual({ value: TONE_NOT_STORED, hint: null })
			expect(r.value).toBe("A tone was heard (not stored)")
		}
	})

	it("through the loader, from the item's keptBy when it has no facts", async () => {
		const { api } = scripted(() =>
			json(404, { error: { code: "NOT_FOUND", message: "x" } }),
		)
		const t = await loadTransmission(
			{ recording: KEY },
			{
				api,
				recordings: () => [item({ keptBy: "own-tone" })],
				optionalMs: 50,
			},
		)
		expect(knownRows(t).find(r => r.term === "Tone")?.value).toBe(
			"A tone was heard (not stored)",
		)
	})

	it("a stored tone still wins over keptBy", () => {
		const facts = parseFacts({
			...FACTS,
			finish: { ...FACTS.finish, keptBy: "own-tone" },
			tone: { kind: "ctcss", hz: 88.5 },
		})
		expect(toneRow(recorderTone(facts)).value).toBe("CTCSS 88.5 Hz")
	})

	it("an undetermined tone is worded neutrally: no cause the data cannot show", () => {
		const facts = parseFacts(FACTS)
		expect(toneRow(recorderTone(facts))).toEqual({
			value: "Not measured",
			hint: "Not determined for this recording",
		})
		for (const hint of Object.values(NOT_MEASURED_WORDS))
			expect(hint).not.toMatch(/steady/)
	})
})

function dto(over: Partial<TransmissionDto>): TransmissionDto {
	return {
		id: null,
		refs: {
			recordingKeys: [],
			eventIds: [],
			observationId: null,
			discoveryId: null,
			ownerDiscoveryId: null,
			operationId: null,
		},
		kind: "voice-analog",
		recordingKind: null,
		protocol: "analog-nfm",
		sourceId: null,
		channel: { hz: 145_562_500, measuredHz: null, name: null },
		startedAt: null,
		endedAt: null,
		durationMs: 8000,
		close: null,
		part: null,
		tone: null,
		identity: null,
		signal: null,
		verdict: { speech: "unchecked", keptBy: null, itemCut: null },
		admission: null,
		artefacts: [],
		noAudioReason: null,
		group: null,
		sameTime: null,
		channelSummary: null,
		gone: [],
		raw: { recording: null, activity: null, facts: null, observation: null },
		...over,
	}
}

describe("M3. the header tile carries the kind's icon", () => {
	it("the Recordings rows' icon for its recording's kind; none for a live transmission", () => {
		expect(transmissionIcon(dto({ recordingKind: "scanner-analog" }))).toBe(
			"scan",
		)
		expect(transmissionIcon(dto({ recordingKind: "dsd-fme-call" }))).toBe(
			"voice",
		)
		const audio = {
			kind: "audio" as const,
			id: "r1",
			inventoryId: null,
			bytes: 0,
			durationMs: null,
			state: "kept",
			kept: null,
			expiresAt: null,
		}
		expect(
			transmissionIcon(dto({ kind: "voice-digital", artefacts: [audio] })),
		).toBe("voice")
		expect(transmissionIcon(dto({}))).toBeNull()
	})

	it("the loader names the kind, and the tile is never empty", async () => {
		const { api } = scripted(() =>
			json(404, { error: { code: "NOT_FOUND", message: "x" } }),
		)
		const t = await loadTransmission(
			{ recording: KEY },
			{ api, recordings: () => [item()], optionalMs: 50 },
		)
		expect(t.recordingKind).toBe("scanner-analog")
		const view = src("features/transmission/TransmissionView.tsx")
		expect(view).not.toContain(
			'<span className="wk-tile" data-tone="accent" aria-hidden="true" />',
		)
		expect(view).toContain("<RecIcon name={icon} />")
	})
})

describe("m4. Play all plays every part", () => {
	it("its queue is a Play all, whatever Auto-next says", () => {
		const q = playAllQueue({ source: "recordings", ids: ["a", "b"] })
		expect(q.playAll).toBe(true)
		expect(src("features/transmission/TransmissionView.tsx")).toContain(
			"playAllQueue(queue)",
		)
	})
})

describe("m5. focus goes to Back only when the view opens", () => {
	it("the player moving it on keeps focus where it is", () => {
		const view = src("features/transmission/TransmissionView.tsx")
		expect(view).not.toContain("focus({ preventScroll: true }), [key])")
		expect(view).toContain("focus({ preventScroll: true }), [])")
	})
})

describe("m6. the required read gives up, and the view offers Retry", () => {
	it("rejects with a timeout when the core never answers", async () => {
		vi.useFakeTimers()
		const api: Pick<ApiClient, "get"> = {
			get: () => new Promise<never>(() => undefined),
		}
		const p = loadTransmission({ recording: KEY }, { api, requiredMs: 1000 })
		const caught = p.catch((e: unknown) => e)
		await vi.advanceTimersByTimeAsync(1001)
		expect(await caught).toBeInstanceOf(TransmissionTimeoutError)
	})

	it("an event without its row times out too", async () => {
		vi.useFakeTimers()
		const api: Pick<ApiClient, "get"> = {
			get: () => new Promise<never>(() => undefined),
		}
		const caught = loadTransmission(
			{ event: "evt_x" },
			{ api, requiredMs: 500 },
		).catch((e: unknown) => e)
		await vi.advanceTimersByTimeAsync(501)
		expect(await caught).toBeInstanceOf(TransmissionTimeoutError)
	})

	it("the client is given the required deadline too", async () => {
		const seen: (number | undefined)[] = []
		const api: Pick<ApiClient, "get"> = {
			get: <T>(_path: string, options?: { timeoutMs?: number }) => {
				seen.push(options?.timeoutMs)
				return Promise.resolve({ items: [] } as T)
			},
		}
		await loadTransmission({ recording: KEY }, { api, requiredMs: 1234 }).catch(
			() => undefined,
		)
		expect(seen[0]).toBe(1234)
	})

	it("the error state has a Retry button", () => {
		expect(src("features/transmission/TransmissionView.tsx")).toMatch(
			/setAttempt\(n => n \+ 1\)\}\s*>\s*Retry/,
		)
	})
})

describe("m7. one recordings read per open, and a bounded cache for the player's steps", () => {
	function core(items: RecordingInventoryItem[]) {
		return scripted(call => {
			const path = new URL(call.url, "http://core").pathname
			if (path === "/api/recordings")
				return json(200, { items, nextCursor: null })
			return json(404, { error: { code: "NOT_FOUND", message: path } })
		})
	}
	const readsOf = (calls: { url: string }[]) =>
		calls.filter(
			c => new URL(c.url, "http://core").pathname === "/api/recordings",
		)

	it("a recording ref reads its folder once, for the file and its neighbours", async () => {
		const { api, calls } = core([item()])
		const t = await loadTransmission(
			{ recording: KEY },
			{ api, optionalMs: 50 },
		)
		expect(t.artefacts[0]?.id).toBe(KEY)
		expect(readsOf(calls)).toHaveLength(1)
	})

	it("an Activity row with its file reads the folder once too", async () => {
		const { api, calls } = core([item()])
		const summary = row({
			kind: "recording-change",
			recording: { id: KEY, durationMs: 8000 },
		} as Partial<ActivitySummary>)
		await loadTransmission(
			{ event: summary.eventId },
			{ api, summary, optionalMs: 50 },
		)
		expect(readsOf(calls)).toHaveLength(1)
	})

	it("the player's steps answer from the cache; a fresh open reads again", async () => {
		const { api, calls } = core([item()])
		const a = await loadTransmission(
			{ recording: KEY },
			{ api, optionalMs: 50 },
		)
		const n = calls.length
		const b = await loadTransmission(
			{ recording: KEY },
			{ api, optionalMs: 50, cached: true },
		)
		expect(b).toBe(a)
		expect(calls.length).toBe(n)
		await loadTransmission({ recording: KEY }, { api, optionalMs: 50 })
		expect(calls.length).toBeGreaterThan(n)
	})

	it("is bounded in size and age", async () => {
		const { api } = core([])
		const t0 = 1_000_000
		for (let i = 0; i < TRANSMISSION_CACHE_MAX + 5; i++)
			await loadTransmission(
				{ event: `evt_c${i}` },
				{
					api,
					summary: row({ eventId: `evt_c${i}` }),
					optionalMs: 20,
					now: () => t0,
				},
			)
		expect(transmissionCacheSize()).toBe(TRANSMISSION_CACHE_MAX)
		// the oldest went first
		expect(cachedTransmission({ event: "evt_c0" }, t0)).toBeUndefined()
		const last = { event: `evt_c${TRANSMISSION_CACHE_MAX + 4}` }
		expect(cachedTransmission(last, t0)).toBeDefined()
		expect(
			cachedTransmission(last, t0 + TRANSMISSION_CACHE_MS + 1),
		).toBeUndefined()
	})

	it("the view uses the cache only when it follows the player", () => {
		transmissionNav.set({
			ref: { recording: "a" },
			origin: { host: "recordings", label: "Recordings" },
			summary: null,
		})
		replaceTransmission({ recording: "b" }, null, true)
		expect(transmissionNav.get()?.follow).toBe(true)
		replaceTransmission({ recording: "c" })
		expect(transmissionNav.get()?.follow).toBeUndefined()
		expect(src("features/transmission/TransmissionView.tsx")).toContain(
			"cached: opened.current.follow === true && attempt === 0",
		)
	})
})

describe("m8. a later part's start is its own", () => {
	const payload = (
		over: Partial<RecordingChangePayload> = {},
	): RecordingChangePayload => ({
		change: "finalized",
		recordingId: KEY,
		recordingKind: "scanner-analog",
		discoveryId: "d_A",
		observationId: "o_A",
		sourceId: "rx",
		frequencyHz: 145_562_753,
		observationStartedAt: "2026-11-23T17:30:00.000Z",
		durationMs: 120_000,
		finalizedAt: "2026-11-23T17:32:02.000Z",
		...over,
	})

	it("the first part starts with its observation", () => {
		expect(keptFileStartOf(payload())).toBe("2026-11-23T17:30:00.000Z")
	})

	it("a later part starts at its keep less its length", () => {
		// part 3 of a long transmission: kept at 17:36:02, 120 s long
		const p = payload({
			finalizedAt: "2026-11-23T17:36:02.000Z",
			durationMs: 120_000,
		})
		expect(keptFileStartOf(p)).toBe("2026-11-23T17:34:02.000Z")
		expect(recordingChangeFields(p).find(f => f.key === "started")).toBeTruthy()
	})

	it("the gap rule's edge", () => {
		const obs = Date.parse("2026-11-23T17:30:00.000Z")
		const at = (gap: number) =>
			keptFileStartOf(
				payload({
					finalizedAt: new Date(obs + gap + 8000).toISOString(),
					durationMs: 8000,
				}),
			)
		expect(at(LATER_PART_GAP_MS)).toBe("2026-11-23T17:30:00.000Z")
		expect(at(LATER_PART_GAP_MS + 1000)).toBe(
			new Date(obs + LATER_PART_GAP_MS + 1000).toISOString(),
		)
	})

	it("a kept file known only through Activity takes its own start", async () => {
		const summary = row({ kind: "recording-change", title: "FM voice" })
		const p = payload({ finalizedAt: "2026-11-23T17:36:02.000Z" })
		const { api } = scripted(call =>
			new URL(call.url, "http://core").pathname.startsWith("/api/activity/")
				? json(200, {
						version: 1,
						eventId: summary.eventId,
						commitSeq: "1",
						producedAt: p.finalizedAt,
						receivedAt: p.finalizedAt,
						kind: "recording-change",
						payload: p,
					})
				: json(200, { items: [], nextCursor: null }),
		)
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary, optionalMs: 50 },
		)
		expect(t.startedAt).toBe("2026-11-23T17:34:02.000Z")
	})
})

describe("m10. AM never gets a Tone row", () => {
	const failing = () =>
		scripted(() => json(500, { error: { code: "INTERNAL", message: "down" } }))

	it("a live AM row whose record cannot be read has no Tone row", async () => {
		const summary = row({
			title: "AM 124.1000 MHz",
			fields: [{ key: "modulation", label: "Modulation", value: "am" }],
		})
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api: failing().api, summary, optionalMs: 50 },
		)
		expect(t.tone).toBeNull()
		expect(t.protocol).toBe("analog-am")
		expect(knownRows(t).some(r => r.term === "Tone")).toBe(false)
	})

	it("the title says AM when the row has no Modulation field", () => {
		expect(modulationOfRow(row({ title: "AM 124.1000 MHz" }))).toBe("am")
		expect(modulationOfRow(row({ title: "Transmission" }))).toBeNull()
	})

	it("an FM row whose record cannot be read keeps its Tone row, not measured", async () => {
		const summary = row({
			fields: [{ key: "modulation", label: "Modulation", value: "nfm" }],
		})
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api: failing().api, summary, optionalMs: 50 },
		)
		expect(t.tone).toMatchObject({ state: "not-measured", why: "no-record" })
	})

	it("a read AM record has no Tone row either", async () => {
		const summary = row({ title: "AM 124.1000 MHz" })
		const { api } = scripted(() =>
			json(200, liveRecord(summary.eventId, { ctcssHz: null }, "am")),
		)
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary, optionalMs: 50 },
		)
		expect(t.tone).toBeNull()
	})
})

function render(node: ReturnType<typeof createElement>): string {
	services = createServices()
	return renderToStaticMarkup(
		createElement(ServicesContext.Provider, { value: services }, node),
	)
}

describe("m11. the All / Kept switch is hidden while the view is open in Recordings", () => {
	it("not in the header under the view; there over the list", () => {
		transmissionNav.set({
			ref: { recording: KEY },
			origin: { host: "recordings", label: "Recordings" },
			summary: null,
		})
		const open = render(
			createElement(RecordingsDrawer, { onClose: () => undefined }),
		)
		expect(open).toContain('aria-label="Transmission"')
		expect(open).not.toContain('aria-label="Show"')
		services?.dispose()
		transmissionNav.set(null)
		const list = render(
			createElement(RecordingsDrawer, { onClose: () => undefined }),
		)
		expect(list).toContain('aria-label="Show"')
	})
})

describe("m12. Keep gets the known kept value", () => {
	it("the loader says kept, not kept, or not known; the view passes it", async () => {
		const { api } = scripted(() =>
			json(404, { error: { code: "NOT_FOUND", message: "x" } }),
		)
		const kept = await loadTransmission(
			{ recording: KEY },
			{ api, recordings: () => [item({ kept: true })], optionalMs: 50 },
		)
		expect(kept.artefacts[0]?.kept).toBe(true)
		clearTransmissionCache()
		const unknown = await loadTransmission(
			{ recording: KEY },
			{ api, recordings: () => [item()], optionalMs: 50 },
		)
		expect(unknown.artefacts[0]?.kept).toBeNull()
		// a row's file, its catalogue entry not read: not known, never "not kept"
		const summary = row({
			kind: "recording-change",
			recording: { id: KEY, durationMs: 8000 },
		} as Partial<ActivitySummary>)
		const fromRow = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary, optionalMs: 50 },
		)
		expect(fromRow.artefacts[0]?.kept).toBeNull()
		expect(src("features/transmission/TransmissionView.tsx")).toContain(
			"kept={state.t.artefacts[0]?.kept ?? null}",
		)
	})
})
