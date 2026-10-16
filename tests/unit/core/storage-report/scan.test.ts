import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { StorageAreaSource } from "../../../../src/core/storage-report/contract.js"
import {
	DEFAULT_STORAGE_SCAN_LIMITS,
	scanStorageAreas,
} from "../../../../src/core/storage-report/scan.js"
import { createFakeFs } from "./fake-fs.js"
import type { FakeNode } from "./fake-fs.js"

const area = (
	id: StorageAreaSource["id"],
	paths: string[],
	exclude?: string[],
): StorageAreaSource => ({
	id,
	paths,
	capBytes: null,
	...(exclude ? { exclude } : {}),
})

/** A chain /r/d1/d2/.../dN/f with f a 10-byte file at depth n+1. */
function chain(n: number): Record<string, FakeNode> {
	const nodes: Record<string, FakeNode> = { "/r": { kind: "dir" } }
	let p = "/r"
	for (let i = 1; i <= n; i++) {
		p = `${p}/d${i}`
		nodes[p] = { kind: "dir" }
	}
	nodes[`${p}/f`] = { kind: "file", size: 10 }
	return nodes
}

describe("scanStorageAreas (real fs)", () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "wavekit-scan-"))
	})
	afterEach(async () => {
		await chmod(path.join(dir, "locked"), 0o755).catch(() => undefined)
		await rm(dir, { recursive: true, force: true })
	})

	it("reports a missing root as absent without a reason", async () => {
		const [scan] = await scanStorageAreas([
			area("logs", [path.join(dir, "nope")]),
		])
		expect(scan).toEqual({
			id: "logs",
			bytes: 0,
			files: 0,
			exists: false,
			partialReason: null,
		})
	})

	it("counts files and a symlink loop without following it", async () => {
		await mkdir(path.join(dir, "a"))
		await writeFile(path.join(dir, "a", "x.bin"), Buffer.alloc(100))
		await writeFile(path.join(dir, "top.txt"), "hello")
		await symlink(dir, path.join(dir, "a", "loop"))
		const [scan] = await scanStorageAreas([area("logs", [dir])])
		expect(scan?.exists).toBe(true)
		expect(scan?.partialReason).toBeNull()
		expect(scan?.files).toBe(3)
		expect(scan?.bytes).toBeGreaterThanOrEqual(105)
	})

	it("reports permission for an unreadable subdirectory", async ({ skip }) => {
		if (process.getuid?.() === 0) skip()
		await mkdir(path.join(dir, "locked"))
		await writeFile(path.join(dir, "ok"), "12")
		await chmod(path.join(dir, "locked"), 0o000)
		const [scan] = await scanStorageAreas([area("logs", [dir])])
		expect(scan).toMatchObject({
			exists: true,
			files: 1,
			bytes: 2,
			partialReason: "permission",
		})
	})

	it("skips excluded paths", async () => {
		await mkdir(path.join(dir, "sub"))
		await writeFile(path.join(dir, "sub", "big"), Buffer.alloc(50))
		await writeFile(path.join(dir, "small"), "1")
		const [scan] = await scanStorageAreas([
			area("operator-data", [dir], [path.join(dir, "x", "..", "sub")]),
		])
		expect(scan).toMatchObject({ files: 1, bytes: 1, partialReason: null })
	})
})

describe("scanStorageAreas (fake fs)", () => {
	it("uses the contract defaults", () => {
		expect(DEFAULT_STORAGE_SCAN_LIMITS).toEqual({
			maxEntries: 50_000,
			maxDepth: 16,
			maxWallMs: 2_000,
			concurrency: 8,
		})
	})

	it("ignores an entry that vanishes mid-scan", async () => {
		const fs = createFakeFs(
			{
				"/r": { kind: "dir" },
				"/r/gone": { kind: "file", size: 5 },
				"/r/k": { kind: "file", size: 7 },
			},
			{ lstatErrors: { "/r/gone": "ENOENT" }, readdirErrors: {} },
		)
		const [scan] = await scanStorageAreas([area("logs", ["/r"])], { fs })
		expect(scan).toMatchObject({
			exists: true,
			files: 1,
			bytes: 7,
			partialReason: null,
		})
	})

	it("ignores sockets and does not count directory sizes", async () => {
		const fs = createFakeFs({
			"/r": { kind: "dir" },
			"/r/s": { kind: "other" },
			"/r/d": { kind: "dir" },
		})
		const [scan] = await scanStorageAreas([area("logs", ["/r"])], { fs })
		expect(scan).toMatchObject({
			exists: true,
			files: 0,
			bytes: 0,
			partialReason: null,
		})
	})

	it("reports io-error for other errno and keeps scanning other areas", async () => {
		const fs = createFakeFs(
			{
				"/r": { kind: "dir" },
				"/r/a": { kind: "file", size: 1 },
				"/s": { kind: "file", size: 3 },
			},
			{ readdirErrors: { "/r": "EIO" } },
		)
		const scans = await scanStorageAreas(
			[area("logs", ["/r"]), area("station", ["/s"])],
			{ fs },
		)
		expect(scans[0]).toMatchObject({ exists: true, partialReason: "io-error" })
		expect(scans[1]).toMatchObject({
			exists: true,
			files: 1,
			bytes: 3,
			partialReason: null,
		})
	})

	it("treats an area as existing when any path exists", async () => {
		const fs = createFakeFs({ "/b": { kind: "file", size: 4 } })
		const [scan] = await scanStorageAreas(
			[area("digital-voice-wav", ["/a", "/b"])],
			{ fs },
		)
		expect(scan).toMatchObject({
			exists: true,
			files: 1,
			bytes: 4,
			partialReason: null,
		})
	})

	it("allows exactly maxDepth and flags maxDepth + 1", async () => {
		// chain(2): file at depth 3
		const fs = createFakeFs(chain(2))
		const ok = await scanStorageAreas([area("logs", ["/r"])], {
			fs,
			limits: { maxDepth: 3 },
		})
		expect(ok[0]).toMatchObject({ files: 1, bytes: 10, partialReason: null })
		const over = await scanStorageAreas([area("logs", ["/r"])], {
			fs,
			limits: { maxDepth: 2 },
		})
		expect(over[0]).toMatchObject({ files: 0, partialReason: "depth-limit" })
	})

	it("allows exactly maxEntries and flags one more", async () => {
		const fs = createFakeFs(chain(2)) // 4 lstats
		const ok = await scanStorageAreas([area("logs", ["/r"])], {
			fs,
			limits: { maxEntries: 4 },
		})
		expect(ok[0]).toMatchObject({ files: 1, partialReason: null })
		const over = await scanStorageAreas([area("logs", ["/r"])], {
			fs,
			limits: { maxEntries: 3 },
		})
		expect(over[0]).toMatchObject({ files: 0, partialReason: "entry-limit" })
	})

	it("marks the current and all later areas when a bound is reached", async () => {
		const fs = createFakeFs({
			...chain(2),
			"/s": { kind: "file", size: 1 },
			"/t": { kind: "file", size: 1 },
		})
		const scans = await scanStorageAreas(
			[area("logs", ["/t"]), area("station", ["/r"]), area("access", ["/s"])],
			{ fs, limits: { maxEntries: 3 } },
		)
		expect(scans.map(s => s.id)).toEqual(["logs", "station", "access"])
		expect(scans[0]).toMatchObject({ files: 1, partialReason: null })
		expect(scans[1]).toMatchObject({ partialReason: "entry-limit" })
		expect(scans[2]).toEqual({
			id: "access",
			bytes: 0,
			files: 0,
			exists: false,
			partialReason: "entry-limit",
		})
		expect(fs.lstatCalls).not.toContain("/s")
	})

	it("stops at the wall limit with a fake clock", async () => {
		let t = 1_000
		const fs = createFakeFs(
			{ ...chain(5), "/s": { kind: "file", size: 1 } },
			{
				onCall: () => {
					t += 10
				},
			},
		)
		const scans = await scanStorageAreas(
			[area("logs", ["/r"]), area("station", ["/s"])],
			{
				fs,
				now: () => t,
				limits: { maxWallMs: 25 },
			},
		)
		expect(scans[0]?.partialReason).toBe("time-limit")
		expect(scans[1]).toMatchObject({
			exists: false,
			partialReason: "time-limit",
		})
	})

	it("never exceeds the concurrency limit", async () => {
		const nodes: Record<string, FakeNode> = { "/r": { kind: "dir" } }
		for (let i = 0; i < 20; i++) {
			nodes[`/r/d${i}`] = { kind: "dir" }
			for (let j = 0; j < 5; j++)
				nodes[`/r/d${i}/f${j}`] = { kind: "file", size: 1 }
		}
		const fs = createFakeFs(nodes, { delayTicks: 2 })
		const [scan] = await scanStorageAreas([area("logs", ["/r"])], {
			fs,
			limits: { concurrency: 3 },
		})
		expect(scan).toMatchObject({ files: 100, bytes: 100, partialReason: null })
		expect(fs.maxInFlight).toBeLessThanOrEqual(3)
		expect(fs.maxInFlight).toBeGreaterThan(1)
	})
})
