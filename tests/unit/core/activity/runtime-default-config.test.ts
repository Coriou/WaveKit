import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	activityConfigOptions,
	startActivityRuntime,
} from "../../../../src/core/activity/runtime.js"
import { ConfigSchema } from "../../../../src/config.js"
import { logger, roots, tempDir } from "./storage/helpers.js"

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

// WG1 req 7.1, 7.2: the startup composition (src/index.ts) with a config that
// has no activity block opens the store with the bounded store defaults.
describe("activity with the default config", () => {
	it("passes no limit overrides and opens a ready store under stateDir", async () => {
		const stateDir = await tempDir()
		const config = ConfigSchema.parse({ stateDir })
		const options = activityConfigOptions(config.activity)
		expect(options).toEqual({ enabled: true })
		const runtime = await startActivityRuntime({
			...options,
			stateDir: config.stateDir,
			logger,
			execution: "inline",
			queryExecution: "inline",
			setPublisher: () => {},
		})
		try {
			expect(runtime.status).toBe("ready")
			expect(existsSync(join(stateDir, "activity", "activity.db"))).toBe(true)
		} finally {
			await runtime.close()
		}
	})

	it("keeps partial overrides and an explicit disable", () => {
		const partial = ConfigSchema.parse({
			activity: { retention: { maxRows: 1000 } },
		}).activity
		expect(activityConfigOptions(partial)).toEqual({
			enabled: true,
			retention: { maxRows: 1000 },
		})
		expect(
			activityConfigOptions(
				ConfigSchema.parse({ activity: { enabled: false } }).activity,
			),
		).toEqual({ enabled: false })
	})
})
