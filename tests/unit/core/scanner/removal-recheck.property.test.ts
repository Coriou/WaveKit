/**
 * Randomised interleavings of the scanner's recording lifecycle against one invariant: no delete
 * path reaches a file another live discovery lists, and a folder that is marked (its ownership
 * is unknown) or whose owner cannot be resolved keeps every recording file in it.
 *
 * Real DiscoveryStore, EvidenceStore (with its analog operations) and ScannerPersistence over a
 * temporary root. Steps: record (digital and analog, in the discovery's own folder or listed by
 * another), co-channel split, merge, overflow mark, discovery delete, inactive prune (with the
 * ownership table's prune), capacity eviction, retention (age and quota), restart (snapshot or
 * not, journal replay, optionally a torn last line).
 *
 * Async steps interleave deterministically: a scheduler counts the filesystem calls an async step
 * makes and runs a synchronous step (a listing, a mark, a merge, a store delete) when the n-th
 * one settles, before its caller resumes (an await point); no timers. The folder mark is the evidence store's lookup answer (the same as a
 * full ownership table's, which held-recordings-bounds covers with 65,536 real entries).
 *
 * Seeds: fast-check prints the seed and the shrunk counterexample on failure; replay with
 * `fc.assert(..., { seed, path })`.
 */
import { randomUUID } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import type * as FsPromisesModule from "node:fs/promises"
import {
	appendFile,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterAll, describe, expect, it, vi } from "vitest"
import type { AnalogMetadataAdapter } from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../../src/core/scanner/store/evidence-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { Discovery } from "../../../../src/core/scanner/types.js"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

type FsPromises = typeof FsPromisesModule

/** The scheduler: while armed, `step` runs when the `at`-th filesystem call settles. */
const sched = vi.hoisted(() => ({
	count: 0,
	at: -1,
	step: null as (() => void) | null,
}))

vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<FsPromises>()
	const gated =
		<A extends unknown[], R>(fn: (...args: A) => R) =>
		(...args: A): R => {
			const result = fn(...args)
			if (sched.step === null || sched.count++ !== sched.at) return result
			const step = sched.step
			sched.step = null
			// At the await point: after the call settled, before its caller resumes (never between
			// a caller's synchronous check and the call it guards).
			return Promise.resolve(result).then(
				value => {
					step()
					return value
				},
				(err: unknown) => {
					step()
					throw err
				},
			) as R
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
		link: gated(actual.link),
		rename: gated(actual.rename),
		mkdir: gated(actual.mkdir),
	}
	return { ...actual, ...wrapped, default: { ...actual, ...wrapped } }
})

const logger = createLogger({ level: "fatal" })
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const DAY = 86_400_000
const BASE_HZ = 430_000_000
const CH = 446_006_250
const PMR = [{ spacingHz: 12_500, firstChannelHz: CH }]
const KINDS = ["dv", "analog"] as const
const CAPS: StorageCaps = {
	maxRecordingsMb: 20,
	maxEvidenceMb: 20,
	maxAgeDays: 30,
	minFreeDiskMb: 0,
}
const roots: string[] = []

afterAll(async () => {
	await Promise.all(
		roots.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

// ---- steps ----

type SyncStep =
	| { k: "list"; f: number; by: number }
	| { k: "mark"; f: number }
	| { k: "merge"; s: number; m: number }
	| { k: "drop"; d: number }
interface Interleave {
	at: number
	step: SyncStep
}
interface RetentionStep {
	k: "retention"
	mode: "age" | "quota"
	victim: number
	il: Interleave | null
}
type Step =
	| { k: "ingest" }
	| { k: "recDigital"; d: number; by: number | null }
	| { k: "recAnalog"; d: number; by: number | null }
	| { k: "split" }
	| { k: "merge"; s: number; m: number }
	| { k: "mark"; d: number }
	| { k: "delete"; d: number; il: Interleave | null }
	| { k: "prune"; il: Interleave | null }
	| { k: "evict"; il: Interleave | null }
	| RetentionStep
	| { k: "restart"; snapshot: boolean; torn: boolean }

const idx = fc.nat({ max: 7 })
const syncStep: fc.Arbitrary<SyncStep> = fc.oneof(
	fc.record({ k: fc.constant("list" as const), f: idx, by: idx }),
	fc.record({ k: fc.constant("mark" as const), f: idx }),
	fc.record({ k: fc.constant("merge" as const), s: idx, m: idx }),
	fc.record({ k: fc.constant("drop" as const), d: idx }),
)
const interleave = fc.option(
	fc.record({ at: fc.nat({ max: 14 }), step: syncStep }),
	{ nil: null, freq: 2 },
)
const step: fc.Arbitrary<Step> = fc.oneof(
	{ arbitrary: fc.record({ k: fc.constant("ingest" as const) }), weight: 3 },
	{
		arbitrary: fc.record({
			k: fc.constant("recDigital" as const),
			d: idx,
			by: fc.option(idx, { nil: null }),
		}),
		weight: 5,
	},
	{
		arbitrary: fc.record({
			k: fc.constant("recAnalog" as const),
			d: idx,
			by: fc.option(idx, { nil: null }),
		}),
		weight: 2,
	},
	{ arbitrary: fc.record({ k: fc.constant("split" as const) }), weight: 1 },
	{
		arbitrary: fc.record({ k: fc.constant("merge" as const), s: idx, m: idx }),
		weight: 1,
	},
	{
		arbitrary: fc.record({ k: fc.constant("mark" as const), d: idx }),
		weight: 1,
	},
	{
		arbitrary: fc.record({
			k: fc.constant("delete" as const),
			d: idx,
			il: interleave,
		}),
		weight: 4,
	},
	{
		arbitrary: fc.record({ k: fc.constant("prune" as const), il: interleave }),
		weight: 1,
	},
	{
		arbitrary: fc.record({ k: fc.constant("evict" as const), il: interleave }),
		weight: 1,
	},
	{
		arbitrary: fc.record({
			k: fc.constant("retention" as const),
			mode: fc.constantFrom("age" as const, "quota" as const),
			victim: idx,
			il: interleave,
		}),
		weight: 2,
	},
	{
		arbitrary: fc.record({
			k: fc.constant("restart" as const),
			snapshot: fc.boolean(),
			torn: fc.boolean(),
		}),
		weight: 1,
	},
)

// ---- the world ----

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

const tone = (at: number): ProofAnalogInput => ({
	outcome: "decoded",
	mode: "nfm",
	voice: false,
	tone: { ctcssHz: 88.5, dcs: null },
	transport: "live",
	at,
})

const folderOf = (rid: string): string => rid.split("~")[0] ?? ""

class World {
	store!: DiscoveryStore
	ev!: EvidenceStore
	persist!: ScannerPersistence
	readonly marked = new Set<string>()
	/** Every listing made: the recording id and the observation listing it. */
	readonly listings: { rid: string; obs: string }[] = []
	/** Every observation id ingested (their discovery follows the store: splits, merges). */
	readonly observations: string[] = []
	readonly clock = { now: Date.now() }
	private appends: Promise<unknown>[] = []
	private n = 0
	private file = 0
	private readonly ids = counterIds()

	constructor(
		readonly root: string,
		readonly state: string,
	) {}

	async open(): Promise<void> {
		this.persist = new ScannerPersistence({
			dir: this.state,
			logger,
			now: () => T0,
		})
		const loaded = await this.persist.load()
		this.store = new DiscoveryStore({
			maxDiscoveries: 1_000,
			now: () => T0,
			newId: this.ids,
			logger,
			rasters: () => PMR,
		})
		await this.store.restoreInSlices({
			discoveries: loaded.discoveries,
			observations: loaded.observations,
			corrections: loaded.corrections,
			...(loaded.aliases ? { aliases: loaded.aliases } : {}),
			...(loaded.heldRecordings
				? { heldRecordings: loaded.heldRecordings }
				: {}),
			...(loaded.heldOverflow ? { heldOverflow: loaded.heldOverflow } : {}),
			...(loaded.recordingOperations
				? { recordingOperations: loaded.recordingOperations }
				: {}),
		})
		for (const e of loaded.entries) this.store.replay(e)
		this.store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
			this.appends.push(this.persist.append(e).catch(() => undefined))
		})
		const store = (): DiscoveryStore => this.store
		this.ev = new EvidenceStore({
			dir: this.root,
			caps: CAPS,
			logger,
			now: () => this.clock.now,
			statfs: async () => ({ freeBytes: 1e12 }),
			isDiscoveryLive: id => store().get(id) !== undefined,
			aliases: {
				aliasOwner: id => store().aliasOwner(id),
				aliasesOf: id => store().aliasesOf(id),
				releaseAliases: id => store().releaseAliases(id),
				heldFileNames: (id, removing) => store().heldFileNames(id, removing),
				heldRecordingOwner: id =>
					this.marked.has(folderOf(id)) ? null : store().heldRecordingOwner(id),
				heldRecordingHolder: id => store().heldRecordingHolder(id),
				heldFolderUnknown: id =>
					this.marked.has(id) || store().heldFolderUnknown(id),
			},
		})
		this.store.setFolderLookup(id => this.ev.folders.holds(id))
		const adapter: AnalogMetadataAdapter = {
			authorityHealthy: () => true,
			bindingLive: () => true,
			association: (d, o, b) => store().recordingAssociation(d, o, b),
			prepare: async metadata => {
				store().prepareRecording(metadata)
			},
			inverse: async id => {
				store().removePreparedRecording(id)
			},
			buildCommitPlan: id => store().buildRecordingCommitPlan(id),
			commitPlanCurrent: plan => store().recordingCommitPlanCurrent(plan),
			publishCommit: plan => store().publishRecordingCommit(plan),
		}
		this.ev.configureAnalog(adapter)
		await this.ev.loadFolderIndex()
		await this.ev.recoverAnalog()
	}

	async flush(): Promise<void> {
		while (this.appends.length > 0) await Promise.all(this.appends.splice(0))
	}

	live(): string[] {
		return this.store
			.snapshot()
			.discoveries.map(d => d.id)
			.sort()
	}
	pick(i: number): string | undefined {
		const live = this.live()
		return live.length === 0 ? undefined : live[i % live.length]
	}
	/** An observation the store places in `d` now. */
	obsOf(d: string): string | undefined {
		return this.observations.find(o => this.store.discoveryIdOf(o) === d)
	}

	ingest(): string | undefined {
		this.n++
		const id = `o${this.n}`
		const d = this.store.ingest(
			makeObs({
				id,
				centreHz: BASE_HZ + this.n * 100_000,
				startedAt: T0 + this.n * 1_000,
				cls: "analog-fm",
				open: false,
				gate: "passed",
			}),
		).discoveryId
		if (d === null) return undefined
		this.observations.push(id)
		return d
	}

	list(rid: string, obs: string): void {
		if (this.store.attachRecordings(obs, [rid], "linked"))
			this.listings.push({ rid, obs })
	}

	async recDigital(d: string, by: string | undefined): Promise<void> {
		const obs = this.obsOf(by ?? d)
		if (obs === undefined) return
		const name = `call${++this.file}.wav`
		const dir = join(this.root, "recordings", "dv", d)
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, name), Buffer.alloc(2048))
		await this.ev.loadFolderIndex()
		this.list(`${d}~${name}`, obs)
	}

	async recAnalog(d: string, by: string | undefined): Promise<void> {
		const obs = this.obsOf(d)
		if (obs === undefined) return
		const op = this.ev.beginAnalog({
			discoveryId: d,
			observationId: obs,
			binding: bindingOf(BASE_HZ),
		})
		await op.ready
		await op.push(new Int16Array([1, -2, 3, -4]))
		const receipt = await op.finish()
		const name = receipt.artifact?.split("/").at(-1)
		if (receipt.outcome !== "finalized" || name === undefined) return
		this.listings.push({ rid: `${d}~${name}`, obs })
		const other = by === undefined ? undefined : this.obsOf(by)
		if (other !== undefined && by !== d) this.list(`${d}~${name}`, other)
	}

	/** Decoded DMR discovery A on a fresh channel; an analog over's tone splits it onto twin B. */
	async split(): Promise<void> {
		this.n++
		const hz = CH + this.n * 12_500 * 16
		const old = `s${this.n}a`
		const id = `s${this.n}b`
		const at = T0 + this.n * 1_000
		const voice = (oid: string, startedAt: number, open: boolean) =>
			makeObs({
				id: oid,
				centreHz: hz,
				startedAt,
				cls: "analog-fm",
				open,
				gate: "passed",
			})
		const a = this.store.ingest(voice(old, at, false)).discoveryId
		if (a === null) return
		this.observations.push(old)
		const decoded = evidence("dmr", at + 500, { identity: dmrCc(1) })
		if (!this.store.appendObservationEvidence(old, decoded)) return
		this.store.applyEvidence(a, decoded)
		if (this.store.ingest(voice(id, at + 60_000, true)).discoveryId !== a)
			return
		this.observations.push(id)
		const op = this.ev.beginAnalog({
			discoveryId: a,
			observationId: id,
			binding: bindingOf(hz),
		})
		await op.ready
		await op.push(new Int16Array([1, -2, 3, -4]))
		this.store.recordAnalog(id, tone(at + 63_000))
		const receipt = await op.finish()
		const name = receipt.artifact?.split("/").at(-1)
		if (receipt.outcome === "finalized" && name !== undefined)
			this.listings.push({ rid: `${a}~${name}`, obs: id })
	}

	merge(s: string | undefined, m: string | undefined): void {
		if (s === undefined || m === undefined || s === m) return
		this.store.applyConsolidation({ groups: [{ survivor: s, members: [m] }] })
	}

	/** The live discovery that lists `path`'s file outside its folder's owner (any listing). */
	holderOf(path: string): string | undefined {
		const parts = path.split("/")
		const folder = parts.at(-2) ?? ""
		const rid = `${folder}~${parts.at(-1) ?? ""}`
		for (const l of this.listings) {
			if (l.rid !== rid) continue
			const h = this.store.discoveryIdOf(l.obs)
			if (h === undefined || this.store.get(h) === undefined) continue
			if (h === folder || this.store.aliasOwner(folder) === h) continue
			return h
		}
		return undefined
	}

	resolved(folder: string): boolean {
		if (this.store.get(folder) !== undefined) return true
		const owner = this.store.aliasOwner(folder)
		return owner !== undefined && this.store.get(owner) !== undefined
	}
	unknown(folder: string): boolean {
		return this.marked.has(folder) || this.store.heldFolderUnknown(folder)
	}

	/** Every recording file in a discovery folder, by folder. */
	files(): { path: string; folder: string; kind: string }[] {
		const out: { path: string; folder: string; kind: string }[] = []
		for (const kind of KINDS) {
			const base = join(this.root, "recordings", kind)
			if (!existsSync(base)) continue
			for (const folder of readdirSync(base)) {
				const dir = join(base, folder)
				let names: string[]
				try {
					names = readdirSync(dir)
				} catch {
					continue
				}
				for (const name of names)
					if (name.endsWith(".wav"))
						out.push({ path: join(dir, name), folder, kind })
			}
		}
		return out
	}

	async restart(snapshot: boolean, torn: boolean): Promise<void> {
		await this.flush()
		await this.ev.stopAnalog()
		if (snapshot) await this.persist.writeSnapshot(this.store.snapshot())
		await this.flush()
		if (torn) {
			const dir = join(this.state, "journal")
			const names = existsSync(dir) ? (await readdir(dir)).sort() : []
			const last = names.at(-1)
			if (last !== undefined)
				await appendFile(join(dir, last), '{"seq":999999,"at":"2026-')
		}
		await this.open()
	}
}

// ---- the property ----

interface Ledger {
	/** Files a marked or unresolved folder held at some point of the step (must survive). */
	fixed: Set<string>
	/** Whether a synchronous step ran inside the async one. */
	interleaved: boolean
}

function runSync(w: World, s: SyncStep, ledger: Ledger): void {
	ledger.interleaved = true
	const files = w.files()
	const f =
		files.length === 0 ? undefined : files[("f" in s ? s.f : 0) % files.length]
	switch (s.k) {
		case "list": {
			const by = w.pick(s.by)
			if (f === undefined || by === undefined || by === f.folder) return
			const obs = w.obsOf(by)
			if (obs === undefined || !existsSync(f.path)) return
			w.list(`${f.folder}~${f.path.split("/").at(-1) ?? ""}`, obs)
			return
		}
		case "mark": {
			if (f === undefined) return
			w.marked.add(f.folder)
			for (const g of w.files())
				if (g.folder === f.folder) ledger.fixed.add(g.path)
			return
		}
		case "merge":
			w.merge(w.pick(s.s), w.pick(s.m))
			return
		case "drop": {
			const d = w.pick(s.d)
			if (d !== undefined) w.store.delete(d)
			return
		}
	}
}

async function interleaved<T>(
	w: World,
	il: Interleave | null,
	ledger: Ledger,
	task: () => Promise<T>,
): Promise<T> {
	if (il === null) return task()
	sched.count = 0
	sched.at = il.at
	sched.step = () => runSync(w, il.step, ledger)
	try {
		return await task()
	} finally {
		const late = sched.step
		sched.step = null
		// The task made fewer calls: the step runs after it (sequentially).
		late?.()
	}
}

/** Removals of `ids` in order; a removal refused or left pending keeps its files (fine). */
async function removeAll(w: World, ids: readonly string[]): Promise<void> {
	for (const id of ids) await w.ev.removeDiscovery(id).catch(() => undefined)
}

async function runStep(w: World, s: Step): Promise<void> {
	const before = w.files()
	const ledger: Ledger = { fixed: new Set(), interleaved: false }
	// A file of an unresolved folder that a live discovery lists belongs to that holder (it
	// follows the holder's policy); every other file of an unresolved folder stays.
	for (const f of before)
		if (
			w.unknown(f.folder) ||
			(!w.resolved(f.folder) && w.holderOf(f.path) === undefined)
		)
			ledger.fixed.add(f.path)
	let removed: string[] = []
	let victim: string | undefined
	switch (s.k) {
		case "ingest":
			w.ingest()
			break
		case "recDigital": {
			const d = w.pick(s.d)
			if (d !== undefined)
				await w.recDigital(d, s.by === null ? undefined : w.pick(s.by))
			break
		}
		case "recAnalog": {
			const d = w.pick(s.d)
			if (d !== undefined)
				await w.recAnalog(d, s.by === null ? undefined : w.pick(s.by))
			break
		}
		case "split":
			await w.split()
			break
		case "merge":
			w.merge(w.pick(s.s), w.pick(s.m))
			break
		case "mark": {
			const d = w.pick(s.d)
			if (d !== undefined) {
				w.marked.add(d)
				for (const f of before) if (f.folder === d) ledger.fixed.add(f.path)
			}
			break
		}
		case "delete": {
			const d = w.pick(s.d)
			if (d === undefined || !w.store.delete(d)) break
			removed = [d]
			await interleaved(w, s.il, ledger, () => removeAll(w, removed))
			break
		}
		case "prune": {
			removed = w.store.pruneInactive(-1)
			await interleaved(w, s.il, ledger, () => removeAll(w, removed))
			const onDisk = new Set(w.files().map(f => f.folder))
			const exists = (rid: string): boolean =>
				w
					.files()
					.some(f =>
						f.path.endsWith(`/${folderOf(rid)}/${rid.split("~")[1] ?? ""}`),
					)
			w.store.pruneHeldRecordings(exists, id => onDisk.has(id))
			for (const m of [...w.marked]) if (!onDisk.has(m)) w.marked.delete(m)
			break
		}
		case "evict": {
			const live = w.live().length
			if (live < 2) break
			const evicted: string[] = []
			const onEvicted = (ds: Discovery[]): void => {
				for (const d of ds) evicted.push(d.id)
			}
			w.store.on("evicted", onEvicted)
			w.store.setLimits({ maxDiscoveries: live, minSurfaceBlocks: 1 })
			w.ingest()
			w.store.off("evicted", onEvicted)
			w.store.setLimits({ maxDiscoveries: 1_000, minSurfaceBlocks: 1 })
			removed = evicted
			await interleaved(w, s.il, ledger, () => removeAll(w, removed))
			break
		}
		case "retention": {
			victim = w.pick(s.victim)
			// Every live discovery but the victim is kept, so a held file's holder is kept unless
			// it is the victim (whose held files follow its policy and may go).
			const keep = new Set(w.live().filter(d => d !== victim))
			const saved = w.clock.now
			w.clock.now = Date.now() + (s.mode === "age" ? 40 * DAY : 0)
			if (s.mode === "quota") w.ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
			w.clock.now = Math.max(w.clock.now, Date.now() + 60_000)
			await interleaved(w, s.il, ledger, () => w.ev.retention(keep))
			w.ev.setCaps(CAPS)
			w.clock.now = saved
			break
		}
		case "restart":
			await w.restart(s.snapshot, s.torn)
			break
	}
	await w.flush()
	check(w, s, before, ledger, removed, victim)
}

function check(
	w: World,
	s: Step,
	before: readonly { path: string; folder: string; kind: string }[],
	ledger: Ledger,
	removed: readonly string[],
	victim: string | undefined,
): void {
	const label = JSON.stringify(s)
	for (const f of before) {
		const gone = !existsSync(f.path)
		if (!gone) continue
		// 1. No file another live discovery lists was deleted (by retention only the victim's
		// held files may go: a held file follows its holder's policy).
		const holder = w.holderOf(f.path)
		if (holder !== undefined && holder !== victim)
			expect.fail(`${label}: ${f.path} listed by ${holder} was deleted`)
		// 2. Every file of a marked or unresolved folder still exists.
		if (ledger.fixed.has(f.path))
			expect.fail(
				`${label}: ${f.path} in a marked or unresolved folder was deleted`,
			)
	}
	if (ledger.interleaved) return
	// 3. Not trivially satisfied: an unkept digital file with no holder, in an unmarked folder,
	// is deleted by its discovery's removal and by retention of its (victim) discovery.
	const owners = new Set(removed)
	if (s.k === "retention" && victim !== undefined) owners.add(victim)
	for (const f of before) {
		if (f.kind !== "dv" || !owners.has(f.folder)) continue
		if (ledger.fixed.has(f.path) || w.unknown(f.folder)) continue
		if (w.holderOf(f.path) !== undefined) continue
		if (s.k === "retention" && !w.resolved(f.folder)) continue
		expect(existsSync(f.path), `${label}: ${f.path} should be deleted`).toBe(
			false,
		)
	}
}

describe("recording deletion under randomised interleavings", () => {
	// Feature: scanner recordings, Property 1: no delete path reaches a listed or unknown-owner file
	// Validates: Requirements binding invariant (no discovery's delete path reaches a file another
	// discovery lists; a marked or unresolved folder keeps every recording file in it)
	it("holds after every step, and unheld unkept files still go", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(step, { minLength: 3, maxLength: 12 }),
				async steps => {
					const base = await realpath(
						await mkdtemp(join(tmpdir(), "wavekit-recheck-prop-")),
					)
					roots.push(base)
					const w = new World(join(base, "data"), join(base, "state"))
					await mkdir(w.root, { recursive: true })
					try {
						await w.open()
						// Two discoveries with a file each, so every run has something to delete.
						for (let i = 0; i < 2; i++) {
							const d = w.ingest()
							if (d !== undefined) await w.recDigital(d, undefined)
						}
						for (const s of steps) await runStep(w, s)
					} finally {
						sched.step = null
						await w.flush()
						await w.ev.stopAnalog()
						await rm(base, { recursive: true, force: true })
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
