import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import { retentionShareKey } from "../../../../../src/core/activity/storage/fair-share.js"
import { resolveActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import type { ActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import { buildActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type { BuiltActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type {
	SqliteDatabase,
	SqliteValue,
} from "../../../../../src/core/activity/storage/sqlite.js"
import { envelope } from "./helpers.js"

export const NOW = 1_700_000_000_000
export const YEAR_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Session limits for small stores. Built from the resolved defaults, then the caps are set
 * below the config floors (maxRows >= 1000, maxDbBytes >= 16 MiB) so a few hundred rows
 * exercise the prune paths. The session takes limits as given.
 */
export function smallLimits(
	patch: Partial<ActivityLimits> = {},
): ActivityLimits {
	return {
		...resolveActivityLimits({
			maxAgeMs: YEAR_MS,
			pruneBurstBatches: 1_000,
			pruneBurstMs: 600_000,
			incrementalVacuumPages: 0,
		}),
		maxRows: 1_000_000,
		maxDbBytes: Number.MAX_SAFE_INTEGER,
		...patch,
	}
}

/** A decoder-reception row of `decoderId`, or a decoder-less row of `kind` when null. */
export function shareRow(
	eventId: string,
	decoderId: string | null,
	receivedAtMs = NOW,
	blobChars = 40,
	kind: "ingestion-gap" | "analog-transmission" = "ingestion-gap",
): BuiltActivityRow {
	const stamp = new Date(receivedAtMs).toISOString()
	const row = buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId,
		commitSeq: "0",
		producedAt: stamp,
		receivedAt: stamp,
		kind: "decoder-reception",
		payload: envelope({
			eventId,
			decoderId: decoderId ?? "none",
			title: eventId,
			receivedAt: stamp,
			decodedData: { blob: "x".repeat(blobChars) },
		}),
	})
	if (decoderId !== null) return row
	return { ...row, decoderId: null, kind }
}

export interface ShareUsage {
	rows: number
	bytes: number
}

/** The grouped scan the counters must equal, keyed like the counters. */
export function groupedScan(db: SqliteDatabase): Map<string, ShareUsage> {
	const rows = db
		.prepare(
			`SELECT decoder_id, kind, COUNT(*) AS n, COALESCE(SUM(record_bytes), 0) AS b
			 FROM activity GROUP BY decoder_id, CASE WHEN decoder_id IS NULL THEN kind END`,
		)
		.all()
	const map = new Map<string, ShareUsage>()
	for (const row of rows) {
		const decoderId = row["decoder_id"]
		const kind = row["kind"]
		map.set(
			retentionShareKey(
				typeof decoderId === "string" ? decoderId : null,
				String(kind),
			),
			{ rows: num(row["n"]), bytes: num(row["b"]) },
		)
	}
	return map
}

export function sharesOf(
	shares: readonly { key: string; rows: number; bytes: number }[],
): Map<string, ShareUsage> {
	return new Map(
		shares.map(share => [share.key, { rows: share.rows, bytes: share.bytes }]),
	)
}

export function seqs(db: SqliteDatabase): bigint[] {
	return db
		.prepare("SELECT CAST(seq AS TEXT) AS s FROM activity ORDER BY seq")
		.all()
		.map(row => BigInt(String(row["s"])))
}

export interface MetaReading {
	pruneWatermark: bigint
	pruneGeneration: number
	holeWatermark: bigint
	holeGeneration: number
}

export function readMeta(db: SqliteDatabase): MetaReading {
	const map = new Map<string, string>()
	for (const row of db.prepare("SELECT key, value FROM store_meta").all())
		map.set(String(row["key"]), String(row["value"]))
	return {
		pruneWatermark: BigInt(map.get("pruneWatermark") ?? "0"),
		pruneGeneration: Number(map.get("pruneGeneration") ?? "0"),
		holeWatermark: BigInt(map.get("holeWatermark") ?? "0"),
		holeGeneration: Number(map.get("holeGeneration") ?? "0"),
	}
}

/**
 * A database wrapper whose `prepare` throws for SQL matching `fail` while `armed()` is true.
 * Used to inject a failing seed scan or a failing prune statement.
 */
export function faultyDb(
	raw: SqliteDatabase,
	fail: (sql: string) => boolean,
	armed: () => boolean,
): SqliteDatabase {
	return {
		exec(sql) {
			raw.exec(sql)
		},
		prepare(sql) {
			if (armed() && fail(sql)) throw new Error(`injected failure: ${sql}`)
			return raw.prepare(sql)
		},
		close() {
			raw.close()
		},
	}
}

function num(value: SqliteValue | undefined): number {
	if (typeof value === "number") return value
	if (typeof value === "bigint") return Number(value)
	return Number(value)
}
