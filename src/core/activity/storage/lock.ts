import { chmod } from "node:fs/promises"
import { ActivityStoreLockedError } from "./errors.js"
import { loadDatabaseSync } from "./probe.js"
import type { SqliteDatabase } from "./sqlite.js"

export interface ActivityLock {
	readonly path: string
	release(): Promise<void>
}

/**
 * Kernel-released lock. The writer opens `<activity>/activity.lock.db` with
 * `locking_mode=EXCLUSIVE` and holds `BEGIN EXCLUSIVE` until close. The lock
 * drops when the connection closes or the process dies, including SIGKILL.
 * A second opener in this process or another gets ACTIVITY_STORE_LOCKED.
 */
export async function acquireActivityLock(path: string): Promise<ActivityLock> {
	const DatabaseSync = await loadDatabaseSync()
	const db = new DatabaseSync(path, { timeout: 0 })
	try {
		db.exec("PRAGMA busy_timeout=0")
		db.exec("PRAGMA locking_mode=EXCLUSIVE")
		db.exec("BEGIN EXCLUSIVE")
	} catch (error) {
		try {
			db.close()
		} catch {
			// The open error is the one the caller needs.
		}
		if (isLockBusy(error)) throw new ActivityStoreLockedError(path)
		throw error
	}
	try {
		await chmod(path, 0o600)
	} catch (error) {
		try {
			db.close()
		} catch {
			// The chmod error is the one the caller needs.
		}
		throw error
	}
	return createLock(path, db)
}

function createLock(path: string, db: SqliteDatabase): ActivityLock {
	let released = false
	return {
		path,
		async release() {
			if (released) return
			released = true
			db.close()
		},
	}
}

export async function restrictPrivate(
	path: string,
	mode: number,
): Promise<void> {
	await chmod(path, mode)
}

function isLockBusy(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false
	if ("errcode" in error && (error.errcode === 5 || error.errcode === 6))
		return true
	return (
		error instanceof Error &&
		/database is locked|database is busy/i.test(error.message)
	)
}
