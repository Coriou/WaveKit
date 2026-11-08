/**
 * Randomised interleavings of the scanner's recording lifecycle against the binding invariant:
 * no delete path reaches a file that any other live discovery lists; a listed file follows its
 * listers' policy (kept while any lister is kept; the physical folder's discovery counts only
 * when it lists the file itself); a folder that is marked (its ownership is unknown) or whose
 * owner cannot be resolved keeps every recording file in it, at any depth; nothing is removed
 * recursively.
 *
 * Real DiscoveryStore, EvidenceStore (with its analog operations) and ScannerPersistence over a
 * temporary root, with or without a protection port, and in some runs a real ownership table
 * filled to within a few entries of its bound (real refusals and marks, and a real return below
 * the bound when the filler's holder is deleted or the prune drops the filler). Steps: record
 * (digital and analog, in the discovery's own folder or listed by another, nested files at any
 * depth), another listing of an existing file, co-channel split, merge, overflow mark, discovery
 * delete, inactive prune (with the ownership table's prune), capacity eviction, retention (age
 * and quota), restart (snapshot or not, journal replay, optionally a torn last line), probe
 * publication of a call file whose name may already be taken in the folder (same device through
 * link, or another device through the copy fallback: link fails with EXDEV).
 *
 * Interleavings: every filesystem call (lstat, stat, readdir, readFile, open and every FileHandle
 * method, unlink, rm, rmdir, rename, link, realpath, mkdir, writes) and every await of the analog
 * metadata adapter (prepare, inverse) counts while an async step runs; up to three synchronous
 * steps (a listing, a mark, a merge, a store delete) run when the n-th call settles, before its
 * caller resumes. No timers.
 *
 * Oracle: every unlink and rm of a recording file is checked in its own call (the same
 * synchronous turn as the deleter's decision) against the world's ground truth: the listings
 * made, followed through splits and merges to the live discoveries now holding them. A
 * recursive rm of a recording folder fails at once. After each step: the files of marked or
 * unresolved folders still exist, and without an interleave an unkept file nobody else lists is
 * deleted (the property is not trivially satisfied). A probe publication leaves every file
 * already in the target folder in place with its bytes.
 *
 * Seeds: fast-check prints the seed and the shrunk counterexample on failure; replay with
 * `fc.assert(..., { seed, path })`. `SCANNER_PROPERTY_SEED` fixes the seed of the random run.
 */
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import type * as FsPromisesModule from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
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
import { join, relative, sep } from "node:path"
import fc from "fast-check"
import { afterAll, describe, expect, it, vi } from "vitest"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import type { AnalogMetadataAdapter } from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../../src/core/scanner/store/evidence-store.js"
import { HELD_RECORDINGS_MAX } from "../../../../src/core/scanner/store/held-recordings.js"
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

/**
 * The scheduler: while `due` holds steps, every gated call counts, and each step whose `at` has
 * been reached runs when that call settles. `onUnlink` and `onRecursive` see every unlink, rm
 * and recursive rm in the call itself.
 */
const sched = vi.hoisted(() => ({
	count: 0,
	due: [] as { at: number; run: () => void }[],
	tick: null as (() => Promise<void>) | null,
	onUnlink: null as ((path: string) => void) | null,
	onRecursive: null as ((path: string) => void) | null,
	/** link() fails with EXDEV (another device: the copy fallback publishes). */
	exdev: false,
}))

vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<FsPromises>()
	const takeDue = (): (() => void)[] => {
		if (sched.due.length === 0) return []
		const n = sched.count++
		const out: (() => void)[] = []
		while ((sched.due[0]?.at ?? Number.POSITIVE_INFINITY) <= n) {
			const d = sched.due.shift()
			if (d !== undefined) out.push(d.run)
		}
		return out
	}
	// At the await point: after the call settled, before its caller resumes (never between a
	// caller's synchronous check and the call it guards).
	const after = <T>(result: Promise<T>): Promise<T> => {
		const due = takeDue()
		if (due.length === 0) return result
		const run = (): void => {
			for (const step of due) step()
		}
		return result.then(
			value => {
				run()
				return value
			},
			(err: unknown) => {
				run()
				throw err
			},
		)
	}
	const gated =
		<A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
		(...args: A): Promise<R> =>
			after(fn(...args))
	const handle = (h: FileHandle): FileHandle =>
		new Proxy(h, {
			get(target, prop) {
				const value: unknown = Reflect.get(target, prop, target)
				if (typeof value !== "function") return value
				return (...args: unknown[]): unknown => {
					const result: unknown = (value as (...a: unknown[]) => unknown).apply(
						target,
						args,
					)
					return result instanceof Promise ? after(result) : result
				}
			},
		})
	sched.tick = () => after(Promise.resolve())
	const wrapped = {
		lstat: gated(actual.lstat),
		stat: gated(actual.stat),
		readdir: gated(actual.readdir),
		readFile: gated(actual.readFile),
		writeFile: gated(actual.writeFile),
		appendFile: gated(actual.appendFile),
		copyFile: gated(actual.copyFile),
		opendir: gated(actual.opendir),
		rm: ((path: string, opts?: { recursive?: boolean }) => {
			if (opts?.recursive === true) sched.onRecursive?.(String(path))
			else sched.onUnlink?.(String(path))
			return after(actual.rm(path, opts))
		}) as FsPromises["rm"],
		rmdir: gated(actual.rmdir),
		unlink: ((path: string) => {
			sched.onUnlink?.(String(path))
			return after(actual.unlink(path))
		}) as FsPromises["unlink"],
		realpath: gated(actual.realpath),
		open: (async (...args: Parameters<FsPromises["open"]>) =>
			handle(await after(actual.open(...args)))) as FsPromises["open"],
		link: gated(((...args: Parameters<FsPromises["link"]>) =>
			sched.exdev
				? Promise.reject(
						Object.assign(new Error("EXDEV: cross-device link"), {
							code: "EXDEV",
						}),
					)
				: actual.link(...args)) as FsPromises["link"]),
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
const DISCOVERY_ID = /^d_[0-9A-Za-z]+$/
const CAPS: StorageCaps = {
	maxRecordingsMb: 20,
	maxEvidenceMb: 20,
	maxAgeDays: 30,
	minFreeDiskMb: 0,
}
/** A port that keeps nothing: every removal takes the guarded per-file path. */
const keepsNothing: RecordingProtection = {
	isProtected: () => false,
	isDsdFmeFileProtected: () => false,
	isScannerFileProtected: () => false,
	discoveryHoldsKept: () => false,
}
const roots: string[] = []

afterAll(async () => {
	sched.onUnlink = null
	sched.onRecursive = null
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
type Step =
	| { k: "ingest" }
	| { k: "recDigital"; d: number; by: number | null }
	| { k: "recAnalog"; d: number; by: number | null }
	| { k: "recNested"; d: number; depth: number }
	| { k: "list"; f: number; by: number }
	| { k: "split" }
	| { k: "merge"; s: number; m: number }
	| { k: "mark"; d: number }
	| { k: "delete"; d: number; il: Interleave[] }
	| { k: "prune"; il: Interleave[] }
	| { k: "evict"; il: Interleave[] }
	| RetentionStep
	| { k: "restart"; snapshot: boolean; torn: boolean }
	| ProbeStep
interface RetentionStep {
	k: "retention"
	mode: "age" | "quota"
	victim: number
	il: Interleave[]
}

/** A probe call file for discovery `d`; talkgroup `tg` of three, so names repeat. */
interface ProbeStep {
	k: "probe"
	d: number
	tg: number
	exdev: boolean
	il: Interleave[]
}

interface Run {
	/** A protection port: removals take the guarded path. */
	protection: boolean
	/** A real ownership table filled to this many entries below its bound; null: not filled. */
	full: number | null
}

const idx = fc.nat({ max: 7 })
const syncStep: fc.Arbitrary<SyncStep> = fc.oneof(
	fc.record({ k: fc.constant("list" as const), f: idx, by: idx }),
	fc.record({ k: fc.constant("mark" as const), f: idx }),
	fc.record({ k: fc.constant("merge" as const), s: idx, m: idx }),
	fc.record({ k: fc.constant("drop" as const), d: idx }),
)
/** Up to three interleaved steps, early (the first 15 calls) or anywhere in the first 200. */
const interleaves: fc.Arbitrary<Interleave[]> = fc.oneof(
	{ arbitrary: fc.constant<Interleave[]>([]), weight: 2 },
	{
		arbitrary: fc.array(
			fc.record({
				at: fc.oneof(fc.nat({ max: 15 }), fc.nat({ max: 200 })),
				step: syncStep,
			}),
			{ minLength: 1, maxLength: 3 },
		),
		weight: 3,
	},
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
	{
		arbitrary: fc.record({
			k: fc.constant("recNested" as const),
			d: idx,
			depth: fc.integer({ min: 1, max: 3 }),
		}),
		weight: 2,
	},
	{
		arbitrary: fc.record({ k: fc.constant("list" as const), f: idx, by: idx }),
		weight: 3,
	},
	{ arbitrary: fc.record({ k: fc.constant("split" as const) }), weight: 1 },
	{
		arbitrary: fc.record({ k: fc.constant("merge" as const), s: idx, m: idx }),
		weight: 2,
	},
	{
		arbitrary: fc.record({ k: fc.constant("mark" as const), d: idx }),
		weight: 1,
	},
	{
		arbitrary: fc.record({
			k: fc.constant("delete" as const),
			d: idx,
			il: interleaves,
		}),
		weight: 4,
	},
	{
		arbitrary: fc.record({ k: fc.constant("prune" as const), il: interleaves }),
		weight: 1,
	},
	{
		arbitrary: fc.record({ k: fc.constant("evict" as const), il: interleaves }),
		weight: 1,
	},
	{
		arbitrary: fc.record({
			k: fc.constant("retention" as const),
			mode: fc.constantFrom("age" as const, "quota" as const),
			victim: idx,
			il: interleaves,
		}),
		weight: 3,
	},
	{
		arbitrary: fc.record({
			k: fc.constant("restart" as const),
			snapshot: fc.boolean(),
			torn: fc.boolean(),
		}),
		weight: 1,
	},
	{
		arbitrary: fc.record({
			k: fc.constant("probe" as const),
			d: idx,
			tg: fc.nat({ max: 2 }),
			exdev: fc.boolean(),
			il: interleaves,
		}),
		weight: 3,
	},
)
const run: fc.Arbitrary<Run> = fc.record({
	protection: fc.boolean(),
	full: fc.oneof(
		{ arbitrary: fc.constant(null), weight: 4 },
		{ arbitrary: fc.nat({ max: 2 }), weight: 1 },
	),
})

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

/** What a deleter is doing while the oracle watches its unlinks. */
type Context = { k: "removal" } | RetentionContext | { k: "other" }
interface RetentionContext {
	k: "retention"
	keep: ReadonlySet<string>
	/** `keep` and the alias folders of every kept discovery (retention's own view). */
	keepFolders: ReadonlySet<string>
}

interface StoredWav {
	path: string
	folder: string
	kind: string
	/** Directly in the discovery folder (a recording id names it); deeper ones are nested. */
	top: boolean
}

class World {
	store!: DiscoveryStore
	ev!: EvidenceStore
	persist!: ScannerPersistence
	readonly marked = new Set<string>()
	/** Every listing made: the recording id and the observation listing it. */
	readonly listings: { rid: string; obs: string }[] = []
	/** Every observation id ingested (their discovery follows the store: splits, merges). */
	readonly observations: string[] = []
	/** Every discovery id seen (live ones are those the store still holds). */
	readonly known = new Set<string>()
	readonly clock = { now: Date.now() }
	ctx: Context = { k: "other" }
	readonly violations: string[] = []
	private appends: Promise<unknown>[] = []
	private n = 0
	private file = 0
	private readonly ids = counterIds()

	constructor(
		readonly root: string,
		readonly state: string,
		readonly opts: Run,
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
				heldRecordingListers: id =>
					this.marked.has(folderOf(id))
						? null
						: store().heldRecordingListers(id),
				heldRecordingHolders: id => store().heldRecordingHolders(id),
				heldFolderUnknown: id =>
					this.marked.has(id) || store().heldFolderUnknown(id),
			},
			...(this.opts.protection ? { protection: keepsNothing } : {}),
		})
		this.store.setFolderLookup(id => this.ev.folders.holds(id))
		const adapter: AnalogMetadataAdapter = {
			authorityHealthy: () => true,
			bindingLive: () => true,
			association: (d, o, b) => store().recordingAssociation(d, o, b),
			prepare: async metadata => {
				store().prepareRecording(metadata)
				await sched.tick?.()
			},
			inverse: async id => {
				store().removePreparedRecording(id)
				await sched.tick?.()
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
		return [...this.known].filter(id => this.store.get(id) !== undefined).sort()
	}
	pick(i: number): string | undefined {
		const live = this.live()
		return live.length === 0 ? undefined : live[i % live.length]
	}
	/** An observation the store places in `d` now (the oldest one: an older observation). */
	obsOf(d: string): string | undefined {
		return this.observations.find(o => this.store.discoveryIdOf(o) === d)
	}
	seen(id: string | null | undefined): string | undefined {
		if (id === null || id === undefined) return undefined
		this.known.add(id)
		return id
	}

	ingest(): string | undefined {
		this.n++
		const id = `o${this.n}`
		const d = this.seen(
			this.store.ingest(
				makeObs({
					id,
					centreHz: BASE_HZ + this.n * 100_000,
					startedAt: T0 + this.n * 1_000,
					cls: "analog-fm",
					open: false,
					gate: "passed",
				}),
			).discoveryId,
		)
		if (d === undefined) return undefined
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

	/**
	 * A dsd-fme call file in a probe folder, published into `d`'s folder and listed by `d`'s
	 * observation; its name repeats per talkgroup, so it may already be taken there (listed by
	 * anyone). Every file already in that folder must keep its bytes.
	 */
	async probe(d: string, tg: number): Promise<void> {
		const obs = this.obsOf(d)
		if (obs === undefined) return
		const name = `20261009_120000_00001_p_GROUP_TGT_${tg}_SRC_1.wav`
		const target = join(this.root, "recordings", "dv", d)
		const before = new Map<string, string>()
		for (const n of existsSync(target) ? readdirSync(target) : []) {
			const path = join(target, n)
			if (statSync(path).isFile())
				before.set(path, readFileSync(path).toString("base64"))
		}
		const dir = join(this.root, "recordings", "dv", `probe-${++this.file}`)
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, name), `probe ${this.file}`)
		const at = new Date(2026, 9, 9, 12, 0, 0).getTime()
		const out = await this.ev.linkProbeRecordings(dir, [
			{
				observationId: obs,
				discoveryId: d,
				startedAt: at,
				endedAt: at + 5_000,
				encrypted: false,
			},
		])
		for (const [path, bytes] of before) {
			// Only a sync step's own deleter could remove one (none runs inside a probe step).
			if (!existsSync(path)) {
				this.violations.push(`probe removed ${relative(this.root, path)}`)
				continue
			}
			if (readFileSync(path).toString("base64") !== bytes)
				this.violations.push(`probe replaced ${relative(this.root, path)}`)
		}
		for (const l of out.linked) {
			if (before.has(join(target, l.recordingId.split("~")[1] ?? "")))
				this.violations.push(`probe published over ${l.recordingId}`)
			this.list(l.recordingId, l.observationId)
		}
	}

	/** A file below the folder (no recording id names it). */
	async recNested(d: string, depth: number): Promise<void> {
		const parts = Array.from({ length: depth }, (_, i) => `n${i}`)
		const dir = join(this.root, "recordings", "dv", d, ...parts)
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, `deep${++this.file}.wav`), Buffer.alloc(1024))
		await this.ev.loadFolderIndex()
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
		const a = this.seen(this.store.ingest(voice(old, at, false)).discoveryId)
		if (a === undefined) return
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
		this.seen(this.store.discoveryIdOf(id))
		const receipt = await op.finish()
		const name = receipt.artifact?.split("/").at(-1)
		if (receipt.outcome === "finalized" && name !== undefined)
			this.listings.push({ rid: `${a}~${name}`, obs: id })
	}

	merge(s: string | undefined, m: string | undefined): void {
		if (s === undefined || m === undefined || s === m) return
		this.store.applyConsolidation({ groups: [{ survivor: s, members: [m] }] })
	}

	/** The live discoveries holding an observation that lists `name` of `folder` now. */
	listersOf(folder: string, name: string): Set<string> {
		const rid = `${folder}~${name}`
		const out = new Set<string>()
		for (const l of this.listings) {
			if (l.rid !== rid) continue
			const h = this.store.discoveryIdOf(l.obs)
			if (h !== undefined && this.store.get(h) !== undefined) out.add(h)
		}
		return out
	}

	resolved(folder: string): boolean {
		if (this.store.get(folder) !== undefined) return true
		const owner = this.store.aliasOwner(folder)
		return owner !== undefined && this.store.get(owner) !== undefined
	}
	unknown(folder: string): boolean {
		return this.marked.has(folder) || this.store.heldFolderUnknown(folder)
	}

	/** Every recording file under a discovery folder, at any depth. */
	files(): StoredWav[] {
		const out: StoredWav[] = []
		const walk = (dir: string, folder: string, kind: string, top: boolean) => {
			let names: string[]
			try {
				names = readdirSync(dir)
			} catch {
				return
			}
			for (const name of names) {
				const path = join(dir, name)
				let isDir = false
				try {
					isDir = statSync(path).isDirectory()
				} catch {
					continue
				}
				if (isDir) walk(path, folder, kind, false)
				else if (name.endsWith(".wav")) out.push({ path, folder, kind, top })
			}
		}
		for (const kind of KINDS) {
			const base = join(this.root, "recordings", kind)
			if (!existsSync(base)) continue
			for (const folder of readdirSync(base))
				if (DISCOVERY_ID.test(folder))
					walk(join(base, folder), folder, kind, true)
		}
		return out
	}

	/**
	 * The oracle of one unlink or rm, in the deleter's own synchronous turn: a recording file of
	 * a marked folder (any depth), one any live discovery lists while a removal runs, or one a
	 * retention pass may not remove (unresolved folder; a kept lister; no lister and a kept
	 * folder owner) is a violation.
	 */
	checkUnlink(path: string): void {
		const parts = relative(this.root, path).split(sep)
		const folder = parts[2] ?? ""
		if (
			parts[0] !== "recordings" ||
			!(KINDS as readonly string[]).includes(parts[1] ?? "") ||
			!DISCOVERY_ID.test(folder) ||
			parts.length < 4
		)
			return
		const name = parts[3] ?? ""
		const label = `${this.ctx.k} unlinked ${parts.slice(1).join("/")}`
		if (this.unknown(folder)) this.violations.push(`${label}: marked folder`)
		if (parts.length > 4 || !name.endsWith(".wav")) return
		const listers = [...this.listersOf(folder, name)]
		const ctx = this.ctx
		if (ctx.k !== "retention") {
			if (listers.length > 0)
				this.violations.push(`${label}: listed by ${listers.join(",")}`)
			return
		}
		if (!this.resolved(folder))
			this.violations.push(`${label}: unresolved folder`)
		if (listers.length > 0) {
			const kept = listers.filter(l => ctx.keep.has(l))
			if (kept.length > 0)
				this.violations.push(`${label}: kept lister ${kept.join(",")}`)
		} else if (ctx.keepFolders.has(folder))
			this.violations.push(`${label}: kept folder owner`)
	}

	checkRecursive(path: string): void {
		const parts = relative(this.root, path).split(sep)
		if (
			parts[0] === "recordings" &&
			(KINDS as readonly string[]).includes(parts[1] ?? "") &&
			DISCOVERY_ID.test(parts[2] ?? "")
		)
			this.violations.push(`recursive rm of ${parts.slice(1).join("/")}`)
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

	/**
	 * A real ownership table `below` entries short of its bound: filler listings held by
	 * `owner` of files that are not on disk (the prune drops them; deleting `owner` drops them).
	 */
	async fill(owner: string, below: number): Promise<void> {
		await this.flush()
		await this.ev.stopAnalog()
		const snapshot = this.store.snapshot()
		const held = snapshot.heldRecordings ?? []
		const count = Math.max(0, HELD_RECORDINGS_MAX - below - held.length)
		await this.persist.writeSnapshot({
			...snapshot,
			heldRecordings: [
				...held,
				...Array.from({ length: count }, (_, i) => ({
					id: `d_Z${i}~z${i}.wav`,
					ownerId: owner,
					observationId: `oz${i}`,
				})),
			],
		})
		await this.flush()
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
	const files = w.files().filter(f => f.top)
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
	il: readonly Interleave[],
	ledger: Ledger,
	task: () => Promise<T>,
): Promise<T> {
	if (il.length === 0) return task()
	sched.count = 0
	sched.due = [...il]
		.sort((a, b) => a.at - b.at)
		.map(i => ({ at: i.at, run: () => runSync(w, i.step, ledger) }))
	try {
		return await task()
	} finally {
		const late = sched.due.splice(0)
		// The task made fewer calls: the rest run after it (sequentially).
		for (const d of late) d.run()
	}
}

/** Removals of `ids` in order; a removal refused or left pending keeps its files (fine). */
async function removeAll(w: World, ids: readonly string[]): Promise<void> {
	for (const id of ids) await w.ev.removeDiscovery(id).catch(() => undefined)
}

async function runStep(w: World, s: Step): Promise<void> {
	const before = w.files()
	const ledger: Ledger = { fixed: new Set(), interleaved: false }
	// A marked folder, or one whose owner cannot be resolved, keeps every recording file in it.
	for (const f of before)
		if (w.unknown(f.folder) || !w.resolved(f.folder)) ledger.fixed.add(f.path)
	let removed: string[] = []
	let victim: string | undefined
	w.ctx = { k: "other" }
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
		case "recNested": {
			const d = w.pick(s.d)
			if (d !== undefined) await w.recNested(d, s.depth)
			break
		}
		case "list":
			runSync(w, s, ledger)
			ledger.interleaved = false
			break
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
			w.ctx = { k: "removal" }
			await interleaved(w, s.il, ledger, () => removeAll(w, removed))
			break
		}
		case "prune": {
			removed = w.store.pruneInactive(-1)
			w.ctx = { k: "removal" }
			await interleaved(w, s.il, ledger, () => removeAll(w, removed))
			w.ctx = { k: "other" }
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
			w.ctx = { k: "removal" }
			await interleaved(w, s.il, ledger, () => removeAll(w, removed))
			break
		}
		case "retention": {
			victim = w.pick(s.victim)
			// Every live discovery but the victim is kept: only files whose every lister is the
			// victim (or, with no lister, whose folder's owner is the victim) may go.
			const keep = new Set(w.live().filter(d => d !== victim))
			const keepFolders = new Set(keep)
			for (const k of keep)
				for (const alias of w.store.aliasesOf(k)) keepFolders.add(alias)
			const saved = w.clock.now
			w.clock.now = Date.now() + (s.mode === "age" ? 40 * DAY : 0)
			if (s.mode === "quota") w.ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
			w.clock.now = Math.max(w.clock.now, Date.now() + 60_000)
			w.ctx = { k: "retention", keep, keepFolders }
			await interleaved(w, s.il, ledger, () => w.ev.retention(keep))
			w.ev.setCaps(CAPS)
			w.clock.now = saved
			break
		}
		case "restart":
			await w.restart(s.snapshot, s.torn)
			break
		case "probe": {
			const d = w.pick(s.d)
			if (d === undefined) break
			sched.exdev = s.exdev
			try {
				await interleaved(w, s.il, ledger, () => w.probe(d, s.tg))
			} finally {
				sched.exdev = false
			}
			break
		}
	}
	w.ctx = { k: "other" }
	await w.flush()
	check(w, s, before, ledger, removed, victim)
}

function check(
	w: World,
	s: Step,
	before: readonly StoredWav[],
	ledger: Ledger,
	removed: readonly string[],
	victim: string | undefined,
): void {
	const label = JSON.stringify(s)
	// 1. No unlink met a listed, marked, unresolved or kept file; nothing was removed recursively.
	if (w.violations.length > 0)
		expect.fail(`${label}: ${w.violations.splice(0).join("; ")}`)
	// 2. Every file of a marked or unresolved folder still exists.
	for (const path of ledger.fixed)
		if (!existsSync(path))
			expect.fail(
				`${label}: ${path} in a marked or unresolved folder was deleted`,
			)
	if (ledger.interleaved) return
	// 3. Not trivially satisfied: a file nobody else lists, in an unmarked folder, is deleted by
	// its discovery's removal (nested ones too); retention deletes every file whose listers are
	// all the victim, wherever it lives (a kept folder owner that does not list it never keeps
	// it), and every unlisted file of a folder the victim owns.
	const owners = new Set(removed)
	for (const f of before) {
		if (f.kind !== "dv" || ledger.fixed.has(f.path) || w.unknown(f.folder))
			continue
		const name = f.path.split("/").at(-1) ?? ""
		const listers = f.top ? [...w.listersOf(f.folder, name)] : []
		if (s.k === "retention") {
			if (victim === undefined || !f.top || !w.resolved(f.folder)) continue
			const owner = w.store.get(f.folder)
				? f.folder
				: w.store.aliasOwner(f.folder)
			if (
				listers.length === 0
					? owner !== victim
					: listers.some(l => l !== victim)
			)
				continue
		} else if (!owners.has(f.folder) || listers.length > 0) continue
		expect(existsSync(f.path), `${label}: ${f.path} should be deleted`).toBe(
			false,
		)
	}
}

const fromOld = (il: Interleave | null): Interleave[] =>
	il === null ? [] : [il]

/**
 * Fixed cases. The counterexample an earlier version of this property found (seed 155921, path
 * 38:3:3:4:7:5:5:8:8:8:8:8:8:8 of its arbitrary): a merge, a listing interleaved into retention,
 * an analog publication revisiting an older observation, then a delete that reached a file
 * another live discovery still listed.
 */
const FIXED: { name: string; run: Run; steps: Step[] }[] = [false, true].map(
	protection => ({
		name: `seed 155921 counterexample (${protection ? "with" : "without"} a protection port)`,
		run: { protection, full: null },
		steps: [
			{ k: "ingest" },
			{ k: "merge", s: 1, m: 0 },
			{
				k: "retention",
				mode: "age",
				victim: 0,
				il: fromOld({ at: 0, step: { k: "list", f: 0, by: 7 } }),
			},
			{ k: "recAnalog", d: 0, by: null },
			{ k: "delete", d: 0, il: fromOld(null) },
			{ k: "mark", d: 0 },
		],
	}),
)

async function scenario(opts: Run, steps: readonly Step[]): Promise<void> {
	const base = await realpath(
		await mkdtemp(join(tmpdir(), "wavekit-recheck-prop-")),
	)
	roots.push(base)
	const w = new World(join(base, "data"), join(base, "state"), opts)
	await mkdir(w.root, { recursive: true })
	sched.onUnlink = path => w.checkUnlink(path)
	sched.onRecursive = path => w.checkRecursive(path)
	try {
		await w.open()
		// Two discoveries with a file each, so every run has something to delete.
		for (let i = 0; i < 2; i++) {
			const d = w.ingest()
			if (d !== undefined) await w.recDigital(d, undefined)
		}
		const first = w.pick(0)
		if (opts.full !== null && first !== undefined)
			await w.fill(first, opts.full)
		for (const s of steps) await runStep(w, s)
	} finally {
		sched.due = []
		sched.exdev = false
		sched.onUnlink = null
		sched.onRecursive = null
		await w.flush()
		await w.ev.stopAnalog()
		await rm(base, { recursive: true, force: true })
	}
}

const SEED = Number.parseInt(process.env["SCANNER_PROPERTY_SEED"] ?? "", 10)

describe("recording deletion under randomised interleavings", () => {
	for (const c of FIXED)
		it(`fixed case: ${c.name}`, async () => {
			await scenario(c.run, c.steps)
		})

	// Feature: scanner recordings, Property 1: no delete path reaches a listed or unknown-owner file
	// Validates: Requirements binding invariant (no discovery's delete path reaches a file another
	// live discovery lists; a listed file follows its listers' policy; a marked or unresolved
	// folder keeps every recording file in it, at any depth; nothing is removed recursively)
	it("holds at every unlink and after every step, and unheld unkept files still go", async () => {
		await fc.assert(
			fc.asyncProperty(
				run,
				fc.array(step, { minLength: 3, maxLength: 10 }),
				async (opts, steps) => {
					await scenario(opts, steps)
				},
			),
			{ numRuns: 100, ...(Number.isNaN(SEED) ? {} : { seed: SEED }) },
		)
	}, 540_000)
})
