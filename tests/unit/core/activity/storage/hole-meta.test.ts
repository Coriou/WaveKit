import { rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	openActivityDatabase,
	readActivityState,
} from "../../../../../src/core/activity/storage/database.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import { createActivitySession } from "../../../../../src/core/activity/storage/writer-session.js"
import { roots, tempDir } from "./helpers.js"
import { smallLimits } from "./retention-helpers.js"

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

function holeKeys(db: Awaited<ReturnType<typeof openSqliteFile>>) {
	return db
		.prepare(
			"SELECT key, value FROM store_meta WHERE key IN ('holeWatermark', 'holeGeneration') ORDER BY key",
		)
		.all()
}

describe("hole meta keys", () => {
	it("are written as 0 on a new store and carried by the identity", async () => {
		const db = await openSqliteFile(":memory:")
		try {
			openActivityDatabase(db)
			expect(holeKeys(db)).toEqual([
				{ key: "holeGeneration", value: "0" },
				{ key: "holeWatermark", value: "0" },
			])
			const identity = readActivityState(db, ":memory:").identity
			expect(identity.holeWatermark).toBe("0")
			expect(identity.holeGeneration).toBe(0)
		} finally {
			db.close()
		}
	})

	it("are added with INSERT OR IGNORE when a store written before WG3 opens", async () => {
		const dbPath = join(await tempDir(), "pre-wg3.db")
		const old = await openSqliteFile(dbPath)
		openActivityDatabase(old)
		old.exec(
			"DELETE FROM store_meta WHERE key IN ('holeWatermark', 'holeGeneration')",
		)
		old.exec("UPDATE store_meta SET value = '7' WHERE key = 'pruneWatermark'")
		// Readers treat absent keys as 0.
		const absent = readActivityState(old, dbPath).identity
		expect(absent.holeWatermark).toBe("0")
		expect(absent.holeGeneration).toBe(0)
		old.close()
		const db = await openSqliteFile(dbPath)
		const session = createActivitySession(db, dbPath, smallLimits())
		try {
			expect(holeKeys(db)).toEqual([
				{ key: "holeGeneration", value: "0" },
				{ key: "holeWatermark", value: "0" },
			])
			const identity = session.snapshot().identity
			expect(identity.pruneWatermark).toBe("7")
			expect(identity.holeWatermark).toBe("0")
			expect(identity.holeGeneration).toBe(0)
			const version = db
				.prepare("SELECT value FROM store_meta WHERE key = 'schemaVersion'")
				.get()
			expect(version).toEqual({ value: "1" })
		} finally {
			session.close()
		}
	})

	it("keep existing values on reopen", async () => {
		const dbPath = join(await tempDir(), "kept.db")
		const first = await openSqliteFile(dbPath)
		openActivityDatabase(first)
		first.exec("UPDATE store_meta SET value = '42' WHERE key = 'holeWatermark'")
		first.exec("UPDATE store_meta SET value = '3' WHERE key = 'holeGeneration'")
		first.close()
		const db = await openSqliteFile(dbPath)
		try {
			openActivityDatabase(db)
			const identity = readActivityState(db, dbPath).identity
			expect(identity.holeWatermark).toBe("42")
			expect(identity.holeGeneration).toBe(3)
		} finally {
			db.close()
		}
	})
})
