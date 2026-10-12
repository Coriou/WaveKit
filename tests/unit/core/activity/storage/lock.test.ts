import { spawn } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ActivityStoreLockedError } from "../../../../../src/core/activity/storage/errors.js"
import { acquireActivityLock } from "../../../../../src/core/activity/storage/lock.js"
import type { ActivityLock } from "../../../../../src/core/activity/storage/lock.js"
import { openStore, roots, stores, tempDir } from "./helpers.js"

const held: ActivityLock[] = []

afterEach(async () => {
	await Promise.all(
		held.splice(0).map(lock => lock.release().catch(() => undefined)),
	)
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("activity store lock", () => {
	it("refuses a second opener in this process and releases on close", async () => {
		const stateDir = await tempDir()
		const lockPath = join(stateDir, "activity", "activity.lock.db")
		await mkdir(join(stateDir, "activity"), { recursive: true })
		const first = await acquireActivityLock(lockPath)
		held.push(first)
		const error = await acquireActivityLock(lockPath).then(
			() => undefined,
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(ActivityStoreLockedError)
		if (error instanceof ActivityStoreLockedError)
			expect(error.lockPath).toBe(lockPath)
		await first.release()
		const next = await acquireActivityLock(lockPath)
		held.push(next)
		expect(next.path).toBe(lockPath)
	})

	it("lets the next open succeed after the holder is killed", async () => {
		const stateDir = await tempDir()
		await mkdir(join(stateDir, "activity"), { recursive: true })
		const lockPath = join(stateDir, "activity", "activity.lock.db")
		const child = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				[
					'import { DatabaseSync } from "node:sqlite"',
					"const db = new DatabaseSync(process.env.LOCK_PATH, { timeout: 0 })",
					'db.exec("PRAGMA busy_timeout=0")',
					'db.exec("PRAGMA locking_mode=EXCLUSIVE")',
					'db.exec("BEGIN EXCLUSIVE")',
					'process.send("held")',
					"setInterval(() => {}, 1000)",
				].join("\n"),
			],
			{
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				env: { ...process.env, LOCK_PATH: lockPath },
			},
		)
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("child did not take the activity lock")),
					5_000,
				)
				child.once("message", message => {
					if (message !== "held") return
					clearTimeout(timer)
					resolve()
				})
				child.once("exit", code => {
					clearTimeout(timer)
					reject(new Error(`lock child exited early (${code})`))
				})
			})
			const blocked = await acquireActivityLock(lockPath).then(
				() => undefined,
				(caught: unknown) => caught,
			)
			expect(blocked).toBeInstanceOf(ActivityStoreLockedError)
			if (child.pid === undefined) throw new Error("lock child has no pid")
			process.kill(child.pid, "SIGKILL")
			await new Promise<void>(resolve => {
				child.once("exit", () => resolve())
			})
			const next = await acquireActivityLock(lockPath)
			held.push(next)
			expect(next.path).toBe(lockPath)
		} finally {
			if (child.exitCode === null && child.pid !== undefined) {
				try {
					process.kill(child.pid, "SIGKILL")
				} catch {
					// Already gone.
				}
			}
		}
	}, 10_000)

	it("keeps a live store locked until close", async () => {
		const stateDir = await tempDir()
		const store = await openStore({ stateDir })
		await expect(openStore({ stateDir })).rejects.toBeInstanceOf(
			ActivityStoreLockedError,
		)
		await store.close()
		const next = await openStore({ stateDir })
		expect(next.identity().storeUuid).toBe(store.identity().storeUuid)
	})
})
