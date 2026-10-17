// WG10 req 1.6: a capacity eviction removes the evicted discovery's folders (and its aliases)
// as an inactive prune does, and keeps skipping a discovery that holds kept recordings.
import { afterEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ScannerService } from "../../../../src/core/scanner/scanner-service.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { Discovery } from "../../../../src/core/scanner/types.js"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import { aliasAwareProtection } from "../../../../src/core/scanner/recording-aliases.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const dirs: string[] = []
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

interface Internals {
	store: DiscoveryStore
	evidence: EvidenceStore
	background: Set<Promise<void>>
	storageDir: string
}

const obs = (id: string, i: number) =>
	makeObs({
		id,
		centreHz: CH + i * 100_000,
		startedAt: T0 + i * 1_000,
		blocks: 2,
	})

describe("capacity eviction removes evicted evidence (WG10 req 1.6)", () => {
	it("emits deleted, removes the evicted folders and leaves the survivors'", async () => {
		const h = serviceHarness({
			patch: s => {
				s.storage.maxDiscoveries = 2
			},
		})
		dirs.push(h.dir)
		await h.service.start()
		const internals = h.service as unknown as Internals
		const deleted: Discovery[] = []
		;(h.service as ScannerService).on(
			"discovery",
			(e: { change: string; discovery: Discovery }) => {
				if (e.change === "deleted") deleted.push(e.discovery)
			},
		)
		const a = internals.store.ingest(obs("o1", 0)).discoveryId ?? ""
		const b = internals.store.ingest(obs("o2", 1)).discoveryId ?? ""
		const folders = [a, b].map(id =>
			join(internals.storageDir, "recordings", "dv", id),
		)
		for (const f of folders) {
			await mkdir(f, { recursive: true })
			await writeFile(join(f, "x.wav"), "x")
		}
		await mkdir(join(internals.storageDir, "evidence", a), { recursive: true })
		await writeFile(join(internals.storageDir, "evidence", a, "psd.json"), "{}")
		const c = internals.store.ingest(obs("o3", 2)).discoveryId ?? ""
		expect(c).not.toBe("")
		expect(deleted.map(d => d.id)).toEqual([a])
		await Promise.all([...internals.background])
		expect(existsSync(folders[0] ?? "")).toBe(false)
		expect(existsSync(join(internals.storageDir, "evidence", a))).toBe(false)
		expect(existsSync(folders[1] ?? "")).toBe(true)
		await h.service.stop()
	})
})

describe("eviction skips kept holders, aliases included (WG9 2.6, WG10 req 1.5)", () => {
	it("a discovery whose alias folder holds a kept key is never the victim", () => {
		const kept = new Set<string>()
		const port: RecordingProtection = {
			isProtected: () => false,
			isDsdFmeFileProtected: () => false,
			isScannerFileProtected: (d, n) => kept.has(`${d}/${n}`),
			discoveryHoldsKept: d => [...kept].some(k => k.startsWith(`${d}/`)),
		}
		let store: DiscoveryStore | null = null
		const aware = aliasAwareProtection(port, id => store?.aliasesOf(id) ?? [])
		store = new DiscoveryStore({
			maxDiscoveries: 2,
			now: () => T0,
			newId: counterIds(),
			discoveryHoldsKept: id => aware.discoveryHoldsKept(id),
		})
		const evicted: string[][] = []
		store.on("evicted", (ds: Discovery[]) => evicted.push(ds.map(d => d.id)))
		const a = store.ingest(obs("o1", 0)).discoveryId ?? ""
		const b = store.ingest(obs("o2", 1)).discoveryId ?? ""
		// a is the natural victim (oldest); its kept alias folder protects it
		store.restore({
			...store.snapshot(),
			aliases: [{ id: a, aliases: ["d_ALIAS"] }],
		})
		kept.add("d_ALIAS/k.wav")
		store.ingest(obs("o3", 2))
		expect(evicted).toEqual([[b]])
		expect(store.get(a)).toBeDefined()
	})
})
