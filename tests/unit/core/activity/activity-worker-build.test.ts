import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { createActivityQueryService } from "../../../../src/core/activity/query/service.js"
import { openActivityStore } from "../../../../src/core/activity/storage/store.js"
import { envelope, logger } from "./storage/helpers.js"

const WRITER = "dist/activity-writer-worker.js"
const QUERY = "dist/activity-query-worker.js"

// Runs after `pnpm run build`; skipped on a clean checkout.
describe.skipIf(!existsSync(WRITER) || !existsSync(QUERY))(
	"built activity workers",
	() => {
		it("ships both workers and opens the store with the built writer", async () => {
			expect(existsSync(WRITER)).toBe(true)
			expect(existsSync(QUERY)).toBe(true)
			const stateDir = await mkdtemp(join(tmpdir(), "wavekit-activity-built-"))
			const store = await openActivityStore({
				stateDir,
				logger,
				workerUrl: pathToFileURL(WRITER),
				limits: { batchWindowMs: 0 },
			})
			const service = createActivityQueryService({
				store,
				logger,
				execution: "worker",
				workerUrl: pathToFileURL(QUERY),
				limits: { deadlineMs: 5_000 },
			})
			try {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error("activity writer did not commit")),
						4_000,
					)
					const stop = store.onCommit(() => {
						clearTimeout(timer)
						stop()
						resolve()
					})
					const admitted = store.admit(
						envelope({ eventId: "built-1", title: "builtunique" }),
					)
					if (!admitted.admitted) {
						clearTimeout(timer)
						stop()
						reject(new Error(admitted.reason))
					}
				})
				const page = await service.search({ query: { text: "builtunique" } })
				expect(page.items.map(item => item.eventId)).toEqual(["built-1"])
			} finally {
				await service.close()
				await store.close()
				await rm(stateDir, { recursive: true, force: true })
			}
		})
	},
)
