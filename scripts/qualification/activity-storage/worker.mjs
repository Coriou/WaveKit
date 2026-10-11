// Disposable fixture primitives, not a production Activity store.
import { isMainThread, parentPort, workerData } from "node:worker_threads"
import { join } from "node:path"
import * as fs from "node:fs"
import {
	diskGuard,
	inspectArtifacts,
	LIMITS,
	supportedRuntime,
	verifyOutputDirectory,
} from "./run.mjs"
import { offers } from "./workloads.mjs"

export function writeGuard(
	{ queuedRows, queuedBytes, artifactBytes, rssBytes, free },
	reserveBytes,
) {
	for (const value of [queuedRows, queuedBytes, artifactBytes, rssBytes]) {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error("Unknown resource usage")
	}
	if (
		queuedRows > LIMITS.queueRows ||
		queuedBytes > LIMITS.queueBytes ||
		artifactBytes + 1024 * 1024 > LIMITS.artifactBytes ||
		rssBytes > LIMITS.memoryBytes
	)
		throw new Error("Resource quota exceeded")
	diskGuard(free, reserveBytes)
}

export function guardedWrite(check, write) {
	check()
	return write()
}

async function fixture(data) {
	if (
		isMainThread ||
		!parentPort ||
		!supportedRuntime(process.versions.node) ||
		!["micro", "runtime"].includes(data?.scenario) ||
		data?.limits?.queueRows !== LIMITS.queueRows
	)
		throw new Error("Worker not admitted")
	const directoryInfo = verifyOutputDirectory(data.directory, data.root)
	if (
		directoryInfo.ino !== data.identity?.inode ||
		directoryInfo.dev !== data.identity?.device
	)
		throw new Error("Worker output replaced")
	const warnings = []
	const warning = event => {
		if (warnings.length < 16) warnings.push(String(event).slice(0, 512))
	}
	process.on("warning", warning)
	// The only SQLite import in the harness, after runtime/worker admission.
	let DatabaseSync
	try {
		;({ DatabaseSync } = await import("node:sqlite"))
	} catch (error) {
		process.removeListener("warning", warning)
		throw error
	}
	const databasePath =
		data.scenario === "runtime"
			? ":memory:"
			: join(data.directory, "fixture.db")
	let db
	const counts = { offered: 0, admitted: 0, rejected: 0, committed: 0 }
	const check = (rows = 0, bytes = 0) => {
		const info = verifyOutputDirectory(data.directory, data.root)
		if (info.ino !== directoryInfo.ino || info.dev !== directoryInfo.dev)
			throw new Error("Worker output replaced")
		writeGuard(
			{
				queuedRows: rows,
				queuedBytes: bytes,
				artifactBytes: inspectArtifacts(data.directory).bytes,
				rssBytes: process.memoryUsage().rss,
				free: fs.statfsSync(data.directory, { bigint: true }),
			},
			data.reserveBytes,
		)
		// This micro fixture has at most ten ~2.5KiB rows. Reserve 1MiB BEFORE each
		// transaction, rather than trusting a post-commit WAL size measurement.
		for (const [suffix, cap] of [
			["", LIMITS.dbBytes],
			["-wal", LIMITS.walBytes],
		]) {
			const path = join(data.directory, `fixture.db${suffix}`)
			try {
				if (fs.lstatSync(path).size + 1024 * 1024 > cap)
					throw new Error("Transaction growth allowance exceeded")
			} catch (error) {
				if (error.code !== "ENOENT") throw error
			}
		}
	}
	try {
		check()
		db = new DatabaseSync(databasePath)
		db.exec(
			"PRAGMA page_size=4096; PRAGMA max_page_count=4096; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=32; PRAGMA busy_timeout=50;",
		)
		const sqlite = db
			.prepare("SELECT sqlite_version() AS version")
			.get().version
		const compileOptions = db.prepare("PRAGMA compile_options").all()
		db.exec(`CREATE TABLE activity(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
			CREATE VIRTUAL TABLE search USING fts5(payload, content='activity', content_rowid='id');
			CREATE TRIGGER activity_insert AFTER INSERT ON activity BEGIN INSERT INTO search(rowid,payload) VALUES(new.id,new.payload); END;
			CREATE TRIGGER activity_delete AFTER DELETE ON activity BEGIN INSERT INTO search(search,rowid,payload) VALUES('delete',old.id,old.payload); END;
			CREATE TABLE receipts(id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL);
			CREATE TABLE epochs(id INTEGER PRIMARY KEY, closed INTEGER NOT NULL);
			INSERT INTO epochs VALUES(1,0);`)
		const ftsAvailable = true // CREATE above fails explicitly if FTS5 is unavailable.
		const primitives = { ftsAvailable }
		if (data.scenario === "micro") {
			const batch = [...offers("micro", 1)]
			counts.offered = batch.length
			const bytes = batch.reduce(
				(total, row) => total + Buffer.byteLength(row.payload),
				0,
			)
			guardedWrite(
				() => check(batch.length, bytes),
				() => {
					counts.admitted = batch.length
					db.exec("BEGIN IMMEDIATE")
					try {
						const insert = db.prepare("INSERT INTO activity VALUES(?,?)")
						const receipt = db.prepare("INSERT INTO receipts VALUES(?,1)")
						for (const row of batch) {
							insert.run(row.id, row.payload)
							receipt.run(row.id)
						}
						// Synthetic I/O failure, never fill the host disk.
						if (data.fault === "enospc")
							throw Object.assign(new Error("Injected ENOSPC"), {
								code: "ENOSPC",
							})
						db.exec("COMMIT")
						counts.committed = batch.length
					} catch (error) {
						db.exec("ROLLBACK")
						if (
							Number(
								db.prepare("SELECT count(*) AS n FROM activity").get().n,
							) !== 0 ||
							Number(
								db.prepare("SELECT count(*) AS n FROM receipts").get().n,
							) !== 0
						)
							throw new Error("Fault rollback mismatch")
						throw error
					}
				},
			)
			const scalar = sql => Number(Object.values(db.prepare(sql).get())[0])
			if (
				scalar("SELECT count(*) FROM search WHERE search MATCH 'synthetic'") !==
				batch.length
			)
				throw new Error("FTS mismatch")
			check()
			db.exec(
				"BEGIN; INSERT INTO activity VALUES(99,'rollback'); INSERT INTO receipts VALUES(99,1); ROLLBACK;",
			)
			if (
				scalar("SELECT count(*) FROM activity WHERE id=99") ||
				scalar("SELECT count(*) FROM receipts WHERE id=99") ||
				scalar("SELECT count(*) FROM search WHERE search MATCH 'rollback'")
			)
				throw new Error("Rollback mismatch")
			primitives.rollback = true
			check()
			db.exec("BEGIN; DELETE FROM activity WHERE id<=5; COMMIT;")
			if (
				scalar("SELECT count(*) FROM search WHERE search MATCH 'synthetic'") !==
					5 ||
				scalar("SELECT count(*) FROM receipts") !== 10
			)
				throw new Error("Retention receipt mismatch")
			primitives.retentionBeforeRetry = true
			primitives.originalReceiptAfterPrune =
				scalar("SELECT count(*) FROM receipts WHERE id=1") === 1
			check()
			db.exec(
				"BEGIN; UPDATE epochs SET closed=1 WHERE id=1; DELETE FROM receipts WHERE epoch IN (SELECT id FROM epochs WHERE closed=1); COMMIT;",
			)
			primitives.explicitExpiry =
				scalar("SELECT count(*) FROM receipts WHERE id=1") === 0 &&
				scalar("SELECT closed FROM epochs WHERE id=1") === 1
			primitives.queryPlan = db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT * FROM activity WHERE id>5 ORDER BY id LIMIT 4",
				)
				.all()
			db.exec(
				"INSERT INTO search(search,rank) VALUES('integrity-check',1); PRAGMA wal_checkpoint(TRUNCATE);",
			)
			db.close()
			db = new DatabaseSync(databasePath)
			if (
				db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
				scalar("SELECT count(*) FROM activity") !== 5 ||
				scalar("SELECT closed FROM epochs WHERE id=1") !== 1
			)
				throw new Error("Restart integrity mismatch")
			primitives.cleanRestart = true
		}
		check()
		await new Promise(resolve => setImmediate(resolve)) // Collect deferred native-module warnings, no polling.
		return {
			status: "ok",
			warnings,
			sqlite,
			compileOptions,
			syncMode: "FULL",
			pageSize: 4096,
			primitives,
			counts,
			processRssBytes: process.memoryUsage().rss,
			memoryMetric: "RSS of shared process, not isolated worker RSS",
			queueMaxRows: data.scenario === "micro" ? 10 : 0,
			unverified: [
				"production receipts/retention",
				"crash recovery",
				"latency distributions",
				"row overhead/horizon",
				"mount/fsync semantics",
			],
		}
	} catch (error) {
		throw Object.assign(error, { counts, warnings })
	} finally {
		process.removeListener("warning", warning)
		db?.close()
	}
}

if (!isMainThread && parentPort) {
	try {
		parentPort.postMessage(await fixture(workerData))
	} catch (error) {
		parentPort.postMessage({
			status: "failed",
			error: String(error),
			counts: error.counts,
			warnings: error.warnings,
		})
	} finally {
		parentPort.close()
	}
}
