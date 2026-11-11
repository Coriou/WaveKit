/**
 * Analog operation folders survive a crash at any step: creation publishes a folder only
 * complete (staging name, then rename), and a restart sets aside any incomplete folder an
 * older image left (bounded, counted in the scanner status) instead of refusing every
 * recording. Finalized recordings are never set aside, lost or quarantined.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	rename,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Writable } from "node:stream"
import fc from "fast-check"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	ANALOG_SET_ASIDE_MAX,
	type AnalogMetadataAdapter,
	type AnalogOperationIo,
	type AnalogReceipt,
	resetDirectorySyncWarning,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const dirs: string[] = []
const logger = createLogger({ level: "fatal" })
const NOW = 1_700_000_000_000
const caps = {
	maxRecordingsMb: 20,
	maxEvidenceMb: 1,
	maxAgeDays: 30,
	minFreeDiskMb: 1,
}
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

/** Throws at the armed step, then every later injected step throws too: a dead process. */
class Crash {
	steps = 0
	armedAt = -1
	dead = false
	step(): void {
		if (this.dead) throw new Error("crashed")
		if (this.steps++ === this.armedAt) {
			this.dead = true
			throw new Error("crash cut")
		}
	}
	io(): AnalogOperationIo {
		return {
			unlink: async path => {
				this.step()
				await unlink(path)
			},
			rmdir: async path => {
				this.step()
				await rmdir(path)
			},
			checkpoint: async () => {
				this.step()
			},
		}
	}
}

async function newRoot(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wavekit-aocs-")))
	dirs.push(root)
	return root
}
function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => NOW,
		newId: counterIds(),
	})
}
function adapterFor(
	store: DiscoveryStore,
	crash?: Crash,
): AnalogMetadataAdapter {
	const alive = (): void => {
		if (crash?.dead) throw new Error("crashed")
	}
	return {
		authorityHealthy: () => true,
		bindingLive: () => true,
		association: (d, o, historical) =>
			store.recordingAssociation(d, o, historical),
		prepare: async metadata => {
			alive()
			store.prepareRecording(metadata)
		},
		inverse: async id => {
			alive()
			store.removePreparedRecording(id)
		},
		buildCommitPlan: id => store.buildRecordingCommitPlan(id),
		commitPlanCurrent: plan => store.recordingCommitPlanCurrent(plan),
		publishCommit: plan => store.publishRecordingCommit(plan),
	}
}
const ENGINE = randomUUID()
const binding = (): RecordingBinding => ({
	sourceId: "src-1",
	engineInstanceId: ENGINE,
	stream: 1,
	epoch: 1,
	channelId: "opaque-native-grant",
	channelGeneration: 1,
	inputFormat: "cf32",
	inputSampleRateHz: 48000,
	groupDelayInputSamples: null,
	targetHz: 446_000_000,
	captureCentreHz: null,
	tuningTrust: "unverified",
})
/** One process lifetime on `root`; `store` stands for the journaled discovery state. */
async function start(root: string, store: DiscoveryStore, crash?: Crash) {
	const evidence = new EvidenceStore({
		dir: root,
		caps,
		logger,
		now: () => NOW,
		statfs: async () => ({ freeBytes: 1e9 }),
		isDiscoveryLive: id => !!store.get(id),
		...(crash ? { analogIo: crash.io() } : {}),
	})
	evidence.configureAnalog(adapterFor(store, crash))
	const reconciliation = await evidence.recoverAnalog()
	const discoveryId = store.list({}).items[0]!.id
	return {
		evidence,
		reconciliation,
		discoveryId,
		begin: () =>
			evidence.beginAnalog({
				discoveryId,
				observationId: "o1",
				binding: binding(),
			}),
	}
}
async function fresh() {
	const root = await newRoot()
	const store = newStore()
	store.ingest(makeObs({ id: "o1", centreHz: 446_000_000, startedAt: NOW }))
	return { root, store }
}
async function record(
	p: Awaited<ReturnType<typeof start>>,
): Promise<AnalogReceipt> {
	const op = p.begin()
	await op.ready
	await op.push(new Int16Array([1, -2, 3]))
	return op.finish()
}
function ops(root: string): string {
	return join(root, ".analog-operations")
}
/** Every path under root with its type and size (directories end with "/"). */
async function listing(root: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const names = (await readdir(dir)).sort()
		for (const name of names) {
			const path = join(dir, name)
			const info = await lstat(path)
			if (info.isDirectory()) {
				out.push(`${prefix}${name}/`)
				await walk(path, `${prefix}${name}/`)
			} else out.push(`${prefix}${name} ${info.size}`)
		}
	}
	await walk(root, "")
	return out
}

describe("analog operation crash safety: leftovers never poison the inventory", () => {
	it.each([
		["an empty operation folder", async (_dir: string) => undefined],
		[
			"an operation folder holding only a torn intent.tmp",
			async (dir: string) => writeFile(join(dir, "intent.tmp"), '{"vers'),
		],
		[
			"an operation folder holding an unparseable intent.json and no media",
			async (dir: string) => writeFile(join(dir, "intent.json"), "not json"),
		],
	])(
		"sets aside %s, keeps serving and admits new recordings",
		async (_label, fill) => {
			const { root, store } = await fresh()
			const first = await start(root, store)
			const kept = await record(first)
			expect(kept.outcome).toBe("finalized")
			const orphan = join(ops(root), randomUUID())
			await mkdir(orphan)
			await fill(orphan)

			const restarted = await start(root, store)
			expect(restarted.evidence.analogAuthorityReady).toBe(true)
			expect(restarted.evidence.analogQuarantine()).toEqual([])
			expect(restarted.evidence.recordingPath(kept.alias!)).not.toBeNull()
			expect(existsSync(orphan)).toBe(false)
			expect(restarted.evidence.analogOperationsStatus()).toMatchObject({
				setAside: 1,
			})
			const next = await record(restarted)
			expect(next.outcome).toBe("finalized")
			// The inventory answers (no "unknown inventory" refusal).
			await expect(
				restarted.evidence.hasAnalogCleanup(first.discoveryId),
			).resolves.toBe(true)
		},
	)
	it("sets aside a staging folder a crash left behind (only intent metadata, never media)", async () => {
		const { root, store } = await fresh()
		await start(root, store)
		const staging = join(ops(root), `.staging-${randomUUID()}`)
		await mkdir(staging, { recursive: true })
		await writeFile(join(staging, "intent.tmp"), "{}")
		const restarted = await start(root, store)
		expect(restarted.evidence.analogAuthorityReady).toBe(true)
		expect(existsSync(staging)).toBe(false)
		expect(restarted.evidence.analogOperationsStatus()).toEqual({
			setAside: 1,
			lastReason: "staging-residue",
		})
	})
	it("reports no block while nothing was set aside", async () => {
		const { root, store } = await fresh()
		const p = await start(root, store)
		await record(p)
		expect(p.evidence.analogOperationsStatus()).toBeNull()
	})
	it("keeps genuinely unsafe residue fail-closed (a symlink, unexplained media-bearing files)", async () => {
		const { root, store } = await fresh()
		await start(root, store)
		const target = await newRoot()
		await symlink(target, join(ops(root), randomUUID()))
		const restarted = await start(root, store)
		expect(restarted.evidence.analogAuthorityReady).toBe(false)

		const other = await fresh()
		await start(other.root, other.store)
		const partial = join(ops(other.root), randomUUID())
		await mkdir(partial)
		await writeFile(join(partial, "payload.wav.part"), "x")
		const again = await start(other.root, other.store)
		expect(again.evidence.analogAuthorityReady).toBe(false)
		expect(existsSync(join(partial, "payload.wav.part"))).toBe(true)
	})
	it("never sets aside an unparseable intent whose media may exist", async () => {
		const { root, store } = await fresh()
		const p = await start(root, store)
		const kept = await record(p)
		const dir = join(ops(root), kept.operationId)
		// The receipt proves a finalized file: an unreadable intent beside it is not crash residue.
		await writeFile(join(dir, "intent.json"), "corrupt")
		const restarted = await start(root, store)
		expect(existsSync(join(dir, "receipt.json"))).toBe(true)
		expect(existsSync(join(root, kept.artifact!))).toBe(true)
		expect(restarted.evidence.analogOperationsStatus()).toBeNull()

		// No receipt yet, but the media file exists: left in place, fail closed.
		const other = await fresh()
		const q = await start(other.root, other.store)
		const r = await record(q)
		const odir = join(ops(other.root), r.operationId)
		await unlink(join(odir, "receipt.json"))
		await writeFile(join(odir, "intent.json"), "corrupt")
		const again = await start(other.root, other.store)
		expect(again.evidence.analogAuthorityReady).toBe(false)
		expect(existsSync(join(other.root, r.artifact!))).toBe(true)
		expect(existsSync(odir)).toBe(true)
	})
	it(`bounds the set-aside folder at ANALOG_SET_ASIDE_MAX (${ANALOG_SET_ASIDE_MAX}), oldest first out`, async () => {
		const { root, store } = await fresh()
		await start(root, store)
		const make = async (n: number): Promise<void> => {
			for (let i = 0; i < n; i++) await mkdir(join(ops(root), randomUUID()))
		}
		// At the bound: everything kept.
		await make(ANALOG_SET_ASIDE_MAX)
		const at = await start(root, store)
		expect(at.evidence.analogOperationsStatus()?.setAside).toBe(
			ANALOG_SET_ASIDE_MAX,
		)
		const held = (await readdir(join(ops(root), ".set-aside"))).sort()
		expect(held).toHaveLength(ANALOG_SET_ASIDE_MAX)
		// Past the bound: the oldest entries go.
		await make(3)
		const past = await start(root, store)
		expect(past.evidence.analogAuthorityReady).toBe(true)
		expect(past.evidence.analogOperationsStatus()?.setAside).toBe(
			ANALOG_SET_ASIDE_MAX,
		)
		const after = (await readdir(join(ops(root), ".set-aside"))).sort()
		expect(after).toHaveLength(ANALOG_SET_ASIDE_MAX)
		for (const name of held.slice(0, 3)) expect(after).not.toContain(name)
	})
	it("keeps and counts set-aside entries that cannot be proven media-free, even past the bound", async () => {
		const { root, store } = await fresh()
		await start(root, store)
		const held: string[] = []
		for (let i = 0; i <= ANALOG_SET_ASIDE_MAX; i++) {
			const name = `${String(1000 + i).padStart(13, "0")}-${randomUUID()}`
			const entry = join(ops(root), ".set-aside", name)
			await mkdir(entry, { recursive: true })
			// A file no intent folder holds: possibly media, never deleted.
			await writeFile(join(entry, "other.bin"), "x")
			held.push(name)
		}
		const restarted = await start(root, store)
		expect(restarted.evidence.analogAuthorityReady).toBe(true)
		expect(restarted.evidence.analogOperationsStatus()?.setAside).toBe(
			ANALOG_SET_ASIDE_MAX + 1,
		)
		expect((await readdir(join(ops(root), ".set-aside"))).sort()).toEqual(held)
	})
	it("evicts a half-evicted set-aside entry (one file or every file already gone)", async () => {
		const { root, store } = await fresh()
		await start(root, store)
		const names: string[] = []
		for (let i = 0; i < ANALOG_SET_ASIDE_MAX + 2; i++) {
			const name = `${String(1000 + i).padStart(13, "0")}-${randomUUID()}`
			const entry = join(ops(root), ".set-aside", name)
			await mkdir(entry, { recursive: true })
			// The oldest lost intent.tmp, the next lost both files (a crash mid-eviction).
			if (i !== 1) await writeFile(join(entry, "intent.json"), "{}")
			if (i > 1) await writeFile(join(entry, "intent.tmp"), "{")
			names.push(name)
		}
		const restarted = await start(root, store)
		expect(restarted.evidence.analogAuthorityReady).toBe(true)
		expect(restarted.evidence.analogOperationsStatus()?.setAside).toBe(
			ANALOG_SET_ASIDE_MAX,
		)
		expect((await readdir(join(ops(root), ".set-aside"))).sort()).toEqual(
			names.slice(2),
		)
	})
	it("keeps an unparseable intent fail closed when recordings/analog has more folders than the search bound", async () => {
		const { root, store } = await fresh()
		const p = await start(root, store)
		await record(p)
		const analog = join(root, "recordings", "analog")
		const existing = (await readdir(analog)).length
		// One past MAX_RECOVERY_OPERATIONS (4096): empty folders are cheap.
		const extra: string[] = []
		for (let i = existing; i <= 4096; i++) {
			const folder = join(analog, `f${i}`)
			await mkdir(folder)
			extra.push(folder)
		}
		expect((await readdir(analog)).length).toBe(4097)
		const orphan = join(ops(root), randomUUID())
		await mkdir(orphan)
		await writeFile(join(orphan, "intent.json"), "not json")
		const over = await start(root, store)
		expect(over.evidence.analogAuthorityReady).toBe(false)
		expect(existsSync(join(orphan, "intent.json"))).toBe(true)
		expect(over.evidence.analogOperationsStatus()).toBeNull()
		// At the bound the search completes and the residue is set aside.
		await rmdir(extra[extra.length - 1]!)
		const at = await start(root, store)
		expect(at.evidence.analogAuthorityReady).toBe(true)
		expect(existsSync(orphan)).toBe(false)
		expect(at.evidence.analogOperationsStatus()).toEqual({
			setAside: 1,
			lastReason: "invalid-intent",
		})
	}, 60_000)
	it("a staging folder removed between the listing and its check does not refuse another admission", async () => {
		const { root, store } = await fresh()
		await start(root, store)
		let vanish: string | null = null
		const evidence = new EvidenceStore({
			dir: root,
			caps,
			logger,
			now: () => NOW,
			statfs: async () => ({ freeBytes: 1e9 }),
			isDiscoveryLive: id => !!store.get(id),
			analogIo: {
				unlink: path => unlink(path),
				rmdir: path => rmdir(path),
				checkpoint: async name => {
					// A concurrent cleanupStaging finishing right after the admission scan listed.
					if (name !== "inventory-listed" || !vanish) return
					const dir = vanish
					vanish = null
					await unlink(join(dir, "intent.tmp"))
					await rmdir(dir)
				},
			},
		})
		evidence.configureAnalog(adapterFor(store))
		await evidence.recoverAnalog()
		expect(evidence.analogAuthorityReady).toBe(true)
		const staging = join(ops(root), `.staging-${randomUUID()}`)
		await mkdir(staging)
		await writeFile(join(staging, "intent.tmp"), "{")
		vanish = staging
		const op = evidence.beginAnalog({
			discoveryId: store.list({}).items[0]!.id,
			observationId: "o1",
			binding: binding(),
		})
		await op.ready
		await op.push(new Int16Array([1, -2, 3]))
		const receipt = await op.finish()
		expect(vanish).toBeNull()
		expect(existsSync(staging)).toBe(false)
		expect(receipt.outcome).toBe("finalized")
		expect(evidence.analogAuthorityReady).toBe(true)
	})
	it("a second restart changes nothing on disk", async () => {
		const { root, store } = await fresh()
		const p = await start(root, store)
		await record(p)
		await mkdir(join(ops(root), randomUUID()))
		await start(root, store)
		const once = await listing(root)
		await start(root, store)
		expect(await listing(root)).toEqual(once)
	})
})

/** One process lifetime on `root` whose directory renames go through `rename`. */
async function startRenaming(
	root: string,
	store: DiscoveryStore,
	renameDir: (from: string, to: string) => Promise<void>,
) {
	const evidence = new EvidenceStore({
		dir: root,
		caps,
		logger,
		now: () => NOW,
		statfs: async () => ({ freeBytes: 1e9 }),
		isDiscoveryLive: id => !!store.get(id),
		analogIo: {
			unlink: path => unlink(path),
			rmdir: path => rmdir(path),
			rename: renameDir,
			checkpoint: async () => undefined,
		},
	})
	evidence.configureAnalog(adapterFor(store))
	const reconciliation = await evidence.recoverAnalog()
	const discoveryId = store.list({}).items[0]!.id
	return {
		evidence,
		reconciliation,
		discoveryId,
		begin: () =>
			evidence.beginAnalog({
				discoveryId,
				observationId: "o1",
				binding: binding(),
			}),
	}
}

describe("analog operation crash safety: residue proofs and failed renames", () => {
	it("never sets aside an operation folder without intent.json whose media exists", async () => {
		const { root, store } = await fresh()
		const p = await start(root, store)
		const kept = await record(p)
		const id = randomUUID()
		const orphan = join(ops(root), id)
		await mkdir(orphan)
		// The media an older image's operation may have left beside the finalized one.
		const media = join(dirname(join(root, kept.artifact!)), `analog-${id}.wav`)
		await writeFile(media, "RIFF")
		const restarted = await start(root, store)
		expect(restarted.evidence.analogAuthorityReady).toBe(false)
		expect(existsSync(orphan)).toBe(true)
		expect(existsSync(media)).toBe(true)
		expect(restarted.evidence.analogOperationsStatus()).toBeNull()
	})
	it("measures hard-linked intent files once (a crash at intent-linked)", async () => {
		const { root, store } = await fresh()
		await start(root, store)
		const staging = join(ops(root), `.staging-${randomUUID()}`)
		await mkdir(staging)
		// Between 8 and 16 KiB: within the bound once, past it if counted twice.
		await writeFile(join(staging, "intent.tmp"), "x".repeat(12 * 1024))
		await link(join(staging, "intent.tmp"), join(staging, "intent.json"))
		const restarted = await start(root, store)
		expect(restarted.evidence.analogAuthorityReady).toBe(true)
		expect(existsSync(staging)).toBe(false)
		expect(restarted.evidence.analogOperationsStatus()).toEqual({
			setAside: 1,
			lastReason: "staging-residue",
		})
	})
	it("a failed set-aside move leaves the residue in place, never poisons, and a later scan moves it", async () => {
		const { root, store } = await fresh()
		const kept = await record(await start(root, store))
		const orphan = join(ops(root), randomUUID())
		await mkdir(orphan)
		let refused = 0
		const failing = await startRenaming(root, store, async (from, to) => {
			if (to.includes(".set-aside")) {
				refused++
				throw new Error("rename refused")
			}
			await rename(from, to)
		})
		expect(refused).toBeGreaterThanOrEqual(1)
		expect(failing.evidence.analogAuthorityReady).toBe(true)
		expect(existsSync(orphan)).toBe(true)
		expect(failing.evidence.analogOperationsStatus()).toBeNull()
		expect(failing.evidence.recordingPath(kept.alias!)).not.toBeNull()
		const next = await record(failing)
		expect(next.outcome).toBe("finalized")
		await failing.evidence.stopAnalog()

		const restarted = await start(root, store)
		expect(restarted.evidence.analogAuthorityReady).toBe(true)
		expect(existsSync(orphan)).toBe(false)
		expect(restarted.evidence.analogOperationsStatus()).toEqual({
			setAside: 1,
			lastReason: "missing-intent",
		})
	})
	it("a failed staging publication cleans its staging folder, refuses that recording only, and the next one is admitted", async () => {
		const { root, store } = await fresh()
		let failNext = true
		const life = await startRenaming(root, store, async (from, to) => {
			if (failNext && from.includes(".staging-")) {
				failNext = false
				throw new Error("rename refused")
			}
			await rename(from, to)
		})
		const op = life.begin()
		await op.ready.catch(() => undefined)
		await op.push(new Int16Array([1, -2, 3])).catch(() => undefined)
		const refused = await op.finish()
		await op.settled
		expect(failNext).toBe(false)
		expect(refused.outcome).not.toBe("finalized")
		const left = (await readdir(ops(root))).filter(
			name => name.startsWith(".staging-") || name === refused.operationId,
		)
		expect(left).toEqual([])
		expect(life.evidence.analogAuthorityReady).toBe(true)
		const next = await record(life)
		expect(next.outcome).toBe("finalized")
		expect(life.evidence.recordingPath(next.alias!)).not.toBeNull()
	})
})

describe("analog operation crash safety: honest status", () => {
	it("the scanner status carries analogOperations, the scanner keeps serving (no 503)", async () => {
		const dir = await newRoot()
		const orphan = randomUUID()
		// The harness's scanner storage dir is `dir` itself.
		await mkdir(join(ops(dir), orphan), { recursive: true })
		const h = serviceHarness({
			dir,
			patch: settings => {
				settings.passive.enabled = false
			},
		})
		await h.service.start()
		try {
			const ev = (h.service as unknown as { evidence: EvidenceStore }).evidence
			expect(ev.analogAuthorityReady).toBe(true)
			expect(h.service.status().analogOperations).toEqual({
				setAside: 1,
				lastReason: "missing-intent",
			})
			// An analog recording id is answered (null: not found), not refused as unavailable.
			expect(
				h.service.recordingPath(`d_1~analog-${randomUUID()}.wav`),
			).toBeNull()
		} finally {
			await h.service.stop()
		}
		const clean = serviceHarness({
			dir: await newRoot(),
			patch: settings => {
				settings.passive.enabled = false
			},
		})
		await clean.service.start()
		try {
			expect(clean.service.status()).not.toHaveProperty("analogOperations")
		} finally {
			await clean.service.stop()
		}
	})
	it("logs one line per scan that set something aside, counts only (no names)", async () => {
		const { root, store } = await fresh()
		await start(root, store)
		const orphan = randomUUID()
		await mkdir(join(ops(root), orphan))
		const lines: string[] = []
		const sink = new Writable({
			write(chunk: Buffer, _encoding, done) {
				lines.push(chunk.toString())
				done()
			},
		})
		const evidence = new EvidenceStore({
			dir: root,
			caps,
			logger: pino({ level: "warn" }, sink),
			now: () => NOW,
			statfs: async () => ({ freeBytes: 1e9 }),
			isDiscoveryLive: id => !!store.get(id),
		})
		evidence.configureAnalog(adapterFor(store))
		await evidence.recoverAnalog()
		const setAside = lines.filter(line => line.includes("Set aside"))
		expect(setAside).toHaveLength(1)
		expect(JSON.parse(setAside[0]!)).toMatchObject({
			moved: 1,
			evicted: 0,
			held: 1,
		})
		expect(setAside[0]).not.toContain(orphan)
	})
})

describe("analog operation crash safety: a crash at any step", () => {
	type Action = "record" | "cancel" | "delete"
	async function run(
		actions: readonly Action[],
		crashAt: number,
	): Promise<{ steps: number }> {
		const { root, store } = await fresh()
		const crash = new Crash()
		crash.armedAt = crashAt
		const life = await start(root, store, crash)
		const finalized: AnalogReceipt[] = []
		let deleted = false
		for (const action of actions) {
			if (crash.dead) break
			if (action === "delete") {
				deleted = true
				store.delete(life.discoveryId)
				await life.evidence
					.removeDiscovery(life.discoveryId)
					.catch(() => undefined)
				// Deletion removed the discovery: a later recording has no owner; stop here.
				break
			}
			const op = life.begin()
			await op.ready.catch(() => undefined)
			if (action === "cancel") op.cancel()
			else await op.push(new Int16Array([1, 2, 3])).catch(() => undefined)
			const receipt = await op.finish()
			await op.settled
			if (receipt.outcome === "finalized") finalized.push(receipt)
		}
		if (deleted)
			store.ingest(makeObs({ id: "o1", centreHz: 446_000_000, startedAt: NOW }))

		// Restart: a fresh owner on the same directory.
		const restarted = await start(root, store)
		expect(
			restarted.evidence.analogAuthorityReady,
			`crash at step ${crashAt} of ${actions.join(",")}: ${(await listing(root)).join(" | ")}`,
		).toBe(true)
		const quarantined = restarted.evidence.analogQuarantine()
		// A deletion the user asked for removed the owner: its files are kept with no owner
		// (owner-unresolved) until the delete completes, by design. Every other one is served.
		for (const receipt of deleted ? [] : finalized) {
			expect(
				quarantined.map(q => q.operationId),
				`crash at step ${crashAt} of ${actions.join(",")}: ${JSON.stringify(quarantined)}`,
			).not.toContain(receipt.operationId)
			expect(existsSync(join(root, receipt.artifact!))).toBe(true)
			expect(restarted.evidence.recordingPath(receipt.alias!)).not.toBeNull()
		}
		const next = await record(restarted)
		expect(next.outcome).toBe("finalized")
		await restarted.evidence.stopAnalog()
		const once = await listing(root)
		const second = await start(root, store)
		expect(second.evidence.analogAuthorityReady).toBe(true)
		expect(await listing(root)).toEqual(once)
		return { steps: crash.steps }
	}

	it("restarts clean after a crash at every step of record, cancel and delete", async () => {
		// Count the steps of an uncrashed run, then crash at each one in turn.
		// Creation, finalize, a cancel's cleanup and a delete's cleanup, every step of each.
		const sequence: Action[] = ["record", "cancel", "delete"]
		const { steps } = await run(sequence, -1)
		expect(steps).toBeGreaterThan(10)
		for (let at = 0; at < steps; at++) await run(sequence, at)
	}, 240_000)

	it("restarts clean after a crash at every step of a recovery scan setting residue aside", async () => {
		const seeded = async () => {
			const { root, store } = await fresh()
			const kept = await record(await start(root, store))
			// Past the bound, so the scan both moves and evicts.
			for (let i = 0; i < ANALOG_SET_ASIDE_MAX; i++)
				await mkdir(
					join(
						ops(root),
						".set-aside",
						`${String(1000 + i).padStart(13, "0")}-${randomUUID()}`,
					),
					{
						recursive: true,
					},
				)
			await mkdir(join(ops(root), randomUUID()))
			const staging = join(ops(root), `.staging-${randomUUID()}`)
			await mkdir(staging)
			await writeFile(join(staging, "intent.tmp"), "{")
			return { root, store, kept }
		}
		const count = await seeded()
		const crash = new Crash()
		await start(count.root, count.store, crash)
		expect(crash.steps).toBeGreaterThan(2)
		for (let at = 0; at < crash.steps; at++) {
			const { root, store, kept } = await seeded()
			const dying = new Crash()
			dying.armedAt = at
			await start(root, store, dying).catch(() => undefined)
			const restarted = await start(root, store)
			expect(restarted.evidence.analogAuthorityReady).toBe(true)
			expect(restarted.evidence.recordingPath(kept.alias!)).not.toBeNull()
			expect(restarted.evidence.analogOperationsStatus()?.setAside).toBe(
				ANALOG_SET_ASIDE_MAX,
			)
			const once = await listing(root)
			await start(root, store)
			expect(await listing(root)).toEqual(once)
		}
	}, 120_000)

	it("property: any sequence, any crash point, restart loses nothing and never poisons", async () => {
		// Feature: analog-operations-crash-safety, Property 1: crash at any step restarts clean
		// Validates: Requirements 1, 2, 4
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.constantFrom<Action>("record", "cancel", "delete"), {
					minLength: 1,
					maxLength: 4,
				}),
				fc.nat({ max: 80 }),
				async (actions, crashAt) => {
					await run(actions, crashAt)
				},
			),
			{ numRuns: 100 },
		)
	}, 300_000)
})

/** One process lifetime on `root` with an injected analog io and an optional log sink. */
async function startWithIo(
	root: string,
	store: DiscoveryStore,
	io: AnalogOperationIo,
	lines?: string[],
) {
	const sink = new Writable({
		write(chunk: Buffer, _encoding, done) {
			lines?.push(chunk.toString())
			done()
		},
	})
	const evidence = new EvidenceStore({
		dir: root,
		caps,
		logger: lines ? pino({ level: "warn" }, sink) : logger,
		now: () => NOW,
		statfs: async () => ({ freeBytes: 1e9 }),
		isDiscoveryLive: id => !!store.get(id),
		analogIo: io,
	})
	evidence.configureAnalog(adapterFor(store))
	const reconciliation = await evidence.recoverAnalog()
	const discoveryId = store.list({}).items[0]!.id
	return {
		evidence,
		reconciliation,
		discoveryId,
		begin: () =>
			evidence.beginAnalog({
				discoveryId,
				observationId: "o1",
				binding: binding(),
			}),
	}
}
function codedError(code: string): Error {
	return Object.assign(new Error(`fsync ${code}`), { code })
}

describe("analog operation crash safety: directory fsync and repeated residue searches", () => {
	afterEach(() => resetDirectorySyncWarning())
	it("a tolerated directory fsync refusal (EPERM) admits and finalizes, warning once without paths", async () => {
		resetDirectorySyncWarning()
		const { root, store } = await fresh()
		const lines: string[] = []
		let syncs = 0
		const life = await startWithIo(
			root,
			store,
			{
				unlink: path => unlink(path),
				fsyncDir: async () => {
					syncs++
					throw codedError("EPERM")
				},
				checkpoint: async () => undefined,
			},
			lines,
		)
		const first = await record(life)
		const second = await record(life)
		expect(first.outcome).toBe("finalized")
		expect(second.outcome).toBe("finalized")
		expect(life.evidence.recordingPath(second.alias!)).not.toBeNull()
		expect(syncs).toBeGreaterThanOrEqual(4)
		const warned = lines.filter(line => line.includes("Directory fsync"))
		expect(warned).toHaveLength(1)
		expect(JSON.parse(warned[0]!)).toMatchObject({
			code: "EPERM",
			kind: "staging",
		})
		expect(warned[0]).not.toContain(root)
	})
	it("a directory fsync failure outside the tolerated set (EIO) refuses the recording", async () => {
		const { root, store } = await fresh()
		const life = await startWithIo(root, store, {
			unlink: path => unlink(path),
			fsyncDir: async () => {
				throw codedError("EIO")
			},
			checkpoint: async () => undefined,
		})
		const op = life.begin()
		await expect(op.ready).rejects.toThrow()
		await op.push(new Int16Array([1, -2, 3])).catch(() => undefined)
		const refused = await op.finish()
		await op.settled
		expect(refused.outcome).not.toBe("finalized")
	})
	it("a residue whose set-aside move keeps failing is searched for media once while the folder count holds", async () => {
		const { root, store } = await fresh()
		await record(await start(root, store))
		const id = randomUUID()
		await mkdir(join(ops(root), id))
		const probe = `analog-${id}.wav`
		let probes = 0
		let refused = 0
		const life = await startWithIo(root, store, {
			unlink: path => unlink(path),
			rmdir: path => rmdir(path),
			rename: async (from, to) => {
				if (to.includes(".set-aside")) {
					refused++
					throw new Error("rename refused")
				}
				await rename(from, to)
			},
			mediaLstat: async path => {
				if (path.endsWith(probe)) probes++
				return lstat(path)
			},
			checkpoint: async () => undefined,
		})
		// Start, then each admission's and settlement's scan: one folder searched once.
		expect((await record(life)).outcome).toBe("finalized")
		expect((await record(life)).outcome).toBe("finalized")
		expect(refused).toBeGreaterThanOrEqual(3)
		expect(probes).toBe(1)
		// A new analog folder may hold the media: the next scan searches again (two folders).
		await mkdir(join(root, "recordings", "analog", "d_new"))
		const before = refused
		expect((await record(life)).outcome).toBe("finalized")
		expect(refused).toBeGreaterThan(before)
		expect(probes).toBe(3)
		expect(existsSync(join(ops(root), id))).toBe(true)
	})
})
