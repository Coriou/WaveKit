/**
 * The recordings catalogue kept current by its writers, through the production wiring: a real
 * ScannerService (its DiscoveryStore events), the real keep service (Keep and delete through
 * invalidate(id)), wireRecordingCatalogue and the inventory over an mkdtemp tree (the merge is
 * computed in a store with a channel raster, then published through the service's store). Each change
 * shows in the list without a rescan: the scanner kind folders are listed only by the first
 * build, never again.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordingInventoryItem } from "@wavekit/api-types"
import { wireRecordingCatalogue } from "../../../../src/core/recordings/catalogue-wiring.js"
import {
	createRecordingInventory,
	nodeRecordingFs,
} from "../../../../src/core/recordings/inventory.js"
import type { RecordingFsPort } from "../../../../src/core/recordings/inventory.js"
import { openRecordingKeepService } from "../../../../src/core/recordings/keep-service.js"
import type { RecordingKeepService } from "../../../../src/core/recordings/contract.js"
import { lateBoundRecordingProtection } from "../../../../src/core/recordings/late-bound-protection.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const quiet = createLogger({ level: "fatal" })
const CALL = "20261016_120000_01234_YSF_1_GROUP_TGT_100_SRC_2001.wav"

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

/** A settled recording (modified a minute ago). */
async function put(p: string): Promise<void> {
	await mkdir(join(p, ".."), { recursive: true })
	await writeFile(p, wav(16_000))
	const t = (Date.now() - 60_000) / 1000
	await utimes(p, t, t)
}

const roots: string[] = []
const stops: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const s of stops.splice(0).reverse()) await s()
	for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

describe("recordings catalogue writers (production wiring)", () => {
	it("a finalize, a Keep, a delete and a merge each change the list without a rescan", async () => {
		const root = await mkdtemp(join(tmpdir(), "wk-rec-wiring-"))
		roots.push(root)
		const scan = join(root, "scan")
		const dsd = join(root, "dsd")

		const h = serviceHarness()
		await h.service.start()
		stops.push(() => h.service.stop())
		const scanner = h.service
		const store = (scanner as unknown as { store: DiscoveryStore }).store
		// Two discoveries 3.5 kHz apart on a 12.5 kHz raster, built in a store with the raster
		// (the harness store has none) and restored into the service's store.
		const CH = 446_006_250
		const own = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => Date.now(),
			newId: counterIds(),
			rasters: () => [{ spacingHz: 12_500, firstChannelHz: CH }],
			logger: quiet,
		})
		const dmr = (id: string, centreHz: number, startedAt: number) =>
			makeObs({
				id,
				centreHz,
				startedAt,
				cls: "fsk4-12k5",
				hypotheses: [["dmr", 0.8]],
			})
		const a = own.ingest(dmr("o1", CH, Date.now() - 5_000)).discoveryId ?? ""
		const b =
			own.ingest(dmr("o2", CH + 3_500, Date.now() - 4_000)).discoveryId ?? ""
		expect(a).not.toBe("")
		expect(b).not.toBe(a)
		store.restore(own.snapshot())

		await put(join(dsd, CALL))
		await put(join(scan, "analog", b, "analog-1.wav"))

		// Counts every directory listing, to prove no change below is a rescan.
		const listed: string[] = []
		const fs: RecordingFsPort = {
			...nodeRecordingFs,
			opendir: dir => {
				listed.push(dir)
				return nodeRecordingFs.opendir(dir)
			},
		}
		let keeps: RecordingKeepService | undefined
		const inventory = createRecordingInventory({
			dsdFmeDirs: () => [{ decoderId: "dsd-a", dir: dsd }],
			scannerRecordingsDir: () => scan,
			// The production lambdas in src/index.ts.
			discoveryCentreHz: id =>
				scanner.recordingFolderDiscovery(id)?.frequencyHz ?? null,
			discoveryOwner: id => {
				const owner = scanner.recordingFolderDiscovery(id)
				return owner ? { id: owner.id, frequencyHz: owner.frequencyHz } : null
			},
			protection: lateBoundRecordingProtection(() => keeps),
			logger: quiet,
			fs,
		})
		stops.push(() => inventory.close?.())
		const opened = await openRecordingKeepService({
			stateDir: root,
			inventory,
			logger: quiet,
		})
		keeps = opened
		stops.push(() => opened.close())
		stops.push(wireRecordingCatalogue({ inventory, scanner }))
		await inventory.start?.()

		const items = async (): Promise<RecordingInventoryItem[]> =>
			(await inventory.list({})).items
		const ids = async (): Promise<string[]> => (await items()).map(i => i.id)
		expect((await ids()).sort()).toEqual(
			[`dsd:0~${CALL}`, `scan:${b}~analog-1.wav`].sort(),
		)
		const kindListings = (): number =>
			listed.filter(d => d === join(scan, "dv") || d === join(scan, "analog"))
				.length
		const builtListings = kindListings()
		expect(builtListings).toBe(1) // analog only: dv does not exist yet

		// 1. Finalize: the file lands, the scanner attaches it to its observation (the event).
		await put(join(scan, "dv", a, "call-1.wav"))
		expect(store.attachRecordings("o1", [`${a}~call-1.wav`], "linked")).toBe(
			true,
		)
		await vi.waitFor(
			async () => expect(await ids()).toContain(`scan:${a}~call-1.wav`),
			{ timeout: 5_000 },
		)

		// 2. Keep: the next listing shows it kept.
		const rev = (await inventory.list({})).revision ?? 0
		await opened.keep(`scan:${a}~call-1.wav`)
		const afterKeep = await inventory.list({})
		expect(afterKeep.revision).toBeGreaterThan(rev)
		expect(
			afterKeep.items.find(i => i.id === `scan:${a}~call-1.wav`)?.kept,
		).toBe(true)

		// 3. Delete: gone from the very next listing.
		await opened.remove(`dsd:0~${CALL}`)
		expect(await ids()).not.toContain(`dsd:0~${CALL}`)

		// 4. Merge: b's folder now belongs to a (its frequency follows the owner).
		const before = (await items()).find(i => i.discoveryId === b)
		expect(before?.ownerDiscoveryId).toBe(b)
		const revBefore = (await inventory.list({})).revision ?? 0
		// a 3 kHz source correction brings b onto a's channel: b merges into a (first heard). The
		// merged state goes into the service's store, which publishes the merge as it does live.
		expect(own.rekey("src-1", 3_000)).toEqual({ merged: [[a, b]] })
		store.restore(own.snapshot())
		store.emit("change", a, "merged", [b])
		await vi.waitFor(
			async () =>
				expect(
					(await items()).find(i => i.discoveryId === b)?.ownerDiscoveryId,
				).toBe(a),
			{ timeout: 5_000 },
		)
		expect((await inventory.list({})).revision).toBeGreaterThan(revBefore)
		expect((await items()).find(i => i.discoveryId === b)?.frequencyHz).toBe(
			store.get(a)?.frequencyHz,
		)

		// Not one of these was a rescan.
		expect(kindListings()).toBe(builtListings)
	})
})

describe("scanner retention tells the catalogue which folders it emptied", () => {
	it("emits recordings-removed with the folder ids of the files retention deleted", async () => {
		const h = serviceHarness({ patch: st => void (st.passive.enabled = false) })
		await h.service.start()
		stops.push(() => h.service.stop())
		const internal = h.service as unknown as {
			maintenance(): Promise<void>
			evidence: {
				retention(keep: ReadonlySet<string>): Promise<{ deleted: string[] }>
			}
		}
		vi.spyOn(internal.evidence, "retention").mockResolvedValue({
			deleted: [
				"recordings/dv/d_A/call.wav",
				"recordings/analog/d_B/analog-1.wav",
				"psd/d_C/psd.json",
			],
		})
		const removed: string[][] = []
		h.service.on("recordings-removed", (ids: string[]) => removed.push(ids))
		await internal.maintenance()
		// start runs a maintenance pass too: every pass reports the same folders
		expect(removed.length).toBeGreaterThan(0)
		for (const ids of removed) expect(ids).toEqual(["d_A", "d_B"])
	})
})
