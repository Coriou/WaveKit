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
	/** Serialised switches per source; writes are dropped and loads wait while one runs. */
	private readonly chains = new Map<string, Promise<void>>()
	private readonly switching = new Set<string>()
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
				const key = this.bound.get(sourceId) ?? null
				// Unknown receiver or a switch in progress: nothing is written under any key.
				if (key === null || this.switching.has(sourceId) || !writable()) return
				return store.writeEngineIn(sourceId, key, s)
			},
			loadEngine: async sourceId => {
				if (!this.options.tracked(sourceId)) return legacy.loadEngine(sourceId)
				await this.idle(sourceId)
				const key = this.bound.get(sourceId) ?? null
				return key === null ? null : store.loadEngineIn(sourceId, key)
			},
			writeOccupancy: async (sourceId, s) => {
				if (!this.options.tracked(sourceId))
					return legacy.writeOccupancy(sourceId, s)
				const key = this.bound.get(sourceId) ?? null
				if (key === null || this.switching.has(sourceId) || !writable()) return
				return store.writeOccupancyIn(sourceId, key, s)
			},
			loadOccupancy: async sourceId => {
				if (!this.options.tracked(sourceId))
					return legacy.loadOccupancy(sourceId)
				await this.idle(sourceId)
				const key = this.bound.get(sourceId) ?? null
				return key === null ? null : store.loadOccupancyIn(sourceId, key)
			},
		}
	}

	view(sourceId: string): ReceiverNamespaceView | undefined {
		const v = this.views.get(sourceId)
		return v ? { ...v } : undefined
	}

	/** Resolves once every queued switch of the source finished (tests, shutdown). */
	idle(sourceId: string): Promise<void> {
		return this.chains.get(sourceId) ?? Promise.resolve()
	}

	/** A settled identity (ReceiverIdentityTracker "identity"); serialised per source. */
	onIdentity(
		sourceId: string,
		identity: ReceiverIdentity,
		previous: ReceiverIdentity | undefined,
	): Promise<void> {
		if (!this.options.tracked(sourceId)) return Promise.resolve()
		const run = (this.chains.get(sourceId) ?? Promise.resolve())
			.then(() => this.switchTo(sourceId, identity, previous))
			.catch((err: unknown) =>
				this.log.warn({ err, sourceId }, "Switching the receiver state failed"),
			)
		this.chains.set(sourceId, run)
		void run.then(() => {
			if (this.chains.get(sourceId) === run) this.chains.delete(sourceId)
		})
		return run
	}

	private async switchTo(
		sourceId: string,
		identity: ReceiverIdentity,
		previous: ReceiverIdentity | undefined,
	): Promise<void> {
		const from = this.bound.get(sourceId) ?? null
		const to = identity.strength === "unknown" ? null : identity.key
		this.switching.add(sourceId)
		try {
			// The learned state so far belongs to the receiver it was learned on (nothing for unknown).
			const store = this.store
			if (
				this.spectrum &&
				store &&
				from !== null &&
				from !== to &&
				this.writable()
			) {
				const now = await this.spectrum.exportLearnedState(sourceId)
				if (now.engine)
					await store
						.writeEngineIn(sourceId, from, now.engine)
						.catch((err: unknown) =>
							this.log.warn({ err, sourceId }, "Engine state write failed"),
						)
				if (now.occupancy)
					await store
						.writeOccupancyIn(sourceId, from, now.occupancy)
						.catch((err: unknown) =>
							this.log.warn({ err, sourceId }, "Occupancy write failed"),
						)
			}
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
			this.bound.set(sourceId, to)
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
			this.log.info(
				{
					sourceId,
					from: previous?.key ?? "none",
					to: identity.key,
					strength: identity.strength,
					learnedState: state,
				},
				`Receiver changed: ${previous?.key ?? "none"} -> ${identity.key}; learned state ${state}`,
			)
			if (identity.strength === "model")
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
