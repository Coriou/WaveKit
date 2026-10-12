/**
 * node:sqlite is loaded with a dynamic import so a process that never opens
 * Activity does not touch the builtin. Do not add a top-level import.
 */

export type SqlValue = string | number | bigint | null

export interface SqlStatement {
	all(...params: SqlValue[]): Record<string, unknown>[]
	get(...params: SqlValue[]): Record<string, unknown> | undefined
}

export interface SqlDatabase {
	prepare(sql: string): SqlStatement
	exec(sql: string): void
	close(): void
}

interface SqliteStatement {
	all(...params: SqlValue[]): unknown
	get(...params: SqlValue[]): unknown
}

interface SqliteDatabase {
	prepare(sql: string): SqliteStatement
	exec(sql: string): void
	close(): void
}

interface SqliteModule {
	DatabaseSync: new (
		path: string,
		options?: { readOnly?: boolean },
	) => SqliteDatabase
}

function rowsOf(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return []
	return value.filter(
		(row): row is Record<string, unknown> =>
			typeof row === "object" && row !== null && !Array.isArray(row),
	)
}

function rowOf(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined
	}
	return value as Record<string, unknown>
}

export async function openReadOnly(dbPath: string): Promise<SqlDatabase> {
	const loaded = (await import("node:sqlite")) as SqliteModule
	const db = new loaded.DatabaseSync(dbPath, { readOnly: true })
	// busy_timeout is per connection. Set it before query_only.
	db.exec("PRAGMA busy_timeout = 100")
	db.exec("PRAGMA query_only = ON")
	return {
		prepare(sql: string): SqlStatement {
			const statement = db.prepare(sql)
			return {
				all: (...params) => rowsOf(statement.all(...params)),
				get: (...params) => rowOf(statement.get(...params)),
			}
		},
		exec(sql: string): void {
			db.exec(sql)
		},
		close(): void {
			db.close()
		},
	}
}

export async function withReadOnly<T>(
	dbPath: string,
	read: (db: SqlDatabase) => T,
): Promise<T> {
	const db = await openReadOnly(dbPath)
	try {
		return read(db)
	} finally {
		db.close()
	}
}
