// The Transmission view's second round of fixes: a live row whose record failed is analog voice, the live tone
// read with Zod (anything unreadable is not measured), optional reads in parallel under their deadline, kept
// recordings' Activity rows showing their audio start, Back's focus, the shell closing a host, a slow Open in
// Scanner, and the Recordings list taking focus when its row is gone.
import { readFileSync } from "node:fs"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
	ActivityRecord,
	ActivitySummary,
	RecordingInventoryItem,
} from "@wavekit/api-types"

import {
	noteRecordStart,
	recordingStarts,
	recordStarts,
	rowTimeOf,
} from "../../src/features/activity/row-time.ts"
import { focusListAfterBack } from "../../src/features/recordings/RecordingsDrawer.tsx"
import {
	parseFacts,
	readLiveTone,
} from "../../src/features/transmission/contract.ts"
import type { TransmissionTone } from "../../src/features/transmission/contract.ts"
import {
	liveToneOf,
	loadTransmission,
	recorderTone,
} from "../../src/features/transmission/load.ts"
import type {
	FocusTrigger,
	ShellDoor,
} from "../../src/features/transmission/nav.ts"
import {
	focusAfterBack,
	hostChanged,
	openInScanner,
	openTransmission,
	replaceTransmission,
	transmissionNav,
} from "../../src/features/transmission/nav.ts"
import { knownRows } from "../../src/features/transmission/TransmissionView.tsx"
import { toneRow, toneText } from "../../src/features/transmission/words.ts"
import type { DrawerId } from "../../src/shell/store.ts"
import { shellStore } from "../../src/shell/store.ts"
import { appToast } from "../../src/shell/toast.ts"
import { scannerUi } from "../../src/features/scanner/ui-store.ts"
import type { ApiClient } from "../../src/data/api-client.ts"
import { json, scripted } from "../data/fake-fetch.ts"

const src = (path: string) =>
	readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8")

function fakeShell(drawer: DrawerId | null): ShellDoor & { moves: string[] } {
	const s = { drawer }
	const moves: string[] = []
	return {
		moves,
		getState: () => s,
		openDrawer(id) {
			s.drawer = id
			moves.push(`open:${id}`)
		},
		closeDrawer() {
			s.drawer = null
			moves.push("close")
		},
	}
}

const trigger = (): FocusTrigger => ({ focus: () => undefined })

let seq = 0
function row(over: Partial<ActivitySummary> = {}): ActivitySummary {
	seq += 1
	return {
		eventId: `evt_r${seq}`,
		commitSeq: String(seq),
		kind: "recording-change",
		producedAt: "2026-11-23T17:30:40.000Z",
		receivedAt: "2026-11-23T17:30:40.000Z",
		decoderId: null,
		sourceId: "rx",
		protocol: "analog",
		category: "voice",
		frequencyHz: 145_562_500,
		entityKey: null,
		title: "FM voice",
		fields: [],
		...over,
	}
}

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
		keptBy: "own-tone",
		speechHeard: true,
		cutActive: null,
	},
	admission: null,
}

afterEach(() => {
	vi.useRealTimers()
	transmissionNav.set(null)
	shellStore.closeDrawer()
	appToast.set(null)
	scannerUi.update(s => ({ ...s, openDiscoveryId: null }))
	recordStarts.set(new Map())
})

describe("1. a live transmission's row whose record could not be read", () => {
	it("is analog voice, its Tone not measured with a reason", async () => {
		const summary = row({ kind: "analog-transmission", title: "NFM" })
		const { api } = scripted(() =>
			json(500, { error: { code: "INTERNAL", message: "down" } }),
		)
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary, optionalMs: 50 },
		)
		expect(t.kind).toBe("voice-analog")
		expect(t.tone).toMatchObject({
			state: "not-measured",
			from: "live-demod",
			why: "no-record",
		})
		const tone = knownRows(t).find(r => r.term === "Tone")
		expect(tone?.value).toBe("Not measured")
		expect(tone?.hint).toMatch(/record could not be read/)
	})
})

// near-valid live tone readings, so the property reaches the schema's edges as well as arbitrary values
const nearLiveTone = fc.record(
	{
		ctcssHz: fc.oneof(
			fc.constant(null),
			fc.constantFrom(88.5, 67, 254.1, 0, -1, 1e9, Number.NaN, Infinity),
			fc.double(),
			fc.string(),
		),
		dtmf: fc.oneof(fc.constant(null), fc.string(), fc.anything()),
		dcs: fc.oneof(
			fc.constant(undefined),
			fc.constant(null),
			fc.record(
				{
					code: fc.oneof(
						fc.constantFrom("023", "23", "7", "1234", "089", ""),
						fc.string(),
						fc.integer(),
					),
					polarity: fc.oneof(
						fc.constantFrom("normal", "inverted"),
						fc.string(),
					),
				},
				{ requiredKeys: [] },
			),
			fc.anything(),
		),
	},
	{ requiredKeys: [] },
)

/** A readable live "none" reading: an object with ctcssHz null and no DCS code. */
function isNoneReading(x: unknown): boolean {
	if (x === null || typeof x !== "object" || Array.isArray(x)) return false
	const o = x as { ctcssHz?: unknown; dcs?: unknown }
	return o.ctcssHz === null && (o.dcs === null || o.dcs === undefined)
}

describe("2. the live tone goes through Zod", () => {
	it("anything unreadable is not measured, malformed", () => {
		for (const raw of [
			null,
			{},
			{ dtmf: null },
			{ ctcssHz: Number.NaN, dtmf: null },
			{ ctcssHz: Infinity, dtmf: null },
			{ ctcssHz: "88.5", dtmf: null },
			{ ctcssHz: null, dtmf: null, dcs: { code: 23, polarity: "normal" } },
			{ ctcssHz: null, dtmf: null, dcs: { code: "089", polarity: "normal" } },
			{ ctcssHz: null, dtmf: null, dcs: { code: "023" } },
			[88.5],
			"CTCSS 88.5",
			88.5,
		]) {
			expect(readLiveTone(raw)).toBe("malformed")
			const t = liveToneOf(raw)
			expect(t).toMatchObject({ state: "not-measured", why: "malformed" })
			expect(toneRow(t).value).toBe("Not measured")
		}
	})

	it("readable readings: heard, none, or not stored", () => {
		expect(liveToneOf(undefined)).toMatchObject({ why: "live-none" })
		expect(liveToneOf({ ctcssHz: 88.5, dtmf: null })).toMatchObject({
			state: "heard",
			ctcssHz: 88.5,
			dcsChecked: false,
		})
		expect(
			liveToneOf({
				ctcssHz: null,
				dtmf: null,
				dcs: { code: "23", polarity: "inverted" },
			}),
		).toMatchObject({
			state: "heard",
			dcs: { code: "023", polarity: "inverted" },
			dcsChecked: true,
		})
		// an empty live reading is not a measured absence (binding: short audio, a failed detector, old records)
		expect(
			toneRow(liveToneOf({ ctcssHz: null, dtmf: null, dcs: null })).value,
		).toBe("Not measured")
	})

	it("a live record with tone: null reads as not measured through the loader", async () => {
		const summary = row({ kind: "analog-transmission" })
		const { api } = scripted(() =>
			json(200, {
				version: 1,
				eventId: summary.eventId,
				commitSeq: "1",
				producedAt: "2026-11-23T17:30:40.000Z",
				receivedAt: "2026-11-23T17:30:40.000Z",
				kind: "analog-transmission",
				payload: {
					transmissionId: "t1",
					sourceId: "rx",
					modulation: "nfm",
					frequency: { hz: 145_562_500 },
					startedAt: "2026-11-23T17:30:21.000Z",
					endedAt: "2026-11-23T17:30:29.000Z",
					durationMs: 8000,
					bandwidthHz: 12_500,
					squelchMode: "manual",
					peakChannelPowerDbfs: -20,
					closeReason: "squelch",
					tone: null,
				},
			}),
		)
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary },
		)
		expect(t.tone).toMatchObject({ state: "not-measured", why: "malformed" })
	})

	it("a heard tone holding no showable value is not measured, never NaN Hz", () => {
		const bad = (over: Partial<TransmissionTone>): TransmissionTone => ({
			state: "heard",
			ctcssHz: null,
			dcs: null,
			dcsChecked: false,
			from: "live-demod",
			why: null,
			...over,
		})
		for (const t of [
			bad({ ctcssHz: Number.NaN }),
			bad({ ctcssHz: Infinity }),
			bad({ dcs: { code: 23 as unknown as string, polarity: null } }),
			bad({ dcs: { code: "9x", polarity: null } }),
			bad({}),
		])
			expect(toneRow(t)).toEqual({
				value: "Not measured",
				hint: "The stored tone could not be read",
			})
	})

	// Feature: transmission-view, Property 1: an unreadable tone never reads as "No tone heard"
	// Validates: review finding 2
	it("property: the formatter never throws, and says No tone heard only for the recorder's stored null", () => {
		const raw = fc.oneof(fc.anything(), nearLiveTone)
		fc.assert(
			fc.property(raw, x => {
				// the live demodulator's reading
				const live = toneRow(liveToneOf(x))
				expect(typeof live.value).toBe("string")
				expect(live.value).not.toBe("No tone heard")
				if (isNoneReading(x)) expect(live.value).toBe("Not measured")
				// the recorder's facts carrying it as their tone
				const facts = parseFacts({ ...FACTS, tone: x })
				const kept = toneRow(recorderTone(facts))
				if (kept.value === "No tone heard") expect(x).toBeNull()
				if (toneText(x) === "No tone heard") expect(x).toBeNull()
				// arbitrary facts as a whole
				const any = toneRow(recorderTone(parseFacts(x)))
				if (any.value === "No tone heard")
					expect((x as { tone?: unknown }).tone).toBeNull()
			}),
			{ numRuns: 300 },
		)
	})
})

describe("3. with the row in hand the optional reads run at once, under their deadline", () => {
	it("renders from the row when the client never answers", async () => {
		vi.useFakeTimers()
		const calls: { path: string; timeoutMs: number | undefined }[] = []
		const api: Pick<ApiClient, "get"> = {
			get: <T>(path: string, options?: { timeoutMs?: number }) => {
				calls.push({ path, timeoutMs: options?.timeoutMs })
				return new Promise<T>(() => undefined)
			},
		}
		const summary = row({ recording: { id: KEY, durationMs: 8000 } })
		let done = false
		const p = loadTransmission(
			{ event: summary.eventId },
			{ api, summary, optionalMs: 50 },
		).then(t => {
			done = true
			return t
		})
		await vi.advanceTimersByTimeAsync(0)
		// both reads asked before either answered, each with the optional deadline
		expect(calls.map(c => c.path).sort()).toEqual([
			`/api/activity/${summary.eventId}`,
			"/api/recordings",
		])
		expect(calls.every(c => c.timeoutMs === 50)).toBe(true)
		await vi.advanceTimersByTimeAsync(60)
		expect(done).toBe(true)
		const t = await p
		expect(t.gone).toEqual(expect.arrayContaining(["activity", "audio"]))
		expect(t.refs.eventIds).toEqual([summary.eventId])
	})
})

describe("4. a kept recording's Activity row shows its audio start", () => {
	it("the loaded recording's start, else its record's, else producedAt", () => {
		const kept = row({ recording: { id: KEY, durationMs: 8000 } })
		expect(
			rowTimeOf(kept, {
				recording: "2026-11-23T17:30:21.000Z",
				record: "2026-11-23T17:30:20.000Z",
			}),
		).toBe("2026-11-23T17:30:21.000Z")
		expect(
			rowTimeOf(kept, { recording: null, record: "2026-11-23T17:30:20.000Z" }),
		).toBe("2026-11-23T17:30:20.000Z")
		expect(rowTimeOf(kept, { recording: null, record: "nonsense" })).toBe(
			kept.producedAt,
		)
		// any other row keeps producedAt
		const other = row({ kind: "decoder-reception", category: "aviation-data" })
		expect(
			rowTimeOf(other, { recording: null, record: "2026-11-23T17:30:20.000Z" }),
		).toBe(other.producedAt)
	})

	it("agrees with the Recordings list: its start by key and id", () => {
		const m = recordingStarts([
			item(),
			item({
				id: "dsd~c",
				key: "dsd~c",
				startedAt: null,
				startedAtLocal: "2026-11-23T18:00:00",
			}),
		])
		expect(m.get(KEY)).toBe("2026-11-23T17:30:21.000Z")
		expect(m.get("dsd~c")).toBe(new Date("2026-11-23T18:00:00").toISOString())
	})

	it("a kept file's record carries no start of its own to the row (its observation's start is the transmission's)", async () => {
		const summary = row()
		const record: ActivityRecord = {
			version: 1,
			eventId: summary.eventId,
			commitSeq: "1",
			producedAt: "2026-11-23T17:30:40.000Z",
			receivedAt: "2026-11-23T17:30:40.000Z",
			kind: "recording-change",
			payload: {
				change: "finalized",
				recordingId: "scan:d_A~gone.wav",
				recordingKind: "scanner-analog",
				discoveryId: "d_A",
				observationId: "o_A",
				sourceId: "rx",
				frequencyHz: 145_562_753,
				observationStartedAt: "2026-11-23T17:30:21.000Z",
				durationMs: 8000,
				finalizedAt: "2026-11-23T17:30:40.000Z",
			},
		} as ActivityRecord
		const { api } = scripted(call =>
			new URL(call.url, "http://core").pathname.startsWith("/api/activity/")
				? json(200, record)
				: json(200, { items: [], nextCursor: null }),
		)
		await loadTransmission({ event: summary.eventId }, { api, summary })
		expect(recordStarts.get().get(summary.eventId)).toBeUndefined()
		noteRecordStart(null)
		expect(recordStarts.get().size).toBe(0)
	})

	it("both row kinds show it; the list's order is untouched", () => {
		const list = src("features/activity/ActivityList.tsx")
		expect(list).not.toContain("dateTime={item.producedAt}")
		expect(list.match(/const shown = useRowTime\(item\)/g)).toHaveLength(2)
		expect(src("features/activity/rows.ts")).toContain(
			"Date.parse(s.producedAt)",
		)
	})
})

describe("5. Back onto an event detail focuses the detail", () => {
	it("the detail when it is open under the view, else the list, else the trigger", () => {
		expect(focusAfterBack({ host: "activity", label: "Activity" }, true)).toBe(
			"detail",
		)
		expect(focusAfterBack({ host: "activity", label: "Activity" }, false)).toBe(
			"list",
		)
		expect(
			focusAfterBack(
				{ host: "activity", label: "Back", restoreDrawer: null },
				true,
			),
		).toBe("trigger")
		expect(focusAfterBack(null, false)).toBe("list")
		const drawer = src("shell/drawers/ActivityDrawer.tsx")
		expect(drawer).toContain(
			"focusAfterBack(origin, activity.get().openId !== null)",
		)
	})
})

describe("6. the shell closing the host honours restoreDrawer", () => {
	it("Esc from outside the drawer (or its close button) reopens the drawer that was open before", () => {
		const shell = fakeShell("recordings")
		openTransmission(
			{ event: "e1" },
			{ host: "activity", label: "Back" },
			null,
			shell,
			trigger(),
		)
		expect(transmissionNav.get()?.origin.restoreDrawer).toBe("recordings")
		shell.closeDrawer()
		hostChanged(null, shell)
		expect(transmissionNav.get()).toBeNull()
		expect(shell.moves).toEqual(["open:activity", "close", "open:recordings"])
	})

	it("switching to another drawer, or closing a host opened over nothing, restores nothing", () => {
		const a = fakeShell("recordings")
		openTransmission(
			{ event: "e1" },
			{ host: "activity", label: "Back" },
			null,
			a,
			trigger(),
		)
		a.openDrawer("scanner")
		hostChanged("scanner", a)
		expect(transmissionNav.get()).toBeNull()
		expect(a.moves).toEqual(["open:activity", "open:scanner"])
		const b = fakeShell(null)
		openTransmission(
			{ event: "e2" },
			{ host: "activity", label: "Back" },
			null,
			b,
			trigger(),
		)
		hostChanged(null, b)
		expect(b.moves).toEqual(["open:activity"])
	})
})

describe("7. Open in Scanner after a slow fetch", () => {
	function slowScanner() {
		let answer: (d: { id: string }) => void = () => undefined
		return {
			resolve: (id: string) => answer({ id }),
			door: {
				discovery: () => undefined,
				fetchDiscovery: () =>
					new Promise<{ id: string }>(r => {
						answer = r
					}),
			},
		}
	}

	it("does nothing when the view was closed meanwhile", async () => {
		const shell = fakeShell("recordings")
		transmissionNav.set({
			ref: { recording: KEY },
			origin: { host: "recordings", label: "Recordings" },
			summary: null,
		})
		const s = slowScanner()
		const opened = openInScanner("d_A", s.door, shell)
		transmissionNav.set(null)
		s.resolve("d_A")
		expect(await opened).toBe(false)
		expect(shell.moves).toEqual([])
		expect(scannerUi.get().openDiscoveryId).toBeNull()
	})

	it("does nothing when the view moved to another transmission meanwhile", async () => {
		const shell = fakeShell("recordings")
		transmissionNav.set({
			ref: { recording: KEY },
			origin: { host: "recordings", label: "Recordings" },
			summary: null,
		})
		const s = slowScanner()
		const opened = openInScanner("d_A", s.door, shell)
		replaceTransmission({ recording: "scan:d_A~other.wav" })
		s.resolve("d_A")
		expect(await opened).toBe(false)
		expect(shell.moves).toEqual([])
	})

	it("opens when the view still shows it", async () => {
		const shell = fakeShell("recordings")
		transmissionNav.set({
			ref: { recording: KEY },
			origin: { host: "recordings", label: "Recordings" },
			summary: null,
		})
		const s = slowScanner()
		const opened = openInScanner("d_A", s.door, shell)
		s.resolve("d_A")
		expect(await opened).toBe(true)
		expect(shell.moves).toEqual(["open:scanner"])
	})
})

describe("9. Back onto the Recordings list", () => {
	interface Fake {
		n: number
		tabIndex?: number
		focus(): void
		hasAttribute(name: string): boolean
	}
	const spy = (): Fake => {
		const t: Fake = {
			n: 0,
			focus: () => void (t.n += 1),
			hasAttribute: name => name === "tabindex" && t.tabIndex !== undefined,
		}
		return t
	}
	function doc(
		rows: Record<string, Fake>,
		stop: Fake | null,
		list: Fake | null,
	) {
		return {
			getElementById: (id: string) => rows[id] ?? null,
			querySelector: (sel: string) =>
				sel.includes("[data-row-id]") ? stop : list,
		} as unknown as Pick<Document, "getElementById" | "querySelector">
	}

	it("focuses the open row when it is mounted, else the list's tab stop, else the list", () => {
		const r = spy()
		const stop = spy()
		const l = spy()
		focusListAfterBack(
			{ openId: "a", cursorId: null },
			doc({ "wkr-a": r }, stop, l),
		)
		expect([r.n, stop.n, l.n]).toEqual([1, 0, 0])
		focusListAfterBack({ openId: "gone", cursorId: null }, doc({}, stop, l))
		expect([stop.n, l.n]).toEqual([1, 0])
		focusListAfterBack({ openId: "gone", cursorId: null }, doc({}, null, l))
		expect(l.n).toBe(1)
		// made focusable by script, never a tab stop
		expect(l.tabIndex).toBe(-1)
	})

	it("Back onto the list uses it, unless the view opened the drawer", () => {
		const drawer = src("features/recordings/RecordingsDrawer.tsx")
		expect(drawer).toContain(
			'if (focusAfterBack(origin, false) !== "list") return',
		)
		expect(drawer).toContain("focusListAfterBack(recordingsUi.get(), document)")
	})
})
