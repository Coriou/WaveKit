/** Scanner-owned prepared-link media lifecycle. No native/channel consumer is adopted here. */
import { randomUUID } from "node:crypto"
import { constants, linkSync, lstatSync, type Stats } from "node:fs"
import {
	link,
	lstat,
	mkdir,
	open,
	opendir,
	realpath,
	rmdir,
	unlink,
} from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { z } from "zod"
import { WaveKitError } from "../../../utils/errors.js"
import {
	WavFileWriter,
	wavHeader,
	type WavWriteReceipt,
} from "../channel/wav-writer.js"
import type { RecordingCommitPlan } from "./discovery-store.js"
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
const ErrorSchema = z.enum([
	"admission-denied",
	"disk-unavailable",
	"disk-low",
	"storage-cap",
	"write-failed",
	"close-failed",
	"header-invalid",
	"rename-failed",
	"metadata-failed",
	"cleanup-failed",
	"recovery-incomplete",
	"invalid-binding",
	"recovery-ambiguous",
])
export type AnalogError = z.infer<typeof ErrorSchema>
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
		closure: z.enum(["closed", "incomplete", "unknown"]),
		outcome: z.enum(["finalized", "aborted", "failed"]),
		artifact: z.string().max(512).nullable(),
		cleanup: z.enum(["complete", "pending"]),
		residueBytes: count.nullable(),
		errorCode: ErrorSchema.nullable(),
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
					r.output.fileBytes !== 44 + 2 * (r.output.outputFrames ?? -1) ||
					r.closure !== "closed" ||
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
	): { aliasIds: readonly string[] } | null
	prepare(metadata: PreparedRecordingMetadata): Promise<void>
	inverse(operationId: string): Promise<void>
	buildCommitPlan(operationId: string): RecordingCommitPlan | null
	/** Must delegate to the known plain DiscoveryStore identity checker, without callbacks. */
	commitPlanCurrent(plan: RecordingCommitPlan): boolean
	publishCommit(plan: RecordingCommitPlan): void
}
export interface AnalogHandle {
	readonly operationId: string
	readonly ready: Promise<void>
	readonly settled: Promise<AnalogReceipt>
	push(pcm: Int16Array): Promise<void>
	addGap(gap: AnalogGap): void
	finish(cut?: AnalogCut): Promise<AnalogReceipt>
	cancel(cut?: AnalogCut): void
}
export interface AnalogReconciliation {
	operationId: string
	discoveryId: string | null
	status: "available" | "cleaned" | "quarantined"
	errorCode: AnalogError | null
	residueBytes: number | null
}
export interface AnalogOperationIo {
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
}
interface Inventory {
	bytes: number
	metadataBytes: number
	unknown: boolean
	intents: Map<string, Intent>
	opBytes: Map<string, number>
}
interface Operation {
	intent: Intent
	writer: WavFileWriter | null
	cancelled: AnalogCut | null
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
	ownedMedia: boolean
	foreignMarker: boolean
	reservation: boolean
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
	private readonly io: AnalogOperationIo
	private lock: Promise<void> = Promise.resolve()
	private inventory: Inventory = {
		bytes: 0,
		metadataBytes: 0,
		unknown: true,
		intents: new Map(),
		opBytes: new Map(),
	}
	private readonly uncertainResidue = new Map<
		string,
		{ discoveryId: string; bytes: number }
	>()
	private stopped = false
	private initialized = false
	private recovery: Promise<AnalogReconciliation[]> | null = null
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
			ownedDirectory: false,
			ownedMedia: false,
			foreignMarker: false,
			reservation: false,
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
			finish: (cut = "completed") =>
				this.finishOperation(op, AnalogCutSchema.parse(cut)),
			cancel: (cut = "cancelled") => {
				if (op.decision) return
				op.cancelled ??= AnalogCutSchema.parse(cut)
				op.accepting = false
				op.writer?.cancel()
				void this.finishOperation(op, op.cancelled)
			},
		}
	}
	private valid(op: Operation): void {
		if (op.cancelled)
			throw coded("admission-denied", "Analog operation cancelled")
		if (
			!this.context.adapter.authorityHealthy() ||
			!this.context.admits(op.intent.discoveryId) ||
			!this.context.adapter.association(
				op.intent.discoveryId,
				op.intent.observationId,
				op.intent.binding,
			)
		)
			throw coded("admission-denied", "Analog association is unavailable")
		const b = op.intent.binding
		if (
			b.inputFormat !== "cf32" ||
			b.inputSampleRateHz !== 48000 ||
			b.sourceId === null ||
			b.engineInstanceId === null ||
			b.stream === null ||
			b.epoch === null ||
			b.channelId === null ||
			b.channelGeneration === null ||
			!this.context.adapter.bindingLive(b)
		)
			throw coded("invalid-binding", "Actual live 48 kHz cf32 binding required")
		if (op.cancelled || !this.context.admits(op.intent.discoveryId))
			throw coded(
				"admission-denied",
				"Analog operation cancelled during validation",
			)
	}
	private async admit(op: Operation): Promise<void> {
		await this.exclusive(async () => {
			if (!this.ready)
				throw coded(
					"recovery-incomplete",
					"Analog inventory/authority unavailable",
				)
			this.valid(op)
			await this.checkpoint("reserve", op.intent.operationId)
			this.valid(op)
			await this.safeDirectory(dirname(this.finalPath(op.intent)), true, op)
			this.valid(op)
			await this.scanInventory()
			if (this.inventory.unknown)
				throw coded("recovery-incomplete", "Unknown recording inventory")
			if (this.inventory.intents.size >= MAX_RECOVERY_OPERATIONS)
				throw coded("storage-cap", "Operation inventory limit")
			let free: number
			try {
				free = await this.context.freeBytes()
			} catch (cause) {
				throw coded("disk-unavailable", "Free disk unavailable", cause)
			}
			if (!Number.isFinite(free) || free < 0)
				throw coded("disk-unavailable", "Invalid free disk measurement")
			this.valid(op)
			const outstanding = this.reservedUnused() + this.uncertainUnused()
			if (free - outstanding - RESERVATION < this.context.limits().minFreeBytes)
				throw coded("disk-low", "Insufficient reserved free disk")
			if (
				this.inventory.bytes +
					(await this.context.legacyBytes()) +
					outstanding +
					RESERVATION >
				this.context.limits().maxBytes
			)
				throw coded("storage-cap", "Recording storage cap")
			this.valid(op)
			op.reservation = true
			await this.safeDirectory(
				dirname(this.opDir(op.intent.operationId)),
				true,
				op,
			)
			await mkdir(this.opDir(op.intent.operationId))
			op.ownedDirectory = true
			await this.safeDirectory(this.opDir(op.intent.operationId), false, op)
			this.valid(op)
			await this.publishIntent(op)
			this.valid(op)
			await this.checkpoint("intent", op.intent.operationId)
			this.valid(op)
			op.writer = await WavFileWriter.open(this.stagePath(op.intent))
			this.valid(op)
			await this.checkpoint("stage", op.intent.operationId)
			this.valid(op)
		})
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
	private async publishIntent(op: Operation): Promise<void> {
		const dir = this.opDir(op.intent.operationId)
		const temp = join(dir, "intent.tmp")
		await this.writeSynced(temp, boundedJson(op.intent), op)
		this.valid(op)
		await this.safeTarget(join(dir, "intent.json"), op)
		this.valid(op)
		await link(temp, join(dir, "intent.json"))
		op.ownedIntent = true
		this.valid(op)
		await this.io.unlink(temp)
		this.valid(op)
	}
	private async writeSynced(
		path: string,
		body: Buffer,
		op?: Operation,
	): Promise<void> {
		await this.safeTarget(path, op)
		if (op) this.valid(op)
		const handle = await open(path, "wx")
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
				)
					throw coded("admission-denied", "Current commit plan invalidated")
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
								})
								throw coded(
									"cleanup-failed",
									"Writer closure is unverifiable",
									writerCause,
								)
							}
						}
					}
					if (op.foreignMarker)
						throw coded(
							"recovery-ambiguous",
							"Existing marker requires reconciliation",
						)
					if (op.prepared)
						await this.context.adapter.inverse(op.intent.operationId)
					if (op.ownedDirectory)
						await this.cleanupOwned(op.intent, op.ownedIntent, op.ownedMedia)
				} catch {
					cleanup = "pending"
					error = op.foreignMarker ? "recovery-ambiguous" : "cleanup-failed"
				}
				await this.exclusive(async () => {
					try {
						await this.scanInventory()
					} catch {
						this.inventory.unknown = true
					}
					op.reservation = false
				})
				const slot = this.available.get(op.intent.alias)
				if (slot && !slot.available) this.available.delete(op.intent.alias)
				op.decision = this.makeReceipt(
					op,
					op.cancelled && cleanup === "complete" ? "aborted" : "failed",
					op.cancelled ?? cut,
					cleanup,
					this.inventory.unknown
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
			await this.exclusive(async () => {
				try {
					await this.scanInventory()
				} catch {
					this.inventory.unknown = true
				}
				op.reservation = false
			})
		}
		const result = op.decision!
		this.active.delete(op.intent.operationId)
		op.resolve(result)
		return result
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
				closure: op.output ? "closed" : "incomplete",
				outcome,
				artifact: outcome === "finalized" ? op.intent.artifact : null,
				cleanup,
				residueBytes,
				errorCode,
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
	private async readJson(path: string): Promise<unknown> {
		await this.safeTarget(path)
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
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
			await handle.close()
		}
	}
	private async mediaValid(
		intent: Intent,
		receipt: AnalogReceipt,
	): Promise<boolean> {
		await this.safeTarget(this.finalPath(intent))
		const handle = await open(
			this.finalPath(intent),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		)
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
			await handle.close()
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
	private async scanInventory(): Promise<void> {
		const next: Inventory = {
			bytes: 0,
			metadataBytes: 0,
			unknown: false,
			intents: new Map(),
			opBytes: new Map(),
		}
		const inodes = new Set<string>()
		const account = async (
			path: string,
			id: string,
			metadata: boolean,
		): Promise<void> => {
			try {
				const info = await lstat(path)
				if (
					!info.isFile() ||
					info.isSymbolicLink() ||
					!Number.isSafeInteger(info.size) ||
					info.size < 0
				) {
					next.unknown = true
					return
				}
				const inode = `${info.dev}:${info.ino}`
				if (inodes.has(inode)) return
				inodes.add(inode)
				next.bytes += info.size
				if (metadata) next.metadataBytes += info.size
				next.opBytes.set(id, (next.opBytes.get(id) ?? 0) + info.size)
			} catch (cause) {
				if (nativeCode(cause) !== "ENOENT") next.unknown = true
			}
		}
		try {
			await this.anchorRoot()
			await this.safeDirectory(this.root, true)
			const base = join(this.root, ".analog-operations")
			await this.safeDirectory(base, true)
			for (const id of await this.children(base, MAX_RECOVERY_OPERATIONS)) {
				if (!UUIDSchema.safeParse(id).success) {
					next.unknown = true
					continue
				}
				const dir = this.opDir(id)
				try {
					await this.safeDirectory(dir)
				} catch {
					next.unknown = true
					continue
				}
				let metadataBytes = 0
				for (const name of await this.children(dir, 8)) {
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
						next.unknown = true
					const before = next.bytes
					await account(join(dir, name), id, metadata)
					if (metadata) metadataBytes += next.bytes - before
				}
				if (metadataBytes > MAX_OPERATION_METADATA_BYTES) next.unknown = true
				try {
					const intent = IntentSchema.parse(
						await this.readJson(join(dir, "intent.json")),
					)
					if (intent.operationId !== id) {
						next.unknown = true
						continue
					}
					next.intents.set(id, intent)
					await this.safeDirectory(dirname(this.finalPath(intent)))
					await account(this.finalPath(intent), id, false)
				} catch (cause) {
					if (nativeCode(cause) === "ENOENT" && next.intents.has(id)) continue
					// Pre-intent crash residue is quarantined and counted; its media ownership is unknown.
					if (!this.active.has(id)) next.unknown = true
				}
			}
		} catch {
			next.unknown = true
		}
		this.inventory = next
	}

	recover(): Promise<AnalogReconciliation[]> {
		if (this.stopped && this.active.size === 0) {
			this.stopped = false
			this.recovery = null
		}
		this.recovery ??= this.exclusive(async () => {
			this.available.clear()
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
				return [...this.inventory.intents.values()].map(intent => ({
					operationId: intent.operationId,
					discoveryId: intent.discoveryId,
					status: "quarantined" as const,
					errorCode: "recovery-incomplete" as const,
					residueBytes: this.inventory.opBytes.get(intent.operationId) ?? null,
				}))
			}
			for (const intent of this.inventory.intents.values()) {
				if (this.active.has(intent.operationId)) continue
				results.push(await this.reconcile(intent))
			}
			await this.scanInventory()
			this.initialized = true
			return results
		})
		return this.recovery
	}
	private async reconcile(intent: Intent): Promise<AnalogReconciliation> {
		const result = (
			status: AnalogReconciliation["status"],
			errorCode: AnalogError | null,
		): AnalogReconciliation => ({
			operationId: intent.operationId,
			discoveryId: intent.discoveryId,
			status,
			errorCode,
			residueBytes: this.inventory.opBytes.get(intent.operationId) ?? null,
		})
		if (!this.context.adapter.authorityHealthy())
			return result("quarantined", "recovery-incomplete")
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
				return result("quarantined", "recovery-incomplete")
			const association = this.context.adapter.association(
				intent.discoveryId,
				intent.observationId,
				intent.binding,
			)
			if (association?.aliasIds.includes(intent.alias))
				return result("quarantined", "recovery-ambiguous")
			try {
				await this.context.adapter.inverse(intent.operationId)
				if (!this.context.adapter.authorityHealthy())
					return result("quarantined", "recovery-incomplete")
				await this.cleanupOwned(intent, true, true)
				return { ...result("cleaned", null), residueBytes: 0 }
			} catch {
				return result("quarantined", "cleanup-failed")
			}
		}
		try {
			if (
				!this.matches(intent, marker) ||
				!(await this.mediaValid(intent, marker))
			)
				return result("quarantined", "recovery-incomplete")
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
				return result("quarantined", "recovery-incomplete")
			const association = this.context.adapter.association(
				intent.discoveryId,
				intent.observationId,
				intent.binding,
			)
			if (
				!association?.aliasIds.includes(intent.alias) ||
				!this.context.admits(intent.discoveryId)
			)
				return result("quarantined", "recovery-ambiguous")
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
			} catch (cause) {
				if (nativeCode(cause) !== "ENOENT")
					return result("available", "cleanup-failed")
			}
			return result("available", null)
		} catch {
			return result("quarantined", "recovery-incomplete")
		}
	}

	/** Cancellation and settlement drain are outside the publication queue. */
	cancelDiscovery(id: string): Promise<AnalogReceipt[]> {
		const operations = [...this.active.values()].filter(
			op => op.intent.discoveryId === id,
		)
		for (const op of operations) {
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
			await this.scanInventory()
			if (this.inventory.unknown)
				throw coded("recovery-incomplete", "Unknown operation inventory")
			return (
				this.protectedDiscovery(id) ||
				[...this.uncertainResidue.values()].some(
					item => item.discoveryId === id,
				) ||
				[...this.inventory.intents.values()].some(
					intent => intent.discoveryId === id,
				)
			)
		})
	}
	async deleteDiscovery(id: string): Promise<void> {
		await this.cancelDiscovery(id)
		await this.exclusive(async () => {
			if (!this.context.adapter.authorityHealthy())
				throw coded("cleanup-failed", "Unknown metadata authority")
			await this.scanInventory()
			if (this.inventory.unknown)
				throw coded("cleanup-failed", "Unknown operation inventory")
			if (
				[...this.uncertainResidue.values()].some(
					item => item.discoveryId === id,
				)
			)
				throw coded("cleanup-failed", "Writer closure remains unverifiable")
			const owned = [...this.inventory.intents.values()].filter(
				intent => intent.discoveryId === id,
			)
			for (const intent of owned) {
				this.available.delete(intent.alias)
				// Explicit DELETE may remove quarantined media only under strict matching ownership.
				await this.validateCleanupMarker(intent)
				await this.context.adapter.inverse(intent.operationId)
				await this.cleanupOwned(intent, true, true)
			}
			await this.scanInventory()
			if (
				this.inventory.unknown ||
				[...this.uncertainResidue.values()].some(
					item => item.discoveryId === id,
				) ||
				[...this.inventory.intents.values()].some(
					intent => intent.discoveryId === id,
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
	private async cleanupOwned(
		intent: Intent,
		ownedIntent: boolean,
		ownedMedia: boolean,
	): Promise<void> {
		if (ownedIntent) await this.validateCleanupMarker(intent)
		const remove = async (path: string): Promise<void> => {
			if (!this.context.adapter.authorityHealthy())
				throw coded(
					"cleanup-failed",
					"Metadata authority changed during cleanup",
				)
			try {
				await this.safeTarget(path)
				await this.io.unlink(path)
			} catch (cause) {
				if (nativeCode(cause) !== "ENOENT") throw cause
			}
		}
		// Persistent cleanup authority is removed last. Any failure retains the original intent.
		if (ownedMedia) await remove(this.finalPath(intent))
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
		if (ownedIntent) await remove(join(dir, "intent.json"))
		try {
			await rmdir(dir)
		} catch (cause) {
			if (nativeCode(cause) !== "ENOENT") throw cause
		}
	}
	path(alias: string): string | null {
		if (!this.ready) return null
		const item = this.available.get(alias)
		if (
			!item?.available ||
			!this.context.admits(item.intent.discoveryId) ||
			!this.context.adapter
				.association(
					item.intent.discoveryId,
					item.intent.observationId,
					item.intent.binding,
				)
				?.aliasIds.includes(alias)
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
		return (
			[...this.inventory.intents.values()].some(
				intent => intent.artifact === relativePath,
			) ||
			[...this.active.values()].some(op => op.intent.artifact === relativePath)
		)
	}
	async retained(
		keep: ReadonlySet<string>,
		maxAgeMs: number,
		now: number,
	): Promise<string[]> {
		if (!this.ready) return []
		const deleted: string[] = []
		for (const intent of [...this.inventory.intents.values()]) {
			if (
				keep.has(intent.discoveryId) ||
				this.protectedDiscovery(intent.discoveryId)
			)
				continue
			let old = false
			try {
				old = now - (await lstat(this.finalPath(intent))).mtimeMs > maxAgeMs
			} catch {
				/* quarantine is retained until explicit deletion */
			}
			if (
				!old &&
				this.inventory.bytes + (await this.context.legacyBytes()) <=
					this.context.limits().maxBytes
			)
				continue
			await this.context.serialise(intent.discoveryId, async () => {
				if (this.protectedDiscovery(intent.discoveryId)) return
				await this.exclusive(async () => {
					await this.validateCleanupMarker(intent)
					await this.context.adapter.inverse(intent.operationId)
					await this.cleanupOwned(intent, true, true)
					this.available.delete(intent.alias)
					deleted.push(intent.artifact)
					await this.scanInventory()
				})
			})
		}
		return deleted
	}
}
