// The Transmission view's last fix round: a kept file's start is never guessed (a real start from its recording
// or facts, else its observation's start labelled as the transmission's, and the Activity row falls back to
// producedAt), a file kept for its own tone never reads "No tone heard", the required reads share one deadline
// and the read that hit it is aborted, and a Retry no longer turns the player's cache off for good.
import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
	ActivityRecord,
	ActivitySummary,
	RecordingChangePayload,
	RecordingInventoryItem,
} from "@wavekit/api-types"

import type { ApiClient } from "../../src/data/api-client.ts"
import * as rowTime from "../../src/features/activity/row-time.ts"
import {
	noteRecordStart,
	recordingStarts,
	recordStarts,
	rowTimeOf,
} from "../../src/features/activity/row-time.ts"
import { parseFacts } from "../../src/features/transmission/contract.ts"
import {
	clearTransmissionCache,
	loadTransmission,
	recorderTone,
	TransmissionTimeoutError,
} from "../../src/features/transmission/load.ts"
import {
	knownRows,
	retryGate,
} from "../../src/features/transmission/TransmissionView.tsx"
import {
	recordingChangeFields,
	startText,
	TONE_NOT_STORED,
	toneRow,
	TRANSMISSION_STARTED,
} from "../../src/features/transmission/words.ts"
import { json, scripted } from "../data/fake-fetch.ts"

const src = (path: string) =>
	readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8")

const KEY = "scan:d_A~analog-2.wav"
/** The session's first over started here; this file is its second over, half an hour later. */
const OBS = "2026-11-23T17:00:00.000Z"
const FILE_START = "2026-11-23T17:30:21.000Z"
const KEPT_AT = "2026-11-23T17:30:40.000Z"

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
	modifiedAt: KEPT_AT,
	bytes: 128_000,
	durationMs: 8000,
	callType: null,
	talkgroup: null,
	source: null,
	frequencyHz: 145_562_500,
	startedAt: FILE_START,
	activityEventId: "evt_kept",
	...over,
})

const FACTS = {
	version: 1,
	operationId: "00000000-0000-4000-8000-000000000001",
	discoveryId: "d_A",
	observationId: "o_A",
	frequencyHz: 145_562_753,
	startedAt: FILE_START,
	endedAt: "2026-11-23T17:30:29.000Z",
	keptAt: KEPT_AT,
	durationMs: 8000,
	finish: {
		cut: "completed",
		keptBy: "content",
		speechHeard: true,
		cutActive: null,
	},
	admission: null,
}

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
	observationStartedAt: OBS,
	durationMs: 8000,
	finalizedAt: KEPT_AT,
	...over,
})

const record = (eventId: string, p = payload()): ActivityRecord =>
	({
		version: 1,
		eventId,
		commitSeq: "1",
		producedAt: p.finalizedAt,
		receivedAt: p.finalizedAt,
		kind: "recording-change",
		payload: p,
	}) as ActivityRecord

const keptRow = (over: Partial<ActivitySummary> = {}): ActivitySummary => ({
	eventId: "evt_kept",
	commitSeq: "1",
	kind: "recording-change",
	producedAt: KEPT_AT,
	receivedAt: KEPT_AT,
	decoderId: null,
	sourceId: "rx",
	protocol: "analog",
	category: "voice",
	frequencyHz: 145_562_500,
	entityKey: null,
	title: "FM voice",
	fields: [],
	...over,
})

/** A core that serves `items` as every recordings page and `rec` as every Activity record. */
function core(items: RecordingInventoryItem[], rec: ActivityRecord | null) {
	return scripted(call => {
		const path = new URL(call.url, "http://core").pathname
		if (path === "/api/recordings")
			return json(200, { items, nextCursor: null })
		if (path.startsWith("/api/activity/") && rec !== null) return json(200, rec)
		return json(404, { error: { code: "NOT_FOUND", message: path } })
	})
}

afterEach(() => {
	vi.useRealTimers()
	clearTransmissionCache()
	recordStarts.set(new Map())
})

describe("M-A. a kept file's start is never guessed", () => {
	it("row-time no longer derives a part's start", () => {
		expect("keptFileStartOf" in rowTime).toBe(false)
		expect("LATER_PART_GAP_MS" in rowTime).toBe(false)
		expect(src("features/transmission/words.ts")).not.toContain(
			"keptFileStartOf",
		)
		expect(src("features/transmission/load.ts")).not.toContain(
			"keptFileStartOf",
		)
	})

	it("a second over in the same session shows the catalogue's start, not its observation's", async () => {
		const { api } = core([item()], record("evt_kept"))
		const t = await loadTransmission(
			{ recording: KEY },
			{ api, optionalMs: 50 },
		)
		expect(t.startedAt).toBe(FILE_START)
		expect(knownRows(t).map(r => r.term)).not.toContain(TRANSMISSION_STARTED)
	})

	it("opened from its Activity row, the catalogue's start wins too", async () => {
		const summary = keptRow({ recording: { id: KEY, durationMs: 8000 } })
		const { api } = core([item()], record(summary.eventId))
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary, optionalMs: 50 },
		)
		expect(t.startedAt).toBe(FILE_START)
	})

	it("the facts' start serves when the catalogue item has none", async () => {
		const facts = { ...FACTS, startedAt: "2026-11-23T17:30:22.000Z" }
		const { api } = core(
			[item({ startedAt: null, facts } as Partial<RecordingInventoryItem>)],
			null,
		)
		const t = await loadTransmission(
			{ recording: KEY },
			{ api, optionalMs: 50 },
		)
		expect(t.startedAt).toBe("2026-11-23T17:30:22.000Z")
	})

	it("without a catalogue item: Transmission started and Kept at, never a derived time", async () => {
		const summary = keptRow()
		// a later part: 120 s long, kept 30 min into its observation (the old rule derived 17:28:40 from these)
		const p = payload({ durationMs: 120_000 })
		const { api } = core([], record(summary.eventId, p))
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary, optionalMs: 50 },
		)
		expect(t.startedAt).toBeNull()
		expect(t.endedAt).toBeNull()
		const rows = knownRows(t)
		expect(rows.find(r => r.term === TRANSMISSION_STARTED)?.value).toBe(
			startText(OBS),
		)
		expect(rows.find(r => r.term === "Kept at")?.value).toBe(startText(KEPT_AT))
		expect(rows.map(r => r.term)).not.toContain("Started")
		const derived = new Date(Date.parse(KEPT_AT) - 120_000).toISOString()
		expect(JSON.stringify(rows)).not.toContain(startText(derived))
	})

	it("the Activity detail labels the observation's start as the transmission's", () => {
		const fields = recordingChangeFields(payload({ durationMs: 120_000 }))
		expect(fields.map(f => f.label)).toEqual([
			"Channel",
			"Transmission started",
			"Duration",
			"Kept at",
		])
		expect(fields.find(f => f.label === TRANSMISSION_STARTED)?.value).toBe(
			startText(OBS),
		)
		expect(fields.some(f => f.label === "Started")).toBe(false)
	})

	it("the row time without a real start is producedAt", () => {
		noteRecordStart(record("evt_kept"))
		const known = recordStarts.get().get("evt_kept") ?? null
		expect(known).toBeNull()
		expect(rowTimeOf(keptRow(), { recording: null, record: known })).toBe(
			KEPT_AT,
		)
	})

	it("a real start from the Recordings list or its facts still wins", () => {
		const m = recordingStarts([
			item(),
			item({
				id: "scan:d_A~b.wav",
				key: "scan:d_A~b.wav",
				startedAt: null,
				facts: { ...FACTS, startedAt: "2026-11-23T17:31:00.000Z" },
			} as Partial<RecordingInventoryItem>),
		])
		expect(m.get(KEY)).toBe(FILE_START)
		expect(m.get("scan:d_A~b.wav")).toBe("2026-11-23T17:31:00.000Z")
		expect(
			rowTimeOf(keptRow({ recording: { id: KEY, durationMs: 8000 } }), {
				recording: m.get(KEY) ?? null,
				record: null,
			}),
		).toBe(FILE_START)
	})
})

describe("m1. kept for its own tone never reads No tone heard", () => {
	it("a stored null tone with keptBy own-tone: a tone was heard (not stored)", () => {
		const facts = parseFacts({
			...FACTS,
			tone: null,
			finish: { ...FACTS.finish, keptBy: "own-tone" },
		})
		expect(facts?.tone).toBeNull()
		const r = toneRow(recorderTone(facts))
		expect(r.value).toBe(TONE_NOT_STORED)
		expect(r.value).toBe("A tone was heard (not stored)")
	})

	it("through the loader, next to Kept: Speech heard over a tone", async () => {
		const facts = {
			...FACTS,
			tone: null,
			finish: { ...FACTS.finish, keptBy: "own-tone" },
		}
		const { api } = core(
			[item({ facts } as Partial<RecordingInventoryItem>)],
			null,
		)
		const t = await loadTransmission(
			{ recording: KEY },
			{ api, optionalMs: 50 },
		)
		const rows = knownRows(t)
		expect(rows.find(r => r.term === "Tone")?.value).toBe(TONE_NOT_STORED)
		expect(rows.find(r => r.term === "Kept")?.value).toBe(
			"Speech heard over a tone",
		)
		expect(JSON.stringify(rows)).not.toContain("No tone heard")
	})
})

type GetOptions = { signal?: AbortSignal; timeoutMs?: number }

describe("m2 and m3. one deadline for the required reads, and the late read aborted", () => {
	/** The Activity record answers after `firstMs`; the recordings page never answers. */
	function slowCore(firstMs: number) {
		const signals: { path: string; signal: AbortSignal | undefined }[] = []
		const api: Pick<ApiClient, "get"> = {
			get: <T>(path: string, options?: GetOptions) => {
				signals.push({ path, signal: options?.signal })
				if (path.startsWith("/api/activity/"))
					return new Promise<T>(resolve =>
						setTimeout(() => resolve(record("evt_slow") as T), firstMs),
					)
				return new Promise<T>(() => undefined)
			},
		}
		return { api, signals }
	}

	it("two chained slow reads give up within the one deadline, not twice it", async () => {
		vi.useFakeTimers()
		const { api } = slowCore(10_000)
		let settled: unknown = "pending"
		void loadTransmission(
			{ event: "evt_slow" },
			{ api, requiredMs: 15_000 },
		).then(
			() => (settled = "resolved"),
			(e: unknown) => (settled = e),
		)
		await vi.advanceTimersByTimeAsync(14_999)
		expect(settled).toBe("pending")
		await vi.advanceTimersByTimeAsync(2)
		expect(settled).toBeInstanceOf(TransmissionTimeoutError)
	})

	it("the read that hit the deadline is aborted", async () => {
		vi.useFakeTimers()
		const { api, signals } = slowCore(10_000)
		const caught = loadTransmission(
			{ event: "evt_slow" },
			{ api, requiredMs: 15_000 },
		).catch((e: unknown) => e)
		await vi.advanceTimersByTimeAsync(15_001)
		expect(await caught).toBeInstanceOf(TransmissionTimeoutError)
		const late = signals.find(s => s.path === "/api/recordings")
		expect(late?.signal).toBeDefined()
		expect(late?.signal?.aborted).toBe(true)
	})

	it("the caller's abort reaches the reads too", async () => {
		const { api, signals } = slowCore(10_000)
		const outer = new AbortController()
		const caught = loadTransmission(
			{ event: "evt_slow" },
			{ api, signal: outer.signal, requiredMs: 60_000 },
		).catch((e: unknown) => e)
		outer.abort()
		expect(signals[0]?.signal?.aborted).toBe(true)
		void caught
	})

	it("a finished open leaves no deadline armed", async () => {
		vi.useFakeTimers()
		const { api } = core([item()], null)
		await loadTransmission(
			{ recording: KEY },
			{ api, requiredMs: 15_000, optionalMs: 50 },
		)
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe("m3. a Retry reads afresh once, then the cache serves the player's steps again", () => {
	it("the gate", () => {
		const gate = retryGate()
		expect(gate.cached(true)).toBe(true)
		expect(gate.cached(undefined)).toBe(false)
		gate.retry()
		expect(gate.cached(true)).toBe(false)
		gate.loaded()
		expect(gate.cached(true)).toBe(true)
	})

	it("the view resets it after a successful load", () => {
		const view = src("features/transmission/TransmissionView.tsx")
		expect(view).toContain("cached: gate.cached(opened.current.follow),")
		expect(view).toMatch(
			/if \(abort\.signal\.aborted\) return\s*gate\.loaded\(\)\s*setState\(\{ status: "ready", t \}\)/,
		)
		expect(view).toMatch(/gate\.retry\(\)\s*setAttempt\(n => n \+ 1\)/)
	})
})
