// The Transmission view's review fixes: doors that leave close the view first, a second open keeps the origin,
// the dock opens the playing row, Esc and focus stay in the view, honest tone and not-found words, optional reads
// that degrade, the Conversation's cap, no epoch dates, and the player's Next followed by the view.
import { readFileSync } from "node:fs"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
	ActivitySummary,
	RecordingInventoryItem,
} from "@wavekit/api-types"

import type { TransmissionMember } from "../../src/features/transmission/contract.ts"
import { refText } from "../../src/features/transmission/contract.ts"
import {
	firstTime,
	groupOf,
	loadTransmission,
	MEMBERS_MAX,
	NOT_FOUND_WORDS,
	recordingQueryOf,
	TransmissionNotFoundError,
	windowAround,
} from "../../src/features/transmission/load.ts"
import type {
	ActivityRows,
	FocusTrigger,
	ShellDoor,
} from "../../src/features/transmission/nav.ts"
import {
	backFromTransmission,
	escapeGoesBack,
	followsPlayer,
	openActivityRow,
	openChannelHistory,
	openInScanner,
	openTransmission,
	playingTransmission,
	transmissionNav,
} from "../../src/features/transmission/nav.ts"
import {
	copyValue,
	knownRows,
} from "../../src/features/transmission/TransmissionView.tsx"
import { startText, toneRow } from "../../src/features/transmission/words.ts"
import type { DrawerId } from "../../src/shell/store.ts"
import { shellStore } from "../../src/shell/store.ts"
import { appToast } from "../../src/shell/toast.ts"
import { scannerUi } from "../../src/features/scanner/ui-store.ts"
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

function trigger(connected = true): FocusTrigger & { focused: number } {
	const t = {
		focused: 0,
		isConnected: connected,
		focus() {
			t.focused += 1
		},
	}
	return t
}

let seq = 0
function row(over: Partial<ActivitySummary> = {}): ActivitySummary {
	seq += 1
	return {
		eventId: `evt_${seq}`,
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

function recording(
	over: Partial<RecordingInventoryItem> = {},
): RecordingInventoryItem {
	return {
		id: "dsd~call-1",
		key: "dsd~call-1",
		kind: "dsd-fme-call",
		decoderId: "dsd",
		discoveryId: null,
		startedAtLocal: null,
		modifiedAt: "2026-11-23T17:30:40.000Z",
		bytes: 1000,
		durationMs: 4000,
		callType: null,
		talkgroup: "9",
		source: "1",
		frequencyHz: null,
		...over,
	}
}

afterEach(() => {
	transmissionNav.set(null)
	shellStore.closeDrawer()
	appToast.set(null)
	scannerUi.update(s => ({ ...s, openDiscoveryId: null }))
})

describe("1. a door that leaves closes the view first", () => {
	it("History of … in a view over Activity shows the channel's list itself, nothing restored later", () => {
		const shell = fakeShell(null)
		openTransmission(
			{ event: "evt_1" },
			{ host: "activity", label: "Back" },
			null,
			shell,
			null,
		)
		expect(transmissionNav.get()?.origin.restoreDrawer).toBeNull()
		const show = vi.fn()
		const activity = { update: vi.fn(), setSearch: vi.fn() }
		openChannelHistory(activity, 145_562_500, show)
		// the view and its restoreDrawer are gone before the list is filtered
		expect(transmissionNav.get()).toBeNull()
		expect(show).toHaveBeenCalledWith(activity, 145_562_500, expect.any(Number))
		expect(backFromTransmission(shell)).toBeNull()
		expect(shell.moves).toEqual(["open:activity"])
	})

	it("Open in Scanner closes the view before it opens the Scanner", async () => {
		const shell = fakeShell("activity")
		openTransmission(
			{ event: "evt_1" },
			{ host: "activity", label: "Activity" },
			null,
			shell,
		)
		const seen: (object | null)[] = []
		await openInScanner(
			"d_A",
			{
				discovery: () => ({}),
				fetchDiscovery: () => Promise.reject(new Error("x")),
			},
			{
				openDrawer: id => {
					seen.push(transmissionNav.get())
					shell.openDrawer(id)
				},
			},
		)
		expect(seen).toEqual([null])
	})

	it("every door of the view goes through the closing opener", () => {
		const view = src("features/transmission/TransmissionView.tsx")
		expect(view).toContain("openChannelHistory(services.activity, hz)")
		expect(view).not.toContain("showChannel(")
	})
})

describe("2. a second open in the same host keeps the origin", () => {
	it("replaces only the ref and the summary", () => {
		const shell = fakeShell(null)
		const t = trigger()
		openTransmission(
			{ recording: "a" },
			{ host: "activity", label: "Back" },
			null,
			shell,
			t,
		)
		const first = transmissionNav.get()?.origin
		const summary = row()
		openTransmission(
			{ event: summary.eventId },
			{ host: "activity", label: "Activity" },
			summary,
			shell,
			null,
		)
		const now = transmissionNav.get()
		expect(now?.origin).toBe(first)
		expect(now?.origin).toMatchObject({
			label: "Back",
			restoreDrawer: null,
			trigger: t,
		})
		expect(now?.ref).toEqual({ event: summary.eventId })
		expect(now?.summary).toBe(summary)
		// Back still closes the drawer the first open opened
		backFromTransmission(shell, fn => fn())
		expect(shell.moves).toEqual(["open:activity", "close"])
	})
})

describe("3. the dock opens what plays", () => {
	const lists = (items: ActivitySummary[]): ActivityRows[] => [
		{ get: () => ({ items }) },
	]

	it("an Activity play opens on its row", () => {
		const r = row({ recording: { id: "dsd~call-1", durationMs: 4000 } })
		expect(
			playingTransmission(
				{
					id: "dsd~call-1",
					queue: { source: "activity", ids: ["dsd~call-1"] },
				},
				lists([r]),
			),
		).toEqual({ ref: { event: r.eventId }, summary: r })
	})

	it("a Recordings play, or a row no longer shown, opens on the recording", () => {
		expect(
			playingTransmission(
				{ id: "k", queue: { source: "recordings", ids: ["k"] } },
				lists([]),
			),
		).toEqual({ ref: { recording: "k" }, summary: null })
		expect(
			playingTransmission(
				{ id: "k", queue: { source: "activity", ids: ["k"] } },
				lists([row()]),
			),
		).toEqual({ ref: { recording: "k" }, summary: null })
		expect(playingTransmission({ id: null, queue: null }, lists([]))).toBeNull()
	})

	it("a recording the list has not loaded is read with a keyed recordings query", async () => {
		expect(recordingQueryOf("scan:d_A~x.wav")).toEqual({
			discoveryId: "d_A",
			limit: 200,
		})
		expect(recordingQueryOf("dsd~call-1")).toEqual({ limit: 200 })
		const { api, calls } = scripted(call => {
			const url = new URL(call.url, "http://core")
			if (url.pathname === "/api/recordings")
				return json(200, { items: [recording()], nextCursor: null })
			return json(404, { error: { code: "NOT_FOUND", message: "x" } })
		})
		const t = await loadTransmission({ recording: "dsd~call-1" }, { api })
		expect(t.refs.recordingKeys).toEqual(["dsd~call-1"])
		expect(calls[0]?.url).toContain("limit=200")
	})

	it('says "Not found" with a reason, never "no longer kept"', async () => {
		const { api } = scripted(() => json(200, { items: [], nextCursor: null }))
		const missing = await loadTransmission(
			{ recording: "dsd~gone" },
			{ api },
		).catch((e: unknown) => e)
		expect(missing).toBeInstanceOf(TransmissionNotFoundError)
		expect((missing as TransmissionNotFoundError).reason).toBe(
			NOT_FOUND_WORDS.recordingNewest,
		)
		for (const words of Object.values(NOT_FOUND_WORDS))
			expect(words.toLowerCase()).not.toContain("no longer kept")
		const view = src("features/transmission/TransmissionView.tsx")
		expect(view).toContain("Not found: {state.reason}.")
		expect(view).not.toContain("no longer kept")
	})

	it("the dock title opens through the playing row", () => {
		const dock = src("features/playback/PlayerDock.tsx")
		expect(dock).toContain(
			"playingTransmission(playback.get(), activityLists(activity))",
		)
		expect(dock).not.toContain("openTransmission({ recording: id }")
	})
})

/** A tree of fake nodes: enough for contains and closest. */
class N {
	parent: N | null = null
	constructor(
		readonly tagName = "DIV",
		readonly role: string | null = null,
	) {}
	add(c: N): N {
		c.parent = this
		return c
	}
	contains(n: N | null): boolean {
		for (let p = n; p; p = p.parent) if (p === this) return true
		return false
	}
	closest(sel: string): N | null {
		for (let p: N | null = this; p; p = p.parent)
			if (sel === "[role=menu]" && p.role === "menu") return p
		return null
	}
}

describe("4. Esc in a drawer with an open view goes Back", () => {
	const body = new N("BODY")
	const box = body.add(new N())
	const drawer = box.add(new N("SECTION"))
	const view = drawer.add(new N("SECTION"))
	const row = view.add(new N("BUTTON"))
	const head = drawer.add(new N("BUTTON"))
	const field = drawer.add(new N("INPUT"))
	const menu = view.add(new N("DIV", "menu")).add(new N("BUTTON"))
	const other = body.add(new N("BUTTON"))
	const esc = (target: N, key = "Escape", defaultPrevented = false) =>
		escapeGoesBack({
			key,
			defaultPrevented,
			target: target as unknown as Node,
			view: view as unknown as Node,
			host: drawer as unknown as Node,
		})

	it("from a row, the drawer's own header, the drawer box, or the page after a lost focus", () => {
		expect(esc(row)).toBe(true)
		expect(esc(head)).toBe(true)
		expect(esc(box)).toBe(true)
		expect(esc(body)).toBe(true)
	})

	it("never from a field, a menu, another layer, or a key already handled", () => {
		expect(esc(field)).toBe(false)
		expect(esc(menu)).toBe(false)
		expect(esc(other)).toBe(false)
		expect(esc(row, "Enter")).toBe(false)
		expect(esc(row, "Escape", true)).toBe(false)
	})

	it("is a capture-phase hook, and focus goes to Back when the view opens", () => {
		const viewSrc = src("features/transmission/TransmissionView.tsx")
		expect(viewSrc).toContain('window.addEventListener("keydown", onKey, true)')
		expect(viewSrc).not.toContain("onKeyDown={onKeyDown}")
		expect(viewSrc).toContain(
			"back.current?.focus({ preventScroll: true }), [])",
		)
	})
})

describe("5. a kept recording known only through Activity", () => {
	it("is scanner analog FM with its tone not measured", async () => {
		const summary = row()
		const { api } = scripted(call => {
			const url = new URL(call.url, "http://core")
			if (url.pathname === `/api/activity/${summary.eventId}`)
				return json(200, {
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
						channel: { discoveryId: "d_A", frequencyHz: 145_562_500 },
						observationStartedAt: "2026-11-23T17:30:21.000Z",
						durationMs: 8000,
						finalizedAt: "2026-11-23T17:30:40.000Z",
					},
				})
			return json(200, { items: [], nextCursor: null })
		})
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary },
		)
		expect(t.kind).toBe("voice-analog")
		expect(t.tone).toMatchObject({ state: "not-measured", why: "no-recording" })
		// no file start is known: the observation's start is the transmission's, shown as such (knownRows)
		expect(t.startedAt).toBeNull()
		expect(t.channel).toMatchObject({
			hz: 145_562_500,
			measuredHz: 145_562_753,
		})
		expect(t.refs).toMatchObject({
			recordingKeys: ["scan:d_A~gone.wav"],
			observationId: "o_A",
		})
		expect(knownRows(t).find(r => r.term === "Tone")?.value).toBe(
			"Not measured",
		)
	})
})

describe("6. Copy", () => {
	it("says it could not copy when the browser has no clipboard", async () => {
		const toast = vi.fn()
		expect(await copyValue("id", undefined, toast)).toBe(false)
		expect(toast).toHaveBeenCalledWith(
			expect.stringContaining("Could not copy"),
			{ tone: "warn" },
		)
	})

	it("says Copied, or that it failed", async () => {
		const toast = vi.fn()
		expect(
			await copyValue("id", { writeText: () => Promise.resolve() }, toast),
		).toBe(true)
		expect(toast).toHaveBeenLastCalledWith("Copied")
		expect(
			await copyValue(
				"id",
				{ writeText: () => Promise.reject(new Error("no")) },
				toast,
			),
		).toBe(false)
		expect(toast).toHaveBeenLastCalledWith("Could not copy", { tone: "warn" })
	})
})

describe("7. a live transmission with no tone", () => {
	it("has its own not-measured reason, worded for a live transmission", async () => {
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
					squelchMode: "carrier",
					peakChannelPowerDbfs: -20,
					closeReason: "squelch",
				},
			}),
		)
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary },
		)
		expect(t.tone).toMatchObject({
			state: "not-measured",
			why: "live-none",
			from: "live-demod",
		})
		const hint = t.tone ? toneRow(t.tone).hint : null
		expect(hint).toMatch(/live/i)
		expect(hint).not.toMatch(/recording/i)
	})
})

describe("8. with the row in hand the event's reads are optional", () => {
	it("degrades instead of rejecting when Activity and the recordings both fail", async () => {
		const summary = row({
			recording: { id: "scan:d_A~x.wav", durationMs: 8000 },
		})
		const { api } = scripted(() =>
			json(500, { error: { code: "INTERNAL", message: "down" } }),
		)
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary, optionalMs: 50 },
		)
		expect(t.gone).toEqual(expect.arrayContaining(["activity", "audio"]))
		expect(t.refs.eventIds).toEqual([summary.eventId])
	})

	it("without the row the event's read is still required", async () => {
		const { api } = scripted(() =>
			json(500, { error: { code: "INTERNAL", message: "down" } }),
		)
		await expect(
			loadTransmission({ event: "evt_x" }, { api }),
		).rejects.not.toBeInstanceOf(TransmissionNotFoundError)
	})
})

const member = (i: number): TransmissionMember => ({
	ref: `rec:m${i}`,
	startedAt: new Date(Date.UTC(2026, 10, 23, 17, 0, i)).toISOString(),
	durationMs: 1000,
	hasAudio: true,
	audioId: `m${i}`,
})

describe("9. the Conversation keeps the current item when it trims", () => {
	it("the cap is the route's, above what the neighbours read can give today", () => {
		expect(MEMBERS_MAX).toBe(64)
	})

	it("keeps the newest one when it is the current one", () => {
		const item = (
			i: number,
			over: Partial<RecordingInventoryItem> = {},
		): RecordingInventoryItem =>
			recording({
				id: `scan:d_A~${i}.wav`,
				key: `scan:d_A~${i}.wav`,
				kind: "scanner-analog",
				discoveryId: "d_A",
				frequencyHz: 145_562_500,
				startedAt: new Date(Date.UTC(2026, 10, 23, 17, 0, i)).toISOString(),
				durationMs: 500,
				...over,
			})
		const self = item(90)
		const neighbours = Array.from({ length: 90 }, (_, i) => item(i))
		const g = groupOf(self, neighbours)
		expect(g?.members.length).toBe(MEMBERS_MAX)
		expect(g?.members.at(-1)?.ref).toBe(
			refText({ recording: self.key ?? self.id }),
		)
	})

	it("property: always holds self, at most the cap, oldest first, a contiguous window", () => {
		// Feature: transmission-view, Property 1: the Conversation window holds the current transmission
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 200 }),
				fc.nat(),
				fc.integer({ min: 1, max: 80 }),
				(n, at, max) => {
					const sorted = Array.from({ length: n }, (_, i) => member(i))
					const self = sorted[at % n]!.ref
					const w = windowAround(sorted, self, max)
					expect(w.length).toBe(Math.min(n, max))
					expect(w.some(m => m.ref === self)).toBe(true)
					const first = sorted.indexOf(w[0]!)
					expect(w).toEqual(sorted.slice(first, first + w.length))
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("10. a missing start time renders nothing", () => {
	it("never an epoch date", () => {
		expect(startText(null)).toBe("")
		expect(startText(undefined)).toBe("")
		expect(startText("not a time")).toBe("")
		expect(firstTime(null, "", "nope")).toBeNull()
		expect(firstTime(null, "2026-11-23T17:30:21.000Z")).toBe(
			"2026-11-23T17:30:21.000Z",
		)
	})

	it("a row with no valid time gives no start", async () => {
		const summary = row({ kind: "analog-transmission", producedAt: "" })
		const { api } = scripted(() =>
			json(404, { error: { code: "NOT_FOUND", message: "x" } }),
		)
		const t = await loadTransmission(
			{ event: summary.eventId },
			{ api, summary },
		)
		expect(t.startedAt).toBeNull()
		expect(t.endedAt).toBeNull()
		expect(JSON.stringify(t)).not.toContain("1970")
	})
})

describe("11. the player, the columns and Back's focus", () => {
	it("the view follows the player only from the item it shows", () => {
		expect(followsPlayer("a", "a", "b")).toBe(true)
		expect(followsPlayer("a", "c", "b")).toBe(false)
		expect(followsPlayer("a", "a", null)).toBe(false)
		expect(followsPlayer("a", "a", "a")).toBe(false)
		expect(followsPlayer(null, "a", "b")).toBe(false)
		const view = src("features/transmission/TransmissionView.tsx")
		expect(view).toContain("followsPlayer(shown.current, was, s.id)")
		expect(view).toContain("replaceTransmission(next.ref, next.summary, true)")
	})

	it("a pinned column's row opens the view like the drawer's", () => {
		const shell = fakeShell("activity")
		const activity = { open: vi.fn() }
		const t = row({ kind: "analog-transmission" })
		openActivityRow(t, activity, shell)
		expect(transmissionNav.get()).toMatchObject({
			ref: { event: t.eventId },
			summary: t,
		})
		expect(activity.open).not.toHaveBeenCalled()
		const packet = row({ kind: "decoder-reception", category: "paging" })
		openActivityRow(packet, activity, shell)
		expect(activity.open).toHaveBeenCalledWith(packet)
		expect(src("shell/drawers/ActivityColumnsPane.tsx")).toContain(
			"openActivityRow(item, activity)",
		)
	})

	it("Back that closes the drawer the view opened gives focus back to the trigger", () => {
		const shell = fakeShell(null)
		const t = trigger()
		openTransmission(
			{ recording: "a" },
			{ host: "activity", label: "Back" },
			null,
			shell,
			t,
		)
		backFromTransmission(shell, fn => fn())
		expect(shell.moves).toEqual(["open:activity", "close"])
		expect(t.focused).toBe(1)
	})

	it("Back onto a host it did not open leaves focus to the host; a gone trigger is not focused", () => {
		const t = trigger()
		openTransmission(
			{ recording: "a" },
			{ host: "activity", label: "Activity" },
			null,
			fakeShell("activity"),
			t,
		)
		backFromTransmission(fakeShell("activity"), fn => fn())
		expect(t.focused).toBe(0)
		const gone = trigger(false)
		const shell = fakeShell("scanner")
		openTransmission(
			{ recording: "a" },
			{ host: "activity", label: "Back" },
			null,
			shell,
			gone,
		)
		backFromTransmission(shell, fn => fn())
		expect(gone.focused).toBe(0)
	})
})
