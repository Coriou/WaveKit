/**
 * While a pre-migration backup is still linking recordings in (after the start), the evidence
 * store removes none: retention, a discovery's removal and one recording's delete wait for the
 * deletion gate (the scanner passes ScannerPersistence.backupPending). With nothing pending they
 * start as before.
 */
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const dirs: string[] = []
const logger = createLogger({ level: "fatal" })
const DAY_MS = 86_400_000
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

async function setup() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wavekit-gate-")))
	dirs.push(root)
	const now = Date.now()
	const store = new DiscoveryStore({
		maxDiscoveries: 10,
		now: () => now,
		newId: counterIds(),
	})
	const { discoveryId } = store.ingest(
		makeObs({ id: "o1", centreHz: 446_000_000, startedAt: now }),
	)
	if (!discoveryId) throw new Error("Missing test discovery")
	const folder = join(root, "recordings", "dv", discoveryId)
	await mkdir(folder, { recursive: true })
	const file = join(folder, "call.wav")
	await writeFile(file, Buffer.alloc(64))
	// Past the 30-day age: retention removes it once it may.
	const old = new Date(now - 60 * DAY_MS)
	await utimes(file, old, old)
	const evidence = new EvidenceStore({
		dir: root,
		caps: {
			maxRecordingsMb: 20,
			maxEvidenceMb: 1,
			maxAgeDays: 30,
			minFreeDiskMb: 1,
		},
		logger,
		now: () => now,
		statfs: async () => ({ freeBytes: 1e12 }),
		isDiscoveryLive: id => !!store.get(id),
	})
	return { evidence, file }
}

describe("deletions wait for a pending state backup", () => {
	it("retention removes nothing until the gate settles, then as before", async () => {
		const { evidence, file } = await setup()
		let open!: () => void
		const pending = new Promise<void>(resolve => {
			open = resolve
		})
		let settled = false
		evidence.setDeletionGate(() => (settled ? null : pending))
		const pass = evidence.retention(new Set())
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(existsSync(file)).toBe(true)
		settled = true
		open()
		const { deleted } = await pass
		expect(deleted).toHaveLength(1)
		expect(existsSync(file)).toBe(false)
	})

	it("a discovery's removal waits too", async () => {
		const { evidence, file } = await setup()
		let open!: () => void
		const pending = new Promise<void>(resolve => {
			open = resolve
		})
		evidence.setDeletionGate(() => pending)
		const discoveryId = file.split("/").at(-2)!
		const removal = evidence.removeDiscovery(discoveryId)
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(existsSync(file)).toBe(true)
		open()
		await removal
		expect(existsSync(file)).toBe(false)
	})
})
