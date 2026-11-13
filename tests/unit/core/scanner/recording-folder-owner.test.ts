/**
 * Requirement 3: a recording keeps the folder of the discovery it was made under; once that
 * discovery is merged into another, every recording DTO resolves the folder's owner through the
 * merge aliases (recordingFolderDiscovery), so it carries the live owner's frequency (and the
 * title clients derive from it, "<MHz> MHz" instead of the generic "Scanner recording").
 * Real DiscoveryStore merges, real recordings inventory over an mkdtemp tree.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { recordingFolderDiscovery } from "../../../../src/core/scanner/recording-aliases.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { StoreSnapshot } from "../../../../src/core/scanner/store/discovery-store.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const PMR = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const quiet = createLogger({ level: "fatal" })

const dmrObs = (id: string, centreHz: number, startedAt: number) =>
	makeObs({
		id,
		centreHz,
		startedAt,
		cls: "fsk4-12k5",
		hypotheses: [["dmr", 0.8]],
	})

function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
		logger: quiet,
	})
}

/** S (first heard) and D (3.5 kHz up, later) merge once a 3 kHz correction lands: D into S. */
function mergedPair(store: DiscoveryStore): {
	survivor: string
	dropped: string
} {
	const survivor = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
	const dropped =
		store.ingest(dmrObs("o2", CH + 3_500, T0 + 1_000)).discoveryId ?? ""
	expect(store.rekey("src-1", 3_000)).toEqual({ merged: [[survivor, dropped]] })
	return { survivor, dropped }
}

/** `from`'s record and observations copied under `id`, first heard at `firstSeen`. */
function cloneInto(
	s: StoreSnapshot,
	from: string,
	id: string,
	firstSeen: number,
): StoreSnapshot {
	const d = s.discoveries.find(x => x.id === from)
	if (!d) throw new Error("no source discovery")
	const at = new Date(firstSeen).toISOString()
	const obs = s.observations
		.filter(o => o.discoveryId === from)
		.map((o, i) => ({
			...structuredClone(o),
			id: `${id}-o${i}`,
			discoveryId: id,
		}))
	return {
		...s,
		discoveries: [
			...s.discoveries,
			{ ...structuredClone(d), id, firstSeenAt: at, lastSeenAt: at },
		],
		observations: [...s.observations, ...obs],
	}
}

const roots: string[] = []
afterEach(async () => {
	for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

function wav(dataBytes: number): Buffer {
	const b = Buffer.alloc(44 + dataBytes)
	b.write("RIFF", 0, "ascii")
	b.writeUInt32LE(36 + dataBytes, 4)
	b.write("WAVEfmt ", 8, "ascii")
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(1, 22)
	b.writeUInt32LE(8000, 24)
	b.writeUInt32LE(16000, 28)
	b.writeUInt16LE(2, 32)
	b.writeUInt16LE(16, 34)
	b.write("data", 36, "ascii")
	b.writeUInt32LE(dataBytes, 40)
	return b
}

describe("recordingFolderDiscovery: a folder's live owner through merge aliases", () => {
	it("a live discovery's own folder resolves to itself", () => {
		const store = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		expect(recordingFolderDiscovery(store, id)?.id).toBe(id)
	})

	it("A merged into B: A's folder carries B's id and frequency", () => {
		const store = newStore()
		const { survivor, dropped } = mergedPair(store)
		expect(store.get(dropped)).toBeUndefined()
		const owner = recordingFolderDiscovery(store, dropped)
		expect(owner?.id).toBe(survivor)
		expect(owner?.frequencyHz).toBe(store.get(survivor)?.frequencyHz)
	})

	it("a chain A into B, B into C: A's and B's folders both resolve to C", () => {
		const first = newStore()
		const { survivor: bId, dropped: aId } = mergedPair(first)
		const store = newStore()
		store.restore(cloneInto(first.snapshot(), bId, "d_C", T0 - 60_000))
		expect(store.rekey("src-1", 3_000).merged).toEqual([["d_C", bId]])
		for (const folder of [aId, bId]) {
			const owner = recordingFolderDiscovery(store, folder)
			expect(owner?.id).toBe("d_C")
			expect(owner?.frequencyHz).toBe(store.get("d_C")?.frequencyHz)
		}
	})

	it("a deleted owner or an unknown folder resolves to nothing (no throw)", () => {
		const store = newStore()
		const { survivor, dropped } = mergedPair(store)
		expect(store.delete(survivor)).toBe(true)
		expect(recordingFolderDiscovery(store, dropped)).toBeUndefined()
		expect(recordingFolderDiscovery(store, survivor)).toBeUndefined()
		expect(recordingFolderDiscovery(store, "d_NEVER")).toBeUndefined()
	})

	it("a throwing lookup resolves to nothing", () => {
		const throwing = {
			folderOwner: (): string | undefined => {
				throw new Error("boom")
			},
			get: (): { frequencyHz: number } | undefined => ({ frequencyHz: 1 }),
		}
		expect(recordingFolderDiscovery(throwing, "d_X")).toBeUndefined()
	})
})

describe("GET /api/recordings items resolve the folder's owner (inventory wiring)", () => {
	it("A merged into B: A's recording lists B's frequency; a deleted owner lists null", async () => {
		const store = newStore()
		const { survivor, dropped } = mergedPair(store)
		const other = newStore()
		const gone = mergedPair(other)
		expect(other.delete(gone.survivor)).toBe(true)

		const root = await mkdtemp(join(tmpdir(), "wk-rec-owner-"))
		roots.push(root)
		const scan = join(root, "scan")
		for (const id of [dropped, survivor]) {
			await mkdir(join(scan, "analog", id), { recursive: true })
			await writeFile(join(scan, "analog", id, "a-1.wav"), wav(16_000))
		}
		await mkdir(join(scan, "analog", "d_ORPHAN"), { recursive: true })
		await writeFile(join(scan, "analog", "d_ORPHAN", "a-1.wav"), wav(16_000))

		const centre = (id: string): number | null =>
			(id === "d_ORPHAN"
				? recordingFolderDiscovery(other, gone.dropped)
				: recordingFolderDiscovery(store, id)
			)?.frequencyHz ?? null
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [],
			scannerRecordingsDir: () => scan,
			discoveryCentreHz: centre,
			now: () => Date.now() + 60_000,
			logger: quiet,
		})
		const page = await inv.list({})
		const freq = (folder: string): number | null | undefined =>
			page.items.find(i => i.id === `scan:${folder}~a-1.wav`)?.frequencyHz
		const owner = store.get(survivor)?.frequencyHz
		expect(owner).toBeGreaterThan(0)
		expect(freq(dropped)).toBe(owner)
		expect(freq(survivor)).toBe(owner)
		// The folder id stays the item's discoveryId (keep keys and deletes name the folder).
		expect(
			page.items.find(i => i.id === `scan:${dropped}~a-1.wav`)?.discoveryId,
		).toBe(dropped)
		expect(freq("d_ORPHAN")).toBeNull()
	})
})
