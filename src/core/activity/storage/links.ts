/**
 * Recording links in the store (writer thread only): a row's playable recording lives in its
 * summary (`recording`) and in one `recordingId` ref. Rows gain a link when they are stored
 * (row.ts rowWithRecording), when a call's file is found after its row was stored (`link-call`),
 * or by the backfill of stores written before links existed; they lose it when the file is
 * deleted (`unlink`). Only `summary_json` and `activity_refs` change: `record_json` and
 * `record_bytes` stay what was received, so retention counters never drift.
 */
import { RECORDINGS_CATALOGUE_MAX } from "@wavekit/api-types"
import { recordingBaseName } from "../recording-path.js"
import type {
	ActivityLinkEvent,
	ActivityLinkOp,
	ActivityRecordingLink,
} from "./contract.js"
import { dsdFmeKeepKey } from "../../recordings/contract.js"
import {
	callTrustAdmits,
	dsdFmeCallRecordable,
	protocolRecordable,
} from "../../../decoders/builtin/dmr-recording-gate.js"
import { recordingLinkOf, summaryWithRecording } from "./row.js"
import { bindInteger, cell } from "./sqlite.js"
import type { SqliteDatabase, SqliteStatement, SqliteValue } from "./sqlite.js"

/**
 * Link changes held for the writer at most (each is a few hundred bytes). 1 024 covers a
 * minute of late call files at 17 calls a second, or 1 024 deleted files of one sweep.
 */
export const ACTIVITY_LINK_OPS_MAX = 1_024

/**
 * Links the parent remembers (recording key → newest row) and the writer loads at open: the
 * recordings catalogue bound (RECORDINGS_CATALOGUE_MAX), since a key outside the catalogue
 * cannot be listed with its row anyway.
 */
export const ACTIVITY_LINKS_MAX = RECORDINGS_CATALOGUE_MAX

/**
 * Voice rows the backfill examines per transaction. A write waits for at most one chunk: 2 000
 * rows took up to 286 ms on a 250 000-row store at load 5 (half of them linked); 500 take 18 ms
 * (median, at most 89 ms) alone and at most 82 ms beside writes at load 5 (docs/PERFORMANCE.md,
 * scripts/longevity/recording-links.ts).
 */
export const ACTIVITY_LINK_BACKFILL_CHUNK = 500

/**
 * Calls whose file had not been found when their row was stored, remembered by the backfill to
 * link the late `wavFileUpdate` row's file to them (it follows its call within about a second).
 */
const BACKFILL_PENDING_CALLS = 4_096

const META_KEY = "recordingLinkBackfill"

/**
 * A call the backfill waits on for its late file, with whether it may be recorded: its protocol
 * is recordable and its row says it clear (callTrustAdmits).
 */
type PendingCall = LinkedRow & { durationMs: unknown; recordable: boolean }

/**
 * Whether a backfilled row of this protocol may link this dsd-fme call file: both the row's
 * `protocol` and the protocol in the file name must be recordable (protocolRecordable), so a DMR
 * call (by either) never links while DMR recordings are off, and neither does a row or name
 * without a known protocol.
 */
function backfillLinkable(protocol: unknown, name: string): boolean {
	return (
		typeof protocol === "string" &&
		protocolRecordable(protocol) &&
		dsdFmeCallRecordable(name)
	)
}

interface LinkedRow {
	seq: bigint
	eventId: string
	summaryJson: string
}

function linkedRows(
	db: SqliteDatabase,
	sql: string,
	...params: SqliteValue[]
): LinkedRow[] {
	const out: LinkedRow[] = []
	for (const row of db.prepare(sql).all(...params)) {
		const seq = cell(row, "seq")
		const eventId = cell(row, "event_id")
		const summaryJson = cell(row, "summary_json")
		if (
			(typeof seq !== "number" && typeof seq !== "bigint") ||
			typeof eventId !== "string" ||
			typeof summaryJson !== "string"
		)
			continue
		out.push({ seq: BigInt(seq), eventId, summaryJson })
	}
	return out
}

interface LinkStatements {
	summary: SqliteStatement
	dropRef: SqliteStatement
	addRef: SqliteStatement
}

/** Prepared once per connection (the writer's). */
const statements = new WeakMap<SqliteDatabase, LinkStatements>()

function linkStatements(db: SqliteDatabase): LinkStatements {
	let prepared = statements.get(db)
	if (prepared === undefined) {
		prepared = {
			summary: db.prepare("UPDATE activity SET summary_json = ? WHERE seq = ?"),
			dropRef: db.prepare(
				"DELETE FROM activity_refs WHERE seq = ? AND ref_type = 'recordingId'",
			),
			addRef: db.prepare(
				"INSERT INTO activity_refs(seq, ref_type, ref_value) VALUES (?, 'recordingId', ?)",
			),
		}
		statements.set(db, prepared)
	}
	return prepared
}

/**
 * Sets (or, with null, removes) one row's link. False when its summary cannot carry one, or when
 * the row is gone (pruned since it was read: a backfill's call waiting across chunks), so no ref
 * is ever added for a row that does not exist (its foreign key would fail).
 */
function setLink(
	db: SqliteDatabase,
	row: LinkedRow,
	link: ActivityRecordingLink | null,
): boolean {
	const summary = summaryWithRecording(row.summaryJson, link)
	if (summary === null) return false
	const seq = bindInteger(row.seq)
	const st = linkStatements(db)
	if (Number(st.summary.run(summary, seq).changes) !== 1) return false
	st.dropRef.run(seq)
	if (link !== null) st.addRef.run(seq, link.id)
	return true
}

const CALL_ROWS = `SELECT a.seq AS seq, a.event_id AS event_id, a.summary_json AS summary_json
	FROM activity_refs r JOIN activity a ON a.seq = r.seq
	WHERE r.ref_type = 'callId' AND r.ref_value = ? AND a.decoder_id = ? AND a.kind = 'decoder-reception'`

const LINKED_ROWS = `SELECT a.seq AS seq, a.event_id AS event_id, a.summary_json AS summary_json
	FROM activity_refs r JOIN activity a ON a.seq = r.seq
	WHERE r.ref_type = 'recordingId' AND r.ref_value = ?`

/**
 * Applies link changes in one transaction (the caller's write runs first). Returns what
 * changed; a row already in the asked state is not reported.
 */
export function applyActivityLinks(
	db: SqliteDatabase,
	ops: readonly ActivityLinkOp[],
): ActivityLinkEvent[] {
	if (ops.length === 0) return []
	const events: ActivityLinkEvent[] = []
	db.exec("BEGIN IMMEDIATE")
	try {
		for (const op of ops) {
			if (op.type === "link-call") {
				const link = recordingLinkOf(op.recording.id, op.recording.durationMs)
				if (link === null) continue
				for (const row of linkedRows(db, CALL_ROWS, op.callId, op.decoderId)) {
					if (setLink(db, row, link))
						events.push({
							recordingId: link.id,
							eventId: row.eventId,
							seq: row.seq.toString(10),
							linked: true,
						})
				}
				continue
			}
			for (const id of op.recordingIds) {
				const rows = linkedRows(db, LINKED_ROWS, id)
				// No row holds the key any more (pruned meanwhile): the parent forgets it
				// (eventId ""), so a sweep does not ask again.
				if (rows.length === 0)
					events.push({ recordingId: id, eventId: "", seq: "0", linked: false })
				for (const row of rows) {
					if (setLink(db, row, null))
						events.push({
							recordingId: id,
							eventId: row.eventId,
							seq: row.seq.toString(10),
							linked: false,
						})
				}
			}
		}
		db.exec("COMMIT")
	} catch (error) {
		try {
			db.exec("ROLLBACK")
		} catch {
			// The first error is the one the caller needs.
		}
		throw error
	}
	return events
}

/** Every link, newest row first, at most `max`: the parent's index after open. */
export function readRecordingLinks(
	db: SqliteDatabase,
	max: number = ACTIVITY_LINKS_MAX,
): ActivityLinkEvent[] {
	const out: ActivityLinkEvent[] = []
	const rows = db
		.prepare(
			`SELECT r.ref_value AS ref_value, a.event_id AS event_id, CAST(a.seq AS TEXT) AS seq
			 FROM activity_refs r JOIN activity a ON a.seq = r.seq
			 WHERE r.ref_type = 'recordingId' ORDER BY r.seq DESC LIMIT ?`,
		)
		.all(max)
	for (const row of rows) {
		const id = cell(row, "ref_value")
		const eventId = cell(row, "event_id")
		const seq = cell(row, "seq")
		if (
			typeof id !== "string" ||
			typeof eventId !== "string" ||
			typeof seq !== "string"
		)
			continue
		out.push({ recordingId: id, eventId, seq, linked: true })
	}
	return out
}

export interface LinkBackfillStep {
	/** True once every row was examined (the store meta then reads "done"). */
	done: boolean
	examined: number
	events: ActivityLinkEvent[]
}

/** Where the backfill stands: "done", or the greatest seq examined (decimal). */
export function readLinkBackfill(db: SqliteDatabase): string {
	const row = db
		.prepare("SELECT value FROM store_meta WHERE key = ?")
		.get(META_KEY)
	const value = cell(row, "value")
	if (value === "done") return "done"
	return typeof value === "string" && /^\d+$/.test(value) ? value : "0"
}

/**
 * Links stores written before recording links, one chunk per call (a transaction of at most
 * ACTIVITY_LINK_BACKFILL_CHUNK voice rows, read through the category index), resuming from the
 * store meta cursor. A dsd-fme `call_end` row with a `wavFile` gains `dsd~<name>`; a later
 * `wavFileUpdate` row (the file found late) links its call's row instead and stays unlinked
 * itself. Probe calls are linked the same way: a key the recordings catalogue does not list is
 * removed by the link sweep (recording-links.ts). `pending` carries unmatched calls between
 * chunks.
 */
export function backfillRecordingLinks(
	db: SqliteDatabase,
	pending: Map<string, PendingCall>,
	chunk: number = ACTIVITY_LINK_BACKFILL_CHUNK,
	/**
	 * The newest row stored before this open (null: no limit). Rows after it came through the
	 * live path, which already linked them or chose not to (a probe's call).
	 */
	untilSeq: bigint | null = null,
): LinkBackfillStep {
	const cursor = readLinkBackfill(db)
	if (cursor === "done") return { done: true, examined: 0, events: [] }
	const rows = db
		.prepare(
			`SELECT seq, event_id, decoder_id, summary_json,
				json_extract(record_json, '$.payload.outputType') AS output_type,
				json_extract(record_json, '$.payload.decodedData.wavFile') AS wav_file,
				json_extract(record_json, '$.payload.decodedData.callId') AS call_id,
				json_extract(record_json, '$.payload.decodedData.flags.wavFileUpdate') AS late,
				json_extract(record_json, '$.payload.decodedData.duration') AS duration,
				json_extract(record_json, '$.payload.decodedData.protocol') AS protocol,
				json_extract(record_json, '$.payload.decodedData.encrypted') AS encrypted,
				json_extract(record_json, '$.payload.decodedData.encryptionKnown') AS known,
				json_extract(record_json, '$.payload.decodedData.clearEvidence') AS evidence,
				json_extract(record_json, '$.payload.decodedData.flags.encrypted') AS flagged
			 FROM activity
			 WHERE category = 'voice' AND kind = 'decoder-reception' AND seq > ? AND seq <= ?
			 ORDER BY seq LIMIT ?`,
		)
		.all(
			bindInteger(BigInt(cursor)),
			bindInteger(untilSeq ?? BigInt(Number.MAX_SAFE_INTEGER)),
			chunk,
		)
	const events: ActivityLinkEvent[] = []
	let last = BigInt(cursor)
	db.exec("BEGIN IMMEDIATE")
	try {
		for (const row of rows) {
			const seqCell = cell(row, "seq")
			if (typeof seqCell !== "number" && typeof seqCell !== "bigint") continue
			const seq = BigInt(seqCell)
			if (seq > last) last = seq
			if (cell(row, "output_type") !== "call_end") continue
			const eventId = cell(row, "event_id")
			const summaryJson = cell(row, "summary_json")
			const decoderId = cell(row, "decoder_id")
			if (
				typeof eventId !== "string" ||
				typeof summaryJson !== "string" ||
				typeof decoderId !== "string"
			)
				continue
			const callId = cell(row, "call_id")
			const callKey =
				typeof callId === "string" ? `${decoderId}\u0000${callId}` : null
			const wav = cell(row, "wav_file")
			const late = cell(row, "late") === 1
			const name = typeof wav === "string" ? recordingBaseName(wav) : null
			const key = name === null ? null : dsdFmeKeepKey(name)
			const protocol = cell(row, "protocol")
			// This row's own trust fields (callTrustAdmits); JSON booleans read back as 1 / 0.
			const bool = (v: unknown): unknown =>
				v === 1 || v === 1n ? true : v === 0 || v === 0n ? false : v
			const flagged = bool(cell(row, "flagged"))
			const clear = callTrustAdmits(protocol, {
				encrypted: bool(cell(row, "encrypted")),
				encryptionKnown: bool(cell(row, "known")),
				clearEvidence: bool(cell(row, "evidence")),
				...(flagged !== null ? { flags: { encrypted: flagged } } : {}),
			})
			let target: PendingCall | undefined
			if (late) {
				target = callKey === null ? undefined : pending.get(callKey)
				if (callKey !== null) pending.delete(callKey)
			} else if (key === null) {
				if (callKey !== null) {
					pending.delete(callKey)
					pending.set(callKey, {
						seq,
						eventId,
						summaryJson,
						durationMs: cell(row, "duration"),
						recordable:
							typeof protocol === "string" &&
							protocolRecordable(protocol) &&
							clear,
					})
					while (pending.size > BACKFILL_PENDING_CALLS) {
						const oldest = pending.keys().next()
						if (oldest.done === true) break
						pending.delete(oldest.value)
					}
				}
				continue
			} else {
				target = {
					seq,
					eventId,
					summaryJson,
					durationMs: cell(row, "duration"),
					recordable: true,
				}
			}
			if (target === undefined || key === null || name === null) continue
			// A DMR call (or one of unknown protocol) never links while DMR recordings are off:
			// the file's row, its call's row and the file name must all say a recordable protocol.
			if (!target.recordable || !clear || !backfillLinkable(protocol, name))
				continue
			const link = recordingLinkOf(key, target.durationMs)
			if (link === null) continue
			// One row that cannot be linked is skipped; it never stops the backfill.
			let set = false
			try {
				set = setLink(db, target, link)
			} catch {
				set = false
			}
			if (!set) continue
			events.push({
				recordingId: link.id,
				eventId: target.eventId,
				seq: target.seq.toString(10),
				linked: true,
			})
		}
		const done = rows.length < chunk
		db.prepare("UPDATE store_meta SET value = ? WHERE key = ?").run(
			done ? "done" : last.toString(10),
			META_KEY,
		)
		db.exec("COMMIT")
		return { done, examined: rows.length, events }
	} catch (error) {
		try {
			db.exec("ROLLBACK")
		} catch {
			// The first error is the one the caller needs.
		}
		throw error
	}
}

export type BackfillPending = Map<string, PendingCall>
