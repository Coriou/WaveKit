import { spawnSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ActivityStoreLockedError } from "../../../../../src/core/activity/storage/errors.js"
import { openStore, roots, stores, tempDir } from "./helpers.js"

afterEach(async () => {
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("activity store lock", () => {
	it("reclaims a lock whose pid is dead", async () => {
		const stateDir = await tempDir()
		const finished = spawnSync(process.execPath, ["-e", "process.exit(0)"])
		expect(finished.pid).toBeGreaterThan(0)
		await mkdir(join(stateDir, "activity"), { recursive: true })
		await writeFile(
			join(stateDir, "activity", "activity.lock"),
			`${finished.pid}\nstale\n`,
		)
		const store = await openStore({ stateDir })
		expect(store.identity().restoreGeneration).toBe(1)
		await store.close()
	})

	it("reclaims a corrupt lock and still rejects a live holder", async () => {
		const stateDir = await tempDir()
		await mkdir(join(stateDir, "activity"), { recursive: true })
		await writeFile(join(stateDir, "activity", "activity.lock"), "not-a-pid\n")
		const store = await openStore({ stateDir })
		const error = await openStore({ stateDir }).then(
			() => undefined,
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(ActivityStoreLockedError)
		if (error instanceof ActivityStoreLockedError)
			expect(
				error.lockPath.endsWith(`${join("activity", "activity.lock")}`),
			).toBe(true)
		await store.close()
		const next = await openStore({ stateDir })
		expect(next.identity().storeUuid).toBe(store.identity().storeUuid)
	})
})
