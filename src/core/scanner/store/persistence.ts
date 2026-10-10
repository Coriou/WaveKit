/**
 * Scanner persistence (spec § 8) under `scanner.storage.dir`:
 *
 * - `discoveries.json`: snapshot of discoveries + observations with `lastSeq` (atomic write);
 * - `journal/observations-YYYYMMDD.jsonl`: one line per store mutation, monotonic `seq`, UTC daily files;
 * - `jobs.json`: job specs, lifecycle state and the persisted lease (lifecycle changes only);
 * - `settings.json`: runtime settings overrides; `engine/<sourceId>.json`: learned engine state.
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
	ScanJobSpec,
} from "../types.js"
import type {
	Assert,
	EngineState,
	SchemaMatches,
} from "../../spectrum/types.js"
import { EngineStateSchema } from "../../spectrum/engine-state.js"
import type { JournalEntry, StoreSnapshot } from "./discovery-store.js"
import {
	DiscoverySchema,
	ObservationSchema,
	ScannerClassSchema,
	ScannerProtocolSchema,
	StoreMutationSchema,
} from "./schemas.js"

const FILE_VERSION = 1
const SNAPSHOT_FILE = "discoveries.json"
const JOBS_FILE = "jobs.json"
const SETTINGS_FILE = "settings.json"
const JOURNAL_DIR = "journal"
const ENGINE_DIR = "engine"
const JOURNAL_NAME = /^observations-(\d{8})\.jsonl$/
const DAY_MS = 86_400_000

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
	rawSpec: ScanJobSpec
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
	settings: RuntimeSettingsOverrides
	engines: Record<string, EngineState>
	droppedLines: number
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
	provenance: z.record(z.enum(["operator", "bandplan", "measured", "default"])),
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
	rawSpec: z.custom<ScanJobSpec>(
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

const SnapshotFileSchema = z.object({
	version: z.literal(FILE_VERSION),
	lastSeq: z.number().int().nonnegative(),
	savedAt: z.string(),
	discoveries: z.array(DiscoverySchema),
	observations: z.array(ObservationSchema),
	corrections: z
		.array(z.object({ sourceId: z.string().min(1), hz: z.number() }))
		.default([]),
})
const JobsFileSchema = z.object({
	version: z.literal(FILE_VERSION),
	jobs: z.array(PersistedJobSchema),
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

export class ScannerPersistence {
	private readonly root: string
	private readonly log: Logger
	private readonly now: () => number
	private readonly appendFile: (path: string, data: string) => Promise<void>
	private readonly fileMaxSeq = new Map<string, number>()
	private readonly fileBytes = new Map<string, number>()
	private chain: Promise<unknown> = Promise.resolve()
	private nextSeq = 1
	private durableLastSeq = 0
	private loaded = false

	/** `appendFile` is injectable for the short-write test; default `fs/promises.appendFile`. */
	constructor(opts: {
		dir: string
		logger: Logger
		now: () => number
		appendFile?: (path: string, data: string) => Promise<void>
	}) {
		this.root = resolve(opts.dir)
		this.log = createComponentLogger(opts.logger, "ScannerPersistence")
		this.now = opts.now
		this.appendFile =
			opts.appendFile ?? ((path, data) => appendFile(path, data))
	}

	async load(): Promise<LoadedState> {
		this.fileMaxSeq.clear()
		this.fileBytes.clear()
		const snapshot = await this.readSnapshot()
		const journal = await this.readJournal(snapshot.lastSeq)
		const jobs = await this.readJobs()
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
			settings,
			engines,
			droppedLines: journal.dropped,
		}
	}

	append(entry: Omit<JournalEntry, "seq">): Promise<number> {
		if (!this.loaded) return Promise.reject(notLoaded())
		const seq = this.nextSeq++
		const line = `${JSON.stringify({ seq, at: entry.at, op: entry.op, payload: entry.payload })}\n`
		const name = journalName(this.now())
		return this.enqueue(async () => {
			const dir = join(this.root, JOURNAL_DIR)
			const path = join(dir, name)
			const knownBytes = this.fileBytes.get(name) ?? 0 // load() sized every existing file; a new file is 0
			try {
				await mkdir(dir, { recursive: true })
				await this.appendFile(path, line)
			} catch (err) {
				// A partial line would glue onto the next one and lose both at load: cut back to the known size.
				await truncate(path, knownBytes).catch(() => undefined)
				this.log.warn(
					{ err, file: path, seq },
					"Journal append failed; truncated the partial line",
				)
				throw new WaveKitError(
					`Could not append to ${path}`,
					"SCANNER_PERSIST_FAILED",
					err instanceof Error ? err : undefined,
				)
			}
			this.fileMaxSeq.set(name, Math.max(this.fileMaxSeq.get(name) ?? 0, seq))
			this.fileBytes.set(name, knownBytes + Buffer.byteLength(line))
			return seq
		})
	}

	writeSnapshot(s: StoreSnapshot): Promise<void> {
		if (!this.loaded) return Promise.reject(notLoaded())
		const lastSeq = this.nextSeq - 1
		const text = JSON.stringify({
			version: FILE_VERSION,
			lastSeq,
			savedAt: new Date(this.now()).toISOString(),
			discoveries: s.discoveries,
			observations: s.observations,
			corrections: s.corrections,
		})
		return this.enqueue(async () => {
			await atomicWrite(join(this.root, SNAPSHOT_FILE), text)
			this.durableLastSeq = Math.max(this.durableLastSeq, lastSeq)
		})
	}

	writeJobs(jobs: PersistedJob[]): Promise<void> {
		const text = JSON.stringify({ version: FILE_VERSION, jobs }, null, "\t")
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
		return this.enqueue(() =>
			atomicWrite(
				join(this.root, ENGINE_DIR, `${encodeURIComponent(sourceId)}.json`),
				text,
			),
		)
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

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.then(fn)
		this.chain = next.catch(() => undefined)
		return next
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
			const aside = `${file}.invalid-${this.now()}`
			await rename(file, aside).catch(() => undefined)
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
			if (errorCode(err) !== "ENOENT")
				this.log.warn({ err, dir }, "Scanner journal directory unreadable")
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
					this.log.warn({ file: path }, "Skipping an invalid journal line")
					continue
				}
				fileMax = Math.max(fileMax, parsed.seq)
				if (parsed.seq > lastSeq && !bySeq.has(parsed.seq))
					bySeq.set(parsed.seq, parsed)
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

	private async readJobs(): Promise<PersistedJob[]> {
		const file = join(this.root, JOBS_FILE)
		const read = await readJson(file)
		if (read.kind === "missing") return []
		const parsed =
			read.kind === "ok" ? JobsFileSchema.safeParse(read.value) : null
		if (parsed === null || !parsed.success) {
			this.log.warn(
				{
					file,
					issues: parsed?.success === false ? parsed.error.issues : undefined,
				},
				"Scanner jobs file is invalid; starting with no jobs",
			)
			return []
		}
		return parsed.data.jobs as PersistedJob[]
	}

	private async readSettings(): Promise<RuntimeSettingsOverrides> {
		const file = join(this.root, SETTINGS_FILE)
		const read = await readJson(file)
		if (read.kind === "missing") return {}
		const parsed =
			read.kind === "ok" ? SettingsFileSchema.safeParse(read.value) : null
		if (parsed === null || !parsed.success) {
			this.log.warn(
				{
					file,
					issues: parsed?.success === false ? parsed.error.issues : undefined,
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
