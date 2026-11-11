/**
 * Learned state per receiver, inside the one state directory.
 *
 * A tracked source (rtl_tcp U8_IQ) has, per receiver key, its own namespace for the spectrum
 * engine state and occupancy (`<scanner dir>/engine/receivers/<source>/<key>/`); the pre-band
 * gain and the accepted tuning are namespaced by the tuner controller through `onBound`.
 * - same key as before: that namespace resumes;
 * - another key: its own namespace, nothing of another receiver's applied;
 * - a weak key (`source:<id>|model:...`): only that source's state for that model (logged as weak);
 * - `unknown`: nothing learned is applied (fresh in memory) and nothing is written.
 *
 * Reconnects. Between a connection boundary (`onConnection`) and that connection's settled
 * identity the source is pending: the state learned so far is exported under the receiver it was
 * learned on, and stays applied read-only (loads read that receiver's namespace, writes are
 * dropped). The settle swaps the engine state only when the settled key differs; the same key
 * again costs no swap and no pipeline restart.
 *
 * Exports that cannot be written (store not attached or not writable, a failed write) are held
 * in memory under the key they belong to (HELD_EXPORTS_MAX per source) and written once the store
 * is writable; binding that key again resumes from the held state. No learning is lost to a swap.
 *
 * The state from before namespacing (legacy) is adopted once, per concern (`adoptedBy` and
 * `owed` in `<stateDir>/receiver-namespaces.json`): the pre-band gain at the identification (the
 * tuner), the spectrum files as soon as the scanner store is writable while that receiver is bound.
 * Who may adopt: a stable key (`unit:` or a strong `serial:`) always; the source-scoped key only
 * when the source has no sdr-host (`sdrHostConfigured` false). With an sdr-host the adoption waits
 * for its stable answer, so a header-only key never wins it. When the answer stops being awaited
 * (an auto-detected sdr-host that never answered: `recheckAdoption`), the bound source-scoped key
 * adopts then, within its connection. While the answer is still awaited (`sdrHostAwaited`) and
 * no receiver adopted yet, that key takes no writes (reads are fine): its namespace stays empty,
 * so the later adoption copies the legacy files in.
 *
 * Take-over: a stable key bound for the first time on a source that does not adopt the legacy
 * state now (another key adopted it) starts from that source's weak namespace for the same model
 * (`source:<id>|model:<its model>`) when one was learned and no other stable key took it over
 * before (`takenOver`, once per weak key). The weak namespace itself stays as it was. The first
 * stable key on a source whose weak key learned while no receiver adopted (an sdr-host without
 * `unitId`, updated later) adopts too, and takes the weak namespace over only when no legacy
 * engine or occupancy file exists; else the legacy files win, whatever their age (legacy wins).
 * Its pre-band gain follows the same rule: the legacy record first, the weak key's only without one.
 *
 * A pending window that spans more than one new connection (an unsettled connection to another
 * receiver, then back) reloads the settled key's saved state even when it is the key bound
 * before: what the engine learned in memory meanwhile may be another receiver's (one swap).
 *
 * Scanner discoveries and recordings stay shared. A source the tracker does not follow keeps the
 * un-namespaced files exactly as before.
 */
import { join } from "node:path"
import { z } from "zod"
import type { ReceiverNamespaceState } from "@wavekit/api-types"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import { readFileBounded } from "./band-gain.js"
import { atomicWrite } from "./scanner/store/atomic-write.js"
import type { SpectrumPersistence } from "./spectrum/spectrum-service.js"
import type { EngineState } from "./spectrum/types.js"
import type { OccupancyState } from "./spectrum/occupancy.js"
import {
	isReceiverKey,
	RECEIVER_KEY_MAX_LENGTH,
	sourceModelKey,
	type ReceiverIdentity,
} from "./receiver-identity.js"

export const RECEIVER_NAMESPACES_FILE_NAME = "receiver-namespaces.json"
/** One core runs far fewer sources; past this the oldest records are not persisted. */
export const RECEIVER_NAMESPACES_MAX_SOURCES = 16
/** Receivers remembered per source (resumed vs fresh); past this the oldest is forgotten. */
export const RECEIVER_NAMESPACES_MAX_KEYS = 16
const SOURCE_ID_MAX_LENGTH = 128
/**
 * 16 sources x (a 128-character id at up to 6 bytes JSON-escaped + 17 keys of at most 128
 * characters + 16 take-over pairs of two such keys + quotes, commas and tab indentation, about
 * 7.6 KiB) is about 122 KiB; 128 KiB bounds the read before parse.
 */
export const RECEIVER_NAMESPACES_FILE_MAX_BYTES = 128 * 1024
/**
 * Exports held in memory per source until the store takes them: the receivers a source switched
 * between while the store was not writable. Past it the oldest is dropped (logged).
 */
export const HELD_EXPORTS_MAX = 4

/**
 * Keys are read as bounded strings, then each is kept only when this build could have made it:
 * a key form of an earlier build (the process-random `sdrhost:` id, the unscoped `model:`) is
 * dropped, and an `adoptedBy` of such a form reads as no adopter (the legacy files, never
 * overwritten, are adopted again by the next eligible receiver).
 */
const KeyText = z.string().max(RECEIVER_KEY_MAX_LENGTH)
const FileSchema = z
	.object({
		version: z.literal(1),
		sources: z
			.array(
				z
					.object({
						sourceId: z.string().min(1).max(SOURCE_ID_MAX_LENGTH),
						adoptedBy: KeyText.nullable(),
						keys: z.array(KeyText).max(RECEIVER_NAMESPACES_MAX_KEYS),
						/** Concerns of `adoptedBy` not adopted yet; absent: none. */
						owed: z
							.array(z.enum(["spectrum", "gain"]))
							.max(2)
							.optional(),
						/** Weak keys a stable key took over, once each; absent: none. */
						takenOver: z
							.array(z.object({ from: KeyText, by: KeyText }).strict())
							.max(RECEIVER_NAMESPACES_MAX_KEYS)
							.optional(),
					})
					.strict(),
			)
			.max(RECEIVER_NAMESPACES_MAX_SOURCES),
	})
	.strict()

/** What the namespaced store needs (ScannerPersistence implements it). */
export interface ReceiverScopedStore extends Omit<
	SpectrumPersistence,
	"generation"
> {
	receiverNamespacePath(sourceId: string, receiverKey: string): string
	writeEngineIn(sourceId: string, key: string, s: EngineState): Promise<void>
	loadEngineIn(sourceId: string, key: string): Promise<EngineState | null>
	writeOccupancyIn(
		sourceId: string,
		key: string,
		s: OccupancyState,
	): Promise<void>
	loadOccupancyIn(sourceId: string, key: string): Promise<OccupancyState | null>
	adoptLegacyInto(sourceId: string, key: string): Promise<boolean>
	/**
	 * Modification times (ms) of a namespace's engine and occupancy files, or of the files from
	 * before namespacing when `key` is null; null for a missing file. Only presence is read (the
	 * legacy files win whenever one exists). Optional: without it the legacy files always win the
	 * first adoption.
	 */
	learnedFileTimes?(
		sourceId: string,
		key: string | null,
	): Promise<{ engine: number | null; occupancy: number | null }>
}

/** The spectrum side of a switch (SpectrumService). */
export interface LearnedSpectrum {
	exportLearnedState(sourceId: string): Promise<{
		engine: EngineState | null
		occupancy: OccupancyState | null
	}>
	replaceLearnedState(
		sourceId: string,
		next: { engine: EngineState | null; occupancy: OccupancyState | null },
	): Promise<void>
}

export interface ReceiverBinding {
	/** The receiver key whose state applies; null: unknown, nothing applies. */
	key: string | null
	/** True for the one identification that adopts the pre-band gain from before namespacing. */
	adoptLegacy: boolean
	/**
	 * With adoptLegacy: the namespace record of the adoption was written. Informational: the
	 * record from before namespacing is kept either way (a rollback reads it).
	 */
	legacyRecorded?: boolean
	/**
	 * A stable key's first binding that takes over this weak key's state (copied, never moved).
	 * With adoptLegacy the legacy pre-band gain record still comes first when one exists.
	 */
	takeOverFrom?: string
}

export interface ReceiverLearnedStateOptions {
	stateDir: string
	logger: Logger
	/** Sources whose learned state is namespaced (the tracker follows them). */
	tracked: (sourceId: string) => boolean
	/** Learned state outside the spectrum (the tuner: pre-band gain, accepted tuning). */
	onBound?: (sourceId: string, binding: ReceiverBinding) => void
	/**
	 * The source has an sdr-host that can name a stable unit, or one may still answer: a weak key
	 * then does not adopt the state from before namespacing (default: none). When it turns false
	 * for a bound weak key, call `recheckAdoption`.
	 */
	sdrHostConfigured?: (sourceId: string) => boolean
	/**
	 * The source's sdr-host may still give its first answer (never answered, not given up on):
	 * while it does, a bound weak key that no receiver adopted for yet takes no learned-state
	 * writes (reads are fine), so the legacy adoption a later `recheckAdoption` makes finds its
	 * namespace empty and copies the legacy files in. Default: never awaited.
	 */
	sdrHostAwaited?: (sourceId: string) => boolean
	fs?: {
		readFile: (path: string, maxBytes: number) => Promise<Buffer>
		atomicWrite: (path: string, data: string) => Promise<void>
	}
}

type Concern = "spectrum" | "gain"

interface SourceRecord {
	/** The receiver the state from before namespacing belongs to (null: none identified yet). */
	adoptedBy: string | null
	keys: string[]
	/** Concerns `adoptedBy` has not adopted yet. */
	owed: Set<Concern>
	/** Weak key -> the stable key that took it over (once per weak key). */
	takenOver: Map<string, string>
}

interface LearnedSnapshot {
	engine: EngineState | null
	occupancy: OccupancyState | null
}

export interface ReceiverNamespaceView {
	key: string
	strength: ReceiverIdentity["strength"]
	tunerType?: number
	serial?: string
	learnedStateNamespace: string | null
	namespaceState: ReceiverNamespaceState
}

export class ReceiverLearnedState {
	private readonly log: Logger
	private readonly file: string
	private readonly fs: NonNullable<ReceiverLearnedStateOptions["fs"]>
	private records = new Map<string, SourceRecord>()
	/** The bound receiver key per tracked source; absent or null: unknown (nothing applies). */
	private readonly bound = new Map<string, string | null>()
	private readonly views = new Map<string, ReceiverNamespaceView>()
	/** Serialised switches per source; writes are dropped and loads return nothing while one runs. */
	private readonly chains = new Map<string, Promise<void>>()
	private readonly switching = new Set<string>()
	/** Sources between a connection boundary and that connection's settled identity. */
	private readonly pending = new Set<string>()
	/** Connection boundaries seen per source; a settle clears `pending` only if none came since. */
	private readonly boundaries = new Map<string, number>()
	/** Bumped on every binding change; a load that read across one reads again. */
	private readonly generation = new Map<string, number>()
	/** Exports not written yet, per source and key (never the bound key's). */
	private readonly held = new Map<string, Map<string, LearnedSnapshot>>()
	/** A held-export flush is queued, one per source. */
	private readonly flushing = new Set<string>()
	/** A load was refused while a switch ran: an engine opened fresh meanwhile. */
	private readonly refusedLoads = new Set<string>()
	private spectrum: LearnedSpectrum | null = null
	private store: ReceiverScopedStore | null = null
	private writable: () => boolean = () => true
	private fileChain: Promise<unknown> = Promise.resolve()
	/** Spectrum adoptions queued by a write or a load, one per source. */
	private readonly adopting = new Set<string>()
	/** The identity of the last settle per source (`recheckAdoption` binds it again). */
	private readonly settledIdentity = new Map<string, ReceiverIdentity>()
	/** New connections ("open" boundaries) since the last settle, per source. */
	private readonly opens = new Map<string, number>()
	/** Queued `recheckAdoption`s not run yet, per source: the adoption is still awaited. */
	private readonly rechecks = new Map<string, number>()

	constructor(private readonly options: ReceiverLearnedStateOptions) {
		this.log = createComponentLogger(options.logger, "ReceiverLearnedState")
		this.file = join(options.stateDir, RECEIVER_NAMESPACES_FILE_NAME)
		this.fs = options.fs ?? {
			readFile: (path, maxBytes) => readFileBounded(path, maxBytes),
			atomicWrite: (path, data) => atomicWrite(path, data),
		}
	}

	/** Reads the record file once; a missing, oversized or invalid one reads as empty (logged). */
	async load(): Promise<void> {
		let raw: Buffer
		try {
			raw = await this.fs.readFile(
				this.file,
				RECEIVER_NAMESPACES_FILE_MAX_BYTES,
			)
		} catch (err) {
			const code =
				typeof err === "object" && err !== null
					? (err as { code?: unknown }).code
					: undefined
			if (code !== "ENOENT")
				this.log.warn(
					"Receiver namespace record unreadable; every receiver starts as new",
				)
			return
		}
		let json: unknown
		try {
			json = JSON.parse(raw.toString("utf8"))
		} catch {
			this.log.warn(
				"Receiver namespace record is not JSON; every receiver starts as new",
			)
			return
		}
		const parsed = FileSchema.safeParse(json)
		if (!parsed.success) {
			this.log.warn(
				"Receiver namespace record is invalid; every receiver starts as new",
			)
			return
		}
		this.records = new Map(
			parsed.data.sources.map(r => {
				const adoptedBy =
					r.adoptedBy !== null && isReceiverKey(r.adoptedBy)
						? r.adoptedBy
						: null
				const record: SourceRecord = {
					adoptedBy,
					keys: r.keys.filter(k => isReceiverKey(k)),
					owed: adoptedBy === null ? new Set() : new Set(r.owed ?? []),
					takenOver: new Map(
						(r.takenOver ?? [])
							.filter(t => isReceiverKey(t.from) && isReceiverKey(t.by))
							.map(t => [t.from, t.by] as const),
					),
				}
				return [r.sourceId, record]
			}),
		)
	}

	setSpectrum(spectrum: LearnedSpectrum | null): void {
		this.spectrum = spectrum
	}

	/**
	 * The SpectrumPersistence the spectrum service uses (ScannerServiceDeps.learnedState):
	 * `legacy` (the gated un-namespaced one) for untracked sources, the receiver's namespace in
	 * `store` for tracked ones, written only while `writable` (the scanner's own write gate).
	 */
	attach(
		store: ReceiverScopedStore,
		legacy: SpectrumPersistence,
		writable: () => boolean,
	): SpectrumPersistence {
		this.store = store
		this.writable = writable
		// A receiver bound before the store existed adopts the files it is owed now (if writable).
		for (const sourceId of this.bound.keys()) this.kickAdoption(sourceId)
		return {
			generation: sourceId => this.generation.get(sourceId) ?? 0,
			writeEngine: async (sourceId, s, generation) => {
				if (!this.options.tracked(sourceId))
					return legacy.writeEngine(sourceId, s)
				// Unknown receiver, pending or a switch in progress: nothing is written under any key.
				const key = this.writableKey(sourceId, generation)
				if (key === null) return
				return store.writeEngineIn(sourceId, key, s)
			},
			loadEngine: async sourceId => {
				if (!this.options.tracked(sourceId)) return legacy.loadEngine(sourceId)
				return this.loadBound(sourceId, key =>
					store.loadEngineIn(sourceId, key),
				)
			},
			writeOccupancy: async (sourceId, s, generation) => {
				if (!this.options.tracked(sourceId))
					return legacy.writeOccupancy(sourceId, s)
				const key = this.writableKey(sourceId, generation)
				if (key === null) return
				return store.writeOccupancyIn(sourceId, key, s)
			},
			loadOccupancy: async sourceId => {
				if (!this.options.tracked(sourceId))
					return legacy.loadOccupancy(sourceId)
				return this.loadBound(sourceId, key =>
					store.loadOccupancyIn(sourceId, key),
				)
			},
		}
	}

	/**
	 * The key a write goes under now; null: dropped (unknown, pending, switching, gated, a binding
	 * change since the writer captured `generation`, or the spectrum adoption still owed: the
	 * adopted state replaces what is in memory first).
	 */
	private writableKey(sourceId: string, generation?: number): string | null {
		if (this.writable()) this.flushHeldSoon(sourceId)
		const key = this.bound.get(sourceId) ?? null
		if (
			key === null ||
			this.pending.has(sourceId) ||
			this.switching.has(sourceId) ||
			!this.writable() ||
			(generation !== undefined &&
				generation !== (this.generation.get(sourceId) ?? 0))
		)
			return null
		if (this.spectrumOwed(sourceId, key)) {
			this.kickAdoption(sourceId)
			return null
		}
		if (this.adoptionAwaited(sourceId, key)) return null
		return key
	}

	/**
	 * True while `key` is the settled weak key, no receiver adopted the legacy state yet and the
	 * source's sdr-host is still awaited: the adoption is deferred, so nothing is written under the
	 * key (a written file would make the later adoption copy nothing).
	 */
	private adoptionAwaited(sourceId: string, key: string): boolean {
		const identity = this.settledIdentity.get(sourceId)
		return (
			identity?.key === key &&
			identity.strength === "model" &&
			(this.records.get(sourceId)?.adoptedBy ?? null) === null &&
			(this.options.sdrHostAwaited?.(sourceId) === true ||
				(this.rechecks.get(sourceId) ?? 0) > 0)
		)
	}

	/** The last receiver key bound on a source (persisted); undefined before its first. */
	lastKey(sourceId: string): string | undefined {
		return this.records.get(sourceId)?.keys.at(-1)
	}

	private spectrumOwed(sourceId: string, key: string): boolean {
		const record = this.records.get(sourceId)
		return record?.adoptedBy === key && record.owed.has("spectrum")
	}

	/**
	 * Queues the owed spectrum adoption of the bound receiver once the store is writable. Never
	 * awaited by a load or a write (a switch may be waiting on the very open that reads).
	 */
	private kickAdoption(sourceId: string): void {
		const key = this.bound.get(sourceId) ?? null
		if (
			key === null ||
			!this.store ||
			!this.writable() ||
			this.adopting.has(sourceId) ||
			!this.spectrumOwed(sourceId, key)
		)
			return
		this.adopting.add(sourceId)
		void this.enqueue(sourceId, () => this.adoptOwed(sourceId)).finally(() =>
			this.adopting.delete(sourceId),
		)
	}

	/** The owed spectrum adoption, while its receiver is still the one bound and settled. */
	private async adoptOwed(sourceId: string): Promise<void> {
		const key = this.bound.get(sourceId) ?? null
		const store = this.store
		const record = this.records.get(sourceId)
		if (
			key === null ||
			!store ||
			!record ||
			this.pending.has(sourceId) ||
			!this.writable() ||
			!this.spectrumOwed(sourceId, key)
		)
			return
		this.switching.add(sourceId)
		try {
			const moved = await this.adoptSpectrum(sourceId, key, store, record)
			await this.saveRecords()
			// Every write or export started before the adoption is of the fresh state: dropped.
			this.bind(sourceId, key)
			// From the namespace when the legacy files moved in, or when an engine opened while the
			// adoption was owed (its load was refused: it runs fresh and must not overwrite the
			// namespace). Otherwise the engine already runs on this receiver's state: kept.
			if (this.spectrum && (moved || this.refusedLoads.has(sourceId))) {
				await this.spectrum.replaceLearnedState(
					sourceId,
					await this.loadNamespace(sourceId, key, store),
				)
				this.refusedLoads.delete(sourceId)
				// A persist that started between the bind and the swap exported the fresh state.
				this.bumpGeneration(sourceId)
			}
			const view = this.views.get(sourceId)
			if (view?.key === key)
				this.views.set(sourceId, {
					...view,
					learnedStateNamespace: store.receiverNamespacePath(sourceId, key),
					...(moved ? { namespaceState: "adopted" as const } : {}),
				})
		} finally {
			this.switching.delete(sourceId)
		}
	}

	/** Copies the spectrum files from before namespacing into `key`; the debt is paid either way. */
	private async adoptSpectrum(
		sourceId: string,
		key: string,
		store: ReceiverScopedStore,
		record: SourceRecord,
	): Promise<boolean> {
		const moved = await store
			.adoptLegacyInto(sourceId, key)
			.catch((err: unknown) => {
				this.log.warn(
					{ err, sourceId },
					"Adopting the learned state from before receiver namespacing failed",
				)
				return false
			})
		record.owed.delete("spectrum")
		return moved
	}

	/**
	 * The bound receiver's state, or null while unbound or switching (the switch then hands the
	 * state to the engine itself: it sees `refusedLoads`). While pending, the receiver bound before
	 * the boundary is read (read-only: writes are dropped until the settle). A read that a binding
	 * change overtook reads again for the binding now.
	 */
	private async loadBound<T>(
		sourceId: string,
		read: (key: string) => Promise<T | null>,
	): Promise<T | null> {
		for (let attempt = 0; attempt < 4; attempt++) {
			if (this.switching.has(sourceId)) {
				this.refusedLoads.add(sourceId)
				return null
			}
			const key = this.bound.get(sourceId) ?? null
			if (key === null) return null
			// Owed: the adoption hands the adopted state to the engine itself (never awaited here).
			if (this.spectrumOwed(sourceId, key)) {
				this.refusedLoads.add(sourceId)
				this.kickAdoption(sourceId)
				return null
			}
			const gen = this.generation.get(sourceId) ?? 0
			const value = await read(key)
			if ((this.generation.get(sourceId) ?? 0) === gen) return value
		}
		return null
	}

	/** A namespace's state: the held export when there is one, else the store's files. */
	private async loadNamespace(
		sourceId: string,
		key: string,
		store: ReceiverScopedStore,
	): Promise<LearnedSnapshot> {
		const held = this.held.get(sourceId)?.get(key)
		if (held) return { ...held }
		return {
			engine: await store.loadEngineIn(sourceId, key).catch(() => null),
			occupancy: await store.loadOccupancyIn(sourceId, key).catch(() => null),
		}
	}

	private bind(sourceId: string, key: string | null): void {
		this.bound.set(sourceId, key)
		this.bumpGeneration(sourceId)
	}

	private bumpGeneration(sourceId: string): void {
		this.generation.set(sourceId, (this.generation.get(sourceId) ?? 0) + 1)
	}

	view(sourceId: string): ReceiverNamespaceView | undefined {
		const v = this.views.get(sourceId)
		return v ? { ...v } : undefined
	}

	/** Resolves once every queued switch of the source finished (tests, shutdown). */
	idle(sourceId: string): Promise<void> {
		return this.chains.get(sourceId) ?? Promise.resolve()
	}

	/**
	 * A connection boundary of a tracked source (ReceiverIdentityTracker "connection": a
	 * disconnect or a new connection). From now until that connection's identity settles nothing
	 * learned is written; queued, the state learned so far is exported under the receiver it was
	 * learned on, and stays applied (read-only) until the settle decides.
	 */
	onConnection(sourceId: string, kind?: "open" | "close"): Promise<void> {
		if (!this.options.tracked(sourceId)) return Promise.resolve()
		if (kind === "open")
			this.opens.set(sourceId, (this.opens.get(sourceId) ?? 0) + 1)
		// Only the first boundary since the last settle exports: after it, what the engine learns
		// comes from a connection whose receiver is not known yet.
		const first = !this.pending.has(sourceId)
		this.pending.add(sourceId)
		this.boundaries.set(sourceId, (this.boundaries.get(sourceId) ?? 0) + 1)
		return first
			? this.enqueue(sourceId, () => this.suspend(sourceId))
			: (this.chains.get(sourceId) ?? Promise.resolve())
	}

	/**
	 * A settled identity (ReceiverIdentityTracker "settled": every settle, also of the same
	 * receiver again after a reconnect); serialised per source.
	 */
	onIdentity(
		sourceId: string,
		identity: ReceiverIdentity,
		previous: ReceiverIdentity | undefined,
	): Promise<void> {
		if (!this.options.tracked(sourceId)) return Promise.resolve()
		const boundary = this.boundaries.get(sourceId) ?? 0
		return this.enqueue(sourceId, () =>
			this.switchTo(sourceId, identity, previous, boundary),
		)
	}

	/**
	 * `sdrHostConfigured` may have turned false for the source (its auto-detected sdr-host never
	 * answered): the bound weak key adopts the state from before namespacing now when no receiver
	 * adopted it yet. Nothing happens while a connection is pending (its settle decides), for
	 * another key than the settled one, or when the adoption is not allowed yet.
	 */
	recheckAdoption(sourceId: string): Promise<void> {
		if (!this.options.tracked(sourceId)) return Promise.resolve()
		const boundary = this.boundaries.get(sourceId) ?? 0
		// Until it ran the adoption is still awaited: no write slips into the namespace before it.
		this.rechecks.set(sourceId, (this.rechecks.get(sourceId) ?? 0) + 1)
		return this.enqueue(sourceId, async () => {
			try {
				const identity = this.settledIdentity.get(sourceId)
				if (
					identity === undefined ||
					this.pending.has(sourceId) ||
					(this.boundaries.get(sourceId) ?? 0) !== boundary ||
					this.bound.get(sourceId) !== identity.key ||
					(this.records.get(sourceId)?.adoptedBy ?? null) !== null ||
					!this.mayAdopt(sourceId, identity)
				)
					return
				await this.switchTo(sourceId, identity, identity, boundary, true)
			} finally {
				const left = (this.rechecks.get(sourceId) ?? 1) - 1
				if (left > 0) this.rechecks.set(sourceId, left)
				else this.rechecks.delete(sourceId)
			}
		})
	}

	private enqueue(sourceId: string, task: () => Promise<void>): Promise<void> {
		const run = (this.chains.get(sourceId) ?? Promise.resolve())
			.then(task)
			.catch((err: unknown) =>
				this.log.warn({ err, sourceId }, "Switching the receiver state failed"),
			)
		this.chains.set(sourceId, run)
		void run.then(() => {
			if (this.chains.get(sourceId) === run) this.chains.delete(sourceId)
		})
		return run
	}

	/**
	 * The pending side of a connection boundary (queued after any switch before it): the state so
	 * far is exported under the bound receiver; the binding and the engine's state stay.
	 */
	private async suspend(sourceId: string): Promise<void> {
		const from = this.bound.get(sourceId) ?? null
		if (from === null) return
		this.switching.add(sourceId)
		try {
			await this.exportUnder(sourceId, from)
			this.options.onBound?.(sourceId, { key: null, adoptLegacy: false })
		} finally {
			this.switching.delete(sourceId)
		}
	}

	/**
	 * The spectrum's learned state now, under `key` (the receiver it was learned on): written when
	 * the store takes it, else held in memory until it does.
	 */
	private async exportUnder(sourceId: string, key: string): Promise<void> {
		if (!this.spectrum || this.adoptionAwaited(sourceId, key)) return
		const now = await this.spectrum.exportLearnedState(sourceId)
		if (now.engine === null && now.occupancy === null) return
		if (await this.writeSnapshot(sourceId, key, now)) {
			this.held.get(sourceId)?.delete(key)
			return
		}
		this.hold(sourceId, key, now)
	}

	/** True when every part was written (nothing to write counts as written). */
	private async writeSnapshot(
		sourceId: string,
		key: string,
		snap: LearnedSnapshot,
	): Promise<boolean> {
		const store = this.store
		if (!store || !this.writable()) return false
		let ok = true
		if (snap.engine)
			await store
				.writeEngineIn(sourceId, key, snap.engine)
				.catch((err: unknown) => {
					ok = false
					this.log.warn(
						{ err, sourceId },
						"Engine state write failed; kept in memory",
					)
				})
		if (snap.occupancy)
			await store
				.writeOccupancyIn(sourceId, key, snap.occupancy)
				.catch((err: unknown) => {
					ok = false
					this.log.warn(
						{ err, sourceId },
						"Occupancy write failed; kept in memory",
					)
				})
		return ok
	}

	private hold(sourceId: string, key: string, snap: LearnedSnapshot): void {
		let byKey = this.held.get(sourceId)
		if (!byKey) {
			byKey = new Map()
			this.held.set(sourceId, byKey)
		}
		byKey.delete(key)
		byKey.set(key, snap)
		while (byKey.size > HELD_EXPORTS_MAX) {
			const oldest = byKey.keys().next().value
			if (oldest === undefined) break
			byKey.delete(oldest)
			this.log.warn(
				{ sourceId, key: oldest },
				"Learned state of a receiver dropped: the store stayed unwritable across too many receiver switches",
			)
		}
	}

	/** Queues writing the held exports once the store takes them (one flush per source). */
	private flushHeldSoon(sourceId: string): void {
		if (
			!this.held.get(sourceId)?.size ||
			!this.store ||
			!this.writable() ||
			this.flushing.has(sourceId)
		)
			return
		this.flushing.add(sourceId)
		void this.enqueue(sourceId, () => this.flushHeld(sourceId)).finally(() =>
			this.flushing.delete(sourceId),
		)
	}

	private async flushHeld(sourceId: string): Promise<void> {
		const byKey = this.held.get(sourceId)
		if (!byKey) return
		for (const [key, snap] of [...byKey]) {
			// The bound key's state is the engine's own now: the normal persist writes it.
			if (key === this.bound.get(sourceId)) {
				byKey.delete(key)
				continue
			}
			if (!(await this.writeSnapshot(sourceId, key, snap))) return
			if (byKey.get(key) === snap) byKey.delete(key)
		}
		if (byKey.size === 0) this.held.delete(sourceId)
	}

	/**
	 * For the first stable key of a source with no adopter yet: the weak key of its model when it
	 * learned something (a file or a held export) and no legacy engine or occupancy file exists,
	 * else null: the legacy files win whatever their age. Reads file presence only.
	 */
	private async weakTakeOverChoice(
		sourceId: string,
		identity: ReceiverIdentity,
	): Promise<string | null> {
		const read = this.store?.learnedFileTimes?.bind(this.store)
		const record = this.records.get(sourceId)
		if (
			identity.strength !== "unit" ||
			identity.tunerType === undefined ||
			identity.gainCount === undefined ||
			read === undefined ||
			!record ||
			record.adoptedBy !== null ||
			record.keys.includes(identity.key)
		)
			return null
		const weak = sourceModelKey(sourceId, {
			tunerType: identity.tunerType,
			gainCount: identity.gainCount,
		})
		if (!record.keys.includes(weak) || record.takenOver.has(weak)) return null
		const times = (key: string | null) =>
			read(sourceId, key).catch(() => ({
				engine: null,
				occupancy: null,
			}))
		const held = this.held.get(sourceId)?.has(weak) === true
		const weakTimes = held ? null : await times(weak)
		if (
			!held &&
			(weakTimes === null ||
				(weakTimes.engine === null && weakTimes.occupancy === null))
		)
			return null
		const legacy = await times(null)
		return legacy.engine === null && legacy.occupancy === null ? weak : null
	}

	/** True when a weak key may adopt the legacy state: only a source without an sdr-host. */
	private mayAdopt(sourceId: string, identity: ReceiverIdentity): boolean {
		if (identity.strength === "unit") return true
		return (
			identity.strength === "model" &&
			this.options.sdrHostConfigured?.(sourceId) !== true
		)
	}

	private async switchTo(
		sourceId: string,
		identity: ReceiverIdentity,
		previous: ReceiverIdentity | undefined,
		boundary: number,
		recheck = false,
	): Promise<void> {
		const from = this.bound.get(sourceId) ?? null
		const to = identity.strength === "unknown" ? null : identity.key
		// The settle of a connection after a newer boundary: that one's settle binds.
		const stale = (this.boundaries.get(sourceId) ?? 0) !== boundary
		if (stale) return
		const wasPending = this.pending.has(sourceId)
		const opens = this.opens.get(sourceId) ?? 0
		this.opens.delete(sourceId)
		// Nothing changed (a repeated settle within one connection); a recheck may adopt.
		if (
			!recheck &&
			!wasPending &&
			from === to &&
			this.views.get(sourceId)?.key === identity.key
		)
			return
		this.switching.add(sourceId)
		try {
			const store = this.store
			// Read before the export below rewrites the weak namespace's files.
			const weakChoice =
				to === null ? null : await this.weakTakeOverChoice(sourceId, identity)
			// Within one connection (an upgrade) the state so far is the previous key's. After a
			// boundary it was exported then; what came since is the new connection's.
			if (!wasPending && from !== null && from !== to)
				await this.exportUnder(sourceId, from)
			let state: ReceiverNamespaceState = "none"
			let adoptLegacy = false
			let legacyRecorded = false
			let moved = false
			let takeOverFrom: string | null = null
			if (to !== null) {
				const record = this.records.get(sourceId) ?? {
					adoptedBy: null,
					keys: [],
					owed: new Set<Concern>(),
					takenOver: new Map<string, string>(),
				}
				const known = record.keys.includes(to)
				let changed = !this.records.has(sourceId) || record.keys.at(-1) !== to
				// The first eligible receiver is the adopter of record for every concern, even when a
				// concern cannot adopt now: no later receiver ever takes it over.
				if (record.adoptedBy === null && this.mayAdopt(sourceId, identity)) {
					record.adoptedBy = to
					record.owed = new Set(["spectrum", "gain"])
					changed = true
					// The first stable key of a source whose weak key learned meanwhile: the weak
					// state is taken over only when there are no legacy files (legacy wins). The
					// legacy pre-band gain stays owed and still comes first when it exists.
					if (
						weakChoice !== null &&
						!known &&
						!record.takenOver.has(weakChoice) &&
						record.keys.includes(weakChoice)
					) {
						takeOverFrom = weakChoice
						record.takenOver.set(weakChoice, to)
						record.owed.delete("spectrum")
					}
				}
				if (
					record.adoptedBy === to &&
					record.owed.has("spectrum") &&
					store &&
					this.writable()
				) {
					moved = await this.adoptSpectrum(sourceId, to, store, record)
					changed = true
				}
				// The pre-band gain needs no store: the tuner adopts it at this binding.
				if (record.adoptedBy === to && record.owed.delete("gain")) {
					adoptLegacy = true
					changed = true
				}
				// Take-over: a stable key new on this source that does not adopt the legacy state.
				if (
					takeOverFrom === null &&
					!known &&
					identity.strength === "unit" &&
					record.adoptedBy !== to &&
					identity.tunerType !== undefined &&
					identity.gainCount !== undefined
				) {
					const weak = sourceModelKey(sourceId, {
						tunerType: identity.tunerType,
						gainCount: identity.gainCount,
					})
					if (record.keys.includes(weak) && !record.takenOver.has(weak)) {
						takeOverFrom = weak
						record.takenOver.set(weak, to)
						changed = true
					}
				}
				state =
					moved || takeOverFrom !== null
						? "adopted"
						: known
							? "resumed"
							: "fresh"
				// A recheck that moved nothing keeps what the settle said.
				if (recheck && state !== "adopted")
					state = this.views.get(sourceId)?.namespaceState ?? state
				record.keys = [...record.keys.filter(k => k !== to), to].slice(
					-RECEIVER_NAMESPACES_MAX_KEYS,
				)
				this.records.set(sourceId, record)
				if (changed) legacyRecorded = await this.saveRecords()
			}
			this.bind(sourceId, to)
			this.pending.delete(sourceId)
			this.settledIdentity.set(sourceId, { ...identity })
			if (this.spectrum && store) {
				// Which state the engine runs from now; undefined: what it has (no swap).
				let next: LearnedSnapshot | undefined
				const refused = this.refusedLoads.has(sourceId)
				if (to === null) {
					if (from !== null || refused) next = { engine: null, occupancy: null }
				} else if (moved) next = await this.loadNamespace(sourceId, to, store)
				else if (takeOverFrom !== null) {
					if (from !== takeOverFrom || refused || (wasPending && opens > 1))
						next = await this.loadNamespace(sourceId, takeOverFrom, store)
				} else if (from !== to || refused || (wasPending && opens > 1))
					// More than one new connection since the last settle: what the engine learned in
					// memory meanwhile may be another receiver's; this receiver's saved state applies.
					next = await this.loadNamespace(sourceId, to, store)
				if (to !== null) this.held.get(sourceId)?.delete(to)
				this.refusedLoads.delete(sourceId)
				if (next !== undefined) {
					await this.spectrum.replaceLearnedState(sourceId, next)
					// A persist that started between the bind and the swap exported the previous state.
					this.bumpGeneration(sourceId)
				}
			}
			this.views.set(sourceId, {
				key: identity.key,
				strength: identity.strength,
				...(identity.tunerType !== undefined
					? { tunerType: identity.tunerType }
					: {}),
				...(identity.serial !== undefined ? { serial: identity.serial } : {}),
				learnedStateNamespace:
					to === null || !store
						? null
						: store.receiverNamespacePath(sourceId, to),
				namespaceState: state,
			})
			const binding: ReceiverBinding = adoptLegacy
				? { key: to, adoptLegacy, legacyRecorded }
				: { key: to, adoptLegacy }
			if (takeOverFrom !== null) binding.takeOverFrom = takeOverFrom
			this.options.onBound?.(sourceId, binding)
			// Keys are built from validated components only, so they are safe to log.
			const same = previous?.key === identity.key
			if (recheck)
				this.log.info(
					{ sourceId, key: identity.key, learnedState: state },
					"No sdr-host answered: the receiver identified by model adopts the learned state from before namespacing",
				)
			else
				this.log.info(
					{
						sourceId,
						from: previous?.key ?? "none",
						to: identity.key,
						strength: identity.strength,
						learnedState: state,
					},
					same
						? `Receiver reconnected: ${identity.key}; learned state ${state}`
						: `Receiver changed: ${previous?.key ?? "none"} -> ${identity.key}; learned state ${state}`,
				)
			if (identity.strength === "model" && !same)
				this.log.info(
					{ sourceId, key: identity.key },
					"Receiver identified by model only: learned state is shared by every dongle of this model on this source",
				)
		} finally {
			this.switching.delete(sourceId)
		}
		// Not writable yet (or no store): the owed spectrum adoption runs once it is.
		this.kickAdoption(sourceId)
		this.flushHeldSoon(sourceId)
	}

	/** True when the record file was written. */
	private saveRecords(): Promise<boolean> {
		const sources = [...this.records]
			.filter(([id]) => id.length <= SOURCE_ID_MAX_LENGTH)
			.slice(-RECEIVER_NAMESPACES_MAX_SOURCES)
			.map(([sourceId, r]) => ({
				sourceId,
				adoptedBy: r.adoptedBy,
				keys: r.keys,
				...(r.owed.size > 0 ? { owed: [...r.owed].sort() } : {}),
				...(r.takenOver.size > 0
					? {
							takenOver: [...r.takenOver]
								.slice(-RECEIVER_NAMESPACES_MAX_KEYS)
								.map(([from, by]) => ({ from, by })),
						}
					: {}),
			}))
		const text = JSON.stringify({ version: 1, sources }, null, "\t")
		const run = this.fileChain.then(() =>
			this.fs.atomicWrite(this.file, text).then(
				() => true,
				() => {
					this.log.warn(
						"Writing the receiver namespace record failed; kept in memory",
					)
					return false
				},
			),
		)
		this.fileChain = run
		return run
	}
}
