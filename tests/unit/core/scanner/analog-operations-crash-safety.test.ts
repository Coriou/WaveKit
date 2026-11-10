/**
 * Analog operation folders survive a crash at any step: creation publishes a folder only
 * complete (staging name, then rename), and a restart sets aside any incomplete folder an
 * older image left (bounded, counted in the scanner status) instead of refusing every
 * recording. Finalized recordings are never set aside, lost or quarantined.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import fc from "fast-check"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	ANALOG_SET_ASIDE_MAX,
	type AnalogMetadataAdapter,
	type AnalogOperationIo,
	type AnalogReceipt,
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
