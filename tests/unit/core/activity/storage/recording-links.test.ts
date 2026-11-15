/**
 * Recording links in the Activity store: a row's playable recording lives in its summary
 * (`recording`) and in one `recordingId` ref; a late call file updates the call's row (never a
 * row of its own); a deleted file's link goes; stores written before links are backfilled. The
 * stored record is never rewritten. Synthetic rows only.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { createActivityQueryService } from "../../../../../src/core/activity/query/service.js"
import type {
	ActivityLinkEvent,
	ActivityStoreHandle,
	RecordingChangePayload,
} from "../../../../../src/core/activity/storage/contract.js"
import { pruneActivityFair } from "../../../../../src/core/activity/storage/database.js"
import { backfillRecordingLinks } from "../../../../../src/core/activity/storage/links.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import { openActivityStore } from "../../../../../src/core/activity/storage/store.js"
import type { DecodeEnvelope } from "../../../../../src/core/activity/types.js"
import {
	envelope,
	fixtureClock,
	logger,
	openStore,
	roots,
	stores,
	tempDir,
} from "./helpers.js"

const NAME_A = "20261012_100000_12345_DMR_CC_1_GROUP_TGT_9_SRC_2001.wav"
const NAME_B = "20261012_100100_54321_DMR_CC_1_GROUP_TGT_9_SRC_2002.wav"
const KEY_A = `dsd~${NAME_A}`
const KEY_B = `dsd~${NAME_B}`
const SCAN_KEY =
	"scan:d_01JTESTDISCOVERY~analog-6f0a2c1e-1111-4222-8333-444455556666.wav"

afterEach(async () => {
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

/** A dsd-fme `call_end` reception of `callId` (its `callId` ref, as the ingress sets it). */
function callEnd(
	callId: string,
	patch: { decoderId?: string; wavFile?: string; late?: boolean } = {},
): DecodeEnvelope {
	const base = envelope({
		decoderId: patch.decoderId ?? "dsd-a",
		outputType: "call_end",
		protocol: "dmr",
		category: "voice",
		entityKey: "talkgroup:9",
		title: "DMR TG 9 from 2001",
		fields: [{ key: "talkgroup", label: "Talkgroup", value: 9 }],
		decodedData: {
			callId,
			talkgroup: 9,
			duration: 4200,
			...(patch.wavFile !== undefined ? { wavFile: patch.wavFile } : {}),
			...(patch.late === true ? { flags: { wavFileUpdate: true } } : {}),
		},
	})
	return { ...base, refs: { callId } }
}

function service(store: ActivityStoreHandle) {
	return createActivityQueryService({ store, logger, execution: "inline" })
}

async function rows(dbPath: string): Promise<
	{
		eventId: string
		summary: Record<string, unknown>
		recordJson: string
		recordBytes: number
		refs: string[]
	}[]
> {
	const db = await openSqliteFile(dbPath, true)
	try {
		const out = db
			.prepare(
				"SELECT seq, event_id, summary_json, record_json, record_bytes FROM activity ORDER BY seq",
			)
			.all()
		return out.map(row => ({
			eventId: String(row["event_id"]),
			summary: JSON.parse(String(row["summary_json"])) as Record<
				string,
				unknown
			>,
			recordJson: String(row["record_json"]),
			recordBytes: Number(row["record_bytes"]),
			refs: db
				.prepare(
					"SELECT ref_type, ref_value FROM activity_refs WHERE seq = ? ORDER BY ref_type",
				)
				.all(row["seq"] ?? null)
				.map(r => `${String(r["ref_type"])}:${String(r["ref_value"])}`),
		}))
	} finally {
		db.close()
	}
}

describe("recording links in the store", () => {
	it("a row admitted with its recording carries it; hasRecording and the recordingId ref find it", async () => {
		const store = await openStore()
		const events: ActivityLinkEvent[] = []
		store.onLinks?.(e => events.push(...e))
		const linked = callEnd("call-1")
		expect(
			store.admit(linked, undefined, { id: KEY_A, durationMs: 4200 }),
		).toEqual({ admitted: true })
		store.admit(envelope({ eventId: "plain" }))
		const q = service(store)
		const withAudio = await q.search({ query: { hasRecording: true } })
		expect(withAudio.items.map(i => i.eventId)).toEqual([linked.eventId])
		expect(withAudio.items[0]?.recording).toEqual({
			id: KEY_A,
			durationMs: 4200,
		})
		const without = await q.search({ query: { hasRecording: false } })
		expect(without.items.map(i => i.eventId)).toEqual(["plain"])
		const byKey = await q.search({
			query: { refs: [{ type: "recordingId", value: KEY_A }] },
		})
		expect(byKey.items.map(i => i.eventId)).toEqual([linked.eventId])
		expect(store.recordingEventId?.(KEY_A)).toBe(linked.eventId)
		expect(events.map(e => [e.recordingId, e.linked])).toEqual([[KEY_A, true]])
		await q.close()
	})

	it("a late file links its call's row still queued in place: one row, stored with the link", async () => {
		const stateDir = await tempDir()
		const store = await openStore({
			stateDir,
			limits: { batchWindowMs: 60_000 },
		})
		const call = callEnd("call-2")
		store.admit(call)
		store.link?.({
			type: "link-call",
			decoderId: "dsd-a",
			callId: "call-2",
			recording: { id: KEY_B, durationMs: 1000 },
		})
		await store.close()
		const stored = await rows(store.dbPath)
		expect(stored).toHaveLength(1)
		expect(stored[0]?.summary["recording"]).toEqual({
			id: KEY_B,
			durationMs: 1000,
		})
		expect(stored[0]?.refs).toContain(`recordingId:${KEY_B}`)
	})

	it("a late file updates the stored call row, not adding one; the record stays as received", async () => {
		const store = await openStore()
		const events: ActivityLinkEvent[] = []
		store.onLinks?.(e => events.push(...e))
		const call = callEnd("call-3")
		store.admit(call)
		// Another decoder's call with the same id and a call_start without the ref stay unlinked.
		store.admit(callEnd("call-3", { decoderId: "dsd-b" }))
		const before = await rows(store.dbPath)
		store.link?.({
			type: "link-call",
			decoderId: "dsd-a",
			callId: "call-3",
			recording: { id: KEY_A, durationMs: 4200 },
		})
		const after = await rows(store.dbPath)
		expect(after).toHaveLength(before.length)
		const row = after.find(r => r.eventId === call.eventId)
		const was = before.find(r => r.eventId === call.eventId)
		expect(row?.summary["recording"]).toEqual({ id: KEY_A, durationMs: 4200 })
		expect(row?.recordJson).toBe(was?.recordJson)
		expect(row?.recordBytes).toBe(was?.recordBytes)
		expect(
			after.filter(r => r.summary["recording"] !== undefined),
		).toHaveLength(1)
		expect(store.recordingEventId?.(KEY_A)).toBe(call.eventId)
		expect(events).toEqual([
			expect.objectContaining({
				recordingId: KEY_A,
				eventId: call.eventId,
				linked: true,
			}),
		])
	})

	it("an unlink removes the link from stored and queued rows", async () => {
		const stateDir = await tempDir()
		const first = await openStore({ stateDir })
		const stored = callEnd("call-4")
		first.admit(stored, undefined, { id: KEY_A, durationMs: 1 })
		await first.close()
		// Reopened: the writer loads the link; the next row waits in the queue (60 s window).
		const store = await openStore({
			stateDir,
			limits: { batchWindowMs: 60_000 },
		})
		expect(store.recordingEventId?.(KEY_A)).toBe(stored.eventId)
		const queued = callEnd("call-5")
		store.admit(queued, undefined, { id: KEY_A, durationMs: 1 })
		store.link?.({ type: "unlink", recordingIds: [KEY_A] })
		await store.close()
		expect(store.recordingEventId?.(KEY_A)).toBeNull()
		const after = await rows(store.dbPath)
		expect(after.map(r => r.eventId)).toEqual([stored.eventId, queued.eventId])
		for (const row of after) {
			expect(row.summary["recording"]).toBeUndefined()
			expect(row.refs.some(r => r.startsWith("recordingId:"))).toBe(false)
		}
	})

	it("an unlink of a key no row holds any more makes the index forget it", async () => {
		const store = await openStore()
		const events: ActivityLinkEvent[] = []
		store.onLinks?.(e => events.push(...e))
		const call = callEnd("call-12")
		store.admit(call, undefined, { id: KEY_A, durationMs: 1 })
		expect(store.recordingEventId?.(KEY_A)).toBe(call.eventId)
		// The row goes behind the index's back (as a fair-share delete of an older core would).
		const db = await openSqliteFile(store.dbPath)
		db.prepare("DELETE FROM activity WHERE event_id = ?").run(call.eventId)
		db.close()
		store.link?.({ type: "unlink", recordingIds: [KEY_A] })
		expect(store.recordingEventId?.(KEY_A)).toBeNull()
		expect(store.linkedRecordings?.()).toEqual([])
		expect(events.at(-1)).toEqual({
			recordingId: KEY_A,
			eventId: "",
			seq: "0",
			linked: false,
		})
	})

	it("a fair-share delete reports the links of the rows it removes", async () => {
		const store = await openStore()
		const linked = callEnd("call-13")
		store.admit(linked, undefined, { id: KEY_B, durationMs: 1 })
		store.admit(callEnd("call-14"))
		await store.close()
		const db = await openSqliteFile(store.dbPath)
		const done = pruneActivityFair(
			db,
			{ incrementalVacuumPages: 0 },
			[{ decoderId: "dsd-a", kind: "decoder-reception", rows: 2 }],
			{ rowCount: 2, dbBytes: 0 },
		)
		db.close()
		expect(done.deleted).toBe(2)
		expect(done.unlinked).toEqual([
			expect.objectContaining({
				recordingId: KEY_B,
				eventId: linked.eventId,
				linked: false,
			}),
		])
	})

	it("a kept scanner recording is one recording-change row linked to its file, discovery and observation", async () => {
		const store = await openStore()
		const payload: RecordingChangePayload = {
			change: "finalized",
			recordingId: SCAN_KEY,
			recordingKind: "scanner-analog",
			discoveryId: "d_01JTESTDISCOVERY",
			observationId: "o_01JTESTOBSERVATION",
			sourceId: "source-1",
			frequencyHz: 446_006_250,
			observationStartedAt: "2026-10-12T00:00:00.000Z",
			durationMs: 3500,
			finalizedAt: "2026-10-12T00:00:30.000Z",
		}
		expect(
			store.admitRecording?.({
				payload,
				receivedAt: "2026-10-12T00:00:30.100Z",
			}),
		).toEqual({ admitted: true })
		const q = service(store)
		const page = await q.search({ query: { hasRecording: true } })
		expect(page.items).toHaveLength(1)
		const item = page.items[0]!
		expect(item).toMatchObject({
			kind: "recording-change",
			category: "voice",
			protocol: "analog",
			frequencyHz: 446_006_250,
			title: "Recording 446.00625 MHz",
			recording: { id: SCAN_KEY, durationMs: 3500 },
		})
		for (const ref of [
			{ type: "discoveryId" as const, value: payload.discoveryId },
			{ type: "observationId" as const, value: payload.observationId },
		]) {
			const found = await q.search({ query: { refs: [ref] } })
			expect(found.items.map(i => i.eventId)).toEqual([item.eventId])
		}
		const detail = await q.detail(item.eventId)
		expect(detail).toMatchObject({ kind: "recording-change", payload })
		expect(store.recordingEventId?.(SCAN_KEY)).toBe(item.eventId)
		await q.close()
	})

	it("backfills a store written before links; the stored path is served as a file name", async () => {
		const stateDir = await tempDir()
		const first = await openStore({ stateDir })
		const immediate = callEnd("call-6", {
			wavFile: `/var/lib/wavekit/calls/${NAME_A}`,
		})
		const pending = callEnd("call-7")
		const lateRow = callEnd("call-7", {
			wavFile: `/var/lib/wavekit/calls/${NAME_B}`,
			late: true,
		})
		const notACall = callEnd("call-8", { wavFile: "/tmp/notes.wav" })
		for (const e of [immediate, pending, lateRow, notACall]) {
			// Rows of an older core: no callId ref, the absolute path in the data.
			const { refs: _refs, ...legacy } = e
			first.admit(legacy)
		}
		await first.close()
		const db = await openSqliteFile(first.dbPath)
		db.prepare("UPDATE store_meta SET value = '0' WHERE key = ?").run(
			"recordingLinkBackfill",
		)
		db.close()
		const second = await openStore({ stateDir })
		expect(second.recordingEventId?.(KEY_A)).toBe(immediate.eventId)
		expect(second.recordingEventId?.(KEY_B)).toBe(pending.eventId)
		const after = await rows(second.dbPath)
		expect(after).toHaveLength(4)
		const linked = after.filter(r => r.summary["recording"] !== undefined)
		expect(linked.map(r => r.eventId).sort()).toEqual(
			[immediate.eventId, pending.eventId].sort(),
		)
		const q = service(second)
		const detail = await q.detail(immediate.eventId)
		expect(
			(detail?.payload as unknown as { decodedData: { wavFile: string } })
				.decodedData.wavFile,
		).toBe(NAME_A)
		const meta = await openSqliteFile(second.dbPath, true)
		expect(
			meta
				.prepare("SELECT value FROM store_meta WHERE key = ?")
				.get("recordingLinkBackfill")?.["value"],
		).toBe("done")
		meta.close()
		await q.close()
	})

	it("the backfill stops at the newest row stored before the open", async () => {
		const stateDir = await tempDir()
		const first = await openStore({ stateDir })
		const before = callEnd("call-15", { wavFile: `/c/${NAME_A}` })
		const after = callEnd("call-16", { wavFile: `/c/${NAME_B}` })
		for (const e of [before, after]) {
			const { refs: _refs, ...legacy } = e
			first.admit(legacy)
		}
		await first.close()
		const db = await openSqliteFile(first.dbPath)
		db.prepare("UPDATE store_meta SET value = '0' WHERE key = ?").run(
			"recordingLinkBackfill",
		)
		const until = BigInt(
			String(
				db.prepare("SELECT MIN(seq) AS s FROM activity").get()?.["s"] ?? "0",
			),
		)
		const step = backfillRecordingLinks(db, new Map(), 500, until)
		db.close()
		expect(step.done).toBe(true)
		expect(step.events.map(e => e.eventId)).toEqual([before.eventId])
	})

	it("the backfill resumes chunk by chunk from its cursor, a late file matched across chunks", async () => {
		const stateDir = await tempDir()
		const first = await openStore({ stateDir })
		const pending = callEnd("call-9")
		const lateRow = callEnd("call-9", {
			wavFile: `C:\\calls\\${NAME_B}`,
			late: true,
		})
		for (const e of [pending, lateRow]) {
			const { refs: _refs, ...legacy } = e
			first.admit(legacy)
		}
		await first.close()
		const db = await openSqliteFile(first.dbPath)
		db.prepare("UPDATE store_meta SET value = '0' WHERE key = ?").run(
			"recordingLinkBackfill",
		)
		const carry = new Map()
		const one = backfillRecordingLinks(db, carry, 1)
		expect(one).toMatchObject({ done: false, examined: 1, events: [] })
		const two = backfillRecordingLinks(db, carry, 1)
		expect(two.events.map(e => [e.recordingId, e.eventId])).toEqual([
			[KEY_B, pending.eventId],
		])
		const three = backfillRecordingLinks(db, carry, 1)
		expect(three).toMatchObject({ done: true, examined: 0 })
		expect(backfillRecordingLinks(db, carry, 1)).toEqual({
			done: true,
			examined: 0,
			events: [],
		})
		db.close()
	})
})

const repository = fileURLToPath(new URL("../../../../../", import.meta.url))
const bundles: string[] = []
afterAll(async () => {
	await Promise.all(
		bundles.map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("recording links through the writer thread", () => {
	it("backfills, loads the links after the backfill, and applies a late link in the worker", async () => {
		const bundleDir = await mkdtemp(join(repository, ".tmp-activity-links-"))
		bundles.push(bundleDir)
		const outfile = join(bundleDir, "activity-writer-worker.mjs")
		await build({
			absWorkingDir: repository,
			entryPoints: ["src/core/activity/storage/activity-writer-worker.ts"],
			outfile,
			bundle: true,
			platform: "node",
			format: "esm",
			packages: "external",
		})
		await writeFile(join(bundleDir, "package.json"), '{"type":"module"}\n')
		const stateDir = await tempDir()
		const legacy = await openStore({ stateDir })
		const old = callEnd("call-10", { wavFile: `/calls/${NAME_A}` })
		const { refs: _refs, ...oldRow } = old
		legacy.admit(oldRow)
		await legacy.close()
		const db = await openSqliteFile(legacy.dbPath)
		db.prepare("UPDATE store_meta SET value = '0' WHERE key = ?").run(
			"recordingLinkBackfill",
		)
		db.close()
		const store = await openActivityStore({
			stateDir,
			logger,
			execution: "thread",
			workerUrl: pathToFileURL(outfile),
			now: fixtureClock(),
			limits: { batchWindowMs: 0 },
		})
		stores.push(store)
		const seen: ActivityLinkEvent[] = []
		store.onLinks?.(e => seen.push(...e))
		await expect
			.poll(() => store.recordingEventId?.(KEY_A), { timeout: 5_000 })
			.toBe(old.eventId)
		const call = callEnd("call-11")
		store.admit(call)
		await expect
			.poll(async () => (await rows(store.dbPath)).length, { timeout: 5_000 })
			.toBe(2)
		store.link?.({
			type: "link-call",
			decoderId: "dsd-a",
			callId: "call-11",
			recording: { id: KEY_B, durationMs: 900 },
		})
		await expect
			.poll(() => store.recordingEventId?.(KEY_B), { timeout: 5_000 })
			.toBe(call.eventId)
		const stored = await rows(store.dbPath)
		expect(stored).toHaveLength(2)
		expect(
			stored.find(r => r.eventId === call.eventId)?.summary["recording"],
		).toEqual({ id: KEY_B, durationMs: 900 })
		expect(seen.some(e => e.recordingId === KEY_B && e.linked)).toBe(true)
	}, 30_000)
})
