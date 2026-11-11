/**
 * Learned state per receiver (lane RS), inside the one state directory.
 *
 * A tracked source (rtl_tcp U8_IQ) has, per receiver key, its own namespace for the spectrum
 * engine state and occupancy (`<scanner dir>/engine/receivers/<source>/<key>/`); the pre-band
 * gain and the accepted tuning are namespaced by the tuner controller through `onBound`.
 * - same key as before: that namespace resumes;
 * - another key: its own namespace, nothing of another receiver's applied;
 * - a `model` key: only the same model key's state (logged as weak);
 * - `unknown`: nothing learned is applied (fresh in memory) and nothing is written.
 * Between a connection boundary (disconnect or connect, `onConnection`) and the new connection's
 * settled identity the source is pending: the state learned so far is written under the receiver
 * it was learned on, the engine runs fresh in memory, loads return nothing and writes are dropped,
 * so the next receiver's IQ never trains or reads the previous receiver's state.
 * The files from before namespacing are adopted once per source, by the first receiver
 * identified after the upgrade (`<stateDir>/receiver-namespaces.json` records it). Scanner
 * discoveries and recordings stay shared. A source the tracker does not follow keeps the
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
 * characters + quotes, commas and tab indentation, about 3.1 KiB) is about 50 KiB; 64 KiB bounds
 * the read before parse.
 */
export const RECEIVER_NAMESPACES_FILE_MAX_BYTES = 64 * 1024

const KeySchema = z
	.string()
	.max(RECEIVER_KEY_MAX_LENGTH)
	.refine(v => isReceiverKey(v))
const FileSchema = z
	.object({
		version: z.literal(1),
		sources: z
			.array(
				z
					.object({
						sourceId: z.string().min(1).max(SOURCE_ID_MAX_LENGTH),
						adoptedBy: KeySchema.nullable(),
						keys: z.array(KeySchema).max(RECEIVER_NAMESPACES_MAX_KEYS),
					})
					.strict(),
			)
			.max(RECEIVER_NAMESPACES_MAX_SOURCES),
	})
	.strict()

/** What the namespaced store needs (ScannerPersistence implements it). */
export interface ReceiverScopedStore extends SpectrumPersistence {
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
	/** True for the one identification that adopts the files from before namespacing. */
	adoptLegacy: boolean
}

export interface ReceiverLearnedStateOptions {
	stateDir: string
	logger: Logger
	/** Sources whose learned state is namespaced (the tracker follows them). */
	tracked: (sourceId: string) => boolean
	/** Learned state outside the spectrum (the tuner: pre-band gain, accepted tuning). */
	onBound?: (sourceId: string, binding: ReceiverBinding) => void
	fs?: {
		readFile: (path: string, maxBytes: number) => Promise<Buffer>
		atomicWrite: (path: string, data: string) => Promise<void>
	}
}

interface SourceRecord {
	adoptedBy: string | null
	keys: string[]
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
	/** The in-memory learned state is known fresh (unbound since the last boundary). */
	private readonly neutral = new Set<string>()
	private spectrum: LearnedSpectrum | null = null
	private store: ReceiverScopedStore | null = null
	private writable: () => boolean = () => true
	private fileChain: Promise<void> = Promise.resolve()

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
			parsed.data.sources.map(r => [
				r.sourceId,
				{ adoptedBy: r.adoptedBy, keys: [...r.keys] },
			]),
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
		return {
			writeEngine: async (sourceId, s) => {
				if (!this.options.tracked(sourceId))
					return legacy.writeEngine(sourceId, s)
				// Unknown receiver, pending or a switch in progress: nothing is written under any key.
				const key = this.writableKey(sourceId)
				if (key === null) return
				return store.writeEngineIn(sourceId, key, s)
			},
			loadEngine: async sourceId => {
				if (!this.options.tracked(sourceId)) return legacy.loadEngine(sourceId)
				return this.loadBound(sourceId, key =>
					store.loadEngineIn(sourceId, key),
				)
			},
			writeOccupancy: async (sourceId, s) => {
				if (!this.options.tracked(sourceId))
					return legacy.writeOccupancy(sourceId, s)
				const key = this.writableKey(sourceId)
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

	/** The key a write goes under now; null: dropped (unknown, pending, switching, gated). */
	private writableKey(sourceId: string): string | null {
		const key = this.bound.get(sourceId) ?? null
		if (
			key === null ||
			this.pending.has(sourceId) ||
			this.switching.has(sourceId) ||
			!this.writable()
		)
			return null
		return key
	}

	/**
	 * The bound receiver's state, or null while unbound, pending or switching (the switch then
	 * hands the state to the engine itself: replaceLearnedState waits for an open in flight). A
	 * read that a binding change overtook reads again for the binding now.
	 */
	private async loadBound<T>(
		sourceId: string,
		read: (key: string) => Promise<T | null>,
	): Promise<T | null> {
		for (let attempt = 0; attempt < 4; attempt++) {
			if (this.pending.has(sourceId) || this.switching.has(sourceId))
				return null
			const key = this.bound.get(sourceId) ?? null
			if (key === null) return null
			const gen = this.generation.get(sourceId) ?? 0
			const value = await read(key)
			if ((this.generation.get(sourceId) ?? 0) === gen) return value
		}
		return null
	}

	private bind(sourceId: string, key: string | null): void {
		this.bound.set(sourceId, key)
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
	 * learned is read or written; queued, the state learned so far is written under the receiver
	 * it was learned on and the engine continues fresh in memory.
	 */
	onConnection(sourceId: string): Promise<void> {
		if (!this.options.tracked(sourceId)) return Promise.resolve()
		this.pending.add(sourceId)
		this.boundaries.set(sourceId, (this.boundaries.get(sourceId) ?? 0) + 1)
		return this.enqueue(sourceId, () => this.unbind(sourceId))
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

	/** The pending side of a connection boundary (queued after any switch before it). */
	private async unbind(sourceId: string): Promise<void> {
		const from = this.bound.get(sourceId) ?? null
		this.switching.add(sourceId)
		try {
			if (from !== null) await this.exportUnder(sourceId, from)
			this.bind(sourceId, null)
			if (from !== null)
				this.options.onBound?.(sourceId, { key: null, adoptLegacy: false })
			if (this.spectrum && !this.neutral.has(sourceId)) {
				// Whatever is in memory belongs to the previous connection: the next one starts fresh.
				await this.spectrum.replaceLearnedState(sourceId, {
					engine: null,
					occupancy: null,
				})
				this.neutral.add(sourceId)
			}
		} finally {
			this.switching.delete(sourceId)
		}
	}

	/** Writes the spectrum's learned state now under `key` (the receiver it was learned on). */
	private async exportUnder(sourceId: string, key: string): Promise<void> {
		const store = this.store
		if (!this.spectrum || !store || !this.writable()) return
		const now = await this.spectrum.exportLearnedState(sourceId)
		if (now.engine)
			await store
				.writeEngineIn(sourceId, key, now.engine)
				.catch((err: unknown) =>
					this.log.warn({ err, sourceId }, "Engine state write failed"),
				)
		if (now.occupancy)
			await store
				.writeOccupancyIn(sourceId, key, now.occupancy)
				.catch((err: unknown) =>
					this.log.warn({ err, sourceId }, "Occupancy write failed"),
				)
	}

	private async switchTo(
		sourceId: string,
		identity: ReceiverIdentity,
		previous: ReceiverIdentity | undefined,
		boundary: number,
	): Promise<void> {
		const from = this.bound.get(sourceId) ?? null
		const to = identity.strength === "unknown" ? null : identity.key
		// The settle of a connection after a newer boundary: that one's settle binds.
		const stale = (this.boundaries.get(sourceId) ?? 0) !== boundary
		if (stale) return
		const wasPending = this.pending.has(sourceId)
		// Nothing changed (a repeated settle within one connection).
		if (
			!wasPending &&
			from === to &&
			this.views.get(sourceId)?.key === identity.key
		)
			return
		this.switching.add(sourceId)
		try {
			// The learned state so far belongs to the receiver it was learned on (nothing for unknown).
			const store = this.store
			if (from !== null && from !== to) await this.exportUnder(sourceId, from)
			let state: ReceiverNamespaceState = "none"
			let adoptLegacy = false
			if (to !== null) {
				const record = this.records.get(sourceId) ?? {
					adoptedBy: null,
					keys: [],
				}
				if (record.keys.includes(to)) state = "resumed"
				else if (record.adoptedBy === null && store && this.writable()) {
					// Only with the store: a core without the scanner leaves the adoption for later.
					adoptLegacy = true
					const moved = await store
						.adoptLegacyInto(sourceId, to)
						.catch((err: unknown) => {
							this.log.warn(
								{ err, sourceId },
								"Adopting the learned state from before receiver namespacing failed",
							)
							return false
						})
					state = moved ? "adopted" : "fresh"
					record.adoptedBy = to
				} else state = "fresh"
				record.keys = [...record.keys.filter(k => k !== to), to].slice(
					-RECEIVER_NAMESPACES_MAX_KEYS,
				)
				this.records.set(sourceId, record)
				await this.saveRecords()
			}
			this.bind(sourceId, to)
			this.pending.delete(sourceId)
			this.neutral.delete(sourceId)
			if (this.spectrum && store && from !== to) {
				const next =
					to === null
						? { engine: null, occupancy: null }
						: {
								engine: await store
									.loadEngineIn(sourceId, to)
									.catch(() => null),
								occupancy: await store
									.loadOccupancyIn(sourceId, to)
									.catch(() => null),
							}
				await this.spectrum.replaceLearnedState(sourceId, next)
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
			this.options.onBound?.(sourceId, { key: to, adoptLegacy })
			// Keys are built from validated components only, so they are safe to log.
			const same = previous?.key === identity.key
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
					"Receiver identified by model only: learned state is shared by every dongle of this model",
				)
		} finally {
			this.switching.delete(sourceId)
		}
	}

	private saveRecords(): Promise<void> {
		const sources = [...this.records]
			.filter(([id]) => id.length <= SOURCE_ID_MAX_LENGTH)
			.slice(-RECEIVER_NAMESPACES_MAX_SOURCES)
			.map(([sourceId, r]) => ({
				sourceId,
				adoptedBy: r.adoptedBy,
				keys: r.keys,
			}))
		const text = JSON.stringify({ version: 1, sources }, null, "\t")
		const run = this.fileChain.then(() =>
			this.fs.atomicWrite(this.file, text).catch(() => {
				this.log.warn(
					"Writing the receiver namespace record failed; kept in memory",
				)
			}),
		)
		this.fileChain = run
		return run
	}
}
