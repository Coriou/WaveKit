import { describe, expect, it, vi } from "vitest"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { createStorageReporter } from "../../../../src/core/storage-report/reporter.js"
import type { StorageAreaSource } from "../../../../src/core/storage-report/contract.js"
import type { StorageActivityRetention } from "@wavekit/api-types"

type ScanFn = NonNullable<Parameters<typeof createStorageReporter>[1]>["scan"]
type StatfsFn = NonNullable<
	NonNullable<Parameters<typeof createStorageReporter>[1]>["statfs"]
>

const src = (
	id: StorageAreaSource["id"],
	capBytes: number | null = null,
): StorageAreaSource => ({ id, paths: [`/secret/${id}`], capBytes })

const okScan: NonNullable<ScanFn> = vi.fn(
	async (areas: readonly StorageAreaSource[]) =>
		areas.map(a => ({
			id: a.id,
			bytes: 10,
			files: 2,
			exists: true,
			partialReason: null,
		})),
) as unknown as NonNullable<ScanFn>

const statfsOk: StatfsFn = async () => ({
	blocks: 1000,
	bfree: 400n,
	bavail: 300,
	bsize: 4096n,
})

const retention: StorageActivityRetention = {
	policy: "fair-share",
	effective: null,
	maxRows: 1,
	maxDbBytes: 2,
	maxAgeMs: 3,
	rows: null,
	oldestReceivedAt: null,
	shares: [],
	sharesTruncated: false,
}

function make(
	over: Partial<Parameters<typeof createStorageReporter>[0]> = {},
	internal: NonNullable<Parameters<typeof createStorageReporter>[1]> = {},
) {
	return createStorageReporter(
		{
			stateDir: "/state",
			areas: [src("activity", 100)],
			minFreeBytes: null,
			now: () => 1_000,
			...over,
		},
		{ scan: okScan, statfs: statfsOk, ...internal },
	)
}

describe("storage reporter", () => {
	it("sorts areas into STORAGE_AREA_IDS order and builds areas", async () => {
		const scan = vi.fn(okScan)
		const r = await make(
			{ areas: [src("logs"), src("activity", 100), src("station")] },
			{ scan },
		).report()
		expect(r.areas.map(a => a.id)).toEqual(["activity", "station", "logs"])
		expect(scan.mock.calls[0]?.[0].map(a => a.id)).toEqual([
			"activity",
			"station",
			"logs",
		])
		expect(r.areas[0]).toMatchObject({
			class: "automatic",
			cap: { bytes: 100 },
			bytes: 10,
			files: 2,
			partial: false,
		})
		expect(r.areas[1]).toMatchObject({ class: "state", cap: null })
		expect(r.areas[2]).toMatchObject({ class: "other" })
		expect(r.kept).toBeNull()
		expect(r.generatedAt).toBe(new Date(1_000).toISOString())
		expect(r.cachedUntil).toBe(new Date(31_000).toISOString())
	})

	it("marks partial from partialReason", async () => {
		const scan = (async areas =>
			areas.map(a => ({
				id: a.id,
				bytes: 1,
				files: 1,
				exists: true,
				partialReason: "time-limit" as const,
			}))) as NonNullable<ScanFn>
		const r = await make({}, { scan }).report()
		expect(r.areas[0]).toMatchObject({
			partial: true,
			partialReason: "time-limit",
		})
	})

	it("throws on duplicate or unknown ids", () => {
		expect(() => make({ areas: [src("logs"), src("logs")] })).toThrow(
			WaveKitError,
		)
		expect(() =>
			make({ areas: [{ ...src("logs"), id: "nope" as never }] }),
		).toThrow(WaveKitError)
	})

	it("reports retention for activity only, null when absent/null/throwing", async () => {
		const areas = [src("activity"), src("logs")]
		const value = await make({
			areas,
			activityRetention: () => retention,
		}).report()
		expect(value.areas[0]?.retention).toEqual(retention)
		expect(value.areas[1]?.retention).toBeNull()
		for (const activityRetention of [
			undefined,
			() => null,
			() => {
				throw new Error("boom")
			},
		]) {
			const r = await make({
				areas,
				...(activityRetention ? { activityRetention } : {}),
			}).report()
			expect(r.areas[0]?.retention).toBeNull()
		}
	})

	it("computes filesystem from statfs and tolerates failure", async () => {
		const r = await make().report()
		expect(r.filesystem).toEqual({
			totalBytes: 1000 * 4096,
			freeBytes: 400 * 4096,
			availableBytes: 300 * 4096,
		})
		const bad = await make(
			{},
			{
				statfs: async () => {
					throw new Error("nope")
				},
			},
		).report()
		expect(bad.filesystem).toBeNull()
		expect(bad.lowSpace.state).toBe("unknown")
	})

	it("derives lowSpace state", async () => {
		const avail = 300 * 4096
		const state = async (minFreeBytes: number | null) =>
			(await make({ minFreeBytes }).report()).lowSpace
		expect(await state(avail + 1)).toEqual({
			policy: "scanner-evidence-stops-writing",
			minFreeBytes: avail + 1,
			state: "low",
		})
		expect((await state(avail)).state).toBe("ok")
		expect((await state(1)).state).toBe("ok")
		expect((await state(null)).state).toBe("unknown")
	})

	it("caches until expiry then rescans", async () => {
		let t = 1_000
		const scan = vi.fn(okScan)
		const rep = make({ now: () => t }, { scan, cacheMs: 500 })
		const a = await rep.report()
		t = 1_499
		expect(await rep.report()).toBe(a)
		expect(scan).toHaveBeenCalledTimes(1)
		t = 1_500
		const b = await rep.report()
		expect(b).not.toBe(a)
		expect(scan).toHaveBeenCalledTimes(2)
	})

	it("shares one scan between concurrent calls", async () => {
		const scan = vi.fn(okScan)
		const rep = make({}, { scan })
		const [a, b] = await Promise.all([rep.report(), rep.report()])
		expect(a).toBe(b)
		expect(scan).toHaveBeenCalledTimes(1)
	})

	it("does not cache a rejected scan", async () => {
		const scan = vi
			.fn<NonNullable<ScanFn>>()
			.mockRejectedValueOnce(new Error("scan failed"))
			.mockImplementation(okScan)
		const rep = make({}, { scan })
		await expect(rep.report()).rejects.toThrow("scan failed")
		await expect(rep.report()).resolves.toMatchObject({ kept: null })
		expect(scan).toHaveBeenCalledTimes(2)
	})

	it("runs statfs before the scan so fs concurrency stays <= 8", async () => {
		let inFlight = 0
		let peak = 0
		const track = async <T>(v: T): Promise<T> => {
			inFlight++
			peak = Math.max(peak, inFlight)
			await new Promise(resolve => setImmediate(resolve))
			inFlight--
			return v
		}
		const nodes = Array.from({ length: 40 }, (_, i) => `f${i}`)
		const fs = {
			lstat: (p: string) =>
				track({
					size: 1,
					isFile: () => p !== "/d",
					isDirectory: () => p === "/d",
					isSymbolicLink: () => false,
				}),
			readdir: () => track(nodes),
		}
		const r = createStorageReporter(
			{
				areas: [{ id: "logs", paths: ["/d"], capBytes: null }],
				stateDir: "/d",
				minFreeBytes: null,
			},
			{ fs, statfs: () => track({ blocks: 1, bfree: 1, bavail: 1, bsize: 1 }) },
		)
		const report = await r.report()
		expect(report.areas[0]?.files).toBe(40)
		expect(report.filesystem).not.toBeNull()
		expect(peak).toBe(8)
	})

	it("bounds a stalled statfs within the report deadline", async () => {
		let lstats = 0
		const fs = {
			lstat: () => {
				lstats++
				return Promise.resolve({
					size: 1,
					isFile: () => true,
					isDirectory: () => false,
					isSymbolicLink: () => false,
				})
			},
			readdir: () => Promise.resolve([]),
		}
		const r = createStorageReporter(
			{
				areas: [{ id: "logs", paths: ["/d"], capBytes: null }],
				stateDir: "/d",
				minFreeBytes: 1,
			},
			{
				fs,
				limits: { maxWallMs: 20 },
				statfs: () => new Promise<never>(() => undefined),
			},
		)
		const started = Date.now()
		const report = await r.report()
		expect(Date.now() - started).toBeLessThan(1_000)
		expect(report.filesystem).toBeNull()
		expect(report.lowSpace.state).toBe("unknown")
		expect(report.areas[0]?.partialReason).toBe("time-limit")
		expect(lstats).toBe(0)
	})

	it("passes the remaining budget and concurrency - 1 after a statfs timeout", async () => {
		const scanSpy = vi.fn(okScan)
		const r = createStorageReporter(
			{ areas: [src("logs")], stateDir: "/d", minFreeBytes: null },
			{
				scan: scanSpy as unknown as NonNullable<ScanFn>,
				limits: { maxWallMs: 20 },
				statfs: () => new Promise<never>(() => undefined),
			},
		)
		await r.report()
		const limits = scanSpy.mock.calls[0]?.[1]?.limits
		expect(limits?.concurrency).toBe(7)
		expect(limits?.maxWallMs).toBeLessThanOrEqual(1)
	})

	it("reads area and minFreeBytes providers at each scan, not on cache hits", async () => {
		let t = 0
		let list: StorageAreaSource[] = [src("activity", 100)]
		let min: number | null = null
		const areas = vi.fn(() => list)
		const minFreeBytes = vi.fn(() => min)
		const scan = vi.fn(okScan)
		const rep = make(
			{ areas, minFreeBytes, now: () => t },
			{ scan, cacheMs: 500 },
		)
		// Not read at construction.
		expect(areas).not.toHaveBeenCalled()
		const [first, shared] = await Promise.all([rep.report(), rep.report()])
		expect(shared).toBe(first)
		expect(first.areas.map(a => a.id)).toEqual(["activity"])
		expect(first.lowSpace).toMatchObject({
			minFreeBytes: null,
			state: "unknown",
		})
		expect(areas).toHaveBeenCalledTimes(1)
		expect(minFreeBytes).toHaveBeenCalledTimes(1)
		// A runtime change waits for the cache to expire.
		list = [src("logs"), src("scanner-evidence", 7), src("activity", 100)]
		min = 1
		t = 499
		expect(await rep.report()).toBe(first)
		expect(areas).toHaveBeenCalledTimes(1)
		t = 500
		const next = await rep.report()
		expect(next.areas.map(a => [a.id, a.cap])).toEqual([
			["activity", { bytes: 100 }],
			["scanner-evidence", { bytes: 7 }],
			["logs", null],
		])
		expect(next.lowSpace).toMatchObject({ minFreeBytes: 1, state: "ok" })
		expect(scan).toHaveBeenCalledTimes(2)
		expect(areas).toHaveBeenCalledTimes(2)
		expect(minFreeBytes).toHaveBeenCalledTimes(2)
	})

	it("rejects a scan whose provider returns invalid areas, uncached", async () => {
		let list: StorageAreaSource[] = [src("logs"), src("logs")]
		const rep = make({ areas: () => list })
		await expect(rep.report()).rejects.toThrow(WaveKitError)
		list = [src("logs")]
		expect((await rep.report()).areas.map(a => a.id)).toEqual(["logs"])
	})
})
