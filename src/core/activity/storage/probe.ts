import { ActivityUnavailableError } from "./errors.js"
import type { SqliteDatabase } from "./sqlite.js"

export type ActivityProbeResult = { ok: true } | { ok: false; reason: string }

interface DatabaseSyncConstructor {
	new (
		path: string,
		options?: {
			readOnly?: boolean
			enableForeignKeyConstraints?: boolean
			timeout?: number
		},
	): SqliteDatabase
}

/**
 * Loads node:sqlite. Callers must already have passed probeActivityRuntime
 * before creating a state file. Never imported at module top level.
 */
export async function loadDatabaseSync(): Promise<DatabaseSyncConstructor> {
	const loaded: unknown = await import("node:sqlite")
	const exported =
		typeof loaded === "object" && loaded !== null
			? (loaded as { DatabaseSync?: unknown }).DatabaseSync
			: undefined
	if (typeof exported !== "function")
		throw new ActivityUnavailableError(
			"node:sqlite DatabaseSync is unavailable",
		)
	return exported as DatabaseSyncConstructor
}

export async function openSqliteFile(
	path: string,
	readOnly = false,
): Promise<SqliteDatabase> {
	const DatabaseSync = await loadDatabaseSync()
	return new DatabaseSync(path, {
		readOnly,
		enableForeignKeyConstraints: true,
		timeout: 100,
	})
}

/**
 * Runtime floor for Activity: node:sqlite loads and an in-memory FTS5 table
 * with contentless_delete=1 can be created. A version string is not consulted.
 * Failure returns a reason and does not write a state file.
 */
export async function probeActivityRuntime(): Promise<ActivityProbeResult> {
	let db: SqliteDatabase | undefined
	try {
		const DatabaseSync = await loadDatabaseSync()
		db = new DatabaseSync(":memory:")
		db.exec(
			"CREATE VIRTUAL TABLE activity_probe USING fts5(text, content='', contentless_delete=1)",
		)
		return { ok: true }
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		return { ok: false, reason }
	} finally {
		try {
			db?.close()
		} catch {
			// The probe result is the capability, not cleanup.
		}
	}
}
