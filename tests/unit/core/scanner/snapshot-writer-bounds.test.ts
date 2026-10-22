/**
 * WG11 lane SC (review m2, m4): the worker heap limit scales with host memory within
 * [256 MiB, 2 GiB]; the commit timeout scales with the text size at 1 MiB/s within
 * [base, max(base, 10 min)].
 */
import { describe, expect, it } from "vitest"
import {
	DEFAULT_SNAPSHOT_COMMIT_TIMEOUT_MS,
	defaultSnapshotWorkerHeapMb,
	MAX_SNAPSHOT_COMMIT_TIMEOUT_MS,
	snapshotCommitTimeoutMs,
	snapshotWorkerTmp,
} from "../../../../src/core/scanner/store/snapshot-writer.js"

const MiB = 1024 * 1024
const GiB = 1024 * MiB

describe("snapshot worker heap limit (review m2)", () => {
	it("is a quarter of host memory, clamped to [256 MiB, 2 GiB]", () => {
		expect(defaultSnapshotWorkerHeapMb(1 * GiB)).toBe(256)
		expect(defaultSnapshotWorkerHeapMb(1 * GiB - 1)).toBe(256)
		expect(defaultSnapshotWorkerHeapMb(2 * GiB)).toBe(512)
		expect(defaultSnapshotWorkerHeapMb(4 * GiB)).toBe(1024)
		expect(defaultSnapshotWorkerHeapMb(8 * GiB)).toBe(2048)
		expect(defaultSnapshotWorkerHeapMb(8 * GiB + 4 * MiB)).toBe(2048)
		expect(defaultSnapshotWorkerHeapMb(8 * GiB - 4 * MiB)).toBe(2047)
		expect(defaultSnapshotWorkerHeapMb(64 * GiB)).toBe(2048)
		expect(defaultSnapshotWorkerHeapMb(Number.NaN)).toBe(256)
		const own = defaultSnapshotWorkerHeapMb()
		expect(own).toBeGreaterThanOrEqual(256)
		expect(own).toBeLessThanOrEqual(2048)
	})
})

describe("snapshot commit timeout (review m4)", () => {
	const base = DEFAULT_SNAPSHOT_COMMIT_TIMEOUT_MS
	it("is the base up to 60 MiB and one second per MiB past it", () => {
		expect(snapshotCommitTimeoutMs(base, 0)).toBe(60_000)
		expect(snapshotCommitTimeoutMs(base, 60 * MiB)).toBe(60_000)
		expect(snapshotCommitTimeoutMs(base, 60 * MiB + 1)).toBe(61_000)
		expect(snapshotCommitTimeoutMs(base, 200 * MiB)).toBe(200_000)
	})

	it("is capped at 10 minutes (600 MiB), and never below the base", () => {
		expect(snapshotCommitTimeoutMs(base, 600 * MiB)).toBe(600_000)
		expect(snapshotCommitTimeoutMs(base, 600 * MiB + 1)).toBe(
			MAX_SNAPSHOT_COMMIT_TIMEOUT_MS,
		)
		expect(snapshotCommitTimeoutMs(base, 1e12)).toBe(600_000)
		expect(snapshotCommitTimeoutMs(50, 10 * MiB)).toBe(10_000)
		expect(snapshotCommitTimeoutMs(900_000, 1e12)).toBe(900_000)
		expect(snapshotCommitTimeoutMs(base, Number.NaN)).toBe(60_000)
	})
})

describe("worker tmp name (review m3)", () => {
	it("is per commit and off the main thread's <file>.<pid>.tmp", () => {
		const a = snapshotWorkerTmp("/x/discoveries.json", 3)
		expect(a).toBe(`/x/discoveries.json.${process.pid}.worker-3.tmp`)
		expect(a).not.toBe(`/x/discoveries.json.${process.pid}.tmp`)
		expect(snapshotWorkerTmp("/x/discoveries.json", 4)).not.toBe(a)
	})
})
