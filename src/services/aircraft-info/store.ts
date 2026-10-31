/**
 * On-disk state of the aircraft-info service, under stateDir:
 *
 * - `lookup_cache` (aircraft-info.sqlite): answers of online sources (and "not
 *   found"), with an expiry, so a restart or an offline core keeps what it learned.
 *   Expired rows are pruned (the service does it hourly) and the table never holds
 *   more than MAX_CACHE_ROWS rows: past it the rows closest to expiry go first.
 * - `aircraft_db` (aircraft-db.sqlite, attached as `adb`): the tar1090-db aircraft
 *   table (hex, registration, type, flags, description, year, owner), refreshed from
 *   the network every few days. Without a file (tests, no stateDir) it is a table of
 *   the main database.
 * - `meta`: refresh bookkeeping.
 *
 * Point lookups only (primary keys), cheap enough for the main thread. The database
 * import never holds the event loop for long: see importAircraftDbFile.
 *
 * @module src/services/aircraft-info/store
 */

import { createReadStream, existsSync, renameSync, rmSync } from "node:fs"
import { open, rm } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { createGunzip } from "node:zlib"
import type {
	SqliteDatabase,
	SqliteStatement,
	SqliteValue,
} from "../../core/activity/storage/sqlite.js"
import { WaveKitError } from "../../utils/errors.js"

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
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS lookup_cache_expires ON lookup_cache (expires_at);
`

/** The tar1090-db table in `schema`, under `name` (aircraft_db or a side table). */
export const AIRCRAFT_DB_TABLE = (
	schema: string,
	name = "aircraft_db",
): string => `CREATE TABLE IF NOT EXISTS ${schema}.${name} (
	hex TEXT PRIMARY KEY,
	reg TEXT,
	type TEXT,
	flags TEXT,
	descr TEXT,
	year INTEGER,
	owner TEXT
) WITHOUT ROWID;`

/**
 * Names of the registration index of aircraft_db. A file built by an import always
 * uses the first. The in-database swap (no file) builds the index on the side table
 * before the rows go in, and SQLite cannot rename an index, so there the name
 * alternates between imports: the side table takes the one the live table is not using.
 */
export const REG_INDEXES = ["aircraft_db_reg", "aircraft_db_reg_b"] as const

/**
 * Main-thread import pacing (no worker). Rows are read ahead into a buffer, then one
 * slice inserts them until IMPORT_SLICE_MS have passed or IMPORT_SLICE_ROWS rows went
 * in, commits and yields to the event loop; no transaction stays open across a yield.
 * The clock is read every IMPORT_CLOCK_EVERY rows: at the measured worst of ~0.4 ms a
 * row (indexed insert, loaded host), 32 rows overshoot the budget by about 13 ms, so a
 * slice's inserts hold the loop for about 8 + 13 = 21 ms at worst. The commit is not
 * bounded by this: on a busy disk a WAL checkpoint can take far longer, which is why the
 * service imports in a worker.
 */
export const IMPORT_SLICE_MS = 8
export const IMPORT_SLICE_ROWS = 500
const IMPORT_CLOCK_EVERY = 32
/**
 * Rows deleted per slice when emptying a replaced side table before dropping it:
 * dropping 500k rows at once held the loop for over 100 ms. 2,000 rows of ~100 B is
 * about 50 pages of 4 KiB, a few milliseconds.
 */
export const DROP_SLICE_ROWS = 2_000

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

/** Where aircraft_db lives on disk, and the worker that rebuilds it. */
export interface AircraftDbFile {
	/** SQLite file holding aircraft_db, attached to the main connection as `adb` */
	path: string
	/** Worker entry (dist/aircraft-db-worker.js); missing on disk: import on the main thread in slices */
	workerUrl?: URL
}

/** Worker entry after esbuild flattens this module into dist/index.js. */
export function defaultAircraftDbWorkerUrl(): URL {
	return new URL("./aircraft-db-worker.js", import.meta.url)
}

/** workerData of aircraft-db-worker. */
export interface AircraftDbJob {
	gzFile: string
	outFile: string
}

export type AircraftDbWorkerReply =
	| { kind: "done"; rows: number }
	| { kind: "error"; message: string }

export function isAircraftDbJob(v: unknown): v is AircraftDbJob {
	if (typeof v !== "object" || v === null) return false
	const job = v as Record<string, unknown>
	return typeof job["gzFile"] === "string" && typeof job["outFile"] === "string"
}

function isWorkerReply(v: unknown): v is AircraftDbWorkerReply {
	if (typeof v !== "object" || v === null) return false
	const r = v as Record<string, unknown>
	return (
		(r["kind"] === "done" &&
			typeof r["rows"] === "number" &&
			Number.isSafeInteger(r["rows"])) ||
		(r["kind"] === "error" && typeof r["message"] === "string")
	)
}

/** How an import ran: in a worker thread, or on the main thread in yielding slices. */
export interface AircraftDbImport {
	rows: number
	offThread: boolean
}

interface ImportOptions {
	signal?: AbortSignal
	sliceMs?: number
	sliceRows?: number
}

const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve))

const str = (v: SqliteValue | undefined): string | undefined =>
	typeof v === "string" && v.length > 0 ? v : undefined

const sqlString = (v: string) => `'${v.replace(/'/g, "''")}'`

export class AircraftInfoStore {
	private readonly getCache: SqliteStatement
	private readonly putCache: SqliteStatement
	private getAircraft!: SqliteStatement
	private readonly getMeta: SqliteStatement
	private readonly putMeta: SqliteStatement
	private countAircraft!: SqliteStatement
	private getHexByReg!: SqliteStatement
	private readonly countCache: SqliteStatement
	private readonly trimCache: SqliteStatement
	/** Rows written since the last count, added to it: an upper bound of the table size. */
	private rowsAtMost: number
	/** aircraft_db row count, counted once (a full scan) then kept by imports. */
	private aircraftRows: number | undefined
	/** Schema holding aircraft_db: `adb` (its own file) or `main`. */
	private readonly adb: "adb" | "main"
	/** Main-thread import slices committed so far: each one ends with a yield. */
	slices = 0

	constructor(
		private readonly db: SqliteDatabase,
		private readonly now: () => number = Date.now,
		private readonly maxCacheRows: number = MAX_CACHE_ROWS,
		private readonly trimSlack: number = CACHE_TRIM_SLACK,
		private readonly aircraftFile?: AircraftDbFile,
	) {
		db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
		db.exec(SCHEMA)
		this.adb = aircraftFile ? "adb" : "main"
		if (aircraftFile) this.attachAircraftDb()
		else {
			db.exec(AIRCRAFT_DB_TABLE("main"))
			// A fresh database: the empty table gets its index now, which costs nothing.
			if (this.regIndexOf("aircraft_db") === undefined)
				db.exec(`CREATE INDEX ${REG_INDEXES[0]} ON aircraft_db (reg)`)
			this.prepareAircraft()
		}
		this.getCache = db.prepare(
			"SELECT value, expires_at FROM lookup_cache WHERE kind = ? AND key = ?",
		)
		this.putCache = db.prepare(
			"INSERT OR REPLACE INTO lookup_cache (kind, key, value, expires_at) VALUES (?, ?, ?, ?)",
		)
		this.getMeta = db.prepare("SELECT value FROM meta WHERE key = ?")
		this.putMeta = db.prepare(
			"INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
		)
		this.countCache = db.prepare("SELECT count(*) AS n FROM lookup_cache")
		this.trimCache = db.prepare(
			"DELETE FROM lookup_cache WHERE (kind, key) IN (SELECT kind, key FROM lookup_cache ORDER BY expires_at LIMIT ?)",
		)
		this.rowsAtMost = this.cacheSize()
		this.enforceCap()
	}

	/** Attaches the aircraft file (an empty table and index on first use), then prepares. */
	private attachAircraftDb(): void {
		if (!this.aircraftFile) return
		this.db.exec(
			`ATTACH DATABASE ${sqlString(this.aircraftFile.path)} AS adb;
${AIRCRAFT_DB_TABLE("adb")}
CREATE INDEX IF NOT EXISTS adb.${REG_INDEXES[0]} ON aircraft_db (reg);`,
		)
		this.prepareAircraft()
	}

	/** Statements on aircraft_db; again after a swap, which replaces the table. */
	private prepareAircraft(): void {
		const table = `${this.adb}.aircraft_db`
		this.getAircraft = this.db.prepare(
			`SELECT reg, type, flags, descr, year, owner FROM ${table} WHERE hex = ?`,
		)
		this.countAircraft = this.db.prepare(`SELECT count(*) AS n FROM ${table}`)
		this.getHexByReg = this.db.prepare(
			`SELECT hex FROM ${table} WHERE reg = ? ORDER BY hex LIMIT 2`,
		)
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
		this.aircraftRows ??= Number(this.countAircraft.get()?.["n"] ?? 0)
		return this.aircraftRows
	}

	meta(key: string): string | undefined {
		return str(this.getMeta.get(key)?.["value"])
	}

	setMeta(key: string, value: string): void {
		this.putMeta.run(key, value)
	}

	// ---- import --------------------------------------------------------------

	/**
	 * Replaces aircraft_db with the rows of a downloaded tar1090-db `.csv.gz`. Lookups
	 * keep answering from the current table until the new one is complete.
	 *
	 * With a file and its worker entry on disk, a worker thread builds a new file next to
	 * it (`<path>.next`, its own connection: nothing on this thread reads, inserts, indexes
	 * or syncs it), then this thread detaches the old file, renames the new one over it
	 * and attaches it again: a few milliseconds. Without the worker entry (a source
	 * checkout without `pnpm run build`) the same file is built here in yielding slices.
	 * Without a file the rows go into a side table of the main database (replaceAircraftDb).
	 *
	 * `signal` (online lookups turned off, or the service stopping) terminates the worker
	 * or stops between slices, deletes the unfinished file and keeps the current table.
	 */
	async importAircraftDbFile(
		gzFile: string,
		options: ImportOptions = {},
	): Promise<AircraftDbImport> {
		const lines = () => gzipLines(gzFile)
		const file = this.aircraftFile
		if (!file)
			return {
				rows: await this.replaceAircraftDb(lines(), options),
				offThread: false,
			}
		const next = `${file.path}.next`
		const workerUrl = file.workerUrl
		const offThread =
			workerUrl !== undefined && existsSync(fileURLToPath(workerUrl))
		let rows: number
		try {
			options.signal?.throwIfAborted()
			rows = offThread
				? await this.buildInWorker(workerUrl, gzFile, next, options.signal)
				: await this.buildInSlices(lines(), next, options)
			options.signal?.throwIfAborted()
		} catch (err) {
			await rm(next, { force: true })
			throw err
		}
		this.swapAircraftFile(next, rows)
		return { rows, offThread }
	}

	private buildInWorker(
		workerUrl: URL,
		gzFile: string,
		outFile: string,
		signal: AbortSignal | undefined,
	): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const job: AircraftDbJob = { gzFile, outFile }
			const worker = new Worker(workerUrl, {
				name: "aircraft-db-import",
				workerData: job,
			})
			let settled = false
			// The worker is stopped before the promise settles, so a caller that retries at once
			// never finds the previous job still writing `<path>.next`.
			const settle = (fn: () => void) => {
				if (settled) return
				settled = true
				signal?.removeEventListener("abort", onAbort)
				void worker
					.terminate()
					.catch(() => undefined)
					.then(fn)
			}
			const onAbort = () => {
				settle(() => {
					reject(signal?.reason ?? new Error("aborted"))
				})
			}
			signal?.addEventListener("abort", onAbort, { once: true })
			worker.on("message", (msg: unknown) => {
				if (!isWorkerReply(msg))
					settle(() => {
						reject(
							new WaveKitError(
								"Aircraft database worker sent an unexpected message",
								"AIRCRAFT_DB_WORKER",
							),
						)
					})
				else if (msg.kind === "done") settle(() => resolve(msg.rows))
				else
					settle(() => {
						reject(new WaveKitError(msg.message, "AIRCRAFT_DB_WORKER"))
					})
			})
			worker.on("error", err => {
				settle(() => {
					reject(err)
				})
			})
			worker.on("exit", code => {
				settle(() => {
					reject(
						new WaveKitError(
							`Aircraft database worker exited (${code})`,
							"AIRCRAFT_DB_WORKER",
						),
					)
				})
			})
		})
	}

	/** Builds `outFile` on this thread: attached as adb_next, filled in slices, synced. */
	private async buildInSlices(
		lines: AsyncIterable<string>,
		outFile: string,
		options: ImportOptions,
	): Promise<number> {
		await rm(outFile, { force: true })
		this.db.exec(`ATTACH DATABASE ${sqlString(outFile)} AS adb_next;
PRAGMA adb_next.journal_mode = OFF;
PRAGMA adb_next.synchronous = OFF;
${AIRCRAFT_DB_TABLE("adb_next")}
CREATE INDEX adb_next.${REG_INDEXES[0]} ON aircraft_db (reg);`)
		let rows: number
		try {
			rows = await this.insertInSlices(lines, "adb_next.aircraft_db", options)
		} finally {
			this.db.exec("DETACH DATABASE adb_next")
		}
		// synced off the event loop (libuv thread pool) before the rename makes it live
		const handle = await open(outFile, "r+")
		try {
			await handle.sync()
		} finally {
			await handle.close()
		}
		return rows
	}

	/** Detaches the current file, renames `next` over it and attaches it. */
	private swapAircraftFile(next: string, rows: number): void {
		const file = this.aircraftFile
		if (!file) return
		this.db.exec("DETACH DATABASE adb")
		try {
			renameSync(next, file.path)
		} catch (err) {
			rmSync(next, { force: true })
			this.attachAircraftDb()
			throw err
		}
		this.attachAircraftDb()
		this.aircraftRows = rows
	}

	/**
	 * Inserts parsed `lines` into `table` in time-boxed slices (IMPORT_SLICE_MS or
	 * IMPORT_SLICE_ROWS), each its own transaction, yielding between them. Rows are read
	 * ahead into a buffer first, so no transaction is open while waiting on the input.
	 */
	private async insertInSlices(
		lines: AsyncIterable<string>,
		table: string,
		options: ImportOptions,
	): Promise<number> {
		const signal = options.signal
		const sliceMs = options.sliceMs ?? IMPORT_SLICE_MS
		const sliceRows = options.sliceRows ?? IMPORT_SLICE_ROWS
		const insert = this.db.prepare(
			`INSERT OR REPLACE INTO ${table} (hex, reg, type, flags, descr, year, owner) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		let count = 0
		let pending: SqliteValue[][] = []
		const drain = async (all: boolean) => {
			while (pending.length >= sliceRows || (all && pending.length > 0)) {
				const start = performance.now()
				let done = 0
				this.db.exec("BEGIN")
				try {
					while (done < pending.length && done < sliceRows) {
						const row = pending[done]
						if (row) insert.run(...row)
						done++
						if (
							done % IMPORT_CLOCK_EVERY === 0 &&
							performance.now() - start >= sliceMs
						)
							break
					}
					this.db.exec("COMMIT")
				} catch (err) {
					this.db.exec("ROLLBACK")
					throw err
				}
				pending = pending.slice(done)
				count += done
				this.slices++
				await yieldLoop()
				signal?.throwIfAborted()
			}
		}
		for await (const line of lines) {
			const row = parseTar1090Line(line)
			if (!row) continue
			pending.push(row)
			if (pending.length >= sliceRows) await drain(false)
		}
		await drain(true)
		return count
	}

	/** Name of the registration index of a main-schema `table`, if it has one. */
	private regIndexOf(table: string): string | undefined {
		const rows = this.db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
			)
			.all(table)
		for (const row of rows) {
			const name = str(row["name"])
			if (name && (REG_INDEXES as readonly string[]).includes(name)) return name
		}
		return undefined
	}

	private tableExists(table: string): boolean {
		return (
			this.db
				.prepare(
					"SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?",
				)
				.get(table) !== undefined
		)
	}

	/** Empties a main-schema `table` DROP_SLICE_ROWS rows at a time, yielding between, then drops it. */
	private async dropInSlices(table: string): Promise<void> {
		if (!this.tableExists(table)) return
		const del = this.db.prepare(
			`DELETE FROM ${table} WHERE hex IN (SELECT hex FROM ${table} LIMIT ?)`,
		)
		while (Number(del.run(DROP_SLICE_ROWS).changes) > 0) await yieldLoop()
		this.db.exec(`DROP TABLE IF EXISTS ${table}`)
	}

	/**
	 * Replaces aircraft_db with `lines` (tar1090-db CSV lines) when it is a table of the
	 * main database (no file): the side table and its registration index are created
	 * empty, so each insert maintains the index as it goes (no index build over 500k rows
	 * in one statement); rows go in yielding slices (insertInSlices); the swap is two
	 * renames in one transaction; the replaced table is then emptied in slices before it
	 * is dropped. With a file, use importAircraftDbFile.
	 */
	async replaceAircraftDb(
		lines: AsyncIterable<string>,
		options: ImportOptions = {},
	): Promise<number> {
		if (this.adb !== "main")
			throw new WaveKitError(
				"replaceAircraftDb needs the in-database table; use importAircraftDbFile",
				"AIRCRAFT_DB_IMPORT",
			)
		// leftovers of an import or cleanup cut short by a restart
		await this.dropInSlices("aircraft_db_next")
		await this.dropInSlices("aircraft_db_old")
		options.signal?.throwIfAborted()
		const live = this.regIndexOf("aircraft_db")
		const index = live === REG_INDEXES[0] ? REG_INDEXES[1] : REG_INDEXES[0]
		this.db.exec(`${AIRCRAFT_DB_TABLE("main", "aircraft_db_next")}
CREATE INDEX ${index} ON aircraft_db_next (reg);`)
		let count: number
		try {
			count = await this.insertInSlices(lines, "aircraft_db_next", options)
			options.signal?.throwIfAborted()
		} catch (err) {
			await this.dropInSlices("aircraft_db_next")
			throw err
		}
		this.db.exec(`BEGIN;
ALTER TABLE aircraft_db RENAME TO aircraft_db_old;
ALTER TABLE aircraft_db_next RENAME TO aircraft_db;
COMMIT;`)
		this.prepareAircraft()
		this.aircraftRows = count
		await this.dropInSlices("aircraft_db_old")
		return count
	}

	close(): void {
		this.db.close()
	}
}

/**
 * Lines of a gzipped text file. Nothing is opened until the first line is asked for, so
 * a caller can await its own setup between creating the iterable and reading it; read
 * and gunzip errors (a missing file, a corrupt archive) reject the iteration as a
 * WaveKitError; both streams are destroyed when the iteration ends, fails or is
 * abandoned (an aborted import).
 */
export async function* gzipLines(gzFile: string): AsyncGenerator<string> {
	const source = createReadStream(gzFile)
	const gunzip = createGunzip()
	source.on("error", err => gunzip.destroy(err))
	source.pipe(gunzip)
	const decoder = new StringDecoder("utf8")
	let rest = ""
	try {
		for await (const chunk of gunzip as AsyncIterable<Buffer>) {
			const parts = (rest + decoder.write(chunk)).split("\n")
			rest = parts.pop() ?? ""
			for (const line of parts)
				yield line.endsWith("\r") ? line.slice(0, -1) : line
		}
		rest += decoder.end()
		if (rest) yield rest.endsWith("\r") ? rest.slice(0, -1) : rest
	} catch (err) {
		throw new WaveKitError(
			"Aircraft database download could not be read",
			"AIRCRAFT_DB_IMPORT",
			err instanceof Error ? err : undefined,
		)
	} finally {
		source.destroy()
		gunzip.destroy()
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
