/**
 * A discovery removal decides per file, in the same turn as each unlink: a listing by another
 * live discovery, or a folder mark (the ownership table was full), that lands while the removal
 * is already under way keeps the file. Nothing captured before an await authorises an unlink.
 *
 * The interleave is driven deterministically: the first filesystem call that touches the
 * removed discovery's recording folder runs the interleaving step synchronously before the call
 * proceeds (digital), or the analog adapter's inverse runs it (analog). No timers.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import type * as FsPromisesModule from "node:fs/promises"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import type { AnalogMetadataAdapter } from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { StoreSnapshot } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../../src/core/scanner/store/evidence-store.js"
import { HELD_RECORDINGS_MAX } from "../../../../src/core/scanner/store/held-recordings.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

type FsPromises = typeof FsPromisesModule

/** One-shot hook: the first fs call on `dir` (or below it) runs `step` before it proceeds. */
const gate = vi.hoisted(() => ({
	dir: null as string | null,
	step: null as (() => void) | null,
}))

vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<FsPromises>()
	const gated =
		<A extends unknown[], R>(fn: (...args: A) => R) =>
		(...args: A): R => {
			const path = args[0]
			const dir = gate.dir
			if (
				gate.step !== null &&
				dir !== null &&
				typeof path === "string" &&
				(path === dir || path.startsWith(`${dir}/`))
			) {
				const step = gate.step
				gate.step = null
				step()
			}
			return fn(...args)
		}
	const wrapped = {
		lstat: gated(actual.lstat),
		stat: gated(actual.stat),
		readdir: gated(actual.readdir),
		rm: gated(actual.rm),
		rmdir: gated(actual.rmdir),
		unlink: gated(actual.unlink),
		realpath: gated(actual.realpath),
		open: gated(actual.open),
	}
	return { ...actual, ...wrapped, default: { ...actual, ...wrapped } }
})

const logger = createLogger({ level: "fatal" })
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const BASE_HZ = 430_000_000
const CAPS: StorageCaps = {
	maxRecordingsMb: 20,
	maxEvidenceMb: 20,
	maxAgeDays: 30,
	minFreeDiskMb: 0,
}
const dirs: string[] = []

afterEach(async () => {
	gate.dir = null
	gate.step = null
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

const keepsNothing: RecordingProtection = {
	isProtected: () => false,
	isDsdFmeFileProtected: () => false,
	isScannerFileProtected: () => false,
	discoveryHoldsKept: () => false,
}

async function tempRoot(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wavekit-recheck-")))
	dirs.push(root)
	return root
}

function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 1_000,
		now: () => T0,
		newId: counterIds(),
		logger,
	})
}

function bindingOf(hz: number): RecordingBinding {
	return {
		sourceId: "src-1",
		engineInstanceId: randomUUID(),
		stream: 1,
		epoch: 1,
		channelId: "opaque",
		channelGeneration: 1,
		inputFormat: "cf32",
		inputSampleRateHz: 48000,
		groupDelayInputSamples: null,
		targetHz: hz,
		captureCentreHz: null,
		tuningTrust: "commanded",
	}
}

function evidenceFor(
	root: string,
	store: () => DiscoveryStore,
	protection: RecordingProtection | undefined,
	hooks: { onInverse?: (() => void) | undefined } = {},
): EvidenceStore {
	const ev = new EvidenceStore({
		dir: root,
		caps: CAPS,
		logger,
		now: () => T0,
		statfs: async () => ({ freeBytes: 1e12 }),
		isDiscoveryLive: id => store().get(id) !== undefined,
		aliases: {
			aliasOwner: id => store().aliasOwner(id),
			aliasesOf: id => store().aliasesOf(id),
			releaseAliases: id => store().releaseAliases(id),
			heldFileNames: (id, removing) => store().heldFileNames(id, removing),
			heldRecordingOwner: id => store().heldRecordingOwner(id),
			heldFolderUnknown: id => store().heldFolderUnknown(id),
		},
		...(protection ? { protection } : {}),
	})
	store().setFolderLookup(id => ev.folders.holds(id))
	const adapter: AnalogMetadataAdapter = {
		authorityHealthy: () => true,
		bindingLive: () => true,
		association: (d, o, b) => store().recordingAssociation(d, o, b),
		prepare: async metadata => {
			store().prepareRecording(metadata)
		},
		inverse: async id => {
			const step = hooks.onInverse
			hooks.onInverse = undefined
			step?.()
			store().removePreparedRecording(id)
		},
		buildCommitPlan: id => store().buildRecordingCommitPlan(id),
		commitPlanCurrent: plan => store().recordingCommitPlanCurrent(plan),
		publishCommit: plan => store().publishRecordingCommit(plan),
	}
	ev.configureAnalog(adapter)
	return ev
}

function ingest(store: DiscoveryStore, n: number): string {
	const id =
		store.ingest(
			makeObs({
				id: `o${n}`,
				centreHz: BASE_HZ + n * 100_000,
				startedAt: T0 + n * 1_000,
				cls: "analog-fm",
				open: false,
				gate: "passed",
			}),
		).discoveryId ?? ""
	expect(id).not.toBe("")
	return id
}

async function writeWav(root: string, folderId: string, name: string) {
	const dir = join(root, "recordings", "dv", folderId)
	await mkdir(dir, { recursive: true })
	const path = join(dir, name)
	await writeFile(path, Buffer.alloc(4096))
	return path
}

/**
 * A owns `call.wav` (listed by its own observation o1); B is live with a file of its own.
 * `fullTable`: the restored ownership table is already full, so B's later listing of A's file
 * marks A's folder instead of recording an entry.
 */
async function scene(
	protection: RecordingProtection | undefined,
	fullTable: boolean,
) {
	const root = await tempRoot()
	const first = newStore()
	const a = ingest(first, 1)
	const b = ingest(first, 2)
	const callPath = await writeWav(root, a, "call.wav")
	await writeWav(root, b, "call.wav")
	first.attachRecordings("o1", [`${a}~call.wav`], "linked")
	first.attachRecordings("o2", [`${b}~call.wav`], "linked")
	let store = first
	if (fullTable) {
		const snapshot: StoreSnapshot = {
			...first.snapshot(),
			heldRecordings: Array.from({ length: HELD_RECORDINGS_MAX }, (_, i) => ({
				id: `d_F${i}~f${i}.wav`,
				ownerId: b,
				observationId: `oh${i}`,
			})),
		}
		store = newStore()
		store.restore(snapshot)
	}
	const ev = evidenceFor(root, () => store, protection)
	await ev.loadFolderIndex()
	return { root, store, ev, a, b, callPath }
}

for (const [mode, protection] of [
	["unguarded", undefined],
	["guarded", keepsNothing],
] as const)
	for (const fullTable of [false, true])
		describe(`${mode}, ${fullTable ? "full table (folder mark)" : "ordinary listing"}`, () => {
			it("a listing landing after the removal began keeps the file and its folder", async () => {
				const s = await scene(protection, fullTable)
				expect(s.store.delete(s.a)).toBe(true)
				expect(s.store.heldRecordingOwner(`${s.a}~call.wav`)).toBeUndefined()
				// The removal is under way (its first touch of A's folder) when B lists A's file.
				gate.dir = join(s.root, "recordings", "dv", s.a)
				gate.step = () => {
					expect(
						s.store.attachRecordings("o2", [`${s.a}~call.wav`], "linked"),
					).toBe(true)
				}
				await s.ev.removeDiscovery(s.a)
				expect(gate.step).toBeNull()
				if (fullTable) expect(s.store.heldFolderUnknown(s.a)).toBe(true)
				else expect(s.store.heldRecordingOwner(`${s.a}~call.wav`)).toBe(s.b)
				expect(existsSync(s.callPath)).toBe(true)
				expect(s.ev.recordingPath(`${s.a}~call.wav`)).toBe(
					fullTable ? null : s.callPath,
				)
			})

			it("without the interleave the same removal deletes the file and the folder", async () => {
				const s = await scene(protection, fullTable)
				expect(s.store.delete(s.a)).toBe(true)
				await s.ev.removeDiscovery(s.a)
				expect(existsSync(s.callPath)).toBe(false)
				expect(existsSync(join(s.root, "recordings", "dv", s.a))).toBe(false)
			})
		})

describe("the analog delete path", () => {
	async function analogScene(protection: RecordingProtection | undefined) {
		const root = await tempRoot()
		const store = newStore()
		const hooks: { onInverse?: (() => void) | undefined } = {}
		const ev = evidenceFor(root, () => store, protection, hooks)
		await ev.recoverAnalog()
		const a = ingest(store, 1)
		const b = ingest(store, 2)
		const op = ev.beginAnalog({
			discoveryId: a,
			observationId: "o1",
			binding: bindingOf(BASE_HZ + 100_000),
		})
		await op.ready
		await op.push(new Int16Array([1, -2, 3, -4]))
		const receipt = await op.finish()
		expect(receipt.outcome).toBe("finalized")
		const artifact = receipt.artifact ?? ""
		const name = artifact.split("/").at(-1) ?? ""
		return { root, store, ev, hooks, a, b, file: join(root, artifact), name }
	}

	for (const [mode, protection] of [
		["unguarded", undefined],
		["guarded", keepsNothing],
	] as const) {
		it(`${mode}: B listing A's analog file after the owned set was taken keeps it`, async () => {
			const s = await analogScene(protection)
			expect(existsSync(s.file)).toBe(true)
			expect(s.store.delete(s.a)).toBe(true)
			// After the analog delete chose its owned files, before the media unlink.
			s.hooks.onInverse = () => {
				expect(
					s.store.attachRecordings("o2", [`${s.a}~${s.name}`], "linked"),
				).toBe(true)
			}
			await s.ev.removeDiscovery(s.a)
			expect(s.hooks.onInverse).toBeUndefined()
			expect(s.store.heldRecordingOwner(`${s.a}~${s.name}`)).toBe(s.b)
			expect(existsSync(s.file)).toBe(true)
		})

		it(`${mode}: without the interleave A's own analog file goes`, async () => {
			const s = await analogScene(protection)
			expect(s.store.delete(s.a)).toBe(true)
			await s.ev.removeDiscovery(s.a)
			expect(existsSync(s.file)).toBe(false)
		})
	}
})
