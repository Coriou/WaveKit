/** Scanner-owned prepared-link media lifecycle. No native/channel consumer is adopted here. */
import { SCANNER_RECORDER_ERRORS } from "@wavekit/api-types"
import { randomUUID } from "node:crypto"
import { constants, linkSync, lstatSync, type Stats } from "node:fs"
import {
	link,
	lstat,
	mkdir,
	open,
	opendir,
	realpath,
	rename,
	rmdir,
	unlink,
	type FileHandle,
} from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { z } from "zod"
import { WaveKitError } from "../../../utils/errors.js"
import {
	WavFileWriter,
	wavHeader,
	type WavWriteReceipt,
	type WavHandle,
	type WavIo,
} from "../channel/wav-writer.js"
import { SCANNER_DISCOVERY_HOLDS_KEPT_CODE } from "@wavekit/api-types"
import type { RecordingProtection } from "../../recordings/contract.js"
import type {
	NoiseQuarantineFacts,
	NoiseQuarantineIds,
} from "./noise-quarantine.js"
import { ScannerApiError } from "../errors.js"
import type {
	RecordingAssociation,
	RecordingCommitPlan,
} from "./discovery-store.js"
import {
	MAX_OPERATION_METADATA_BYTES,
	MAX_RECOVERY_OPERATIONS,
	PreparedRecordingMetadataSchema,
	RecordingBindingSchema,
	RecordingIdentitySchema,
	UUIDSchema,
	recordingAlias,
	recordingArtifact,
	type PreparedRecordingMetadata,
	type RecordingBinding,
} from "./recording-operation.js"

export const MAX_ACTIVE_ANALOG_OPERATIONS = 8
export const MAX_ACTIVE_ANALOG_PER_SOURCE = 2
export const MAX_ANALOG_FILE_BYTES = 1_920_044
const RESERVATION = MAX_ANALOG_FILE_BYTES + MAX_OPERATION_METADATA_BYTES
/**
 * Room retention keeps free under the recordings quota for admission: 2 × RESERVATION =
 * 2 × (1,920,044 + 16,384) = 3,872,856 B. Admission refuses once used + outstanding +
 * RESERVATION exceeds the cap, so a pass that leaves used + outstanding + ADMISSION_HEADROOM
 * within the cap always fits one admission plus one more in flight. A store counts as full
 * (retention evicts, the quota status shows) past that, never only past the cap itself.
 */
export const ADMISSION_HEADROOM = 2 * RESERVATION
/**
 * Operations retention keeps free under the inventory bound (MAX_RECOVERY_OPERATIONS, 4096):
 * admission refuses once intents + unpublished reach the bound, so retention evicts oldest
 * first while they are at or past 4096 − 8 = 4088, which leaves room for every recording that
 * can be in flight at once (MAX_ACTIVE_ANALOG_OPERATIONS, 8).
 */
export const OPERATION_HEADROOM = MAX_ACTIVE_ANALOG_OPERATIONS
/**
 * A recording outside analog operations (digital voice; probe recordings are protected and never offered) that retention may remove for
 * the quota, offered to AnalogOperations.retained so one oldest-first pass covers both pools.
 */
export interface LegacyRetentionFile {
	mtimeMs: number
	/** Tie-break among equal mtimes (the file's relative path). */
	key: string
	bytes: number
	/** Removes it after the caller's whole policy again; false when it was kept. */
	remove: () => Promise<boolean>
}
/** One file of AnalogOperations.retained's oldest-first pass, from either pool. */
type RetentionEntry =
	| { kind: "analog"; intent: Intent; mtimeMs: number; key: string }
	| { kind: "legacy"; file: LegacyRetentionFile; mtimeMs: number; key: string }
/** The legacy pool of one retention pass; `bytes` drops by each file `retained` removes. */
export interface LegacyRetention {
	/** Legacy recording bytes left (the pass's walk, less what it removed). */
	bytes: number
	/** Removable legacy recordings (not protected when listed). */
	files: readonly LegacyRetentionFile[]
}
/**
 * The refusal for the recording bytes themselves (used + outstanding + one reservation over the
 * cap), the only storage-cap refusal retention can clear. Its public code is the same
 * SCANNER_ANALOG_STORAGE_CAP the operation inventory limit and the metadata bounds throw; only
 * this class tells it apart (isStorageBytesRefusal).
 */
export class AnalogStorageBytesError extends WaveKitError {
	constructor(message: string) {
		super(message, "SCANNER_ANALOG_STORAGE_CAP")
	}
}
/**
 * The refusal for the operation inventory (intents + unpublished at MAX_RECOVERY_OPERATIONS),
 * which retention can clear too (it evicts the oldest removable analog files while the
 * inventory is within OPERATION_HEADROOM of its bound). Same public code as the byte refusal
 * (SCANNER_ANALOG_STORAGE_CAP); only this class tells it apart (isStorageCountRefusal).
 */
export class AnalogStorageCountError extends WaveKitError {
	constructor(message: string) {
		super(message, "SCANNER_ANALOG_STORAGE_CAP")
	}
}
/** True for a storage-cap refusal of the recording bytes (AnalogStorageBytesError). */
export function isStorageBytesRefusal(err: unknown): boolean {
	return err instanceof AnalogStorageBytesError
}
/** True for a storage-cap refusal of the operation inventory (AnalogStorageCountError). */
export function isStorageCountRefusal(err: unknown): boolean {
	return err instanceof AnalogStorageCountError
}
/**
 * What an admission that succeeded left short (AnalogHandle.roomShort): `bytes` when less than
 * one more RESERVATION (1,936,428 B) is left under the cap, `count` when fewer than
 * OPERATION_HEADROOM (8) operations are left under MAX_RECOVERY_OPERATIONS (4096), this one
 * counted. Retention evicts in both states, so an early pass asked on either can act.
 */
export interface AnalogRoomShort {
	bytes: boolean
	count: boolean
}
/**
 * Incomplete operation folders (crash residue holding no media) a scan moved aside into
 * `.analog-operations/.set-aside/`, kept for diagnosis. Each holds only the intent files
 * (intent.json, intent.tmp), together at most MAX_OPERATION_METADATA_BYTES (16 KiB). Past the
 * bound the oldest entries are deleted, but only entries proven to hold intent metadata alone:
 * an entry that cannot be proven media-free (changed by hand, unreadable) is kept and counted,
 * so the bound is strict for the 32 × 16 KiB = 512 KiB of evictable entries only.
 */
export const ANALOG_SET_ASIDE_MAX = 32
/**
 * Why a folder was set aside (closed): a staging folder creation never published
 * (`staging-residue`), an operation folder without intent.json and no media anywhere (`missing-intent`, an older
 * image's crash between mkdir and the intent link), an unreadable intent.json with no receipt and
 * no media anywhere (`invalid-intent`).
 */
export const ANALOG_SET_ASIDE_REASONS = [
	"staging-residue",
	"missing-intent",
	"invalid-intent",
] as const
export type AnalogSetAsideReason = (typeof ANALOG_SET_ASIDE_REASONS)[number]
/** `ScannerStatus.analogOperations`: present once something is held set aside. */
export interface AnalogSetAsideStatus {
	setAside: number
	lastReason?: AnalogSetAsideReason
}
/** A creation in progress: invisible to recovery until renamed to its operation id. */
const STAGING_PREFIX = ".staging-"
const SET_ASIDE_DIR = ".set-aside"
/** `<13-digit ms stamp>-<operation uuid>`: name order is set-aside order. */
const SET_ASIDE_ENTRY = /^(\d{13})-[0-9a-f-]{36}$/i
/**
 * Bound of the media search a missing or unreadable intent.json needs before it may be set aside: one
 * lstat per `recordings/analog/<folder>/`, at most MAX_RECOVERY_OPERATIONS (4096) folders, once
 * per such operation (a hit is remembered); more folders: not searched, kept fail closed.
 */
const MEDIA_SEARCH_FOLDERS = MAX_RECOVERY_OPERATIONS
const PRODUCER_RUN_ID = randomUUID()
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const AnalogCutSchema = z.enum([
	"completed",
	"duration-limit",
	"track-ended",
	"cancelled",
	"discovery-deleted",
	"source-lost",
	"epoch-changed",
	"stream-changed",
	"channel-invalidated",
	"engine-failed",
	"shutdown",
])
export type AnalogCut = z.infer<typeof AnalogCutSchema>
export const ErrorSchema = z.enum(SCANNER_RECORDER_ERRORS)
export type AnalogError = z.infer<typeof ErrorSchema>
/**
 * Which check refused an operation whose error is `admission-denied` or `invalid-binding`
 * (AnalogReceipt.failure): those two codes cover every one of them, and only this tells a discovery
 * removed from an observation merged away. A closed code: safe to log.
 */
export const AnalogFailureSchema = z.enum([
	"cancelled",
	"authority-unhealthy",
	"discovery-removed",
	"association-lost",
	"binding-unusable",
	"binding-not-live",
	"commit-plan-stale",
])
export type AnalogFailure = z.infer<typeof AnalogFailureSchema>
export const AnalogGapSchema = z
	.object({
		cause: z.enum([
			"input-gap",
			"queue-overflow",
			"writer-backpressure",
			"source-gap",
			"unknown",
		]),
		inputSampleIndex: count.nullable(),
		droppedInputSamples: count.nullable(),
		outputFrameIndex: count.nullable(),
	})
	.strict()
export type AnalogGap = Readonly<z.infer<typeof AnalogGapSchema>>
const OutputSchema = z
	.object({
		format: z.literal("s16le-wav").nullable(),
		sampleRateHz: z.literal(8000).nullable(),
		channelCount: z.literal(1).nullable(),
		outputFrames: count.max(960_000).nullable(),
		fileBytes: count.max(MAX_ANALOG_FILE_BYTES).nullable(),
	})
	.strict()
export const AnalogReceiptSchema = z
	.object({
		version: z.literal(1),
		operationId: UUIDSchema,
		producerRecordingId: UUIDSchema,
		producerId: z.literal("scanner-analog"),
		producerRunId: UUIDSchema,
		producerStoreId: z.null(),
		discoveryId: RecordingIdentitySchema.nullable(),
		observationId: RecordingIdentitySchema.nullable(),
		alias: z.string().max(256).nullable(),
		binding: RecordingBindingSchema,
		output: OutputSchema,
		gaps: z.array(AnalogGapSchema).max(64),
		omittedGapCount: count,
		cutReason: AnalogCutSchema.nullable(),
		/**
		 * The producer's answer whether a joined track was still on the air at the cut
		 * (AnalogFinishFacts.cutActive); absent when it gave none and on older receipts.
		 */
		cutActive: z.boolean().optional(),
		/**
		 * The recorder's reason for keeping the file (AnalogFinishFacts.keptBy, its finish path's
		 * code); absent when it gave none and on older receipts.
		 */
		keptBy: z
			.string()
			.regex(/^[a-z][a-z-]{0,31}$/)
			.optional(),
		/**
		 * The file's own speech reading at its finish (AnalogFinishFacts.speechHeard): true heard,
		 * false not, null not measured; absent when none was given and on older receipts.
		 */
		speechHeard: z.boolean().nullable().optional(),
		/** Wall time of the file's first sample (ISO); absent when not given and on older receipts. */
		startedAt: z.string().datetime().optional(),
		closure: z.enum(["closed", "incomplete", "unknown"]),
		outcome: z.enum(["finalized", "aborted", "failed"]),
		artifact: z.string().max(512).nullable(),
		cleanup: z.enum(["complete", "pending"]),
		residueBytes: count.nullable(),
		errorCode: ErrorSchema.nullable(),
		/** Absent on a finalized receipt, on older markers and on failures of other steps. */
		failure: AnalogFailureSchema.optional(),
		durability: z
			.object({
				mediaFileSync: z.enum(["synced", "not-acknowledged"]),
				metadata: z.enum(["journal-append-prepared-link", "not-acknowledged"]),
				metadataPowerLossDurable: z.literal(false),
				finalMarkerFileSync: z.enum(["synced", "not-acknowledged"]),
				finalMarkerDirectorySync: z.literal("not-attempted"),
			})
			.strict(),
	})
	.strict()
	.superRefine((r, ctx) => {
		if (
			r.operationId !== r.producerRecordingId ||
			(r.outcome === "finalized" &&
				(r.discoveryId === null ||
					r.observationId === null ||
					r.alias !== recordingAlias(r.discoveryId, r.operationId) ||
					r.artifact !== recordingArtifact(r.discoveryId, r.operationId) ||
					r.output.format !== "s16le-wav" ||
					r.output.sampleRateHz !== 8000 ||
					r.output.channelCount !== 1 ||
					r.output.outputFrames === null ||
					r.output.fileBytes === null ||
					r.output.fileBytes !== 44 + 2 * (r.output.outputFrames ?? -1) ||
					r.closure !== "closed" ||
					r.cutReason === null ||
					r.errorCode !== null ||
					r.durability.mediaFileSync !== "synced" ||
					r.durability.metadata !== "journal-append-prepared-link" ||
					r.durability.finalMarkerFileSync !== "synced"))
		)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Invalid analog receipt identity/output",
			})
	})
export type AnalogReceipt = Readonly<
	Omit<
		z.infer<typeof AnalogReceiptSchema>,
		"binding" | "output" | "gaps" | "durability"
	> & {
		binding: RecordingBinding
		output: Readonly<z.infer<typeof OutputSchema>>
		gaps: readonly AnalogGap[]
		durability: Readonly<z.infer<typeof AnalogReceiptSchema>["durability"]>
	}
>
const IntentSchema = z
	.object({
		version: z.literal(1),
		operationId: UUIDSchema,
		producerRecordingId: UUIDSchema,
		producerRunId: UUIDSchema,
		discoveryId: RecordingIdentitySchema,
		observationId: RecordingIdentitySchema,
		alias: z.string().max(256),
		artifact: z.string().max(512),
		binding: RecordingBindingSchema,
		maxFileBytes: z.literal(MAX_ANALOG_FILE_BYTES),
	})
	.strict()
	.superRefine((i, ctx) => {
		if (
			!/^d_[0-9A-Za-z]+$/.test(i.discoveryId) ||
			i.operationId !== i.producerRecordingId ||
			i.alias !== recordingAlias(i.discoveryId, i.operationId) ||
			i.artifact !== recordingArtifact(i.discoveryId, i.operationId)
		)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Invalid intent identity",
			})
	})
type Intent = z.infer<typeof IntentSchema>
export interface AnalogInput {
	discoveryId: string
	observationId: string
	binding: RecordingBinding
}
export interface AnalogMetadataAdapter {
	authorityHealthy(): boolean
	bindingLive(binding: RecordingBinding): boolean
	association(
		discoveryId: string,
		observationId: string,
		binding?: RecordingBinding,
	): RecordingAssociation | null
	/**
	 * A finalized file's live owner once its observation left the window (association has
	 * nothing to answer from): DiscoveryStore.retainedRecordingOwner. Undefined while the
	 * observation is stored or when no live discovery resolves. Absent: no such answer.
	 */
	retainedOwner?(
		discoveryId: string,
		observationId: string,
		alias: string,
	): string | undefined
	prepare(metadata: PreparedRecordingMetadata): Promise<void>
	inverse(operationId: string): Promise<void>
	buildCommitPlan(operationId: string): RecordingCommitPlan | null
	/** Must delegate to the known plain DiscoveryStore identity checker, without callbacks. */
	commitPlanCurrent(plan: RecordingCommitPlan): boolean
	publishCommit(plan: RecordingCommitPlan): void
}
/** What the producer knows of a file's end, besides its cut (AnalogHandle.finish). */
export interface AnalogFinishFacts {
	/**
	 * Whether a joined track was still on the air at the cut: false when only the file's silent
	 * hang after the transmission's end was cut off. Written to the receipt as `cutActive`.
	 */
	readonly cutActive?: boolean
	/**
	 * Why the recorder kept the file: its finish path's reason code (recording-verdict.ts
	 * FinishReason). Written to the receipt as `keptBy`; a read-only pass-through.
	 */
	readonly keptBy?: string
	/** The file's own speech reading at the finish (null: not measured). Receipt `speechHeard`. */
	readonly speechHeard?: boolean | null
	/** Wall time of the file's first sample, ISO. Receipt `startedAt`. */
	readonly startedAt?: string
}
/**
 * The receipt's verdict members of finish facts: each one kept only when the receipt schema takes
 * it, so a malformed fact is left out (unknown) and never fails the finish.
 */
function verdictOf(
	facts: AnalogFinishFacts,
): Pick<AnalogReceipt, "keptBy" | "speechHeard" | "startedAt"> {
	const shape = AnalogReceiptSchema.innerType().shape
	const out: {
		keptBy?: string
		speechHeard?: boolean | null
		startedAt?: string
	} = {}
	if (
		shape.keptBy.safeParse(facts.keptBy).success &&
		facts.keptBy !== undefined
	)
		out.keptBy = facts.keptBy
	if (
		shape.speechHeard.safeParse(facts.speechHeard).success &&
		facts.speechHeard !== undefined
	)
		out.speechHeard = facts.speechHeard
	if (
		shape.startedAt.safeParse(facts.startedAt).success &&
		facts.startedAt !== undefined
	)
		out.startedAt = facts.startedAt
	return out
}
export interface AnalogHandle {
	readonly operationId: string
	readonly ready: Promise<void>
	readonly settled: Promise<AnalogReceipt>
	push(pcm: Int16Array): Promise<void>
	addGap(gap: AnalogGap): void
	finish(cut?: AnalogCut, facts?: AnalogFinishFacts): Promise<AnalogReceipt>
	/**
	 * Ends the operation unfinalized (receipt `aborted`, like every cancel). `noise`: the file was
	 * measured as noise (`discarded:noise`): its written audio is moved to the noise quarantine
	 * (noise-quarantine.ts, Context.noiseQuarantine) instead of deleted; a failed move, or no
	 * quarantine configured, deletes it as any other cancel does.
	 */
	cancel(cut?: AnalogCut, noise?: NoiseQuarantineFacts): void
	/**
	 * Set once `ready` resolved: what the admission left short (AnalogRoomShort), null when it
	 * left room for the next recording (or was refused). Absent on handles that never admit.
	 */
	readonly roomShort?: AnalogRoomShort | null
}
export interface AnalogReconciliation {
	operationId: string
	discoveryId: string | null
	status: "available" | "cleaned" | "quarantined"
	errorCode: AnalogError | null
	residueBytes: number | null
}
/**
 * Why recovery quarantined an operation (closed; one check each). Finalized files: a receipt
 * that is not finalized, does not match its intent, media that fails its size or header check,
 * prepared metadata that disagrees, no live owner, an owner not admitted. Unfinalized ones: no
 * receipt while something lists the file. Any: unreadable receipt, unknown inventory, unhealthy
 * authority, unconfirmed descriptor closure, a failed cleanup, an unexpected error.
 */
export const ANALOG_QUARANTINE_REASONS = [
	"not-finalized",
	"receipt-mismatch",
	"media-invalid",
	"prepared-mismatch",
	"owner-unresolved",
	"owner-not-admitted",
	"unfinalized-listed",
	"receipt-unreadable",
	"inventory-unknown",
	"authority-unhealthy",
	"closure-uncertain",
	"cleanup-failed",
	"recovery-error",
] as const
export type AnalogQuarantineReason = (typeof ANALOG_QUARANTINE_REASONS)[number]
/** One quarantined operation: schema-validated ids (intent.json) and a closed reason. */
export interface AnalogQuarantine {
	readonly operationId: string
	readonly discoveryId: string
	readonly reason: AnalogQuarantineReason
}
export interface AnalogOperationIo {
	wavIo?: WavIo
	readOpen?: (path: string, flags: number) => Promise<FileHandle>
	metadataOpen?: (path: string) => Promise<WavHandle>
	rmdir?: (path: string) => Promise<void>
	/** Directory renames: a staging folder's publication and set-aside moves. */
	rename?: (from: string, to: string) => Promise<void>
	/** fsync of a directory (durability only, see DIRECTORY_SYNC_TOLERATED). */
	fsyncDir?: (path: string) => Promise<void>
	/** The per-folder media probe of a residue proof (`recordings/analog/<folder>/analog-<id>.wav`). */
	mediaLstat?: (path: string) => Promise<unknown>
	unlink(path: string): Promise<void>
	checkpoint(name: string, operationId: string): Promise<void>
}
interface Context {
	root: string
	adapter: AnalogMetadataAdapter
	admits(id: string): boolean
	serialise<T>(id: string, job: () => Promise<T>): Promise<T>
	legacyBytes(): Promise<number>
	limits(): { maxBytes: number; minFreeBytes: number }
	freeBytes(): Promise<number>
	io?: AnalogOperationIo
	/** WG9 req 2.5: a kept artifact survives retention; absent keeps today's behaviour. */
	protection?: RecordingProtection
	/** Fixed-text count log of kept artifacts a deleter left in place. */
	keptSkipped?: (count: number) => void
	/**
	 * True when a live discovery may list a file of `folderId` the ownership table could not
	 * record (it was full): such a file's owner is unknown and it is kept (heldElsewhere null).
	 */
	heldUnknown?: (folderId: string) => boolean
	/**
	 * Every live discovery the ownership table records as listing `name` of `folderId` (null:
	 * the folder is marked, its listers are unknown; empty: the table holds no listing).
	 */
	listers?: (folderId: string, name: string) => readonly string[] | null
	/**
	 * Fixed-text warning, once per process, that a directory fsync failed with a tolerated
	 * code (closed set, see DIRECTORY_SYNC_TOLERATED) and a fixed folder kind: no paths.
	 */
	directorySyncTolerated?: (code: string, kind: AnalogDirectorySyncKind) => void
	/** Fixed-text count log of one scan's set-aside work (no names). */
	setAsideLogged?: (counts: {
		moved: number
		evicted: number
		held: number
	}) => void
	/**
	 * The noise quarantine (noise-quarantine.ts NoiseQuarantine.admit): moves a cancelled noise
	 * file's `payload.wav.part` out; true when moved, false (never throws) when the caller deletes it.
	 */
	noiseQuarantine?: (
		source: string,
		ids: NoiseQuarantineIds,
		facts: NoiseQuarantineFacts,
	) => Promise<boolean>
}
interface Inventory {
	bytes: number
	metadataBytes: number
	unknown: boolean
	cleanup: Set<string>
	intents: Map<string, Intent>
	opBytes: Map<string, number>
	/** Metadata bytes per operation id, so a refreshed id credits back exactly what it added. */
	opMetadata: Map<string, number>
	/** Artifact (root-relative path) to its operation id: ownsArtifact without a walk. */
	artifacts: Map<string, string>
}
/** Which of an operation id's three names (cleanup marker, staging folder, folder) exist. */
interface Presence {
	cleanup: boolean
	staging: boolean
	folder: boolean
}
interface OperationListing {
	ids: Map<string, Presence>
	/** A name that is none of them: fail closed. */
	invalid: boolean
	setAsidePresent: boolean
}
/** One operation id's share of the inventory (scanOperation). */
interface OperationScan {
	id: string
	bytes: number
	metadataBytes: number
	unknown: boolean
	/** Its folder's intent.json, else its cleanup marker's; null when neither parses. */
	intent: Intent | null
	cleanup: boolean
	/** Verified crash residue to move aside (staging folder, folder). */
	residue: { name: string; id: string; reason: AnalogSetAsideReason }[]
}
function emptyInventory(): Inventory {
	return {
		bytes: 0,
		metadataBytes: 0,
		unknown: false,
		cleanup: new Set(),
		intents: new Map(),
		opBytes: new Map(),
		opMetadata: new Map(),
		artifacts: new Map(),
	}
}
/** Removes `id`'s share from the totals and indexes (the inverse of addOperation). */
function dropOperation(inventory: Inventory, id: string): void {
	inventory.bytes -= inventory.opBytes.get(id) ?? 0
	inventory.metadataBytes -= inventory.opMetadata.get(id) ?? 0
	inventory.opBytes.delete(id)
	inventory.opMetadata.delete(id)
	const intent = inventory.intents.get(id)
	if (intent && inventory.artifacts.get(intent.artifact) === id)
		inventory.artifacts.delete(intent.artifact)
	inventory.intents.delete(id)
	inventory.cleanup.delete(id)
}
/** Adds a scanned id's share (after dropOperation of the same id, or into a fresh inventory). */
function addOperation(inventory: Inventory, scan: OperationScan): void {
	if (scan.unknown) inventory.unknown = true
	if (scan.bytes > 0) {
		inventory.bytes += scan.bytes
		inventory.opBytes.set(scan.id, scan.bytes)
	}
	if (scan.metadataBytes > 0) {
		inventory.metadataBytes += scan.metadataBytes
		inventory.opMetadata.set(scan.id, scan.metadataBytes)
	}
	if (scan.cleanup) inventory.cleanup.add(scan.id)
	if (scan.intent) {
		inventory.intents.set(scan.id, scan.intent)
		inventory.artifacts.set(scan.intent.artifact, scan.id)
	}
}
/**
 * Operation ids a full scan reads at once: 8 = twice libuv's default thread pool of 4, enough
 * to keep every pool thread busy (each id is a chain of dependent lstat/open/read calls), small
 * enough that MAX_RECOVERY_OPERATIONS ids never queue more than 8 chains.
 */
const SCAN_CONCURRENCY = 8
/**
 * Operation ids an audit reads at once: 1, so a background audit never queues more than one
 * file system call ahead of a recording's own writes on the shared thread pool.
 */
const AUDIT_CONCURRENCY = 1
/** Runs `fn` over `items` with at most `limit` in flight; results in input order. */
async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let next = 0
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++
			results[index] = await fn(items[index]!)
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker()),
	)
	return results
}
interface Operation {
	intent: Intent
	descriptors: Set<WavHandle>
	writer: WavFileWriter | null
	cancelled: AnalogCut | null
	/** A noise cancel's measured facts: the writer's part unlink quarantines instead (once). */
	noise: NoiseQuarantineFacts | null
	/** The first finish's AnalogFinishFacts.cutActive; null: none given. */
	cutActive: boolean | null
	/** The first finish's verdict facts (keptBy, speechHeard, startedAt) as given and valid. */
	verdict: Pick<AnalogReceipt, "keptBy" | "speechHeard" | "startedAt">
	/** The check that refused it first (AnalogFailure), for its receipt. */
	failure: AnalogFailure | null
	accepting: boolean
	decision: AnalogReceipt | null
	markerLinked: boolean
	candidate: AnalogReceipt | null
	finish: Promise<AnalogReceipt> | null
	ready: Promise<void>
	settled: Promise<AnalogReceipt>
	resolve(receipt: AnalogReceipt): void
	gaps: AnalogGap[]
	omitted: number
	output: WavWriteReceipt | null
	prepared: boolean
	metadataAck: boolean
	ownedIntent: boolean
	ownedDirectory: boolean
	/** The owned folder still carries its staging name (never published). */
	staged: boolean
	ownedMedia: boolean
	foreignMarker: boolean
	reservation: boolean
	/** What the admission left short (AnalogHandle.roomShort), set under its lock. */
	roomShort: AnalogRoomShort | null
}
/**
 * A directory fsync is durability only (the entries are already written): a file system or
 * sandbox that refuses it with one of these codes is accepted, any other failure is not.
 */
const DIRECTORY_SYNC_TOLERATED: ReadonlySet<string> = new Set([
	"EINVAL",
	"ENOTSUP",
	"EISDIR",
	"EPERM",
	"EACCES",
	"EBADF",
	"ENOSYS",
	"EOPNOTSUPP",
])
/** Which folder a directory fsync was for: a fixed label, safe to log. */
export type AnalogDirectorySyncKind = "staging" | "operations"
/** Per process: the tolerated-fsync warning is logged once, whatever the store instance. */
let directorySyncWarned = false
/** Test hook: lets the next tolerated directory fsync warn again. */
export function resetDirectorySyncWarning(): void {
	directorySyncWarned = false
}
async function fsyncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY)
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}
const defaultIo: AnalogOperationIo = {
	unlink,
	checkpoint: async () => undefined,
}
function coded(
	code: AnalogError,
	message: string,
	cause?: unknown,
): WaveKitError {
	return new WaveKitError(
		message,
		`SCANNER_ANALOG_${code.toUpperCase().replaceAll("-", "_")}`,
		cause instanceof Error ? cause : undefined,
	)
}
function nativeCode(err: unknown): unknown {
	return err instanceof Error && "code" in err ? err.code : null
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const v of Object.values(value)) freeze(v)
		Object.freeze(value)
	}
	return value
}
function boundedJson(value: unknown): Buffer {
	const serialized = JSON.stringify(value)
	if (serialized === undefined)
		throw coded("write-failed", "Missing operation metadata")
	const data = Buffer.from(serialized)
	if (data.length > MAX_OPERATION_METADATA_BYTES)
		throw coded("storage-cap", "Operation metadata exceeds bound")
	return data
}

/** Owned by EvidenceStore; one global admission/inventory lock and one accepted-operation registry. */
export class AnalogOperations {
	private readonly runId = PRODUCER_RUN_ID
	private readonly active = new Map<string, Operation>()
	private readonly available = new Map<
		string,
		{ intent: Intent; receipt: AnalogReceipt; available: boolean }
	>()
	private readonly unconfirmedReads = new Set<FileHandle>()
	private readonly io: AnalogOperationIo
	private lock: Promise<void> = Promise.resolve()
	private inventory: Inventory = { ...emptyInventory(), unknown: true }
	/** Counts full scans: an audit begun before one never applies its older reads. */
	private scanEpoch = 0
	/** A refresh or an audit met crash residue: the next audit runs the full scan (set-aside). */
	private residuePending = false
	/** Ids this process changed since the running audit began (null: no audit running). */
	private auditTouched: Set<string> | null = null
	private readonly uncertainResidue = new Map<
		string,
		{ discoveryId: string; bytes: number; descriptors: ReadonlySet<WavHandle> }
	>()
	private stopped = false
	private initialized = false
	/** Artifacts the last retention pass kept because no live discovery owns them. */
	unresolvedRetained = 0
	/**
	 * The last retention pass found the operation inventory full (operationsFull) with the
	 * operations it may not remove alone at or past the limit (MAX_RECOVERY_OPERATIONS −
	 * OPERATION_HEADROOM): no count eviction can clear it, so none ran.
	 */
	operationsHeldFull = false
	/** Artifacts the last retention pass kept because recovery quarantined them. */
	quarantinedRetained = 0
	/**
	 * The last retention pass, for removableNow: its keep set, the analog operations it tried to
	 * retire and the legacy files it did not try (the store fit at their turn). Null: none ran.
	 */
	private lastPass: {
		keep: ReadonlySet<string>
		tried: ReadonlySet<string>
		legacyUntried: number
	} | null = null
	/** Why the last recovery quarantined each operation it did not admit (closed reasons). */
	private readonly quarantine = new Map<string, AnalogQuarantine>()
	/** Artifacts the last retention pass kept because their owner is unknown (table full). */
	unknownHeldRetained = 0
	private recovery: Promise<AnalogReconciliation[]> | null = null
	/** Folders held in `.set-aside/` at the last scan (ANALOG_SET_ASIDE_MAX evictable, see there). */
	private setAsideHeld = 0
	private lastSetAsideReason: AnalogSetAsideReason | null = null
	/** Operation ids whose missing or unreadable intent has media somewhere (searched once each). */
	private readonly mediaBearing = new Set<string>()
	/**
	 * Operation ids proven media-free by a complete search, with the `recordings/analog/` folder
	 * count it saw: a residue whose set-aside move keeps failing is not searched again until
	 * that count changes. Errors and an over-bound listing are never recorded here.
	 */
	private readonly mediaFree = new Map<string, number>()
	private root: string
	private rootAnchored = false
	constructor(private readonly context: Context) {
		this.io = context.io ?? defaultIo
		this.root = resolve(context.root)
	}
	get ready(): boolean {
		return (
			!this.stopped &&
			this.initialized &&
			!this.inventory.unknown &&
			this.context.adapter.authorityHealthy()
		)
	}
	/**
	 * Bytes retention must still free so the next admissions fit: managed + `legacy` +
	 * outstanding reservations + ADMISSION_HEADROOM − the cap (> 0: full). Null while the
	 * inventory is unknown.
	 */
	quotaShortfall(legacy: number): number | null {
		if (this.inventory.unknown) return null
		return (
			this.inventory.bytes +
			legacy +
			this.reservedUnused() +
			this.uncertainUnused() +
			ADMISSION_HEADROOM -
			this.context.limits().maxBytes
		)
	}
	/**
	 * The operation inventory is within OPERATION_HEADROOM of its bound (intents + unpublished
	 * ≥ MAX_RECOVERY_OPERATIONS − OPERATION_HEADROOM): retention evicts until it is not.
	 */
	private operationsFull(): boolean {
		return (
			this.inventory.intents.size + this.unpublished() >=
			MAX_RECOVERY_OPERATIONS - OPERATION_HEADROOM
		)
	}
	get managedBytes(): number | null {
		return this.inventory.unknown
			? null
			: this.inventory.bytes + this.uncertainUnused()
	}
	isManagedAlias(alias: string): boolean {
		return /^d_[0-9A-Za-z]+~analog-[0-9a-f-]{36}\.wav$/i.test(alias)
	}
	protectedDiscovery(id: string): boolean {
		return [...this.active.values()].some(op => op.intent.discoveryId === id)
	}
	private exclusive<T>(job: () => Promise<T>): Promise<T> {
		const run = this.lock.then(job)
		this.lock = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}
	private opDir(id: string): string {
		return join(this.root, ".analog-operations", id)
	}
	private stagingDir(id: string): string {
		return join(this.root, ".analog-operations", `${STAGING_PREFIX}${id}`)
	}
	private setAsideDir(): string {
		return join(this.root, ".analog-operations", SET_ASIDE_DIR)
	}
	private finalPath(intent: Intent): string {
		return join(this.root, intent.artifact)
	}
	private stagePath(intent: Intent): string {
		return join(this.opDir(intent.operationId), "payload.wav.part")
	}
	private async checkpoint(name: string, id: string): Promise<void> {
		await this.io.checkpoint(name, id)
	}

	begin(input: AnalogInput): AnalogHandle {
		const id = randomUUID()
		const intent = IntentSchema.parse({
			version: 1,
			operationId: id,
			producerRecordingId: id,
			producerRunId: this.runId,
			discoveryId: input.discoveryId,
			observationId: input.observationId,
			alias: recordingAlias(input.discoveryId, id),
			artifact: recordingArtifact(input.discoveryId, id),
			binding: input.binding,
			maxFileBytes: MAX_ANALOG_FILE_BYTES,
		})
		freeze(intent)
		let resolveSettlement!: (receipt: AnalogReceipt) => void
		const settled = new Promise<AnalogReceipt>(done => {
			resolveSettlement = done
		})
		const op: Operation = {
			intent,
			writer: null,
			cancelled: null,
			noise: null,
			cutActive: null,
			verdict: {},
			failure: null,
			accepting: true,
			decision: null,
			markerLinked: false,
			candidate: null,
			finish: null,
			ready: Promise.resolve(),
			settled,
			resolve: resolveSettlement,
			gaps: [],
			omitted: 0,
			output: null,
			prepared: false,
			metadataAck: false,
			ownedIntent: false,
			descriptors: new Set(),
			ownedDirectory: false,
			staged: false,
			ownedMedia: false,
			foreignMarker: false,
			reservation: false,
			roomShort: null,
		}
		const sameSource = [...this.active.values()].filter(
			other => other.intent.binding.sourceId === intent.binding.sourceId,
		).length
		// Registration precedes the first await, including an admission that will fail.
		const capacity =
			this.active.size < MAX_ACTIVE_ANALOG_OPERATIONS &&
			sameSource < MAX_ACTIVE_ANALOG_PER_SOURCE
		if (capacity) this.active.set(id, op)
		op.ready = capacity
			? this.admit(op)
			: Promise.reject(
					coded("admission-denied", "Active analog operation limit"),
				)
		void op.ready.catch(() => {
			void this.finishOperation(op, "cancelled")
		})
		return {
			operationId: id,
			ready: op.ready,
			settled,
			get roomShort() {
				return op.roomShort
			},
			push: pcm => {
				if (!op.accepting || op.cancelled)
					return Promise.reject(coded("write-failed", "Analog intake fenced"))
				if (!op.writer)
					return Promise.reject(
						coded("admission-denied", "Await analog readiness before writing"),
					)
				return op.writer.write(pcm)
			},
			addGap: gap => {
				if (op.decision) return
				const parsed = freeze(AnalogGapSchema.parse(gap))
				if (op.gaps.length < 64) op.gaps.push(parsed)
				else op.omitted++
			},
			finish: (cut = "completed", facts) => {
				if (!op.finish && typeof facts?.cutActive === "boolean")
					op.cutActive = facts.cutActive
				if (!op.finish && facts !== undefined) op.verdict = verdictOf(facts)
				return this.finishOperation(op, AnalogCutSchema.parse(cut))
			},
			cancel: (cut = "cancelled", noise) => {
				if (op.decision) return
				if (noise !== undefined && !op.cancelled) op.noise = noise
				op.cancelled ??= AnalogCutSchema.parse(cut)
				op.accepting = false
				op.writer?.cancel()
				void this.finishOperation(op, op.cancelled)
			},
		}
	}
	private valid(op: Operation): void {
		const failure = this.invalidBecause(op)
		if (failure === null) return
		op.failure ??= failure
		if (failure === "binding-unusable" || failure === "binding-not-live")
			throw coded("invalid-binding", "Actual live 48 kHz cf32 binding required")
		if (failure === "cancelled")
			throw coded("admission-denied", "Analog operation cancelled")
		throw coded("admission-denied", "Analog association is unavailable")
	}
	/** The first check `op` fails, or null. A callback may cancel it meanwhile, so the last ones repeat. */
	private invalidBecause(op: Operation): AnalogFailure | null {
		if (op.cancelled) return "cancelled"
		if (!this.context.adapter.authorityHealthy()) return "authority-unhealthy"
		if (!this.context.admits(op.intent.discoveryId)) return "discovery-removed"
		const association = this.context.adapter.association(
			op.intent.discoveryId,
			op.intent.observationId,
			op.intent.binding,
		)
		// A held answer covers committed files only: an operation still writing has lost it.
		if (association === null || association.held === true)
			return "association-lost"
		const b = op.intent.binding
		if (
			b.inputFormat !== "cf32" ||
			b.inputSampleRateHz !== 48000 ||
			b.sourceId === null ||
			b.engineInstanceId === null ||
			b.stream === null ||
			b.epoch === null ||
			b.channelId === null ||
			b.channelGeneration === null
		)
			return "binding-unusable"
		if (!this.context.adapter.bindingLive(b)) return "binding-not-live"
		if (op.cancelled) return "cancelled"
		if (!this.context.admits(op.intent.discoveryId)) return "discovery-removed"
		return null
	}
	/**
	 * Admission. Only the reservation is exclusive: the capacity checks against the inventory and
	 * the outstanding reservations, then the reservation itself, in one synchronous step under the
	 * lock, so concurrent admissions never share free space. The measurements it compares (free
	 * disk, the other recordings' bytes) are taken before it, and the operation's folder is built
	 * after it: an admitted, active operation's files are its own (every scan counts an active
	 * id's folders as owned, retention and deletion leave its discovery alone), so no other step
	 * needs the lock to exclude them. The inventory is kept current by every change this process
	 * makes (refresh) and by the audit for outside ones: no scan here, so admission costs the same
	 * at any store size.
	 */
	private async admit(op: Operation): Promise<void> {
		const unavailable = (): WaveKitError =>
			coded("recovery-incomplete", "Analog inventory/authority unavailable")
		if (!this.ready) throw unavailable()
		this.valid(op)
		await this.checkpoint("reserve", op.intent.operationId)
		this.valid(op)
		await this.safeDirectory(dirname(this.finalPath(op.intent)), true, op)
		this.valid(op)
		let free: number
		try {
			free = await this.context.freeBytes()
		} catch (cause) {
			throw coded("disk-unavailable", "Free disk unavailable", cause)
		}
		if (!Number.isFinite(free) || free < 0)
			throw coded("disk-unavailable", "Invalid free disk measurement")
		const legacy = await this.context.legacyBytes()
		this.valid(op)
		await this.exclusive(async () => {
			if (!this.ready) throw unavailable()
			if (this.inventory.unknown)
				throw coded("recovery-incomplete", "Unknown recording inventory")
			if (
				this.inventory.intents.size + this.unpublished() >=
				MAX_RECOVERY_OPERATIONS
			)
				throw new AnalogStorageCountError("Operation inventory limit")
			this.valid(op)
			// Space reserved and not yet written: free disk measured before the lock has not seen
			// it, so it is subtracted here (writes since only make the check stricter).
			const outstanding = this.reservedUnused() + this.uncertainUnused()
			if (free - outstanding - RESERVATION < this.context.limits().minFreeBytes)
				throw coded("disk-low", "Insufficient reserved free disk")
			if (
				this.inventory.bytes + legacy + outstanding + RESERVATION >
				this.context.limits().maxBytes
			) {
				throw new AnalogStorageBytesError("Recording storage cap")
			}
			op.reservation = true
			// What this admission left: less than one more RESERVATION of bytes under the cap, or
			// fewer than OPERATION_HEADROOM operations under the bound (this one counted, it is
			// reserved and unpublished). Both are states retention evicts for (quotaShortfall > 0,
			// operationsFull), so an early pass asked on them can act.
			const roomBytes =
				this.context.limits().maxBytes -
				(this.inventory.bytes + legacy + outstanding + RESERVATION)
			const roomCount =
				MAX_RECOVERY_OPERATIONS -
				(this.inventory.intents.size + this.unpublished())
			const bytes = roomBytes < RESERVATION
			const count = roomCount < OPERATION_HEADROOM
			op.roomShort = bytes || count ? { bytes, count } : null
		})
		this.valid(op)
		await this.safeDirectory(
			dirname(this.opDir(op.intent.operationId)),
			true,
			op,
		)
		// Built under a staging name, published by one rename once intent.json is synced: a
		// crash anywhere before leaves a folder recovery recognises as residue (no media).
		const id = op.intent.operationId
		const staging = this.stagingDir(id)
		await mkdir(staging)
		op.ownedDirectory = true
		op.staged = true
		await this.checkpoint("staging-dir", id)
		await this.safeDirectory(staging, false, op)
		this.valid(op)
		await this.publishIntent(op, staging)
		this.valid(op)
		await this.syncDirectory(staging, "staging")
		await this.checkpoint("staging-synced", id)
		this.valid(op)
		await this.safeDirectory(dirname(this.opDir(id)), false, op)
		// rename(2) silently replaces an existing empty directory on Linux and macOS, so the
		// lstat below is a check, not an exclusive create. Acceptable: the id is a fresh random
		// UUID nothing else in this process names, so only an outside writer guessing it between
		// this lstat and the rename could be replaced, and only by an empty directory (no media lost).
		try {
			await lstat(this.opDir(id))
			throw coded("recovery-ambiguous", "Operation folder already exists")
		} catch (cause) {
			if (nativeCode(cause) !== "ENOENT") throw cause
		}
		await this.moveDirectory(staging, this.opDir(id))
		op.staged = false
		// Published: its intent counts toward the operation bound from here (the bytes are
		// within its reservation). The settlement's refresh replaces this with what is on disk.
		this.auditTouched?.add(id)
		dropOperation(this.inventory, id)
		addOperation(this.inventory, {
			id,
			bytes: 0,
			metadataBytes: 0,
			unknown: false,
			intent: op.intent,
			cleanup: false,
			residue: [],
		})
		await this.syncDirectory(dirname(this.opDir(id)), "operations")
		this.valid(op)
		await this.checkpoint("intent", id)
		this.valid(op)
		op.writer = await WavFileWriter.open(this.stagePath(op.intent), 8000, {
			io: this.writerIo(op),
		})
		this.valid(op)
		await this.checkpoint("stage", op.intent.operationId)
		this.valid(op)
	}
	/** Reserved operations whose intent is not inventoried yet (their folder is being built). */
	private unpublished(): number {
		let count = 0
		for (const [id, op] of this.active)
			if (op.reservation && !this.inventory.intents.has(id)) count++
		return count
	}
	private reservedUnused(): number {
		let bytes = 0
		for (const op of this.active.values())
			if (op.reservation)
				bytes += Math.max(
					0,
					RESERVATION -
						(this.inventory.opBytes.get(op.intent.operationId) ?? 0),
				)
		return bytes
	}
	private uncertainUnused(): number {
		let bytes = 0
		for (const [id, residue] of this.uncertainResidue)
			if (!this.active.has(id))
				bytes += Math.max(
					0,
					residue.bytes - (this.inventory.opBytes.get(id) ?? 0),
				)
		return bytes
	}
	private trackedHandle(op: Operation, handle: WavHandle): WavHandle {
		op.descriptors.add(handle)
		return {
			write: (buffer, offset, length, position) =>
				handle.write(buffer, offset, length, position),
			sync: () => handle.sync(),
			close: async () => {
				await handle.close()
				op.descriptors.delete(handle)
			},
		}
	}
	private writerIo(op: Operation): WavIo {
		const injected = this.io.wavIo
		return {
			open: async (path, flags) =>
				this.trackedHandle(
					op,
					await (injected?.open(path, flags) ?? open(path, flags)),
				),
			unlink: async path => {
				if (op.descriptors.size)
					throw coded("cleanup-failed", "Descriptor closure unconfirmed")
				const noise = op.noise
				const quarantine = this.context.noiseQuarantine
				if (
					noise !== null &&
					quarantine &&
					path === this.stagePath(op.intent)
				) {
					op.noise = null
					const ids = {
						operationId: op.intent.operationId,
						discoveryId: op.intent.discoveryId,
						observationId: op.intent.observationId,
					}
					// Moved: the part is gone, as an unlink leaves it. Not moved: deleted below.
					if (await quarantine(path, ids, noise).catch(() => false)) return
				}
				await (injected?.unlink(path) ?? this.io.unlink(path))
			},
			inspect: injected
				? path => injected.inspect(path)
				: async path => {
						const handle = await open(
							path,
							constants.O_RDONLY | constants.O_NOFOLLOW,
						)
						const tracked = this.trackedHandle(op, handle)
						try {
							const header = Buffer.alloc(44)
							let offset = 0
							while (offset < header.length) {
								const { bytesRead } = await handle.read(
									header,
									offset,
									header.length - offset,
									offset,
								)
								if (!bytesRead) throw coded("close-failed", "Short WAV header")
								offset += bytesRead
							}
							return { header, fileBytes: (await handle.stat()).size }
						} finally {
							await tracked.close()
						}
					},
		}
	}
	private async publishIntent(op: Operation, dir: string): Promise<void> {
		const temp = join(dir, "intent.tmp")
		await this.writeSynced(temp, boundedJson(op.intent), op)
		await this.checkpoint("intent-written", op.intent.operationId)
		this.valid(op)
		await this.safeTarget(join(dir, "intent.json"), op)
		this.valid(op)
		await link(temp, join(dir, "intent.json"))
		op.ownedIntent = true
		await this.checkpoint("intent-linked", op.intent.operationId)
		this.valid(op)
		await this.io.unlink(temp)
		this.valid(op)
	}
	private moveDirectory(from: string, to: string): Promise<void> {
		return this.io.rename?.(from, to) ?? rename(from, to)
	}
	/** fsync of a directory's entries; a tolerated refusal (DIRECTORY_SYNC_TOLERATED) is accepted. */
	private async syncDirectory(
		path: string,
		kind: AnalogDirectorySyncKind,
	): Promise<void> {
		try {
			await (this.io.fsyncDir?.(path) ?? fsyncDirectory(path))
		} catch (cause) {
			const code = nativeCode(cause)
			if (typeof code !== "string" || !DIRECTORY_SYNC_TOLERATED.has(code))
				throw cause
			if (!directorySyncWarned) {
				directorySyncWarned = true
				this.context.directorySyncTolerated?.(code, kind)
			}
		}
	}
	/** Removes a never-published staging folder: it holds intent metadata only, nothing listed. */
	private async cleanupStaging(intent: Intent): Promise<void> {
		const id = intent.operationId
		const dir = this.stagingDir(id)
		this.requireCleanupClosure(id)
		for (const name of ["intent.tmp", "intent.json"]) {
			const path = join(dir, name)
			await this.safeTarget(path)
			this.requireCleanupClosure(id)
			try {
				await this.io.unlink(path)
			} catch (cause) {
				if (nativeCode(cause) !== "ENOENT") throw cause
			}
			await this.checkpoint("staging-cleanup", id)
		}
		this.requireCleanupClosure(id)
		try {
			await (this.io.rmdir?.(dir) ?? rmdir(dir))
		} catch (cause) {
			if (nativeCode(cause) !== "ENOENT") throw cause
		}
	}
	private async writeSynced(
		path: string,
		body: Buffer,
		op?: Operation,
	): Promise<void> {
		await this.safeTarget(path, op)
		if (op) this.valid(op)
		const opened = await (this.io.metadataOpen?.(path) ?? open(path, "wx"))
		const handle = op ? this.trackedHandle(op, opened) : opened
		try {
			if (op) this.valid(op)
			let offset = 0
			while (offset < body.length) {
				const { bytesWritten } = await handle.write(
					body,
					offset,
					Math.min(1024, body.length - offset),
					offset,
				)
				if (
					!Number.isSafeInteger(bytesWritten) ||
					bytesWritten <= 0 ||
					bytesWritten > Math.min(1024, body.length - offset)
				)
					throw coded("write-failed", "Metadata write made no progress")
				offset += bytesWritten
				if (op) this.valid(op)
			}
			await handle.sync()
			if (op) this.valid(op)
		} finally {
			await handle.close()
		}
	}
	private finishOperation(
		op: Operation,
		cut: AnalogCut,
	): Promise<AnalogReceipt> {
		op.accepting = false
		op.finish ??= this.runFinish(op, cut)
		return op.finish
	}
	private async runFinish(
		op: Operation,
		cut: AnalogCut,
	): Promise<AnalogReceipt> {
		let error: AnalogError = "write-failed"
		try {
			await op.ready
			this.valid(op)
			if (!op.writer) throw coded("write-failed", "Missing admitted WAV writer")
			error = "close-failed"
			op.output = await op.writer.finish()
			if (cut === "completed" && op.output.durationMs >= 120_000)
				cut = "duration-limit"
			this.valid(op)
			await this.checkpoint("closed", op.intent.operationId)
			this.valid(op)
			await this.context.serialise(op.intent.discoveryId, async () => {
				this.valid(op)
				error = "rename-failed"
				await this.safeDirectory(dirname(this.finalPath(op.intent)), true, op)
				this.valid(op)
				await this.safeTarget(this.finalPath(op.intent), op)
				this.valid(op)
				await link(this.stagePath(op.intent), this.finalPath(op.intent))
				op.ownedMedia = true
				this.valid(op)
				await this.checkpoint("media-linked", op.intent.operationId)
				this.valid(op)
				await this.io.unlink(this.stagePath(op.intent))
				this.valid(op)
				const metadata = PreparedRecordingMetadataSchema.parse({
					version: 1,
					operationId: op.intent.operationId,
					producerRecordingId: op.intent.operationId,
					discoveryId: op.intent.discoveryId,
					observationId: op.intent.observationId,
					alias: op.intent.alias,
					artifact: op.intent.artifact,
					binding: op.intent.binding,
					desiredState:
						cut === "completed" || cut === "duration-limit" ? "linked" : "cut",
					expectedOutput: {
						sampleRateHz: 8000,
						channelCount: 1,
						outputFrames: op.output!.outputFrames,
						fileBytes: op.output!.fileBytes,
					},
				})
				error = "metadata-failed"
				op.prepared = true
				await this.context.adapter.prepare(metadata)
				op.metadataAck = true
				this.valid(op)
				await this.checkpoint("prepared", op.intent.operationId)
				this.valid(op)
				const receipt = this.makeReceipt(
					op,
					"finalized",
					cut,
					"pending",
					null,
					null,
				)
				const bytes = boundedJson(receipt)
				if (
					bytes.length + boundedJson(op.intent).length >
					MAX_OPERATION_METADATA_BYTES
				)
					throw coded(
						"storage-cap",
						"Aggregate operation metadata exceeds bound",
					)
				const markerTemp = join(
					this.opDir(op.intent.operationId),
					"receipt.tmp",
				)
				await this.writeSynced(markerTemp, bytes, op)
				this.valid(op)
				await this.checkpoint("marker-ready", op.intent.operationId)
				// All injected/reentrant checks complete before the final plain store-plan check.
				this.valid(op)
				op.candidate = receipt
				const availability = { intent: op.intent, receipt, available: false }
				this.available.set(op.intent.alias, availability)
				const plan = this.context.adapter.buildCommitPlan(op.intent.operationId)
				if (!plan)
					throw coded(
						"metadata-failed",
						"Current prepared association is unavailable",
					)
				this.valid(op)
				const marker = join(this.opDir(op.intent.operationId), "receipt.json")
				this.safeTargetSync(marker)
				const healthy = this.context.adapter.authorityHealthy()
				const admitted = this.context.admits(op.intent.discoveryId)
				const current = this.context.adapter.commitPlanCurrent(plan)
				if (
					!current ||
					!admitted ||
					!healthy ||
					op.cancelled ||
					plan.observation.recordingIds !== plan.priorIds ||
					plan.observation.recording !== plan.priorRecording ||
					plan.evidence.recordings !== plan.priorCount ||
					plan.discovery.evidence !== plan.evidence ||
					plan.observation.discoveryId !== plan.discovery.id
				) {
					op.failure ??= op.cancelled ? "cancelled" : "commit-plan-stale"
					throw coded("admission-denied", "Current commit plan invalidated")
				}
				try {
					linkSync(markerTemp, marker)
				} catch (cause) {
					if (nativeCode(cause) === "EEXIST") op.foreignMarker = true
					throw coded(
						"recovery-ambiguous",
						"Exclusive marker publication failed",
						cause,
					)
				}
				// Irrevocable decision: plain assignments only; no callbacks/events/resolvers.
				op.markerLinked = true
				plan.observation.recordingIds = plan.recordingIds
				plan.observation.recording = plan.recordingState
				plan.evidence.recordings = plan.recordingCount
				op.decision = receipt
				availability.available = true
				// Projection is captured before listeners by the store adapter, never saved/replayed here.
				try {
					this.context.adapter.publishCommit(plan)
				} catch {
					/* immutable commit survives listeners */
				}
			})
		} catch (cause) {
			// Even an unexpected plain assignment failure after our own link cannot compensate it.
			if (op.markerLinked && !op.decision) op.decision = op.candidate
			if (!op.decision && op.foreignMarker) {
				try {
					const reconciliation = await this.reconcile(op.intent)
					const prior = this.available.get(op.intent.alias)
					if (
						reconciliation.status === "available" &&
						prior?.available &&
						prior.receipt.output.outputFrames === op.output?.outputFrames &&
						prior.receipt.output.fileBytes === op.output?.fileBytes
					)
						op.decision = prior.receipt
				} catch {
					/* ambiguous ownership retains residue and still settles below */
				}
			}
			if (!op.decision) {
				const ownCode = cause instanceof WaveKitError ? cause.code : ""
				if (ownCode === "SCANNER_WAV_INVALID") error = "header-invalid"
				for (const candidate of ErrorSchema.options)
					if (
						ownCode ===
						`SCANNER_ANALOG_${candidate.toUpperCase().replaceAll("-", "_")}`
					)
						error = candidate
				let cleanup: "complete" | "pending" = "complete"
				try {
					if (op.writer) {
						try {
							await op.writer.abort()
						} catch (writerCause) {
							if (
								!op.output &&
								!(
									writerCause instanceof WaveKitError &&
									writerCause.code === "SCANNER_WAV_CANCELLED"
								)
							) {
								this.uncertainResidue.set(op.intent.operationId, {
									discoveryId: op.intent.discoveryId,
									bytes: RESERVATION,
									descriptors: op.descriptors,
								})
								throw coded(
									"cleanup-failed",
									"Writer closure is unverifiable",
									writerCause,
								)
							}
						}
					}
					if (op.descriptors.size) {
						this.uncertainResidue.set(op.intent.operationId, {
							discoveryId: op.intent.discoveryId,
							bytes: RESERVATION,
							descriptors: op.descriptors,
						})
						throw coded(
							"cleanup-failed",
							"Descriptor closure remains unconfirmed",
						)
					}
					if (op.foreignMarker)
						throw coded(
							"recovery-ambiguous",
							"Existing marker requires reconciliation",
						)
					if (op.prepared)
						await this.context.adapter.inverse(op.intent.operationId)
					if (op.ownedDirectory && op.staged)
						await this.cleanupStaging(op.intent)
					else if (op.ownedDirectory)
						await this.cleanupOwned(op.intent, op.ownedIntent, op.ownedMedia)
				} catch {
					cleanup = "pending"
					error = op.foreignMarker ? "recovery-ambiguous" : "cleanup-failed"
				}
				await this.settleInventory(op)
				const slot = this.available.get(op.intent.alias)
				if (slot && !slot.available) this.available.delete(op.intent.alias)
				op.decision = this.makeReceipt(
					op,
					op.cancelled && cleanup === "complete" ? "aborted" : "failed",
					op.cancelled ?? cut,
					cleanup,
					this.inventory.unknown ||
						this.uncertainResidue.has(op.intent.operationId)
						? null
						: (this.inventory.opBytes.get(op.intent.operationId) ?? 0),
					error,
				)
			}
		}
		// These independent postdecision steps cannot change the finalized outcome.
		if (op.decision?.outcome === "finalized") {
			try {
				await this.checkpoint("decided", op.intent.operationId)
			} catch {
				/* reconciliation owns later diagnostics */
			}
			try {
				await this.io.unlink(
					join(this.opDir(op.intent.operationId), "receipt.tmp"),
				)
			} catch {
				/* retained and inventoried */
			}
			await this.settleInventory(op)
		}
		const result = op.decision!
		this.active.delete(op.intent.operationId)
		op.resolve(result)
		return result
	}
	/**
	 * A settling operation's files are final (no step of this process changes them any more):
	 * they are read outside the lock, then swapped into the inventory with its reservation
	 * released in one synchronous step under it. An unknown inventory runs the full scan instead.
	 */
	private async settleInventory(op: Operation): Promise<void> {
		let scans: OperationScan[] | null
		try {
			scans = await this.scanIds([op.intent.operationId])
		} catch {
			scans = null
		}
		await this.exclusive(async () => {
			try {
				if (scans === null || this.inventory.unknown) await this.scanInventory()
				else this.applyScans(scans)
			} catch {
				this.inventory.unknown = true
			}
			op.reservation = false
		})
	}
	private makeReceipt(
		op: Operation,
		outcome: "finalized" | "aborted" | "failed",
		cutReason: AnalogCut,
		cleanup: "complete" | "pending",
		residueBytes: number | null,
		errorCode: AnalogError | null,
	): AnalogReceipt {
		return freeze(
			AnalogReceiptSchema.parse({
				version: 1,
				operationId: op.intent.operationId,
				producerRecordingId: op.intent.operationId,
				producerId: "scanner-analog",
				producerRunId: op.intent.producerRunId,
				producerStoreId: null,
				discoveryId: op.intent.discoveryId,
				observationId: op.intent.observationId,
				alias: outcome === "finalized" ? op.intent.alias : null,
				binding: op.intent.binding,
				output: op.output
					? {
							format: "s16le-wav",
							sampleRateHz: 8000,
							channelCount: 1,
							outputFrames: op.output.outputFrames,
							fileBytes: op.output.fileBytes,
						}
					: {
							format: null,
							sampleRateHz: null,
							channelCount: null,
							outputFrames: null,
							fileBytes: null,
						},
				gaps: op.gaps,
				omittedGapCount: op.omitted,
				cutReason,
				...(op.cutActive === null ? {} : { cutActive: op.cutActive }),
				...(outcome === "finalized" ? op.verdict : {}),
				closure: op.descriptors.size
					? "unknown"
					: op.output
						? "closed"
						: "incomplete",
				outcome,
				artifact: outcome === "finalized" ? op.intent.artifact : null,
				cleanup,
				residueBytes,
				errorCode,
				...(outcome !== "finalized" && op.failure !== null
					? { failure: op.failure }
					: {}),
				durability: {
					mediaFileSync: op.output ? "synced" : "not-acknowledged",
					metadata: op.metadataAck
						? "journal-append-prepared-link"
						: "not-acknowledged",
					metadataPowerLossDurable: false,
					finalMarkerFileSync:
						outcome === "finalized" ? "synced" : "not-acknowledged",
					finalMarkerDirectorySync: "not-attempted",
				},
			}),
		)
	}

	/** Canonicalize only the trusted configured root; operation paths never select an anchor. */
	private async anchorRoot(): Promise<void> {
		if (this.rootAnchored) return
		let original: Stats
		try {
			original = await lstat(this.root)
		} catch (cause) {
			if (nativeCode(cause) !== "ENOENT") throw cause
			await mkdir(this.root, { recursive: true })
			original = await lstat(this.root)
		}
		if (original.isSymbolicLink() || !original.isDirectory())
			throw coded("recovery-incomplete", "Invalid configured storage root")
		const canonical = await realpath(this.root)
		const [current, physical] = await Promise.all([
			lstat(this.root),
			lstat(canonical),
		])
		if (
			current.isSymbolicLink() ||
			!current.isDirectory() ||
			physical.isSymbolicLink() ||
			!physical.isDirectory() ||
			current.dev !== original.dev ||
			current.ino !== original.ino ||
			physical.dev !== original.dev ||
			physical.ino !== original.ino
		)
			throw coded("recovery-incomplete", "Configured storage root changed")
		this.root = canonical
		this.rootAnchored = true
	}

	private async safeDirectory(
		path: string,
		create = false,
		op?: Operation,
	): Promise<void> {
		const absolute = resolve(path)
		if (absolute !== this.root && !absolute.startsWith(this.root + sep))
			throw coded("recovery-incomplete", "Path leaves storage root")
		const pieces = absolute.split(sep).filter(Boolean)
		let parent: string = sep
		for (const piece of pieces) {
			parent = join(parent, piece)
			let info: Stats
			try {
				info = await lstat(parent)
				if (op) this.valid(op)
			} catch (cause) {
				if (
					!create ||
					nativeCode(cause) !== "ENOENT" ||
					(parent !== this.root && !parent.startsWith(this.root + sep))
				)
					throw cause
				try {
					if (op) this.valid(op)
					await mkdir(parent)
					if (op) this.valid(op)
				} catch (mkdirCause) {
					if (nativeCode(mkdirCause) !== "EEXIST") throw mkdirCause
				}
				info = await lstat(parent)
				if (op) this.valid(op)
			}
			if (info.isSymbolicLink() || !info.isDirectory())
				throw coded(
					"recovery-incomplete",
					"Symlink or non-directory storage ancestor",
				)
		}
	}
	private async safeTarget(path: string, op?: Operation): Promise<void> {
		await this.safeDirectory(dirname(path), false, op)
		if (op) this.valid(op)
		try {
			const info = await lstat(path)
			if (op) this.valid(op)
			if (info.isSymbolicLink() || !info.isFile())
				throw coded("recovery-incomplete", "Unsafe storage target")
		} catch (cause) {
			if (nativeCode(cause) !== "ENOENT") throw cause
		}
	}
	private safeTargetSync(path: string): void {
		const absolute = resolve(path)
		if (!absolute.startsWith(this.root + sep))
			throw coded("recovery-incomplete", "Path leaves storage root")
		let parent: string = sep
		for (const piece of dirname(absolute).split(sep).filter(Boolean)) {
			parent = join(parent, piece)
			const info = lstatSync(parent)
			if (info.isSymbolicLink() || !info.isDirectory())
				throw coded("recovery-incomplete", "Unsafe marker ancestor")
		}
		try {
			const info = lstatSync(path)
			if (info.isSymbolicLink() || !info.isFile())
				throw coded("recovery-incomplete", "Unsafe marker target")
		} catch (cause) {
			if (nativeCode(cause) !== "ENOENT") throw cause
		}
	}
	private async closeRead(handle: FileHandle): Promise<void> {
		try {
			await handle.close()
		} catch (cause) {
			this.unconfirmedReads.add(handle)
			this.inventory.unknown = true
			throw cause
		}
	}
	private async readJson(path: string): Promise<unknown> {
		if (this.unconfirmedReads.size)
			throw coded("cleanup-failed", "Read descriptor closure unconfirmed")
		await this.safeTarget(path)
		const handle = await (this.io.readOpen?.(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		) ?? open(path, constants.O_RDONLY | constants.O_NOFOLLOW))
		try {
			const info = await handle.stat()
			if (!info.isFile() || info.size > MAX_OPERATION_METADATA_BYTES)
				throw coded("recovery-incomplete", "Invalid metadata size")
			const bytes = Buffer.alloc(info.size)
			let offset = 0
			while (offset < bytes.length) {
				const { bytesRead } = await handle.read(
					bytes,
					offset,
					bytes.length - offset,
					offset,
				)
				if (!bytesRead)
					throw coded("recovery-incomplete", "Truncated operation metadata")
				offset += bytesRead
			}
			return JSON.parse(bytes.toString("utf8")) as unknown
		} finally {
			await this.closeRead(handle)
		}
	}
	private async mediaValid(
		intent: Intent,
		receipt: AnalogReceipt,
	): Promise<boolean> {
		if (this.unconfirmedReads.size)
			throw coded("cleanup-failed", "Read descriptor closure unconfirmed")
		await this.safeTarget(this.finalPath(intent))
		const path = this.finalPath(intent)
		const flags = constants.O_RDONLY | constants.O_NOFOLLOW
		const handle = await (this.io.readOpen?.(path, flags) ?? open(path, flags))
		try {
			const info = await handle.stat()
			const header = Buffer.alloc(44)
			let offset = 0
			while (offset < 44) {
				const { bytesRead } = await handle.read(
					header,
					offset,
					44 - offset,
					offset,
				)
				if (!bytesRead) return false
				offset += bytesRead
			}
			return (
				info.isFile() &&
				receipt.output.fileBytes !== null &&
				receipt.output.outputFrames !== null &&
				info.size === receipt.output.fileBytes &&
				info.size === 44 + 2 * receipt.output.outputFrames &&
				header.equals(wavHeader(8000, info.size - 44))
			)
		} finally {
			await this.closeRead(handle)
		}
	}
	private matches(intent: Intent, receipt: AnalogReceipt): boolean {
		return (
			receipt.outcome === "finalized" &&
			receipt.operationId === intent.operationId &&
			receipt.producerRecordingId === intent.operationId &&
			receipt.producerRunId === intent.producerRunId &&
			receipt.discoveryId === intent.discoveryId &&
			receipt.observationId === intent.observationId &&
			receipt.alias === intent.alias &&
			receipt.artifact === intent.artifact &&
			JSON.stringify(receipt.binding) === JSON.stringify(intent.binding)
		)
	}
	private async children(path: string, limit: number): Promise<string[]> {
		const names: string[] = []
		let directory: Awaited<ReturnType<typeof opendir>>
		try {
			directory = await opendir(path)
		} catch (cause) {
			if (nativeCode(cause) === "ENOENT") return names
			throw cause
		}
		try {
			for await (const entry of directory) {
				if (names.length === limit)
					throw coded("recovery-incomplete", "Operation inventory overflow")
				names.push(entry.name)
			}
		} catch (cause) {
			try {
				await directory.close()
			} catch {
				/* iterator may already close */
			}
			throw cause
		}
		return names
	}
	private cleanupPath(id: string): string {
		return join(this.root, ".analog-operations", `${id}.cleanup`)
	}
	/** Null while nothing is held set aside. */
	setAsideStatus(): AnalogSetAsideStatus | null {
		if (this.setAsideHeld === 0) return null
		return {
			setAside: this.setAsideHeld,
			...(this.lastSetAsideReason
				? { lastReason: this.lastSetAsideReason }
				: {}),
		}
	}
	/**
	 * True when `dir` holds only regular files named in `allowed`, together at most
	 * MAX_OPERATION_METADATA_BYTES: intent metadata, never media or a receipt. Any doubt: false.
	 * Hard links count once (a crash at `intent-linked` leaves intent.tmp and intent.json as one file).
	 */
	private async metadataOnly(
		dir: string,
		allowed: readonly string[],
	): Promise<boolean> {
		try {
			let bytes = 0
			const inodes = new Set<string>()
			for (const name of await this.children(dir, allowed.length)) {
				if (!allowed.includes(name)) return false
				const info = await lstat(join(dir, name))
				if (info.isSymbolicLink() || !info.isFile()) return false
				const inode = `${info.dev}:${info.ino}`
				if (inodes.has(inode)) continue
				inodes.add(inode)
				bytes += info.size
			}
			return bytes <= MAX_OPERATION_METADATA_BYTES
		} catch {
			return false
		}
	}
	/** No `recordings/analog/<folder>/analog-<id>.wav` anywhere (bounded, see MEDIA_SEARCH_FOLDERS). */
	private async mediaAbsent(id: string): Promise<boolean> {
		if (this.mediaBearing.has(id)) return false
		const analogRoot = join(this.root, "recordings", "analog")
		let folders: string[]
		try {
			await this.safeDirectory(analogRoot)
			folders = await this.children(analogRoot, MEDIA_SEARCH_FOLDERS)
		} catch (cause) {
			return nativeCode(cause) === "ENOENT"
		}
		if (this.mediaFree.get(id) === folders.length) return true
		this.mediaFree.delete(id)
		const probe = this.io.mediaLstat ?? lstat
		for (const folder of folders) {
			try {
				await probe(join(analogRoot, folder, `analog-${id}.wav`))
				this.mediaBearing.add(id)
				return false
			} catch (cause) {
				const code = nativeCode(cause)
				if (code !== "ENOENT" && code !== "ENOTDIR") return false
			}
		}
		this.mediaFree.set(id, folders.length)
		return true
	}
	/**
	 * Moves verified residue into `.set-aside/` (one rename each, atomic: a crash leaves it either
	 * place, both handled) and deletes the oldest evictable entries past ANALOG_SET_ASIDE_MAX; an
	 * entry not proven media-free is kept and counted, so `setAsideHeld` may exceed it. A residue
	 * folder that cannot move stays where it is: it was verified harmless, so it never poisons.
	 * An unsafe `.set-aside` (a symlink, a file) is tampering: fail closed.
	 */
	private async tendSetAside(
		base: string,
		residue: readonly {
			name: string
			id: string
			reason: AnalogSetAsideReason
		}[],
		next: Inventory,
	): Promise<void> {
		const dir = this.setAsideDir()
		try {
			await this.safeDirectory(dir, residue.length > 0)
		} catch {
			next.unknown = true
			return
		}
		let entries: string[]
		try {
			// Our own moves add at most one entry per base child (MAX_RECOVERY_OPERATIONS * 2).
			entries = (
				await this.children(
					dir,
					ANALOG_SET_ASIDE_MAX + MAX_RECOVERY_OPERATIONS * 2,
				)
			)
				.filter(name => SET_ASIDE_ENTRY.test(name))
				.sort()
		} catch {
			next.unknown = true
			return
		}
		let stamp = Date.now()
		for (const name of entries)
			stamp = Math.max(stamp, Number(name.slice(0, 13)) + 1)
		let moved = 0
		for (const item of residue) {
			// The target name carries a stamp past every entry listed and a random UUID, and the
			// scan holds the lock, so it never names an existing entry. rename(2) would replace an
			// empty directory there (Linux, macOS); none can exist short of an outside writer, and
			// an empty one holds nothing to lose.
			const target = `${String(stamp++).padStart(13, "0")}-${item.id}`
			try {
				await this.moveDirectory(join(base, item.name), join(dir, target))
			} catch {
				continue
			}
			entries.push(target)
			moved++
			this.lastSetAsideReason = item.reason
			// An operation folder's files were counted as metadata by the scan; a staging folder's
			// never were (its name differs from the id). Moved out, they no longer count.
			if (item.name === item.id) {
				// A staging item leaves the id's bytes alone: they belong to a published folder.
				dropOperation(next, item.id)
			}
			await this.checkpoint("set-aside", item.id)
		}
		let evicted = 0
		for (
			let i = 0;
			i < entries.length && entries.length > ANALOG_SET_ASIDE_MAX;
		) {
			if (await this.evictSetAside(join(dir, entries[i]!))) {
				entries.splice(i, 1)
				evicted++
				await this.checkpoint("set-aside-evicted", "")
			} else i++
		}
		this.setAsideHeld = entries.length
		if (moved || evicted)
			this.context.setAsideLogged?.({ moved, evicted, held: entries.length })
	}
	/** Deletes one set-aside entry holding only intent metadata; anything else is left. */
	private async evictSetAside(path: string): Promise<boolean> {
		try {
			const info = await lstat(path)
			if (info.isSymbolicLink() || !info.isDirectory()) return false
			if (!(await this.metadataOnly(path, ["intent.tmp", "intent.json"])))
				return false
			for (const name of await this.children(path, 2))
				await this.io.unlink(join(path, name))
			await (this.io.rmdir?.(path) ?? rmdir(path))
			return true
		} catch {
			return false
		}
	}
	/**
	 * The `.analog-operations/` listing grouped by operation id: which of its cleanup marker,
	 * staging folder and operation folder are present. `invalid` when a name is not one of
	 * them (fail closed). Throws when the root or the folder is unsafe or unlistable.
	 */
	private async listOperations(): Promise<OperationListing> {
		await this.anchorRoot()
		await this.safeDirectory(this.root, true)
		const base = join(this.root, ".analog-operations")
		await this.safeDirectory(base, true)
		const all = await this.children(base, MAX_RECOVERY_OPERATIONS * 2)
		// Cleanups run outside the lock: any listed entry may vanish from here on.
		await this.checkpoint("inventory-listed", "")
		const ids = new Map<string, Presence>()
		let invalid = false
		let setAsidePresent = false
		const presence = (id: string): Presence => {
			let entry = ids.get(id)
			if (!entry) {
				entry = { cleanup: false, staging: false, folder: false }
				ids.set(id, entry)
			}
			return entry
		}
		for (const name of all) {
			if (name === SET_ASIDE_DIR) {
				setAsidePresent = true
				continue
			}
			const id = name.startsWith(STAGING_PREFIX)
				? name.slice(STAGING_PREFIX.length)
				: name.endsWith(".cleanup")
					? name.slice(0, -8)
					: name
			if (!UUIDSchema.safeParse(id).success) {
				invalid = true
				continue
			}
			const entry = presence(id)
			if (name.startsWith(STAGING_PREFIX)) entry.staging = true
			else if (name.endsWith(".cleanup")) entry.cleanup = true
			else entry.folder = true
		}
		// Staging names never counted toward the operation bound (they carry no published intent).
		const published = [...ids.values()].filter(
			entry => entry.cleanup || entry.folder,
		).length
		if (published > MAX_RECOVERY_OPERATIONS)
			throw coded("recovery-incomplete", "Operation inventory overflow")
		return { ids, invalid, setAsidePresent }
	}
	/** One id's entries on disk now (lstat of each name): a doubt other than ENOENT is unknown. */
	private async presenceOf(id: string): Promise<Presence | null> {
		const present = async (path: string): Promise<boolean | null> => {
			try {
				await lstat(path)
				return true
			} catch (cause) {
				return nativeCode(cause) === "ENOENT" ? false : null
			}
		}
		const [cleanup, staging, folder] = await Promise.all([
			present(this.cleanupPath(id)),
			present(this.stagingDir(id)),
			present(this.opDir(id)),
		])
		if (cleanup === null || staging === null || folder === null) return null
		return { cleanup, staging, folder }
	}
	/**
	 * One operation id's share of the inventory: its cleanup marker, staging folder and operation
	 * folder (as `has` says they were listed) and the media its intent names. Reads only; the
	 * checks are the full scan's, per id. Hard links are counted once within the id (a link
	 * across ids, never made here, counts twice: more, never less).
	 */
	private async scanOperation(
		id: string,
		has: Presence,
	): Promise<OperationScan> {
		try {
			return await this.readOperation(id, has)
		} catch {
			// Any read the checks did not settle (an over-bound or unreadable folder): unknown.
			return {
				id,
				bytes: 0,
				metadataBytes: 0,
				unknown: true,
				intent: null,
				cleanup: false,
				residue: [],
			}
		}
	}
	private async readOperation(
		id: string,
		has: Presence,
	): Promise<OperationScan> {
		const out: OperationScan = {
			id,
			bytes: 0,
			metadataBytes: 0,
			unknown: false,
			intent: null,
			cleanup: false,
			residue: [],
		}
		const inodes = new Set<string>()
		const account = async (path: string, metadata: boolean): Promise<void> => {
			try {
				const info = await lstat(path)
				if (
					!info.isFile() ||
					info.isSymbolicLink() ||
					!Number.isSafeInteger(info.size) ||
					info.size < 0
				) {
					out.unknown = true
					return
				}
				const inode = `${info.dev}:${info.ino}`
				if (inodes.has(inode)) return
				inodes.add(inode)
				out.bytes += info.size
				if (metadata) out.metadataBytes += info.size
			} catch (cause) {
				if (nativeCode(cause) !== "ENOENT") out.unknown = true
			}
		}
		let cleanup: Intent | null = null
		if (has.cleanup) {
			try {
				if (!UUIDSchema.safeParse(id).success)
					throw coded("recovery-incomplete", "Invalid cleanup owner")
				const intent = IntentSchema.parse(
					await this.readJson(this.cleanupPath(id)),
				)
				if (intent.operationId !== id)
					throw coded("recovery-incomplete", "Cleanup ownership mismatch")
				cleanup = intent
				out.cleanup = true
				out.intent = intent
				await account(this.cleanupPath(id), true)
			} catch {
				out.unknown = true
			}
		}
		if (has.staging) await this.scanStaging(id, out, account)
		if (has.folder) await this.scanFolder(id, cleanup, out, account)
		if (cleanup) {
			await account(this.finalPath(cleanup), false)
			try {
				await lstat(this.finalPath(cleanup))
				out.unknown = true // A cleanup disposition never authorizes unexpected replacement media.
			} catch (cause) {
				if (nativeCode(cause) !== "ENOENT") out.unknown = true
			}
			if (out.bytes > MAX_OPERATION_METADATA_BYTES) out.unknown = true
		}
		return out
	}
	private async scanStaging(
		id: string,
		out: OperationScan,
		account: (path: string, metadata: boolean) => Promise<void>,
	): Promise<void> {
		const dir = this.stagingDir(id)
		if (!UUIDSchema.safeParse(id).success) {
			out.unknown = true
			return
		}
		// Ownership first: this process's own creation, or its unverifiable residue, is
		// counted and kept whatever its state, and a staging folder never holds media, so
		// one gone since the listing (a concurrent cleanupStaging) is simply gone.
		const owned = this.active.has(id) || this.uncertainResidue.has(id)
		try {
			await this.safeDirectory(dir)
		} catch (cause) {
			if (nativeCode(cause) !== "ENOENT") out.unknown = true
			return
		}
		if (owned) {
			for (const child of await this.children(dir, 8))
				await account(join(dir, child), true)
			return
		}
		if (await this.metadataOnly(dir, ["intent.tmp", "intent.json"]))
			out.residue.push({
				name: `${STAGING_PREFIX}${id}`,
				id,
				reason: "staging-residue",
			})
		else out.unknown = true
	}
	private async scanFolder(
		id: string,
		cleanup: Intent | null,
		out: OperationScan,
		account: (path: string, metadata: boolean) => Promise<void>,
	): Promise<void> {
		if (!UUIDSchema.safeParse(id).success) {
			out.unknown = true
			return
		}
		const dir = this.opDir(id)
		// An operation of this process mid-cleanup, or one a cleanup marker governs, may
		// remove its folder after the listing: gone, not unknown. Anyone else's: fail closed.
		const removable = this.active.has(id) || cleanup !== null
		try {
			await this.safeDirectory(dir)
		} catch (cause) {
			if (!removable || nativeCode(cause) !== "ENOENT") out.unknown = true
			return
		}
		let metadataBytes = 0
		const directoryNames = await this.children(dir, 8)
		if (cleanup && directoryNames.some(name => name !== "intent.json"))
			out.unknown = true
		for (const name of directoryNames) {
			const metadata = name !== "payload.wav.part"
			if (
				![
					"intent.json",
					"intent.tmp",
					"receipt.json",
					"receipt.tmp",
					"payload.wav.part",
				].includes(name)
			)
				out.unknown = true
			const before = out.bytes
			await account(join(dir, name), metadata)
			if (metadata) metadataBytes += out.bytes - before
		}
		if (metadataBytes > MAX_OPERATION_METADATA_BYTES) out.unknown = true
		try {
			const intent = IntentSchema.parse(
				await this.readJson(join(dir, "intent.json")),
			)
			if (intent.operationId !== id) {
				out.unknown = true
				return
			}
			if (cleanup && JSON.stringify(cleanup) !== JSON.stringify(intent))
				out.unknown = true
			out.intent = intent
			await this.safeDirectory(dirname(this.finalPath(intent)))
			await account(this.finalPath(intent), false)
		} catch (cause) {
			if (nativeCode(cause) === "ENOENT" && cleanup) {
				// Transferred authority only permits a known empty leftover directory.
				if ((await this.children(dir, 1)).length) out.unknown = true
				return
			}
			// The intent parsed, its media folder is gone: no media to count.
			if (nativeCode(cause) === "ENOENT" && out.intent) return
			// An operation of this process mid-cleanup (cleanup runs outside the lock).
			if (this.active.has(id)) return
			if (cleanup || this.uncertainResidue.has(id)) {
				out.unknown = true
				return
			}
			// Crash residue of an older image (mkdir before the intent link) or an intent
			// that cannot parse: set aside only when provably holding no media and no
			// receipt; anything else (a read error, other files) stays fail closed.
			const parseFailure =
				cause instanceof SyntaxError || cause instanceof z.ZodError
			let reason: AnalogSetAsideReason | null = null
			if (nativeCode(cause) === "ENOENT") {
				if (
					(await this.metadataOnly(dir, ["intent.tmp"])) &&
					(await this.mediaAbsent(id))
				)
					reason = "missing-intent"
			} else if (
				parseFailure &&
				(await this.metadataOnly(dir, ["intent.json", "intent.tmp"])) &&
				(await this.mediaAbsent(id))
			)
				reason = "invalid-intent"
			if (reason) out.residue.push({ name: id, id, reason })
			else out.unknown = true
		}
	}
	/**
	 * The full scan: every operation id listed, SCAN_CONCURRENCY at once (reads only), then the
	 * set-aside moves, under the lock. Replaces the inventory; the only path that can clear an
	 * unknown one. Startup recovery runs it, so does any refresh while the inventory is unknown
	 * and an audit that met crash residue; steady-state work refreshes single ids instead.
	 */
	private async scanInventory(): Promise<void> {
		this.scanEpoch++
		this.residuePending = false
		if (this.unconfirmedReads.size) {
			this.inventory.unknown = true
			return
		}
		const next = emptyInventory()
		try {
			const listing = await this.listOperations()
			if (listing.invalid) next.unknown = true
			const scans = await mapLimited(
				[...listing.ids],
				SCAN_CONCURRENCY,
				([id, has]) => this.scanOperation(id, has),
			)
			const residue: OperationScan["residue"] = []
			for (const scan of scans) {
				addOperation(next, scan)
				residue.push(...scan.residue)
			}
			this.pruneSearches(listing.ids)
			if (residue.length || listing.setAsidePresent)
				await this.tendSetAside(
					join(this.root, ".analog-operations"),
					residue,
					next,
				)
			else this.setAsideHeld = 0
			if (next.intents.size > MAX_RECOVERY_OPERATIONS) next.unknown = true
		} catch {
			next.unknown = true
		}
		if (this.unconfirmedReads.size) next.unknown = true
		// An explicit delete removed it: no longer quarantined (a doubtful scan keeps every entry).
		if (!next.unknown)
			for (const id of [...this.quarantine.keys()])
				if (!next.intents.has(id)) this.quarantine.delete(id)
		this.inventory = next
	}
	/** Forgets media searches of ids no longer listed. */
	private pruneSearches(listed: ReadonlyMap<string, Presence>): void {
		for (const id of [...this.mediaBearing])
			if (!listed.has(id)) this.mediaBearing.delete(id)
		for (const id of [...this.mediaFree.keys()])
			if (!listed.has(id)) this.mediaFree.delete(id)
	}
	/** Scans of `ids` now (reads only, no lock needed); null when a full scan is required. */
	private async scanIds(
		ids: Iterable<string>,
	): Promise<OperationScan[] | null> {
		if (this.inventory.unknown || this.unconfirmedReads.size) return null
		try {
			await this.anchorRoot()
			await this.safeDirectory(join(this.root, ".analog-operations"), true)
		} catch {
			return null
		}
		const scans = await mapLimited([...new Set(ids)], 1, async id => {
			const has = await this.presenceOf(id)
			if (has) return this.scanOperation(id, has)
			return {
				id,
				bytes: 0,
				metadataBytes: 0,
				unknown: true,
				intent: null,
				cleanup: false,
				residue: [],
			} satisfies OperationScan
		})
		return this.unconfirmedReads.size ? null : scans
	}
	/**
	 * Replaces each scanned id's share of the inventory (synchronous: call under the lock). A
	 * doubtful scan makes the inventory unknown (only a full scan clears it); crash residue
	 * found here stays counted until a full scan sets it aside.
	 */
	private applyScans(scans: readonly OperationScan[]): void {
		for (const scan of scans) {
			this.auditTouched?.add(scan.id)
			dropOperation(this.inventory, scan.id)
			addOperation(this.inventory, scan)
			if (scan.residue.length) this.residuePending = true
			// An explicit delete removed it: no longer quarantined.
			if (!scan.unknown && !scan.intent) this.quarantine.delete(scan.id)
		}
		if (this.inventory.intents.size > MAX_RECOVERY_OPERATIONS)
			this.inventory.unknown = true
	}
	/**
	 * Brings `ids` up to date after this process changed their files (call under the lock): a
	 * scan of those ids only, or the full scan while the inventory is unknown.
	 */
	private async refresh(ids: Iterable<string>): Promise<void> {
		const scans = await this.scanIds(ids)
		if (scans === null) await this.scanInventory()
		else this.applyScans(scans)
	}
	/**
	 * Re-reads every operation without holding the lock (AUDIT_CONCURRENCY at once), so changes
	 * made from outside this process (hand edits, tampering) reach the inventory and an
	 * unexpected one makes it unknown, fail closed, as the full scan would. Each id's result is
	 * applied under the lock only when nothing of this process touched that id since the audit
	 * began (an active operation, a refresh, a full scan). Crash residue, or an unknown
	 * inventory, runs the full scan under the lock instead (it sets residue aside, and only it
	 * may clear an unknown inventory). One audit at a time; the retention pass runs it.
	 */
	async audit(): Promise<void> {
		if (this.auditTouched || this.stopped || !this.initialized) return
		if (this.inventory.unknown || this.residuePending) {
			if (this.context.adapter.authorityHealthy())
				await this.exclusive(() => this.scanInventory())
			return
		}
		const epoch = this.scanEpoch
		const touched = new Set<string>()
		this.auditTouched = touched
		try {
			let listing: OperationListing | null
			try {
				listing = await this.listOperations()
			} catch {
				listing = null
			}
			const ids = new Map(listing?.ids ?? [])
			// Known ids the listing did not show are gone (or a doubtful listing: scanned anyway).
			for (const id of [
				...this.inventory.opBytes.keys(),
				...this.inventory.intents.keys(),
			])
				if (!ids.has(id))
					ids.set(id, { cleanup: false, staging: false, folder: false })
			const scans = await mapLimited([...ids], AUDIT_CONCURRENCY, ([id, has]) =>
				this.scanOperation(id, has),
			)
			await this.exclusive(async () => {
				// A full scan replaced the inventory meanwhile: it is newer than this audit.
				if (this.scanEpoch !== epoch) return
				if (listing === null || listing.invalid || this.unconfirmedReads.size) {
					this.inventory.unknown = true
					return
				}
				const fresh = scans.filter(
					scan => !this.active.has(scan.id) && !touched.has(scan.id),
				)
				if (fresh.some(scan => scan.residue.length)) {
					await this.scanInventory()
					return
				}
				this.applyScans(fresh)
				this.pruneSearches(listing.ids)
			})
		} finally {
			this.auditTouched = null
		}
	}

	recover(): Promise<AnalogReconciliation[]> {
		if (this.stopped && this.active.size === 0) {
			this.stopped = false
			this.recovery = null
		}
		this.recovery ??= this.exclusive(async () => {
			this.available.clear()
			this.quarantine.clear()
			if (!this.context.adapter.authorityHealthy()) {
				this.initialized = false
				return [
					{
						operationId: "",
						discoveryId: null,
						status: "quarantined" as const,
						errorCode: "recovery-incomplete" as const,
						residueBytes: null,
					},
				]
			}
			await this.scanInventory()
			const results: AnalogReconciliation[] = []
			if (this.inventory.unknown) {
				this.initialized = true
				for (const intent of this.inventory.intents.values())
					this.quarantine.set(intent.operationId, {
						operationId: intent.operationId,
						discoveryId: intent.discoveryId,
						reason: "inventory-unknown",
					})
				return [...this.inventory.intents.values()].map(intent => ({
					operationId: intent.operationId,
					discoveryId: intent.discoveryId,
					status: "quarantined" as const,
					errorCode: "recovery-incomplete" as const,
					residueBytes: this.closureUncertain(intent.operationId)
						? null
						: (this.inventory.opBytes.get(intent.operationId) ?? null),
				}))
			}
			// The ids reconciliation changed on disk (cleanups, receipt.tmp unlinks): only they
			// are read again, not every operation.
			const changed = new Set<string>()
			for (const intent of this.inventory.intents.values()) {
				if (this.active.has(intent.operationId)) continue
				results.push(await this.reconcile(intent, changed))
			}
			await this.refresh(changed)
			this.initialized = true
			return results
		})
		return this.recovery
	}
	/** The last recovery's quarantined operations still on disk, by operation id. */
	quarantined(): AnalogQuarantine[] {
		return [...this.quarantine.values()].sort((a, b) =>
			a.operationId < b.operationId
				? -1
				: a.operationId > b.operationId
					? 1
					: 0,
		)
	}
	/** A same-owner stop/recover is not a process lifetime boundary for retained descriptors. */
	private closureUncertain(operationId: string): boolean {
		return (
			this.unconfirmedReads.size > 0 ||
			this.uncertainResidue.has(operationId) ||
			(this.active.get(operationId)?.descriptors.size ?? 0) > 0
		)
	}
	private requireCleanupClosure(operationId: string): void {
		if (this.closureUncertain(operationId))
			throw coded("cleanup-failed", "Descriptor closure remains unconfirmed")
	}
	private async reconcile(
		intent: Intent,
		changed?: Set<string>,
	): Promise<AnalogReconciliation> {
		const result = (
			status: AnalogReconciliation["status"],
			errorCode: AnalogError | null,
			reason?: AnalogQuarantineReason,
		): AnalogReconciliation => {
			if (status === "quarantined")
				this.quarantine.set(intent.operationId, {
					operationId: intent.operationId,
					discoveryId: intent.discoveryId,
					reason: reason ?? "recovery-error",
				})
			else this.quarantine.delete(intent.operationId)
			return {
				operationId: intent.operationId,
				discoveryId: intent.discoveryId,
				status,
				errorCode,
				residueBytes: this.closureUncertain(intent.operationId)
					? null
					: (this.inventory.opBytes.get(intent.operationId) ?? null),
			}
		}
		if (this.closureUncertain(intent.operationId))
			return result("quarantined", "cleanup-failed", "closure-uncertain")
		if (!this.context.adapter.authorityHealthy())
			return result("quarantined", "recovery-incomplete", "authority-unhealthy")
		if (this.inventory.cleanup.has(intent.operationId)) {
			try {
				changed?.add(intent.operationId)
				await this.context.adapter.inverse(intent.operationId)
				await this.cleanupOwned(intent, true, false)
				return { ...result("cleaned", null), residueBytes: 0 }
			} catch {
				return result("quarantined", "cleanup-failed", "cleanup-failed")
			}
		}
		let marker: AnalogReceipt
		try {
			marker = freeze(
				AnalogReceiptSchema.parse(
					await this.readJson(
						join(this.opDir(intent.operationId), "receipt.json"),
					),
				),
			)
		} catch (cause) {
			if (nativeCode(cause) !== "ENOENT")
				return result(
					"quarantined",
					"recovery-incomplete",
					"receipt-unreadable",
				)
			const association = this.context.adapter.association(
				intent.discoveryId,
				intent.observationId,
				intent.binding,
			)
			// A marked folder (the ownership table was full) keeps every file, and a file anyone
			// lists is theirs: never cleaned here.
			const listers = this.listersOf(intent)
			if (
				association?.aliasIds.includes(intent.alias) ||
				listers === null ||
				listers.length > 0
			)
				return result("quarantined", "recovery-ambiguous", "unfinalized-listed")
			try {
				changed?.add(intent.operationId)
				await this.context.adapter.inverse(intent.operationId)
				if (!this.context.adapter.authorityHealthy())
					return result(
						"quarantined",
						"recovery-incomplete",
						"authority-unhealthy",
					)
				await this.cleanupOwned(intent, true, true)
				return { ...result("cleaned", null), residueBytes: 0 }
			} catch (cause) {
				if (cause instanceof ScannerApiError) this.context.keptSkipped?.(1)
				return result("quarantined", "cleanup-failed", "cleanup-failed")
			}
		}
		try {
			if (marker.outcome !== "finalized")
				return result("quarantined", "recovery-incomplete", "not-finalized")
			if (!this.matches(intent, marker))
				return result("quarantined", "recovery-incomplete", "receipt-mismatch")
			if (!(await this.mediaValid(intent, marker)))
				return result("quarantined", "recovery-incomplete", "media-invalid")
			const prepared = this.context.adapter.buildCommitPlan(
				intent.operationId,
			)?.metadata
			if (
				prepared &&
				(prepared.expectedOutput.fileBytes !== marker.output.fileBytes ||
					prepared.expectedOutput.outputFrames !== marker.output.outputFrames ||
					prepared.alias !== intent.alias ||
					prepared.artifact !== intent.artifact ||
					JSON.stringify(prepared.binding) !== JSON.stringify(intent.binding))
			)
				return result("quarantined", "recovery-incomplete", "prepared-mismatch")
			// A finalized, matching file: its observation is not required, a live owner is
			// (finalizedAssociation). An earlier start's quarantine wrote nothing, so the same rule
			// re-admits it here with every file left as it is.
			const association = this.finalizedAssociation(intent)
			if (!association?.aliasIds.includes(intent.alias))
				return result("quarantined", "recovery-ambiguous", "owner-unresolved")
			if (!this.admitsFile(intent, association))
				return result("quarantined", "recovery-ambiguous", "owner-not-admitted")
			// Deliberately no public state/count changes: later authoritative mutations survive replay.
			this.available.set(intent.alias, {
				intent,
				receipt: marker,
				available: true,
			})
			try {
				await this.io.unlink(
					join(this.opDir(intent.operationId), "receipt.tmp"),
				)
				changed?.add(intent.operationId)
			} catch (cause) {
				if (nativeCode(cause) !== "ENOENT") {
					changed?.add(intent.operationId)
					return result("available", "cleanup-failed")
				}
			}
			return result("available", null)
		} catch {
			return result("quarantined", "recovery-incomplete", "recovery-error")
		}
	}

	/** Cancellation and settlement drain are outside the publication queue. */
	cancelDiscovery(id: string): Promise<AnalogReceipt[]> {
		const operations = [...this.active.values()].filter(
			op => op.intent.discoveryId === id,
		)
		for (const op of operations) {
			// A deleted discovery's audio is deleted, never quarantined (even a noise cancel's).
			op.noise = null
			if (op.decision) continue
			op.cancelled ??= "discovery-deleted"
			op.accepting = false
			op.writer?.cancel()
			void this.finishOperation(op, "discovery-deleted")
		}
		return Promise.all(operations.map(op => op.settled))
	}
	stop(): Promise<void> {
		this.stopped = true
		const operations = [...this.active.values()]
		for (const op of operations) {
			op.noise = null
			if (op.decision) continue
			op.cancelled ??= "shutdown"
			op.accepting = false
			op.writer?.cancel()
			void this.finishOperation(op, "shutdown")
		}
		return Promise.all(operations.map(op => op.settled)).then(() => undefined)
	}
	async hasCleanup(id: string): Promise<boolean> {
		return this.exclusive(async () => {
			if (!this.context.adapter.authorityHealthy())
				throw coded("recovery-incomplete", "Unknown metadata authority")
			await this.refresh(this.operationsOf(id))
			if (this.inventory.unknown)
				throw coded("recovery-incomplete", "Unknown operation inventory")
			return (
				this.protectedDiscovery(id) ||
				[...this.uncertainResidue.values()].some(
					item => item.discoveryId === id,
				) ||
				[...this.inventory.intents.values()].some(
					intent =>
						intent.discoveryId === id &&
						this.heldElsewhere(intent, [id]) === undefined,
				)
			)
		})
	}
	/** Inventoried operation ids of `discoveryId`'s folder. */
	private operationsOf(discoveryId: string): string[] {
		const ids: string[] = []
		for (const [id, intent] of this.inventory.intents)
			if (intent.discoveryId === discoveryId) ids.push(id)
		return ids
	}
	/**
	 * A live discovery other than the folder's own and outside `removing` that lists this
	 * intent's committed file (any of them; undefined when none): after a co-channel split the
	 * file stays in the folder it was written to, and the twin whose observation lists it holds
	 * it (DiscoveryStore.recordingAssociation); several may list one file. No deleter of that
	 * folder may reach it. Null (fail closed) whenever the listers are unknown (`listersOf`).
	 */
	private heldElsewhere(
		intent: Intent,
		removing: readonly string[],
	): string | null | undefined {
		const listers = this.listersOf(intent)
		if (listers === null) return null
		return listers.find(
			id => id !== intent.discoveryId && !removing.includes(id),
		)
	}
	/**
	 * Every live discovery listing this intent's committed file: the ownership table's listers
	 * and the owner of the intent's association when it lists the alias (the folder's own
	 * discovery when its observation still holds it). Null (fail closed) when the folder is
	 * marked (checked first: a live discovery may list the file unrecorded), the table's answer
	 * is unknown (its lookup answers null) or a lookup throws. Only an absent lookup means "no
	 * table". An admitted file whose observation left the window adds its retained owner only
	 * when the table records no lister (the folder's owner is the fallback, never an extra one).
	 */
	private listersOf(intent: Intent): string[] | null {
		if (this.heldUnknown(intent.discoveryId)) return null
		try {
			const name = intent.artifact.split("/").at(-1)
			const lookup = this.context.listers
			const table =
				name === undefined || lookup === undefined
					? []
					: lookup(intent.discoveryId, name)
			if (table === null) return null
			const out = new Set(table)
			// An admitted (finalized) file whose observation left the window follows its owner,
			// when no lister is recorded; otherwise the table's listers are its owners.
			const association =
				out.size === 0 && this.available.get(intent.alias)?.available
					? this.finalizedAssociation(intent)
					: this.context.adapter.association(
							intent.discoveryId,
							intent.observationId,
							intent.binding,
						)
			if (association?.aliasIds.includes(intent.alias))
				out.add(association.ownerId ?? intent.discoveryId)
			return [...out]
		} catch {
			return null
		}
	}
	/**
	 * A finalized file's association (a receipt that matches its intent and media): the strict
	 * one while its observation lists it, else, once that observation left the window, a live
	 * discovery the ownership table names, or, when none is recorded, the live discovery its
	 * folder resolves to (itself or a merge survivor) (adapter.retainedOwner). Null or the strict answer otherwise: no live owner, no admission.
	 * Callers use it only for a receipt-proven commit; an unfinalized intent keeps the strict one.
	 */
	private finalizedAssociation(intent: Intent): RecordingAssociation | null {
		const association = this.context.adapter.association(
			intent.discoveryId,
			intent.observationId,
			intent.binding,
		)
		if (association?.aliasIds.includes(intent.alias)) return association
		let ownerId: string | undefined
		try {
			ownerId = this.context.adapter.retainedOwner?.(
				intent.discoveryId,
				intent.observationId,
				intent.alias,
			)
		} catch {
			ownerId = undefined
		}
		if (ownerId === undefined) return association
		return { aliasIds: [intent.alias], ownerId, held: true }
	}
	/** Fail closed: a throwing lookup answers "unknown owner". */
	private heldUnknown(folderId: string): boolean {
		try {
			return this.context.heldUnknown?.(folderId) ?? false
		} catch {
			return true
		}
	}
	/** The intent's file is admitted through its folder, or through the live discovery owning it. */
	private admitsFile(
		intent: Intent,
		association: RecordingAssociation,
	): boolean {
		if (this.context.admits(intent.discoveryId)) return true
		const owner = association.ownerId
		return owner !== undefined && this.context.admits(owner)
	}
	/**
	 * File names in `folderId`'s analog folder that another live discovery owns (heldElsewhere):
	 * the folder removal of `removing` must leave them, and the folder, in place.
	 */
	heldArtifactNames(
		folderId: string,
		removing: readonly string[],
	): ReadonlySet<string> {
		const names = new Set<string>()
		for (const intent of this.inventory.intents.values())
			if (
				intent.discoveryId === folderId &&
				this.heldElsewhere(intent, removing) !== undefined
			)
				names.add(intent.artifact.split("/").at(-1) ?? "")
		names.delete("")
		return names
	}
	/**
	 * One file's answer for a folder removal of `removing`, asked in the same turn as its unlink:
	 * true when an inventoried artifact named `name` in `folderId`'s analog folder is owned by
	 * another live discovery or its folder is marked (heldElsewhere not undefined).
	 */
	heldArtifact(
		folderId: string,
		name: string,
		removing: readonly string[],
	): boolean {
		for (const intent of this.inventory.intents.values())
			if (
				intent.discoveryId === folderId &&
				intent.artifact.split("/").at(-1) === name &&
				this.heldElsewhere(intent, removing) !== undefined
			)
				return true
		return false
	}
	async deleteDiscovery(
		id: string,
		removing: readonly string[] = [id],
	): Promise<void> {
		await this.cancelDiscovery(id)
		await this.exclusive(async () => {
			if (!this.context.adapter.authorityHealthy())
				throw coded("cleanup-failed", "Unknown metadata authority")
			await this.refresh(this.operationsOf(id))
			if (this.inventory.unknown)
				throw coded("cleanup-failed", "Unknown operation inventory")
			if (
				[...this.uncertainResidue.values()].some(
					item => item.discoveryId === id,
				)
			)
				throw coded("cleanup-failed", "Writer closure remains unverifiable")
			// A file another live discovery owns (a split twin) is not this removal's to delete.
			const owned = [...this.inventory.intents.values()].filter(
				intent =>
					intent.discoveryId === id &&
					this.heldElsewhere(intent, removing) === undefined,
			)
			// WG9 R2: refuse before the first mutation when any owned artifact is kept now.
			if (owned.some(intent => this.keptArtifact(intent))) throw keptRefusal()
			try {
				for (const intent of owned) {
					this.auditTouched?.add(intent.operationId)
					// WG9 R2: a Keep committed during an earlier intent's awaits refuses here, in the same
					// exclusive section, before the alias, the marker or the metadata is touched.
					if (this.keptArtifact(intent)) throw keptRefusal()
					// Owned when the removal began; asked again before each step and in the media
					// unlink's own turn: a split or a mark since leaves the file to its new owner.
					const stillOwned = (): boolean =>
						this.heldElsewhere(intent, removing) === undefined
					if (!stillOwned()) continue
					const slot = this.available.get(intent.alias)
					this.available.delete(intent.alias)
					// Explicit DELETE may remove quarantined media only under strict matching ownership.
					await this.validateCleanupMarker(intent)
					if (!stillOwned()) {
						if (slot) this.available.set(intent.alias, slot)
						continue
					}
					await this.context.adapter.inverse(intent.operationId)
					try {
						await this.cleanupOwned(intent, true, true, stillOwned)
					} catch (cause) {
						// Held elsewhere since: the file and its operation stay whole (its new owner's).
						if (!(cause instanceof ScannerApiError) || stillOwned()) throw cause
						if (slot) this.available.set(intent.alias, slot)
					}
				}
			} finally {
				// What is on disk now, whether every cleanup ended or one stopped part-way.
				await this.refresh(owned.map(intent => intent.operationId))
			}
			if (
				this.inventory.unknown ||
				[...this.uncertainResidue.values()].some(
					item => item.discoveryId === id,
				) ||
				[...this.inventory.intents.values()].some(
					intent =>
						intent.discoveryId === id &&
						this.heldElsewhere(intent, removing) === undefined,
				)
			)
				throw coded("cleanup-failed", "Owned recording cleanup pending")
		})
	}
	private async validateCleanupMarker(intent: Intent): Promise<void> {
		try {
			const marker = AnalogReceiptSchema.parse(
				await this.readJson(
					join(this.opDir(intent.operationId), "receipt.json"),
				),
			)
			if (!this.matches(intent, marker))
				throw coded(
					"recovery-ambiguous",
					"Foreign final marker cannot authorize deletion",
				)
		} catch (cause) {
			if (nativeCode(cause) !== "ENOENT") throw cause
		}
	}
	/**
	 * Removes an operation's files. Every caller reaches the committed file only here, so the
	 * folder mark is checked here itself, whoever calls: a marked folder (the ownership table was
	 * full, some live discovery may list the file) refuses before anything is removed, and again
	 * in the same turn as the media unlink. So is `stillOwned` (by default: no other live
	 * discovery owns the file, heldElsewhere): a split since the caller decided refuses too. The
	 * operation stays whole and inventoried, so recovery quarantines it (recovery-ambiguous) and
	 * retention keeps it.
	 */
	private async cleanupOwned(
		intent: Intent,
		ownedIntent: boolean,
		ownedMedia: boolean,
		stillOwned: () => boolean = () =>
			this.heldElsewhere(intent, [intent.discoveryId]) === undefined,
	): Promise<void> {
		// Fail closed: a throwing ownership answer keeps the media.
		const ownedNow = (): boolean => {
			try {
				return stillOwned()
			} catch {
				return false
			}
		}
		this.requireCleanupClosure(intent.operationId)
		if (ownedMedia && (this.heldUnknown(intent.discoveryId) || !ownedNow()))
			throw heldRefusal()
		if (ownedIntent) await this.validateCleanupMarker(intent)
		const remove = async (path: string): Promise<void> => {
			this.requireCleanupClosure(intent.operationId)
			if (!this.context.adapter.authorityHealthy())
				throw coded(
					"cleanup-failed",
					"Metadata authority changed during cleanup",
				)
			try {
				await this.safeTarget(path)
				this.requireCleanupClosure(intent.operationId)
				// WG9 req 2.5: the deletion decision runs in the same turn as the media unlink.
				if (path === final && this.keptArtifact(intent)) throw keptRefusal()
				if (
					path === final &&
					(this.heldUnknown(intent.discoveryId) || !ownedNow())
				)
					throw heldRefusal()
				await this.io.unlink(path)
			} catch (cause) {
				if (nativeCode(cause) !== "ENOENT") throw cause
			}
			await this.checkpoint("cleanup-removed", intent.operationId)
		}
		const final = this.finalPath(intent)
		// Transfer strict cleanup authority before removing the directory's last file.
		if (ownedMedia) await remove(final)
		const dir = this.opDir(intent.operationId)
		for (const name of [
			"payload.wav.part",
			"receipt.tmp",
			"receipt.json",
			"intent.tmp",
		]) {
			try {
				await remove(join(dir, name))
			} catch (cause) {
				if (nativeCode(cause) !== "ENOENT") throw cause
			}
		}
		if (ownedIntent) {
			const transferred = this.cleanupPath(intent.operationId)
			await this.safeTarget(transferred)
			this.requireCleanupClosure(intent.operationId)
			try {
				await link(join(dir, "intent.json"), transferred)
			} catch (cause) {
				if (nativeCode(cause) !== "EEXIST" && nativeCode(cause) !== "ENOENT")
					throw cause
				const prior = IntentSchema.parse(await this.readJson(transferred))
				if (JSON.stringify(prior) !== JSON.stringify(intent))
					throw coded("cleanup-failed", "Foreign cleanup ownership")
			}
			await this.checkpoint("cleanup-transferred", intent.operationId)
			await remove(join(dir, "intent.json"))
		}
		this.requireCleanupClosure(intent.operationId)
		try {
			await (this.io.rmdir?.(dir) ?? rmdir(dir))
		} catch (cause) {
			if (nativeCode(cause) !== "ENOENT") throw cause
		}
		await this.checkpoint("cleanup-rmdir", intent.operationId)
		if (ownedIntent) await remove(this.cleanupPath(intent.operationId))
	}
	path(alias: string): string | null {
		if (!this.ready) return null
		const item = this.available.get(alias)
		if (!item?.available) return null
		const association = this.finalizedAssociation(item.intent)
		if (
			!association?.aliasIds.includes(alias) ||
			!this.admitsFile(item.intent, association)
		)
			return null
		try {
			this.safeTargetSync(this.finalPath(item.intent))
			const info = lstatSync(this.finalPath(item.intent))
			return info.isFile() && info.size === item.receipt.output.fileBytes
				? this.finalPath(item.intent)
				: null
		} catch {
			return null
		}
	}
	ownsArtifact(relativePath: string): boolean {
		if (this.inventory.artifacts.has(relativePath)) return true
		for (const op of this.active.values())
			if (op.intent.artifact === relativePath) return true
		return false
	}
	/** Fail closed: a throwing port answers protected. */
	private keptArtifact(intent: Intent): boolean {
		const port = this.context.protection
		if (!port) return false
		try {
			return (
				port.isScannerFileProtected(
					intent.discoveryId,
					intent.artifact.split("/").at(-1) ?? "",
				) !== false
			)
		} catch {
			return true
		}
	}
	/**
	 * Age expiry and the quota for the analog files, and, with `legacy`, the quota for the other
	 * recordings in the same pass: every removable file of both pools, oldest first, goes while
	 * the store is full (quotaShortfall over the pool's live `legacy.bytes` > 0); an analog file
	 * also goes once it is past `maxAgeMs`, or while the operation inventory is full
	 * (operationsFull) and the candidates left can clear it (at most the excess; none when the
	 * held operations alone fill it, operationsHeldFull). The pass stops removing as soon as neither holds, so a shortfall left after it
	 * means no candidate in either pool was left. Not ready: the legacy pool alone, to the cap.
	 */
	async retained(
		keep: ReadonlySet<string>,
		maxAgeMs: number,
		now: number,
		legacy?: LegacyRetention,
	): Promise<string[]> {
		this.lastPass = null
		this.operationsHeldFull = false
		if (!this.ready) {
			if (legacy) {
				const capBytes = this.context.limits().maxBytes
				for (const file of legacy.files) {
					if (legacy.bytes <= capBytes) break
					if (await file.remove()) legacy.bytes -= file.bytes
				}
			}
			return []
		}
		const deleted: string[] = []
		let skipped = 0
		let unresolved = 0
		let unknownHeld = 0
		let quarantined = 0
		// Evictable files with their media mtime (one lstat each; at most the inventory,
		// MAX_RECOVERY_OPERATIONS), oldest first: age expiry and the quota both retire the oldest.
		// A file whose media cannot be read sorts last (its age is unknown, never aged).
		const candidates: { intent: Intent; mtimeMs: number }[] = []
		for (const intent of [...this.inventory.intents.values()]) {
			const hold = this.retentionHold(intent, keep)
			// Quarantined at recovery (whatever the reason): kept, counted, until a start admits it.
			if (hold === "quarantined") {
				quarantined++
				continue
			}
			// An unknown lister (the ownership table was full): kept, never unkept.
			if (hold === "unknown") {
				unknownHeld++
				continue
			}
			// A folder no live discovery owns: kept, never unkept.
			if (hold === "unresolved") {
				unresolved++
				continue
			}
			if (hold) continue
			let mtimeMs = Number.POSITIVE_INFINITY
			try {
				mtimeMs = (await lstat(this.finalPath(intent))).mtimeMs
			} catch {
				/* quarantine is retained until explicit deletion */
			}
			candidates.push({ intent, mtimeMs })
		}
		// Both pools in one order: oldest first by file time, then by operation id or path.
		const entries: RetentionEntry[] = candidates.map(c => ({
			kind: "analog",
			intent: c.intent,
			mtimeMs: c.mtimeMs,
			key: c.intent.operationId,
		}))
		for (const file of legacy?.files ?? [])
			entries.push({
				kind: "legacy",
				file,
				mtimeMs: file.mtimeMs,
				key: file.key,
			})
		entries.sort(
			(a, b) =>
				a.mtimeMs - b.mtimeMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
		)
		// Full: no room for one admission plus one in flight (ADMISSION_HEADROOM), re-checked
		// after every removal so the pass stops as soon as the next recording fits.
		const bytesFull = async (): Promise<boolean> =>
			(this.quotaShortfall(
				legacy ? legacy.bytes : await this.context.legacyBytes(),
			) ?? 0) > 0
		// Count eviction: while the inventory is full (intents + unpublished ≥ 4096 − 8 = 4088),
		// only when the analog candidates not yet tried can bring it under that limit, i.e.
		// intents + unpublished − analogLeft < 4088. Each retire drops one intent, so the pass
		// evicts for count exactly the excess intents + unpublished − 4087 (oldest first) and
		// stops; with the held operations alone at or past 4088 it evicts nothing for count.
		let analogLeft = candidates.length
		const countLimit = MAX_RECOVERY_OPERATIONS - OPERATION_HEADROOM
		const heldAtStart =
			this.inventory.intents.size + this.unpublished() - analogLeft
		this.operationsHeldFull = this.operationsFull() && heldAtStart >= countLimit
		const countEvicts = (): boolean =>
			this.operationsFull() &&
			this.inventory.intents.size + this.unpublished() - analogLeft < countLimit
		const tried = new Set<string>()
		let legacyUntried = 0
		for (const entry of entries) {
			if (entry.kind === "legacy") {
				// Legacy age expiry ran in the caller's own pass; here only the quota removes.
				if (!(await bytesFull())) {
					legacyUntried++
					continue
				}
				if ((await entry.file.remove()) && legacy)
					legacy.bytes -= entry.file.bytes
				continue
			}
			const { intent, mtimeMs } = entry
			const old = now - mtimeMs > maxAgeMs
			const evict = old || countEvicts() || (await bytesFull())
			analogLeft--
			if (!evict) continue
			// The whole policy again before the retire and in the media unlink's own turn: a
			// listing, a mark, a keep or an unresolved folder since keeps the file.
			const stillRetirable = (): boolean =>
				this.retentionHold(intent, keep) === false
			tried.add(intent.operationId)
			if (!stillRetirable()) continue
			try {
				await this.retire(intent, deleted, stillRetirable)
			} catch (cause) {
				if (!(cause instanceof ScannerApiError)) throw cause
				skipped++
			}
		}
		if (skipped > 0) this.context.keptSkipped?.(skipped)
		this.unresolvedRetained = unresolved
		this.unknownHeldRetained = unknownHeld
		this.quarantinedRetained = quarantined
		this.lastPass = { keep, tried, legacyUntried }
		return deleted
	}
	/**
	 * Files the last retention pass left that it could still remove, counted NOW: the analog
	 * operations in the inventory it did not try to retire whose policy lets them go (one
	 * finalized during the pass included), plus the legacy files it did not try. An admission or
	 * a finalization after the pass's last removal decision can leave the store short again with
	 * these left, so a shortfall then is not "nothing removable" (0: genuinely held, or no pass).
	 */
	removableNow(): number {
		const pass = this.lastPass
		if (pass === null || !this.ready) return 0
		let n = pass.legacyUntried
		for (const intent of this.inventory.intents.values())
			if (
				!pass.tried.has(intent.operationId) &&
				this.retentionHold(intent, pass.keep) === false
			)
				n++
		return n
	}
	/**
	 * Retention's policy for one artifact, synchronous so it can run in the media unlink's turn:
	 * `unknown` (its listers are unknown) and `unresolved` (no live discovery owns its folder)
	 * keep it, counted; true keeps it; false lets age or the quota remove it. A file the ownership
	 * table or its association records listers for follows them (the folder's own discovery only
	 * when it is one of them): kept while any lister is kept. Any other follows its folder's
	 * owner (`keep` holds alias folders of a kept survivor too). `quarantined` (right after
	 * `unknown`, which counts a marked folder's file first): recovery did not admit it, for any reason (no live owner, a failed check): kept, counted,
	 * never aged or quota-removed, pending re-admission at a later start (fail closed).
	 */
	private retentionHold(
		intent: Intent,
		keep: ReadonlySet<string>,
	): "quarantined" | "unknown" | "unresolved" | boolean {
		const listers = this.listersOf(intent)
		if (listers === null) return "unknown"
		if (this.quarantine.has(intent.operationId)) return "quarantined"
		if (!this.context.admits(intent.discoveryId)) return "unresolved"
		if (
			this.closureUncertain(intent.operationId) ||
			this.protectedDiscovery(intent.discoveryId) ||
			this.keptArtifact(intent)
		)
			return true
		if (listers.length === 0) return keep.has(intent.discoveryId)
		return listers.some(id => keep.has(id) || !this.context.admits(id))
	}
	private async retire(
		intent: Intent,
		deleted: string[],
		stillRetirable: () => boolean,
	): Promise<void> {
		await this.context.serialise(intent.discoveryId, async () => {
			if (
				this.protectedDiscovery(intent.discoveryId) ||
				this.closureUncertain(intent.operationId) ||
				this.keptArtifact(intent) ||
				this.heldUnknown(intent.discoveryId)
			)
				return
			await this.exclusive(async () => {
				// Another pass retired it meanwhile (its list was taken before): nothing left to do.
				if (!this.inventory.intents.has(intent.operationId)) return
				// A folder marked meanwhile keeps the file (its owner is unknown).
				if (
					this.closureUncertain(intent.operationId) ||
					this.keptArtifact(intent) ||
					this.heldUnknown(intent.discoveryId)
				)
					return
				await this.validateCleanupMarker(intent)
				if (!stillRetirable()) return
				this.auditTouched?.add(intent.operationId)
				try {
					await this.context.adapter.inverse(intent.operationId)
					await this.cleanupOwned(intent, true, true, stillRetirable)
					this.available.delete(intent.alias)
					deleted.push(intent.artifact)
				} finally {
					// What is on disk now, whether the cleanup ended or stopped part-way.
					await this.refresh([intent.operationId])
				}
			})
		})
	}
}

/** Sentinel: the media unlink met a kept artifact; the file is left in place. */
function keptRefusal(): ScannerApiError {
	return new ScannerApiError(
		"Discovery holds kept recordings",
		SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
		409,
	)
}

/**
 * Sentinel: the media unlink met a marked folder (a live discovery may list the file, its owner
 * is unknown); the file is left in place. A refusal like a kept artifact's, counted the same way.
 */
function heldRefusal(): ScannerApiError {
	return new ScannerApiError(
		"Recording folder ownership is unknown",
		SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
		409,
	)
}
