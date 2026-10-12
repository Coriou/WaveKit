import { readdir, rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { ActivityUnavailableError } from "../../../../../src/core/activity/storage/errors.js"
import { resolveActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import { probeActivityRuntime } from "../../../../../src/core/activity/storage/probe.js"
import { openActivityStore } from "../../../../../src/core/activity/storage/store.js"
import { logger, roots, stores, tempDir } from "./helpers.js"

afterEach(async () => {
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("activity runtime probe", () => {
	it("accepts this runtime's node:sqlite FTS5", async () => {
		await expect(probeActivityRuntime()).resolves.toEqual({ ok: true })
	})

	it("refuses to create state files when the probe fails", async () => {
		const stateDir = await tempDir()
		await expect(
			openActivityStore({
				stateDir,
				logger,
				execution: "inline",
				probe: () =>
					Promise.resolve({ ok: false, reason: "no such module: fts5" }),
			}),
		).rejects.toBeInstanceOf(ActivityUnavailableError)
		await expect(readdir(stateDir)).resolves.toEqual([])
	})

	it("keeps spec defaults and rejects inverted WAL thresholds", () => {
		const limits = resolveActivityLimits()
		expect(limits.globalRatePerSec).toBe(100)
		expect(limits.globalBurst).toBe(1000)
		expect(limits.decoderRatePerSec).toBe(50)
		expect(limits.decoderBurst).toBe(200)
		expect(limits.queueMaxItems).toBe(1024)
		expect(limits.queueMaxBytes).toBe(8 * 1024 * 1024)
		expect(limits.maxRows).toBe(1_000_000)
		expect(limits.maxAgeMs).toBe(7 * 24 * 60 * 60 * 1000)
		expect(limits.walPassiveBytes).toBe(16 * 1024 * 1024)
		expect(limits.walTruncateBytes).toBe(48 * 1024 * 1024)
		expect(limits.walPauseBytes).toBe(64 * 1024 * 1024)
		expect(resolveActivityLimits({ queueMaxItems: 2 }).queueMaxItems).toBe(2)
		expect(() =>
			resolveActivityLimits({
				walPassiveBytes: 10,
				walTruncateBytes: 5,
				walPauseBytes: 5,
			}),
		).toThrow(ActivityUnavailableError)
	})
})
