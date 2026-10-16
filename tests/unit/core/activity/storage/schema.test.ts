import { mkdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ACTIVITY_SCHEMA_V1 } from "../../../../../src/core/activity/storage/contract.js"
import {
	openActivityDatabase,
	readActivityPragmas,
	readActivityState,
} from "../../../../../src/core/activity/storage/database.js"
import {
	ActivitySchemaMismatchError,
	ActivityStoreLockedError,
} from "../../../../../src/core/activity/storage/errors.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import { openStore, roots, stores, tempDir } from "./helpers.js"

afterEach(async () => {
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("activity schema", () => {
	it("creates schema v1 with the runtime pragmas and reopens the same identity", async () => {
		const stateDir = await tempDir()
		const store = await openStore({ stateDir })
		const firstKey = store.cursorKey()
		const firstIdentity = store.identity()
		expect(firstKey).toHaveLength(32)
		expect(store.cursorKey()).not.toBe(firstKey)
		expect(store.cursorKey().equals(firstKey)).toBe(true)
		firstKey[0] = firstKey[0] === 0 ? 1 : 0
		expect(store.cursorKey().equals(firstKey)).toBe(false)
		expect(firstIdentity.restoreGeneration).toBe(1)
		expect(firstIdentity.pruneWatermark).toBe("0")
		expect(firstIdentity.pruneGeneration).toBe(0)
		expect(firstIdentity.committedMax).toBe("0")
		const db = await openSqliteFile(store.dbPath, true)
		try {
			const pragmas = readActivityPragmas(db)
			expect(pragmas.autoVacuum).toBe(2)
			expect(pragmas.journalMode).toBe("wal")
			const state = readActivityState(db, store.dbPath)
			expect(state.identity.storeUuid).toBe(firstIdentity.storeUuid)
			expect(state.cursorKey.equals(store.cursorKey())).toBe(true)
		} finally {
			db.close()
		}
		const originalKey = Buffer.from(store.cursorKey())
		await store.close()
		const reopened = await openStore({ stateDir })
		expect(reopened.identity().storeUuid).toBe(firstIdentity.storeUuid)
		expect(reopened.cursorKey().equals(originalKey)).toBe(true)
		const mode = async (path: string): Promise<number> =>
			(await stat(path)).mode & 0o777
		expect(await mode(join(stateDir, "activity"))).toBe(0o700)
		expect(await mode(store.dbPath)).toBe(0o600)
		expect(await mode(`${store.dbPath}-wal`)).toBe(0o600)
	})

	it("refuses a different schema version before switching the journal mode", async () => {
		const stateDir = await tempDir()
		const dbPath = join(stateDir, "activity", "activity.db")
		await mkdir(join(stateDir, "activity"), { recursive: true })
		const created = await openSqliteFile(dbPath)
		created.exec(ACTIVITY_SCHEMA_V1)
		created.exec(
			"INSERT INTO store_meta(key, value) VALUES ('schemaVersion', '2'), ('storeUuid', 'x')",
		)
		created.close()
		await expect(openStore({ stateDir })).rejects.toBeInstanceOf(
			ActivitySchemaMismatchError,
		)
		await expect(openStore({ stateDir })).rejects.toMatchObject({ found: "2" })
		await expect(stat(`${dbPath}-wal`)).rejects.toThrow()
		await expect(
			stat(join(stateDir, "activity", "activity.lock")),
		).rejects.toThrow()
		const inspect = await openSqliteFile(dbPath, true)
		try {
			expect(readActivityPragmas(inspect).journalMode).toBe("delete")
		} finally {
			inspect.close()
		}
	})

	it("rejects a second opener and releases the lock on close", async () => {
		const stateDir = await tempDir()
		const store = await openStore({ stateDir })
		await expect(openStore({ stateDir })).rejects.toBeInstanceOf(
			ActivityStoreLockedError,
		)
		expect(store.stats().rows).toBe(0)
		await store.close()
		const next = await openStore({ stateDir })
		expect(next.identity().storeUuid).toBe(store.identity().storeUuid)
		await next.close()
		await expect(
			stat(join(stateDir, "activity", "activity.lock")),
		).rejects.toThrow()
		await expect(
			stat(join(stateDir, "activity", "activity.lock.db")),
		).resolves.toBeTruthy()
	})

	it("creates the schema inside the database opened by openActivityDatabase", async () => {
		const stateDir = await tempDir()
		const dbPath = join(stateDir, "created.db")
		const db = await openSqliteFile(dbPath)
		try {
			const opened = openActivityDatabase(db)
			expect(opened.created).toBe(true)
			expect(opened.cursorKey).toHaveLength(32)
			const again = openActivityDatabase(db)
			expect(again.created).toBe(false)
			expect(again.cursorKey.equals(opened.cursorKey)).toBe(true)
			expect(readActivityPragmas(db)).toMatchObject({
				autoVacuum: 2,
				journalMode: "wal",
				synchronous: 2,
				busyTimeout: 100,
				foreignKeys: 1,
				walAutocheckpoint: 0,
			})
		} finally {
			db.close()
		}
	})
})
