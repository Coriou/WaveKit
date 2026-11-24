import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createStorageReporter } from "../../../../src/core/storage-report/reporter.js"
import type { StorageAreaSource } from "../../../../src/core/storage-report/contract.js"
import type {
	StorageAreaScan,
	StorageScanFs,
} from "../../../../src/core/storage-report/scan.js"
import {
	STORAGE_REPORT_CACHE_MS,
	STORAGE_SCAN_MAX_ENTRIES,
	STORAGE_SCAN_MAX_WALL_MS,
} from "@wavekit/api-types"
import {
	STORAGE_COUNT_MAX_SERVE_AGE_MS,
	STORAGE_COUNT_MAX_WALL_MS,
} from "../../../../src/core/storage-report/contract.js"

type ScanFn = NonNullable<
	NonNullable<Parameters<typeof createStorageReporter>[1]>["scan"]
>

const statfs = async () => ({ blocks: 10, bfree: 5, bavail: 4, bsize: 1 })

const area = (
	id: StorageAreaSource["id"],
	p = `/s/${id}`,
): StorageAreaSource => ({ id, paths: [p], capBytes: null })

const scanOf = (
	areas: readonly StorageAreaSource[],
	files: number,
	partialReason: StorageAreaScan["partialReason"] = null,
): StorageAreaScan[] =>
	areas.map(a => ({
		id: a.id,
		bytes: files * 10,
		files,
		exists: true,
		partialReason,
	}))

/** A scan whose every call waits until the test settles it. */
function deferredScans() {
	const pending: {
		areas: readonly StorageAreaSource[]
		resolve: (s: StorageAreaScan[]) => void
		reject: (e: unknown) => void
	}[] = []
	const scan = vi.fn(
		(areas: readonly StorageAreaSource[]) =>
			new Promise<StorageAreaScan[]>((resolve, reject) => {
				pending.push({ areas, resolve, reject })
			}),
	)
	return { scan: scan as unknown as ScanFn, calls: scan, pending }
}

/** Lets settled promises run their reactions. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

/**
 * A report budget no test reaches: a wait the test ends by settling the count never races a
 * real timer. Only a wait the test never ends (a count it settles later) uses a short budget.
 */
const NEVER_MS = 600_000

describe("storage report background count", () => {
	it("serves the previous count while a refresh outlasts the budget, then the refresh", async () => {
		let t = 1_000
		const { scan, calls, pending } = deferredScans()
		const rep = createStorageReporter(
			{
				stateDir: "/s",
				areas: [area("logs")],
				minFreeBytes: null,
				now: () => t,
			},
			{ scan, statfs, cacheMs: 500, limits: { maxWallMs: NEVER_MS } },
		)
		const cold = rep.report()
		await flush()
		pending[0]?.resolve(scanOf(pending[0].areas, 3))
		const first = await cold
		expect(first.areas[0]).toMatchObject({ files: 3, partial: false })
		expect(first.count).toEqual({
			countedAt: new Date(1_000).toISOString(),
			ageMs: 0,
			refreshing: false,
		})

		// Past the cache: a refresh starts and the old count (within the serve age) is served at once.
		t = 1_600
		const stale = await rep.report()
		expect(calls).toHaveBeenCalledTimes(2)
		expect(stale.areas[0]).toMatchObject({ files: 3, partial: false })
		expect(stale.count).toEqual({
			countedAt: new Date(1_000).toISOString(),
			ageMs: 600,
			refreshing: true,
		})
		// Shared until the refresh finishes.
		expect(await rep.report()).toBe(stale)

		t = 1_700
		pending[1]?.resolve(scanOf(pending[1].areas, 8))
		await flush()
		const next = await rep.report()
		expect(next).not.toBe(stale)
		expect(next.areas[0]).toMatchObject({ files: 8, partial: false })
		expect(next.count).toEqual({
			countedAt: new Date(1_700).toISOString(),
			ageMs: 0,
			refreshing: false,
		})
		// A fresh count starts no other one.
		expect(calls).toHaveBeenCalledTimes(2)
	})

	it("cold: serves the count's progress as time-limit lower bounds; asking again after it finishes clears the reason", async () => {
		let finish: (s: StorageAreaScan[]) => void = () => undefined
		const scan = ((areas, options) => {
			options?.progress?.(() => scanOf(areas, 2, "time-limit"))
			return new Promise<StorageAreaScan[]>(resolve => {
				finish = resolve
			})
		}) as ScanFn
		const areas = [area("activity"), area("logs")]
		const rep = createStorageReporter(
			{ stateDir: "/s", areas, minFreeBytes: null, now: () => 5_000 },
			{ scan, statfs, limits: { maxWallMs: 5 } },
		)
		const cold = await rep.report()
		expect(cold.areas.map(a => [a.files, a.partialReason])).toEqual([
			[2, "time-limit"],
			[2, "time-limit"],
		])
		expect(cold.count).toEqual({
			countedAt: null,
			ageMs: null,
			refreshing: true,
		})

		finish(scanOf(areas, 9))
		await flush()
		const done = await rep.report()
		expect(done.areas.map(a => [a.files, a.partial, a.partialReason])).toEqual([
			[9, false, null],
			[9, false, null],
		])
		expect(done.count?.refreshing).toBe(false)
		expect(done.count?.countedAt).toBe(new Date(5_000).toISOString())
	})

	it("a failed refresh keeps serving the previous count and the next report retries", async () => {
		let t = 0
		const { scan, calls, pending } = deferredScans()
		const rep = createStorageReporter(
			{
				stateDir: "/s",
				areas: [area("logs")],
				minFreeBytes: null,
				now: () => t,
			},
			{ scan, statfs, cacheMs: 100, limits: { maxWallMs: NEVER_MS } },
		)
		const first = rep.report()
		await flush()
		pending[0]?.resolve(scanOf(pending[0].areas, 4))
		await first
		t = 200
		// The previous count is served at once, without waiting for the refresh.
		const second = await rep.report()
		expect(second.areas[0]?.files).toBe(4)
		expect(second.count).toEqual({
			countedAt: new Date(0).toISOString(),
			ageMs: 200,
			refreshing: true,
		})
		pending[1]?.reject(new Error("walk failed"))
		await flush()
		const third = await rep.report()
		expect(third).not.toBe(second)
		expect(third.areas[0]?.files).toBe(4)
		expect(calls).toHaveBeenCalledTimes(3)
	})

	it("warm() starts the first count so the first report serves it complete", async () => {
		const { scan, calls, pending } = deferredScans()
		const rep = createStorageReporter(
			{
				stateDir: "/s",
				areas: [area("logs")],
				minFreeBytes: null,
				now: () => 0,
			},
			{ scan, statfs, limits: { maxWallMs: 5 } },
		)
		rep.warm?.()
		rep.warm?.()
		expect(calls).toHaveBeenCalledTimes(1)
		pending[0]?.resolve(scanOf(pending[0].areas, 6))
		await flush()
		const r = await rep.report()
		expect(r.areas[0]).toMatchObject({ files: 6, partial: false })
		expect(r.count?.refreshing).toBe(false)
		// Fresh: neither the report nor another warm() counts again.
		rep.warm?.()
		expect(calls).toHaveBeenCalledTimes(1)
	})

	it("warm() swallows invalid areas; the report fails with them", async () => {
		const rep = createStorageReporter(
			{
				stateDir: "/s",
				areas: () => [area("logs"), area("logs")],
				minFreeBytes: null,
			},
			{ statfs },
		)
		expect(() => rep.warm?.()).not.toThrow()
		await expect(rep.report()).rejects.toThrow("Duplicate storage area id")
	})

	it("never serves a count of other areas", async () => {
		let t = 0
		let list = [area("logs", "/a")]
		const { scan, pending } = deferredScans()
		const rep = createStorageReporter(
			{ stateDir: "/s", areas: () => list, minFreeBytes: null, now: () => t },
			// The moved report's wait ends by its budget: that count is never settled here.
			{ scan, statfs, cacheMs: 100, limits: { maxWallMs: 5 } },
		)
		rep.warm?.()
		pending[0]?.resolve(scanOf(pending[0].areas, 4))
		await flush()
		expect((await rep.report()).areas[0]?.files).toBe(4)
		list = [area("logs", "/b")]
		t = 200
		const moved = await rep.report()
		expect(moved.areas[0]).toMatchObject({
			files: 0,
			partialReason: "time-limit",
		})
		expect(moved.count?.countedAt).toBeNull()
		expect(pending[1]?.areas[0]?.paths).toEqual(["/b"])
	})

	it("serves the previous count of the areas it holds while a count of changed areas waits for the running one", async () => {
		let t = 0
		let list = [area("activity", "/x"), area("logs", "/a")]
		const { scan, calls, pending } = deferredScans()
		const rep = createStorageReporter(
			{ stateDir: "/s", areas: () => list, minFreeBytes: null, now: () => t },
			// Every wait here ends by its budget: the awaited count is settled only afterwards.
			{ scan, statfs, cacheMs: 100, limits: { maxWallMs: 5 } },
		)
		rep.warm?.()
		pending[0]?.resolve(scanOf(pending[0].areas, 4))
		await flush()
		// Past the cache: a refresh of the same areas starts and runs on.
		t = 200
		expect((await rep.report()).count?.refreshing).toBe(true)
		expect(calls).toHaveBeenCalledTimes(2)

		// The logs path moves mid-refresh: no second count overlaps the running one.
		list = [area("activity", "/x"), area("logs", "/b")]
		t = 400
		const moved = await rep.report()
		expect(calls).toHaveBeenCalledTimes(2)
		expect(moved.areas.map(a => [a.id, a.files, a.partialReason])).toEqual([
			["activity", 4, null],
			["logs", 0, "time-limit"],
		])
		expect(moved.count).toEqual({
			countedAt: new Date(0).toISOString(),
			ageMs: 400,
			refreshing: true,
		})

		// The old count finishes: the queued count of the moved areas starts at once.
		t = 450
		pending[1]?.resolve(scanOf(pending[1].areas, 6))
		await flush()
		expect(calls).toHaveBeenCalledTimes(3)
		expect(pending[2]?.areas.map(a => a.paths)).toEqual([["/x"], ["/b"]])
		const during = await rep.report()
		expect(during.areas.map(a => [a.id, a.files, a.partialReason])).toEqual([
			["activity", 6, null],
			["logs", 0, "time-limit"],
		])
		expect(during.count?.countedAt).toBe(new Date(450).toISOString())

		t = 500
		pending[2]?.resolve(scanOf(pending[2].areas, 9))
		await flush()
		const done = await rep.report()
		expect(done.areas.map(a => [a.id, a.files, a.partialReason])).toEqual([
			["activity", 9, null],
			["logs", 9, null],
		])
		expect(calls).toHaveBeenCalledTimes(3)
	})

	it("shares one report between overlapping requests mid-refresh and drops it when the refresh finishes", async () => {
		let t = 0
		const { scan, calls, pending } = deferredScans()
		const rep = createStorageReporter(
			{
				stateDir: "/s",
				areas: [area("logs")],
				minFreeBytes: null,
				now: () => t,
			},
			{ scan, statfs, cacheMs: 100, limits: { maxWallMs: NEVER_MS } },
		)
		rep.warm?.()
		pending[0]?.resolve(scanOf(pending[0].areas, 4))
		await flush()
		t = 200
		const a = rep.report()
		const b = rep.report()
		expect(b).toBe(a)
		const mid = await a
		expect(mid.count?.refreshing).toBe(true)
		// Cached (provisional) while the refresh runs.
		expect(await rep.report()).toBe(mid)
		t = 210
		pending[1]?.resolve(scanOf(pending[1].areas, 7))
		await flush()
		const after = await rep.report()
		expect(after).not.toBe(mid)
		expect(after.areas[0]?.files).toBe(7)
		expect(calls).toHaveBeenCalledTimes(2)
	})

	it("does not cache a report whose refresh finished between its build and its caching", async () => {
		let t = 0
		let settleDuringBuild = false
		const { scan, pending } = deferredScans()
		const rep = createStorageReporter(
			{
				stateDir: "/s",
				areas: [area("logs")],
				minFreeBytes: null,
				now: () => t,
				// Read at the end of the build, after the refresh started: settling it here lands
				// after the build read the settled-count total and before the report is cached.
				kept: () => {
					if (settleDuringBuild) {
						settleDuringBuild = false
						pending[1]?.resolve(scanOf(pending[1].areas, 8))
					}
					return null
				},
			},
			{ scan, statfs, cacheMs: 100, limits: { maxWallMs: NEVER_MS } },
		)
		rep.warm?.()
		pending[0]?.resolve(scanOf(pending[0].areas, 3))
		await flush()
		t = 200
		settleDuringBuild = true
		const mid = await rep.report()
		expect(mid.areas[0]?.files).toBe(3)
		expect(mid.count?.refreshing).toBe(true)
		// Not cached: the next request builds again and serves the finished refresh.
		const next = await rep.report()
		expect(next).not.toBe(mid)
		expect(next.areas[0]?.files).toBe(8)
		expect(next.count?.refreshing).toBe(false)
	})

	describe("the maximum serve age", () => {
		/** A reporter whose first count (3 files) finished at t = 0; `t` is the test clock. */
		async function counted(maxWallMs: number) {
			const clock = { t: 0 }
			const { scan, calls, pending } = deferredScans()
			const rep = createStorageReporter(
				{
					stateDir: "/s",
					areas: [area("logs")],
					minFreeBytes: null,
					now: () => clock.t,
				},
				{ scan, statfs, limits: { maxWallMs } },
			)
			rep.warm?.()
			pending[0]?.resolve(scanOf(pending[0].areas, 3))
			await flush()
			return { rep, calls, pending, clock }
		}

		it("is four cache periods: refresh trigger + count wall + report cache", () => {
			expect(STORAGE_COUNT_MAX_SERVE_AGE_MS).toBe(
				STORAGE_REPORT_CACHE_MS +
					STORAGE_COUNT_MAX_WALL_MS +
					STORAGE_REPORT_CACHE_MS,
			)
			expect(STORAGE_COUNT_MAX_SERVE_AGE_MS).toBe(120_000)
		})

		it("at the age: serves the count as exact at once while it refreshes", async () => {
			const { rep, calls, clock } = await counted(NEVER_MS)
			clock.t = STORAGE_COUNT_MAX_SERVE_AGE_MS
			const r = await rep.report()
			expect(calls).toHaveBeenCalledTimes(2)
			expect(r.areas[0]).toMatchObject({
				files: 3,
				partial: false,
				partialReason: null,
			})
			expect(r.count).toEqual({
				countedAt: new Date(0).toISOString(),
				ageMs: STORAGE_COUNT_MAX_SERVE_AGE_MS,
				refreshing: true,
			})
		})

		it("past the age: a refresh not done within the budget marks the served areas stale", async () => {
			// The wait ends by its 5 ms budget: the refresh is settled only afterwards.
			const { rep, pending, clock } = await counted(5)
			clock.t = STORAGE_COUNT_MAX_SERVE_AGE_MS + 1
			const r = await rep.report()
			expect(r.areas[0]).toMatchObject({
				files: 3,
				partial: true,
				partialReason: "stale",
			})
			expect(r.count).toEqual({
				countedAt: new Date(0).toISOString(),
				ageMs: STORAGE_COUNT_MAX_SERVE_AGE_MS + 1,
				refreshing: true,
			})
			clock.t = STORAGE_COUNT_MAX_SERVE_AGE_MS + 50
			pending[1]?.resolve(scanOf(pending[1].areas, 5))
			await flush()
			expect((await rep.report()).areas[0]).toMatchObject({
				files: 5,
				partial: false,
				partialReason: null,
			})
		})

		it("past the age: waits for the refresh within the budget and serves it", async () => {
			const { rep, pending, clock } = await counted(NEVER_MS)
			clock.t = STORAGE_COUNT_MAX_SERVE_AGE_MS + 1
			const waiting = rep.report()
			await flush()
			pending[1]?.resolve(scanOf(pending[1].areas, 5))
			const r = await waiting
			expect(r.areas[0]).toMatchObject({ files: 5, partial: false })
			expect(r.count).toEqual({
				countedAt: new Date(STORAGE_COUNT_MAX_SERVE_AGE_MS + 1).toISOString(),
				ageMs: 0,
				refreshing: false,
			})
		})

		it("past the age: a failed refresh serves the old count stale, not a failure", async () => {
			const { rep, pending, clock } = await counted(NEVER_MS)
			clock.t = STORAGE_COUNT_MAX_SERVE_AGE_MS + 1
			const waiting = rep.report()
			await flush()
			pending[1]?.reject(new Error("walk failed"))
			const r = await waiting
			expect(r.areas[0]).toMatchObject({ files: 3, partialReason: "stale" })
			expect(r.count?.refreshing).toBe(false)
		})

		it("a stale area with parts reports overBound null", async () => {
			const clock = { t: 0 }
			const { scan, pending } = deferredScans()
			const source: StorageAreaSource = {
				id: "scanner-evidence",
				paths: ["/s/scanner"],
				capBytes: null,
				parts: {
					parts: [
						{
							id: "recordings",
							names: ["recordings"],
							bounds: { maxBytes: 1, maxAgeMs: null, maxFiles: null },
						},
					],
					fallback: {
						id: "other",
						names: [],
						bounds: { maxBytes: null, maxAgeMs: null, maxFiles: null },
					},
				},
			}
			const rep = createStorageReporter(
				{
					stateDir: "/s",
					areas: [source],
					minFreeBytes: null,
					now: () => clock.t,
				},
				{ scan, statfs, limits: { maxWallMs: 5 } },
			)
			rep.warm?.()
			pending[0]?.resolve([
				{
					id: "scanner-evidence",
					bytes: 9,
					files: 1,
					exists: true,
					partialReason: null,
					parts: [
						{ id: "recordings", bytes: 9, files: 1, exists: true },
						{ id: "other", bytes: 0, files: 0, exists: false },
					],
				},
			])
			await flush()
			expect((await rep.report()).areas[0]?.parts?.[0]?.overBound).toBe(true)
			clock.t = STORAGE_COUNT_MAX_SERVE_AGE_MS + 1
			const stale = await rep.report()
			expect(stale.areas[0]?.partialReason).toBe("stale")
			expect(stale.areas[0]?.parts?.[0]?.overBound).toBeNull()
		})
	})

	it("a failed first count fails the waiting report and caches nothing", async () => {
		const { scan, calls, pending } = deferredScans()
		const rep = createStorageReporter(
			{
				stateDir: "/s",
				areas: [area("logs")],
				minFreeBytes: null,
				now: () => 0,
			},
			{ scan, statfs, limits: { maxWallMs: NEVER_MS } },
		)
		const waiting = rep.report()
		await flush()
		pending[0]?.reject(new Error("walk failed"))
		await expect(waiting).rejects.toThrow("walk failed")
		const retry = rep.report()
		await flush()
		expect(calls).toHaveBeenCalledTimes(2)
		pending[1]?.resolve(scanOf(pending[1].areas, 2))
		expect((await retry).areas[0]).toMatchObject({ files: 2, partial: false })
	})

	describe("a 50,000-file tree", () => {
		const DIRS = 500
		const PER_DIR = 100
		/** /t/d<i>/f<j>: 500 folders of 100 one-byte files, counting every fs call. */
		function treeFs(): StorageScanFs & { calls: number } {
			const stat = (kind: "dir" | "file") => ({
				size: kind === "file" ? 1 : 4096,
				isFile: () => kind === "file",
				isDirectory: () => kind === "dir",
				isSymbolicLink: () => false,
			})
			const fs = {
				calls: 0,
				lstat: async (p: string) => {
					fs.calls++
					const depth = p.split("/").length - 2
					return stat(depth < 2 ? "dir" : "file")
				},
				readdir: async (p: string) => {
					fs.calls++
					return p === "/t"
						? Array.from({ length: DIRS }, (_, i) => `d${i}`)
						: Array.from({ length: PER_DIR }, (_, j) => `f${j}`)
				},
			}
			return fs
		}
		const entries = 1 + DIRS + DIRS * PER_DIR

		it("was past the per-report entry bound", () => {
			expect(entries).toBeGreaterThan(STORAGE_SCAN_MAX_ENTRIES)
		})

		it("completes in one count, not partial, with one lstat per entry", async () => {
			const fs = treeFs()
			const rep = createStorageReporter(
				{
					stateDir: "/t",
					areas: [{ id: "logs", paths: ["/t"], capBytes: null }],
					minFreeBytes: null,
				},
				// The request may wait as long as the count needs: the outcome, not the time, is tested.
				{ fs, statfs, limits: { maxWallMs: 600_000 } },
			)
			const r = await rep.report()
			expect(r.areas[0]).toMatchObject({
				files: DIRS * PER_DIR,
				bytes: DIRS * PER_DIR,
				partial: false,
				partialReason: null,
			})
			expect(r.count?.refreshing).toBe(false)
			// One lstat per entry and one readdir per folder (the root and its 500).
			expect(fs.calls).toBe(entries + 1 + DIRS)
			// Served from the cache: no further fs call.
			await rep.report()
			expect(fs.calls).toBe(entries + 1 + DIRS)
			expect(STORAGE_SCAN_MAX_WALL_MS).toBe(2_000)
		})

		it("bounds the count at its maxEntries: complete at it, entry-limit past it", async () => {
			const at = await createStorageReporter(
				{
					stateDir: "/t",
					areas: [{ id: "logs", paths: ["/t"], capBytes: null }],
					minFreeBytes: null,
				},
				{
					fs: treeFs(),
					statfs,
					limits: { maxWallMs: 600_000 },
					countLimits: { maxEntries: entries },
				},
			).report()
			expect(at.areas[0]?.partialReason).toBeNull()
			const past = await createStorageReporter(
				{
					stateDir: "/t",
					areas: [{ id: "logs", paths: ["/t"], capBytes: null }],
					minFreeBytes: null,
				},
				{
					fs: treeFs(),
					statfs,
					limits: { maxWallMs: 600_000 },
					countLimits: { maxEntries: entries - 1 },
				},
			).report()
			expect(past.areas[0]?.partialReason).toBe("entry-limit")
		})
	})

	it("bounds the count at its wall time", async () => {
		const fs: StorageScanFs = {
			lstat: async p => ({
				size: 1,
				isFile: () => path.basename(p) !== "t",
				isDirectory: () => path.basename(p) === "t",
				isSymbolicLink: () => false,
			}),
			readdir: async () => ["a"],
		}
		const r = await createStorageReporter(
			{
				stateDir: "/t",
				areas: [{ id: "logs", paths: ["/t"], capBytes: null }],
				minFreeBytes: null,
			},
			{ fs, statfs, countLimits: { maxWallMs: 0 } },
		).report()
		expect(r.areas[0]?.partialReason).toBe("time-limit")
		expect(r.count?.refreshing).toBe(false)
		expect(r.count?.countedAt).not.toBeNull()
	})
})
