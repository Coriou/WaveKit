import { randomUUID } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import type { DecodeEnvelope } from "../../../../../src/core/activity/types.js"
import type {
	ActivityRecord,
	ActivityStoreHandle,
} from "../../../../../src/core/activity/storage/contract.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import { parseStoredRecord } from "../../../../../src/core/activity/storage/row.js"
import { openActivityStore } from "../../../../../src/core/activity/storage/store.js"
import type { OpenActivityStoreOptions } from "../../../../../src/core/activity/storage/store.js"
import type { Logger } from "../../../../../src/utils/logger.js"

export const logger = pino({ level: "silent" })

export const roots: string[] = []
export const stores: ActivityStoreHandle[] = []

export async function tempDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "wavekit-activity-"))
	roots.push(path)
	return path
}

export async function openStore(
	overrides: Partial<OpenActivityStoreOptions> = {},
): Promise<ActivityStoreHandle> {
	const stateDir = overrides.stateDir ?? (await tempDir())
	const store = await openActivityStore({
		stateDir,
		logger,
		execution: "inline",
		...overrides,
		limits: {
			batchWindowMs: 0,
			...overrides.limits,
		},
	})
	stores.push(store)
	return store
}

export function envelope(patch: EnvelopePatch = {}): DecodeEnvelope {
	const receivedAt = patch.receivedAt ?? "2026-10-12T00:00:00.000Z"
	const producedAt = patch.producedAt ?? receivedAt
	const frequencyHz =
		patch.frequencyHz === undefined ? 1090.4 : patch.frequencyHz
	return {
		version: 1,
		eventId: patch.eventId ?? randomUUID(),
		producedAt,
		receivedAt,
		decoderId: patch.decoderId ?? "decoder-1",
		outputType: patch.outputType ?? "aircraft",
		protocol: patch.protocol === undefined ? "adsb" : patch.protocol,
		category: patch.category ?? "aircraft",
		entityKey: patch.entityKey === undefined ? "abc123" : patch.entityKey,
		title: patch.title === undefined ? "alphaunique" : patch.title,
		fields: patch.fields ?? [
			{ key: "callsign", label: "Callsign", value: "UAL1" },
		],
		provenance: {
			sourceId: patch.sourceId === undefined ? "source-1" : patch.sourceId,
			frequency:
				frequencyHz === null
					? null
					: { hz: frequencyHz, basis: "channel", tuningTrust: "commanded" },
			...(patch.jobId === undefined
				? { jobId: "job-1" }
				: { jobId: patch.jobId }),
		},
		decodedData: patch.decodedData ?? { nested: { note: "leafunique" } },
	}
}

interface EnvelopePatch {
	eventId?: string
	decoderId?: string
	outputType?: string
	receivedAt?: string
	producedAt?: string
	title?: string | null
	protocol?: string | null
	entityKey?: string | null
	category?: DecodeEnvelope["category"]
	fields?: DecodeEnvelope["fields"]
	decodedData?: DecodeEnvelope["decodedData"]
	frequencyHz?: number | null
	jobId?: string
	sourceId?: string | null
}

export async function readRecords(dbPath: string): Promise<ActivityRecord[]> {
	const db = await openSqliteFile(dbPath, true)
	try {
		const rows = db
			.prepare(
				`SELECT CAST(seq AS TEXT) AS seq, event_id, kind, summary_json, record_json
				 FROM activity ORDER BY seq`,
			)
			.all()
		return rows.map(row =>
			parseStoredRecord({
				seq: text(row["seq"]),
				event_id: text(row["event_id"]),
				kind: text(row["kind"]),
				summary_json: text(row["summary_json"]),
				record_json: text(row["record_json"]),
			}),
		)
	} finally {
		db.close()
	}
}

export async function countFts(dbPath: string, token: string): Promise<number> {
	const db = await openSqliteFile(dbPath, true)
	try {
		const row = db
			.prepare(
				"SELECT COUNT(*) AS n FROM activity_fts WHERE activity_fts MATCH ?",
			)
			.get(`"${token}"`)
		const value = row?.["n"]
		return typeof value === "number" ? value : Number(value)
	} finally {
		db.close()
	}
}

function text(value: unknown): string {
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "bigint")
		return String(value)
	throw new Error("expected text column")
}

export type { Logger }
