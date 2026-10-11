import { describe, it, expect } from "vitest"
import {
	initialScan,
	selectScan,
	scanProfile,
	scanFrame,
	scanRead,
} from "../../../cli/source/data/scan-state.js"
import { guardScan } from "../../../cli/source/data/scanner-guards.js"
import {
	SCAN_FRAME,
	SCAN_PROFILE,
	SCAN_JOB,
} from "../../../cli/source/test/fixtures.js"

const ready = () => scanProfile(selectScan(initialScan(), "rtl"), SCAN_PROFILE)
describe("bounded source-selected spectrum history", () => {
	it("requires profile acknowledgement and ignores mismatching source/profile", () => {
		const negotiating = selectScan(initialScan(), "rtl")
		expect(scanFrame(negotiating, SCAN_FRAME, 1).rows).toHaveLength(0)
		expect(
			scanFrame(ready(), { ...SCAN_FRAME, sourceId: "other" }, 1).rows,
		).toHaveLength(0)
		expect(
			scanFrame(ready(), { ...SCAN_FRAME, profile: "10:512" }, 1).rows,
		).toHaveLength(0)
	})
	it("bounds bins/history and keeps snapshot as current state", () => {
		let s = ready()
		for (let i = 0; i < 1000; i++)
			s = scanFrame(
				s,
				{ ...SCAN_FRAME, ...(i === 0 ? { snapshot: true } : {}) },
				i,
			)
		expect(s.rows).toHaveLength(64)
		expect(s.rows.reduce((n, r) => n + r.bins.length, 0)).toBeLessThanOrEqual(
			128 * 1024,
		)
		expect(s.rows.every(r => r.frame.bins === "")).toBe(true)
	})
	it.each([
		{ epoch: 1 },
		{ startHz: 445000000 },
		{ binHz: 8000 },
		{ binCount: 128 },
		{ nativeBinHz: 800 },
		{ sampleRateHz: 1000000 },
	])("resets on layout/equality change %j", patch => {
		const s = scanFrame(
			scanFrame(ready(), SCAN_FRAME, 1),
			{ ...SCAN_FRAME, ...patch },
			2,
		)
		expect(s.rows).toHaveLength(1)
	})
	it("resets on every ack including rejection; does not relabel preserved old selection", () => {
		const s = scanProfile(scanFrame(ready(), SCAN_FRAME, 1), {
			...SCAN_PROFILE,
			outcome: "rejected",
			code: "SPECTRUM_SOURCE_NOT_IQ",
		})
		expect(s.rows).toHaveLength(0)
		expect(s.profile?.sourceId).toBe("rtl")
		expect(selectScan(s, "other").profile).toBeNull()
	})
	it("fatal REST status invalidates cache without inventing a profile notice", () => {
		const status = guardScan("spectrum", {
			defaultProfile: SCAN_PROFILE.profile,
			sources: [
				{
					sourceId: "rtl",
					eligible: true,
					engine: "error",
					tuningTrust: null,
					lastError: "worker stopped",
				},
			],
		})!
		const s = scanRead(
			scanFrame(ready(), SCAN_FRAME, 1),
			"spectrum",
			status,
			null,
			2,
		)
		expect(s.phase).toBe("error")
		expect(s.rows).toHaveLength(0)
		expect(s.profile).toBeNull()
	})
	it("reports omitted jobs instead of presenting a complete history", () => {
		const jobs = guardScan(
			"jobs",
			Array.from({ length: 220 }, (_, i) => ({ ...SCAN_JOB, id: `j${i}` })),
		)!
		const s = scanRead(ready(), "jobs", jobs, null, 1)
		expect(s.lanes.jobs.value).toHaveLength(200)
		expect(s.omittedJobs).toBe(20)
	})
})
