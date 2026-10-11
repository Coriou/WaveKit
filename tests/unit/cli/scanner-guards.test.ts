import { describe, it, expect } from "vitest"
import {
	guardScan,
	guardSpectrumFrame,
	guardSpectrumProfile,
	parseScanEvent,
} from "../../../cli/source/data/scanner-guards.js"
import { parseServerMessage } from "../../../cli/source/data/guards.js"
import {
	SCAN_FRAME,
	SCAN_PROFILE,
	SCAN_JOB,
	SCAN_DISCOVERY,
	SCAN_STATUS,
} from "../../../cli/source/test/fixtures.js"

describe("S1 boundary guards", () => {
	it("accepts merged wire contracts and preserves unknown RF as null", () => {
		expect(guardSpectrumFrame(SCAN_FRAME)).toEqual(SCAN_FRAME)
		expect(guardSpectrumProfile(SCAN_PROFILE)).toEqual(SCAN_PROFILE)
		expect(
			guardScan("job", SCAN_JOB)?.identify?.targets[0]?.result?.measurements
				.peakDbfs,
		).toBeNull()
		expect(guardScan("discovery", SCAN_DISCOVERY)?.metadata.slots).toEqual([1])
		expect(guardScan("status", SCAN_STATUS)?.enabled).toBe(true)
	})
	it.each([
		{ bins: "%%%" },
		{ binCount: 255 },
		{ nativeBinHz: Infinity },
		{ binHz: 0 },
		{ binCount: 2049 },
		{ startHz: -1 },
		{ epoch: -1 },
		{ at: "never" },
		{ profile: "5:128" },
	])("rejects malformed frame %j before decoding", patch => {
		expect(guardSpectrumFrame({ ...SCAN_FRAME, ...patch })).toBeUndefined()
	})
	it("requires correct channel and bounded nested arrays", () => {
		expect(
			parseServerMessage({
				type: "spectrum:frame",
				channel: "scanner",
				data: SCAN_FRAME,
			}),
		).toBeUndefined()
		expect(
			guardScan("discoveries", {
				items: Array.from({ length: 51 }, () => SCAN_DISCOVERY),
				nextCursor: null,
			}),
		).toBeUndefined()
		expect(
			guardScan("job", { ...SCAN_JOB, name: "x".repeat(513) }),
		).toBeUndefined()
	})
	it("invalidates keyed discoveries including delete/merge, not durable append", () => {
		for (const change of ["deleted", "merged"])
			expect(
				parseScanEvent("scanner:discovery", {
					change,
					discovery: SCAN_DISCOVERY,
				}),
			).toEqual({ type: "scanner:invalidate", key: "discovery:disc1" })
		expect(
			parseScanEvent("scanner:progress", {
				jobId: "job1",
				state: "running",
				sweepIndex: 1,
				hopIndex: 2,
				hopCount: 4,
				centerHz: 1,
				coverage: 0.5,
				probes: [],
			}),
		).toBeUndefined()
	})
})

describe("Scan collection preflight", () => {
	function observed(length: number, value: unknown) {
		let reads = 0
		const values = Array.from({ length }, () => value)
		Object.defineProperty(values, 0, {
			get: () => {
				reads++
				return value
			},
			configurable: true,
		})
		return { values, reads: () => reads }
	}
	it("rejects oversized frame tracks and RF masks before accessing elements; accepts maxima", () => {
		const track = {
			startHz: 1,
			endHz: 2,
			flags: { burst: false, iqImage: false, edge: false },
		}
		for (const [key, maximum, value] of [
			["tracks", 256, track],
			["spurRanges", 128, { startHz: 1, endHz: 2 }],
		] as const) {
			const oversized = observed(maximum + 1, value)
			const wire =
				key === "tracks"
					? { ...SCAN_FRAME, tracks: oversized.values }
					: {
							...SCAN_FRAME,
							masks: { ...SCAN_FRAME.masks, spurRanges: oversized.values },
						}
			expect(guardSpectrumFrame(wire)).toBeUndefined()
			expect(oversized.reads()).toBe(0)
			const legal = observed(maximum, value)
			const valid =
				key === "tracks"
					? { ...SCAN_FRAME, tracks: legal.values }
					: {
							...SCAN_FRAME,
							masks: { ...SCAN_FRAME.masks, spurRanges: legal.values },
						}
			expect(guardSpectrumFrame(valid)).toBeDefined()
			expect(legal.reads()).toBeGreaterThan(0)
		}
	})
	it("rejects oversized top-level jobs and nested identify/result metadata before element parsing", () => {
		const jobs = observed(10001, SCAN_JOB)
		expect(guardScan("jobs", jobs.values)).toBeUndefined()
		expect(jobs.reads()).toBe(0)
		expect(
			guardScan(
				"jobs",
				Array.from({ length: 10000 }, () => ({
					...SCAN_JOB,
					identify: undefined,
				})),
			),
		).toHaveLength(10000)
		const target = SCAN_JOB.identify!.targets[0]!
		for (const [maximum, patch] of [
			[
				256,
				(values: unknown[]) => ({ ...SCAN_JOB, identify: { targets: values } }),
			],
			[
				128,
				(values: unknown[]) => ({
					...SCAN_JOB,
					identify: { targets: [{ ...target, trials: values }] },
				}),
			],
			[
				64,
				(values: unknown[]) => ({
					...SCAN_JOB,
					identify: {
						targets: [
							{
								...target,
								result: {
									...target.result!,
									metadata: { ...target.result!.metadata, talkgroups: values },
								},
							},
						],
					},
				}),
			],
		] as const) {
			const value =
				maximum === 256 ? target : maximum === 128 ? target.trials[0]! : "123"
			const oversized = observed(maximum + 1, value)
			expect(guardScan("job", patch(oversized.values))).toBeUndefined()
			expect(oversized.reads()).toBe(0)
			const legal = observed(maximum, value)
			expect(guardScan("job", patch(legal.values))).toBeDefined()
			expect(legal.reads()).toBeGreaterThan(0)
		}
	})
})
