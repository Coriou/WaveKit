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

	it("keeps the bounded defaults and rejects inverted WAL thresholds", () => {
		// WG1 req 7.2: Activity is on by default, so the defaults are bounded.
		const limits = resolveActivityLimits()
		expect(limits.globalRatePerSec).toBe(50)
		expect(limits.globalBurst).toBe(500)
		expect(limits.decoderRatePerSec).toBe(20)
		expect(limits.decoderBurst).toBe(200)
		expect(limits.queueMaxItems).toBe(1024)
		expect(limits.queueMaxBytes).toBe(8 * 1024 * 1024)
		expect(limits.maxRows).toBe(250_000)
		expect(limits.maxDbBytes).toBe(256 * 1024 * 1024)
		expect(limits.maxAgeMs).toBe(3 * 24 * 60 * 60 * 1000)
		expect(limits.gapQuietMs).toBe(5_000)
		expect(limits.gapMaxIntervalMs).toBe(60_000)
		expect(limits.pruneBatchRows).toBe(500)
		expect(limits.pruneBurstBatches).toBe(20)
		expect(limits.pruneBurstMs).toBe(300)
		expect(limits.walPassiveBytes).toBe(16 * 1024 * 1024)
		expect(limits.walTruncateBytes).toBe(48 * 1024 * 1024)
		expect(limits.walPauseBytes).toBe(64 * 1024 * 1024)
		expect(resolveActivityLimits({ queueMaxItems: 2 }).queueMaxItems).toBe(2)
		// Partial overrides keep the bounded value of every omitted field.
		const partial = resolveActivityLimits({ maxRows: 1000, globalBurst: 10 })
		expect(partial).toEqual({
			...resolveActivityLimits(),
			maxRows: 1000,
			globalBurst: 10,
		})
		expect(partial.maxDbBytes).toBe(256 * 1024 * 1024)
		expect(partial.maxAgeMs).toBe(3 * 24 * 60 * 60 * 1000)
		expect(partial.decoderRatePerSec).toBe(20)
		expect(() =>
			resolveActivityLimits({
				walPassiveBytes: 10,
				walTruncateBytes: 5,
				walPauseBytes: 5,
			}),
		).toThrow(ActivityUnavailableError)
		expect(() => resolveActivityLimits({ maxRows: 999 })).toThrow(
			/maxRows must be at least 1000/,
		)
		expect(() =>
			resolveActivityLimits({ maxDbBytes: 16 * 1024 * 1024 - 1 }),
		).toThrow(/16 MiB/)
		expect(
			resolveActivityLimits({ maxDbBytes: 16 * 1024 * 1024 }).maxDbBytes,
		).toBe(16 * 1024 * 1024)
		expect(() =>
			resolveActivityLimits({ positionCoalesceMaxEntities: 0 }),
		).toThrow(/at least 1 tracked entity/)
		expect(
			resolveActivityLimits({
				positionCoalesceMs: 0,
				positionCoalesceMaxEntities: 0,
			}).positionCoalesceMs,
		).toBe(0)
		expect(() => resolveActivityLimits({ gapMaxIntervalMs: 0 })).toThrow(
			/gap interval/,
		)
		expect(() => resolveActivityLimits({ pruneBurstBatches: 0 })).toThrow(
			/prune burst/,
		)
		expect(() => resolveActivityLimits({ pruneBurstMs: 0 })).toThrow(
			/prune burst/,
		)
	})
})
