/**
 * On-disk state of the aircraft-info service, one SQLite file under stateDir:
 *
 * - `lookup_cache`: answers of online sources (and "not found"), with an expiry,
 *   so a restart or an offline core keeps what it learned. Expired rows are pruned
 *   (the service does it hourly) and the table never holds more than
 *   MAX_CACHE_ROWS rows: past it the rows closest to expiry go first.
 * - `aircraft_db`: the tar1090-db aircraft table (hex, registration, type, flags,
 *   description, year, owner), refreshed from the network every few days.
 * - `meta`: refresh bookkeeping.
 *
 * Point lookups only (primary keys), cheap enough for the main thread. The database
 * import yields to the event loop between batches.
 *
 * @module src/services/aircraft-info/store
 */

import type {
	SqliteDatabase,
	SqliteStatement,
	SqliteValue,
} from "../../core/activity/storage/sqlite.js"

export type CacheKind = "airframe" | "photo" | "callsign" | "airline"

/** One row of the tar1090-db aircraft table. */
export interface LocalAircraftRow {
	registration?: string
	typeCode?: string
	description?: string
	year?: number
	owner?: string
	military: boolean
	interesting: boolean
	pia: boolean
	ladd: boolean
}

/** Cache values: `null` records a "not found" answer. */
export interface CacheHit<T> {
	value: T | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lookup_cache (
	kind TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (kind, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS aircraft_db (
	hex TEXT PRIMARY KEY,
	reg TEXT,
	type TEXT,
	flags TEXT,
	descr TEXT,
	year INTEGER,
	owner TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS aircraft_db_reg ON aircraft_db (reg);
CREATE INDEX IF NOT EXISTS lookup_cache_expires ON lookup_cache (expires_at);
`

/**
 * Most lookup_cache rows kept. A busy station sees about 1,500 different aircraft a day;
 * each has an airframe and a photo row kept up to 30 days: 1,500 x 2 x 30 = 90,000, plus
 * callsign rows (12 h) and airline prefixes (a few hundred). Rows are a few hundred bytes
 * of JSON, so 100,000 rows x ~500 B is about 50 MB on disk at most.
 */
export const MAX_CACHE_ROWS = 100_000
/**
 * Past the cap, this many extra rows go in one delete (1% of the cap), so a full cache
 * is trimmed once per thousand writes rather than on every write.
 */
export const CACHE_TRIM_SLACK = 1_000

const str = (v: SqliteValue | undefined): string | undefined =>
	typeof v === "string" && v.length > 0 ? v : undefined

export class AircraftInfoStore {
	private readonly getCache: SqliteStatement
	private readonly putCache: SqliteStatement
	private readonly getAircraft: SqliteStatement
	private readonly getMeta: SqliteStatement
	private readonly putMeta: SqliteStatement
	private readonly countAircraft: SqliteStatement
	private readonly getHexByReg: SqliteStatement
	private readonly countCache: SqliteStatement
	private readonly trimCache: SqliteStatement
	/** Rows written since the last count, added to it: an upper bound of the table size. */
	private rowsAtMost: number

	constructor(
		private readonly db: SqliteDatabase,
		private readonly now: () => number = Date.now,
		private readonly maxCacheRows: number = MAX_CACHE_ROWS,
		private readonly trimSlack: number = CACHE_TRIM_SLACK,
	) {
		db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
		db.exec(SCHEMA)
		this.getCache = db.prepare(
			"SELECT value, expires_at FROM lookup_cache WHERE kind = ? AND key = ?",
		)
		this.putCache = db.prepare(
			"INSERT OR REPLACE INTO lookup_cache (kind, key, value, expires_at) VALUES (?, ?, ?, ?)",
		)
		this.getAircraft = db.prepare(
			"SELECT reg, type, flags, descr, year, owner FROM aircraft_db WHERE hex = ?",
		)
		this.getMeta = db.prepare("SELECT value FROM meta WHERE key = ?")
		this.putMeta = db.prepare(
			"INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
		)
		this.countAircraft = db.prepare("SELECT count(*) AS n FROM aircraft_db")
		this.getHexByReg = db.prepare(
			"SELECT hex FROM aircraft_db WHERE reg = ? ORDER BY hex LIMIT 2",
		)
		this.countCache = db.prepare("SELECT count(*) AS n FROM lookup_cache")
		this.trimCache = db.prepare(
			"DELETE FROM lookup_cache WHERE (kind, key) IN (SELECT kind, key FROM lookup_cache ORDER BY expires_at LIMIT ?)",
		)
		this.rowsAtMost = this.cacheSize()
		this.enforceCap()
	}

	/** A fresh cached answer, or undefined when absent or expired. */
	cached<T>(kind: CacheKind, key: string): CacheHit<T> | undefined {
		const row = this.getCache.get(kind, key)
		if (!row) return undefined
		const expires = row["expires_at"]
		if (typeof expires !== "number" && typeof expires !== "bigint")
			return undefined
		if (Number(expires) <= this.now()) return undefined
		const raw = row["value"]
		if (raw === null) return { value: null }
		if (typeof raw !== "string") return undefined
		try {
			return { value: JSON.parse(raw) as T }
		} catch {
			return undefined
		}
	}

	remember<T>(kind: CacheKind, key: string, value: T | null, ttlMs: number) {
		this.putCache.run(
			kind,
			key,
			value === null ? null : JSON.stringify(value),
			this.now() + ttlMs,
		)
		this.rowsAtMost++
		if (this.rowsAtMost > this.maxCacheRows) this.enforceCap()
	}

	/** Drops expired cache rows, then holds the row cap. */
	prune(): void {
		this.db
			.prepare("DELETE FROM lookup_cache WHERE expires_at <= ?")
			.run(this.now())
		this.rowsAtMost = this.cacheSize()
		this.enforceCap()
	}

	/** Past the cap, deletes the rows closest to expiry down to cap minus the slack. */
	private enforceCap(): void {
		if (this.rowsAtMost <= this.maxCacheRows) return
		const rows = this.cacheSize()
		if (rows > this.maxCacheRows) {
			const target = Math.max(0, this.maxCacheRows - this.trimSlack)
			this.trimCache.run(rows - target)
			this.rowsAtMost = target
		} else this.rowsAtMost = rows
	}

	cacheSize(): number {
		return Number(this.countCache.get()?.["n"] ?? 0)
	}

	localAircraft(hex: string): LocalAircraftRow | undefined {
		const row = this.getAircraft.get(hex)
		if (!row) return undefined
		const flags = typeof row["flags"] === "string" ? row["flags"] : ""
		const out: LocalAircraftRow = {
			military: flags[0] === "1",
			interesting: flags[1] === "1",
			pia: flags[2] === "1",
			ladd: flags[3] === "1",
		}
		const reg = str(row["reg"])
		const type = str(row["type"])
		const descr = str(row["descr"])
		const owner = str(row["owner"])
		const year = row["year"]
		if (reg) out.registration = reg
		if (type) out.typeCode = type
		if (descr) out.description = descr
		if (owner) out.owner = owner
		if (typeof year === "number" && year > 1900) out.year = year
		return out
	}

	/**
	 * ICAO address of a registration (ACARS names aircraft by registration). Case and
	 * ACARS's leading dots are ignored, and a registration sent without its dash
	 * ("ZZWKD", "ZZWKE") also matches "ZZ-WKD" or "ZZ-WKE"; undefined when unknown or
	 * ambiguous.
	 */
	hexForRegistration(registration: string): string | undefined {
		const reg = registration.trim().toUpperCase().replace(/^\.+/, "")
		if (!reg) return undefined
		const candidates = [reg]
		if (!reg.includes("-"))
			for (const cut of [1, 2, 3])
				if (reg.length > cut + 1)
					candidates.push(`${reg.slice(0, cut)}-${reg.slice(cut)}`)
		for (const candidate of candidates) {
			const rows = this.getHexByReg.all(candidate)
			if (rows.length === 1) return str(rows[0]?.["hex"])
		}
		return undefined
	}

	localAircraftCount(): number {
		return Number(this.countAircraft.get()?.["n"] ?? 0)
	}

	meta(key: string): string | undefined {
		return str(this.getMeta.get(key)?.["value"])
	}

	setMeta(key: string, value: string): void {
		this.putMeta.run(key, value)
	}

	/**
	 * Replaces the aircraft table with `rows` (tar1090-db CSV lines). Rows go into a
	 * side table in batches, yielding between them, then swap in one transaction, so
	 * lookups keep answering from the old table until the new one is complete.
	 */
	async replaceAircraftDb(
		lines: AsyncIterable<string>,
		batchSize = 4000,
	): Promise<number> {
		this.db.exec(`DROP TABLE IF EXISTS aircraft_db_next;
CREATE TABLE aircraft_db_next (
	hex TEXT PRIMARY KEY, reg TEXT, type TEXT, flags TEXT, descr TEXT, year INTEGER, owner TEXT
) WITHOUT ROWID;`)
		const insert = this.db.prepare(
			"INSERT OR REPLACE INTO aircraft_db_next (hex, reg, type, flags, descr, year, owner) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		let count = 0
		let pending: SqliteValue[][] = []
		const flush = async () => {
			if (pending.length === 0) return
			this.db.exec("BEGIN")
			try {
				for (const row of pending) insert.run(...row)
				this.db.exec("COMMIT")
			} catch (err) {
				this.db.exec("ROLLBACK")
				throw err
			}
			pending = []
			await new Promise<void>(resolve => setImmediate(resolve))
		}
		try {
			for await (const line of lines) {
				const row = parseTar1090Line(line)
				if (!row) continue
				pending.push(row)
				count++
				if (pending.length >= batchSize) await flush()
			}
			await flush()
		} catch (err) {
			this.db.exec("DROP TABLE IF EXISTS aircraft_db_next")
			throw err
		}
		this.db.exec(`BEGIN;
DROP TABLE aircraft_db;
ALTER TABLE aircraft_db_next RENAME TO aircraft_db;
CREATE INDEX IF NOT EXISTS aircraft_db_reg ON aircraft_db (reg);
COMMIT;`)
		return count
	}

	close(): void {
		this.db.close()
	}
}

/**
 * tar1090-db CSV line: `hex;reg;type;flags;desc;year;owner;` where flags is a run of
 * 0/1 digits (military, interesting, PIA, LADD). Rows with no registration, type or
 * description carry nothing worth storing.
 */
export function parseTar1090Line(line: string): SqliteValue[] | null {
	const f = line.split(";")
	const hex = f[0]?.trim().toUpperCase()
	if (!hex || !/^[0-9A-F]{6}$/.test(hex)) return null
	const reg = f[1]?.trim() ?? ""
	const type = f[2]?.trim() ?? ""
	const flags = f[3]?.trim() ?? ""
	const descr = f[4]?.trim() ?? ""
	const yearText = f[5]?.trim() ?? ""
	const owner = f[6]?.trim() ?? ""
	if (!reg && !type && !descr && !/1/.test(flags)) return null
	const year = /^\d{4}$/.test(yearText) ? Number(yearText) : null
	return [
		hex,
		reg || null,
		type || null,
		/^[01]{1,8}$/.test(flags) ? flags : null,
		descr || null,
		year,
		owner || null,
	]
}
