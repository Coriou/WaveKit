/**
 * A call ended on a decoder whose dsd-fme directory is not indexed yet: the inventory re-derives
 * the dsd-fme directories even when the dv call recorder's directory is already indexed, so the
 * decoder's new call file becomes a key. Synthetic names only.
 */
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	createRecordingInventory,
	type RecordingDsdSourceConfig,
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
})
