import { describe, expect, it } from "vitest"
import type {
	ActivitySummary,
	RecordingInventoryItem,
} from "@wavekit/api-types"

import { headerCount } from "../../src/features/activity/count.ts"
import { foldActivity } from "../../src/features/activity/fold.ts"
import { readFileSync } from "node:fs"

import {
	activityListKey,
	activityQueue,
	recordingOf,
} from "../../src/features/activity/playback.ts"
import {
	keepLabel,
	keepTarget,
	playbackIdOf,
} from "../../src/features/playback/keep.ts"
import { tunedQueue } from "../../src/features/tuned/playback.tsx"
import type { EarlierRow } from "../../src/features/tuned/now.ts"

let seq = 0
function row(over: Partial<ActivitySummary> = {}): ActivitySummary {
	seq += 1
	return {
		eventId: `evt_${seq}`,
		commitSeq: String(1000 - seq),
		kind: "decoder-reception",
		producedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 100 - seq)).toISOString(),
		receivedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 100 - seq)).toISOString(),
		decoderId: "dsd-fme",
		sourceId: "src-0",
		protocol: "dmr",
		category: "voice",
		frequencyHz: null,
		entityKey: `talkgroup:${seq}`,
		title: `TG ${seq}`,
		fields: [],
		...over,
	}
}

describe("Activity header count", () => {
	const base = {
		counts: { voice: 7, paging: 3 },
		total: 12,
		chip: null,
		column: false,
		events: 40,
		more: true,
	}
	it("counts the core's events for the search, in the chips' unit", () => {
		expect(headerCount(base)).toMatchObject({ text: "12", core: true })
		expect(headerCount({ ...base, chip: "voice" })).toMatchObject({
			text: "7",
			core: true,
		})
		expect(headerCount({ ...base, total: 1 }).title).toBe(
			"1 event for this search, counted by WaveKit",
		)
	})

	it("falls back to the loaded events (never folded rows) for a column or before the facets read", () => {
		expect(headerCount({ ...base, column: true })).toMatchObject({
			text: "40+",
			core: false,
		})
		expect(
			headerCount({ ...base, total: null, counts: null, more: false }),
		).toEqual({ text: "40", title: "40 loaded events", core: false })
		expect(headerCount({ ...base, chip: "aircraft", counts: {} }).text).toBe(
			"40+",
		)
	})
})

describe("Activity queue", () => {
	it("is the recording ids of the rows with audio, in the order shown", () => {
		const a = row({ recording: { id: "dsd~a.wav", durationMs: 4000 } })
		const plain = row()
		const b = row({
			kind: "recording-change",
			recording: { id: "scan:d_1~b.wav", durationMs: null },
		})
		const stacks = foldActivity([a, plain, b])
		const q = activityQueue(stacks)
		expect(q.source).toBe("activity")
		expect(q.ids).toEqual(["dsd~a.wav", "scan:d_1~b.wav"])
		expect(q.titles?.["dsd~a.wav"]).toBe(a.title)
		expect(recordingOf(plain)).toBeNull()
	})
})

describe("tuned card queue", () => {
	it("takes the earlier rows that carry a recording, titled as the row reads", () => {
		const rec = row({ recording: { id: "dsd~c.wav", durationMs: 1000 } })
		const rows: EarlierRow[] = [
			{ id: "1", time: "12:00", a: "Call", b: "", item: rec },
			{ id: "2", time: "12:01", a: "Text", b: "", item: row() },
		]
		expect(tunedQueue(rows)).toEqual({
			source: "tuned",
			ids: ["dsd~c.wav"],
			titles: { "dsd~c.wav": "Call" },
		})
	})
})

describe("Keep from anywhere", () => {
	const item = (over: Partial<RecordingInventoryItem>) =>
		({
			id: "dsd:0~20260101_120000_00001_DMR.wav",
			kind: "dsd-fme-call",
			key: "dsd~20260101_120000_00001_DMR.wav",
			kept: true,
			...over,
		}) as RecordingInventoryItem

	it("plays and marks a catalogue item by its stable key", () => {
		expect(playbackIdOf(item({}))).toBe("dsd~20260101_120000_00001_DMR.wav")
		const { key: _k, ...old } = item({})
		expect(playbackIdOf(old as RecordingInventoryItem)).toBe(old.id)
	})

	it("resolves the catalogue id from the loaded list, a scanner key, or not at all", () => {
		const loaded = item({})
		expect(keepTarget(loaded.key ?? "", [loaded], new Map())).toEqual({
			inventoryId: loaded.id,
			kept: true,
		})
		expect(
			keepTarget("scan:d_01ABC~analog-1.wav", [], new Map([["x", true]])),
		).toEqual({ inventoryId: "scan:d_01ABC~analog-1.wav", kept: null })
		expect(
			keepTarget(
				"dsd~20260101_120000_00002_DMR.wav",
				[],
				new Map([["dsd~20260101_120000_00002_DMR.wav", false]]),
			),
		).toEqual({ inventoryId: null, kept: false })
	})

	it("never says not kept when the kept state is unknown", () => {
		const scan = "scan:d_01ABC~analog-1.wav"
		const unknown = keepLabel(keepTarget(scan, [], new Map()))
		expect(unknown).toMatchObject({
			state: "unknown",
			pressed: undefined,
			next: true,
		})
		expect(unknown.title).toMatch(/Not known here whether it is kept/)
		// the row's own data decides when the catalogue and earlier answers do not
		expect(keepLabel(keepTarget(scan, [], new Map()), true)).toMatchObject({
			state: "kept",
			text: "Kept",
			pressed: true,
			next: false,
		})
		expect(
			keepLabel(keepTarget(scan, [], new Map([[scan, false]]))),
		).toMatchObject({ state: "not-kept", pressed: false, next: true })
		// the catalogue wins over the row
		const loaded = item({})
		expect(
			keepLabel(keepTarget(loaded.key ?? "", [loaded], new Map()), false),
		).toMatchObject({ state: "kept" })
		// no Keep route here: disabled with its reason
		expect(
			keepLabel(keepTarget("dsd~20260101_120000_00002_DMR.wav", [], new Map())),
		).toMatchObject({
			state: "unavailable",
			next: null,
			title: "Open it in Recordings to keep it",
		})
	})
})

describe("one queue per Activity list, compact only in a visible panel", () => {
	const src = (path: string) =>
		readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8")

	it("keys each list by its feed: stable for one, distinct across lists", () => {
		const drawer = {}
		const column = {}
		expect(activityListKey(drawer)).toBe(activityListKey(drawer))
		expect(activityListKey(drawer)).not.toBe(activityListKey(column))
		expect(activityQueue([], activityListKey(column)).list).toBe(
			activityListKey(column),
		)
	})

	it("the list and the detail's Recording block play from the list they show", () => {
		const list = src("features/activity/ActivityList.tsx")
		expect(list).toContain("activityListKey(feed)")
		expect(list).toContain(
			'playback.setQueue("activity", queue.ids, queue.titles, queueList)',
		)
		const block = src("features/activity/ActivityPlayback.tsx")
		expect(block).toContain("activityListKey(feed)")
		expect(block).toContain("activityQueue(foldedOf(items, feed), list)")
	})

	it("no surface shrinks the dock under its open row: the one player stays the transport", () => {
		for (const file of [
			"features/activity/ActivityPlayback.tsx",
			"features/recordings/RecordingsDrawer.tsx",
			"features/transmission/TransmissionView.tsx",
		])
			expect(src(file)).not.toContain("setExpanded")
	})
})
