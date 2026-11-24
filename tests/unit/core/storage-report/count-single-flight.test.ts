/**
 * Background counts are single-flight across their fs calls: a count that hit its wall time on
 * a stalled filesystem leaves its calls pending, and no later count starts until they drain, so
 * the counts never hold more pool threads than STORAGE_COUNT_FS_CONCURRENCY together.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createStorageReporter } from "../../../../src/core/storage-report/reporter.js"
import { STORAGE_COUNT_FS_CONCURRENCY } from "../../../../src/core/storage-report/contract.js"
import type { StorageScanFs } from "../../../../src/core/storage-report/scan.js"
import type { Logger } from "../../../../src/utils/logger.js"

const statfs = async () => ({ blocks: 10, bfree: 5, bavail: 4, bsize: 1 })

/** A folder of files whose lstat calls hang while `stalled`, until the test releases them. */
function stallingFs() {
	let stalled = true
	let inFlight = 0
	let maxInFlight = 0
	const hung: Array<() => void> = []
	const enter = (): (() => void) => {
		inFlight++
		maxInFlight = Math.max(maxInFlight, inFlight)
		return () => {
			inFlight--
		}
	}
	const file = {
		size: 1,
		isFile: () => true,
		isDirectory: () => false,
		isSymbolicLink: () => false,
	}
	const dir = { ...file, size: 0, isFile: () => false, isDirectory: () => true }
	const lstat = vi.fn((p: string) => {
		const leave = enter()
		if (p === "/s/logs") {
			leave()
			return Promise.resolve(dir)
		}
		if (!stalled) {
			leave()
			return Promise.resolve(file)
		}
		return new Promise<typeof file>(resolve => {
			hung.push(() => {
				leave()
				resolve(file)
			})
		})
	})
	const readdir = vi.fn((_p: string) => {
		const leave = enter()
		leave()
		return Promise.resolve(Array.from({ length: 10 }, (_, i) => `f${i}`))
	})
	const fs: StorageScanFs = { lstat, readdir }
	return {
		fs,
		lstat,
		maxInFlight: () => maxInFlight,
		inFlight: () => inFlight,
		release: () => {
			stalled = false
			for (const resolve of hung.splice(0)) resolve()
		},
	}
}

/** Lets settled promises run their reactions (setImmediate is not faked). */
const flush = async () => {
	for (let i = 0; i < 5; i++)
		await new Promise<void>(resolve => setImmediate(resolve))
}

describe("storage count on a stalled filesystem", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		vi.setSystemTime(0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("starts no second count while the first one's fs calls hang, then the next count starts", async () => {
		const stalling = stallingFs()
		const rep = createStorageReporter(
			{
				stateDir: "/s",
				areas: [{ id: "logs", paths: ["/s/logs"], capBytes: null }],
				minFreeBytes: null,
			},
			{
				fs: stalling.fs,
				statfs,
				cacheMs: 100,
				limits: { maxWallMs: 10 },
				countLimits: { maxWallMs: 1_000 },
			},
		)
		rep.warm?.()
		await flush()
		// Root lstat plus the limit of hanging file lstats.
		expect(stalling.lstat).toHaveBeenCalledTimes(
			1 + STORAGE_COUNT_FS_CONCURRENCY,
		)
		expect(stalling.inFlight()).toBe(STORAGE_COUNT_FS_CONCURRENCY)

		// The count's wall time passes: it settles partial with its calls still pending.
		await vi.advanceTimersByTimeAsync(1_000)
		await flush()
		const partial = rep.report()
		await vi.advanceTimersByTimeAsync(10)
		expect((await partial).areas[0]).toMatchObject({
			partial: true,
			partialReason: "time-limit",
		})

		// Past the cache, reports ask for a new count: none starts while the calls hang.
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(200)
			const r = rep.report()
			await vi.advanceTimersByTimeAsync(10)
			await r
			await flush()
		}
		expect(stalling.lstat).toHaveBeenCalledTimes(
			1 + STORAGE_COUNT_FS_CONCURRENCY,
		)
		expect(stalling.maxInFlight()).toBe(STORAGE_COUNT_FS_CONCURRENCY)

		// The hung calls settle: the queued count starts and finishes complete.
		stalling.release()
		await flush()
		expect(stalling.lstat.mock.calls.length).toBeGreaterThan(
			1 + STORAGE_COUNT_FS_CONCURRENCY,
		)
		expect(stalling.maxInFlight()).toBe(STORAGE_COUNT_FS_CONCURRENCY)
		await vi.advanceTimersByTimeAsync(200)
		const after = rep.report()
		await vi.advanceTimersByTimeAsync(10)
		expect((await after).areas[0]).toMatchObject({
			files: 10,
			partial: false,
		})
	})
	it("a count queued behind hung fs calls reads as refreshing, warns once and is not cached as final", async () => {
		const stalling = stallingFs()
		const warn = vi.fn()
		const logger = { warn } as unknown as Logger
		const rep = createStorageReporter(
			{
				stateDir: "/s",
				areas: [{ id: "logs", paths: ["/s/logs"], capBytes: null }],
				minFreeBytes: null,
				logger,
			},
			{
				fs: stalling.fs,
				statfs,
				cacheMs: 100,
				limits: { maxWallMs: 10 },
				countLimits: { maxWallMs: 1_000 },
			},
		)
		rep.warm?.()
		await flush()
		// The count settles partial at its wall time; its lstat calls never settle meanwhile.
		await vi.advanceTimersByTimeAsync(1_000)
		await flush()
		expect(warn).not.toHaveBeenCalled()

		for (let i = 0; i < 2; i++) {
			await vi.advanceTimersByTimeAsync(200)
			const r = rep.report()
			await vi.advanceTimersByTimeAsync(10)
			const report = await r
			// No count runs, one waits for the hung calls: still a refresh.
			expect(report.count?.refreshing).toBe(true)
			expect(report.areas[0]).toMatchObject({ partial: true })
			await flush()
		}
		expect(warn).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(warn.mock.calls)).not.toContain("/s")

		// Within that report's cache window the calls drain: the queued count finishes and the
		// provisional report is dropped, so the next report serves its sizes at once.
		stalling.release()
		await flush()
		const after = rep.report()
		await vi.advanceTimersByTimeAsync(10)
		const final = await after
		expect(final.areas[0]).toMatchObject({ files: 10, partial: false })
		expect(final.count?.refreshing).toBe(false)
	})
})
