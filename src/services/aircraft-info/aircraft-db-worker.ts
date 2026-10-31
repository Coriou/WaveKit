/**
 * worker_threads entry (built to dist/aircraft-db-worker.js): builds a fresh tar1090-db
 * aircraft file off the main thread. It reads the downloaded `.csv.gz`, writes every
 * row into a new SQLite file of its own (no other connection touches it), builds the
 * registration index once at the end, syncs the file to disk and reports the row count.
 * The main thread then swaps the file in (AircraftInfoStore.importAircraftDbFile).
 * Terminating the worker abandons the file; the main thread deletes it.
 *
 * @module src/services/aircraft-info/aircraft-db-worker
 */

import { open, rm } from "node:fs/promises"
import { parentPort, workerData } from "node:worker_threads"
import { openSqliteFile } from "../../core/activity/storage/probe.js"
import type { SqliteValue } from "../../core/activity/storage/sqlite.js"
import { WaveKitError } from "../../utils/errors.js"
import {
	AIRCRAFT_DB_TABLE,
	REG_INDEXES,
	gzipLines,
	isAircraftDbJob,
	parseTar1090Line,
	type AircraftDbWorkerReply,
} from "./store.js"

/**
 * Rows per transaction. Nothing waits on this thread, so batches only need to be big
 * enough that commits are rare: 20,000 rows of ~100 B is about 2 MB of pages, so a 500k
 * row database is 25 commits, none of them synced (synchronous OFF; one sync at the end).
 */
const WORKER_BATCH_ROWS = 20_000

async function build(gzFile: string, outFile: string): Promise<number> {
	await rm(outFile, { force: true })
	const db = await openSqliteFile(outFile)
	let count = 0
	try {
		// A throwaway file until the main thread renames it: no journal, one sync at the end.
		db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;")
		db.exec(AIRCRAFT_DB_TABLE("main"))
		const insert = db.prepare(
			"INSERT OR REPLACE INTO aircraft_db (hex, reg, type, flags, descr, year, owner) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		let pending: SqliteValue[][] = []
		const flush = () => {
			if (pending.length === 0) return
			db.exec("BEGIN")
			for (const row of pending) insert.run(...row)
			db.exec("COMMIT")
			pending = []
		}
		for await (const line of gzipLines(gzFile)) {
			const row = parseTar1090Line(line)
			if (!row) continue
			pending.push(row)
			count++
			if (pending.length >= WORKER_BATCH_ROWS) flush()
		}
		flush()
		// One bulk index build over sorted keys is the cheapest way to index 500k rows.
		db.exec(`CREATE INDEX ${REG_INDEXES[0]} ON aircraft_db (reg)`)
	} finally {
		db.close()
	}
	const handle = await open(outFile, "r+")
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
	return count
}

const port = parentPort
if (!port)
	throw new WaveKitError(
		"aircraft-db-worker must run inside a worker thread",
		"AIRCRAFT_DB_WORKER",
	)
const job: unknown = workerData
const reply = (message: AircraftDbWorkerReply) => port.postMessage(message)
if (!isAircraftDbJob(job))
	reply({ kind: "error", message: "Invalid aircraft database job" })
else
	build(job.gzFile, job.outFile).then(
		rows => reply({ kind: "done", rows }),
		(err: unknown) => {
			reply({
				kind: "error",
				message: err instanceof Error ? err.message : String(err),
			})
		},
	)
