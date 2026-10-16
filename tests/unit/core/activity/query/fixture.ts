import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import pino from "pino"
import type {
	ActivityCategory,
	ActivityKind,
	ActivityQueryService,
	ActivityRefType,
	ActivityReplayFrame,
	ActivityReplayHandle,
	ActivityReplayRequest,
	StoreIdentity,
} from "../../../../../src/core/activity/storage/contract.js"
import { ACTIVITY_SCHEMA_V1 } from "../../../../../src/core/activity/storage/contract.js"
import {
	createActivityQueryService,
	type ActivityQueryServiceOptions,
} from "../../../../../src/core/activity/query/service.js"
import type { ActivityStoreQueryHandle } from "../../../../../src/core/activity/query/service.js"

export const testLogger = pino({ level: "silent" })

export interface FixtureInsert {
	eventId: string
	kind?: ActivityKind
	category?: ActivityCategory
	sourceId?: string | null
	decoderId?: string | null
	protocol?: string | null
	frequencyHz?: number | null
	entityKey?: string | null
	title?: string | null
	producedAt?: string
	receivedAt?: string
	text?: string
	refs?: readonly { type: ActivityRefType; value: string }[]
}

export interface ActivityFixture {
	readonly dir: string
	readonly dbPath: string
	readonly store: ActivityStoreQueryHandle
	insert(row: FixtureInsert): string
	/** Put a stale commitSeq into record_json. The reader must replace it. */
	stampStaleCommitSeq(eventId: string): void
	pruneThrough(watermark: string): void
	setIdentity(patch: Partial<StoreIdentity>): void
	/**
	 * Advance the on-disk prune watermark and delete those rows without telling
	 * the cached identity. Models a writer commit the main thread has not seen.
	 */
	divergePrune(watermark: string): void
	/** Change on-disk store identity without updating the cached copy. */
	divergeMeta(
		patch: Partial<Pick<StoreIdentity, "storeUuid" | "restoreGeneration">>,
	): void
	corruptSummary(eventId: string): void
	/**
	 * Emulates the writer opening a hole (web-gaps-3 3.x): deletes the given
	 * rows, raises holeWatermark to the greatest deleted seq and increments
	 * holeGeneration in one transaction. `diverge` leaves the cached identity
	 * untouched (a commit the main thread has not seen yet).
	 */
	openHole(seqs: readonly string[], options?: { diverge?: boolean }): void
	/** Raw store_meta write; null deletes the key. */
	writeRawMeta(key: string, value: string | null): void
	notify(): void
	listenerCount(): number
	reset(): void
	close(): Promise<void>
}

function seqText(value: number | bigint): string {
	return typeof value === "bigint" ? value.toString(10) : String(value)
}

export interface FixtureOptions {
	/**
	 * Shared in-memory database (`file:name?mode=memory&cache=shared`).
	 * A query property reuses one of these and resets between runs. Another
	 * thread cannot open it, so worker tests stay on a file.
	 */
	memory?: boolean
}

export async function createFixture(
	options: FixtureOptions = {},
): Promise<ActivityFixture> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-activity-query-"))
	const dbPath = options.memory
		? `file:wavekit-activity-${randomBytes(8).toString("hex")}?mode=memory&cache=shared`
		: join(dir, "activity.db")
	const db = new DatabaseSync(dbPath)
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("PRAGMA foreign_keys = ON")
	db.exec(ACTIVITY_SCHEMA_V1)
	const cursorKey = randomBytes(32)
	const upsertMeta = db.prepare(
		"INSERT INTO store_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	)
	const initial: StoreIdentity = {
		storeUuid: randomUUID(),
		restoreGeneration: 1,
		pruneWatermark: "0",
		pruneGeneration: 0,
		committedMax: "0",
	}
	const identity: StoreIdentity = { ...initial }
	const listeners = new Set<(snapshot: StoreIdentity) => void>()
	const seqs: string[] = []

	const insertActivity = db.prepare(
		`INSERT INTO activity (
			event_id, kind, produced_at_ms, received_at_ms, source_id, decoder_id,
			protocol, category, frequency_hz, entity_key, summary_json, record_json, record_bytes
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	const insertFts = db.prepare(
		"INSERT INTO activity_fts (rowid, text) VALUES (?, ?)",
	)
	const insertRef = db.prepare(
		"INSERT INTO activity_refs (seq, ref_type, ref_value) VALUES (?, ?, ?)",
	)
	const deleteRefs = db.prepare("DELETE FROM activity_refs WHERE seq = ?")
	const deleteFts = db.prepare("DELETE FROM activity_fts WHERE rowid = ?")
	const deleteRow = db.prepare("DELETE FROM activity WHERE seq = ?")
	const deleteMeta = db.prepare("DELETE FROM store_meta WHERE key = ?")
	const readMeta = db.prepare("SELECT value FROM store_meta WHERE key = ?")

	function writeMeta(next: StoreIdentity): void {
		const rows: readonly (readonly [string, string])[] = [
			["schemaVersion", "1"],
			["storeUuid", next.storeUuid],
			["restoreGeneration", String(next.restoreGeneration)],
			["pruneWatermark", next.pruneWatermark],
			["pruneGeneration", String(next.pruneGeneration)],
			["cursorKey", cursorKey.toString("hex")],
		]
		for (const [key, value] of rows) upsertMeta.run(key, value)
		// Hole keys are written only by openHole/writeRawMeta and cleared by reset.
		if (next.holeWatermark !== undefined) {
			upsertMeta.run("holeWatermark", next.holeWatermark)
		}
		if (next.holeGeneration !== undefined) {
			upsertMeta.run("holeGeneration", String(next.holeGeneration))
		}
	}

	function snapshot(): StoreIdentity {
		return { ...identity }
	}

	writeMeta(initial)

	const store: ActivityStoreQueryHandle = {
		dbPath,
		identity: snapshot,
		cursorKey: () => Buffer.from(cursorKey),
		onCommit(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}

	return {
		dir,
		dbPath,
		store,
		insert(row) {
			const producedAt = row.producedAt ?? "2026-01-01T00:00:00.000Z"
			const receivedAt = row.receivedAt ?? producedAt
			const kind = row.kind ?? "decoder-reception"
			const category = row.category ?? "other"
			const sourceId = row.sourceId ?? null
			const decoderId = row.decoderId ?? null
			const protocol = row.protocol ?? null
			const frequencyHz = row.frequencyHz ?? null
			const entityKey = row.entityKey ?? null
			const title = row.title ?? null
			const summary = {
				eventId: row.eventId,
				commitSeq: "0",
				kind,
				producedAt,
				receivedAt,
				decoderId,
				sourceId,
				protocol,
				category,
				frequencyHz,
				entityKey,
				title,
				fields: [],
			}
			const payload =
				kind === "ingestion-gap"
					? {
							reason: "queue-full",
							dropped: 1,
							decoderIds: decoderId === null ? [] : [decoderId],
							fromReceivedAt: receivedAt,
							toReceivedAt: receivedAt,
						}
					: {
							version: 1,
							eventId: row.eventId,
							producedAt,
							receivedAt,
							decoderId: decoderId ?? "decoder",
							outputType: "test",
							protocol,
							category,
							entityKey,
							title,
							fields: [],
							provenance: {
								sourceId,
								frequency:
									frequencyHz === null
										? null
										: {
												hz: frequencyHz,
												basis: "channel",
												tuningTrust: "commanded",
											},
							},
							decodedData: { text: row.text ?? "" },
						}
			const record = {
				version: 1,
				eventId: row.eventId,
				kind,
				producedAt,
				receivedAt,
				payload,
			}
			const recordJson = JSON.stringify(record)
			const result = insertActivity.run(
				row.eventId,
				kind,
				Date.parse(producedAt),
				Date.parse(receivedAt),
				sourceId,
				decoderId,
				protocol,
				category,
				frequencyHz,
				entityKey,
				JSON.stringify(summary),
				recordJson,
				Buffer.byteLength(recordJson),
			)
			const seq = seqText(result.lastInsertRowid)
			seqs.push(seq)
			if (row.text !== undefined && row.text.length > 0) {
				insertFts.run(Number(seq), row.text)
			}
			for (const ref of row.refs ?? []) {
				insertRef.run(Number(seq), ref.type, ref.value)
			}
			identity.committedMax = seq
			return seq
		},
		stampStaleCommitSeq(eventId) {
			const found = db
				.prepare("SELECT record_json FROM activity WHERE event_id = ?")
				.get(eventId) as { record_json: string } | undefined
			if (!found) throw new Error(`missing ${eventId}`)
			const parsed = JSON.parse(found.record_json) as Record<string, unknown>
			parsed["commitSeq"] = "999"
			db.prepare("UPDATE activity SET record_json = ? WHERE event_id = ?").run(
				JSON.stringify(parsed),
				eventId,
			)
		},
		pruneThrough(watermark) {
			const bound = Number(watermark)
			const rows = db
				.prepare("SELECT seq FROM activity WHERE seq <= ?")
				.all(bound) as { seq: number | bigint }[]
			for (const row of rows) {
				const seq = seqText(row.seq)
				deleteRefs.run(Number(seq))
				deleteFts.run(Number(seq))
			}
			db.prepare("DELETE FROM activity WHERE seq <= ?").run(bound)
			identity.pruneWatermark = watermark
			identity.pruneGeneration += 1
			writeMeta(identity)
		},
		setIdentity(patch) {
			Object.assign(identity, patch)
		},
		divergePrune(watermark) {
			const bound = Number(watermark)
			db.exec("BEGIN")
			try {
				const rows = db
					.prepare("SELECT seq FROM activity WHERE seq <= ?")
					.all(bound) as { seq: number | bigint }[]
				for (const row of rows) {
					const seq = seqText(row.seq)
					deleteRefs.run(Number(seq))
					deleteFts.run(Number(seq))
				}
				db.prepare("DELETE FROM activity WHERE seq <= ?").run(bound)
				upsertMeta.run("pruneWatermark", watermark)
				db.exec("COMMIT")
			} catch (error) {
				db.exec("ROLLBACK")
				throw error
			}
		},
		divergeMeta(patch) {
			if (patch.storeUuid !== undefined) {
				upsertMeta.run("storeUuid", patch.storeUuid)
			}
			if (patch.restoreGeneration !== undefined) {
				upsertMeta.run("restoreGeneration", String(patch.restoreGeneration))
			}
		},
		corruptSummary(eventId) {
			db.prepare("UPDATE activity SET summary_json = ? WHERE event_id = ?").run(
				"{",
				eventId,
			)
		},
		openHole(seqs, options = {}) {
			const onDisk = (key: string): string | undefined => {
				const row = readMeta.get(key) as { value: string } | undefined
				return row?.value
			}
			let watermark = BigInt(onDisk("holeWatermark") ?? "0")
			const generation = Number(onDisk("holeGeneration") ?? "0") + 1
			db.exec("BEGIN")
			try {
				for (const seq of seqs) {
					deleteRefs.run(Number(seq))
					deleteFts.run(Number(seq))
					deleteRow.run(Number(seq))
					if (BigInt(seq) > watermark) watermark = BigInt(seq)
				}
				upsertMeta.run("holeWatermark", watermark.toString(10))
				upsertMeta.run("holeGeneration", String(generation))
				db.exec("COMMIT")
			} catch (error) {
				db.exec("ROLLBACK")
				throw error
			}
			if (options.diverge !== true) {
				identity.holeWatermark = watermark.toString(10)
				identity.holeGeneration = generation
			}
		},
		writeRawMeta(key, value) {
			if (value === null) deleteMeta.run(key)
			else upsertMeta.run(key, value)
		},
		notify() {
			const current = snapshot()
			for (const listener of [...listeners]) listener(current)
		},
		listenerCount: () => listeners.size,
		reset() {
			for (const seq of seqs) {
				deleteRefs.run(Number(seq))
				deleteFts.run(Number(seq))
			}
			db.exec("DELETE FROM activity")
			seqs.length = 0
			listeners.clear()
			delete identity.holeWatermark
			delete identity.holeGeneration
			Object.assign(identity, initial)
			deleteMeta.run("holeWatermark")
			deleteMeta.run("holeGeneration")
			writeMeta(identity)
		},
		async close() {
			db.close()
			await rm(dir, { recursive: true, force: true })
		},
	}
}

/**
 * Test services record every search, detail and facet promise and finish
 * those reads before `close`. A timed-out test can drop its await; settling
 * here keeps that rejection off the process.
 */
export function openQueryService(
	fixture: ActivityFixture,
	overrides: Partial<Omit<ActivityQueryServiceOptions, "store">> = {},
): ActivityQueryService {
	const limits = {
		deadlineMs: 2_000,
		...overrides.limits,
	}
	const service = createActivityQueryService({
		store: fixture.store,
		logger: testLogger,
		execution: "inline",
		...overrides,
		limits,
	})
	const inflight = new Set<Promise<unknown>>()
	let draining = false

	function track<T>(promise: Promise<T>): Promise<T> {
		const settled = promise.finally(() => {
			inflight.delete(settled)
		})
		inflight.add(settled)
		if (draining) void settled.catch(() => {})
		return settled
	}

	return {
		search: input => track(service.search(input)),
		detail: eventId => track(service.detail(eventId)),
		facets: input => track(service.facets(input)),
		replay: (input, sink) => service.replay(input, sink),
		async close() {
			draining = true
			while (inflight.size > 0) {
				const pending = [...inflight]
				await Promise.allSettled(pending)
			}
			await service.close()
		},
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms)
	})
}

export function recordEventIds(
	frames: readonly ActivityReplayFrame[],
): string[] {
	const ids: string[] = []
	for (const frame of frames) {
		if (frame.type !== "records") continue
		for (const item of frame.items) ids.push(item.eventId)
	}
	return ids
}

export async function collectReplay(
	service: ActivityQueryService,
	input: ActivityReplayRequest,
	stopWhen: (frames: readonly ActivityReplayFrame[]) => boolean,
	timeoutMs = 2_000,
): Promise<{ frames: ActivityReplayFrame[]; handle: ActivityReplayHandle }> {
	const frames: ActivityReplayFrame[] = []
	let settle = (): void => {}
	const done = new Promise<void>(resolve => {
		settle = resolve
	})
	const handle = service.replay(input, {
		send(frame) {
			frames.push(frame)
			if (stopWhen(frames)) settle()
			return true
		},
	})
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`replay timed out after ${frames.length} frames ${JSON.stringify(frames.map(frame => (frame.type === "records" ? { type: frame.type, n: frame.items.length, scannedThrough: frame.scannedThrough } : frame)))}`,
				),
			)
		}, timeoutMs)
	})
	try {
		await Promise.race([done, timeout])
	} catch (error) {
		handle.stop()
		throw error
	} finally {
		if (timer) clearTimeout(timer)
	}
	return { frames, handle }
}
