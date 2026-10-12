import { randomBytes } from "node:crypto"
import { chmod, open, readFile, rename, rm, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { ActivityStoreLockedError, errnoCode } from "./errors.js"

const ATTEMPTS = 8

export interface ActivityLock {
	readonly path: string
	release(): Promise<void>
}

/**
 * Exclusive create of a pid lock file. A dead pid is reclaimed by renaming the
 * file aside (atomic) and retrying O_EXCL, so a live lock cannot be unlinked
 * out from under its owner. The holder keeps the fd until release and unlinks
 * only when the path still names that inode.
 */
export async function acquireActivityLock(path: string): Promise<ActivityLock> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		try {
			const handle = await open(path, "wx", 0o600)
			try {
				await handle.chmod(0o600)
				const nonce = randomBytes(16).toString("hex")
				const payload = `${process.pid}\n${nonce}\n`
				await handle.writeFile(payload)
				await handle.sync()
				const owned = await handle.stat()
				const linked = await stat(path)
				if (owned.ino !== linked.ino || owned.dev !== linked.dev) {
					await handle.close()
					continue
				}
				return createLock(path, handle, owned.ino, owned.dev)
			} catch (error) {
				await handle.close().catch(() => undefined)
				throw error
			}
		} catch (error) {
			if (errnoCode(error) !== "EEXIST") throw error
			if (!(await isStale(path))) throw new ActivityStoreLockedError(path)
			const retired = `${path}.stale.${randomBytes(8).toString("hex")}`
			try {
				await rename(path, retired)
			} catch {
				continue
			}
			await rm(retired, { force: true }).catch(() => undefined)
		}
	}
	throw new ActivityStoreLockedError(path)
}

function createLock(
	path: string,
	handle: FileHandle,
	ino: number,
	dev: number,
): ActivityLock {
	let released = false
	return {
		path,
		async release() {
			if (released) return
			released = true
			try {
				const current = await stat(path)
				if (current.ino === ino && current.dev === dev)
					await rm(path, { force: true })
			} catch (error) {
				if (errnoCode(error) !== "ENOENT") {
					await handle.close().catch(() => undefined)
					throw error
				}
			}
			await handle.close().catch(() => undefined)
		},
	}
}

async function isStale(path: string): Promise<boolean> {
	let text: string
	try {
		text = await readFile(path, "utf8")
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return false
		return true
	}
	const line = text.split("\n")[0]
	const pid = Number(line)
	if (!line || !Number.isInteger(pid) || pid <= 0) return true
	return !pidAlive(pid)
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM means the pid exists but we cannot signal it.
		return errnoCode(error) !== "ESRCH"
	}
}

export async function restrictPrivate(
	path: string,
	mode: number,
): Promise<void> {
	await chmod(path, mode)
}
