import { ActivityUnavailableError } from "./errors.js"

/** Structural subset of node:sqlite DatabaseSync. The module is loaded dynamically. */
export type SqliteValue = string | number | bigint | Uint8Array | null

export interface SqliteRunResult {
	changes: number | bigint
	lastInsertRowid: number | bigint
}

export interface SqliteStatement {
	run(...params: SqliteValue[]): SqliteRunResult
	get(...params: SqliteValue[]): Record<string, SqliteValue> | undefined
	all(...params: SqliteValue[]): Array<Record<string, SqliteValue>>
}

export interface SqliteDatabase {
	exec(sql: string): void
	prepare(sql: string): SqliteStatement
	close(): void
}

export function cell(
	row: Record<string, SqliteValue> | undefined,
	key: string,
): SqliteValue | undefined {
	if (!row) return undefined
	return row[key]
}

export function sqlNumber(
	value: SqliteValue | undefined,
	label: string,
): number {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (
		typeof value === "bigint" &&
		value <= BigInt(Number.MAX_SAFE_INTEGER) &&
		value >= BigInt(Number.MIN_SAFE_INTEGER)
	)
		return Number(value)
	if (typeof value === "string" && /^-?\d+$/.test(value)) {
		const parsed = Number(value)
		if (Number.isSafeInteger(parsed)) return parsed
	}
	throw new ActivityUnavailableError(`Unexpected SQLite value for ${label}`)
}

/** Bind an integer without turning a safe id into a string (SQLite would store text). */
export function bindInteger(value: bigint): number | bigint {
	if (
		value > BigInt(Number.MAX_SAFE_INTEGER) ||
		value < BigInt(Number.MIN_SAFE_INTEGER)
	)
		return value
	return Number(value)
}
