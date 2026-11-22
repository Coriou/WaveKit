/**
 * A call ended on a decoder whose dsd-fme directory is not indexed yet: the inventory re-derives
 * the dsd-fme directories even when the dv call recorder's directory is already indexed, so the
 * decoder's new call file becomes a key. Synthetic names only.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	createRecordingInventory,
	nodeRecordingFs,
	type RecordingDsdSourceConfig,
	type RecordingFsPort,
} from "../../../../src/core/recordings/inventory.js"

const logger = pino({ level: "silent" })
const NAME = "20261012_100000_12345_P25_1A3_GROUP_TGT_9_SRC_1.wav"
const roots: string[] = []
const closers: (() => void)[] = []
afterEach(async () => {
	for (const c of closers.splice(0)) c()
	await Promise.all(
		roots.splice(0).map(r => rm(r, { recursive: true, force: true })),
	)
})

async function dir(prefix: string): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), prefix))
	roots.push(d)
	return d
}

describe("recordings inventory: call refresh with a dv-call directory indexed", () => {
	it("re-derives a decoder's dsd-fme directory that is not indexed yet", async () => {
		const dv = await dir("wk-inv-dv-")
		const calls = await dir("wk-inv-dsd-")
		const sources: RecordingDsdSourceConfig[] = [
			{ decoderId: "dv", dir: dv, kind: "dv-call" },
		]
		const inv = createRecordingInventory({
			dsdFmeDirs: () => sources,
			scannerRecordingsDir: () => null,
			logger,
		})
		closers.push(() => inv.close?.())
		await inv.start?.()
		expect(inv.hasKey?.(`dsd~${NAME}`)).toBe(false)
		// The decoder's directory appears with its first call, then the call ends.
		const file = join(calls, NAME)
		await writeFile(file, Buffer.alloc(64))
		const old = (Date.now() - 60_000) / 1000
		await utimes(file, old, old)
		sources.push({ decoderId: "dsd-b", dir: calls })
		await inv.touchCallRecordings?.("dsd-b")
		expect(inv.hasKey?.(`dsd~${NAME}`)).toBe(true)
	})

	it("repeated call ends of a decoder without a dsd-fme directory never re-walk scanner folders", async () => {
		const dv = await dir("wk-inv-dv-")
		const scanner = await dir("wk-inv-scan-")
		const folder = join(scanner, "dv", "d_abc1")
		await mkdir(folder, { recursive: true })
		await writeFile(join(folder, "20261012_100000_rec.wav"), Buffer.alloc(64))
		let scannerTouches = 0
		const touched = (p: string): void => {
			if (p.startsWith(scanner)) scannerTouches++
		}
		const fs: RecordingFsPort = {
			...nodeRecordingFs,
			opendir: d => {
				touched(d)
				return nodeRecordingFs.opendir(d)
			},
			lstat: p => {
				touched(p)
				return nodeRecordingFs.lstat(p)
			},
			stat: p => {
				touched(p)
				return nodeRecordingFs.stat(p)
			},
		}
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [{ decoderId: "dv", dir: dv, kind: "dv-call" }],
			scannerRecordingsDir: () => scanner,
			reconcileIntervalMs: 3_600_000,
			logger,
			fs,
		})
		closers.push(() => inv.close?.())
		await inv.start?.()
		expect(scannerTouches).toBeGreaterThan(0)
		scannerTouches = 0
		// A DMR-mode dsd-fme decoder has no dsd-fme directory: each call end re-derives only
		// the dsd sources.
		for (let i = 0; i < 5; i++) await inv.touchCallRecordings?.("dmr-a")
		expect(scannerTouches).toBe(0)
	})
})
