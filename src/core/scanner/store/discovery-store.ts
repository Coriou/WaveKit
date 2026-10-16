/**
 * Discovery store (spec § 7): turns observations into deduplicated discoveries.
 *
 * Association per observation (§ 7.2): sticky (nearest same-family discovery whose median centre is
 * within the § 5.2 tolerance), then the fixed frequency key with the co-channel rules 2–4. Creation
 * passes the surfacing filter (a)–(d); anything else is a transient. Confidence follows the ladder
 * (§ 7.3): monotone, except a leak/intermod cap recorded before a decode. Every mutation emits one
 * journal entry whose payload holds the resulting records, so replay is an idempotent upsert.
 */
import { EventEmitter } from "node:events"
import { WaveKitError } from "../../../utils/errors.js"
import type { LockoutTarget } from "../plan/lockouts.js"
import {
	frequencyKey,
	gridToleranceHz,
	rasterToleranceHz,
	snapToRaster,
} from "../bandplan/index.js"
import { familyOf } from "../classify/classifier.js"
import { CONFIDENCE_RANK } from "../types.js"
import type {
	Classification,
	ConfidenceCap,
	DecodeEvidence,
	Discovery,
	DiscoveryMetadata,
	Identity,
	Observation,
	ObservationInput,
	ProtocolFamily,
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
	SignalStats,
} from "../types.js"
import type { Raster, TrackSnapshot } from "../../spectrum/types.js"
import { parseStoreMutation } from "./schemas.js"
import type { StoreMutation } from "./schemas.js"
import {
	PreparedRecordingMetadataSchema,
	PreparedRecordingOperationsSchema,
	UUIDSchema,
	MAX_RECOVERY_OPERATIONS,
	samePreparedRecording,
} from "./recording-operation.js"
import type {
	PreparedRecordingMetadata,
	RecordingBinding,
} from "./recording-operation.js"

export type StoreChange =
	| "created"
	| "updated"
	| "upgraded"
	| "merged"
	| "deleted"
	| "transient"
export interface JournalEntry {
	seq: number
	at: string
	op:
		| "observation"
		| "evidence"
		| "classification"
		| "operator"
		| "delete"
		| "rekey"
		| "evict"
	payload: unknown
}
export interface DiscoveryFilter {
	jobId?: string
	sourceId?: string
	protocol?: ScannerProtocol
	minConfidence?: ScannerConfidence
	freqMinHz?: number
	freqMaxHz?: number
	since?: number
	encrypted?: boolean
	q?: string
	/** Exact `kind` and case-insensitive trimmed `value`. Combined with the other filters by AND. */
	identity?: Identity
	sort?: "lastSeen" | "frequency" | "confidence"
	cursor?: string | null
	limit?: number
}
export interface DiscoveryStoreOptions {
	maxDiscoveries: number
	now: () => number
	newId: () => string
	minSurfaceBlocks?: number
	rasters?: (sourceId: string, centreHz: number) => Raster[]
}
export type RecordingLinkState = "linked" | "cut" | "encrypted-dropped" | "none"
export interface StoreSnapshot {
	discoveries: Discovery[]
	observations: Observation[]
	corrections: { sourceId: string; hz: number }[]
	recordingOperations?: PreparedRecordingMetadata[]
}

/** Construct after the last await. References are existing plain internal objects. */
export interface RecordingCommitPlan {
	readonly metadata: PreparedRecordingMetadata
	readonly observation: Observation
	readonly discovery: Discovery
	readonly evidence: Discovery["evidence"]
	readonly priorIds: string[]
	readonly priorRecording: Observation["recording"]
	readonly priorCount: number
	readonly recordingIds: string[]
	readonly recordingState: "linked" | "cut"
	readonly recordingCount: number
}

/**
 * WG2 req 13.1: an observation newly credited to jobs by one ingest (its first placement, or jobs
 * joining a placed observation). A promoted single-block hit credits every pending observation.
 */
export interface Attribution {
	observationId: string
	discoveryId: string
	jobIds: string[]
	/** The ingest created the discovery the observation landed in. */
	created: boolean
}
type Ingested = {
	discoveryId: string | null
	change: StoreChange
	attributed?: Attribution[]
}

const METADATA_MAX = 64
const LINKS_MAX = 64
const OBSERVATIONS_PER_DISCOVERY = 256
const OBSERVATION_DECODE_MAX = 16
const MEDIAN_WINDOW = 64
const SINGLE_BLOCK_HITS = 3
const SINGLE_BLOCK_WINDOW_MS = 10 * 60_000
const SINGLE_BLOCK_EXTRA_DB = 6
const BURST_EXTRA_DB = 3 // spec § 4.10: k_short + 3 dB
const MAX_PENDING_KEYS = 4096
const MAX_FLAGGED_IDS = 4096
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const DAY_MS = 86_400_000
const TRANSIENT: Ingested = { discoveryId: null, change: "transient" }
const CHANGE_RANK: Record<StoreChange, number> = {
	transient: 0,
	updated: 1,
	upgraded: 2,
	merged: 3,
	created: 4,
	deleted: 5,
}

interface Op {
	discoveries: Set<string>
	observations: Set<string>
	deleted: string[]
	changes: Map<string, StoreChange>
	merged: [string, string][]
	removedObservations: string[]
	correction?: { sourceId: string; hz: number }
	/**
	 * Observation id → the discovery it was placed in and the job ids newly credited (WG2 req 13.1).
	 * Recorded at placement, so neither observation retention nor a later listener can lose it.
	 */
	credited: Map<string, { discoveryId: string; jobIds: string[] }>
}

function newOp(): Op {
	return {
		discoveries: new Set(),
		observations: new Set(),
		deleted: [],
		changes: new Map(),
		merged: [],
		removedObservations: [],
		credited: new Map(),
	}
}

function mark(op: Op, id: string, change: StoreChange): void {
	const current = op.changes.get(id)
	if (current === undefined || CHANGE_RANK[change] > CHANGE_RANK[current])
		op.changes.set(id, change)
}

const rank = (c: ScannerConfidence): number => CONFIDENCE_RANK[c]
const maxConfidence = (
	a: ScannerConfidence,
	b: ScannerConfidence,
): ScannerConfidence => (rank(a) >= rank(b) ? a : b)
const iso = (ms: number): string => new Date(ms).toISOString()
const compareText = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0
const compareObs = (a: Observation, b: Observation): number =>
	compareText(a.startedAt, b.startedAt) || compareText(a.id, b.id)
const clone = <T>(value: T): T => structuredClone(value)

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	const upper = sorted[mid] ?? 0
	return sorted.length % 2 === 1
		? upper
		: ((sorted[mid - 1] ?? upper) + upper) / 2
}

/** Appends values not yet present without reordering (link and job lists); keeps the newest `max`. */
function appendMissing(
	list: readonly string[],
	values: readonly string[],
	max = LINKS_MAX,
): string[] {
	const out = [...list]
	for (const v of values) if (!out.includes(v)) out.push(v)
	return out.length > max ? out.slice(out.length - max) : out
}

function lruMerge<T>(
	list: readonly T[],
	values: readonly T[],
	max = METADATA_MAX,
): T[] {
	const out = [...list]
	for (const v of values) {
		const i = out.indexOf(v)
		if (i >= 0) out.splice(i, 1)
		out.push(v)
	}
	return out.length > max ? out.slice(out.length - max) : out
}

function sameIdentity(
	a: Identity | undefined,
	b: Identity | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b
	return a.kind === b.kind && a.value === b.value
}

function observedProtocol(c: Classification): ScannerProtocol {
	const top = c.hypotheses[0]
	if (top !== undefined && top.score >= 0.5) return top.protocol
	if (c.class === "analog-fm") return "analog-fm"
	if (c.class === "carrier") return "carrier"
	return "unknown"
}

/** § 7.3 ladder value a classification supports on its own. */
function ladderOf(c: Classification): ScannerConfidence {
	const top = c.hypotheses[0]
	const strong = top !== undefined && top.score >= 0.5
	const known =
		c.class !== "carrier" && c.class !== "wideband" && c.class !== "unknown"
	if (c.tier === "channel" && c.cap === undefined && strong && known)
		return "classified"
	if (strong || c.class !== "unknown") return "candidate"
	return "activity"
}

/** § 7.2 (c): a classification counts as attached when it names something real. */
function classificationAttached(c: Classification): boolean {
	const top = c.hypotheses[0]
	if (
		top !== undefined &&
		top.score >= 0.5 &&
		top.protocol !== "unknown" &&
		top.protocol !== "carrier"
	)
		return true
	return (
		c.class !== "unknown" && c.class !== "carrier" && c.class !== "wideband"
	)
}

function moreSpecific(
	current: ScannerProtocol,
	next: ScannerProtocol,
): boolean {
	if (current === next || next === "unknown") return false
	if (current === "unknown" || current === "carrier") return true
	if (current === "digital-unknown")
		return familyOf(next) === "digital-voice" && next !== "digital-unknown"
	return false
}

function statsOf(t: TrackSnapshot): SignalStats {
	return {
		peakDbfs: t.peakDbfs,
		meanDbfs: t.meanDbfs,
		snrDb: t.snrDb,
		floorDbfs: t.floorDbfs,
	}
}

function emptyMetadata(): DiscoveryMetadata {
	return {
		talkgroups: [],
		sources: [],
		slots: [],
		callsigns: [],
		capcodes: [],
		ismModels: [],
	}
}

/** Anything only a decode brings; a retracted observation never deletes a discovery that holds it. */
function hasDecodeEvidence(d: Discovery): boolean {
	const m = d.metadata
	const listed =
		m.talkgroups.length +
		m.sources.length +
		m.slots.length +
		m.callsigns.length +
		m.capcodes.length +
		m.ismModels.length
	return (
		d.confidence === "decoded" ||
		d.identity !== undefined ||
		d.encrypted ||
		listed > 0 ||
		m.ctcssHz !== undefined
	)
}

const durationOf = (obs: ObservationInput): number =>
	obs.endedAt === undefined ? 0 : Math.max(0, obs.endedAt - obs.startedAt)
const recordDuration = (o: Observation): number =>
	o.endedAt === undefined
		? 0
		: Math.max(0, Date.parse(o.endedAt) - Date.parse(o.startedAt))

export class DiscoveryStore extends EventEmitter {
	private maxDiscoveries: number
	private readonly now: () => number
	private readonly newId: () => string
	private minSurfaceBlocks: number
	private readonly rastersFor: (sourceId: string, centreHz: number) => Raster[]
	private readonly discoveries = new Map<string, Discovery>()
	private readonly observationIndex = new Map<string, Observation>()
	private readonly byDiscovery = new Map<string, Observation[]>()
	private readonly bySource = new Map<string, Set<string>>()
	private readonly pending = new Map<string, ObservationInput[]>()
	/**
	 * Observation ids seen with truncated/iqImage/spur (in-memory, newest 4096). Defence in depth: the
	 * tracker never clears these flags, so a later snapshot always carries them; the store does not rely on it.
	 */
	private readonly flaggedIds = new Set<string>()
	private readonly corrections = new Map<string, number>()
	private readonly recordingOperations = new Map<
		string,
		PreparedRecordingMetadata
	>()
	private appliedSeq = 0

	constructor(opts: DiscoveryStoreOptions) {
		super()
		this.maxDiscoveries = opts.maxDiscoveries
		this.now = opts.now
		this.newId = opts.newId
		this.minSurfaceBlocks = opts.minSurfaceBlocks ?? 2
		this.rastersFor = opts.rasters ?? (() => [])
	}

	ingest(input: ObservationInput): Ingested {
		const flagged = this.rememberStickyFlags(input) // may be raised late (P3, § 4.9)
		const known = this.observationIndex.get(input.id)
		if (known !== undefined)
			return flagged ? this.retract(known) : this.reingest(known, input)
		if (flagged) {
			this.dropPending(input.id)
			return TRANSIENT
		}
		if (input.jobIds.length === 0) return TRANSIENT
		const obs = this.withPendingBurst(input)
		const edge = obs.track.flags.edge
		const protocol = edge ? "unknown" : observedProtocol(obs.classification)
		const family = familyOf(protocol)
		const sticky = this.stickyMatch(obs, family)
		if (sticky !== undefined)
			return this.commit("observation", op =>
				this.addObservation(op, sticky, obs),
			)
		const place = this.placement(
			obs.sourceId,
			obs.track.centreHz,
			obs.track.obwHz,
		)
		const target = this.keyTarget(
			obs.sourceId,
			place.key,
			family,
			obs.classification.class,
		)
		const into = target.merge
		if (into !== null)
			return this.commit("observation", op =>
				this.addObservation(op, into, obs),
			)
		if (!this.surfaces(obs))
			return this.singleBlockHit(
				obs,
				place.key,
				protocol,
				family,
				target.coChannel,
			)
		return this.createFrom([obs], protocol, family, target.coChannel)
	}

	/**
	 * Applies CRC-clean decode evidence. `opts.cap` is the leak/intermod cap computed for this decode
	 * (Task 35): it is recorded before the decode, so a capped decode leaves the discovery at `candidate`
	 * (§ 6.2); it is ignored once the discovery is `decoded` (P8). The discovery may be merged away by
	 * `settle()`; use `discoveryIdOf(observationId)` for the survivor. Only evidence that carries an
	 * identity confirms (`decoded`, § 6.6); evidence without one records metadata and `encrypted` and may
	 * only refine the protocol (as a classification does).
	 */
	applyEvidence(
		discoveryId: string,
		ev: DecodeEvidence,
		opts: { cap?: ConfidenceCap } = {},
	): StoreChange | null {
		const d = this.discoveries.get(discoveryId)
		if (d === undefined || !ev.crcClean) return null
		if (
			ev.identity !== undefined &&
			d.identity !== undefined &&
			!sameIdentity(ev.identity, d.identity)
		)
			return this.coChannelEvidence(d, ev, opts.cap)
		if (d.confidence === "decoded" && ev.protocol !== d.protocol) return null
		// identity-less evidence it does not adopt from another family belongs to a co-channel emitter: its
		// talkgroups or encrypted flag would land on, e.g., an analog discovery
		if (
			ev.identity === undefined &&
			!moreSpecific(d.protocol, ev.protocol) &&
			familyOf(ev.protocol) !== d.family &&
			d.family !== "unknown"
		)
			return null
		const before = JSON.stringify(d)
		const beforeRank = rank(d.confidence)
		this.capInto(d, opts.cap)
		this.decodeInto(d, ev)
		if (JSON.stringify(d) === before) return null
		const op = newOp()
		op.discoveries.add(d.id)
		mark(op, d.id, rank(d.confidence) > beforeRank ? "upgraded" : "updated")
		const id = this.settle(op, d)
		this.finish("evidence", op)
		return op.changes.get(id) ?? "updated"
	}

	applyClassification(
		discoveryId: string,
		c: Classification,
	): StoreChange | null {
		const d = this.discoveries.get(discoveryId)
		if (d === undefined) return null
		const before = JSON.stringify(d)
		const beforeRank = rank(d.confidence)
		this.applyClassificationTo(d, c)
		if (JSON.stringify(d) === before) return null
		const op = newOp()
		op.discoveries.add(d.id)
		mark(op, d.id, rank(d.confidence) > beforeRank ? "upgraded" : "updated")
		const id = this.settle(op, d)
		this.finish("classification", op)
		return op.changes.get(id) ?? "updated"
	}

	/** Surviving discovery id of an in-memory observation (after any settle merge); undefined when unknown or trimmed. */
	discoveryIdOf(observationId: string): string | undefined {
		return this.observationIndex.get(observationId)?.discoveryId
	}

	/**
	 * Appends accepted evidence to `Observation.decode` (§ 7.1 "accepted values only"): CRC-clean, the
	 * observation's epoch (P17, as the probe pool's rule in Task 34), not stamped after that epoch ended
	 * (`endedAt` when the observation ended by `retune` or `hop`). Exact duplicates are ignored; the list
	 * keeps the 16 newest by `at`. Journaled as one `"evidence"` entry.
	 */
	appendObservationEvidence(
		observationId: string,
		ev: DecodeEvidence,
	): boolean {
		const o = this.observationIndex.get(observationId)
		if (o === undefined || !ev.crcClean || ev.epoch !== o.sampleRange.epoch)
			return false
		const epochEnded = o.endReason === "retune" || o.endReason === "hop"
		if (epochEnded && o.endedAt !== undefined && ev.at >= Date.parse(o.endedAt))
			return false
		const list = o.decode ?? []
		const text = JSON.stringify(ev)
		if (list.some(x => JSON.stringify(x) === text)) return false
		const added = clone(ev)
		const sorted = [...list, added].sort((a, b) => a.at - b.at)
		const kept =
			sorted.length > OBSERVATION_DECODE_MAX
				? sorted.slice(sorted.length - OBSERVATION_DECODE_MAX)
				: sorted
		if (!kept.includes(added)) return false // older than the 16 kept
		o.decode = kept
		const op = newOp()
		op.observations.add(o.id)
		this.finish("evidence", op)
		return true
	}

	/** Runtime settings change (Task 35): the new bounds apply from the next ingest/eviction pass. */
	setLimits(opts: { maxDiscoveries: number; minSurfaceBlocks: number }): void {
		this.maxDiscoveries = opts.maxDiscoveries
		this.minSurfaceBlocks = opts.minSurfaceBlocks
	}

	setOperator(
		id: string,
		patch: Partial<NonNullable<Discovery["operator"]>>,
	): Discovery {
		const d = this.discoveries.get(id)
		if (d === undefined)
			throw new WaveKitError(
				`Discovery ${id} not found`,
				"SCANNER_DISCOVERY_NOT_FOUND",
			)
		const operator: NonNullable<Discovery["operator"]> = {
			...(d.operator ?? {}),
		}
		if (patch.label !== undefined) operator.label = patch.label
		if (patch.notes !== undefined) operator.notes = patch.notes
		if (patch.lockout !== undefined) operator.lockout = patch.lockout
		if (patch.keep !== undefined) operator.keep = patch.keep
		d.operator = operator
		const op = newOp()
		op.discoveries.add(id)
		mark(op, id, "updated")
		this.finish("operator", op)
		return clone(d)
	}

	delete(id: string): boolean {
		const d = this.discoveries.get(id)
		if (d === undefined) return false
		const op = newOp()
		this.deleteInto(op, d)
		this.finish("delete", op)
		return true
	}

	rekey(
		sourceId: string,
		correctionHz: number,
	): { merged: [string, string][] } {
		const op = newOp()
		this.corrections.set(sourceId, correctionHz)
		op.correction = { sourceId, hz: correctionHz }
		const ids = [...(this.bySource.get(sourceId) ?? [])].sort()
		for (const id of ids) {
			const d = this.discoveries.get(id)
			if (d === undefined) continue
			const before = `${d.frequencyKey}|${d.frequencyHz}|${d.measuredOffsetHz}`
			this.refresh(d)
			if (
				`${d.frequencyKey}|${d.frequencyHz}|${d.measuredOffsetHz}` !== before
			) {
				op.discoveries.add(id)
				mark(op, id, "updated")
			}
		}
		for (const id of ids) {
			const d = this.discoveries.get(id)
			if (d !== undefined) this.settle(op, d)
		}
		this.finish("rekey", op)
		return { merged: op.merged }
	}

	/** Only private metadata is changed; register exact append correlation before emitting. */
	prepareRecording(
		value: PreparedRecordingMetadata,
		beforeEmit?: (entry: Omit<JournalEntry, "seq">) => void,
	): Omit<JournalEntry, "seq"> {
		const parsed = PreparedRecordingMetadataSchema.safeParse(value)
		if (!parsed.success)
			throw new WaveKitError(
				"Invalid prepared recording metadata",
				"SCANNER_RECORDING_INVALID",
			)
		const metadata = parsed.data
		const o = this.observationIndex.get(metadata.observationId)
		const d = this.discoveries.get(metadata.discoveryId)
		if (
			o === undefined ||
			d === undefined ||
			o.discoveryId !== d.id ||
			metadata.binding.sourceId !== o.sourceId ||
			metadata.binding.stream !== o.sampleRange.stream ||
			metadata.binding.epoch !== o.sampleRange.epoch ||
			metadata.binding.inputFormat !== "cf32" ||
			metadata.binding.inputSampleRateHz !== 48000 ||
			metadata.binding.engineInstanceId === null ||
			metadata.binding.channelId === null ||
			metadata.binding.channelGeneration === null
		)
			throw new WaveKitError(
				"Invalid recording association or binding",
				"SCANNER_RECORDING_INVALID",
			)
		const existing = this.recordingOperations.get(metadata.operationId)
		if (
			(existing !== undefined && !samePreparedRecording(existing, metadata)) ||
			(existing === undefined &&
				this.recordingOperations.size >= MAX_RECOVERY_OPERATIONS)
		)
			throw new WaveKitError(
				"Recording operation conflict or overflow",
				"SCANNER_RECORDING_INVALID",
			)
		Object.freeze(metadata.binding)
		Object.freeze(metadata.expectedOutput)
		Object.freeze(metadata)
		this.recordingOperations.set(metadata.operationId, metadata)
		return this.emitPrepared({ add: [metadata], remove: [] }, beforeEmit)
	}

	/** Emit even when memory lacks it: an earlier snapshot can still contain this operation. */
	removePreparedRecording(
		operationId: string,
		beforeEmit?: (entry: Omit<JournalEntry, "seq">) => void,
	): Omit<JournalEntry, "seq"> {
		if (!UUIDSchema.safeParse(operationId).success)
			throw new WaveKitError(
				"Invalid recording operation ID",
				"SCANNER_RECORDING_INVALID",
			)
		this.recordingOperations.delete(operationId)
		return this.emitPrepared({ add: [], remove: [operationId] }, beforeEmit)
	}

	preparedRecordingOperations(): PreparedRecordingMetadata[] {
		return [...this.recordingOperations.values()].map(clone)
	}

	/** Exact current association, without pagination or any identity repair. */
	recordingAssociation(
		discoveryId: string,
		observationId: string,
		binding?: RecordingBinding,
	): { aliasIds: readonly string[] } | null {
		const observation = this.observationIndex.get(observationId)
		if (
			observation === undefined ||
			observation.discoveryId !== discoveryId ||
			!this.discoveries.has(discoveryId)
		)
			return null
		if (
			binding !== undefined &&
			(observation.sourceId !== binding.sourceId ||
				observation.sampleRange.stream !== binding.stream ||
				observation.sampleRange.epoch !== binding.epoch)
		)
			return null
		return { aliasIds: [...observation.recordingIds] }
	}

	buildRecordingCommitPlan(operationId: string): RecordingCommitPlan | null {
		const metadata = this.recordingOperations.get(operationId)
		if (metadata === undefined) return null
		const observation = this.observationIndex.get(metadata.observationId)
		const discovery = this.discoveries.get(metadata.discoveryId)
		if (
			observation === undefined ||
			discovery === undefined ||
			observation.discoveryId !== discovery.id ||
			observation.sourceId !== metadata.binding.sourceId ||
			observation.sampleRange.stream !== metadata.binding.stream ||
			observation.sampleRange.epoch !== metadata.binding.epoch
		)
			return null
		const priorCount = discovery.evidence.recordings
		const present = observation.recordingIds.includes(metadata.alias)
		const recordingCount = priorCount + (present ? 0 : 1)
		if (
			!Number.isSafeInteger(priorCount) ||
			priorCount < 0 ||
			!Number.isSafeInteger(recordingCount)
		)
			return null
		return {
			metadata,
			observation,
			discovery,
			evidence: discovery.evidence,
			priorIds: observation.recordingIds,
			priorRecording: observation.recording,
			priorCount,
			recordingIds: present
				? observation.recordingIds
				: [...observation.recordingIds, metadata.alias],
			recordingState: metadata.desiredState,
			recordingCount,
		}
	}

	/** Pure final current-state check, after every injected callback and immediately before linkSync. */
	recordingCommitPlanCurrent(plan: RecordingCommitPlan): boolean {
		return (
			this.recordingOperations.get(plan.metadata.operationId) ===
				plan.metadata &&
			this.observationIndex.get(plan.metadata.observationId) ===
				plan.observation &&
			this.discoveries.get(plan.metadata.discoveryId) === plan.discovery &&
			plan.observation.discoveryId === plan.discovery.id &&
			plan.observation.sourceId === plan.metadata.binding.sourceId &&
			plan.observation.sampleRange.stream === plan.metadata.binding.stream &&
			plan.observation.sampleRange.epoch === plan.metadata.binding.epoch &&
			plan.observation.recordingIds === plan.priorIds &&
			plan.observation.recording === plan.priorRecording &&
			plan.discovery.evidence === plan.evidence &&
			plan.evidence.recordings === plan.priorCount
		)
	}

	/** Caller may instead perform these exact three assignments directly in its marker decision interval. */
	applyRecordingCommitPlan(plan: RecordingCommitPlan): void {
		plan.observation.recordingIds = plan.recordingIds
		plan.observation.recording = plan.recordingState
		plan.evidence.recordings = plan.recordingCount
	}

	/** Postdecision only: capture/emit projection before public notifications can reenter. */
	publishRecordingCommit(plan: RecordingCommitPlan): void {
		const at = iso(this.now())
		if (
			this.observationIndex.get(plan.observation.id) !== plan.observation ||
			this.discoveries.get(plan.discovery.id) !== plan.discovery
		)
			return
		const entry: Omit<JournalEntry, "seq"> = {
			at,
			op: "evidence",
			payload: {
				discoveries: [clone(plan.discovery)],
				observations: [clone(plan.observation)],
				deleted: [],
			} satisfies StoreMutation,
		}
		let failure: unknown
		try {
			this.emit("mutation", entry)
		} catch (err) {
			failure = err
		}
		try {
			this.emit("change", plan.discovery.id, "updated")
		} catch (err) {
			failure ??= err
		}
		if (failure !== undefined) throw failure
	}

	private emitPrepared(
		patch: NonNullable<StoreMutation["preparedRecordingOperations"]>,
		beforeEmit?: (entry: Omit<JournalEntry, "seq">) => void,
	): Omit<JournalEntry, "seq"> {
		const entry: Omit<JournalEntry, "seq"> = {
			at: iso(this.now()),
			op: "evidence",
			payload: {
				discoveries: [],
				observations: [],
				deleted: [],
				preparedRecordingOperations: patch,
			} satisfies StoreMutation,
		}
		beforeEmit?.(entry)
		this.emit("mutation", entry)
		return entry
	}

	attachRecordings(
		observationId: string,
		recordingIds: string[],
		state: RecordingLinkState,
	): boolean {
		const o = this.observationIndex.get(observationId)
		const d = o === undefined ? undefined : this.discoveries.get(o.discoveryId)
		if (o === undefined || d === undefined) return false
		const added = recordingIds.filter(r => !o.recordingIds.includes(r))
		o.recordingIds = [...o.recordingIds, ...added]
		o.recording = state
		d.evidence.recordings += added.length
		const op = newOp()
		op.discoveries.add(d.id)
		op.observations.add(o.id)
		mark(op, d.id, "updated")
		this.finish("evidence", op)
		return true
	}

	setEvidenceFlags(
		discoveryId: string,
		patch: Partial<Discovery["evidence"]>,
	): boolean {
		const d = this.discoveries.get(discoveryId)
		if (d === undefined) return false
		if (patch.recordings !== undefined) d.evidence.recordings = patch.recordings
		if (patch.psd !== undefined) d.evidence.psd = patch.psd
		if (patch.iq !== undefined) d.evidence.iq = patch.iq
		const op = newOp()
		op.discoveries.add(d.id)
		mark(op, d.id, "updated")
		this.finish("evidence", op)
		return true
	}

	setUndecodedReason(
		discoveryId: string,
		reason: NonNullable<Discovery["undecodedReason"]>,
	): boolean {
		const d = this.discoveries.get(discoveryId)
		if (
			d === undefined ||
			d.confidence === "decoded" ||
			d.undecodedReason === reason
		)
			return false
		d.undecodedReason = reason
		const op = newOp()
		op.discoveries.add(d.id)
		mark(op, d.id, "updated")
		this.finish("classification", op)
		return true
	}

	pruneInactive(maxAgeDays: number): string[] {
		const cutoff = iso(this.now() - maxAgeDays * DAY_MS)
		const op = newOp()
		const removed: string[] = []
		for (const d of [...this.discoveries.values()]) {
			// WG2 R2: a lockout is skipped by sweeps, so its lastSeenAt stops moving; age must not
			// silently remove it and put the frequency back into sweeps.
			if (
				d.operator?.keep === true ||
				d.operator?.lockout === true ||
				d.lastSeenAt >= cutoff
			)
				continue
			removed.push(d.id)
			this.deleteInto(op, d)
		}
		this.finish("evict", op)
		return removed
	}

	correction(sourceId: string): number {
		return this.corrections.get(sourceId) ?? 0
	}

	/** WG2 req 12.1: the locked-out discoveries heard on `sourceId` (no clone: three scalars each). */
	lockouts(sourceId: string): LockoutTarget[] {
		const out: LockoutTarget[] = []
		for (const d of this.discoveries.values())
			if (d.operator?.lockout === true && d.sourceIds.includes(sourceId))
				out.push({
					discoveryId: d.id,
					centreHz: d.frequencyHz,
					bandwidthHz: d.bandwidthHz,
				})
		return out
	}

	get(id: string): Discovery | undefined {
		const d = this.discoveries.get(id)
		return d === undefined ? undefined : clone(d)
	}

	list(filter: DiscoveryFilter): {
		items: Discovery[]
		nextCursor: string | null
	} {
		const limit = Math.min(
			MAX_LIMIT,
			Math.max(1, Math.floor(filter.limit ?? DEFAULT_LIMIT)),
		)
		const offset = parseCursor(filter.cursor ?? null)
		// q is lower-cased once. It matches the operator label or the identity value;
		// metadata lists (talkgroups, callsigns, capcodes) are not searched.
		const q = filter.q?.toLowerCase()
		const identity = filter.identity
		const identityValue = identity?.value.trim().toLowerCase()
		const min = filter.minConfidence
		const items = [...this.discoveries.values()].filter(
			d =>
				(filter.jobId === undefined || d.jobIds.includes(filter.jobId)) &&
				(filter.sourceId === undefined ||
					d.sourceIds.includes(filter.sourceId)) &&
				(filter.protocol === undefined || d.protocol === filter.protocol) &&
				(min === undefined || rank(d.confidence) >= rank(min)) &&
				(filter.freqMinHz === undefined || d.frequencyHz >= filter.freqMinHz) &&
				(filter.freqMaxHz === undefined || d.frequencyHz <= filter.freqMaxHz) &&
				(filter.since === undefined ||
					Date.parse(d.lastSeenAt) >= filter.since) &&
				(filter.encrypted === undefined || d.encrypted === filter.encrypted) &&
				(identity === undefined ||
					(d.identity?.kind === identity.kind &&
						d.identity.value.trim().toLowerCase() === identityValue)) &&
				(q === undefined ||
					(d.operator?.label ?? "").toLowerCase().includes(q) ||
					(d.identity?.value ?? "").toLowerCase().includes(q)),
		)
		const byLastSeen = (a: Discovery, b: Discovery): number =>
			compareText(b.lastSeenAt, a.lastSeenAt) || compareText(a.id, b.id)
		const sort = filter.sort ?? "lastSeen"
		items.sort(
			sort === "frequency"
				? (a, b) => a.frequencyHz - b.frequencyHz || compareText(a.id, b.id)
				: sort === "confidence"
					? (a, b) =>
							rank(b.confidence) - rank(a.confidence) || byLastSeen(a, b)
					: byLastSeen,
		)
		const page = items.slice(offset, offset + limit).map(clone)
		return {
			items: page,
			nextCursor: offset + limit < items.length ? String(offset + limit) : null,
		}
	}

	observations(
		discoveryId: string,
		cursor: string | null,
		limit: number,
	): { items: Observation[]; nextCursor: string | null } {
		const all = [...(this.byDiscovery.get(discoveryId) ?? [])].reverse()
		const offset = parseCursor(cursor)
		const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)))
		return {
			items: all.slice(offset, offset + size).map(clone),
			nextCursor: offset + size < all.length ? String(offset + size) : null,
		}
	}

	/** Everything replay cannot rebuild without the pruned journal: records plus per-source corrections (P13). */
	snapshot(): StoreSnapshot {
		return {
			discoveries: [...this.discoveries.values()]
				.sort((a, b) => compareText(a.id, b.id))
				.map(clone),
			observations: [...this.observationIndex.values()]
				.sort(compareObs)
				.map(clone),
			...(this.recordingOperations.size > 0
				? { recordingOperations: this.preparedRecordingOperations() }
				: {}),
			corrections: [...this.corrections]
				.sort(([a], [b]) => compareText(a, b))
				.map(([sourceId, hz]) => ({ sourceId, hz })),
		}
	}

	restore(s: StoreSnapshot): void {
		const recordings = PreparedRecordingOperationsSchema.safeParse(
			s.recordingOperations ?? [],
		)
		if (!recordings.success)
			throw new WaveKitError(
				"Invalid prepared recording snapshot",
				"SCANNER_JOURNAL_INVALID",
			)
		this.recordingOperations.clear()
		for (const recording of recordings.data) {
			Object.freeze(recording.binding)
			Object.freeze(recording.expectedOutput)
			this.recordingOperations.set(
				recording.operationId,
				Object.freeze(recording),
			)
		}
		this.discoveries.clear()
		this.observationIndex.clear()
		this.byDiscovery.clear()
		this.bySource.clear()
		this.pending.clear()
		this.flaggedIds.clear()
		this.corrections.clear()
		this.appliedSeq = 0
		for (const c of s.corrections) this.corrections.set(c.sourceId, c.hz)
		for (const d of s.discoveries) this.insertDiscovery(clone(d))
		for (const o of [...s.observations].sort(compareObs))
			if (this.discoveries.has(o.discoveryId)) this.putObservation(clone(o))
	}

	replay(entry: JournalEntry): void {
		if (entry.seq <= this.appliedSeq) return
		const m = parseStoreMutation(entry.payload)
		if (m === null)
			throw new WaveKitError(
				`Journal entry ${entry.seq} has an invalid payload`,
				"SCANNER_JOURNAL_INVALID",
			)
		this.applyMutation(m)
		this.appliedSeq = entry.seq
	}

	// ── association ──────────────────────────────────────────────────────

	private stickyMatch(
		obs: ObservationInput,
		family: ProtocolFamily,
	): Discovery | undefined {
		const ids = this.bySource.get(obs.sourceId)
		if (ids === undefined) return undefined
		const tol = this.toleranceHz(
			obs.sourceId,
			obs.track.centreHz,
			obs.track.obwHz,
		)
		let best: Discovery | undefined
		let bestDist = Number.POSITIVE_INFINITY
		for (const id of ids) {
			const d = this.discoveries.get(id)
			if (d === undefined || d.family !== family) continue
			const dist = Math.abs(this.medianCentre(d) - obs.track.centreHz)
			if (dist > tol) continue
			const better =
				best === undefined ||
				dist < bestDist ||
				(dist === bestDist &&
					(d.lastSeenAt > best.lastSeenAt ||
						(d.lastSeenAt === best.lastSeenAt && d.id < best.id)))
			if (better) {
				best = d
				bestDist = dist
			}
		}
		return best
	}

	private keyTarget(
		sourceId: string,
		key: string,
		family: ProtocolFamily,
		cls: ScannerClass,
	): { merge: Discovery | null; coChannel: string[] } {
		const atKey = this.atKey(sourceId, key)
		const same = atKey.filter(d => d.family === family)
		const [only] = same
		if (same.length === 1 && only !== undefined)
			return { merge: only, coChannel: [] }
		if (same.length > 1) {
			const pick =
				same.find(d => d.class === cls) ??
				same.find(d => d.identity === undefined)
			return pick !== undefined
				? { merge: pick, coChannel: [] }
				: { merge: null, coChannel: same.map(d => d.id) }
		}
		if (family === "unknown") {
			const others = atKey.filter(d => d.family !== "carrier")
			const [single] = others
			if (others.length === 1 && single !== undefined)
				return { merge: single, coChannel: [] }
		} else {
			const [lone] = atKey
			if (atKey.length === 1 && lone !== undefined && lone.family === "unknown")
				return { merge: lone, coChannel: [] }
		}
		return { merge: null, coChannel: atKey.map(d => d.id) }
	}

	private surfaces(obs: ObservationInput): boolean {
		const t = obs.track
		if (t.flags.burst) return t.maxBlockSnrDb >= t.thresholdDb + BURST_EXTRA_DB // otherwise rule (d) repetition only
		if (t.blocks >= this.minSurfaceBlocks) return true
		if (
			obs.singleBlockSurfacingAllowed &&
			t.maxBlockSnrDb >= t.thresholdDb + SINGLE_BLOCK_EXTRA_DB
		)
			return true
		// (c) needs a channel-tier class: a spectral class is derived from the same single block of energy and cannot vouch for it
		return (
			!t.flags.edge &&
			obs.classification.tier === "channel" &&
			classificationAttached(obs.classification)
		)
	}

	private singleBlockHit(
		obs: ObservationInput,
		key: string,
		protocol: ScannerProtocol,
		family: ProtocolFamily,
		coChannel: string[],
	): Ingested {
		const pendingKey = `${obs.sourceId}|${key}`
		const hits = (this.pending.get(pendingKey) ?? []).filter(
			h =>
				h.id !== obs.id &&
				Math.abs(obs.startedAt - h.startedAt) <= SINGLE_BLOCK_WINDOW_MS,
		)
		hits.push(obs)
		this.pending.delete(pendingKey)
		if (hits.length < SINGLE_BLOCK_HITS) {
			this.pending.set(pendingKey, hits)
			if (this.pending.size > MAX_PENDING_KEYS) {
				const oldest = this.pending.keys().next()
				if (oldest.done !== true) this.pending.delete(oldest.value)
			}
			return TRANSIENT
		}
		hits.sort((a, b) => a.startedAt - b.startedAt || compareText(a.id, b.id))
		return this.createFrom(hits, protocol, family, coChannel)
	}

	private createFrom(
		hits: ObservationInput[],
		protocol: ScannerProtocol,
		family: ProtocolFamily,
		coChannel: string[],
	): Ingested {
		const [first, ...rest] = hits
		if (first === undefined || !this.makeRoom()) return TRANSIENT
		return this.commit("observation", op => {
			const d = this.newDiscovery(op, first, protocol, family, coChannel)
			let id = this.addObservation(op, d, first)
			for (const hit of rest) {
				const current = this.discoveries.get(id)
				if (current !== undefined) id = this.addObservation(op, current, hit)
			}
			return id
		})
	}

	private newDiscovery(
		op: Op,
		obs: ObservationInput,
		protocol: ScannerProtocol,
		family: ProtocolFamily,
		coChannel: string[],
	): Discovery {
		const place = this.placement(
			obs.sourceId,
			obs.track.centreHz,
			obs.track.obwHz,
		)
		const stats = statsOf(obs.track)
		const at = iso(obs.startedAt)
		const d: Discovery = {
			id: `d_${this.newId()}`,
			frequencyHz: Math.round(place.frequencyHz),
			frequencyKey: place.key,
			measuredOffsetHz: 0,
			bandwidthHz: Math.round(obs.track.obwHz),
			protocol,
			family,
			class: obs.track.flags.edge ? "unknown" : obs.classification.class,
			confidence: obs.track.flags.edge
				? "activity"
				: ladderOf(obs.classification),
			encrypted: false,
			coChannel: coChannel
				.filter(id => this.discoveries.has(id))
				.slice(0, LINKS_MAX),
			firstSeenAt: at,
			lastSeenAt: at,
			observationCount: 0,
			airtimeMs: 0,
			signal: { best: stats, last: { ...stats } },
			metadata: emptyMetadata(),
			sourceIds: [obs.sourceId],
			jobIds: [],
			tuningTrust: obs.track.tuningTrust,
			evidence: { recordings: 0, psd: false, iq: false },
		}
		this.insertDiscovery(d)
		for (const otherId of d.coChannel) {
			const other = this.discoveries.get(otherId)
			if (other === undefined) continue
			other.coChannel = appendMissing(other.coChannel, [d.id])
			op.discoveries.add(other.id)
			mark(op, other.id, "updated")
		}
		this.pending.delete(`${obs.sourceId}|${place.key}`)
		op.discoveries.add(d.id)
		mark(op, d.id, "created")
		return d
	}

	private addObservation(op: Op, d: Discovery, obs: ObservationInput): string {
		const beforeRank = rank(d.confidence)
		const record = this.toRecord(obs, d.id)
		this.putObservation(record)
		op.observations.add(record.id)
		op.credited.set(record.id, {
			discoveryId: d.id,
			jobIds: [...record.jobIds],
		})
		d.observationCount += 1
		d.airtimeMs += durationOf(obs)
		this.absorbStats(d, obs, true)
		this.refresh(d)
		op.discoveries.add(d.id)
		mark(op, d.id, rank(d.confidence) > beforeRank ? "upgraded" : "updated")
		return this.settle(op, d)
	}

	private reingest(known: Observation, obs: ObservationInput): Ingested {
		const d = this.discoveries.get(known.discoveryId)
		if (d === undefined) return TRANSIENT
		const beforeD = JSON.stringify(d)
		const beforeO = JSON.stringify(known)
		const beforeRank = rank(d.confidence)
		const record = this.toRecord(obs, d.id)
		record.jobIds = appendMissing(known.jobIds, obs.jobIds) // a job that ended while the track was open keeps its credit
		record.recordingIds = known.recordingIds
		if (known.recording !== undefined) record.recording = known.recording
		if (known.decode !== undefined) record.decode = known.decode
		d.airtimeMs = Math.max(
			0,
			d.airtimeMs + durationOf(obs) - recordDuration(known),
		)
		this.unlinkObservation(known)
		this.putObservation(record)
		const sameClassification =
			JSON.stringify(record.hypotheses) === JSON.stringify(known.hypotheses) &&
			record.flags.adjacentLeak === known.flags.adjacentLeak &&
			record.flags.suspectedIntermod === known.flags.suspectedIntermod
		this.absorbStats(d, obs, !sameClassification)
		this.refresh(d)
		if (JSON.stringify(d) === beforeD && JSON.stringify(record) === beforeO)
			return { discoveryId: d.id, change: "updated" }
		const joined = record.jobIds.filter(j => !known.jobIds.includes(j))
		return this.commit("observation", op => {
			op.discoveries.add(d.id)
			op.observations.add(record.id)
			if (joined.length > 0)
				op.credited.set(record.id, { discoveryId: d.id, jobIds: joined })
			mark(op, d.id, rank(d.confidence) > beforeRank ? "upgraded" : "updated")
			return this.settle(op, d)
		})
	}

	/**
	 * A known observation whose track became truncated, an IQ image or a spur (sticky flags, raised late) is
	 * unlinked (P3, § 4.9). Its discovery loses the count and airtime and is deleted when nothing is left
	 * that the observation did not bring: no observation, no decode evidence, not `keep`. One entry.
	 */
	private retract(known: Observation): Ingested {
		const d = this.discoveries.get(known.discoveryId)
		this.dropPending(known.id)
		if (d === undefined) return TRANSIENT
		const op = newOp()
		this.unlinkObservation(known)
		op.removedObservations.push(known.id)
		d.observationCount = Math.max(0, d.observationCount - 1)
		d.airtimeMs = Math.max(0, d.airtimeMs - recordDuration(known))
		if (
			d.observationCount === 0 &&
			!hasDecodeEvidence(d) &&
			d.operator?.keep !== true
		) {
			this.deleteInto(op, d)
		} else {
			this.refresh(d)
			op.discoveries.add(d.id)
			mark(op, d.id, "updated")
			this.settle(op, d)
		}
		this.finish("observation", op)
		return TRANSIENT
	}

	/**
	 * Records and reports truncated/iqImage/spur, merged with OR over an observation's snapshots: once
	 * seen, always flagged (defence in depth, see `flaggedIds`).
	 */
	private rememberStickyFlags(obs: ObservationInput): boolean {
		const f = obs.track.flags
		if (!f.truncated && !f.iqImage && !f.spur && !this.flaggedIds.has(obs.id))
			return false
		this.flaggedIds.delete(obs.id)
		this.flaggedIds.add(obs.id)
		if (this.flaggedIds.size > MAX_FLAGGED_IDS) {
			const oldest = this.flaggedIds.values().next()
			if (oldest.done !== true) this.flaggedIds.delete(oldest.value)
		}
		return true
	}

	/**
	 * Defence in depth: `burst` is the one track flag that clears, and the pipeline only moves it true →
	 * false (Task 10a), so its latest value already is the AND over the track's snapshots. The store keeps
	 * that AND without relying on it: a pending hit whose earlier snapshot was not a burst is never a burst
	 * again. Only pending hits matter, because surfacing is decided at creation.
	 */
	private withPendingBurst(obs: ObservationInput): ObservationInput {
		if (!obs.track.flags.burst) return obs
		for (const hits of this.pending.values()) {
			const earlier = hits.find(h => h.id === obs.id)
			if (earlier === undefined) continue
			if (earlier.track.flags.burst) return obs
			return {
				...obs,
				track: { ...obs.track, flags: { ...obs.track.flags, burst: false } },
			}
		}
		return obs
	}

	private dropPending(observationId: string): void {
		for (const [key, hits] of this.pending) {
			if (!hits.some(h => h.id === observationId)) continue
			const rest = hits.filter(h => h.id !== observationId)
			if (rest.length === 0) this.pending.delete(key)
			else this.pending.set(key, rest)
		}
	}

	private absorbStats(
		d: Discovery,
		obs: ObservationInput,
		applyClassification: boolean,
	): void {
		const startedAt = iso(obs.startedAt)
		const endedAt = iso(obs.endedAt ?? obs.startedAt)
		if (startedAt < d.firstSeenAt) d.firstSeenAt = startedAt
		const stats = statsOf(obs.track)
		if (endedAt >= d.lastSeenAt) {
			d.lastSeenAt = endedAt
			d.signal.last = stats
			d.tuningTrust = obs.track.tuningTrust
		}
		if (stats.snrDb > d.signal.best.snrDb) d.signal.best = { ...stats }
		d.jobIds = appendMissing(d.jobIds, obs.jobIds)
		d.sourceIds = appendMissing(d.sourceIds, [obs.sourceId])
		if (applyClassification && !obs.track.flags.edge)
			this.applyClassificationTo(d, obs.classification)
	}

	private applyClassificationTo(d: Discovery, c: Classification): void {
		const decoded = d.confidence === "decoded"
		if (c.cap !== undefined && !decoded) d.confidenceCap = c.cap
		const p = observedProtocol(c)
		if (!decoded && moreSpecific(d.protocol, p)) {
			d.protocol = p
			d.family = familyOf(p)
		}
		if (!decoded && c.class !== "unknown") d.class = c.class
		d.confidence = maxConfidence(d.confidence, ladderOf(c))
		this.clampToCap(d)
	}

	private decodeInto(d: Discovery, ev: DecodeEvidence): void {
		// evidence without an identity is no confirm (§ 6.6): it may only refine the protocol, never switch the
		// family, or settle() could merge an analog discovery into its co-channel digital twin irreversibly
		const adopt =
			ev.identity !== undefined
				? d.protocol !== ev.protocol
				: moreSpecific(d.protocol, ev.protocol)
		if (adopt) {
			d.protocol = ev.protocol
			d.family = familyOf(ev.protocol)
		}
		if (d.identity === undefined && ev.identity !== undefined)
			d.identity = { kind: ev.identity.kind, value: ev.identity.value }
		if (ev.encrypted === true) d.encrypted = true
		const m = ev.metadata
		if (m.talkgroups !== undefined)
			d.metadata.talkgroups = lruMerge(d.metadata.talkgroups, m.talkgroups)
		if (m.sources !== undefined)
			d.metadata.sources = lruMerge(d.metadata.sources, m.sources)
		if (m.slots !== undefined)
			d.metadata.slots = lruMerge(d.metadata.slots, m.slots)
		if (m.callsigns !== undefined)
			d.metadata.callsigns = lruMerge(d.metadata.callsigns, m.callsigns)
		if (m.capcodes !== undefined)
			d.metadata.capcodes = lruMerge(d.metadata.capcodes, m.capcodes)
		if (m.ismModels !== undefined)
			d.metadata.ismModels = lruMerge(d.metadata.ismModels, m.ismModels)
		if (m.ctcssHz !== undefined) d.metadata.ctcssHz = m.ctcssHz
		// § 6.6: a confirm is the first accepted identity; evidence without one (accepted TG/SRC/encrypted only) is recorded but confirms nothing
		if (ev.identity !== undefined)
			d.confidence = maxConfidence(
				d.confidence,
				d.confidenceCap !== undefined ? "candidate" : "decoded",
			)
		if (d.confidence === "decoded") {
			delete d.confidenceCap
			delete d.undecodedReason
		}
		const at = iso(ev.at)
		if (at > d.lastSeenAt) d.lastSeenAt = at
	}

	private coChannelEvidence(
		d: Discovery,
		ev: DecodeEvidence,
		cap: ConfidenceCap | undefined,
	): StoreChange | null {
		const family = familyOf(ev.protocol)
		const sourceId = d.sourceIds[0] ?? ""
		const existing = this.atKey(sourceId, d.frequencyKey).find(
			o => o.family === family && sameIdentity(o.identity, ev.identity),
		)
		if (existing !== undefined)
			return this.applyEvidence(
				existing.id,
				ev,
				cap === undefined ? {} : { cap },
			)
		if (!this.makeRoom()) return null
		const op = newOp()
		const at = iso(ev.at)
		const twin: Discovery = {
			id: `d_${this.newId()}`,
			frequencyHz: d.frequencyHz,
			frequencyKey: d.frequencyKey,
			measuredOffsetHz: d.measuredOffsetHz,
			bandwidthHz: d.bandwidthHz,
			protocol: ev.protocol,
			family,
			class: d.class,
			confidence: "activity",
			encrypted: false,
			coChannel: [],
			firstSeenAt: at,
			lastSeenAt: at,
			observationCount: 0,
			airtimeMs: 0,
			signal: clone(d.signal),
			metadata: emptyMetadata(),
			sourceIds: [...d.sourceIds],
			jobIds: [...d.jobIds],
			tuningTrust: d.tuningTrust,
			evidence: { recordings: 0, psd: false, iq: false },
		}
		this.insertDiscovery(twin)
		this.capInto(twin, cap)
		this.decodeInto(twin, ev)
		const partner = this.discoveries.get(d.id)
		if (partner !== undefined) {
			twin.coChannel = [partner.id]
			partner.coChannel = appendMissing(partner.coChannel, [twin.id])
			op.discoveries.add(partner.id)
			mark(op, partner.id, "updated")
		}
		op.discoveries.add(twin.id)
		mark(op, twin.id, "created")
		const id = this.settle(op, twin)
		this.finish("evidence", op)
		return op.changes.get(id) ?? "created"
	}

	/** Records a leak/intermod cap that arrives with a decode, before the decode is applied (§ 6.2, P8). */
	private capInto(d: Discovery, cap: ConfidenceCap | undefined): void {
		if (cap === undefined || d.confidence === "decoded") return
		d.confidenceCap = cap
		this.clampToCap(d)
	}

	private clampToCap(d: Discovery): void {
		if (
			d.confidenceCap !== undefined &&
			d.confidence !== "decoded" &&
			rank(d.confidence) > rank("candidate")
		)
			d.confidence = "candidate"
	}

	// ── keys, medians and collisions ─────────────────────────────────────

	private toleranceHz(
		sourceId: string,
		centreHz: number,
		obwHz: number,
	): number {
		const rasters = this.rastersFor(sourceId, centreHz)
		if (rasters.length === 0) return gridToleranceHz(obwHz)
		return rasterToleranceHz(Math.min(...rasters.map(r => r.spacingHz)))
	}

	private placement(
		sourceId: string,
		centreHz: number,
		obwHz: number,
	): { frequencyHz: number; key: string; offRaster: boolean } {
		const rasters = this.rastersFor(sourceId, centreHz)
		const snap = snapToRaster(
			centreHz,
			rasters,
			this.corrections.get(sourceId) ?? 0,
		)
		return {
			frequencyHz: snap.hz,
			key: frequencyKey(snap.hz, snap.snapped, obwHz),
			offRaster: rasters.length > 0 && !snap.snapped,
		}
	}

	private medianCentre(d: Discovery): number {
		const recent = (this.byDiscovery.get(d.id) ?? []).slice(-MEDIAN_WINDOW)
		return recent.length > 0
			? median(recent.map(o => o.centerHz))
			: d.frequencyHz + d.measuredOffsetHz
	}

	/** Recomputes frequency, key, offset and bandwidth from the last 64 observations. */
	private refresh(d: Discovery): void {
		const recent = (this.byDiscovery.get(d.id) ?? []).slice(-MEDIAN_WINDOW)
		const centre =
			recent.length > 0
				? median(recent.map(o => o.centerHz))
				: d.frequencyHz + d.measuredOffsetHz
		const obw =
			recent.length > 0 ? median(recent.map(o => o.obwHz)) : d.bandwidthHz
		const place = this.placement(d.sourceIds[0] ?? "", centre, obw)
		d.frequencyHz = Math.round(place.frequencyHz)
		d.frequencyKey = place.key
		// `|| 0`: a median centre 0.5 Hz below the raster rounds to -0, which JSON persists as 0 (P13).
		d.measuredOffsetHz = Math.round(centre - place.frequencyHz) || 0
		d.bandwidthHz = Math.round(obw)
	}

	private atKey(sourceId: string, key: string): Discovery[] {
		const out: Discovery[] = []
		for (const id of this.bySource.get(sourceId) ?? []) {
			const d = this.discoveries.get(id)
			if (d !== undefined && d.frequencyKey === key) out.push(d)
		}
		return out.sort(
			(a, b) =>
				compareText(b.lastSeenAt, a.lastSeenAt) || compareText(a.id, b.id),
		)
	}

	/** Merges every discovery that collides with `start` on (source, key, family, identity). */
	private settle(op: Op, start: Discovery): string {
		let d = start
		for (;;) {
			const other = this.atKey(d.sourceIds[0] ?? "", d.frequencyKey).find(
				o =>
					o.id !== d.id &&
					o.family === d.family &&
					sameIdentity(o.identity, d.identity),
			)
			if (other === undefined) return d.id
			const [keep, drop] =
				compareText(d.firstSeenAt, other.firstSeenAt) < 0 ||
				(d.firstSeenAt === other.firstSeenAt && d.id < other.id)
					? [d, other]
					: [other, d]
			this.absorb(op, keep, drop)
			d = keep
		}
	}

	private absorb(op: Op, keep: Discovery, drop: Discovery): void {
		for (const o of [...(this.byDiscovery.get(drop.id) ?? [])]) {
			this.unlinkObservation(o)
			o.discoveryId = keep.id
			this.putObservation(o)
			op.observations.add(o.id)
		}
		keep.observationCount += drop.observationCount
		keep.airtimeMs += drop.airtimeMs
		if (drop.firstSeenAt < keep.firstSeenAt) keep.firstSeenAt = drop.firstSeenAt
		if (drop.lastSeenAt > keep.lastSeenAt) {
			keep.lastSeenAt = drop.lastSeenAt
			keep.signal.last = drop.signal.last
			keep.tuningTrust = drop.tuningTrust
		}
		if (drop.signal.best.snrDb > keep.signal.best.snrDb)
			keep.signal.best = drop.signal.best
		const km = keep.metadata
		const dm = drop.metadata
		km.talkgroups = lruMerge(km.talkgroups, dm.talkgroups)
		km.sources = lruMerge(km.sources, dm.sources)
		km.slots = lruMerge(km.slots, dm.slots)
		km.callsigns = lruMerge(km.callsigns, dm.callsigns)
		km.capcodes = lruMerge(km.capcodes, dm.capcodes)
		km.ismModels = lruMerge(km.ismModels, dm.ismModels)
		if (km.ctcssHz === undefined && dm.ctcssHz !== undefined)
			km.ctcssHz = dm.ctcssHz
		keep.jobIds = appendMissing(keep.jobIds, drop.jobIds)
		keep.sourceIds = appendMissing(keep.sourceIds, drop.sourceIds)
		keep.encrypted = keep.encrypted || drop.encrypted
		if (keep.identity === undefined && drop.identity !== undefined)
			keep.identity = drop.identity
		if (
			keep.confidence !== "decoded" &&
			(drop.confidence === "decoded" ||
				moreSpecific(keep.protocol, drop.protocol))
		) {
			keep.protocol = drop.protocol
			keep.family = drop.family
			if (drop.class !== "unknown") keep.class = drop.class
		}
		keep.confidence = maxConfidence(keep.confidence, drop.confidence)
		if (keep.confidence === "decoded" || drop.confidenceCap === undefined)
			delete keep.confidenceCap
		if (keep.confidence === "decoded") delete keep.undecodedReason
		else if (
			keep.undecodedReason === undefined &&
			drop.undecodedReason !== undefined
		)
			keep.undecodedReason = drop.undecodedReason
		if (keep.operator !== undefined || drop.operator !== undefined) {
			const a = keep.operator ?? {}
			const b = drop.operator ?? {}
			const merged: NonNullable<Discovery["operator"]> = {}
			const label = a.label ?? b.label
			const notes = a.notes ?? b.notes
			if (label !== undefined) merged.label = label
			if (notes !== undefined) merged.notes = notes
			if (a.lockout === true || b.lockout === true) merged.lockout = true
			if (a.keep === true || b.keep === true) merged.keep = true
			keep.operator = merged
		}
		keep.evidence = {
			recordings: keep.evidence.recordings + drop.evidence.recordings,
			psd: keep.evidence.psd || drop.evidence.psd,
			iq: keep.evidence.iq || drop.evidence.iq,
		}
		keep.coChannel = appendMissing(keep.coChannel, drop.coChannel).filter(
			id => id !== keep.id && id !== drop.id,
		)
		for (const partnerId of drop.coChannel) {
			const partner = this.discoveries.get(partnerId)
			if (partner === undefined || partner.id === keep.id) continue
			partner.coChannel = appendMissing(
				partner.coChannel.filter(id => id !== drop.id),
				[keep.id],
			)
			op.discoveries.add(partner.id)
			mark(op, partner.id, "updated")
		}
		this.removeDiscovery(drop.id)
		op.discoveries.delete(drop.id)
		op.deleted.push(drop.id)
		op.merged.push([keep.id, drop.id])
		mark(op, drop.id, "deleted")
		mark(op, keep.id, "merged")
		op.discoveries.add(keep.id)
		this.refresh(keep)
	}

	/** Evicts until one more discovery fits (several after `setLimits` lowered the bound); one "evict" entry. */
	private makeRoom(): boolean {
		if (this.discoveries.size < this.maxDiscoveries) return true
		const op = newOp()
		let fits = true
		while (this.discoveries.size >= this.maxDiscoveries) {
			const victim = this.evictionVictim()
			if (victim === undefined) {
				fits = false
				break
			}
			this.deleteInto(op, victim)
		}
		this.finish("evict", op)
		return fits
	}

	/**
	 * Lowest confidence, then oldest `lastSeenAt` (ties: smaller id); never `decoded`, `keep` or
	 * locked out (WG2 R1 #8: evicting a lockout would silently put it back into sweeps).
	 */
	private evictionVictim(): Discovery | undefined {
		let victim: Discovery | undefined
		for (const d of this.discoveries.values()) {
			if (
				d.confidence === "decoded" ||
				d.operator?.keep === true ||
				d.operator?.lockout === true
			)
				continue
			if (
				victim === undefined ||
				rank(d.confidence) < rank(victim.confidence) ||
				(rank(d.confidence) === rank(victim.confidence) &&
					(d.lastSeenAt < victim.lastSeenAt ||
						(d.lastSeenAt === victim.lastSeenAt && d.id < victim.id)))
			)
				victim = d
		}
		return victim
	}

	private deleteInto(op: Op, d: Discovery): void {
		for (const partnerId of d.coChannel) {
			const partner = this.discoveries.get(partnerId)
			if (partner === undefined) continue
			partner.coChannel = partner.coChannel.filter(id => id !== d.id)
			op.discoveries.add(partner.id)
			mark(op, partner.id, "updated")
		}
		this.removeDiscovery(d.id)
		op.discoveries.delete(d.id)
		op.deleted.push(d.id)
		mark(op, d.id, "deleted")
	}

	// ── records and indexes ──────────────────────────────────────────────

	private toRecord(obs: ObservationInput, discoveryId: string): Observation {
		const t = obs.track
		const place = this.placement(obs.sourceId, t.centreHz, t.obwHz)
		const cap = obs.classification.cap
		const record: Observation = {
			id: obs.id,
			discoveryId,
			startedAt: iso(obs.startedAt),
			sampleRange: { stream: t.stream, epoch: t.epoch, start: t.startSample },
			centerHz: t.centreHz,
			obwHz: t.obwHz,
			obwMethod: t.obwMethod,
			peakDbfs: t.peakDbfs,
			meanDbfs: t.meanDbfs,
			snrDb: t.snrDb,
			floorDbfs: t.floorDbfs,
			thresholdDb: t.thresholdDb,
			dutyCycle: t.dutyCycle,
			hypotheses: obs.classification.hypotheses.map(h => ({
				protocol: h.protocol,
				score: h.score,
			})),
			recordingIds: [],
			flags: {
				overload: t.flags.overload,
				gap: t.flags.gap,
				offRaster: place.offRaster,
				obwBiased: t.flags.obwBiased,
				adjacentLeak: cap === "adjacent-leak",
				suspectedIntermod: cap === "suspected-intermod",
				edge: t.flags.edge,
			},
			sourceId: obs.sourceId,
			jobIds: [...obs.jobIds],
			tuningTrust: t.tuningTrust,
		}
		if (obs.endedAt !== undefined) {
			record.endedAt = iso(obs.endedAt)
			record.sampleRange.end = t.lastSample
		}
		if (obs.endReason !== undefined) record.endReason = obs.endReason
		if (t.acf30 !== undefined) record.acf30 = t.acf30
		if (t.acf60 !== undefined) record.acf60 = t.acf60
		if (obs.hopIndex !== undefined) record.hopIndex = obs.hopIndex
		return record
	}

	private insertDiscovery(d: Discovery): void {
		const previous = this.discoveries.get(d.id)
		if (previous !== undefined)
			for (const s of previous.sourceIds) this.bySource.get(s)?.delete(d.id)
		this.discoveries.set(d.id, d)
		for (const s of d.sourceIds) {
			let set = this.bySource.get(s)
			if (set === undefined) {
				set = new Set()
				this.bySource.set(s, set)
			}
			set.add(d.id)
		}
	}

	private removeDiscovery(id: string): void {
		const d = this.discoveries.get(id)
		if (d === undefined) return
		this.discoveries.delete(id)
		for (const s of d.sourceIds) this.bySource.get(s)?.delete(id)
		for (const o of this.byDiscovery.get(id) ?? [])
			this.observationIndex.delete(o.id)
		this.byDiscovery.delete(id)
	}

	/** Inserts an unlinked observation in canonical order and trims the per-discovery window. */
	private putObservation(o: Observation): void {
		this.observationIndex.set(o.id, o)
		let list = this.byDiscovery.get(o.discoveryId)
		if (list === undefined) {
			list = []
			this.byDiscovery.set(o.discoveryId, list)
		}
		let i = list.length
		for (;;) {
			const previous = list[i - 1]
			if (previous === undefined || compareObs(previous, o) <= 0) break
			i--
		}
		list.splice(i, 0, o)
		while (list.length > OBSERVATIONS_PER_DISCOVERY) {
			const dropped = list.shift()
			if (dropped !== undefined) this.observationIndex.delete(dropped.id)
		}
	}

	private unlinkObservation(o: Observation): void {
		const list = this.byDiscovery.get(o.discoveryId)
		if (list !== undefined) {
			const i = list.findIndex(x => x.id === o.id)
			if (i >= 0) list.splice(i, 1)
		}
		this.observationIndex.delete(o.id)
	}

	private applyMutation(m: StoreMutation): void {
		const patch = m.preparedRecordingOperations
		if (patch !== undefined) {
			const next = new Map(this.recordingOperations)
			for (const id of patch.remove) next.delete(id)
			for (const recording of patch.add) {
				const old = next.get(recording.operationId)
				if (old !== undefined && !samePreparedRecording(old, recording))
					throw new WaveKitError(
						"Conflicting prepared recording journal",
						"SCANNER_JOURNAL_INVALID",
					)
				next.set(recording.operationId, recording)
			}
			if (next.size > MAX_RECOVERY_OPERATIONS)
				throw new WaveKitError(
					"Prepared recording journal overflow",
					"SCANNER_JOURNAL_INVALID",
				)
			this.recordingOperations.clear()
			for (const [id, recording] of next) {
				Object.freeze(recording.binding)
				Object.freeze(recording.expectedOutput)
				this.recordingOperations.set(id, Object.freeze(recording))
			}
		}
		if (m.correction !== undefined)
			this.corrections.set(m.correction.sourceId, m.correction.hz)
		for (const d of m.discoveries) this.insertDiscovery(clone(d))
		for (const o of m.observations) {
			const previous = this.observationIndex.get(o.id)
			if (previous !== undefined) this.unlinkObservation(previous)
			this.putObservation(clone(o))
		}
		for (const id of m.removedObservations ?? []) {
			const previous = this.observationIndex.get(id)
			if (previous !== undefined) this.unlinkObservation(previous)
		}
		for (const id of m.deleted) this.removeDiscovery(id)
	}

	// ── journal ──────────────────────────────────────────────────────────

	private commit(kind: JournalEntry["op"], run: (op: Op) => string): Ingested {
		const op = newOp()
		const id = run(op)
		const out: Ingested = {
			discoveryId: id,
			change: op.changes.get(id) ?? "updated",
		}
		// WG2 req 13.1: snapshot the credits before any listener runs; a merge in this operation
		// moves the observation to the survivor.
		const survivor = new Map<string, string>()
		for (const [keep, drop] of op.merged) survivor.set(drop, keep)
		const resolve = (discoveryId: string): string => {
			let at = discoveryId
			for (let i = 0; i <= op.merged.length; i++) {
				const next = survivor.get(at)
				if (next === undefined) break
				at = next
			}
			return at
		}
		const attributed: Attribution[] = []
		for (const [observationId, credit] of op.credited) {
			if (credit.jobIds.length === 0) continue
			const discoveryId = resolve(credit.discoveryId)
			attributed.push({
				observationId,
				discoveryId,
				jobIds: [...credit.jobIds],
				created: op.changes.get(discoveryId) === "created",
			})
		}
		if (attributed.length > 0) out.attributed = attributed
		this.finish(kind, op)
		return out
	}

	private finish(kind: JournalEntry["op"], op: Op): void {
		const discoveries = [...op.discoveries]
			.map(id => this.discoveries.get(id))
			.filter((d): d is Discovery => d !== undefined)
			.sort((a, b) => compareText(a.id, b.id))
			.map(clone)
		const observations = [...op.observations]
			.map(id => this.observationIndex.get(id))
			.filter((o): o is Observation => o !== undefined)
			.sort(compareObs)
			.map(clone)
		const removed = op.removedObservations.filter(
			id => !this.observationIndex.has(id),
		)
		if (
			discoveries.length === 0 &&
			observations.length === 0 &&
			op.deleted.length === 0 &&
			removed.length === 0 &&
			op.correction === undefined
		)
			return
		const payload: StoreMutation = {
			discoveries,
			observations,
			deleted: [...op.deleted],
		}
		if (removed.length > 0) payload.removedObservations = removed
		if (op.correction !== undefined) payload.correction = { ...op.correction }
		const entry: Omit<JournalEntry, "seq"> = {
			at: iso(this.now()),
			op: kind,
			payload,
		}
		this.emit("mutation", entry)
		for (const [id, change] of op.changes) this.emit("change", id, change)
	}
}

function parseCursor(cursor: string | null): number {
	if (cursor === null) return 0
	if (!/^\d{1,9}$/.test(cursor))
		throw new WaveKitError("Invalid discovery cursor", "SCANNER_INVALID_CURSOR")
	return Number(cursor)
}

const FREQ_ERROR_MIN_DECODES = 5
const FREQ_ERROR_AGREE_HZ = 300

/**
 * Spec § 7.4: the receiver frequency error of `sourceId`, from its `decoded`, raster-snapped
 * discoveries (`r:` keys). The largest set whose `measuredOffsetHz` agree within 300 Hz (sliding window
 * over the sorted offsets; ties: the window whose median is nearest the overall median) must hold ≥ 5;
 * the estimate is that set's median offset, with ppm against its median channel frequency. Pure.
 */
export function estimateFrequencyError(
	discoveries: readonly Discovery[],
	sourceId: string,
): { hz: number; ppm: number; n: number } | null {
	const usable = discoveries
		.filter(
			d =>
				d.confidence === "decoded" &&
				d.sourceIds.includes(sourceId) &&
				d.frequencyKey.startsWith("r:") &&
				Number.isFinite(d.measuredOffsetHz),
		)
		.sort(
			(a, b) =>
				a.measuredOffsetHz - b.measuredOffsetHz || compareText(a.id, b.id),
		)
	if (usable.length < FREQ_ERROR_MIN_DECODES) return null
	const overall = median(usable.map(d => d.measuredOffsetHz))
	let best: readonly Discovery[] = []
	let bestDistance = Number.POSITIVE_INFINITY
	let start = 0
	for (let end = 0; end < usable.length; end++) {
		const hi = usable[end]?.measuredOffsetHz ?? 0
		while ((usable[start]?.measuredOffsetHz ?? hi) < hi - FREQ_ERROR_AGREE_HZ)
			start++
		const window = usable.slice(start, end + 1)
		const distance = Math.abs(
			median(window.map(d => d.measuredOffsetHz)) - overall,
		)
		if (
			window.length > best.length ||
			(window.length === best.length && distance < bestDistance)
		) {
			best = window
			bestDistance = distance
		}
	}
	if (best.length < FREQ_ERROR_MIN_DECODES) return null
	const hz = median(best.map(d => d.measuredOffsetHz))
	const centreHz = median(best.map(d => d.frequencyHz))
	return { hz, ppm: centreHz > 0 ? (hz / centreHz) * 1e6 : 0, n: best.length }
}
