import { afterEach, describe, expect, it } from "vitest"
import type {
	ActivitySummary,
	RecordingInventoryItem,
} from "@wavekit/api-types"

import {
	loadTransmission,
	TransmissionNotFoundError,
} from "../../src/features/transmission/load.ts"
import {
	backFromTransmission,
	hostHere,
	isTransmissionRow,
	openInScanner,
	openTransmission,
	replaceTransmission,
	transmissionNav,
	type ShellDoor,
} from "../../src/features/transmission/nav.ts"
import { token } from "../../src/features/activity/search.ts"
import { channelLinkLabel } from "../../src/features/recordings/RecordingsDrawer.tsx"
import { scannerUi } from "../../src/features/scanner/ui-store.ts"
import type { DrawerId } from "../../src/shell/store.ts"
import { shellStore } from "../../src/shell/store.ts"
import { appToast } from "../../src/shell/toast.ts"
import { json, scripted } from "../data/fake-fetch.ts"

const KEY = "scan:d_A~analog-00000000-0000-4000-8000-000000000001.wav"

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
	kept: false,
	activityEventId: "evt_1",
	startedAt: "2026-11-23T17:30:21.000Z",
	observationId: "o_A",
	speech: "heard",
	keptBy: "own-tone",
	cut: null,
	part: null,
	parts: null,
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
	tone: { kind: "ctcss", hz: 88.5 },
}

/** A core answering the four reads; `missing` paths answer 404. */
function core(listed: RecordingInventoryItem[], missing: string[] = []) {
	return scripted(call => {
		const path = new URL(call.url, "http://core").pathname
		if (missing.some(m => path.startsWith(m)))
			return json(404, { error: { code: "NOT_FOUND", message: "gone" } })
		if (path === "/api/recordings")
			return json(200, {
				items: listed,
				nextCursor: null,
				scannedFiles: listed.length,
				truncated: false,
				scannedAt: "2026-11-23T18:00:00.000Z",
			})
		if (path === "/api/activity/evt_1")
			return json(200, {
				version: 1,
				eventId: "evt_1",
				commitSeq: "1",
				producedAt: "2026-11-23T17:30:40.000Z",
				receivedAt: "2026-11-23T17:30:40.000Z",
				kind: "recording-change",
				payload: {
					change: "finalized",
					recordingId: KEY,
					recordingKind: "scanner-analog",
					discoveryId: "d_A",
					observationId: "o_A",
					sourceId: "rx",
					frequencyHz: 145_562_753,
					observationStartedAt: "2026-11-23T17:30:21.000Z",
					durationMs: 8000,
					finalizedAt: "2026-11-23T17:30:40.000Z",
				},
			})
		if (path === "/api/scanner/discoveries/d_A")
			return json(200, {
				id: "d_A",
				frequencyHz: 145_562_500,
				observationCount: 212,
				firstSeenAt: "2026-11-12T08:00:00.000Z",
				protocol: "analog-fm",
				proof: { kind: "analog-tone", tone: { ctcssHz: 88.5, dcs: null } },
			})
		if (path === "/api/scanner/discoveries/d_A/observations")
			return json(200, {
				items: [
					{
						id: "o_A",
						snrDb: 24.2,
						peakDbfs: -18,
						sourceId: "rx",
						flags: {
							overload: false,
							gap: false,
							offRaster: true,
							obwBiased: false,
							adjacentLeak: false,
							suspectedIntermod: false,
							edge: false,
						},
					},
				],
				nextCursor: null,
			})
		return json(404, { error: { code: "NOT_FOUND", message: path } })
	})
}

describe("loadTransmission", () => {
	it("composes a recording with its facts into one frozen DTO", async () => {
		const withFacts = { ...item(), facts: FACTS } as RecordingInventoryItem
		const before = item({
			id: "scan:d_A~before.wav",
			key: "scan:d_A~before.wav",
			observationId: "o_B",
			startedAt: "2026-11-23T17:29:58.000Z",
			durationMs: 6000,
		})
		const { api, calls } = core([withFacts, before])
		const t = await loadTransmission({ recording: KEY }, { api })
		expect(Object.isFrozen(t)).toBe(true)
		expect(Object.isFrozen(t.tone)).toBe(true)
		expect(t.kind).toBe("voice-analog")
		expect(t.tone).toMatchObject({
			state: "heard",
			ctcssHz: 88.5,
			from: "recorder",
		})
		expect(t.startedAt).toBe("2026-11-23T17:30:21.000Z")
		expect(t.channel).toMatchObject({
			hz: 145_562_500,
			measuredHz: 145_562_753,
		})
		expect(t.close).toEqual({ reason: "completed", complete: true })
		expect(t.signal).toEqual({
			snrDb: 24.2,
			peakDbfs: -18,
			flags: ["offRaster"],
		})
		expect(t.channelSummary).toEqual({
			timesHeard: 212,
			since: "2026-11-12T08:00:00.000Z",
			usualCtcssHz: 88.5,
		})
		expect(t.refs).toMatchObject({
			recordingKeys: [KEY],
			eventIds: ["evt_1"],
			observationId: "o_A",
			operationId: FACTS.operationId,
		})
		// the earlier recording of the same channel is "around this time", oldest first
		expect(t.group?.heuristic).toBe(true)
		expect(t.group?.members.map(m => m.audioId)).toEqual([
			"scan:d_A~before.wav",
			KEY,
		])
		expect(t.gone).toEqual([])
		// the recording and its neighbours (one folder read), its Activity record, the discovery, its observations
		expect(
			calls.map(c => new URL(c.url, "http://core").pathname).sort(),
		).toEqual(
			[
				"/api/activity/evt_1",
				"/api/recordings",
				"/api/scanner/discoveries/d_A",
				"/api/scanner/discoveries/d_A/observations",
			].sort(),
		)
		// the stored records are copies: the store's own item is never frozen
		expect(Object.isFrozen(withFacts)).toBe(false)
	})

	it("degrades when the facts are missing and the optional reads fail", async () => {
		const { api } = core([item()], ["/api/scanner", "/api/activity"])
		const t = await loadTransmission(
			{ recording: KEY },
			{ api, recordings: () => [item()] },
		)
		// no facts, but kept for its own tone: a tone was heard, not stored
		expect(t.tone).toMatchObject({ state: "heard", why: "not-stored" })
		expect(t.admission).toBeNull()
		expect(t.signal).toBeNull()
		expect(t.channelSummary).toBeNull()
		expect(t.verdict.keptBy).toBe("own-tone")
		expect(t.gone).toEqual(expect.arrayContaining(["activity", "discovery"]))
		expect(t.artefacts[0]).toMatchObject({
			kind: "audio",
			id: KEY,
			bytes: 128_000,
		})
	})

	it("reads the loaded list before asking the core", async () => {
		const { api, calls } = core([], ["/api/scanner", "/api/activity"])
		await loadTransmission(
			{ recording: KEY },
			{
				api,
				recordings: () => [item({ activityEventId: null })],
			},
		)
		// only the neighbours' folder read, never a lookup of the file itself
		expect(calls.filter(c => c.url.includes("/api/recordings"))).toHaveLength(1)
	})

	it("opens an Activity event through its recording", async () => {
		const { api } = core([
			{ ...item(), facts: { ...FACTS, tone: null } } as RecordingInventoryItem,
		])
		const t = await loadTransmission({ event: "evt_1" }, { api })
		expect(t.refs.recordingKeys).toEqual([KEY])
		expect(t.tone?.state).toBe("none")
	})

	it("says the audio is gone when the event's file is no longer listed", async () => {
		const summary: ActivitySummary = {
			eventId: "evt_1",
			commitSeq: "1",
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
		}
		const { api } = core([])
		const t = await loadTransmission({ event: "evt_1" }, { api, summary })
		expect(t.artefacts).toEqual([])
		expect(t.gone).toContain("audio")
		// not listed is all the store said: never "deleted"
		expect(t.noAudioReason).toBe("not-listed")
	})

	it("rejects a ref nothing names", async () => {
		const { api } = core([])
		await expect(
			loadTransmission({ recording: "scan:d_Z~nope.wav" }, { api }),
		).rejects.toBeInstanceOf(TransmissionNotFoundError)
		await expect(
			loadTransmission({ event: "evt_zz" }, { api }),
		).rejects.toBeInstanceOf(TransmissionNotFoundError)
	})
})

/** A shell double: which drawer is open, and every move. */
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

describe("Back to the origin", () => {
	afterEach(() => {
		transmissionNav.set(null)
		shellStore.closeDrawer()
		appToast.set(null)
	})

	it("opens in the drawer the user is in and goes back in one step, moving nothing", () => {
		const shell = fakeShell("recordings")
		openTransmission(
			{ recording: KEY },
			{ host: "recordings", label: "Recordings" },
			null,
			shell,
		)
		expect(transmissionNav.get()?.origin).toEqual({
			host: "recordings",
			label: "Recordings",
		})
		replaceTransmission({ recording: "scan:d_A~before.wav" })
		replaceTransmission({ recording: "scan:d_A~after.wav" })
		const origin = backFromTransmission(shell)
		expect(origin?.label).toBe("Recordings")
		expect(transmissionNav.get()).toBeNull()
		expect(shell.moves).toEqual([])
	})

	it("from a place with no drawer opens Activity, and Back closes it again", () => {
		const shell = fakeShell(null)
		expect(hostHere(shell)).toEqual({ host: "activity", label: "Back" })
		openTransmission({ event: "evt_1" }, hostHere(shell), null, shell)
		expect(shell.moves).toEqual(["open:activity"])
		backFromTransmission(shell)
		expect(shell.moves).toEqual(["open:activity", "close"])
	})

	it("restores the drawer that was open before", () => {
		const shell = fakeShell("scanner")
		openTransmission({ event: "evt_1" }, hostHere(shell), null, shell)
		backFromTransmission(shell)
		expect(shell.moves).toEqual(["open:activity", "open:scanner"])
	})

	it("never writes Activity's search", async () => {
		const { createServices } = await import("../../src/app/services.ts")
		const services = createServices()
		try {
			services.activity.setSearch([token("text", "net")], null)
			const before = services.activity.get()
			openTransmission({ event: "evt_1" }, { host: "activity", label: "Back" })
			backFromTransmission()
			const after = services.activity.get()
			expect(after.tokens).toBe(before.tokens)
			expect(after.chip).toBe(before.chip)
			expect(after.openId).toBe(before.openId)
		} finally {
			services.dispose()
		}
	})

	it("closes with its host drawer", () => {
		openTransmission({ event: "evt_1" }, { host: "activity", label: "Back" })
		expect(shellStore.getState().drawer).toBe("activity")
		expect(transmissionNav.get()).not.toBeNull()
		shellStore.openDrawer("settings")
		expect(transmissionNav.get()).toBeNull()
	})

	it("opens transmission rows, not packets", () => {
		const row = (over: Partial<ActivitySummary>) =>
			({
				kind: "decoder-reception",
				category: "paging",
				...over,
			}) as ActivitySummary
		expect(isTransmissionRow(row({ kind: "recording-change" }))).toBe(true)
		expect(isTransmissionRow(row({ kind: "analog-transmission" }))).toBe(true)
		expect(
			isTransmissionRow(
				row({ category: "voice", recording: { id: "dsd~x", durationMs: 1 } }),
			),
		).toBe(true)
		expect(isTransmissionRow(row({}))).toBe(false)
	})
})

describe("the doors", () => {
	afterEach(() => {
		shellStore.closeDrawer()
		scannerUi.update(s => ({ ...s, openDiscoveryId: null }))
		appToast.set(null)
	})

	it("Open in Scanner opens the discovery it resolves to", async () => {
		const shell = fakeShell(null)
		const ok = await openInScanner(
			"d_old",
			{
				discovery: () => undefined,
				fetchDiscovery: () => Promise.resolve({ id: "d_new" }),
			},
			shell,
		)
		expect(ok).toBe(true)
		expect(scannerUi.get().openDiscoveryId).toBe("d_new")
		expect(shell.moves).toEqual(["open:scanner"])
	})

	it("Open in Scanner says so when the core cannot give it, and moves nothing", async () => {
		const shell = fakeShell("recordings")
		const ok = await openInScanner(
			"d_gone",
			{
				discovery: () => undefined,
				fetchDiscovery: () => Promise.reject(new Error("discovery not found")),
			},
			shell,
		)
		expect(ok).toBe(false)
		expect(shell.moves).toEqual([])
		expect(scannerUi.get().openDiscoveryId).toBeNull()
		expect(appToast.get()?.text).toBe(
			"Could not open this channel in Scanner: discovery not found",
		)
	})

	it("History is a plain channel link: no transmission opens over it", () => {
		expect(channelLinkLabel(item())).toBe("History of 145.5625")
		expect(
			channelLinkLabel(item({ frequencyHz: null, talkgroup: null })),
		).toBeNull()
	})
})
