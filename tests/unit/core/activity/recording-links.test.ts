/**
 * The link wiring's rules: a link goes only after its key was missing from a complete catalogue
 * for RECORDING_LINK_MISSING_MS (a refresh drops and re-adds files), never while the catalogue
 * cannot tell; a kept scanner file's event becomes a checked `recording-change` payload.
 */
import { EventEmitter } from "node:events"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	RECORDING_LINK_MISSING_MS,
	RECORDING_LINK_SWEEP_MS,
	RECORDING_LINK_UNLINK_CHUNK,
	recordingChangeOf,
	wireRecordingLinks,
	type RecordingKeptEvent,
} from "../../../../src/core/activity/recording-links.js"
import type { ActivityRecordingLinks } from "../../../../src/core/activity/runtime.js"
import type {
	ActivityLinkOp,
	RecordingChangePayload,
} from "../../../../src/core/activity/storage/contract.js"
import { RECORDINGS_IN_PROGRESS_MS } from "@wavekit/api-types"

const logger = pino({ level: "silent" })
const closers: (() => void)[] = []
afterEach(() => {
	for (const c of closers.splice(0)) c()
})

function fakeLinks(keys: string[]) {
	const ops: ActivityLinkOp[] = []
	const admitted: RecordingChangePayload[] = []
	const links: ActivityRecordingLinks = {
		admitRecording: p => admitted.push(p),
		link: op => ops.push(op),
		recordingEventId: key => (keys.includes(key) ? `evt-${key}` : null),
		linkedRecordings: () => keys,
		onLinks: () => () => undefined,
	}
	return { links, ops, admitted }
}

const key = (i: number) =>
	`dsd~20261012_100000_${String(i).padStart(5, "0")}_DMR_CC_1_GROUP_TGT_9_SRC_1.wav`

describe("the recording link sweep", () => {
	it("waits past the catalogue's in-progress delay and one sweep", () => {
		expect(RECORDING_LINK_MISSING_MS).toBeGreaterThanOrEqual(
			RECORDING_LINK_SWEEP_MS,
		)
		expect(RECORDING_LINK_MISSING_MS).toBeGreaterThan(RECORDINGS_IN_PROGRESS_MS)
	})

	it("unlinks a key only once a complete catalogue lacked it for the missing time", () => {
		let now = 0
		const present = new Set([key(1)])
		const { links, ops } = fakeLinks([key(1), key(2)])
		const w = wireRecordingLinks({
			links,
			catalogue: { hasKey: k => present.has(k) },
			logger,
			now: () => now,
		})
		closers.push(() => w.close())
		w.sweep()
		expect(ops).toEqual([])
		now = RECORDING_LINK_MISSING_MS - 1
		w.sweep()
		expect(ops).toEqual([])
		now = RECORDING_LINK_MISSING_MS
		w.sweep()
		expect(ops).toEqual([{ type: "unlink", recordingIds: [key(2)] }])
		expect(w.activityEventId(key(1))).toBe(`evt-${key(1)}`)
	})

	it("a key back in the catalogue (a folder refresh) starts over", () => {
		let now = 0
		const present = new Set<string>()
		const { links, ops } = fakeLinks([key(1)])
		const w = wireRecordingLinks({
			links,
			catalogue: { hasKey: k => present.has(k) },
			logger,
			now: () => now,
		})
		closers.push(() => w.close())
		w.sweep()
		present.add(key(1))
		now = RECORDING_LINK_MISSING_MS
		w.sweep()
		present.delete(key(1))
		now += 1
		w.sweep()
		now += RECORDING_LINK_MISSING_MS - 1
		w.sweep()
		expect(ops).toEqual([])
	})

	it("never unlinks on an answer that cannot tell (first build, a bound, a refresh, a throw)", () => {
		let now = 0
		let answer: boolean | null = null
		let throws = false
		const { links, ops } = fakeLinks([key(1)])
		const w = wireRecordingLinks({
			links,
			catalogue: {
				hasKey: () => {
					if (throws) throw new Error("catalogue failed")
					return answer
				},
			},
			logger,
			now: () => now,
		})
		closers.push(() => w.close())
		for (let i = 0; i < 3; i++) {
			w.sweep()
			now += RECORDING_LINK_MISSING_MS
		}
		expect(ops).toEqual([])
		// Missing from a complete catalogue once, then unknown: still linked.
		answer = false
		w.sweep()
		throws = true
		now += RECORDING_LINK_MISSING_MS
		w.sweep()
		expect(ops).toEqual([])
		// Missing again from a complete catalogue the missing time after the first: unlinked.
		throws = false
		w.sweep()
		expect(ops).toEqual([{ type: "unlink", recordingIds: [key(1)] }])
	})

	it("a dsd-fme directory not created yet holds back only dsd keys: a deleted scanner file's link goes", () => {
		let now = 0
		const scanKey =
			"scan:d_01JTEST~analog-6f0a2c1e-1111-4222-8333-444455556666.wav"
		const { links, ops } = fakeLinks([key(1), scanKey])
		const w = wireRecordingLinks({
			links,
			// As the catalogue with one configured dsd-fme directory missing: every dsd~ key unknown.
			catalogue: { hasKey: k => (k.startsWith("dsd~") ? null : false) },
			logger,
			now: () => now,
		})
		closers.push(() => w.close())
		w.sweep()
		now = RECORDING_LINK_MISSING_MS
		w.sweep()
		expect(ops).toEqual([{ type: "unlink", recordingIds: [scanKey] }])
	})

	it("an unknown answer leaves that key's missing time as it was", () => {
		let now = 0
		let answer: boolean | null = false
		const { links, ops } = fakeLinks([key(1)])
		const w = wireRecordingLinks({
			links,
			catalogue: { hasKey: () => answer },
			logger,
			now: () => now,
		})
		closers.push(() => w.close())
		w.sweep()
		answer = null
		now = RECORDING_LINK_MISSING_MS
		w.sweep()
		expect(ops).toEqual([])
		answer = false
		now += 1
		w.sweep()
		expect(ops).toEqual([{ type: "unlink", recordingIds: [key(1)] }])
	})

	it("unlinks many keys in chunks of RECORDING_LINK_UNLINK_CHUNK", () => {
		let now = 0
		const n = RECORDING_LINK_UNLINK_CHUNK + 1
		const keys = Array.from({ length: n }, (_, i) => key(i))
		const { links, ops } = fakeLinks(keys)
		const w = wireRecordingLinks({
			links,
			catalogue: { hasKey: () => false },
			logger,
			now: () => now,
		})
		closers.push(() => w.close())
		w.sweep()
		now = RECORDING_LINK_MISSING_MS
		w.sweep()
		expect(
			ops.map(op => (op.type === "unlink" ? op.recordingIds.length : 0)),
		).toEqual([RECORDING_LINK_UNLINK_CHUNK, 1])
	})
})

const kept = (patch: Partial<RecordingKeptEvent> = {}): RecordingKeptEvent => ({
	recordingId: "d_01JTEST~analog-6f0a2c1e-1111-4222-8333-444455556666.wav",
	discoveryId: "d_01JTEST",
	observationId: "o_01JTEST",
	sourceId: "rtl",
	frequencyHz: 446_006_250,
	observationStartedAt: "2026-10-12T00:00:00.000Z",
	durationMs: 3499.6,
	at: Date.parse("2026-10-12T00:00:30.000Z"),
	...patch,
})

describe("kept scanner recordings", () => {
	it("become a recording-change payload keyed by the file's keep key", () => {
		expect(recordingChangeOf(kept())).toEqual({
			change: "finalized",
			recordingId:
				"scan:d_01JTEST~analog-6f0a2c1e-1111-4222-8333-444455556666.wav",
			recordingKind: "scanner-analog",
			discoveryId: "d_01JTEST",
			observationId: "o_01JTEST",
			sourceId: "rtl",
			frequencyHz: 446_006_250,
			observationStartedAt: "2026-10-12T00:00:00.000Z",
			durationMs: 3500,
			finalizedAt: "2026-10-12T00:00:30.000Z",
		})
	})

	it.each([
		["another folder", { discoveryId: "d_OTHER" }],
		["no file name", { recordingId: "d_01JTEST~" }],
		["a path", { recordingId: "d_01JTEST~../x.wav" }],
		["not a wav", { recordingId: "d_01JTEST~analog-1.mp3" }],
		["no observation", { observationId: "" }],
		["a negative length", { durationMs: -1 }],
		["no time", { at: Number.NaN }],
	])("are refused with %s", (_label, patch) => {
		expect(recordingChangeOf(kept(patch))).toBeNull()
	})

	it("unknown values read as null, never guessed", () => {
		expect(
			recordingChangeOf(
				kept({
					sourceId: null,
					frequencyHz: Number.NaN,
					observationStartedAt: "never",
				}),
			),
		).toMatchObject({
			sourceId: null,
			frequencyHz: null,
			observationStartedAt: null,
		})
	})

	it("the wiring admits each kept file once, and nothing after close", () => {
		const scanner = new EventEmitter()
		const { links, admitted } = fakeLinks([])
		const w = wireRecordingLinks({ links, scanner, logger })
		scanner.emit("recording-kept", kept())
		scanner.emit("recording-kept", kept({ discoveryId: "d_OTHER" }))
		w.close()
		scanner.emit("recording-kept", kept())
		expect(admitted).toHaveLength(1)
	})
})
