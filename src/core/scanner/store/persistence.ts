/**
 * Scanner persistence (spec § 8) under `scanner.storage.dir`:
 *
 * - `discoveries.json`: snapshot of discoveries + observations with `lastSeq` (atomic write);
 * - `journal/observations-YYYYMMDD.jsonl`: one line per store mutation, monotonic `seq`, UTC daily files;
 * - `jobs.json`: job specs, lifecycle state and the persisted lease (lifecycle changes only), plus
 *   `leases`: persisted leases whose job was deleted (their recovery still runs, H4);
 * - `settings.json`: runtime settings overrides; `engine/<sourceId>.json`: learned engine state;
 * - `engine/occupancy/<sourceId>.json`: occupancy history (Task 17a).
 *
 * Atomic writes follow the BandOverrideStore pattern (tmp + fsync + rename). All disk work runs on
 * one promise chain in call order; `append` assigns its seq synchronously. Every file read is
 * validated with Zod; a corrupt file never stops the core.
 */
import {
	appendFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	truncate,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { WaveKitError } from "../../../utils/errors.js"
import { createComponentLogger } from "../../../utils/logger.js"
import type { Logger } from "../../../utils/logger.js"
import type {
	Discovery,
	FailReason,
	JobState,
	NormalisedJobSpec,
	Observation,
	PauseReason,
} from "../types.js"
import type { StoredScanJobSpec } from "../plan/range-contract.js"
import type {
	Assert,
	EngineState,
	SchemaMatches,
} from "../../spectrum/types.js"
import { EngineStateSchema } from "../../spectrum/engine-state.js"
import { DEFAULT_CAPTURE } from "../evidence/capture-spec.js"
import {
	PreparedRecordingOperationsSchema,
	MAX_RECOVERY_OPERATIONS,
	samePreparedRecording,
} from "./recording-operation.js"
import type { PreparedRecordingMetadata } from "./recording-operation.js"
import type { StoreMutation } from "./schemas.js"
import type { JournalEntry, StoreSnapshot } from "./discovery-store.js"
import { OccupancyStateSchema } from "../../spectrum/occupancy.js"
import type { OccupancyState } from "../../spectrum/occupancy.js"
import {
	DiscoverySchema,
	ObservationSchema,
	ScannerClassSchema,
	ScannerProtocolSchema,
	StoreMutationSchema,
	DiscoveryAliasEntrySchema,
} from "./schemas.js"

const FILE_VERSION = 1
const SNAPSHOT_FILE = "discoveries.json"
const JOBS_FILE = "jobs.json"
const SETTINGS_FILE = "settings.json"
const JOURNAL_DIR = "journal"
const ENGINE_DIR = "engine"
/** A subdirectory, so readEngines (direct `engine/*.json` only) never sees these files. */
const OCCUPANCY_DIR = join(ENGINE_DIR, "occupancy")
const JOURNAL_NAME = /^observations-(\d{8})\.jsonl$/
const DAY_MS = 86_400_000
/** Queued journal text past which appends are refused (fail closed, bounded heap). */
const DEFAULT_MAX_JOURNAL_BACKLOG_BYTES = 32 * 1024 * 1024
/** Error code of an append refused because the journal backlog is full. */
export const SCANNER_JOURNAL_BACKLOG_CODE = "SCANNER_JOURNAL_BACKLOG"

export interface LeaseTunerFields {
	frequency: number
	sampleRate: number
	gainMode: "agc" | "manual"
	gain: number
	agcMode: boolean
}
export interface PersistedLease {
	sourceId: string
	jobId: string
	acquiredAt: number
	snapshot: Partial<LeaseTunerFields>
	changedFields: (keyof LeaseTunerFields)[]
}
export interface PersistedJob {
	id: string
	spec: NormalisedJobSpec
	rawSpec: StoredScanJobSpec
	state: JobState
	reason?: PauseReason | FailReason
	createdAt: string
	updatedAt: string
	lease?: PersistedLease
}
/**
 * Persisted runtime settings overrides (settings.json). Task 24 re-exports this schema as
 * ScannerSettingsPatchSchema (PATCH /api/scanner/settings body), so every loaded settings.json accepts
 * later patches.
 */
export type RuntimeSettingsOverrides = z.infer<
	typeof RuntimeSettingsOverridesSchema
>
export interface LoadedState {
	discoveries: Discovery[]
	observations: Observation[]
	/** Per-source § 7.4 corrections from the snapshot (`rekey` entries after it replay on top). */
	corrections: { sourceId: string; hz: number }[]
	lastSeq: number
	entries: JournalEntry[]
	jobs: PersistedJob[]
	/** Persisted leases whose job was deleted (jobs.json `leases`): crash recovery still restores them (H4). */
	leases: PersistedLease[]
	settings: RuntimeSettingsOverrides
	engines: Record<string, EngineState>
	droppedLines: number
	recordingOperations?: PreparedRecordingMetadata[]
	/** WG10 req 1.5: merge aliases from the snapshot (journal entries replay on top). */
	aliases?: { id: string; aliases: string[] }[]
	recoveryHealth: "healthy" | "degraded"
}

// ── schemas ──────────────────────────────────────────────────────────────

const RasterSchema = z.object({
	spacingHz: z.number().positive(),
	firstChannelHz: z.number(),
})
const ScanRangeSchema = z.object({
	startHz: z.number(),
	endHz: z.number(),
	rasters: z.array(RasterSchema).optional(),
	obwHz: z.array(z.number().positive()).optional(),
	protocols: z.array(ScannerProtocolSchema).optional(),
	bandplanId: z.string().optional(),
	// SF1: jobs persisted before these fields load unchanged (all optional)
	enabled: z.boolean().optional(),
	name: z.string().optional(),
	dwellMs: z.number().nonnegative().optional(),
	sensitivity: z.enum(["low", "normal", "high"]).optional(),
})
const ScanExclusionSchema = z.object({
	startHz: z.number(),
	endHz: z.number(),
	reason: z.string().optional(),
})

export const NormalisedJobSpecSchema = z.object({
	sourceId: z.string().min(1),
	sensitivity: z.enum(["low", "normal", "high"]),
	priority: z.number().min(0).max(100),
	mode: z.enum(["in-window", "sweep"]),
	// "identify" mirrors Task 1's NormalisedJobSpec (the SchemaMatches guard below needs it); identify jobs are
	// filtered out of persistJobs (Task 35a) and never written, so a persisted file never holds one
	kind: z.enum(["discover", "monitor", "identify"]),
	ranges: z.array(ScanRangeSchema),
	exclusions: z.array(ScanExclusionSchema),
	protocols: z.array(ScannerProtocolSchema),
	fftSize: z.number().int().positive(),
	integrationMs: z.number().positive(),
	thresholdDb: z.number().nullable(),
	dwellMs: z.number().nonnegative(),
	settleMs: z.number().nonnegative(),
	hold: z.object({
		policy: z.enum(["hold", "confirm", "never"]),
		confirmHoldMs: z.record(ScannerClassSchema, z.number().nonnegative()),
		maxHoldMs: z.number().nonnegative(),
		hangMs: z.number().nonnegative(),
	}),
	revisit: z.object({
		share: z.number().min(0).max(1),
		maxIntervalMs: z.number().positive().nullable(),
	}),
	record: z.object({
		voice: z.boolean(),
		analog: z.boolean(),
		data: z.boolean(),
	}),
	evidence: z.object({ psd: z.boolean(), iq: z.boolean() }),
	tuner: z.object({
		sampleRateHz: z.number().positive().nullable(),
		gainTenthsDb: z.number().nullable(),
		agc: z.boolean().nullable(),
		overload: z.enum(["flag", "reduce-gain"]),
	}),
	stop: z.object({
		afterSweeps: z.number().int().positive().nullable(),
		afterMs: z.number().positive().nullable(),
		onFirstDecoded: z.boolean(),
	}),
	takeover: z.boolean(),
	resume: z.object({
		autoAfterIdleMs: z.number().nonnegative().nullable(),
		onBoot: z.boolean(),
	}),
	txDurationHintMs: z.number().nonnegative(),
	// Jobs persisted before Task 34a carry no capture option and load with the default (off)
	capture: z
		.object({
			enabled: z.boolean(),
			mode: z.enum(["wideband", "channel"]),
			preMs: z.number().int().min(0).max(5000),
			postMs: z.number().int().min(0).max(10_000),
			onlyDecoded: z.boolean(),
			maxPerHour: z.number().int().min(1).max(60),
		})
		.default(() => ({ ...DEFAULT_CAPTURE })),
	// SF1: absent on jobs persisted before signals-only existed (= false)
	signalsOnly: z.boolean().optional(),
	// WG6: absent on jobs persisted before WG6 (= false)
	skipDecodedElsewhere: z.boolean().optional(),
	// WG7: absent on jobs persisted before WG7 (= false)
	skipBandPlanSkips: z.boolean().optional(),
	provenance: z.record(
		z.enum(["operator", "bandplan", "measured", "config", "default"]),
	),
})
export type NormalisedJobSpecCheck = Assert<
	SchemaMatches<NormalisedJobSpec, typeof NormalisedJobSpecSchema>
>

const LEASE_FIELDS = [
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
	"agcMode",
] as const
const PersistedLeaseSchema = z.object({
	sourceId: z.string().min(1),
	jobId: z.string().min(1),
	acquiredAt: z.number(),
	snapshot: z.object({
		frequency: z.number().optional(),
		sampleRate: z.number().optional(),
		gainMode: z.enum(["agc", "manual"]).optional(),
		gain: z.number().optional(),
		agcMode: z.boolean().optional(),
	}),
	changedFields: z.array(z.enum(LEASE_FIELDS)),
})
export type PersistedLeaseCheck = Assert<
	SchemaMatches<PersistedLease, typeof PersistedLeaseSchema>
>

const PersistedJobSchema = z.object({
	id: z.string().min(1),
	spec: NormalisedJobSpecSchema,
	/** Checked as a plain object only; the job runner re-validates it with the REST schema (Task 36). */
	rawSpec: z.custom<StoredScanJobSpec>(
		v => typeof v === "object" && v !== null && !Array.isArray(v),
	),
	state: z.enum([
		"pending",
		"starting",
		"running",
		"holding",
		"paused",
		"completed",
		"cancelled",
		"failed",
	]),
	reason: z
		.enum([
			"operator",
			"preempted-operator",
			"preempted-relay",
			"preempted-job",
			"source-down",
			"core-restart",
			"resume-blocked",
			"source-removed",
			"tuner-unavailable",
			"invalid",
		])
		.optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
	lease: PersistedLeaseSchema.optional(),
})
export type PersistedJobCheck = Assert<
	SchemaMatches<PersistedJob, typeof PersistedJobSchema>
>

/**
 * Task 24 re-exports this schema as ScannerSettingsPatchSchema (PATCH /api/scanner/settings body), so
 * every loaded settings.json accepts later patches. Keys are the spec § 12.1 runtime-safe settings.
 */
export const RuntimeSettingsOverridesSchema = z
	.object({
		passive: z.record(z.string().min(1), z.boolean()).optional(),
		cpuBudgetCores: z.number().min(0.1).max(64).optional(),
		maxProbes: z
			.object({
				offset: z.number().int().min(0).max(16).optional(),
				channel: z.number().int().min(0).max(64).optional(),
			})
			.strict()
			.optional(),
		detection: z
			.object({
				integrationMs: z.number().min(5).max(1000).optional(),
				sensitivity: z.enum(["low", "normal", "high"]).optional(),
				faTargetPerMhzMin: z.number().min(0.01).max(1000).optional(),
				hysteresisDb: z.number().min(0).max(20).optional(),
				minSurfaceBlocks: z.number().int().min(1).max(20).optional(),
			})
			.strict()
			.optional(),
		storage: z
			.object({
				maxRecordingsMb: z.number().int().min(1).max(1_000_000).optional(),
				maxEvidenceMb: z.number().int().min(1).max(100_000).optional(),
				maxJournalMb: z.number().int().min(1).max(10_000).optional(),
				maxAgeDays: z.number().int().min(1).max(3650).optional(),
				discoveryMaxAgeDays: z.number().int().min(1).max(3650).optional(),
				minFreeDiskMb: z.number().int().min(0).max(1_000_000).optional(),
				maxDiscoveries: z.number().int().min(1).max(1_000_000).optional(),
				maxCapturesMb: z.number().int().min(1).max(100_000).optional(),
			})
			.strict()
			.optional(),
		ws: z
			.object({
				maxMessagesPerSecond: z.number().int().min(1).max(100).optional(),
				spectrumHz: z.number().min(0.5).max(25).optional(),
				spectrumBins: z.number().int().min(128).max(2048).optional(),
			})
			.strict()
			.optional(),
	})
	.strict()

const SnapshotFileSchema = z
	.object({
		version: z.literal(FILE_VERSION),
		lastSeq: z.number().int().nonnegative(),
		recordingOperations: PreparedRecordingOperationsSchema.optional(),
		savedAt: z.string(),
		discoveries: z.array(DiscoverySchema),
		observations: z.array(ObservationSchema),
		corrections: z
			.array(z.object({ sourceId: z.string().min(1), hz: z.number() }))
			.default([]),
		aliases: z.array(DiscoveryAliasEntrySchema).optional(),
	})
	.strict()
const JobsFileSchema = z.object({
	version: z.literal(FILE_VERSION),
	jobs: z.array(PersistedJobSchema),
	leases: z.array(PersistedLeaseSchema).optional(),
})
const SettingsFileSchema = z.object({
	version: z.literal(FILE_VERSION),
	settings: RuntimeSettingsOverridesSchema,
})
const JournalLineSchema = z.object({
	seq: z.number().int().positive(),
	at: z.string(),
	op: z.enum([
		"observation",
		"evidence",
		"classification",
		"operator",
		"delete",
		"rekey",
		"evict",
	]),
	payload: StoreMutationSchema,
})

// ── helpers ──────────────────────────────────────────────────────────────

function errorCode(err: unknown): string | undefined {
	if (err !== null && typeof err === "object" && "code" in err) {
		const code = (err as { code: unknown }).code
		return typeof code === "string" ? code : undefined
	}
	return undefined
}

function dayStamp(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10).replaceAll("-", "")
}

function journalName(ms: number): string {
	return `observations-${dayStamp(ms)}.jsonl`
}

/** Tmp file + fsync + rename, as in BandOverrideStore.write. Also used by the EvidenceStore (Task 17). */
export async function atomicWrite(
	file: string,
	data: string | Uint8Array,
): Promise<void> {
	const tmp = `${file}.${process.pid}.tmp`
	try {
		await mkdir(dirname(file), { recursive: true })
		const handle = await open(tmp, "w")
		try {
			await handle.writeFile(data)
			await handle.sync()
		} finally {
			await handle.close()
		}
		await rename(tmp, file)
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => undefined)
		throw new WaveKitError(
			`Could not write ${file}`,
			"SCANNER_PERSIST_FAILED",
			err instanceof Error ? err : undefined,
		)
	}
}

type JsonRead =
	| { kind: "missing" }
	| { kind: "invalid"; reason: unknown }
	| { kind: "ok"; value: unknown }

async function readJson(file: string): Promise<JsonRead> {
	let text: string
	try {
		text = await readFile(file, "utf8")
	} catch (err) {
		if (errorCode(err) === "ENOENT") return { kind: "missing" }
		return { kind: "invalid", reason: err }
	}
	try {
		return { kind: "ok", value: JSON.parse(text) as unknown }
	} catch (err) {
		return { kind: "invalid", reason: err }
	}
}

function parseJournalLine(line: string): JournalEntry | null {
	let raw: unknown
	try {
		raw = JSON.parse(line)
	} catch {
		return null
	}
	const parsed = JournalLineSchema.safeParse(raw)
	return parsed.success ? parsed.data : null
}

/** Journal lines written together by one append (group commit). */
interface JournalBatch {
	name: string
	lines: string[]
	bytes: number
	maxSeq: number
	written: Promise<void>
}

/** A queued snapshot write; `text` is dropped once written or superseded. */
interface SnapshotSlot {
	text: string | null
	lastSeq: number
	/** The newer write that superseded this one; its settlement is this one's. */
	successor: Promise<void> | null
}

export class ScannerPersistence {
	private readonly root: string
	private readonly log: Logger
	private readonly now: () => number
	private readonly appendFile: (path: string, data: string) => Promise<void>
	private readonly fileMaxSeq = new Map<string, number>()
	private readonly fileBytes = new Map<string, number>()
	private chain: Promise<unknown> = Promise.resolve()
	/** The newest snapshot still waiting on the chain; a later one supersedes it (bounded backlog). */
	private queuedSnapshot: SnapshotSlot | null = null
	/** The journal batch at the chain's tail, still collecting lines (group commit). */
	private openBatch: JournalBatch | null = null
	/** Journal lines and their bytes enqueued but not yet written or failed (`backlog()`). */
	private queuedLines = 0
	private queuedBytes = 0
	private backlogFull = false
	private readonly maxJournalBacklogBytes: number
	private nextSeq = 1
	private durableLastSeq = 0
	private loaded = false
	private authorityHealth: "healthy" | "degraded" = "degraded"

	/** S1 can load fallback state; Task42 must require complete restored authority. */
	recoveryHealth(): "healthy" | "degraded" {
		return this.authorityHealth
	}

	/**
	 * `appendFile` is injectable for the short-write test; default `fs/promises.appendFile`.
	 * `maxJournalBacklogBytes`: queued journal text past which appends are refused (default 32 MiB).
	 */
	constructor(opts: {
		dir: string
		logger: Logger
		now: () => number
		appendFile?: (path: string, data: string) => Promise<void>
		maxJournalBacklogBytes?: number
	}) {
		this.maxJournalBacklogBytes =
			opts.maxJournalBacklogBytes ?? DEFAULT_MAX_JOURNAL_BACKLOG_BYTES
		this.root = resolve(opts.dir)
		this.log = createComponentLogger(opts.logger, "ScannerPersistence")
		this.now = opts.now
		this.appendFile =
			opts.appendFile ?? ((path, data) => appendFile(path, data))
	}

	async load(): Promise<LoadedState> {
		try {
			return await this.loadState()
		} catch (err) {
			this.authorityHealth = "degraded"
			this.loaded = false
			throw err
		}
	}

	private async loadState(): Promise<LoadedState> {
		this.authorityHealth = "healthy"
		this.loaded = false
		this.fileMaxSeq.clear()
		this.fileBytes.clear()
		const snapshot = await this.readSnapshot()
		const journal = await this.readJournal(snapshot.lastSeq)
		this.validateRecordingReplay(
			snapshot.recordingOperations ?? [],
			journal.entries,
		)
		const { jobs, leases } = await this.readJobs()
		const settings = await this.readSettings()
		const engines = await this.readEngines()
		this.durableLastSeq = snapshot.lastSeq
		this.nextSeq = Math.max(snapshot.lastSeq, journal.maxSeq) + 1
		this.loaded = true
		this.log.info(
			{
				dir: this.root,
				discoveries: snapshot.discoveries.length,
				lastSeq: snapshot.lastSeq,
				replay: journal.entries.length,
				dropped: journal.dropped,
			},
			"Loaded scanner state",
		)
		return {
			discoveries: snapshot.discoveries,
			observations: snapshot.observations,
			corrections: snapshot.corrections,
			lastSeq: snapshot.lastSeq,
			entries: journal.entries,
			jobs,
			leases,
			settings,
			engines,
			droppedLines: journal.dropped,
			recordingOperations: snapshot.recordingOperations ?? [],
			...(snapshot.aliases ? { aliases: snapshot.aliases } : {}),
			recoveryHealth: this.authorityHealth,
		}
	}

	/**
	 * Jobs, runtime settings and engine state alone, independent of the snapshot and the journal:
	 * ScannerService's fallback when load() rejects (Task 35 fix round). The readers never throw.
	 * Never marks the state loaded, so journal and snapshot writes stay refused.
	 */
	async loadConfig(): Promise<
		Pick<LoadedState, "jobs" | "leases" | "settings" | "engines">
	> {
		const { jobs, leases } = await this.readJobs()
		const settings = await this.readSettings()
		const engines = await this.readEngines()
		return { jobs, leases, settings, engines }
	}

	/**
	 * Group commit: lines appended while the chain is busy join one batch, written by a single
	 * append when its turn comes, so a slow disk or a busy event loop cannot queue one chain step
	 * per line. Fail closed past `maxJournalBacklogBytes`: the append is refused (the next snapshot
	 * still carries the mutation) instead of growing the heap without bound.
	 */
	append(entry: Omit<JournalEntry, "seq">): Promise<number> {
		if (!this.loaded) return Promise.reject(notLoaded())
		const seq = this.nextSeq++
		const line = `${JSON.stringify({ seq, at: entry.at, op: entry.op, payload: entry.payload })}\n`
		if (this.queuedBytes + line.length > this.maxJournalBacklogBytes) {
			if (!this.backlogFull) {
				this.backlogFull = true
				this.log.warn(
					{ queuedBytes: this.queuedBytes, seq },
					"Journal backlog full; refusing appends until it drains",
				)
			}
			return Promise.reject(
				new WaveKitError(
					"Scanner journal backlog full",
					SCANNER_JOURNAL_BACKLOG_CODE,
				),
			)
		}
		const name = journalName(this.now())
		let batch = this.openBatch
		if (batch === null || batch.name !== name) {
			const fresh: JournalBatch = {
				name,
				lines: [],
				bytes: 0,
				maxSeq: 0,
				written: Promise.resolve(),
			}
			fresh.written = this.enqueue(() => this.writeBatch(fresh))
			// After enqueue, which closes any earlier batch: only the chain's tail collects lines.
			this.openBatch = fresh
			batch = fresh
		}
		batch.lines.push(line)
		batch.bytes += line.length
		batch.maxSeq = seq
		this.queuedLines += 1
		this.queuedBytes += line.length
		return batch.written.then(() => seq)
	}

	private async writeBatch(batch: JournalBatch): Promise<void> {
		if (this.openBatch === batch) this.openBatch = null
		const text = batch.lines.join("")
		this.queuedLines -= batch.lines.length
		batch.lines = []
		const dir = join(this.root, JOURNAL_DIR)
		const path = join(dir, batch.name)
		const knownBytes = this.fileBytes.get(batch.name) ?? 0 // load() sized every existing file; a new file is 0
		try {
			await mkdir(dir, { recursive: true })
			await this.appendFile(path, text)
		} catch (err) {
			// A partial line would glue onto the next one and lose both at load: cut back to the known size.
			await truncate(path, knownBytes).catch(() => undefined)
			this.log.warn(
				{ err, file: path, seq: batch.maxSeq },
				"Journal append failed; truncated the partial line",
			)
			throw new WaveKitError(
				`Could not append to ${path}`,
				"SCANNER_PERSIST_FAILED",
				err instanceof Error ? err : undefined,
			)
		} finally {
			this.queuedBytes -= batch.bytes
			if (this.backlogFull && this.queuedBytes === 0) {
				this.backlogFull = false
				this.log.info("Journal backlog drained; appends accepted again")
			}
		}
		this.fileMaxSeq.set(
			batch.name,
			Math.max(this.fileMaxSeq.get(batch.name) ?? 0, batch.maxSeq),
		)
		this.fileBytes.set(batch.name, knownBytes + Buffer.byteLength(text))
	}

	writeSnapshot(s: StoreSnapshot): Promise<void> {
		if (!this.loaded) return Promise.reject(notLoaded())
		const prepared = PreparedRecordingOperationsSchema.safeParse(
			s.recordingOperations ?? [],
		)
		if (!prepared.success)
			return Promise.reject(
				new WaveKitError(
					"Invalid recording snapshot",
					"SCANNER_JOURNAL_INVALID",
				),
			)
		const lastSeq = this.nextSeq - 1
		const text = JSON.stringify({
			version: FILE_VERSION,
			lastSeq,
			savedAt: new Date(this.now()).toISOString(),
			discoveries: s.discoveries,
			observations: s.observations,
			corrections: s.corrections,
			recordingOperations: prepared.data,
			...(s.aliases && s.aliases.length > 0 ? { aliases: s.aliases } : {}),
		})
		// A slow disk must not queue one full-store text per call (the 2 GB heap OOM): a newer
		// snapshot supersedes one that has not started, which drops its text and settles with the
		// newer write. The newest keeps its own place after every append up to its lastSeq.
		const slot: SnapshotSlot = { text, lastSeq, successor: null }
		const superseded = this.queuedSnapshot
		this.queuedSnapshot = slot
		const own = this.enqueue(async () => {
			if (this.queuedSnapshot === slot) this.queuedSnapshot = null
			const body = slot.text
			if (body === null) return
			slot.text = null
			await atomicWrite(join(this.root, SNAPSHOT_FILE), body)
			this.durableLastSeq = Math.max(this.durableLastSeq, slot.lastSeq)
		})
		const done = own.then(() => slot.successor ?? undefined)
		if (superseded) {
			superseded.text = null
			superseded.successor = done
		}
		return done
	}

	/** Disk work still queued: at most one snapshot text whatever the disk speed. */
	backlog(): {
		snapshots: number
		snapshotBytes: number
		journalLines: number
		journalBytes: number
	} {
		const text = this.queuedSnapshot?.text ?? null
		return {
			snapshots: text === null ? 0 : 1,
			snapshotBytes: text === null ? 0 : text.length,
			journalLines: this.queuedLines,
			journalBytes: this.queuedBytes,
		}
	}

	/** `leases`: persisted leases whose job is gone (written only when there are some). */
	writeJobs(
		jobs: PersistedJob[],
		leases: PersistedLease[] = [],
	): Promise<void> {
		const text = JSON.stringify(
			{ version: FILE_VERSION, jobs, ...(leases.length > 0 ? { leases } : {}) },
			null,
			"\t",
		)
		return this.enqueue(() => atomicWrite(join(this.root, JOBS_FILE), text))
	}

	writeSettings(s: RuntimeSettingsOverrides): Promise<void> {
		const text = JSON.stringify(
			{ version: FILE_VERSION, settings: s },
			null,
			"\t",
		)
		return this.enqueue(() => atomicWrite(join(this.root, SETTINGS_FILE), text))
	}

	writeEngine(sourceId: string, s: EngineState): Promise<void> {
		const text = JSON.stringify(s)
		return this.enqueue(() => atomicWrite(this.engineFile(sourceId), text))
	}

	writeOccupancy(sourceId: string, s: OccupancyState): Promise<void> {
		const text = JSON.stringify(s)
		return this.enqueue(() => atomicWrite(this.occupancyFile(sourceId), text))
	}

	/** One source's occupancy history; null when missing or invalid (logged). Does not need load(). */
	async loadOccupancy(sourceId: string): Promise<OccupancyState | null> {
		const file = this.occupancyFile(sourceId)
		const read = await readJson(file)
		if (read.kind === "missing") return null
		const parsed =
			read.kind === "ok" ? OccupancyStateSchema.safeParse(read.value) : null
		if (parsed === null || !parsed.success) {
			this.log.warn(
				{
					file,
					issues: parsed?.success === false ? parsed.error.issues : undefined,
					err: read.kind === "invalid" ? read.reason : undefined,
				},
				"Ignoring an invalid occupancy history file",
			)
			return null
		}
		return parsed.data
	}

	/** One source's engine state; null when missing or invalid (logged). Does not need load(). */
	loadEngine(sourceId: string): Promise<EngineState | null> {
		return this.readEngineFile(this.engineFile(sourceId))
	}

	pruneJournal(caps: {
		maxBytes: number
		maxAgeDays: number
	}): Promise<{ deleted: string[] }> {
		return this.enqueue(async () => {
			const dir = join(this.root, JOURNAL_DIR)
			const deleted: string[] = []
			const deletable = (name: string): boolean =>
				(this.fileMaxSeq.get(name) ?? 0) <= this.durableLastSeq
			const remove = async (name: string): Promise<void> => {
				await rm(join(dir, name), { force: true })
				this.fileMaxSeq.delete(name)
				this.fileBytes.delete(name)
				deleted.push(name)
			}
			const cutoff = dayStamp(this.now() - caps.maxAgeDays * DAY_MS)
			for (const name of [...this.fileMaxSeq.keys()].sort()) {
				const day = JOURNAL_NAME.exec(name)?.[1]
				if (day !== undefined && day < cutoff && deletable(name))
					await remove(name)
			}
			let total = 0
			for (const bytes of this.fileBytes.values()) total += bytes
			for (const name of [...this.fileMaxSeq.keys()].sort()) {
				if (total <= caps.maxBytes) break
				if (!deletable(name)) continue
				total -= this.fileBytes.get(name) ?? 0
				await remove(name)
			}
			if (deleted.length > 0)
				this.log.info(
					{ deleted, durableLastSeq: this.durableLastSeq },
					"Pruned scanner journal",
				)
			return { deleted }
		})
	}

	private engineFile(sourceId: string): string {
		return join(this.root, ENGINE_DIR, `${encodeURIComponent(sourceId)}.json`)
	}

	private occupancyFile(sourceId: string): string {
		return join(
			this.root,
			OCCUPANCY_DIR,
			`${encodeURIComponent(sourceId)}.json`,
		)
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		this.openBatch = null
		const next = this.chain.then(fn)
		this.chain = next.catch(() => undefined)
		return next
	}

	/** Sets an unreadable file aside so the next write cannot destroy what an operator may still recover from it. */
	private async moveAside(file: string): Promise<string> {
		const aside = `${file}.invalid-${this.now()}`
		await rename(file, aside).catch(() => undefined)
		return aside
	}

	private async readSnapshot(): Promise<StoreSnapshot & { lastSeq: number }> {
		const file = join(this.root, SNAPSHOT_FILE)
		const empty = {
			discoveries: [],
			observations: [],
			corrections: [],
			lastSeq: 0,
		}
		const read = await readJson(file)
		if (read.kind === "missing") return empty
		const parsed =
			read.kind === "ok" ? SnapshotFileSchema.safeParse(read.value) : null
		if (parsed === null || !parsed.success) {
			this.authorityHealth = "degraded"
			const aside = await this.moveAside(file)
			this.log.warn(
				{
					file,
					movedTo: aside,
					issues: parsed?.success === false ? parsed.error.issues : undefined,
					err: read.kind === "invalid" ? read.reason : undefined,
				},
				"Scanner snapshot is invalid; starting from the journal alone",
			)
			return empty
		}
		return {
			discoveries: parsed.data.discoveries as Discovery[],
			observations: parsed.data.observations as Observation[],
			corrections: parsed.data.corrections,
			recordingOperations: parsed.data.recordingOperations ?? [],
			...(parsed.data.aliases ? { aliases: parsed.data.aliases } : {}),
			lastSeq: parsed.data.lastSeq,
		}
	}

	private async readJournal(
		lastSeq: number,
	): Promise<{ entries: JournalEntry[]; maxSeq: number; dropped: number }> {
		const dir = join(this.root, JOURNAL_DIR)
		let names: string[]
		try {
			names = (await readdir(dir)).filter(n => JOURNAL_NAME.test(n)).sort()
		} catch (err) {
			if (errorCode(err) !== "ENOENT") {
				this.authorityHealth = "degraded"
				this.log.warn({ err, dir }, "Scanner journal directory unreadable")
			}
			return { entries: [], maxSeq: 0, dropped: 0 }
		}
		const bySeq = new Map<number, JournalEntry>()
		let maxSeq = 0
		let dropped = 0
		for (const name of names) {
			const path = join(dir, name)
			let text = await readFile(path, "utf8")
			if (text.length > 0 && !text.endsWith("\n")) {
				const keep = text.slice(0, text.lastIndexOf("\n") + 1)
				dropped++
				this.authorityHealth = "degraded"
				this.log.warn(
					{
						file: path,
						tornBytes: Buffer.byteLength(text) - Buffer.byteLength(keep),
					},
					"Dropping a torn final journal line",
				)
				await truncate(path, Buffer.byteLength(keep))
				text = keep
			}
			let fileMax = 0
			for (const line of text.split("\n")) {
				if (line === "") continue
				const parsed = parseJournalLine(line)
				if (parsed === null) {
					dropped++
					this.authorityHealth = "degraded"
					this.log.warn({ file: path }, "Skipping an invalid journal line")
					continue
				}
				fileMax = Math.max(fileMax, parsed.seq)
				if (parsed.seq > lastSeq) {
					const previous = bySeq.get(parsed.seq)
					if (
						previous !== undefined &&
						JSON.stringify(previous) !== JSON.stringify(parsed)
					) {
						this.authorityHealth = "degraded"
						dropped++
					} else if (previous === undefined) bySeq.set(parsed.seq, parsed)
				}
			}
			this.fileMaxSeq.set(name, fileMax)
			this.fileBytes.set(name, Buffer.byteLength(text))
			maxSeq = Math.max(maxSeq, fileMax)
		}
		return {
			entries: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
			maxSeq,
			dropped,
		}
	}

	/** Validate aggregate prepared authority across snapshot+journal without changing S1 fallback. */
	private validateRecordingReplay(
		snapshot: PreparedRecordingMetadata[],
		entries: JournalEntry[],
	): void {
		const operations = new Map(
			snapshot.map(record => [record.operationId, record]),
		)
		for (const entry of entries) {
			const patch = (entry.payload as StoreMutation).preparedRecordingOperations
			if (patch === undefined) continue
			const next = new Map(operations)
			for (const id of patch.remove) next.delete(id)
			for (const record of patch.add) {
				const old = next.get(record.operationId)
				if (old !== undefined && !samePreparedRecording(old, record)) {
					this.authorityHealth = "degraded"
					return
				}
				next.set(record.operationId, record)
			}
			if (next.size > MAX_RECOVERY_OPERATIONS) {
				this.authorityHealth = "degraded"
				return
			}
			operations.clear()
			for (const [id, record] of next) operations.set(id, record)
		}
	}

	private async readJobs(): Promise<{
		jobs: PersistedJob[]
		leases: PersistedLease[]
	}> {
		const file = join(this.root, JOBS_FILE)
		const read = await readJson(file)
		if (read.kind === "missing") return { jobs: [], leases: [] }
		const parsed =
			read.kind === "ok" ? JobsFileSchema.safeParse(read.value) : null
		if (parsed === null || !parsed.success) {
			const aside = await this.moveAside(file)
			this.log.warn(
				{
					file,
					movedTo: aside,
					issues: parsed?.success === false ? parsed.error.issues : undefined,
					err: read.kind === "invalid" ? read.reason : undefined,
				},
				"Scanner jobs file is invalid; starting with no jobs",
			)
			return { jobs: [], leases: [] }
		}
		return {
			jobs: parsed.data.jobs as PersistedJob[],
			leases: (parsed.data.leases ?? []) as PersistedLease[],
		}
	}

	private async readSettings(): Promise<RuntimeSettingsOverrides> {
		const file = join(this.root, SETTINGS_FILE)
		const read = await readJson(file)
		if (read.kind === "missing") return {}
		const parsed =
			read.kind === "ok" ? SettingsFileSchema.safeParse(read.value) : null
		if (parsed === null || !parsed.success) {
			const aside = await this.moveAside(file)
			this.log.warn(
				{
					file,
					movedTo: aside,
					issues: parsed?.success === false ? parsed.error.issues : undefined,
					err: read.kind === "invalid" ? read.reason : undefined,
				},
				"Scanner settings file is invalid; using config values",
			)
			return {}
		}
		return parsed.data.settings as RuntimeSettingsOverrides
	}

	private async readEngines(): Promise<Record<string, EngineState>> {
		const dir = join(this.root, ENGINE_DIR)
		let names: string[]
		try {
			names = (await readdir(dir)).filter(n => n.endsWith(".json"))
		} catch (err) {
			if (errorCode(err) !== "ENOENT")
				this.log.warn({ err, dir }, "Scanner engine directory unreadable")
			return {}
		}
		const found: [string, EngineState][] = []
		for (const name of names) {
			let sourceId: string
			try {
				sourceId = decodeURIComponent(name.slice(0, -".json".length))
			} catch {
				this.log.warn(
					{ file: join(dir, name) },
					"Ignoring an engine state file with an undecodable name",
				)
				continue
			}
			const state = await this.readEngineFile(join(dir, name))
			if (state !== null) found.push([sourceId, state])
		}
		// fromEntries defines own properties, so a source id such as "__proto__" stays a plain key
		return Object.fromEntries(found)
	}

	/** One engine state file: null when missing, unreadable or invalid (logged unless missing). */
	private async readEngineFile(file: string): Promise<EngineState | null> {
		const read = await readJson(file)
		if (read.kind === "missing") return null
		const parsed =
			read.kind === "ok" ? EngineStateSchema.safeParse(read.value) : null
		if (parsed === null || !parsed.success) {
			this.log.warn(
				{
					file,
					issues: parsed?.success === false ? parsed.error.issues : undefined,
					err: read.kind === "invalid" ? read.reason : undefined,
				},
				"Ignoring an invalid engine state file",
			)
			return null
		}
		return parsed.data as EngineState
	}
}

function notLoaded(): WaveKitError {
	return new WaveKitError(
		"Scanner persistence used before load()",
		"SCANNER_PERSISTENCE_NOT_LOADED",
	)
}
