// Disposable fixture primitives, not a production Activity store.
import { isMainThread, parentPort, workerData } from "node:worker_threads"
import { join } from "node:path"
import * as fs from "node:fs"
import {
	diskGuard,
	inventoryArtifacts,
	LIMITS,
	supportedRuntime,
	validateBatchEnvelope,
	batchAcknowledgement,
	verifyOutputDirectory,
} from "./run.mjs"
import { offers, tinyRows, tinyQuery } from "./workloads.mjs"

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
		artifactBytes + TINY_GROWTH.totalBytes > LIMITS.artifactBytes ||
		rssBytes > LIMITS.memoryBytes
	)
		throw new Error("Resource quota exceeded")
	diskGuard(free, reserveBytes)
}

export function guardedWrite(check, write) {
	check()
	return write()
}

// Exact-source fixture proof only; this does not qualify the long 64MiB WAL gate.
// SQLite 3.50.4 pager.c: pagerWalFrames consumes a unique sorted dirty-page list;
// cache_spill=OFF prevents intermediate WAL writes. max_page_count bounds that
// list by 128 pages. wal.c adds 32-byte header, 24 bytes/frame and FULL-sync
// repetitions through one sector boundary. sqlite3SectorSize clamps at 65536.
// No ATTACH, VACUUM, backup, explicit cache flush, custom VFS or user SQL here.
// https://github.com/sqlite/sqlite/blob/version-3.50.4/src/pager.c
// https://github.com/sqlite/sqlite/blob/version-3.50.4/src/wal.c
// https://www.sqlite.org/pragma.html#pragma_cache_spill
export const TINY_GROWTH = Object.freeze({
	pageSize: 4096,
	pages: 128,
	dbBytes: 128 * 4096,
	walBytes: 32 + 128 * (4096 + 24) + 65536 + (4096 + 24),
	// Initial WAL-mode header transition may use a one-page rollback journal.
	// SHM remains one 32KiB region: the 4MiB micro WAL cap is <4096 frames.
	totalBytes:
		128 * 4096 + 32 + 128 * 4120 + 65536 + 4120 + 65536 + 4104 + 32768,
	proof: "exact-source no-spill tiny fixture; unsupported for long storage",
})
const PROVEN_SOURCE =
	"2025-07-30 19:33:53 4d8adfb30e03f9cf27f800a2c1ba3c48fb4ca1b08b0f5ed59a4d5ecbf45e20a3"
export function tinyGrowthSupported(node, sourceId) {
	return node === "25.2.1" && sourceId === PROVEN_SOURCE
}
function assertTinyPragmas(p, memory = false) {
	if (
		p.pageSize !== 4096 ||
		p.maxPageCount !== 128 ||
		p.cacheSpill !== 0 ||
		p.synchronous !== 2 ||
		p.journalMode !== (memory ? "memory" : "wal")
	)
		throw new Error("Unsupported actual SQLite growth settings")
}

// Reopen can recover/checkpoint before connection-local page caps are restored.
// Validate the existing physical page domain BEFORE opening SQLite. This is a
// bounded header scan of an already joined fixture, not live content hashing.
function verifyTinyReopen(directory) {
	for (const file of inventoryArtifacts(directory).files) {
		if (!["fixture.db", "fixture.db-wal"].includes(file.name)) continue
		if (file.name === "fixture.db" && file.bytes > TINY_GROWTH.dbBytes)
			throw new Error("Unsupported pre-open database page domain")
		if (!file.bytes) continue
		const fd = fs.openSync(
			join(directory, file.name),
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
		)
		try {
			const info = fs.fstatSync(fd)
			if (
				info.ino !== file.inode ||
				info.dev !== file.device ||
				info.size !== file.bytes
			)
				throw new Error("Reopen artifact changed")
			const header = Buffer.alloc(32)
			if (fs.readSync(fd, header, 0, 32, 0) !== 32)
				throw new Error("Unsupported truncated fixture header")
			if (file.name === "fixture.db") {
				if (
					header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
					header.readUInt16BE(16) !== 4096 ||
					header.readUInt32BE(28) > 128
				)
					throw new Error("Unsupported pre-open database header")
			} else {
				if (header.readUInt32BE(8) !== 4096)
					throw new Error("Unsupported pre-open WAL page size")
				// Partial final frames are allowed after termination; SQLite ignores
				// them. Every complete frame, committed or not, stays in our domain.
				for (let offset = 32; offset + 4120 <= file.bytes; offset += 4120) {
					if (
						fs.readSync(fd, header, 0, 8, offset) !== 8 ||
						header.readUInt32BE(0) > 128 ||
						header.readUInt32BE(4) > 128
					)
						throw new Error("Unsupported pre-open WAL page domain")
				}
			}
		} finally {
			fs.closeSync(fd)
		}
	}
}

const TINY_SCHEMA = `
CREATE TABLE activity(sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 64),
 eventId TEXT UNIQUE NOT NULL CHECK(length(eventId)=36), producer INTEGER NOT NULL CHECK(producer BETWEEN 0 AND 9),
 ingressUs INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('message','call')),
 frequency INTEGER NOT NULL, text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=256),
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=2560));
CREATE INDEX activity_kind ON activity(kind,sequence);
CREATE INDEX activity_producer ON activity(producer,sequence);
CREATE INDEX activity_frequency ON activity(frequency,sequence);
CREATE VIRTUAL TABLE search USING fts5(text, content='activity', content_rowid='sequence');
CREATE TRIGGER activity_insert AFTER INSERT ON activity BEGIN INSERT INTO search(rowid,text) VALUES(new.sequence,new.text); END;
CREATE TRIGGER activity_delete AFTER DELETE ON activity BEGIN INSERT INTO search(search,rowid,text) VALUES('delete',old.sequence,old.text); END;
CREATE TABLE epochs(id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 20), expires INTEGER NOT NULL, closed INTEGER NOT NULL CHECK(closed IN (0,1)));
CREATE TABLE receipts(eventId TEXT PRIMARY KEY, epoch INTEGER NOT NULL, sequence INTEGER UNIQUE NOT NULL,
 producer INTEGER NOT NULL, revision INTEGER NOT NULL, canonical TEXT NOT NULL CHECK(length(canonical)<=256),
 UNIQUE(producer,revision));
CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, lowerBarrier INTEGER NOT NULL, high INTEGER NOT NULL);
INSERT INTO state VALUES(1,1,0,0);`
function actualPragmas(db) {
	return Object.fromEntries(
		[
			["journalMode", "journal_mode"],
			["synchronous", "synchronous"],
			["pageSize", "page_size"],
			["maxPageCount", "max_page_count"],
			["cacheSpill", "cache_spill"],
			["busyTimeout", "busy_timeout"],
			["walAutocheckpoint", "wal_autocheckpoint"],
			["pageCount", "page_count"],
			["queryOnly", "query_only"],
		].map(([name, pragma]) => [
			name,
			Object.values(db.prepare(`PRAGMA ${pragma}`).get())[0],
		]),
	)
}
async function tinyFixture(data, DatabaseSync, check, provenance) {
	if (
		![
			"seed",
			"append",
			"prune",
			"restore",
			"receipts",
			"recover",
			"query",
		].includes(data.action) ||
		!["writer", "reader"].includes(data.role) ||
		(data.role === "reader") !== (data.action === "query") ||
		(data.fault !== undefined &&
			![
				"before-begin",
				"insert",
				"after-commit",
				"enospc",
				"receipt-cleanup",
				"reopen",
			].includes(data.fault))
	)
		throw new Error("Tiny role/action not admitted")
	const path = join(data.directory, "fixture.db")
	const fresh = ["seed", "receipts"].includes(data.action)
	if (fresh === fs.existsSync(path))
		throw new Error("Tiny file lifecycle mismatch")
	if (data.action === "seed") {
		validateBatchEnvelope(data.batch)
		if (JSON.stringify(data.batch.rows) !== JSON.stringify(tinyRows()))
			throw new Error("Tiny batch rows mismatch")
	}
	if (
		data.action === "query" &&
		(!data.readerOwner ||
			Object.keys(data.readerOwner).sort().join() !== "id,owner" ||
			!Number.isSafeInteger(data.readerOwner.id) ||
			data.readerOwner.id < 0 ||
			!Number.isSafeInteger(data.readerOwner.owner) ||
			data.readerOwner.owner < 1)
	)
		throw new Error("Invalid reader owner token")
	// Covers open/recovery, WAL-mode header transition, checkpoint and last close.
	check()
	if (!fresh) verifyTinyReopen(data.directory)
	let db = new DatabaseSync(path, {
		readOnly: data.role === "reader",
		allowExtension: false,
	})
	const reservations = []
	const configure = () => {
		if (data.role === "writer")
			db.exec(
				"PRAGMA page_size=4096; PRAGMA max_page_count=128; PRAGMA cache_spill=OFF; PRAGMA cache_size=128; PRAGMA temp_store=MEMORY; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50; PRAGMA wal_autocheckpoint=32;",
			)
		else
			db.exec(
				"PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=50;",
			)
		const p = actualPragmas(db)
		if (data.role === "writer") assertTinyPragmas(p)
		else if (
			p.queryOnly !== 1 ||
			p.journalMode !== "wal" ||
			p.pageSize !== 4096 ||
			p.pageCount > 128
		)
			throw new Error("Reader settings mismatch")
		return p
	}
	const barrier = async point => {
		if (data.fault !== point) return
		parentPort.postMessage({ barrier: point })
		await new Promise(resolve => parentPort.once("message", resolve))
		throw new Error(`Unexpected continuation at ${point}`)
	}
	const transaction = async (label, mutate, faultable = false) => {
		assertTinyPragmas(actualPragmas(db))
		check() // Every write, including schema/epochs/prune/cleanup/recovery state.
		const before = inventoryArtifacts(data.directory)
		if (faultable) await barrier("before-begin")
		db.exec("BEGIN IMMEDIATE")
		let committing = false
		try {
			mutate()
			if (faultable) await barrier("insert")
			if (faultable && data.fault === "enospc")
				throw Object.assign(new Error("Injected ENOSPC"), { code: "ENOSPC" })
			committing = true
			db.exec("COMMIT")
		} catch (error) {
			if (label === "seed")
				error.ack = batchAcknowledgement(
					data.batch.id,
					committing ? "uncertain" : "failed",
					data.batch.rows.length,
				)
			if (db.isTransaction) db.exec("ROLLBACK")
			throw error
		}
		const after = inventoryArtifacts(data.directory)
		reservations.push({
			label,
			reserved: TINY_GROWTH,
			beforeBytes: before.bytes,
			afterBytes: after.bytes,
			dbGrowthBytes: Math.max(
				0,
				(after.files.find(file => file.name === "fixture.db")?.bytes ?? 0) -
					(before.files.find(file => file.name === "fixture.db")?.bytes ?? 0),
			),
			walGrowthBytes: Math.max(
				0,
				(after.files.find(file => file.name === "fixture.db-wal")?.bytes ?? 0) -
					(before.files.find(file => file.name === "fixture.db-wal")?.bytes ??
						0),
			),
		})
		if (faultable) await barrier("after-commit")
	}
	try {
		const initialPragmas = configure()
		if (fresh) await transaction("schema", () => db.exec(TINY_SCHEMA))
		const insert = row =>
			db
				.prepare("INSERT INTO activity VALUES(?,?,?,?,?,?,?,?)")
				.run(...Object.values(row))
		let ack = null
		let receiptOutcomes = null
		if (data.action === "seed") {
			const rows = tinyRows()
			await transaction(
				"seed",
				() => {
					db.exec("INSERT INTO epochs VALUES(1,960000000,0)")
					for (const row of rows) {
						insert(row)
						db.prepare("INSERT INTO receipts VALUES(?,1,?,?,?,?)").run(
							row.eventId,
							row.sequence,
							row.producer,
							row.sequence,
							row.payload,
						)
					}
					db.exec("UPDATE state SET high=24")
				},
				true,
			)
			ack = batchAcknowledgement(data.batch.id, "committed", rows.length)
		}
		if (data.action === "append")
			await transaction("append", () => {
				insert(tinyRows(25)[24])
				db.exec("UPDATE state SET high=25")
			})
		if (data.action === "prune")
			await transaction("prune", () =>
				db.exec(
					"DELETE FROM activity WHERE sequence<=8; UPDATE state SET lowerBarrier=8;",
				),
			)
		if (data.action === "restore")
			await transaction("restore-generation", () =>
				db.exec("UPDATE state SET generation=2"),
			)
		if (data.action === "receipts") {
			const rows = tinyRows(20)
			for (const row of rows)
				await transaction("epoch-admission", () => {
					db.prepare("INSERT INTO epochs VALUES(?,?,0)").run(
						row.sequence,
						(row.sequence - 1 + 16) * 60000000,
					)
					insert(row)
					db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
						row.eventId,
						row.sequence,
						row.sequence,
						row.producer,
						row.sequence,
						row.payload,
					)
					db.prepare("UPDATE state SET high=?").run(row.sequence)
				})
			// Failed owner ack leaves the immutable receipt; pruning cannot reappend.
			await transaction("prune-before-retry", () =>
				db.exec(
					"DELETE FROM activity WHERE sequence=1; UPDATE state SET lowerBarrier=1;",
				),
			)
			const retry = (epoch, now, generation = 1, payload = rows[0].payload) => {
				if (generation !== 1) return "GENERATION_RESET"
				const ticket = db.prepare("SELECT * FROM epochs WHERE id=?").get(epoch)
				if (!ticket || ticket.closed || now >= ticket.expires)
					return "ADMISSION_EXPIRED"
				const receipt = db
					.prepare("SELECT * FROM receipts WHERE eventId=?")
					.get(rows[0].eventId)
				return receipt?.epoch !== epoch
					? "ADMISSION_EXPIRED"
					: receipt.canonical !== payload
						? "CONFLICT"
						: { sequence: receipt.sequence, epoch: receipt.epoch }
			}
			receiptOutcomes = [
				retry(1, 15 * 60000000),
				retry(1, 15 * 60000000, 1, "changed"),
				retry(99, 0),
				retry(1, 0, 2),
				retry(1, 16 * 60000000),
			]
			await transaction("epoch-close", () =>
				db.exec("UPDATE epochs SET closed=1 WHERE expires<=1140000000"),
			)
			await barrier("receipt-cleanup")
			await transaction("receipt-cleanup", () =>
				db.exec(
					"DELETE FROM receipts WHERE epoch IN (SELECT id FROM epochs WHERE closed=1)",
				),
			)
			receiptOutcomes.push(retry(1, 0)) // Closed epochs cannot reopen on clock rewind.
			if (
				db.prepare("SELECT count(*) n FROM activity WHERE sequence=1").get()
					.n !== 0
			)
				throw new Error("Retry reappended pruned event")
		}
		let pages = null
		let plans = null
		if (data.action === "query") {
			if (
				!Array.isArray(data.requests) ||
				data.requests.length > 16 ||
				!data.requests.length
			)
				throw new Error("Tiny query quota")
			pages = []
			plans = []
			const state = db.prepare("SELECT * FROM state").get()
			for (const request of data.requests) {
				if (
					Object.keys(request).sort().join() !==
						"after,contract,generation,high,lower,queryClass" ||
					![
						request.after,
						request.generation,
						request.high,
						request.lower,
						request.queryClass,
					].every(Number.isSafeInteger) ||
					typeof request.contract !== "string" ||
					request.contract.length > 64 ||
					request.after < request.lower ||
					request.after > request.high ||
					request.high > state.high ||
					request.lower < 0
				)
					throw new Error("Invalid tiny cursor")
				const [predicate, args] = tinyQuery(request.queryClass)
				if (request.contract !== `tiny-v1:ascending:${request.queryClass}`) {
					pages.push({ reset: "filter-contract" })
					continue
				}
				if (
					request.generation !== state.generation ||
					request.lower !== state.lowerBarrier
				) {
					pages.push({
						reset:
							request.generation !== state.generation
								? "generation"
								: "retention",
					})
					continue
				}
				const end = Math.min(request.high, request.after + 4)
				const sql = `SELECT sequence FROM activity WHERE ${predicate} AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 200`
				const values = [...args, request.after, end]
				plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values))
				const page = {
					sequences: db
						.prepare(sql)
						.all(...values)
						.map(row => row.sequence),
					scannedThrough: end,
					high: request.high,
					lower: request.lower,
					generation: request.generation,
					done: end === request.high,
				}
				if (Buffer.byteLength(JSON.stringify(page)) > 1024 * 1024)
					throw new Error("Page quota")
				pages.push(page)
			}
		}
		const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check
		const sequences = db
			.prepare("SELECT sequence FROM activity ORDER BY sequence")
			.all()
			.map(row => row.sequence)
		const ftsSequences = db
			.prepare(
				"SELECT rowid FROM search WHERE search MATCH 'common' ORDER BY rowid",
			)
			.all()
			.map(row => row.rowid)
		if (
			integrity !== "ok" ||
			JSON.stringify(sequences) !== JSON.stringify(ftsSequences)
		)
			throw new Error("Tiny recovery/FTS mismatch")
		if (data.role === "writer") {
			check()
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
		}
		const receiptFacts = {
			epochs: db.prepare("SELECT * FROM epochs ORDER BY id").all(),
			receipts: db
				.prepare("SELECT epoch,sequence FROM receipts ORDER BY sequence")
				.all(),
		}
		const finalPragmas = actualPragmas(db)
		check()
		db.close()
		db = null
		await barrier("reopen")
		return {
			status: "ok",
			provenance,
			initialPragmas,
			finalPragmas,
			reservations,
			ack,
			pages,
			plans,
			receiptOutcomes,
			receiptFacts,
			sequences,
			ftsSequences,
			integrity,
			growthReservation: TINY_GROWTH,
			byteAttribution:
				"Aggregate physical DB/WAL only; event/index/FTS/receipt attribution unavailable",
			unsupported: [
				"long 64MiB WAL pressure",
				"pinned reader/checkpoint and SQLITE_BUSY",
				"restored backup bytes/power loss",
				"long seed/load/runtime matrix",
				"external capture consumer",
			],
			readerReply:
				data.role === "reader"
					? Object.freeze({
							...data.readerOwner,
							reason: "successful",
							page: pages,
						})
					: null,
			runtime: {
				node: process.versions.node,
				sqlite: provenance,
				processRssBytes: process.memoryUsage().rss,
			},
			qualificationClaim: false,
		}
	} finally {
		if (db) {
			check()
			db.close()
		}
	}
}

async function fixture(data) {
	if (
		isMainThread ||
		!parentPort ||
		!supportedRuntime(process.versions.node) ||
		!["micro", "runtime", "tiny"].includes(data?.scenario) ||
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
				artifactBytes: inventoryArtifacts(data.directory).bytes,
				rssBytes: process.memoryUsage().rss,
				free: fs.statfsSync(data.directory, { bigint: true }),
			},
			data.reserveBytes + TINY_GROWTH.totalBytes,
		)
		// Reserve the entire capped database and one no-spill WAL commit, including
		// FULL-sync padding, before open/setup and every subsequent mutation.
		for (const [suffix, cap] of [
			["", LIMITS.dbBytes],
			["-wal", LIMITS.walBytes],
		]) {
			const path = join(data.directory, `fixture.db${suffix}`)
			try {
				if (
					fs.lstatSync(path).size +
						(suffix ? TINY_GROWTH.walBytes : TINY_GROWTH.dbBytes) >
					cap
				)
					throw new Error("Transaction growth allowance exceeded")
			} catch (error) {
				if (error.code !== "ENOENT") throw error
			}
		}
	}
	try {
		// Probe in memory before any file creation. No extension/custom VFS loading.
		const probe = new DatabaseSync(":memory:")
		let provenance
		try {
			provenance = probe
				.prepare(
					"SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId",
				)
				.get()
		} finally {
			probe.close()
		}
		if (!tinyGrowthSupported(process.versions.node, provenance.sourceId))
			return {
				status: "unsupported",
				error: "Unsupported pretransaction SQLite growth proof",
				provenance,
				counts,
			}
		check()
		if (data.scenario === "tiny")
			return await tinyFixture(data, DatabaseSync, check, provenance)
		db = new DatabaseSync(databasePath)
		db.exec(
			"PRAGMA page_size=4096; PRAGMA max_page_count=128; PRAGMA cache_spill=OFF; PRAGMA cache_size=128; PRAGMA temp_store=MEMORY; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=32; PRAGMA busy_timeout=50;",
		)
		const sqlite = db
			.prepare("SELECT sqlite_version() AS version")
			.get().version
		const compileOptions = db.prepare("PRAGMA compile_options").all()
		const pragmas = () => ({
			journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
			synchronous: db.prepare("PRAGMA synchronous").get().synchronous,
			pageSize: db.prepare("PRAGMA page_size").get().page_size,
			maxPageCount: db.prepare("PRAGMA max_page_count").get().max_page_count,
			cacheSpill: db.prepare("PRAGMA cache_spill").get().cache_spill,
			busyTimeout: db.prepare("PRAGMA busy_timeout").get().timeout,
			walAutocheckpoint: db.prepare("PRAGMA wal_autocheckpoint").get()
				.wal_autocheckpoint,
		})
		const initialPragmas = pragmas()
		assertTinyPragmas(initialPragmas, data.scenario === "runtime")
		check()
		db.exec(`BEGIN IMMEDIATE; CREATE TABLE activity(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
			CREATE VIRTUAL TABLE search USING fts5(payload, content='activity', content_rowid='id');
			CREATE TRIGGER activity_insert AFTER INSERT ON activity BEGIN INSERT INTO search(rowid,payload) VALUES(new.id,new.payload); END;
			CREATE TRIGGER activity_delete AFTER DELETE ON activity BEGIN INSERT INTO search(search,rowid,payload) VALUES('delete',old.id,old.payload); END;
			CREATE TABLE receipts(id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL);
			CREATE TABLE epochs(id INTEGER PRIMARY KEY, closed INTEGER NOT NULL);
			INSERT INTO epochs VALUES(1,0); COMMIT;`)
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
			check()
			db.exec(
				"BEGIN IMMEDIATE; INSERT INTO search(search,rank) VALUES('integrity-check',1); COMMIT; PRAGMA wal_checkpoint(TRUNCATE);",
			)
			check() // Last-close checkpoint is covered too.
			db.close()
			check() // Includes recovery/checkpoint growth before reopening.
			verifyTinyReopen(data.directory)
			db = new DatabaseSync(databasePath)
			db.exec(
				"PRAGMA max_page_count=128; PRAGMA cache_spill=OFF; PRAGMA cache_size=128; PRAGMA temp_store=MEMORY; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50; PRAGMA wal_autocheckpoint=32;",
			)
			assertTinyPragmas(pragmas())
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
			provenance,
			growthReservation: TINY_GROWTH,
			compileOptions,
			initialPragmas,
			finalPragmas: pragmas(),
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
		if (db) {
			check()
			db.close()
		}
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
			ack: error.ack,
		})
	} finally {
		parentPort.close()
	}
}
