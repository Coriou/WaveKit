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
})
