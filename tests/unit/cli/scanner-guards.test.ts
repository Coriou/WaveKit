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
