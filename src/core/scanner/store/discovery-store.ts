/**
 * Discovery store (spec § 7): turns observations into deduplicated discoveries.
 *
 * Association per observation (§ 7.2): sticky (nearest discovery in tolerance whose effective
 * family matches; an observation with no evidence yet also matches a decoded discovery), then the
 * fixed frequency key with the co-channel rules 2–4. A track is first placed only when
 * `track.gate` is `passed` (an absent gate is pending), or when an accepted identity decode for
 * it is being applied: a short burst (AIS, VDL2, LoRa) never passes the burst gate, and a decode
 * proves it is not noise. A placed observation keeps re-ingesting whatever a later gate says.
 * Protocol and confidence come from `labelFromEvidence`, never from a hypothesis. Confidence is
 * monotone, except a leak/intermod cap recorded before a decode. Every mutation emits one journal
 * entry whose payload holds the resulting records, so replay is an idempotent upsert.
 */
import {
	ANCHOR_AIRCRAFT_WINDOW_MS,
	ANCHOR_AIRCRAFT_MAX,
	canAnchor,
	decodeAnchorKey,
	newDecodeAnchor,
} from "./decode-anchor.js"
import { ADSB_HZ } from "../probes/confirm/readsb.js"
import { isDsdFmeProtocol } from "../probes/confirm/dsd-fme.js"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { WaveKitError } from "../../../utils/errors.js"
import { createComponentLogger, createLogger } from "../../../utils/logger.js"
import type { Logger } from "../../../utils/logger.js"
import type { LockoutTarget } from "../plan/lockouts.js"
import {
	frequencyKey,
	gridToleranceHz,
	rasterToleranceHz,
	snapToRaster,
} from "../bandplan/index.js"
import {
	DISCOVERY_MERGED_IDS_MAX,
	SCANNER_AMBIENT_TARGET_TOLERANCE_HZ,
	DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
	type BandRegion,
	type ScannerProbeDecoderType,
} from "@wavekit/api-types"
import { familyOf } from "../classify/classifier.js"
import { hintOf } from "../classify/hint.js"
import {
	UNKNOWN_LABEL,
	acceptedAnalogEvidence,
	identityFitsProtocol,
	knownProtocol,
	labelAndFacts,
	labelFromEvidence,
} from "../classify/label-from-evidence.js"
import type {
	EvidenceLabel,
	ProofFacts,
} from "../classify/label-from-evidence.js"
import {
	evidenceLevelOf,
	proofFromFacts,
	strongestKnownProof,
} from "../proof.js"
import type {
	DiscoveryNearQuery,
	ObservationEvidenceSink,
	ProofAnalogInput,
	ProofDecodeInput,
	ProofInput,
	ProofTrialInput,
} from "../scanner-redesign-contract.js"
import {
	PROOF_ANALOG_MAX_PER_OBSERVATION,
	PROOF_TRIALS_MAX_PER_OBSERVATION,
} from "../scanner-redesign-contract.js"
import { CONFIDENCE_RANK } from "../types.js"
import type {
	Classification,
	ConfidenceCap,
	DecodeEvidence,
	DiscoveryMetadata,
	Identity,
	Observation,
	ObservationInput,
	ProtocolFamily,
	ScannerClass,
	ScannerConfidence,
	ScannerEvidenceLevel,
	ScannerHint,
	ScannerProof,
	ScannerProtocol,
	ScanRange,
	SignalStats,
	StoredObservation,
} from "../types.js"
import type { Raster, TrackSnapshot } from "../../spectrum/types.js"
import { parseStoreMutation } from "./schemas.js"
import type { StoredDiscovery as Discovery, StoreMutation } from "./schemas.js"
import { RecordingAliasTable } from "../recording-aliases.js"
import { DISCOVERY_RECORDING_ALIASES_MAX } from "../../recordings/contract.js"
import type { DiscoveryAliasEntry } from "../recording-aliases.js"
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
import { CentreIndex, FrequencyIndex } from "./frequency-index.js"
import type { IndexedCentre } from "./frequency-index.js"
import { JobCounts } from "./job-counts.js"
import type { ConfidenceCounts } from "./job-counts.js"
import type { StoreMirrorRemoval } from "./mirror-sink.js"
import { PendingAdmission, admissionSnrOf } from "./pending-admission.js"
import {
	DQ_CO_CHANNEL_MAX,
	DQ_CONSOLIDATE_GROUP_MAX,
	DQ_CONSOLIDATE_SCAN_MAX,
	DQ_CREATE_SNR_DB,
	DQ_CREATE_TRACK_SNR_DB,
	DQ_SHORT_BURST_BLOCKS,
	DQ_CROSS_FAMILY_HZ,
	DQ_IDENTITY_OVERLAP_MS,
	DQ_IDENTITY_PROTOCOLS,
	DQ_IDENTITY_SPLIT_MAX_HZ,
	DQ_IDENTITY_SPLIT_MIN_HZ,
	DQ_IDENTITY_WEAKER_DB,
	DQ_LOCAL_SNR_DB,
	DQ_MIN_HISTORY_OBS,
	DQ_OBW_RATIO_MAX,
	DQ_OVERLOAD_CREATE_SNR_DB,
	DQ_YOUNG_OBW_RATIO,
} from "../detection-quality-contract.js"
import {
	compatible,
	compatibleValues,
	recordsCompatible,
} from "./compatibility.js"
import {
	inObwBand,
	joinable,
	planConsolidation,
	rankCompare,
} from "./consolidation.js"
import type {
	ConsolidationGroup,
	ConsolidationPlan,
	ConsolidationRecord,
	PlanProbe,
} from "./consolidation.js"
import type { CompatibilitySide } from "./compatibility.js"
import { AbsorbedIdIndex } from "./absorbed-id-index.js"
import {
	FRAGMENT_GROUPS_MAX,
	FRAGMENT_FOLD_CHECK_MAX,
	FRAGMENT_RETIRE_MAX,
	FRAGMENT_ROUNDS_MAX,
	planFragments,
	planRetirement,
} from "./fragment-retirement.js"
import type { FragmentPlan, FragmentRecord } from "./fragment-retirement.js"

export { labelFromEvidence } from "../classify/label-from-evidence.js"
export type { EvidenceLabel } from "../classify/label-from-evidence.js"

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
	/** `proven` / `weak` keep that DTO level; `all` and absent keep both. */
	evidence?: "proven" | "weak" | "all"
	/** Inclusive |Δf| window. `toleranceHz` defaults to 6 250 and is ignored without this. */
	nearHz?: number
	toleranceHz?: number
}
/** Optional context for `ingest`. */
export interface IngestOptions {
	/**
	 * Accepted decode the caller is about to append to this observation. With
	 * a CRC-clean identity that fits its protocol, in the track's epoch, it
	 * places a track whose gate has not passed.
	 */
	decode?: DecodeEvidence
}

/** True when `ev` is an accepted identity decode for this track (it is not noise). */
function decodeProvesSignal(
	input: ObservationInput,
	ev: DecodeEvidence | undefined,
): boolean {
	try {
		return (
			ev !== undefined &&
			ev.crcClean === true &&
			ev.identity !== undefined &&
			ev.epoch === input.track.epoch &&
			identityFitsProtocol(ev.protocol, ev.identity)
		)
	} catch {
		// A throwing getter or proxy proves nothing.
		return false
	}
}

export interface DiscoveryStoreOptions {
	maxDiscoveries: number
	now: () => number
	newId: () => string
	minSurfaceBlocks?: number
	rasters?: (sourceId: string, centreHz: number) => Raster[]
	/**
	 * (DQ 1.16): channel rasters at a centre (the band plans' rasters while passive
	 * runs). An observation off every `rasters` tolerance keys to the nearest of these
	 * channels instead of a grid key. Absent: grid keys, as before.
	 */
	channelRasters?: (sourceId: string, centreHz: number) => Raster[]
	/** WG9 req 2.6: inactive prune and capacity eviction skip a discovery holding kept recordings. */
	discoveryHoldsKept?: (discoveryId: string) => boolean
	/** WG9 R2: the eviction-blocked-by-kept warning; a module-level fallback logger without one. */
	logger?: Logger
	/** Scanner-redesign 3.11: region and effective ranges read when a weak record is presented. */
	hintScope?: () =>
		| { region: BandRegion; ranges: readonly ScanRange[] }
		| undefined
}

/** Created on first need only, so a store that never logs creates no logger. */
let fallbackLog: Logger | null = null
export type RecordingLinkState = "linked" | "cut" | "encrypted-dropped" | "none"
export interface StoreSnapshot {
	discoveries: Discovery[]
	observations: Observation[]
	corrections: { sourceId: string; hz: number }[]
	recordingOperations?: PreparedRecordingMetadata[]
	/** WG10 req 1.5: merge aliases per survivor (absent in state written before WG10). */
	aliases?: DiscoveryAliasEntry[]
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
 * joining a placed observation).
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
/** Weak records publish unknown, except an explicit, unverified digital-voice sync hint. */
function syncOnlyProof(proof: ScannerProof | null): boolean {
	return (
		proof !== null &&
		proof.kind === "digital-undecoded" &&
		isDsdFmeProtocol(proof.protocol)
	)
}
function publishedOf(view: DiscoveryProofView): EvidenceLabel {
	return (view.evidence === "proven" || syncOnlyProof(view.proof)) &&
		view.proof !== null
		? view.label
		: UNKNOWN_LABEL
}
/** The classifier's burst limit (scanner-redesign 3.11 `short`). */
const SHORT_TRACK_BLOCKS = 4
const LINKS_MAX = 64
const NO_LINKS: readonly string[] = []
/** Per-discovery observation window (WG11: exported for the snapshot mirror). */
export const OBSERVATIONS_PER_DISCOVERY = 256
const OBSERVATION_DECODE_MAX = 16
const MEDIAN_WINDOW = 64
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
	/**
	 * Moved observations the destination window trimmed before `finish`. They
	 * are not in the index, so the journal has to carry the moved record itself
	 * and name the removal.
	 */
	trimmedMoves: Observation[]
	correction?: { sourceId: string; hz: number }
	/** WG10 req 1.5: owners whose alias list this op changed (journaled as written). */
	aliases: Set<string>
	/**
	 * Observation id → the discovery it was placed in and the job ids newly credited (WG2 req 13.1).
	 * Recorded at placement, so neither observation retention nor a later listener can lose it.
	 */
	credited: Map<string, { discoveryId: string; jobIds: string[] }>
}

/** Band inspection UX req 3.3: an opaque epoch, unique per store start (time plus 32 random bits). */
function newStoreEpoch(): string {
	return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`
}

function newOp(): Op {
	return {
		discoveries: new Set(),
		observations: new Set(),
		deleted: [],
		changes: new Map(),
		merged: [],
		removedObservations: [],
		trimmedMoves: [],
		aliases: new Set(),
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
/**
 * WG11 req 3.4: a detached deep copy of plain record data (objects, arrays, scalars), members
 * holding `undefined` left out, so its JSON text is the original's. About 5× cheaper than
 * `structuredClone` and 2.5× cheaper than a JSON round trip on a journal payload.
 */
function plainCopy<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value
	if (Array.isArray(value)) {
		const out: unknown[] = new Array<unknown>(value.length)
		for (let i = 0; i < value.length; i++)
			out[i] = plainCopy(value[i] as unknown)
		return out as T
	}
	const out: Record<string, unknown> = {}
	const record = value as Record<string, unknown>
	for (const k in record) {
		if (!Object.hasOwn(record, k)) continue
		const v = record[k]
		if (v !== undefined) out[k] = plainCopy(v)
	}
	return out as T
}

/** A value as `JSON.stringify` writes it inside an array: non-finite numbers and nothing become null. */
function jsonValue(v: unknown): unknown {
	if (typeof v === "number") return Number.isFinite(v) ? v : null
	if (v === undefined || typeof v === "function" || typeof v === "symbol")
		return null
	return v
}

/** Keys `JSON.stringify` writes, in order. */
function jsonKeys(o: object): string[] {
	const out: string[] = []
	for (const [k, v] of Object.entries(o))
		if (v !== undefined && typeof v !== "function" && typeof v !== "symbol")
			out.push(k)
	return out
}

/**
 * WG11 req 3.4: `JSON.stringify(a) === JSON.stringify(b)` for plain data (records, evidence), without
 * building either string: same key order, undefined members skipped, non-finite numbers as null.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
	const x = jsonValue(a)
	const y = jsonValue(b)
	if (x === y) return true
	if (
		typeof x !== "object" ||
		typeof y !== "object" ||
		x === null ||
		y === null
	)
		return false
	if (Array.isArray(x) || Array.isArray(y)) {
		if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length)
			return false
		for (let i = 0; i < x.length; i++) if (!jsonEqual(x[i], y[i])) return false
		return true
	}
	const kx = jsonKeys(x)
	const ky = jsonKeys(y)
	if (kx.length !== ky.length) return false
	const ox = x as Record<string, unknown>
	const oy = y as Record<string, unknown>
	for (let i = 0; i < kx.length; i++) {
		const k = kx[i] as string
		if (k !== ky[i] || !jsonEqual(ox[k], oy[k])) return false
	}
	return true
}

const sameList = <T>(a: readonly T[], b: readonly T[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i])

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

/** DQ 7.1: any operator field set (label, notes, lockout, keep). */
function hasOperatorState(d: Discovery): boolean {
	const op = d.operator
	return (
		op !== undefined &&
		(op.label !== undefined ||
			op.notes !== undefined ||
			op.lockout !== undefined ||
			op.keep !== undefined)
	)
}

function sameIdentity(
	a: Identity | undefined,
	b: Identity | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b
	// DQ 9.8: a malformed identity is different from every other identity.
	if (!wellFormedIdentity(a) || !wellFormedIdentity(b)) return false
	return a.kind === b.kind && a.value === b.value
}

function wellFormedIdentity(x: Identity): boolean {
	const v = x as { kind?: unknown; value?: unknown } | null
	return v !== null && typeof v.kind === "string" && typeof v.value === "string"
}

/** DQ 9.5: the protocol an ingest decode names, or undefined (malformed or not CRC-clean). */
function decodeProtocolOf(ev: DecodeEvidence | undefined): string | undefined {
	try {
		if (ev === undefined || ev.crcClean !== true) return undefined
		const p: unknown = ev.protocol
		return typeof p === "string" ? p : undefined
	} catch {
		return undefined
	}
}

/** No trial evidence yet. Analog and the digital plan arrive with the evidence sink. */
function emptyProof(obs: ObservationInput): ProofInput {
	return {
		observationId: obs.id,
		decodes: [],
		trials: [],
		analog: [],
		unavailable: [],
		trust: obs.track.tuningTrust,
		digitalPlanComplete: false,
	}
}

const TRIAL_OUTCOMES = new Set<string>([
	"pending",
	"running",
	"decoded",
	"no-sync",
	"crc-errors",
	"timeout",
	"skipped-budget",
	"unsupported",
	"not-needed",
	"cancelled",
	"heard",
	"data-like",
	"carrier-only",
])

const PROBE_DECODERS = new Set<string>([
	"acarsdec",
	"dumpvdl2",
	"lora-meshtastic",
	"direwolf",
	"dsd-fme",
	"multimon-ng",
	"rtl433",
])

interface EvidenceBag {
	trials: ProofTrialInput[]
	analog: ProofAnalogInput[]
	unavailable: ScannerProbeDecoderType[]
}

/**
 * Persisted decode → proof input. Ambient origin stays ambient. A probe
 * decode marked `transport: "replay"` is replay. Every other probe decode,
 * including a legacy row with no transport, is live.
 */
function decodeRow(ev: DecodeEvidence): ProofDecodeInput | undefined {
	try {
		ev = checkedDecode(ev)
		if (ev.crcClean !== true) return undefined
		if (!knownProtocol(ev.protocol) || ev.protocol === "unknown")
			return undefined
		if (typeof ev.at !== "number" || !Number.isFinite(ev.at)) return undefined
		const row: ProofDecodeInput = {
			protocol: ev.protocol,
			transport:
				ev.origin === "ambient"
					? "ambient"
					: ev.transport === "replay"
						? "replay"
						: "live",
			at: ev.at,
			encrypted: ev.encrypted === true,
		}
		if (ev.unverifiedCc !== undefined) row.unverifiedCc = ev.unverifiedCc
		if (
			ev.protocol === "dmr" &&
			ev.contentVerified === true &&
			ev.metadata.talkgroups?.length &&
			ev.metadata.sources?.length
		)
			row.tgSrcVerified = true
		if (ev.identity !== undefined)
			row.identity = { kind: ev.identity.kind, value: ev.identity.value }
		const talkgroup = ev.metadata.talkgroups?.[0]
		if (typeof talkgroup === "string") row.talkgroup = talkgroup
		return row
	} catch {
		return undefined
	}
}

/** Normalize old/unchecked dsd-fme content at both live and persistence boundaries. */
function checkedDecode(ev: DecodeEvidence): DecodeEvidence {
	if (!isDsdFmeProtocol(ev.protocol) || ev.contentVerified === true) return ev
	const { identity, callId: _callId, encrypted: _encrypted, ...rest } = ev
	const cc =
		identity?.kind === "dmr-cc" && /^(?:[0-9]|1[0-5])$/.test(identity.value)
			? Number(identity.value)
			: ev.unverifiedCc
	return {
		...rest,
		contentVerified: false,
		metadata: {},
		...(cc !== undefined ? { unverifiedCc: cc } : {}),
	}
}

const DIGITAL_FAILURE = new Set<string>(["no-sync", "crc-errors", "timeout"])

function isAnalogDecoder(decoder: string): boolean {
	return decoder === "analog-demod" || decoder === "live-audio"
}

/**
 * A data-like analog outcome, no decoded digital trial, and every digital
 * trial either ran and failed (`no-sync`, `crc-errors`, `timeout`) or is
 * `unsupported` because its decoder is in `unavailable`. Pending, running,
 * skipped-budget and cancelled trials are not finished failures. No digital
 * trial and no unavailable decoder is not a completed plan. No digital trial
 * with at least one unavailable decoder is the no-decoder case.
 */
function digitalPlanCompleteOf(
	analog: readonly ProofAnalogInput[],
	trials: readonly ProofTrialInput[],
	unavailable: readonly string[],
): boolean {
	let dataLike = false
	for (const row of analog) {
		if (row.outcome === "data-like") dataLike = true
	}
	if (!dataLike) return false
	const missing = new Set(unavailable)
	let digital = 0
	for (const trial of trials) {
		if (trial.outcome === "pending" || trial.outcome === "running") return false
		if (isAnalogDecoder(trial.decoder)) continue
		digital += 1
		const outcome = trial.outcome
		if (outcome === "decoded") return false
		if (outcome === "skipped-budget" || outcome === "cancelled") return false
		if (DIGITAL_FAILURE.has(outcome)) continue
		if (outcome === "unsupported" && missing.has(trial.decoder)) continue
		return false
	}
	if (digital === 0 && missing.size === 0) return false
	return true
}

function acceptTrial(row: ProofTrialInput): ProofTrialInput | undefined {
	try {
		const protocol = row.protocol
		const decoder = row.decoder
		const outcome = row.outcome
		const order = row.order
		const at = row.at
		if (!knownProtocol(protocol) || protocol === "unknown") return undefined
		if (typeof decoder !== "string" || decoder.length === 0) return undefined
		if (typeof outcome !== "string" || !TRIAL_OUTCOMES.has(outcome))
			return undefined
		if (typeof order !== "number" || !Number.isFinite(order)) return undefined
		if (typeof at !== "number" || !Number.isFinite(at)) return undefined
		return { protocol, decoder, outcome, order, at }
	} catch {
		return undefined
	}
}

function digitalFamily(family: ProtocolFamily): boolean {
	return (
		family === "digital-voice" ||
		family === "pager" ||
		family === "packet" ||
		family === "ism"
	)
}

/** Analog and a digital family cannot share one discovery. Unknown and carrier can. */
function familiesIncompatible(a: ProtocolFamily, b: ProtocolFamily): boolean {
	if (a === "unknown" || b === "unknown" || a === "carrier" || b === "carrier")
		return false
	return (
		(a === "analog" && digitalFamily(b)) || (b === "analog" && digitalFamily(a))
	)
}

/**
 * DQ 9.1, 9.8: the association family of a label. Its family when decoded, identified or proven;
 * `unknown` otherwise (an unreadable level or confidence is neither proven nor decoded).
 */
function associationOf(
	label: EvidenceLabel,
	identity: Discovery["identity"],
	evidence: ScannerEvidenceLevel,
): ProtocolFamily {
	return label.confidence === "decoded" ||
		identity !== undefined ||
		evidence === "proven"
		? label.family
		: "unknown"
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

function signalOf(o: Observation): SignalStats {
	return {
		peakDbfs: o.peakDbfs,
		meanDbfs: o.meanDbfs,
		snrDb: o.snrDb,
		floorDbfs: o.floorDbfs,
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

/**
 * Derived discovery proof plus the level and DTO label published from it.
 * All three are filled in one validation and dropped with this entry.
 */
interface DiscoveryProofView {
	proof: ScannerProof | null
	evidence: ScannerEvidenceLevel
	label: EvidenceLabel
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

interface IndexedDiscovery {
	/** Effective family. A sink proof can move this without writing `Discovery.family`. */
	family: ProtocolFamily
	/** Effective confidence is `decoded`, so an evidence-less observation can stick to it. */
	decoded: boolean
	centre: number
	frequencyHz: number
	key: string
	sources: string[]
}

/**
 * Centre-index family for decoded discoveries of every effective family.
 * Not a `ProtocolFamily`. An evidence-less observation searches this list
 * as well as the `unknown` list.
 */
const DECODED_CENTRE_FAMILY = "\u0001"

/** DQ 2.1: every effective family a centre list can hold (fixed, under 16). */
const CENTRE_FAMILIES: readonly ProtocolFamily[] = [
	"analog",
	"digital-voice",
	"pager",
	"packet",
	"ism",
	"carrier",
	"unknown",
]

/**
 * WG11 req 3.2 and DQ 3.1, 3.4: one pass over a discovery's last 64 observations. `count` is the
 * window length; `majority` is the majority non-edge, non-unknown class (ties: the most recent
 * of the tied classes), undefined when nothing voted.
 */
interface Medians {
	centre: number
	obw: number
	/** DQ 9.2: smallest and largest finite OBW of the window; NaN when none is finite. */
	obwMin: number
	obwMax: number
	peak: number
	count: number
	majority: ScannerClass | undefined
}

const voteOf = (o: Observation): ScannerClass | undefined =>
	(o as StoredObservation).classVote

const sideOf = (m: Medians): CompatibilitySide => ({
	peakDbfs: m.peak,
	obwHz: m.obw,
	count: m.count,
})

export class DiscoveryStore
	extends EventEmitter
	implements ObservationEvidenceSink, DiscoveryNearQuery
{
	private maxDiscoveries: number
	private readonly now: () => number
	/** DQ 1.4: weak undecoded candidates, memory only. */
	private readonly pending: PendingAdmission
	private lastPendingSweep = Number.NEGATIVE_INFINITY
	private readonly newId: () => string
	/** Accepted for the frame display role (R 2.5). Creation follows `track.gate`. */
	private minSurfaceBlocks: number
	private readonly rastersFor: (sourceId: string, centreHz: number) => Raster[]
	private readonly channelRastersFor: (
		sourceId: string,
		centreHz: number,
	) => Raster[]
	private readonly discoveries = new Map<string, Discovery>()
	private anchorExpiryEnabled = true
	private readonly anchorExpiry = new Map<
		string,
		ReturnType<typeof setTimeout>
	>()
	private readonly anchorWindows = new Map<string, Map<string, number>>()
	/** Latest confirmations stay private until publishAnchor commits a revision. */
	private readonly anchorPending = new Map<
		string,
		{
			count: number
			seen: string
			observations: number
			trust: "commanded" | "relay"
		}
	>()
	private readonly anchorPublished = new Map<
		string,
		{
			at: number
			count: number
			bucket: number
			seen: string
			observations: number
		}
	>()
	private readonly decodeAnchors = new Map<string, string>()
	/** Set by `applyEvidenceTo` when evidence passed its checks and was stored (see `applyEvidenceResult`). */
	private evidenceAccepted = false
	private readonly observationIndex = new Map<string, Observation>()
	private readonly byDiscovery = new Map<string, Observation[]>()
	private readonly bySource = new Map<string, Set<string>>()
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

	private readonly holdsKept: (discoveryId: string) => boolean
	private readonly injectedLog: Logger | undefined
	/** The kept-blocked count last warned, so a full store does not warn on every ingest. */
	private keptBlockedWarned = 0
	/** WG10 req 1.5: merge aliases (O(1) owner lookup). */
	private readonly aliasTable = new RecordingAliasTable()
	/** Band inspection UX req 3.1: absorbed id -> survivor, in memory only. */
	private readonly absorbedIndex = new AbsorbedIdIndex()
	/** DQ 10.6: where the next fragment pass resumes examining candidates (memory only). */
	private fragmentCursor: string | undefined
	/**
	 * Band inspection UX req 3.3: the public revision. One store-wide counter, bumped once per
	 * published change (an operation, a proof change, a recording commit); every record that
	 * change touched takes the new value, so a record's revision strictly increases. Memory only:
	 * the epoch is new on every start (and restore), so a client never compares across restarts.
	 * A record unchanged since the start reads revision 1. The counter is a JS number: at a
	 * million changes a second it reaches Number.MAX_SAFE_INTEGER (about 9.0e15) after some 285
	 * years.
	 */
	private revisionSeq = 1
	private readonly published = new Map<string, number>()
	private epoch = newStoreEpoch()
	/**
	 * WG11 req 3.1-3.4 (lane SC). `revisions`: bumped by the mutating helpers only when a value the
	 * record's JSON holds changes, so "no change" needs no before/after stringify. `members` mirrors
	 * `bySource` membership per discovery; the centre and key indexes hold exactly the existing
	 * discoveries under those sources. Helpers mark ids dirty; the indexes and counts catch up at
	 * their next read and at the end of every journal entry, replay and restore, so the dirty sets
	 * stay small.
	 */
	private readonly revisions = new WeakMap<Discovery, number>()
	/** Median centre and OBW over a discovery's last 64 observations (only while it has one). */
	private readonly medians = new Map<string, Medians>()
	/** DQ 2.3: partners pruned for distance, per record (memory only), for the re-link. */
	private readonly unlinked = new Map<string, Set<string>>()
	/** DQ 2.3: ids whose `coChannel` a prune changed; `finish` journals them. */
	private readonly linkTouched = new Set<string>()

	private readonly members = new Map<string, Set<string>>()
	private readonly centres = new CentreIndex()
	/**
	 * Decoded discoveries, every effective family, keyed by source. Sticky
	 * association of an evidence-less observation reads this in one window.
	 */
	private readonly decodedCentres = new CentreIndex()
	/** `frequencyHz` spans. Near reads this; the centre index stays the sticky median. */
	private readonly frequencies = new FrequencyIndex()
	/**
	 * Discoveries with a retained decode or sink bag on one of their own
	 * observations. Co-channel partners consult this instead of scanning.
	 */
	private readonly proofBearing = new Set<string>()
	private readonly byKey = new Map<string, Set<string>>()
	private readonly indexed = new Map<string, IndexedDiscovery>()
	private readonly indexDirty = new Set<string>()
	private readonly countsDirty = new Set<string>()
	private readonly jobCounts = new JobCounts()
	private removal: StoreMirrorRemoval = { discoveries: [], observations: [] }
	/** Monotonic trial order. Not cleared on restore and not written to disk. */
	private trialOrder = 0
	/** Trial, analog and unavailable evidence. Memory only, keyed by observation id. */
	private readonly evidenceByObservation = new Map<string, EvidenceBag>()
	/** Derived observation proof. Dropped when that observation's evidence changes. */
	private readonly observationProofCache = new Map<
		string,
		{ proof: ScannerProof | null; label: EvidenceLabel }
	>()
	/**
	 * Strongest attributed proof, the level validated for it, and the DTO label
	 * that level publishes. Dropped for co-channel readers of a changed source.
	 * A derived proof is validated once, when the entry is cached.
	 */
	private readonly proofCache = new Map<string, DiscoveryProofView>()
	/**
	 * Discoveries whose proof reads this discovery's observations: they list it
	 * in `coChannel`. Bounded by the co-channel cap and cleared on removal.
	 */
	private readonly proofWatchers = new Map<string, Set<string>>()
	/** Partner ids last indexed for a discovery, so a co-channel edit can unlink them. */
	private readonly proofWatched = new Map<string, readonly string[]>()
	/** Co-channel proofs captured before a source changed, emitted once if the result differs. */
	private pendingProof = new Map<string, ScannerProof | null>()
	/** Replay and restore drop caches without publishing a sink change. */
	private proofQuiet = 0

	private readonly hintScope: DiscoveryStoreOptions["hintScope"]

	constructor(opts: DiscoveryStoreOptions) {
		super()
		this.hintScope = opts.hintScope
		this.injectedLog = opts.logger
			? createComponentLogger(opts.logger, "DiscoveryStore")
			: undefined
		this.maxDiscoveries = opts.maxDiscoveries
		this.now = opts.now
		this.pending = new PendingAdmission(opts.now)
		this.newId = opts.newId
		this.minSurfaceBlocks = opts.minSurfaceBlocks ?? 2
		this.rastersFor = opts.rasters ?? (() => [])
		this.channelRastersFor = opts.channelRasters ?? (() => [])
		const holds = opts.discoveryHoldsKept
		// Fail closed: a throwing port answers "holds kept".
		this.holdsKept = holds
			? id => {
					try {
						return holds(id) !== false
					} catch {
						return true
					}
				}
			: () => false
	}

	/**
	 * `passed` (or `opts.decode`, see `IngestOptions`) is required only on first
	 * placement. A known observation re-ingests whatever a later snapshot's gate
	 * says, so evidence that follows still finds its discovery.
	 */
	ingest(input: ObservationInput, opts: IngestOptions = {}): Ingested {
		this.sweepPendingIfDue()
		const flagged = this.rememberStickyFlags(input) // may be raised late (P3, § 4.9)
		// DQ 1.4: a flagged observation's pending evidence stops counting.
		if (flagged) this.pending.forget(input.sourceId, input.id)
		const known = this.observationIndex.get(input.id)
		if (known !== undefined) {
			if (flagged) return this.retract(known)
			return this.reingest(known, input)
		}
		if (flagged) return TRANSIENT
		if (input.jobIds.length === 0) return TRANSIENT
		if (
			input.track.gate !== "passed" &&
			!decodeProvesSignal(input, opts.decode)
		)
			return TRANSIENT
		const label = labelFromEvidence(emptyProof(input))
		const decodedAs = decodeProtocolOf(opts.decode)
		const sticky = this.stickyMatch(
			input,
			label.family,
			!decodeProvesSignal(input, opts.decode),
			decodedAs,
		)
		if (sticky !== undefined)
			return this.commit("observation", op =>
				this.addObservation(
					op,
					this.lazyConsolidate(op, sticky, input, decodedAs),
					input,
				),
			)
		const place = this.placement(
			input.sourceId,
			input.track.centreHz,
			input.track.obwHz,
		)
		const target = this.keyTarget(
			input.sourceId,
			place.key,
			label.family,
			input.classification.class,
			input,
			decodedAs,
			!decodeProvesSignal(input, opts.decode),
		)
		const into = target.merge
		if (into !== null)
			return this.commit("observation", op =>
				this.addObservation(op, into, input),
			)
		const admission = decodeProvesSignal(input, opts.decode)
			? "create"
			: this.admits(input)
		if (admission === "refuse") return TRANSIENT
		const created = this.createFrom(input, label, target.coChannel)
		// A threshold, overload or decode create consumes the bucket's entry. A promotion
		// already deleted the one entry it selected; consuming again could take a neighbour.
		// Any create clears the channel's push-to-talk airtime (1.4d): banked credit must not
		// outlive the record it helped make.
		if (created.discoveryId !== null) {
			if (admission === "create") this.pending.consume(input)
			else this.pending.consumeAirtime(input)
		}
		return created
	}

	/** One timer per anchor handles expiry and a pending publication. Window entries are
	 * insertion ordered by latest confirmation; refreshing an address is O(1). */
	startAnchorExpiry(): void {
		this.anchorExpiryEnabled = true
		for (const id of this.decodeAnchors.values()) this.scheduleAnchorExpiry(id)
	}

	stopAnchorExpiry(): void {
		this.anchorExpiryEnabled = false
		for (const id of this.decodeAnchors.values()) this.publishAnchor(id, true)
		for (const timer of this.anchorExpiry.values()) clearTimeout(timer)
		this.anchorExpiry.clear()
	}

	private publishAnchor(id: string, force = false, created = false): void {
		const d = this.discoveries.get(id)
		const pending = this.anchorPending.get(id)
		if (!d || !pending) return
		const now = this.now()
		const previous = this.anchorPublished.get(id)
		const count = pending.count
		const bucket = Math.floor(Date.parse(pending.seen) / 10_000)
		if (
			previous &&
			previous.count === count &&
			previous.bucket === bucket &&
			(!force ||
				(previous.seen === pending.seen &&
					previous.observations === pending.observations))
		)
			return
		// At most one write / 5 s, plus creation and the final stop flush.
		// Before rate limiting: at most one / 10 s bucket + one / count change.
		if (!force && previous && now - previous.at < 5_000) return
		this.anchorPublished.set(id, {
			at: now,
			count,
			bucket,
			seen: pending.seen,
			observations: pending.observations,
		})
		this.commit("observation", op => {
			d.aircraftCount = pending.count
			d.lastSeenAt = pending.seen
			d.observationCount = pending.observations
			d.tuningTrust = pending.trust
			const observation = this.observationIndex.get(`decode:${id}`)
			if (observation) observation.endedAt = pending.seen
			this.invalidateLabel(id)
			this.touch(d)
			op.discoveries.add(id)
			op.observations.add(`decode:${id}`)
			mark(op, id, created ? "created" : "updated")
			return id
		})
	}

	private scheduleAnchorExpiry(id: string, created = false): void {
		const previous = this.anchorExpiry.get(id)
		if (previous) clearTimeout(previous)
		this.anchorExpiry.delete(id)
		const d = this.discoveries.get(id)
		if (!d) return
		const rows = this.anchorWindows.get(id)
		const now = this.now()
		if (rows)
			for (const [address, at] of rows) {
				if (at + ANCHOR_AIRCRAFT_WINDOW_MS >= now) break
				rows.delete(address)
			}
		const pending = this.anchorPending.get(id)
		if (!pending) return
		pending.count = rows?.size ?? 0
		this.publishAnchor(id, false, created)
		if (!this.anchorExpiryEnabled) return
		const oldest = rows?.values().next().value
		let next =
			oldest === undefined ? Infinity : oldest + ANCHOR_AIRCRAFT_WINDOW_MS + 1
		const published = this.anchorPublished.get(id)
		if (
			published &&
			(published.count !== pending.count ||
				published.bucket !== Math.floor(Date.parse(pending.seen) / 10_000))
		)
			next = Math.min(next, published.at + 5_000)
		if (!Number.isFinite(next)) return
		const timer = setTimeout(
			() => {
				this.anchorExpiry.delete(id)
				this.scheduleAnchorExpiry(id)
			},
			Math.max(1, Math.min(2_147_483_647, next - now)),
		)
		timer.unref()
		this.anchorExpiry.set(id, timer)
	}

	decodeAnchorFor(sourceId: string, hz: number): Discovery | undefined {
		if (
			!Number.isFinite(hz) ||
			Math.abs(hz - ADSB_HZ) > SCANNER_AMBIENT_TARGET_TOLERANCE_HZ
		)
			return undefined
		const id = this.decodeAnchors.get(
			decodeAnchorKey(sourceId, "adsb", ADSB_HZ),
		)
		return id === undefined ? undefined : this.get(id)
	}

	/** Canonical destination for confirmed, trusted decode-anchored protocols. */
	anchorDecode(
		sourceId: string,
		hz: number,
		ev: DecodeEvidence,
		trust: Discovery["tuningTrust"] | undefined,
	): Ingested {
		if (!canAnchor(ev, hz, trust) || !ev.identity) return TRANSIENT
		const existingId = this.decodeAnchors.get(
			decodeAnchorKey(sourceId, ev.protocol, ADSB_HZ),
		)
		let d =
			existingId === undefined ? undefined : this.discoveries.get(existingId)
		if (
			d &&
			ev.at < Date.parse(this.anchorPending.get(d.id)?.seen ?? d.lastSeenAt)
		)
			return { discoveryId: d.id, change: "transient" }
		if (!d) {
			if (!this.makeRoom()) return TRANSIENT
			const fresh = newDecodeAnchor(
				`d_${this.newId()}`,
				sourceId,
				ADSB_HZ,
				ev,
				trust,
			)
			d = fresh.discovery
			this.insertDiscovery(d)
			this.putObservation(fresh.observation)
		}
		const rows = this.anchorWindows.get(d.id) ?? new Map<string, number>()
		this.anchorWindows.set(d.id, rows)
		rows.delete(ev.identity.value.toLowerCase())
		rows.set(ev.identity.value.toLowerCase(), ev.at)
		if (rows.size > ANCHOR_AIRCRAFT_MAX) {
			const first = rows.keys().next()
			if (!first.done) rows.delete(first.value)
		}
		this.anchorPending.set(d.id, {
			count: rows.size,
			seen: iso(ev.at),
			observations:
				(this.anchorPending.get(d.id)?.observations ?? d.observationCount) +
				(existingId === undefined ? 0 : 1),
			trust,
		})
		this.scheduleAnchorExpiry(d.id, existingId === undefined)
		return {
			discoveryId: d.id,
			change: existingId === undefined ? "created" : "updated",
		}
	}

	/**
	 * DQ 1.2 to 1.7: may an undecoded observation that matched nothing create a record? Invalid
	 * input is rejected (1.7); overload needs 25 dB and never pends (1.2); otherwise 18 dB, or
	 * promotion from pending (1.3, 1.4), or a sustained run (1.4b, amendment 10 SC) or channel
	 * airtime over separate transmissions (1.4d), which consume the bucket's pending entry like a
	 * threshold create. A short burst's 18 dB threshold also needs a track SNR of at least 15 dB (1.4c).
	 */
	private admits(input: ObservationInput): "create" | "promoted" | "refuse" {
		const track = input.track
		const snr = admissionSnrOf(track)
		const overload: unknown = (
			track.flags as { overload?: unknown } | undefined
		)?.overload
		// Every refusal also ends the observation's sustained run (DQ 1.4b): a rejected sample
		// never keeps a run alive.
		const refuse = (): "refuse" => {
			this.pending.dropRun(input.sourceId, input.id)
			return "refuse"
		}
		if (
			!Number.isFinite(track.centreHz) ||
			!Number.isFinite(snr) ||
			typeof overload !== "boolean"
		)
			return refuse()
		// DQ 1.15: the DC pedestal and plateaus without local contrast never create. A supplied
		// local SNR must be finite and at least 6 dB; only an absent one (no channel plan, or no
		// neighbour bins) skips the check.
		if (input.dcCentred === true) return refuse()
		const local = track.localSnrDb
		if (
			local !== undefined &&
			!(Number.isFinite(local) && local >= DQ_LOCAL_SNR_DB)
		)
			return refuse()
		if (overload) return snr >= DQ_OVERLOAD_CREATE_SNR_DB ? "create" : refuse()
		// DQ 1.4c: the threshold reads the best of several slot readings; a short burst's own
		// track SNR must also clear the measured noise maximum. Non-finite blocks or track SNR
		// never corroborate (the safe answer: the burst waits for more sightings). An edge track
		// (past the 0.8 usable span, on the passband shoulder) never takes the long-track
		// exemption: its own SNR must clear the noise maximum too, however long it lasts.
		const edge = track.flags.edge === true
		if (
			snr >= DQ_CREATE_SNR_DB &&
			((!edge &&
				Number.isFinite(track.blocks) &&
				track.blocks >= DQ_SHORT_BURST_BLOCKS) ||
				(Number.isFinite(track.snrDb) && track.snrDb >= DQ_CREATE_TRACK_SNR_DB))
		)
			return "create"
		if (this.pending.note(input)) {
			this.pending.dropRun(input.sourceId, input.id)
			return "promoted"
		}
		return this.pending.sustained(input) ? "create" : "refuse"
	}

	/** Refresh-cadence sweep of expired pending entries (at most every 10 s, from ingest). */
	private sweepPendingIfDue(): void {
		const now = this.now()
		if (now - this.lastPendingSweep < 10_000) return
		this.lastPendingSweep = now
		this.pending.sweep(now)
	}

	/** DQ 1.5: retune or source removal drops that source's pending entries; none = all. */
	clearPending(sourceId?: string): void {
		this.pending.clear(sourceId)
	}

	/** DQ 1.5: deletes pending entries whose fixed window has ended. */
	sweepPending(): void {
		this.lastPendingSweep = this.now()
		this.pending.sweep(this.lastPendingSweep)
	}

	/** Pending entries held for a source (tests, diagnostics). */
	pendingCount(sourceId?: string): number {
		return this.pending.size(sourceId)
	}

	/**
	 * Applies CRC-clean decode evidence. `opts.cap` is the leak/intermod cap computed for this decode
	 * (Task 35): it is recorded before the decode, so a capped decode leaves the discovery at `candidate`
	 * (§ 6.2); it is ignored once the discovery is `decoded` (P8). The discovery may be merged away by
	 * `settle()`; use `discoveryIdOf(observationId)` for the survivor. Only evidence that carries an
	 * identity confirms (`decoded`, § 6.6); evidence without one records metadata and `encrypted` and may
	 * only refine the protocol (as a classification does). Evidence whose identity does not fit its
	 * protocol (`identityFitsProtocol`) is ignored entirely: nothing is assigned, routed or journaled.
	 */
	applyEvidence(
		discoveryId: string,
		ev: DecodeEvidence,
		opts: { cap?: ConfidenceCap } = {},
	): StoreChange | null {
		return this.applyEvidenceResult(discoveryId, ev, opts).change
	}

	/**
	 * `applyEvidence` that also says whether the evidence was accepted: it passed every check and
	 * landed on a record (this one or a co-channel twin), even when it changed nothing (`change`
	 * null: a repeat of what the record already holds). Rejected evidence is `accepted: false`.
	 */
	applyEvidenceResult(
		discoveryId: string,
		ev: DecodeEvidence,
		opts: { cap?: ConfidenceCap } = {},
	): { change: StoreChange | null; accepted: boolean } {
		this.evidenceAccepted = false
		try {
			const change = this.applyEvidenceTo(discoveryId, ev, opts)
			return { change, accepted: change !== null || this.evidenceAccepted }
		} finally {
			this.evidenceAccepted = false
		}
	}

	private applyEvidenceTo(
		discoveryId: string,
		ev: DecodeEvidence,
		opts: { cap?: ConfidenceCap },
	): StoreChange | null {
		ev = checkedDecode(ev)
		const d = this.discoveries.get(discoveryId)
		if (d === undefined || d.anchor === "decode" || !ev.crcClean) return null
		if (
			ev.identity !== undefined &&
			!identityFitsProtocol(ev.protocol, ev.identity)
		)
			return null
		if (this.adjacentIdentityCopy(d, ev)) return null
		if (
			ev.identity !== undefined &&
			d.identity !== undefined &&
			!sameIdentity(ev.identity, d.identity)
		) {
			const carry = this.observationToMove(d, ev)
			return carry === undefined
				? this.coChannelEvidence(d, ev, opts.cap)
				: this.coChannelEvidence(d, ev, opts.cap, carry)
		}
		if (d.confidence === "decoded" && ev.protocol !== d.protocol) return null
		const shown = this.effectiveLabel(d)
		// A proof on this discovery already named a family this decode cannot share.
		// The observation that carries it moves onto the linked twin when its own
		// proof is the incompatible one; the sink rows stay memory-only. A family
		// only stored (an identity-less decode, no proof) does not split: the
		// identity decode outranks it, as labelFromEvidence ranks them.
		if (
			ev.identity !== undefined &&
			familiesIncompatible(familyOf(ev.protocol), shown.family) &&
			this.discoveryView(d).proof !== null
		) {
			const carry = this.observationToSplit(d, ev)
			return carry === undefined
				? this.coChannelEvidence(d, ev, opts.cap)
				: this.coChannelEvidence(d, ev, opts.cap, carry)
		}
		// identity-less evidence it does not adopt from another family belongs to a co-channel emitter: its
		// talkgroups or encrypted flag would land on, e.g., an analog discovery
		if (
			ev.identity === undefined &&
			!moreSpecific(shown.protocol, ev.protocol) &&
			familyOf(ev.protocol) !== shown.family &&
			shown.family !== "unknown"
		)
			return null
		const before = this.revision(d)
		const beforeRank = rank(d.confidence)
		this.capInto(d, opts.cap)
		this.decodeInto(d, ev)
		this.evidenceAccepted = true
		// Drop the cached proof after the identity and cap are stored, so the one
		// change below is the only publication and readers see the capped label.
		this.invalidateLabel(d.id)
		if (this.revision(d) === before) return null
		const op = newOp()
		op.discoveries.add(d.id)
		mark(op, d.id, rank(d.confidence) > beforeRank ? "upgraded" : "updated")
		const id = this.settle(op, d)
		this.finish("evidence", op)
		return op.changes.get(id) ?? "updated"
	}

	/**
	 * DQ 2.4: true only when `ev` is a digital-voice decode carrying a radio source id (talker id,
	 * `metadata.sources`) that another record of the same source already lists for the same
	 * protocol, 6 to 30 kHz away (median centres), overlapping in time within 2 s, and `d` is at
	 * least 10 dB weaker (median peaks). Channel identities (colour code, NAC, DG-ID) are shared
	 * by every radio on a system and never count. A decode without a source id, or any missing or
	 * non-finite input, is false, so the decode applies as before. Per decode, not per frame.
	 */
	private adjacentIdentityCopy(d: Discovery, ev: DecodeEvidence): boolean {
		if (!DQ_IDENTITY_PROTOCOLS.includes(ev.protocol)) return false
		const talkers = (ev.metadata.sources ?? []).filter(
			x => typeof x === "string" && x.length > 0,
		)
		if (talkers.length === 0) return false
		const sourceId = d.sourceIds[0]
		const own = this.mediansOf(d.id)
		const carry = this.carryingObservation(d, ev)
		if (sourceId === undefined || own === undefined || carry === undefined)
			return false
		const start = Date.parse(carry.startedAt)
		const end = Date.parse(carry.endedAt ?? carry.startedAt)
		if (
			!Number.isFinite(own.centre) ||
			!Number.isFinite(own.peak) ||
			!Number.isFinite(start) ||
			!Number.isFinite(end)
		)
			return false
		const lo = start - DQ_IDENTITY_OVERLAP_MS
		const hi = end + DQ_IDENTITY_OVERLAP_MS
		for (const id of this.bySource.get(sourceId) ?? []) {
			if (id === d.id) continue
			const o = this.discoveries.get(id)
			if (o === undefined || o.sourceIds[0] !== sourceId) continue
			if (!o.metadata.sources.some(x => talkers.includes(x))) continue
			if (this.effectiveLabel(o).protocol !== ev.protocol) continue
			const other = this.mediansOf(o.id)
			if (
				other === undefined ||
				!Number.isFinite(other.centre) ||
				!Number.isFinite(other.peak)
			)
				continue
			const dist = Math.abs(other.centre - own.centre)
			if (dist < DQ_IDENTITY_SPLIT_MIN_HZ || dist > DQ_IDENTITY_SPLIT_MAX_HZ)
				continue
			if (other.peak - own.peak < DQ_IDENTITY_WEAKER_DB) continue
			for (const x of this.byDiscovery.get(o.id) ?? []) {
				const xs = Date.parse(x.startedAt)
				const xe = Date.parse(x.endedAt ?? x.startedAt)
				if (xs <= hi && xe >= lo) return true
			}
		}
		return false
	}

	applyClassification(
		discoveryId: string,
		c: Classification,
	): StoreChange | null {
		const d = this.discoveries.get(discoveryId)
		if (d === undefined) return null
		const before = this.revision(d)
		const beforeRank = rank(d.confidence)
		this.applyClassificationTo(d, c)
		if (this.revision(d) === before) return null
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
	 * Protocol and confidence of a live discovery, in a fresh object. Both are the
	 * proof-implied label `get()` publishes; `id` is the stored id. Undefined when
	 * unknown. Does not clone the discovery. Pair with `discoveryIdOf` to follow an
	 * observation to its surviving discovery after a merge.
	 */
	identityOf(
		discoveryId: string,
	):
		| { id: string; protocol: ScannerProtocol; confidence: ScannerConfidence }
		| undefined {
		const d = this.discoveries.get(discoveryId)
		if (d === undefined) return undefined
		const label = this.publishedLabel(d)
		return { id: d.id, protocol: label.protocol, confidence: label.confidence }
	}

	/** WG6 req 2.1: duration of an in-memory observation that has ended; undefined while open or unknown. */
	endedDurationOf(observationId: string): number | undefined {
		const o = this.observationIndex.get(observationId)
		return o === undefined || o.endedAt === undefined
			? undefined
			: recordDuration(o)
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
		ev = checkedDecode(ev)
		const o = this.observationIndex.get(observationId)
		if (
			o === undefined ||
			this.discoveries.get(o.discoveryId)?.anchor === "decode" ||
			!ev.crcClean ||
			ev.epoch !== o.sampleRange.epoch
		)
			return false
		const epochEnded = o.endReason === "retune" || o.endReason === "hop"
		if (epochEnded && o.endedAt !== undefined && ev.at >= Date.parse(o.endedAt))
			return false
		const list = o.decode ?? []
		if (list.some(x => jsonEqual(x, ev))) return false
		const added = plainCopy(ev)
		const sorted = [...list, added].sort((a, b) => a.at - b.at)
		const kept =
			sorted.length > OBSERVATION_DECODE_MAX
				? sorted.slice(sorted.length - OBSERVATION_DECODE_MAX)
				: sorted
		if (!kept.includes(added)) return false // older than the 16 kept
		const before = this.peekProof(o.id)
		this.armWatchers(o.discoveryId)
		o.decode = kept
		this.proofBearing.add(o.discoveryId)
		this.observationProofCache.delete(o.id)
		this.invalidateLabel(o.discoveryId)
		this.dropWatcherCaches(o.discoveryId)
		const discovery = this.discoveries.get(o.discoveryId)
		const op = newOp()
		op.observations.add(o.id)
		this.finish("evidence", op)
		if (discovery !== undefined)
			this.emitProofChange(
				discovery.id,
				before,
				this.discoveryView(discovery).proof,
			)
		return true
	}

	nextTrialOrder(): number {
		this.trialOrder += 1
		return this.trialOrder
	}

	recordTrial(observationId: string, row: ProofTrialInput): boolean {
		return this.recordTrials(observationId, [row])
	}

	recordTrials(
		observationId: string,
		rows: readonly ProofTrialInput[],
	): boolean {
		try {
			const known = this.observationIndex.get(observationId)
			if (known === undefined) return false
			const armed = this.armWatchers(known.discoveryId)
			const before = this.peekProof(observationId)
			let changed = false
			for (const row of rows) {
				const accepted = acceptTrial(row)
				if (
					accepted !== undefined &&
					this.rememberTrial(observationId, accepted)
				)
					changed = true
			}
			if (!changed) {
				this.disarm(armed)
				return false
			}
			this.publishEvidence(observationId, before)
			return true
		} catch {
			return false
		}
	}

	recordAnalog(observationId: string, row: ProofAnalogInput): boolean {
		try {
			const known = this.observationIndex.get(observationId)
			if (known === undefined) return false
			const accepted = acceptedAnalogEvidence(row)
			if (accepted === undefined) return false
			const armed = this.armWatchers(known.discoveryId)
			const before = this.peekProof(observationId)
			if (!this.rememberAnalog(observationId, accepted)) {
				this.disarm(armed)
				return false
			}
			return this.publishEvidence(observationId, before)
		} catch {
			return false
		}
	}

	recordUnavailable(
		observationId: string,
		type: ScannerProbeDecoderType,
	): boolean {
		try {
			const known = this.observationIndex.get(observationId)
			if (known === undefined) return false
			if (typeof type !== "string" || !PROBE_DECODERS.has(type)) return false
			const armed = this.armWatchers(known.discoveryId)
			const before = this.peekProof(observationId)
			if (!this.rememberUnavailable(observationId, type)) {
				this.disarm(armed)
				return false
			}
			return this.publishEvidence(observationId, before)
		} catch {
			return false
		}
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
		return this.presentDiscovery(d)
	}

	delete(id: string): boolean {
		const d = this.discoveries.get(id)
		if (d === undefined) return false
		const op = newOp()
		this.deleteInto(op, d)
		this.finish("delete", op)
		return true
	}

	/**
	 * DQ 7.3: the load plan over the records as they are now (frozen once). Pure apart from the
	 * reads; nothing changes until `applyConsolidation`.
	 */
	consolidationPlan(probe?: PlanProbe): ConsolidationPlan {
		const frozen: ConsolidationRecord[] = []
		for (const d of this.discoveries.values()) frozen.push(this.frozenOf(d))
		return planConsolidation(frozen, probe)
	}

	/**
	 * DQ 7.5, 7.6: applies (or resumes) a plan. Each group is one operation journaled as `rekey`
	 * with the ordinary merge mutation, so any reader replays it. A gone survivor skips its group;
	 * gone members (already applied) are skipped, so a resumed or repeated plan is a no-op.
	 */
	applyConsolidation(plan: { groups: readonly ConsolidationGroup[] }): {
		groups: number
		absorbed: number
		/** Per applied group: the survivor and every id it absorbed, sorted (not capped). */
		merges: { survivor: string; mergedIds: string[] }[]
	} {
		let groups = 0
		let absorbed = 0
		const merges: { survivor: string; mergedIds: string[] }[] = []
		for (const g of plan.groups) {
			const keep = this.discoveries.get(g.survivor)
			if (keep === undefined || hasOperatorState(keep)) continue
			// 7.1: operator state set since the plan was written (a resume) is never merged.
			const live = g.members.filter(id => {
				const d = this.discoveries.get(id)
				return id !== keep.id && d !== undefined && !hasOperatorState(d)
			})
			if (live.length === 0) continue
			const op = newOp()
			for (const id of live) {
				const drop = this.discoveries.get(id)
				if (drop !== undefined) this.absorb(op, keep, drop, true)
			}
			if (op.merged.length > 0) {
				groups += 1
				absorbed += op.merged.length
				merges.push({
					survivor: keep.id,
					mergedIds: op.merged.map(([, drop]) => drop).sort(compareText),
				})
			}
			this.finish("rekey", op)
		}
		return { groups, absorbed, merges }
	}

	/** DQ 7.1: a record's frozen values for the consolidation predicate. */
	private frozenOf(d: Discovery): ConsolidationRecord {
		const m = this.mediansOf(d.id)
		const count = m?.count ?? 0
		const recent = count < DQ_MIN_HISTORY_OBS ? this.recentOf(d.id) : []
		const label = this.effectiveLabel(d)
		return {
			id: d.id,
			sourceId: d.sourceIds[0] ?? "",
			centreHz: m?.centre ?? d.frequencyHz + d.measuredOffsetHz,
			obwHz: m?.obw ?? d.bandwidthHz,
			obwMin: m?.obwMin ?? Number.NaN,
			obwMax: m?.obwMax ?? Number.NaN,
			bandFactor: this.bandFactor(d),
			peakDbfs: m?.peak ?? Number.NaN,
			count,
			young: recent.map(o => ({ peakDbfs: o.peakDbfs, obwHz: o.obwHz })),
			identity: d.identity,
			family: this.associationFamily(d),
			decoded: label.confidence === "decoded",
			protocol: label.protocol,
			firstSeenAt: d.firstSeenAt,
			hasOperator: hasOperatorState(d),
			...(d.anchor ? { anchor: d.anchor } : {}),
		}
	}

	/**
	 * DQ 7.7: on a sticky match to `m`, absorbs the records joinable to the group's survivor among
	 * the 32 nearest to `m`'s median centre (within 1 kHz); returns the survivor the observation
	 * goes to. Bounded: 7 lists x 33 entries visited, at most 32 candidates checked.
	 */
	private lazyConsolidate(
		op: Op,
		m: Discovery,
		obs: ObservationInput,
		decodedAs?: string,
	): Discovery {
		const sourceId = m.sourceIds[0] ?? ""
		const centre = this.medianCentre(m)
		if (!Number.isFinite(centre)) return m
		this.syncIndex()
		const seen = new Set<string>([m.id])
		const hits: IndexedCentre[] = []
		for (const family of CENTRE_FAMILIES)
			for (const e of this.centres.nearest(
				sourceId,
				family,
				centre,
				DQ_CROSS_FAMILY_HZ,
				DQ_CONSOLIDATE_SCAN_MAX + 1,
			))
				if (!seen.has(e.id)) {
					seen.add(e.id)
					hits.push(e)
				}
		if (hits.length === 0) return m
		hits.sort(
			(a, b) =>
				Math.abs(a.centreHz - centre) - Math.abs(b.centreHz - centre) ||
				compareText(a.id, b.id),
		)
		if (hits.length > DQ_CONSOLIDATE_SCAN_MAX)
			hits.length = DQ_CONSOLIDATE_SCAN_MAX
		const fm = this.frozenOf(m)
		const scanned: ConsolidationRecord[] = []
		for (const e of hits) {
			const d = this.discoveries.get(e.id)
			if (d !== undefined) scanned.push(this.frozenOf(d))
		}
		// DQ 9.5: a record decoded as another protocol than this observation's decode never joins
		// the group the observation lands in.
		const otherDecode = (c: ConsolidationRecord): boolean =>
			decodedAs !== undefined && c.decoded && c.protocol !== decodedAs
		const toM = scanned.filter(c => !otherDecode(c) && joinable(fm, c))
		if (toM.length === 0) return m
		// The survivor: the highest-ranked of m and the records joinable to m that the observation
		// itself may join (3.1), so the observation never lands on a record that refuses it.
		const pool = [fm, ...toM].sort(rankCompare)
		let survivor = m
		let fs = fm
		for (const c of pool) {
			const d = this.discoveries.get(c.id)
			if (d !== undefined && this.obsCompatible(d, obs) !== false) {
				survivor = d
				fs = c
				break
			}
		}
		const members = [fm, ...scanned]
			.filter(
				c =>
					c.id !== fs.id &&
					!otherDecode(c) &&
					Math.abs(c.centreHz - centre) <= DQ_CROSS_FAMILY_HZ &&
					joinable(fs, c),
			)
			.slice(0, DQ_CONSOLIDATE_GROUP_MAX - 1)
		for (const c of members) {
			const drop = this.discoveries.get(c.id)
			if (drop !== undefined && drop.id !== survivor.id)
				this.absorb(op, survivor, drop)
		}
		return survivor
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
		this.publish([plan.discovery.id])
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

	/**
	 * WG10 req 1.2: after a scanner recording delete, the id leaves the observation holding it and
	 * that discovery's `evidence.recordings` drops by one (floor zero); journaled as `evidence`,
	 * change `updated`. False when no observation holds the id (nothing changes).
	 */
	forgetRecording(recordingId: string): boolean {
		for (const o of this.observationIndex.values()) {
			if (!o.recordingIds.includes(recordingId)) continue
			const d = this.discoveries.get(o.discoveryId)
			if (d === undefined) return false
			o.recordingIds = o.recordingIds.filter(r => r !== recordingId)
			d.evidence.recordings = Math.max(0, d.evidence.recordings - 1)
			const op = newOp()
			op.discoveries.add(d.id)
			op.observations.add(o.id)
			mark(op, d.id, "updated")
			this.finish("evidence", op)
			return true
		}
		return false
	}

	/**
	 * Band inspection UX req 3.1: the live discovery `discoveryId` was merged into, by the recording
	 * aliases first, then the bounded absorbed-id index. Undefined for a live, unknown or evicted id.
	 */
	survivorOf(discoveryId: string): string | undefined {
		if (this.discoveries.has(discoveryId)) return undefined
		const owner =
			this.aliasTable.aliasOwner(discoveryId) ??
			this.absorbedIndex.resolve(discoveryId)
		return owner !== undefined && this.discoveries.has(owner)
			? owner
			: undefined
	}

	/** WG10 req 1.5: the live discovery that adopted `discoveryId`'s folder in a merge. */
	aliasOwner(discoveryId: string): string | undefined {
		return this.aliasTable.aliasOwner(discoveryId)
	}

	/** WG10 req 1.5: the folder ids `discoveryId` adopted, oldest first (a deleted owner's until released). */
	aliasesOf(discoveryId: string): readonly string[] {
		return this.aliasTable.aliasesOf(discoveryId)
	}

	/** WG10 req 1.5: forgets a deleted owner's aliases once its evidence removal settled. */
	releaseAliases(discoveryId: string): void {
		if (!this.discoveries.has(discoveryId)) this.aliasTable.release(discoveryId)
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

	/**
	 * `canFold` (DQ 10.3): the caller's check that a record holds no evidence the store cannot see
	 * (files on disk, captures, remembered trials) and so may be merged away or retired. Without
	 * it the fragment pass does nothing.
	 */
	pruneInactive(
		maxAgeDays: number,
		opts: { canFold?: (discoveryId: string) => boolean } = {},
	): string[] {
		this.sweepPending() // DQ 1.5: the maintenance cadence also sweeps pending
		const cutoff = iso(this.now() - maxAgeDays * DAY_MS)
		const op = newOp()
		const removed: string[] = []
		for (const d of [...this.discoveries.values()]) {
			// WG2 R2: a lockout is skipped by sweeps, so its lastSeenAt stops moving; age must not
			// silently remove it and put the frequency back into sweeps.
			if (
				d.operator?.keep === true ||
				d.operator?.lockout === true ||
				d.lastSeenAt >= cutoff ||
				this.holdsKept(d.id)
			)
				continue
			removed.push(d.id)
			this.deleteInto(op, d)
		}
		this.finish("evict", op)
		// DQ 10: the same maintenance cadence retires legacy fragments (bounded per pass).
		removed.push(
			...this.retireFragments(
				opts.canFold !== undefined ? { canFold: opts.canFold } : {},
			).retired,
		)
		return removed
	}

	/**
	 * DQ 10.2 to 10.6: one bounded fragment pass. Fragments on one channel of the covering grid
	 * merge into the channel record (one `rekey` operation per group, the ordinary merge); stale
	 * low-sighting fragments with no evidence retire (one `evict` operation). Idempotent: a second
	 * pass over the result changes nothing.
	 */
	retireFragments(
		opts: {
			/**
			 * DQ 10.3: asked for every record that would be merged away or retired; required for the
			 * pass to do anything. Fail closed: a throw or a non-true answer keeps the record.
			 */
			canFold?: (discoveryId: string) => boolean
			probe?: { plan?: FragmentPlan }
		} = {},
	): {
		groups: number
		absorbed: number
		retired: string[]
		merges: { survivor: string; mergedIds: string[] }[]
	} {
		const canFold = opts.canFold
		if (canFold === undefined)
			return { groups: 0, absorbed: 0, retired: [], merges: [] }
		const finest = (rasters: readonly Raster[]): Raster | null => {
			let best: Raster | null = null
			for (const x of rasters)
				if (x.spacingHz > 0 && (best === null || x.spacingHz < best.spacingHz))
					best = x
			return best
		}
		const at = (r: FragmentRecord): Raster[] =>
			this.channelRastersFor(
				r.sourceId,
				r.centreHz + (this.corrections.get(r.sourceId) ?? 0),
			)
		const cursor = this.fragmentCursor
		let budget = FRAGMENT_GROUPS_MAX
		let groups = 0
		let absorbed = 0
		let truncated = 0
		const merges: { survivor: string; mergedIds: string[] }[] = []
		const retired: string[] = []
		let checks = 0
		let checksSpent = false
		const asked = new Map<string, boolean>()
		const fold = (id: string): boolean => {
			const known = asked.get(id)
			if (known !== undefined) return known
			if (checks >= FRAGMENT_FOLD_CHECK_MAX) {
				checksSpent = true
				return false
			}
			checks += 1
			let ok = false
			try {
				ok = canFold(id) === true
			} catch {
				ok = false
			}
			asked.set(id, ok)
			return ok
		}
		let settled = false
		// 10.5: each round merges, then retires on the merged state. A merge can make a refused pair
		// compatible and a retirement can remove a survivor that refused others, so the pass plans
		// again after any progress, at most FRAGMENT_ROUNDS_MAX rounds.
		for (let round = 0; round < FRAGMENT_ROUNDS_MAX; round++) {
			const records: FragmentRecord[] = []
			for (const d of this.discoveries.values())
				records.push(this.fragmentOf(d))
			const plan = planFragments({
				records,
				rasterOf: r => finest(gridFor(at(r), r.obwHz)),
				fineRasterOf: r => finest(at(r)),
				compatible: (a, b) => {
					const x = this.discoveries.get(a)
					const y = this.discoveries.get(b)
					return (
						x !== undefined &&
						y !== undefined &&
						!this.decodedConflict(x, y) &&
						this.pairCompatible(x, y) !== false &&
						fold(b)
					)
				},
				nowMs: this.now(),
				cursor,
				groupsMax: Math.max(0, budget),
			})
			if (round === 0) this.fragmentCursor = plan.nextCursor
			truncated += plan.truncated
			budget -= plan.groups.length
			let absorbedNow = 0
			for (const g of plan.groups) {
				const keep = this.discoveries.get(g.survivor)
				if (keep === undefined) continue
				const op = newOp()
				for (const id of g.members) {
					const drop = this.discoveries.get(id)
					// 10.3: re-checked on the live record; a protected record is never merged away.
					if (drop === undefined || drop.id === keep.id) continue
					if (this.fragmentProtected(drop) || !fold(drop.id)) continue
					// Never past the alias cap: a dropped alias would stop protecting its evidence.
					if (
						this.aliasesOf(keep.id).length +
							1 +
							this.aliasesOf(drop.id).length >
						DISCOVERY_RECORDING_ALIASES_MAX
					)
						continue
					this.absorb(op, keep, drop)
				}
				if (op.merged.length > 0) {
					absorbedNow += op.merged.length
					groups += 1
					absorbed += op.merged.length
					merges.push({
						survivor: keep.id,
						mergedIds: op.merged.map(([, drop]) => drop).sort(compareText),
					})
				}
				this.finish("rekey", op)
			}
			// 10.4: retirement on the state after this round's merges (re-frozen, O(n)).
			let retiredNow = 0
			const room = FRAGMENT_RETIRE_MAX - retired.length
			if (room > 0) {
				const after: FragmentRecord[] = []
				for (const d of this.discoveries.values())
					after.push(this.fragmentOf(d))
				const op = newOp()
				for (const id of planRetirement(
					after,
					this.now(),
					undefined,
					Number.POSITIVE_INFINITY,
				)) {
					if (retiredNow >= room || checksSpent) break
					const d = this.discoveries.get(id)
					if (d === undefined || this.fragmentProtected(d)) continue
					if (!fold(id)) continue
					retired.push(d.id)
					retiredNow += 1
					this.deleteInto(op, d)
				}
				this.finish("evict", op)
			}
			if (opts.probe) opts.probe.plan = { ...plan, truncated }
			// Settled: a round that saw every candidate and changed nothing.
			if (absorbedNow === 0 && retiredNow === 0) {
				// (With the group budget spent, merges may be left: not settled.)
				// With the retire budget spent, stale records may be left: not settled either.
				settled =
					plan.nextCursor === undefined &&
					budget > 0 &&
					retired.length < FRAGMENT_RETIRE_MAX &&
					!checksSpent
				break
			}
			// A scan cut short by the candidate cap: the next pass continues from the cursor.
			if (plan.nextCursor !== undefined) break
		}
		// A bound was hit (round, group or retire cap): work may be left for the next pass.
		if (!settled && opts.probe?.plan) opts.probe.plan.truncated += 1
		return { groups, absorbed, retired, merges }
	}

	/** DQ 10.3: operator state, decodes or any evidence keep a record from being merged away. */
	private fragmentProtected(d: Discovery): boolean {
		return hasOperatorState(d) || this.fragmentEvidence(d)
	}

	private fragmentEvidence(d: Discovery): boolean {
		if (d.identity !== undefined || d.confidence === "decoded" || d.encrypted)
			return true
		const e = d.evidence
		if (e.recordings > 0 || e.psd || e.iq) return true
		const m = d.metadata
		if (
			m.talkgroups.length > 0 ||
			m.sources.length > 0 ||
			m.slots.length > 0 ||
			m.callsigns.length > 0 ||
			m.capcodes.length > 0 ||
			m.ismModels.length > 0 ||
			m.ctcssHz !== undefined
		)
			return true
		const view = this.discoveryView(d)
		if (
			view.label.confidence === "decoded" ||
			view.evidence === "proven" ||
			view.proof !== null
		)
			return true
		return this.holdsKept(d.id)
	}

	/** DQ 10: a record's frozen values for the fragment pass. */
	private fragmentOf(d: Discovery): FragmentRecord {
		const sourceId = d.sourceIds[0] ?? ""
		const m = this.mediansOf(d.id)
		return {
			id: d.id,
			sourceId,
			centreHz:
				(m?.centre ?? d.frequencyHz + d.measuredOffsetHz) -
				(this.corrections.get(sourceId) ?? 0),
			obwHz: m?.obw ?? d.bandwidthHz,
			observationCount: d.observationCount,
			firstSeenAt: d.firstSeenAt,
			lastSeenAt: d.lastSeenAt,
			confidence: d.confidence,
			family: this.associationFamily(d),
			operator: hasOperatorState(d),
			...(d.anchor ? { anchor: d.anchor } : {}),
			evidence: this.fragmentEvidence(d),
		}
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
		return d === undefined ? undefined : this.presentDiscovery(d)
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
		const nearHz = filter.nearHz
		const toleranceHz =
			filter.toleranceHz ?? DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ
		const useNear =
			nearHz !== undefined &&
			Number.isFinite(nearHz) &&
			Number.isFinite(toleranceHz) &&
			toleranceHz >= 0
		const base =
			nearHz === undefined
				? [...this.discoveries.values()]
				: useNear
					? this.discoveriesNear(nearHz, toleranceHz, filter.sourceId)
					: []
		// q is lower-cased once. It matches the operator label or the identity value;
		// metadata lists (talkgroups, callsigns, capcodes) are not searched.
		const q = filter.q?.toLowerCase()
		const identity = filter.identity
		const identityValue = identity?.value.trim().toLowerCase()
		const min = filter.minConfidence
		const labelFilter = filter.protocol !== undefined || min !== undefined
		const evidence = filter.evidence
		const evidenceOn = evidence === "proven" || evidence === "weak"
		// Source, job, frequency and the near window (already the `base`) do not
		// read the proof. Protocol and confidence use the stored record only while
		// no retained evidence can name a proof; a proof's label is cached with it.
		const items = base.filter(d => {
			if (filter.jobId !== undefined && !d.jobIds.includes(filter.jobId))
				return false
			if (
				filter.sourceId !== undefined &&
				!d.sourceIds.includes(filter.sourceId)
			)
				return false
			if (filter.freqMinHz !== undefined && d.frequencyHz < filter.freqMinHz)
				return false
			if (filter.freqMaxHz !== undefined && d.frequencyHz > filter.freqMaxHz)
				return false
			if (filter.since !== undefined && Date.parse(d.lastSeenAt) < filter.since)
				return false
			const checked =
				(filter.encrypted === undefined &&
					identity === undefined &&
					q === undefined) ||
				!isDsdFmeProtocol(d.protocol) ||
				this.hasCheckedContent(d)
			const publishedIdentity = checked ? d.identity : undefined
			const publishedEncrypted = checked && d.encrypted
			if (
				filter.encrypted !== undefined &&
				publishedEncrypted !== filter.encrypted
			)
				return false
			if (
				identity !== undefined &&
				(publishedIdentity?.kind !== identity.kind ||
					publishedIdentity.value.trim().toLowerCase() !== identityValue)
			)
				return false
			if (
				q !== undefined &&
				!(d.operator?.label ?? "").toLowerCase().includes(q) &&
				!(publishedIdentity?.value ?? "").toLowerCase().includes(q)
			)
				return false
			if (!evidenceOn && !labelFilter) return true
			const cached = this.proofCache.get(d.id)
			if (cached !== undefined) {
				if (evidenceOn && cached.evidence !== evidence) return false
				const label = publishedOf(cached)
				if (filter.protocol !== undefined && label.protocol !== filter.protocol)
					return false
				if (min !== undefined && rank(label.confidence) < rank(min))
					return false
				return true
			}
			// No proof inputs: the level is weak and the DTO label is UNKNOWN_LABEL (3.10).
			if (d.anchor !== "decode" && !this.evidenceCanNameProof(d)) {
				if (
					filter.protocol !== undefined &&
					UNKNOWN_LABEL.protocol !== filter.protocol
				)
					return false
				if (min !== undefined && rank(UNKNOWN_LABEL.confidence) < rank(min))
					return false
				return !evidenceOn || evidence === "weak"
			}
			const view = this.discoveryView(d)
			if (evidenceOn && view.evidence !== evidence) return false
			const label = publishedOf(view)
			if (filter.protocol !== undefined && label.protocol !== filter.protocol)
				return false
			if (min !== undefined && rank(label.confidence) < rank(min)) return false
			return true
		})
		const byLastSeen = (a: Discovery, b: Discovery): number =>
			compareText(b.lastSeenAt, a.lastSeenAt) || compareText(a.id, b.id)
		const byDistance = (a: Discovery, b: Discovery): number =>
			Math.abs(a.frequencyHz - (nearHz ?? 0)) -
				Math.abs(b.frequencyHz - (nearHz ?? 0)) || compareText(a.id, b.id)
		const sort = filter.sort ?? "lastSeen"
		items.sort(
			useNear
				? byDistance
				: sort === "frequency"
					? (a, b) => a.frequencyHz - b.frequencyHz || compareText(a.id, b.id)
					: sort === "confidence"
						? (a, b) =>
								rank(this.publishedLabel(b).confidence) -
									rank(this.publishedLabel(a).confidence) || byLastSeen(a, b)
						: byLastSeen,
		)
		const page = items
			.slice(offset, offset + limit)
			.map(d => this.presentDiscovery(d))
		return {
			items: page,
			nextCursor: offset + limit < items.length ? String(offset + limit) : null,
		}
	}

	near(hz: number, toleranceHz: number, sourceId?: string): Discovery[] {
		if (
			!Number.isFinite(hz) ||
			!Number.isFinite(toleranceHz) ||
			toleranceHz < 0
		)
			return []
		return this.discoveriesNear(hz, toleranceHz, sourceId).map(d =>
			this.presentDiscovery(d),
		)
	}

	/** Inclusive window on `frequencyHz`, sorted by |Δf| then id. */
	private discoveriesNear(
		hz: number,
		toleranceHz: number,
		sourceId?: string,
	): Discovery[] {
		this.syncIndex()
		const out: Discovery[] = []
		for (const hit of this.frequencies.range(
			hz - toleranceHz,
			hz + toleranceHz,
			sourceId,
		)) {
			const d = this.discoveries.get(hit.id)
			if (d === undefined) continue
			if (Math.abs(d.frequencyHz - hz) > toleranceHz) continue
			if (sourceId !== undefined && !d.sourceIds.includes(sourceId)) continue
			out.push(d)
		}
		out.sort(
			(a, b) =>
				Math.abs(a.frequencyHz - hz) - Math.abs(b.frequencyHz - hz) ||
				compareText(a.id, b.id),
		)
		return out
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
			items: all
				.slice(offset, offset + size)
				.map(o => this.presentObservation(o)),
			nextCursor: offset + size < all.length ? String(offset + size) : null,
		}
	}

	/** Everything replay cannot rebuild without the pruned journal: records plus per-source corrections (P13). */
	snapshot(): StoreSnapshot {
		const parts = this.snapshotParts()
		return {
			discoveries: [...this.discoveries.values()]
				.sort((a, b) => compareText(a.id, b.id))
				.map(clone),
			observations: [...this.observationIndex.values()]
				.sort(compareObs)
				.map(clone),
			...(parts.recordingOperations !== undefined
				? { recordingOperations: parts.recordingOperations }
				: {}),
			...(parts.aliases !== undefined ? { aliases: parts.aliases } : {}),
			corrections: parts.corrections,
		}
	}

	/** WG11 req 3.5: the non-record fields of `snapshot()` (same presence rules, copies, no record clones). */
	snapshotParts(): Pick<
		StoreSnapshot,
		"corrections" | "recordingOperations" | "aliases"
	> {
		const aliases = this.aliasTable.entries()
		return {
			...(this.recordingOperations.size > 0
				? { recordingOperations: this.preparedRecordingOperations() }
				: {}),
			...(aliases.length > 0 ? { aliases } : {}),
			corrections: [...this.corrections]
				.sort(([a], [b]) => compareText(a, b))
				.map(([sourceId, hz]) => ({ sourceId, hz })),
		}
	}

	restore(s: StoreSnapshot): void {
		for (const timer of this.anchorExpiry.values()) clearTimeout(timer)
		this.anchorExpiry.clear()
		// band inspection UX req 3.3: restored records are a new store; revisions restart with it
		this.epoch = newStoreEpoch()
		this.revisionSeq = 1
		this.published.clear()
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
		this.evidenceByObservation.clear()
		this.observationProofCache.clear()
		this.proofCache.clear()
		this.clearProofIndexes()
		this.discoveries.clear()
		this.decodeAnchors.clear()
		this.anchorWindows.clear()
		this.anchorPending.clear()
		this.anchorPublished.clear()
		this.observationIndex.clear()
		this.byDiscovery.clear()
		this.bySource.clear()
		this.flaggedIds.clear()
		this.corrections.clear()
		this.appliedSeq = 0
		this.medians.clear()
		this.unlinked.clear()
		this.linkTouched.clear()
		this.members.clear()
		this.centres.clear()
		this.decodedCentres.clear()
		this.proofBearing.clear()
		this.frequencies.clear()
		this.byKey.clear()
		this.indexed.clear()
		this.indexDirty.clear()
		this.countsDirty.clear()
		this.jobCounts.clear()
		this.proofQuiet++
		try {
			for (const c of s.corrections) this.corrections.set(c.sourceId, c.hz)
			for (const d of s.discoveries) this.insertDiscovery(clone(d))
			for (const o of [...s.observations].sort(compareObs)) {
				if (!this.discoveries.has(o.discoveryId)) continue
				const observation = clone(o)
				this.downgradeLegacyObservation(observation)
				this.putObservation(observation)
			}
			for (const d of this.discoveries.values()) this.normalizeCheckedContent(d)
			this.aliasTable.restore(s.aliases ?? [], id => this.discoveries.has(id))
			// the set was replaced, not trimmed: a mirror resets from the snapshot itself
			this.removal = { discoveries: [], observations: [] }
			this.catchUp()
		} finally {
			this.proofQuiet--
			this.pendingProof.clear()
		}
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
		this.catchUp()
		this.flushRemoval()
	}

	/** WG11 req 3.3: discoveries carrying `jobId` by confidence (as a `list({ jobId })` recount), a copy. */
	countsByJob(jobId: string): ConfidenceCounts {
		this.syncCounts()
		return this.jobCounts.get(jobId)
	}

	/** WG11 req 3.5: what `snapshot()` would hold, O(1). */
	recordCounts(): { discoveries: number; observations: number } {
		return {
			discoveries: this.discoveries.size,
			observations: this.observationIndex.size,
		}
	}

	// ── association ──────────────────────────────────────────────────────

	private stickyMatch(
		obs: ObservationInput,
		family: ProtocolFamily,
		evidenceLess: boolean,
		decodedAs?: string,
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
		const centre = obs.track.centreHz
		// review m6: a non-finite centre never matched today's distance test; the index holds none
		if (!Number.isFinite(centre)) return undefined
		this.syncIndex()
		// WG11 req 3.1: the window is widened by 1 Hz so float rounding of centre ± tol cannot drop a
		// hit; the exact distance test below is today's. The centre lists are the association family
		// (DQ 9.1),
		// so a hit needs no proof read. An evidence-less observation also sticks to a decoded
		// discovery of any family; those sit in one extra list.
		const lowHz = centre - tol - 1
		const highHz = centre + tol + 1
		let radius = tol
		let crossFamily = false
		const consider = (e: IndexedCentre): void => {
			const d = this.discoveries.get(e.id)
			if (d === undefined || d.anchor === "decode") return
			const dist = Math.abs(e.centreHz - centre)
			if (dist > radius) return
			// DQ 9.5: never to a record decoded as another protocol than this observation's decode.
			if (this.decodedOther(d, decodedAs)) return
			// DQ 3.2, 9.4: never stick to a record that refuses this observation (young included).
			if (this.obsCompatible(d, obs) === false) return
			// DQ 9.3: only the cross-family or young route is band-gated (9.2).
			if (crossFamily && !this.bandwidthJoins(d, obs.track.obwHz)) return
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
		this.centres.range(obs.sourceId, family, lowHz, highHz, consider)
		// The decoded-record shortcut serves an observation that carries a decode. An evidence-less
		// one reaches a decoded record of another family only by the 9.3 cross-family route below
		// (1 000 Hz, 9.2 band).
		if (family === "unknown" && !evidenceLess)
			this.decodedCentres.range(
				obs.sourceId,
				DECODED_CENTRE_FAMILY,
				lowHz,
				highHz,
				consider,
			)
		// DQ 9.3: the cross-family or young route. An evidence-less observation also sticks to a
		// record of any other association family (carrier included) within min(tol, 1 kHz) when its
		// OBW lies in the record's band (9.2). Young records of the observation's own list are
		// already reached by the same-family route (full tolerance, no band). Nearest wins.
		if (evidenceLess) {
			radius = Math.min(tol, DQ_CROSS_FAMILY_HZ)
			crossFamily = true
			for (const other of CENTRE_FAMILIES) {
				if (other === family) continue
				this.centres.range(
					obs.sourceId,
					other,
					centre - radius - 1,
					centre + radius + 1,
					consider,
				)
			}
		}
		return best
	}

	/**
	 * DQ 9.2: the observation OBW lies in the record's band `[obwMin / f, obwMax x f]`, `f` from
	 * decode or identity (never the observation count). Non-finite or missing values fail (9.8).
	 */
	private bandwidthJoins(d: Discovery, obwHz: number): boolean {
		const m = this.mediansOf(d.id)
		// 9.8: a missing window or a non-finite median width fails.
		if (m === undefined || !Number.isFinite(m.obw)) return false
		return inObwBand(obwHz, m.obwMin, m.obwMax, this.bandFactor(d))
	}

	/** DQ 9.3: the cross-family route's distance and band for an evidence-less observation. */
	private crossJoins(d: Discovery, obs: ObservationInput): boolean {
		const c = obs.track.centreHz
		const tol = this.toleranceHz(obs.sourceId, c, obs.track.obwHz)
		const dist = Math.abs(this.medianCentre(d) - c)
		return (
			dist <= Math.min(tol, DQ_CROSS_FAMILY_HZ) &&
			this.bandwidthJoins(d, obs.track.obwHz)
		)
	}

	/** DQ 9.2: 2 for a decoded or identified record, 3 otherwise. */
	private bandFactor(d: Discovery): number {
		return this.effectiveLabel(d).confidence === "decoded" ||
			d.identity !== undefined
			? DQ_OBW_RATIO_MAX
			: DQ_YOUNG_OBW_RATIO
	}

	/**
	 * DQ 9.1: the effective family when the record is decoded, carries an identity or shows proven
	 * evidence; otherwise `unknown`, so a weak guess never keeps records apart.
	 */
	private associationFamily(d: Discovery): ProtocolFamily {
		const view = this.discoveryView(d)
		return associationOf(view.label, d.identity, view.evidence)
	}

	/** DQ 9.5: both decoded with different (effective) protocols. */
	private decodedConflict(a: Discovery, b: Discovery): boolean {
		const la = this.effectiveLabel(a)
		const lb = this.effectiveLabel(b)
		return (
			la.confidence === "decoded" &&
			lb.confidence === "decoded" &&
			la.protocol !== lb.protocol
		)
	}

	/** DQ 9.5: a record decoded as another protocol than the observation's decode. */
	private decodedOther(d: Discovery, protocol: string | undefined): boolean {
		if (protocol === undefined) return false
		const l = this.effectiveLabel(d)
		return l.confidence === "decoded" && l.protocol !== protocol
	}

	private keyTarget(
		sourceId: string,
		key: string,
		family: ProtocolFamily,
		cls: ScannerClass,
		obs: ObservationInput,
		decodedAs?: string,
		evidenceLess = false,
	): { merge: Discovery | null; coChannel: string[] } {
		const linked = this.atKey(sourceId, key).filter(d => d.anchor !== "decode")
		// DQ 3.2, 9.4, 9.5: a record that refuses the observation, or is decoded as another protocol
		// than its decode, is never a merge target; it stays a co-channel partner of whatever the
		// observation creates.
		const atKey = linked.filter(
			d =>
				!this.decodedOther(d, decodedAs) &&
				this.obsCompatible(d, obs) !== false,
		)
		// DQ 9.1: the association family.
		const familyOfDiscovery = (d: Discovery): ProtocolFamily =>
			this.associationFamily(d)
		const same = atKey.filter(d => familyOfDiscovery(d) === family)
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
			const others = atKey.filter(d => familyOfDiscovery(d) !== "carrier")
			const [single] = others
			// DQ 9.3: another association family is a cross-family join for an evidence-less
			// observation: within min(tolerance, 1 000 Hz) of its median and inside its band.
			if (
				others.length === 1 &&
				single !== undefined &&
				(!evidenceLess || this.crossJoins(single, obs))
			)
				return { merge: single, coChannel: [] }
		} else {
			const [lone] = atKey
			if (
				atKey.length === 1 &&
				lone !== undefined &&
				familyOfDiscovery(lone) === "unknown"
			)
				return { merge: lone, coChannel: [] }
		}
		return { merge: null, coChannel: linked.map(d => d.id) }
	}

	private createFrom(
		obs: ObservationInput,
		label: EvidenceLabel,
		coChannel: string[],
	): Ingested {
		if (!this.makeRoom()) return TRANSIENT
		return this.commit("observation", op => {
			const d = this.newDiscovery(op, obs, label, coChannel)
			const partners = [...d.coChannel]
			const id = this.addObservation(op, d, obs)
			// DQ 2.3: the same cap as refresh (the new record's ran there), reciprocal, on each
			// partner once the new record has its first median.
			for (const otherId of partners) {
				const other = this.discoveries.get(otherId)
				if (other !== undefined) this.pruneLinks(other)
			}
			return id
		})
	}

	private newDiscovery(
		op: Op,
		obs: ObservationInput,
		label: EvidenceLabel,
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
			protocol: label.protocol,
			family: label.family,
			class: obs.track.flags.edge ? "unknown" : obs.classification.class,
			confidence: label.confidence,
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
			this.syncProofWatch(other)
			op.discoveries.add(other.id)
			mark(op, other.id, "updated")
		}
		op.discoveries.add(d.id)
		mark(op, d.id, "created")
		return d
	}

	private addObservation(op: Op, d: Discovery, obs: ObservationInput): string {
		const beforeRank = rank(d.confidence)
		const raise = this.raisesBest(d, obs)
		const record = this.toRecord(obs, d.id)
		this.putObservation(record)
		op.observations.add(record.id)
		op.credited.set(record.id, {
			discoveryId: d.id,
			jobIds: [...record.jobIds],
		})
		d.observationCount += 1
		d.airtimeMs += durationOf(obs)
		this.absorbStats(d, obs, true, raise)
		this.refresh(d)
		op.discoveries.add(d.id)
		mark(op, d.id, rank(d.confidence) > beforeRank ? "upgraded" : "updated")
		return this.settle(op, d)
	}

	private reingest(known: Observation, obs: ObservationInput): Ingested {
		const d = this.discoveries.get(known.discoveryId)
		if (d === undefined) return TRANSIENT
		const beforeD = this.revision(d)
		const beforeRank = rank(d.confidence)
		const raise = this.raisesBest(d, obs)
		const record = this.toRecord(obs, d.id)
		record.jobIds = appendMissing(known.jobIds, obs.jobIds) // a job that ended while the track was open keeps its credit
		record.recordingIds = known.recordingIds
		if (known.recording !== undefined) record.recording = known.recording
		if (known.decode !== undefined) record.decode = known.decode
		const airtimeMs = Math.max(
			0,
			d.airtimeMs + durationOf(obs) - recordDuration(known),
		)
		if (airtimeMs !== d.airtimeMs) this.touch(d)
		d.airtimeMs = airtimeMs
		this.unlinkObservation(known)
		this.putObservation(record)
		const sameClassification =
			jsonEqual(record.hypotheses, known.hypotheses) &&
			record.flags.adjacentLeak === known.flags.adjacentLeak &&
			record.flags.suspectedIntermod === known.flags.suspectedIntermod &&
			voteOf(record) === voteOf(known)
		this.absorbStats(d, obs, !sameClassification, raise)
		this.refresh(d)
		if (this.revision(d) === beforeD && jsonEqual(record, known)) {
			this.flushRemoval()
			this.flushPending(new Set())
			return { discoveryId: d.id, change: "updated" }
		}
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
		if (d === undefined) return TRANSIENT
		const op = newOp()
		this.forgetEvidence(known.id)
		this.bumpProof(known.discoveryId)
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

	private absorbStats(
		d: Discovery,
		obs: ObservationInput,
		applyClassification: boolean,
		raiseBest: boolean,
	): void {
		this.markDirty(d.id)
		const startedAt = iso(obs.startedAt)
		const endedAt = iso(obs.endedAt ?? obs.startedAt)
		if (startedAt < d.firstSeenAt) {
			d.firstSeenAt = startedAt
			this.touch(d)
		}
		const stats = statsOf(obs.track)
		if (endedAt >= d.lastSeenAt) {
			if (
				endedAt !== d.lastSeenAt ||
				!jsonEqual(d.signal.last, stats) ||
				d.tuningTrust !== obs.track.tuningTrust
			)
				this.touch(d)
			d.lastSeenAt = endedAt
			d.signal.last = stats
			d.tuningTrust = obs.track.tuningTrust
		}
		// DQ 3.3: only a compatible, not overload-flagged observation raises best.
		if (raiseBest && stats.snrDb > d.signal.best.snrDb) {
			d.signal.best = { ...stats }
			this.touch(d)
		}
		const jobIds = appendMissing(d.jobIds, obs.jobIds)
		const sourceIds = appendMissing(d.sourceIds, [obs.sourceId])
		if (!sameList(jobIds, d.jobIds) || !sameList(sourceIds, d.sourceIds))
			this.touch(d)
		d.jobIds = jobIds
		d.sourceIds = sourceIds
		if (!applyClassification) return
		const majority = this.mediansOf(d.id)?.majority
		if (!obs.track.flags.edge)
			this.applyClassificationTo(d, obs.classification, majority)
		else if (
			majority !== undefined &&
			d.confidence !== "decoded" &&
			d.class !== majority
		) {
			// DQ 3.4: an edge observation does not vote, but the window it entered may have moved.
			this.markDirty(d.id)
			this.touch(d)
			d.class = majority
		}
	}

	/**
	 * `majority` (DQ 3.4) is the class tally of the last 64 observations; without one (nothing
	 * voted, or a refinement not tied to an observation) the classification's own class applies.
	 */
	private applyClassificationTo(
		d: Discovery,
		c: Classification,
		majority?: ScannerClass,
	): void {
		this.markDirty(d.id)
		const decoded = d.confidence === "decoded"
		// The cached DTO label ceilings confidence from this cap. Drop it with the
		// proof cache when the cap or the stored confidence changes.
		let labelChanged = false
		if (c.cap !== undefined && !decoded) {
			if (d.confidenceCap !== c.cap) {
				this.touch(d)
				labelChanged = true
			}
			d.confidenceCap = c.cap
			// A cap never raises the ladder. It only pulls a restored classified record down.
			if (rank(d.confidence) > rank("candidate")) {
				d.confidence = "candidate"
				this.touch(d)
				labelChanged = true
			}
		}
		const cls = majority ?? c.class
		if (!decoded && cls !== "unknown") {
			if (d.class !== cls) this.touch(d)
			d.class = cls
		}
		if (labelChanged) this.invalidateLabel(d.id)
	}

	private decodeInto(d: Discovery, ev: DecodeEvidence): void {
		// evidence without an identity is no confirm (§ 6.6): it may only refine the protocol, never switch the
		// family, or settle() could merge an analog discovery into its co-channel digital twin irreversibly
		this.markDirty(d.id)
		const decided = this.decidedLabel(d, ev)
		const label = decided.label
		const facts = decided.facts
		const winnerIdentity = facts?.identity
		const winnerProtocol = facts?.protocol
		// Protocol and identity come from the decode that won the label. An
		// incoming decode that lost does not replace an identity already stored.
		const takeWinner =
			facts?.kind === "decoded" &&
			winnerIdentity !== undefined &&
			winnerProtocol !== undefined &&
			(d.identity === undefined ||
				(ev.identity !== undefined &&
					ev.protocol === winnerProtocol &&
					sameIdentity(ev.identity, winnerIdentity)))
		if (
			takeWinner &&
			winnerIdentity !== undefined &&
			winnerProtocol !== undefined
		) {
			if (d.protocol !== winnerProtocol) {
				d.protocol = winnerProtocol
				d.family = label.family
				this.touch(d)
			}
			if (!sameIdentity(d.identity, winnerIdentity)) {
				d.identity = { kind: winnerIdentity.kind, value: winnerIdentity.value }
				this.touch(d)
			}
		} else if (
			facts?.kind !== "decoded" &&
			label.protocol !== "unknown" &&
			moreSpecific(d.protocol, label.protocol)
		) {
			d.protocol = label.protocol
			d.family = label.family
			this.touch(d)
		}
		// Memory-only checked evidence still needs durable provenance when its observation
		// is absent or later trimmed. A loose decode cannot verify a historical identity.
		if (
			isDsdFmeProtocol(ev.protocol) &&
			ev.contentVerified === true &&
			ev.protocol === d.protocol &&
			(d.identity === undefined || sameIdentity(d.identity, ev.identity)) &&
			d.contentVerified !== true
		) {
			this.normalizeCheckedContent(d)
			d.contentVerified = true
			this.touch(d)
		}
		const checked = !isDsdFmeProtocol(d.protocol) || this.hasCheckedContent(d)
		if (checked && ev.encrypted === true) {
			if (!d.encrypted) this.touch(d)
			d.encrypted = true
		}
		const m = checked ? ev.metadata : {}
		const md = d.metadata
		const merge = <T>(current: T[], values: readonly T[]): T[] => {
			const next = lruMerge(current, values)
			if (!sameList(next, current)) this.touch(d)
			return next
		}
		if (m.talkgroups !== undefined)
			md.talkgroups = merge(md.talkgroups, m.talkgroups)
		if (m.sources !== undefined) md.sources = merge(md.sources, m.sources)
		if (m.slots !== undefined) md.slots = merge(md.slots, m.slots)
		if (m.callsigns !== undefined)
			md.callsigns = merge(md.callsigns, m.callsigns)
		if (m.capcodes !== undefined) md.capcodes = merge(md.capcodes, m.capcodes)
		if (m.ismModels !== undefined)
			md.ismModels = merge(md.ismModels, m.ismModels)
		if (m.ctcssHz !== undefined) {
			if (!jsonEqual(md.ctcssHz, m.ctcssHz)) this.touch(d)
			md.ctcssHz = m.ctcssHz
		}
		// § 6.6: a confirm is the first accepted identity; evidence without one (accepted TG/SRC/encrypted only) is recorded but confirms nothing
		if (ev.identity !== undefined && label.confidence === "decoded") {
			const confidence = maxConfidence(
				d.confidence,
				d.confidenceCap !== undefined ? "candidate" : "decoded",
			)
			if (confidence !== d.confidence) this.touch(d)
			d.confidence = confidence
		}
		if (d.confidence === "decoded") {
			if (d.confidenceCap !== undefined || d.undecodedReason !== undefined)
				this.touch(d)
			delete d.confidenceCap
			delete d.undecodedReason
		}
		const at = iso(ev.at)
		if (at > d.lastSeenAt) {
			d.lastSeenAt = at
			this.touch(d)
		}
	}

	private coChannelEvidence(
		d: Discovery,
		ev: DecodeEvidence,
		cap: ConfidenceCap | undefined,
		carry?: Observation,
	): StoreChange | null {
		const family = familyOf(ev.protocol)
		const sourceId = d.sourceIds[0] ?? ""
		const existing = this.atKey(sourceId, d.frequencyKey).find(
			o =>
				this.effectiveLabel(o).family === family &&
				sameIdentity(o.identity, ev.identity),
		)
		if (existing !== undefined) {
			if (carry !== undefined && carry.discoveryId !== existing.id) {
				const from = this.discoveries.get(carry.discoveryId)
				if (from !== undefined) {
					const move = newOp()
					this.rehome(move, from, existing, carry)
					this.settle(move, existing)
					this.finish("evidence", move)
				}
			}
			return this.applyEvidenceTo(
				existing.id,
				ev,
				cap === undefined ? {} : { cap },
			)
		}
		const protect = new Set<string>([d.id])
		if (carry !== undefined) protect.add(carry.discoveryId)
		// The source (and the observation moving with it) stays for this split.
		// Evicting it first would drop the decode before the transfer.
		if (!this.makeRoom(protect)) return null
		const op = newOp()
		const twin = this.linkBeside(
			op,
			d,
			{
				protocol: ev.protocol,
				family,
				confidence: "activity",
			},
			iso(ev.at),
		)
		this.capInto(twin, cap)
		this.decodeInto(twin, ev)
		if (carry !== undefined) {
			const from = this.discoveries.get(carry.discoveryId)
			if (from !== undefined && from.id !== twin.id)
				this.rehome(op, from, twin, carry)
		}
		this.invalidateLabel(twin.id)
		this.invalidateLabel(d.id)
		const id = this.settle(op, twin)
		this.finish("evidence", op)
		return op.changes.get(id) ?? "created"
	}

	/**
	 * A co-channel discovery beside `partner`. The persisted label is `label`
	 * (a decode persists its protocol; a sink split persists nothing and passes
	 * the unknown label). Journaled as a create plus the partner link.
	 */
	private linkBeside(
		op: Op,
		partner: Discovery,
		label: EvidenceLabel,
		at: string,
	): Discovery {
		const twin: Discovery = {
			id: `d_${this.newId()}`,
			frequencyHz: partner.frequencyHz,
			frequencyKey: partner.frequencyKey,
			measuredOffsetHz: partner.measuredOffsetHz,
			bandwidthHz: partner.bandwidthHz,
			protocol: label.protocol,
			family: label.family,
			class: partner.class,
			confidence: label.confidence,
			encrypted: false,
			coChannel: [],
			firstSeenAt: at,
			lastSeenAt: at,
			observationCount: 0,
			airtimeMs: 0,
			signal: plainCopy(partner.signal),
			metadata: emptyMetadata(),
			sourceIds: [...partner.sourceIds],
			jobIds: [...partner.jobIds],
			tuningTrust: partner.tuningTrust,
			evidence: { recordings: 0, psd: false, iq: false },
		}
		this.insertDiscovery(twin)
		const live = this.discoveries.get(partner.id)
		if (live !== undefined) {
			twin.coChannel = [live.id]
			live.coChannel = appendMissing(live.coChannel, [twin.id])
			this.syncProofWatch(twin)
			this.syncProofWatch(live)
			op.discoveries.add(live.id)
			mark(op, live.id, "updated")
		}
		op.discoveries.add(twin.id)
		mark(op, twin.id, "created")
		return twin
	}

	/**
	 * Moves one observation onto `to`. Count, airtime and the sighting move
	 * with it: the destination follows the same chronological rules as a new
	 * observation, and the source's sighting is rebuilt from what remains.
	 * A move the destination window trims in this op is still journaled, plus
	 * an explicit removal, because `finish` only copies indexed observations.
	 */
	private rehome(op: Op, from: Discovery, to: Discovery, o: Observation): void {
		if (o.discoveryId !== from.id || from.id === to.id) return
		const air = recordDuration(o)
		this.unlinkObservation(o)
		from.observationCount = Math.max(0, from.observationCount - 1)
		from.airtimeMs = Math.max(0, from.airtimeMs - air)
		this.releaseSeen(from, o)
		this.touch(from)
		o.discoveryId = to.id
		this.putObservation(o)
		to.observationCount += 1
		to.airtimeMs += air
		to.jobIds = appendMissing(to.jobIds, o.jobIds)
		to.sourceIds = appendMissing(to.sourceIds, [o.sourceId])
		this.applyObservationSeen(to, o)
		this.touch(to)
		this.refresh(from)
		this.refresh(to)
		this.applyMajority(from)
		this.applyMajority(to)
		if (!this.observationIndex.has(o.id)) {
			op.removedObservations.push(o.id)
			op.trimmedMoves.push(plainCopy(o))
		}
		op.observations.add(o.id)
		op.discoveries.add(from.id)
		op.discoveries.add(to.id)
		mark(op, from.id, "updated")
		mark(op, to.id, "updated")
	}

	/** Sighting rules for one stored observation, matching `absorbStats`. */
	private applyObservationSeen(d: Discovery, o: Observation): void {
		this.markDirty(d.id)
		if (o.startedAt < d.firstSeenAt) {
			d.firstSeenAt = o.startedAt
			this.touch(d)
		}
		const endedAt = o.endedAt ?? o.startedAt
		const stats = signalOf(o)
		if (endedAt >= d.lastSeenAt) {
			if (
				endedAt !== d.lastSeenAt ||
				!jsonEqual(d.signal.last, stats) ||
				d.tuningTrust !== o.tuningTrust
			)
				this.touch(d)
			d.lastSeenAt = endedAt
			d.signal.last = stats
			d.tuningTrust = o.tuningTrust
		}
		// DQ 3.3: an overload-flagged observation never raises best, moved or not.
		if (!o.flags.overload && stats.snrDb > d.signal.best.snrDb) {
			d.signal.best = { ...stats }
			this.touch(d)
		}
	}

	/**
	 * Drops `moved` from the source's sighting. Count and airtime are already
	 * transferred. Fields the moved observation was not holding stay, including
	 * a last-seen time a later decode set on its own.
	 */
	private releaseSeen(d: Discovery, moved: Observation): void {
		const list = this.byDiscovery.get(d.id)
		if (list === undefined || list.length === 0) return
		const movedEnd = moved.endedAt ?? moved.startedAt
		const movedStats = signalOf(moved)
		let first = ""
		let lastAt = ""
		let last: Observation | undefined
		let best: SignalStats | undefined
		for (const o of list) {
			if (first === "" || o.startedAt < first) first = o.startedAt
			const end = o.endedAt ?? o.startedAt
			if (last === undefined || end >= lastAt) {
				lastAt = end
				last = o
			}
			const stats = signalOf(o)
			if (o.flags.overload) continue
			if (best === undefined || stats.snrDb > best.snrDb) best = stats
		}
		if (last === undefined) return
		if (d.firstSeenAt === moved.startedAt && first !== d.firstSeenAt) {
			d.firstSeenAt = first
			this.touch(d)
		}
		if (d.lastSeenAt === movedEnd) {
			const lastStats = signalOf(last)
			if (
				d.lastSeenAt !== lastAt ||
				!jsonEqual(d.signal.last, lastStats) ||
				d.tuningTrust !== last.tuningTrust
			) {
				d.lastSeenAt = lastAt
				d.signal.last = lastStats
				d.tuningTrust = last.tuningTrust
				this.touch(d)
			}
		}
		if (
			best !== undefined &&
			jsonEqual(d.signal.best, movedStats) &&
			!jsonEqual(d.signal.best, best)
		) {
			d.signal.best = best
			this.touch(d)
		}
	}

	/** Newest observation on `d` whose stored decode is this evidence. */
	private carryingObservation(
		d: Discovery,
		ev: DecodeEvidence,
	): Observation | undefined {
		let found: Observation | undefined
		for (const o of this.byDiscovery.get(d.id) ?? []) {
			for (const row of o.decode ?? []) {
				if (
					row.protocol === ev.protocol &&
					row.at === ev.at &&
					sameIdentity(row.identity, ev.identity)
				)
					found = o
			}
		}
		return found
	}

	/**
	 * The observation to move when its own proof, not a sibling's, is the
	 * family `d` cannot keep. A lone observation stays: its proof is the
	 * discovery's proof.
	 */
	private observationToSplit(
		d: Discovery,
		ev: DecodeEvidence,
	): Observation | undefined {
		const carry = this.carryingObservation(d, ev)
		if (carry === undefined) return undefined
		const obsFamily = this.observationAssessment(carry).label.family
		const rest = this.establishedFamily(d, carry.id)
		return familiesIncompatible(obsFamily, rest) ? carry : undefined
	}

	/**
	 * Observation to move onto a co-channel twin. A family split moves the
	 * observation whose own proof this discovery cannot keep. An accepted
	 * identity that conflicts with the discovery's identity moves too, unless
	 * that same observation still confirms the discovery.
	 */
	private observationToMove(
		d: Discovery,
		ev: DecodeEvidence,
	): Observation | undefined {
		const split = this.observationToSplit(d, ev)
		if (split !== undefined) return split
		if (d.identity === undefined || ev.identity === undefined) return undefined
		if (sameIdentity(ev.identity, d.identity) && ev.protocol === d.protocol)
			return undefined
		const carry = this.carryingObservation(d, ev)
		if (carry === undefined || this.holdsMatchingIdentity(d, carry))
			return undefined
		return carry
	}

	/**
	 * Family the rest of `d` already established, ignoring `skipId`. A sibling
	 * observation's own proof counts, including a decode stored for another
	 * identity. When no sibling names one, a co-channel decode this discovery
	 * claims does. Unknown when nothing does, so a lone observation is not split.
	 */
	private establishedFamily(d: Discovery, skipId: string): ProtocolFamily {
		const own: ScannerProof[] = []
		for (const observation of this.byDiscovery.get(d.id) ?? []) {
			if (observation.id === skipId) continue
			const proof = this.observationAssessment(observation).proof
			if (proof !== null) own.push(proof)
		}
		const bestOwn = strongestKnownProof(own)
		if (bestOwn !== null) return this.labelOfProof(d, bestOwn).family
		const foreign: ScannerProof[] = []
		for (const source of this.proofSources(d)) {
			if (!source.foreign || source.observation.id === skipId) continue
			const proof = this.observationAssessment(source.observation).proof
			if (proof !== null && this.proofCounts(d, proof)) foreign.push(proof)
		}
		const bestForeign = strongestKnownProof(foreign)
		if (bestForeign === null) return "unknown"
		return this.labelOfProof(d, bestForeign).family
	}

	/**
	 * A sink proof named a family the rest of the discovery cannot share.
	 * The observation moves to a linked discovery. Trial rows are not journaled.
	 * Returns false when nothing moved, so the caller publishes in place.
	 */
	private relocateIncompatible(observation: Observation): boolean {
		const d = this.discoveries.get(observation.discoveryId)
		if (d === undefined) return false
		const assessed = this.observationAssessment(observation)
		if (assessed.proof === null) return false
		const rest = this.establishedFamily(d, observation.id)
		if (!familiesIncompatible(assessed.label.family, rest)) return false
		const family = assessed.label.family
		const sourceId = d.sourceIds[0] ?? ""
		const existing = this.atKey(sourceId, d.frequencyKey).find(
			o =>
				o.id !== d.id &&
				this.effectiveLabel(o).family === family &&
				o.identity === undefined,
		)
		if (existing !== undefined) {
			const op = newOp()
			this.rehome(op, d, existing, observation)
			this.settle(op, existing)
			this.finish("evidence", op)
			return true
		}
		// Same protection as a decode split: do not evict the card being split.
		if (!this.makeRoom(new Set([d.id]))) return false
		const from = this.discoveries.get(d.id)
		if (
			from === undefined ||
			this.observationIndex.get(observation.id) === undefined
		)
			return false
		const op = newOp()
		const twin = this.linkBeside(op, from, UNKNOWN_LABEL, observation.startedAt)
		this.rehome(op, from, twin, observation)
		this.invalidateLabel(twin.id)
		this.invalidateLabel(from.id)
		this.settle(op, twin)
		this.finish("evidence", op)
		return true
	}

	/** Records a leak/intermod cap that arrives with a decode, before the decode is applied (§ 6.2, P8). */
	private capInto(d: Discovery, cap: ConfidenceCap | undefined): void {
		if (cap === undefined || d.confidence === "decoded") return
		this.markDirty(d.id)
		if (d.confidenceCap !== cap) this.touch(d)
		d.confidenceCap = cap
		if (rank(d.confidence) > rank("candidate")) {
			d.confidence = "candidate"
			this.touch(d)
		}
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
		const rasters = gridFor(this.rastersFor(sourceId, centreHz), obwHz)
		const correction = this.corrections.get(sourceId) ?? 0
		const snap = snapToRaster(centreHz, rasters, correction)
		if (!snap.snapped) {
			// (DQ 1.16): off every raster's tolerance, the observation keys to the
			// nearest channel of the finest channel raster, so one emitter whose measured
			// centre drifts within its channel stays one record.
			const ch = channelOf(
				centreHz - correction,
				gridFor(this.channelRastersFor(sourceId, centreHz), obwHz),
			)
			if (ch !== null)
				return {
					frequencyHz: ch,
					key: frequencyKey(ch, true, obwHz),
					offRaster: true,
				}
		}
		return {
			frequencyHz: snap.hz,
			key: frequencyKey(snap.hz, snap.snapped, obwHz),
			offRaster: rasters.length > 0 && !snap.snapped,
		}
	}

	/**
	 * WG11 req 3.2: medians over the last 64 observations, cached until that discovery's observation
	 * list changes (`putObservation`, `unlinkObservation`, `removeDiscovery` drop the entry).
	 */
	private mediansOf(id: string): Medians | undefined {
		const cached = this.medians.get(id)
		if (cached !== undefined) return cached
		const recent = (this.byDiscovery.get(id) ?? []).slice(-MEDIAN_WINDOW)
		if (recent.length === 0) return undefined
		const votes = new Map<ScannerClass, { n: number; last: number }>()
		for (let i = 0; i < recent.length; i++) {
			const o = recent[i]
			if (o === undefined || o.flags.edge) continue
			const cls = voteOf(o)
			if (cls === undefined || cls === "unknown") continue
			const v = votes.get(cls)
			if (v === undefined) votes.set(cls, { n: 1, last: i })
			else {
				v.n += 1
				v.last = i
			}
		}
		let majority: ScannerClass | undefined
		let top = { n: 0, last: -1 }
		for (const [cls, v] of votes)
			if (v.n > top.n || (v.n === top.n && v.last > top.last)) {
				majority = cls
				top = v
			}
		let obwMin = Number.POSITIVE_INFINITY
		let obwMax = Number.NEGATIVE_INFINITY
		for (const o of recent) {
			const w = o.obwHz
			if (!Number.isFinite(w)) continue
			if (w < obwMin) obwMin = w
			if (w > obwMax) obwMax = w
		}
		const fresh: Medians = {
			centre: median(recent.map(o => o.centerHz)),
			obw: median(recent.map(o => o.obwHz)),
			obwMin: Number.isFinite(obwMin) ? obwMin : Number.NaN,
			obwMax: Number.isFinite(obwMax) ? obwMax : Number.NaN,
			peak: median(recent.map(o => o.peakDbfs)),
			count: recent.length,
			majority,
		}
		this.medians.set(id, fresh)
		return fresh
	}

	/** DQ 3.1, 9.4: an observation against a record; null when undecided (3.5). */
	private obsCompatible(d: Discovery, obs: ObservationInput): boolean | null {
		if (d.anchor === "decode") return false
		const m = this.mediansOf(d.id)
		if (m === undefined) return null
		const peak = obs.track.peakDbfs
		const obw = obs.track.obwHz
		if (m.count >= DQ_MIN_HISTORY_OBS)
			return compatibleValues(m.peak, m.obw, peak, obw)
		// 9.4: a young record (1 or 2) is tested observation by observation, in place.
		const list = this.byDiscovery.get(d.id)
		if (list === undefined) return null
		let decided = false
		for (
			let i = Math.max(0, list.length - MEDIAN_WINDOW);
			i < list.length;
			i++
		) {
			const o = list[i]
			if (o === undefined) continue
			const c = compatibleValues(o.peakDbfs, o.obwHz, peak, obw)
			if (c === false) return false
			if (c === true) decided = true
		}
		return decided ? true : null
	}

	private recentOf(id: string): readonly Observation[] {
		return (this.byDiscovery.get(id) ?? []).slice(-MEDIAN_WINDOW)
	}

	/**
	 * DQ 3.3 at a merge: may `from`'s best stand? Not when the stored observation carrying it is
	 * overload-flagged, nor (with `into` established) when `into`'s medians do not find it
	 * compatible. A best no stored observation carries (trimmed) stands as before.
	 */
	private bestEligible(from: Discovery, into?: Discovery): boolean {
		const best = from.signal.best
		const carrier = (this.byDiscovery.get(from.id) ?? []).find(
			o => o.snrDb === best.snrDb && o.peakDbfs === best.peakDbfs,
		)
		if (carrier === undefined) return true
		if (carrier.flags.overload) return false
		if (into === undefined) return true
		const m = this.mediansOf(into.id)
		if (m === undefined || m.count < DQ_MIN_HISTORY_OBS) return true
		return (
			compatible(sideOf(m), {
				peakDbfs: carrier.peakDbfs,
				obwHz: carrier.obwHz,
				count: Number.POSITIVE_INFINITY,
			}) === true
		)
	}

	/** DQ 3.1, 3.2: two records' medians (see `recordsCompatible`). */
	private pairCompatible(a: Discovery, b: Discovery): boolean | null {
		if (a.anchor === "decode" || b.anchor === "decode") return false
		const ma = this.mediansOf(a.id)
		const mb = this.mediansOf(b.id)
		if (ma === undefined || mb === undefined) return null
		const young = (id: string, m: Medians): readonly Observation[] =>
			m.count >= DQ_MIN_HISTORY_OBS ? [] : this.recentOf(id)
		return recordsCompatible(
			{ medians: sideOf(ma), observations: young(a.id, ma) },
			{ medians: sideOf(mb), observations: young(b.id, mb) },
		)
	}

	/**
	 * DQ 3.3, 3.5: may `obs` raise `signal.best`? Judged against the medians before it joined.
	 * Never when overload-flagged or non-finite; with 3 or more observations only when 3.1 says
	 * compatible (not refused, not undecided).
	 */
	private raisesBest(d: Discovery, obs: ObservationInput): boolean {
		const overload: unknown = (
			obs.track.flags as { overload?: unknown } | undefined
		)?.overload
		if (overload !== false || !Number.isFinite(obs.track.snrDb)) return false
		const m = this.mediansOf(d.id)
		if (m === undefined || m.count < DQ_MIN_HISTORY_OBS) return true
		return this.obsCompatible(d, obs) === true
	}

	private medianCentre(d: Discovery): number {
		return this.mediansOf(d.id)?.centre ?? d.frequencyHz + d.measuredOffsetHz
	}

	/** Recomputes frequency, key, offset and bandwidth from the last 64 observations. */
	private refresh(d: Discovery): void {
		if (d.anchor === "decode") return
		this.markDirty(d.id)
		const m = this.mediansOf(d.id)
		const centre = m?.centre ?? d.frequencyHz + d.measuredOffsetHz
		const obw = m?.obw ?? d.bandwidthHz
		const place = this.placement(d.sourceIds[0] ?? "", centre, obw)
		const frequencyHz = Math.round(place.frequencyHz)
		// `|| 0`: a median centre 0.5 Hz below the raster rounds to -0, which JSON persists as 0 (P13).
		const measuredOffsetHz = Math.round(centre - place.frequencyHz) || 0
		const bandwidthHz = Math.round(obw)
		if (
			frequencyHz !== d.frequencyHz ||
			place.key !== d.frequencyKey ||
			measuredOffsetHz !== d.measuredOffsetHz ||
			bandwidthHz !== d.bandwidthHz
		)
			this.touch(d)
		d.frequencyHz = frequencyHz
		d.frequencyKey = place.key
		d.measuredOffsetHz = measuredOffsetHz
		d.bandwidthHz = bandwidthHz
		this.pruneLinks(d)
	}

	/** DQ 2.3: `d`'s association tolerance around its median centre. */
	private linkWindow(d: Discovery): { centre: number; tol: number } {
		const m = this.mediansOf(d.id)
		const centre = m?.centre ?? d.frequencyHz + d.measuredOffsetHz
		const tol = this.toleranceHz(
			d.sourceIds[0] ?? "",
			centre,
			m?.obw ?? d.bandwidthHz,
		)
		return { centre, tol }
	}

	/** Remembers a distance-pruned pair both ways (memory only, at most LINKS_MAX per record). */
	private rememberUnlinked(a: string, b: string): void {
		for (const [x, y] of [
			[a, b],
			[b, a],
		] as const) {
			let set = this.unlinked.get(x)
			if (set === undefined) {
				set = new Set()
				this.unlinked.set(x, set)
			}
			set.delete(y)
			set.add(y)
			if (set.size > LINKS_MAX) {
				const oldest = set.values().next()
				if (oldest.done !== true) set.delete(oldest.value)
			}
		}
	}

	private forgetUnlinked(a: string, b: string): void {
		this.unlinked.get(a)?.delete(b)
		this.unlinked.get(b)?.delete(a)
	}

	/**
	 * DQ 2.3: keeps partners that exist and whose median centre lies within `d`'s association
	 * tolerance, nearest first (ties: the more recently seen first), at most `DQ_CO_CHANNEL_MAX`.
	 * Every dropped partner forgets `d` too (reciprocal); both proof watches follow. A partner
	 * pruned for distance is re-linked (both ways) once both records' tolerances hold again.
	 */
	private pruneLinks(d: Discovery, relink = true): void {
		const links = Array.isArray(d.coChannel) ? d.coChannel : NO_LINKS
		const away = relink ? this.unlinked.get(d.id) : undefined
		if (links.length === 0 && (away === undefined || away.size === 0)) return
		const { centre, tol } = this.linkWindow(d)
		const rows: { id: string; seen: string; dist: number }[] = []
		const far: string[] = []
		const seen = new Set<string>()
		for (const id of links) {
			if (id === d.id || seen.has(id)) continue
			seen.add(id)
			const p = this.discoveries.get(id)
			if (p === undefined) continue
			const dist = Math.abs(this.medianCentre(p) - centre)
			if (!(dist <= tol)) {
				far.push(id)
				continue
			}
			rows.push({ id, seen: p.lastSeenAt, dist })
		}
		for (const id of away ?? []) {
			if (id === d.id || seen.has(id)) continue
			const p = this.discoveries.get(id)
			if (p === undefined || p.sourceIds[0] !== d.sourceIds[0]) continue
			const back = this.linkWindow(p)
			const dist = Math.abs(back.centre - centre)
			if (!(dist <= tol) || !(dist <= back.tol)) continue
			rows.push({ id, seen: p.lastSeenAt, dist })
		}
		rows.sort(
			(a, b) =>
				a.dist - b.dist ||
				compareText(b.seen, a.seen) ||
				compareText(a.id, b.id),
		)
		const kept = rows.slice(0, DQ_CO_CHANNEL_MAX).map(r => r.id)
		if (sameList(kept, links)) return
		const keptSet = new Set(kept)
		const before = new Set(links)
		// A link is a proof read both ways: arm both sides' readers, then drop their caches.
		this.armWatchers(d.id)
		for (const id of new Set([...links, ...kept]))
			if (id !== d.id && this.discoveries.has(id)) this.armWatchers(id)
		this.invalidateLabel(d.id)
		d.coChannel = kept
		this.touch(d)
		this.markDirty(d.id)
		this.syncProofWatch(d)
		this.linkTouched.add(d.id)
		for (const id of far) this.rememberUnlinked(d.id, id)
		const relinked: Discovery[] = []
		for (const id of new Set([...links, ...kept])) {
			if (id === d.id) continue
			const p = this.discoveries.get(id)
			if (p === undefined) continue
			const keep = keptSet.has(id)
			const has = p.coChannel.includes(d.id)
			if (keep && before.has(id) && has) continue
			if (!keep && !has) continue
			if (keep) {
				this.forgetUnlinked(d.id, id)
				p.coChannel = appendMissing(p.coChannel, [d.id])
				relinked.push(p)
			} else p.coChannel = p.coChannel.filter(x => x !== d.id)
			this.invalidateLabel(p.id)
			this.touch(p)
			this.markDirty(p.id)
			this.syncProofWatch(p)
			this.linkTouched.add(p.id)
		}
		// A re-linked partner keeps its own cap (no further re-link from inside this call).
		for (const p of relinked) this.pruneLinks(p, false)
	}

	/**
	 * DQ 3.2: a settle refused on compatibility lists both records as co-channel partners (bounded
	 * by 2.3 through `pruneLinks`).
	 */
	private linkPair(op: Op, a: Discovery, b: Discovery): void {
		if (a.anchor === "decode" || b.anchor === "decode") return
		if (a.coChannel.includes(b.id) && b.coChannel.includes(a.id)) return
		this.armWatchers(a.id)
		this.armWatchers(b.id)
		this.invalidateLabel(a.id)
		this.invalidateLabel(b.id)
		a.coChannel = appendMissing(a.coChannel, [b.id])
		b.coChannel = appendMissing(b.coChannel, [a.id])
		for (const d of [a, b]) {
			this.touch(d)
			this.markDirty(d.id)
			this.syncProofWatch(d)
			op.discoveries.add(d.id)
			mark(op, d.id, "updated")
		}
		this.pruneLinks(a)
		this.pruneLinks(b)
	}

	private atKey(sourceId: string, key: string): Discovery[] {
		const out: Discovery[] = []
		this.syncIndex()
		for (const id of this.byKey.get(`${sourceId}\u0000${key}`) ?? []) {
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
			let other: Discovery | undefined
			for (const o of this.atKey(d.sourceIds[0] ?? "", d.frequencyKey)) {
				if (
					o.id === d.id ||
					this.associationFamily(o) !== this.associationFamily(d) ||
					!sameIdentity(o.identity, d.identity)
				)
					continue
				// DQ 3.2, 9.4, 9.5: an incompatible or differently decoded pair stays apart and is
				// linked as co-channel.
				if (this.decodedConflict(d, o) || this.pairCompatible(d, o) === false) {
					this.linkPair(op, d, o)
					continue
				}
				other = o
				break
			}
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

	private absorb(
		op: Op,
		keep: Discovery,
		drop: Discovery,
		planned = false,
	): void {
		if (keep.anchor === "decode" || drop.anchor === "decode") return
		// DQ 3.2: any caller is covered; an incompatible pair is never merged. DQ 7.5: a planned
		// consolidation pair was checked on the frozen values (3.1 included) when the plan was made;
		// re-checking against medians the group's earlier members already moved would make the
		// result depend on the apply order and a resumed plan differ from an uninterrupted one.
		if (
			!planned &&
			(this.decodedConflict(keep, drop) ||
				this.pairCompatible(keep, drop) === false)
		)
			return
		// DQ 3.3: the better of the two bests, but never one an overload observation set.
		// The dropped record's best must also pass 3.3 against the survivor's medians.
		const keepBestOk = this.bestEligible(keep)
		const dropBestOk = this.bestEligible(drop, keep)
		const readers = [...this.watcherIds(keep.id), ...this.watcherIds(drop.id)]
		this.armWatchers(keep.id)
		this.armWatchers(drop.id)
		this.dropReaders(readers)
		this.invalidateLabel(keep.id)
		this.invalidateLabel(drop.id)
		this.markDirty(keep.id)
		this.markDirty(drop.id)
		this.normalizeCheckedContent(keep)
		this.normalizeCheckedContent(drop)
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
		if (
			dropBestOk &&
			(!keepBestOk || drop.signal.best.snrDb > keep.signal.best.snrDb)
		)
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
		if (
			keep.identity === undefined &&
			drop.identity !== undefined &&
			(!this.hasCheckedContent(keep) || this.hasCheckedContent(drop))
		) {
			keep.identity = drop.identity
		}
		if (
			keep.confidence !== "decoded" &&
			(drop.confidence === "decoded" ||
				moreSpecific(keep.protocol, drop.protocol))
		) {
			keep.protocol = drop.protocol
			keep.family = drop.family
			if (drop.class !== "unknown") keep.class = drop.class
		}
		// Different identities do not transfer verification; their checked TGs may be discarded.
		if (
			drop.contentVerified === true &&
			drop.protocol === keep.protocol &&
			sameIdentity(keep.identity, drop.identity)
		)
			keep.contentVerified = true
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
		this.syncProofWatch(keep)
		for (const partnerId of drop.coChannel) {
			const partner = this.discoveries.get(partnerId)
			if (partner === undefined || partner.id === keep.id) continue
			partner.coChannel = appendMissing(
				partner.coChannel.filter(id => id !== drop.id),
				[keep.id],
			)
			this.syncProofWatch(partner)
			op.discoveries.add(partner.id)
			mark(op, partner.id, "updated")
		}
		this.adoptAliases(op, keep.id, drop.id)
		this.absorbedIndex.record(drop.id, keep.id)
		this.removeDiscovery(drop.id)
		op.discoveries.delete(drop.id)
		op.deleted.push(drop.id)
		op.merged.push([keep.id, drop.id])
		mark(op, drop.id, "deleted")
		mark(op, keep.id, "merged")
		op.discoveries.add(keep.id)
		this.refresh(keep)
		this.applyMajority(keep)
		this.dropReaders(readers)
		this.invalidateLabel(keep.id)
	}

	/** DQ 3.4: re-applies the majority class after observations moved (merge, rehome). */
	private applyMajority(d: Discovery): void {
		const majority = this.mediansOf(d.id)?.majority
		if (
			majority === undefined ||
			d.confidence === "decoded" ||
			d.class === majority
		)
			return
		this.markDirty(d.id)
		this.touch(d)
		d.class = majority
	}

	/**
	 * WG10 req 1.5: `drop`'s folder (and its own aliases) become `keep`'s aliases, journaled with
	 * the merge; past the bound the oldest is released (an orphan folder), warned as a count.
	 */
	private adoptAliases(op: Op, keep: string, drop: string): void {
		const released = this.aliasTable.adopt(keep, drop)
		op.aliases.add(keep)
		op.aliases.add(drop)
		if (released === 0) return
		const log =
			this.injectedLog ??
			(fallbackLog ??= createComponentLogger(
				createLogger({ level: "info" }),
				"DiscoveryStore",
			))
		log.warn(
			{ released },
			"Discovery merge aliases over the bound; the oldest were released",
		)
	}

	/**
	 * Evicts until one more discovery fits (several after `setLimits` lowered the bound); one "evict"
	 * entry. WG10 req 1.6: the evicted discoveries are reported (`evicted`) after the entry.
	 * `protect` is the discovery being split and the card that holds the moving
	 * observation. They are not victims for this call. When nothing else can
	 * go, the caller keeps the observation where it is.
	 */
	private makeRoom(protect?: ReadonlySet<string>): boolean {
		if (this.discoveries.size < this.maxDiscoveries) return true
		const op = newOp()
		let fits = true
		const evicted: Discovery[] = []
		while (this.discoveries.size >= this.maxDiscoveries) {
			const victim = this.evictionVictim(protect)
			if (victim === undefined) {
				fits = false
				break
			}
			evicted.push(plainCopy(victim)) // a copy for listeners, no structuredClone (req 3.4)
			this.deleteInto(op, victim)
		}
		this.finish("evict", op)
		// band inspection UX req 3.3: the copies leave at the revision of their removal
		for (const d of evicted) d.revision = this.revisionSeq
		if (evicted.length > 0) this.emit("evicted", evicted)
		if (fits) this.keptBlockedWarned = 0
		else this.warnKeptBlocked()
		return fits
	}

	/**
	 * WG9 R2: eviction found no victim and kept recordings held some otherwise evictable
	 * discoveries: one warn with the count (fixed text, no ids), again only when it changes.
	 */
	private warnKeptBlocked(): void {
		let held = 0
		for (const d of this.discoveries.values()) {
			if (!this.holdsKept(d.id)) continue
			if (this.evictionRank(d) === undefined) continue
			held++
		}
		if (held === 0 || held === this.keptBlockedWarned) return
		this.keptBlockedWarned = held
		const log =
			this.injectedLog ??
			(fallbackLog ??= createComponentLogger(
				createLogger({ level: "info" }),
				"DiscoveryStore",
			))
		log.warn(
			{ heldByKept: held },
			"Discovery eviction cannot make room: discoveries hold kept recordings",
		)
	}

	/**
	 * Rank used to choose a capacity victim: the proof-implied confidence.
	 * Undefined when the discovery is not a victim. A stored `decoded` record
	 * stays (a later sink proof may show a weaker label), and so does a discovery
	 * whose shown confidence is `decoded`. `keep` and lockout stay too. A kept
	 * recording is a separate hold, checked by the caller.
	 */
	private evictionRank(d: Discovery): number | undefined {
		if (
			d.confidence === "decoded" ||
			d.operator?.keep === true ||
			d.operator?.lockout === true
		)
			return undefined
		const confidence = this.publishedLabel(d).confidence
		if (confidence === "decoded") return undefined
		return rank(confidence)
	}

	/**
	 * Lowest effective confidence, then oldest `lastSeenAt` (ties: smaller id).
	 * Never a stored or shown `decoded` discovery, `keep`, lockout, or a kept
	 * WG2: recording (evicting a lockout would silently put it back into sweeps).
	 */
	private evictionVictim(protect?: ReadonlySet<string>): Discovery | undefined {
		let victim: Discovery | undefined
		let victimRank = Number.POSITIVE_INFINITY
		for (const d of this.discoveries.values()) {
			if (protect !== undefined && protect.has(d.id)) continue
			if (this.holdsKept(d.id)) continue
			const next = this.evictionRank(d)
			if (next === undefined) continue
			if (
				victim === undefined ||
				next < victimRank ||
				(next === victimRank &&
					(d.lastSeenAt < victim.lastSeenAt ||
						(d.lastSeenAt === victim.lastSeenAt && d.id < victim.id)))
			) {
				victim = d
				victimRank = next
			}
		}
		return victim
	}

	private deleteInto(op: Op, d: Discovery): void {
		const readers = this.watcherIds(d.id)
		this.armWatchers(d.id)
		this.dropReaders(readers)
		this.invalidateLabel(d.id)
		for (const partnerId of d.coChannel) {
			const partner = this.discoveries.get(partnerId)
			if (partner === undefined) continue
			partner.coChannel = partner.coChannel.filter(id => id !== d.id)
			this.syncProofWatch(partner)
			op.discoveries.add(partner.id)
			mark(op, partner.id, "updated")
		}
		this.removeDiscovery(d.id)
		this.dropReaders(readers)
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
		// DQ 3.4: persisted vote; absent on edge observations and on records written before DQ.
		if (!t.flags.edge)
			(record as StoredObservation).classVote = obs.classification.class
			// Scanner-redesign 3.11: persisted `short` input of the hint (absent on older records).
		;(record as StoredObservation).short =
			t.flags.burst || t.blocks <= SHORT_TRACK_BLOCKS
		if (t.acf30 !== undefined) record.acf30 = t.acf30
		if (t.acf60 !== undefined) record.acf60 = t.acf60
		if (obs.hopIndex !== undefined) record.hopIndex = obs.hopIndex
		return record
	}

	private insertDiscovery(d: Discovery): void {
		const previous = this.discoveries.get(d.id)
		let members = this.members.get(d.id)
		if (members === undefined) {
			members = new Set()
			this.members.set(d.id, members)
		}
		if (previous !== undefined)
			for (const s of previous.sourceIds) {
				this.bySource.get(s)?.delete(d.id)
				members.delete(s)
			}
		if (previous?.anchor === "decode")
			this.decodeAnchors.delete(
				decodeAnchorKey(
					previous.sourceIds[0]!,
					previous.protocol,
					previous.frequencyHz,
				),
			)
		if (d.anchor === "decode") {
			d.aircraftCount = this.anchorWindows.get(d.id)?.size ?? 0
			delete d.identity
		}
		this.discoveries.set(d.id, d)
		if (d.anchor === "decode")
			this.decodeAnchors.set(
				decodeAnchorKey(d.sourceIds[0]!, d.protocol, d.frequencyHz),
				d.id,
			)
		for (const s of d.sourceIds) {
			let set = this.bySource.get(s)
			if (set === undefined) {
				set = new Set()
				this.bySource.set(s, set)
			}
			set.add(d.id)
			members.add(s)
		}
		this.markDirty(d.id)
		this.syncProofWatch(d)
	}

	private coChannelIds(d: Discovery): readonly string[] {
		const links = d.coChannel
		if (!Array.isArray(links) || links.length === 0) return NO_LINKS
		return links.includes(d.id) ? links.filter(id => id !== d.id) : links
	}

	private watcherIds(ownerId: string): readonly string[] {
		const watchers = this.proofWatchers.get(ownerId)
		if (watchers === undefined || watchers.size === 0) return NO_LINKS
		return [...watchers]
	}

	/** Records each co-channel reader's current proof. Returns ids newly armed. */
	private armWatchers(ownerId: string): string[] {
		if (this.proofQuiet > 0) return []
		const watchers = this.proofWatchers.get(ownerId)
		if (watchers === undefined || watchers.size === 0) return []
		const added: string[] = []
		for (const id of watchers) {
			if (id === ownerId || this.pendingProof.has(id)) continue
			const discovery = this.discoveries.get(id)
			if (discovery === undefined) continue
			this.pendingProof.set(id, this.discoveryView(discovery).proof)
			added.push(id)
		}
		return added
	}

	private disarm(ids: readonly string[]): void {
		for (const id of ids) this.pendingProof.delete(id)
	}

	private dropReaders(ids: readonly string[]): void {
		for (const id of ids) this.invalidateLabel(id)
	}

	private dropWatcherCaches(ownerId: string): void {
		const watchers = this.proofWatchers.get(ownerId)
		if (watchers === undefined || watchers.size === 0) return
		for (const id of watchers) this.invalidateLabel(id)
	}

	/** One `updated` per armed reader whose proof or level changed, skipping ids already notified. */
	private emitPending(
		pending: ReadonlyMap<string, ScannerProof | null>,
		skip: ReadonlySet<string>,
	): void {
		for (const [id, prev] of pending) {
			if (skip.has(id)) continue
			const discovery = this.discoveries.get(id)
			if (discovery === undefined) continue
			this.emitProofChange(id, prev, this.discoveryView(discovery).proof)
		}
	}

	private flushPending(skip: ReadonlySet<string>): void {
		if (this.pendingProof.size === 0) return
		const pending = this.pendingProof
		this.pendingProof = new Map()
		this.emitPending(pending, skip)
	}

	private watchProof(watcher: string, partner: string): void {
		let set = this.proofWatchers.get(partner)
		if (set === undefined) {
			set = new Set()
			this.proofWatchers.set(partner, set)
		}
		set.add(watcher)
	}

	private unwatchProof(watcher: string, partner: string): void {
		const set = this.proofWatchers.get(partner)
		if (set === undefined) return
		set.delete(watcher)
		if (set.size === 0) this.proofWatchers.delete(partner)
	}

	/** Rebuilds reverse links for `d` from its current co-channel list. */
	private syncProofWatch(d: Discovery): void {
		const next = this.coChannelIds(d)
		const prev = this.proofWatched.get(d.id) ?? NO_LINKS
		if (sameList(prev, next)) return
		const nextSet = new Set(next)
		for (const id of prev) if (!nextSet.has(id)) this.unwatchProof(d.id, id)
		const prevSet = new Set(prev)
		for (const id of next) if (!prevSet.has(id)) this.watchProof(d.id, id)
		if (next.length === 0) this.proofWatched.delete(d.id)
		else this.proofWatched.set(d.id, next)
	}

	private clearProofWatch(id: string): void {
		const prev = this.proofWatched.get(id)
		if (prev !== undefined) {
			for (const partner of prev) this.unwatchProof(id, partner)
			this.proofWatched.delete(id)
		}
		const watchers = this.proofWatchers.get(id)
		if (watchers !== undefined) {
			for (const watcher of [...watchers]) {
				const list = this.proofWatched.get(watcher)
				if (list === undefined) continue
				const filtered = list.filter(partner => partner !== id)
				if (filtered.length === 0) this.proofWatched.delete(watcher)
				else this.proofWatched.set(watcher, filtered)
			}
			this.proofWatchers.delete(id)
		}
		this.pendingProof.delete(id)
	}

	private clearProofIndexes(): void {
		this.proofWatchers.clear()
		this.proofWatched.clear()
		this.pendingProof.clear()
	}

	private bumpProof(discoveryId: string): void {
		this.invalidateLabel(discoveryId)
		this.dropWatcherCaches(discoveryId)
	}

	private forgetEvidence(observationId: string): void {
		const observation = this.observationIndex.get(observationId)
		if (observation !== undefined) this.armWatchers(observation.discoveryId)
		this.evidenceByObservation.delete(observationId)
		this.observationProofCache.delete(observationId)
		if (observation !== undefined) {
			this.invalidateLabel(observation.discoveryId)
			this.dropWatcherCaches(observation.discoveryId)
			this.refreshProofBearing(observation.discoveryId)
		}
	}

	private evidenceBag(observationId: string): EvidenceBag {
		let bag = this.evidenceByObservation.get(observationId)
		if (bag === undefined) {
			bag = { trials: [], analog: [], unavailable: [] }
			this.evidenceByObservation.set(observationId, bag)
			const discoveryId = this.observationIndex.get(observationId)?.discoveryId
			if (discoveryId !== undefined) this.proofBearing.add(discoveryId)
		}
		return bag
	}

	private rememberTrial(observationId: string, row: ProofTrialInput): boolean {
		const trials = this.evidenceBag(observationId).trials
		const found = trials.findIndex(
			item =>
				item.protocol === row.protocol &&
				item.decoder === row.decoder &&
				item.order === row.order,
		)
		if (found >= 0) {
			const previous = trials[found]
			if (
				previous !== undefined &&
				previous.outcome === row.outcome &&
				previous.at === row.at
			)
				return false
			trials[found] = row
			return true
		}
		trials.push(row)
		if (trials.length <= PROOF_TRIALS_MAX_PER_OBSERVATION) return true
		let drop = 0
		for (let index = 1; index < trials.length; index++) {
			const candidate = trials[index]
			const current = trials[drop]
			if (
				candidate !== undefined &&
				current !== undefined &&
				candidate.order < current.order
			)
				drop = index
		}
		const dropped = trials.splice(drop, 1)[0]
		return dropped !== row
	}

	private rememberAnalog(
		observationId: string,
		row: ProofAnalogInput,
	): boolean {
		const analog = this.evidenceBag(observationId).analog
		for (const previous of analog) {
			if (
				previous.outcome === row.outcome &&
				previous.mode === row.mode &&
				previous.transport === row.transport &&
				previous.at === row.at
			)
				return false
		}
		analog.push(row)
		if (analog.length <= PROOF_ANALOG_MAX_PER_OBSERVATION) return true
		let drop = 0
		for (let index = 1; index < analog.length; index++) {
			const candidate = analog[index]
			const current = analog[drop]
			if (
				candidate !== undefined &&
				current !== undefined &&
				candidate.at < current.at
			)
				drop = index
		}
		const dropped = analog.splice(drop, 1)[0]
		return dropped !== row
	}

	private rememberUnavailable(
		observationId: string,
		type: ScannerProbeDecoderType,
	): boolean {
		const unavailable = this.evidenceBag(observationId).unavailable
		if (unavailable.includes(type)) return false
		unavailable.push(type)
		unavailable.sort()
		return true
	}

	/** Proof as a reader would see it now. Does not copy; callers must not mutate it. */
	private peekProof(observationId: string): ScannerProof | null {
		const observation = this.observationIndex.get(observationId)
		if (observation === undefined) return null
		const discovery = this.discoveries.get(observation.discoveryId)
		if (discovery === undefined) return null
		return this.discoveryView(discovery).proof
	}

	/**
	 * One `updated` change when the derived proof, or the level it implies, changed.
	 * A sink write journals nothing; a persisted decode journals only the observation.
	 */
	private emitProofChange(
		id: string,
		before: ScannerProof | null,
		after: ScannerProof | null,
	): void {
		const cached = this.proofCache.get(id)
		const afterLevel =
			cached !== undefined && cached.proof === after
				? cached.evidence
				: this.proofLevel(after)
		const beforeLevel = this.proofLevel(before)
		if (jsonEqual(before, after) && beforeLevel === afterLevel) return
		this.publish([id])
		this.emit("change", id, "updated")
	}

	/** Drops the touched observation's proof and tells listeners when a reader's result changed. */
	private publishEvidence(
		observationId: string,
		before: ScannerProof | null,
	): boolean {
		const observation = this.observationIndex.get(observationId)
		if (observation === undefined) return false
		const discovery = this.discoveries.get(observation.discoveryId)
		if (discovery === undefined) {
			this.disarm(this.watcherIds(observation.discoveryId))
			return false
		}
		this.observationProofCache.delete(observationId)
		this.invalidateLabel(discovery.id)
		this.dropWatcherCaches(discovery.id)
		if (this.relocateIncompatible(observation)) return true
		const after = this.discoveryView(discovery).proof
		this.emitProofChange(discovery.id, before, after)
		this.flushPending(new Set([discovery.id]))
		return true
	}

	/**
	 * Winning decode for the stored record. Identified winners come from each
	 * observation's cached proof plus `extra`, so the raw decode lists are read
	 * only when nothing identified is cached. The later timestamp wins.
	 */
	private decidedLabel(
		d: Discovery,
		extra: DecodeEvidence,
	): { label: EvidenceLabel; facts: ProofFacts | null } {
		let bestProtocol: ScannerProtocol | undefined
		let bestIdentity: Identity | undefined
		let bestAt = Number.NEGATIVE_INFINITY
		const considerIdentified = (
			protocol: ScannerProtocol,
			identity: Identity | undefined,
			at: number,
		): void => {
			if (identity === undefined) return
			if (!identityFitsProtocol(protocol, identity)) return
			if (!Number.isFinite(at)) return
			if (bestIdentity !== undefined && at < bestAt) return
			bestProtocol = protocol
			bestIdentity = { kind: identity.kind, value: identity.value }
			bestAt = at
		}
		for (const observation of this.byDiscovery.get(d.id) ?? []) {
			const proof = this.observationAssessment(observation).proof
			if (proof === null || proof.kind !== "decoded") continue
			considerIdentified(proof.protocol, proof.identity, Date.parse(proof.at))
		}
		considerIdentified(extra.protocol, extra.identity, extra.at)
		if (bestProtocol !== undefined && bestIdentity !== undefined) {
			return {
				label: {
					protocol: bestProtocol,
					family: familyOf(bestProtocol),
					confidence: "decoded",
				},
				facts: {
					kind: "decoded",
					protocol: bestProtocol,
					transport: "live",
					at: bestAt,
					encrypted: false,
					identity: bestIdentity,
				},
			}
		}
		let looseProtocol: ScannerProtocol | undefined
		let looseAt = Number.NEGATIVE_INFINITY
		const considerLoose = (
			protocol: ScannerProtocol,
			identity: Identity | undefined,
			at: number,
		): void => {
			if (identity !== undefined) return
			if (!knownProtocol(protocol) || protocol === "unknown") return
			if (!Number.isFinite(at)) return
			if (looseProtocol !== undefined && at < looseAt) return
			looseProtocol = protocol
			looseAt = at
		}
		for (const observation of this.byDiscovery.get(d.id) ?? []) {
			for (const ev of observation.decode ?? [])
				considerLoose(ev.protocol, ev.identity, ev.at)
		}
		considerLoose(extra.protocol, extra.identity, extra.at)
		if (looseProtocol !== undefined) {
			return {
				label: {
					protocol: looseProtocol,
					family: familyOf(looseProtocol),
					confidence: "activity",
				},
				facts: null,
			}
		}
		return { label: UNKNOWN_LABEL, facts: null }
	}

	private proofInputOf(observation: Observation): ProofInput | null {
		const bag = this.evidenceByObservation.get(observation.id)
		const decodes: ProofDecodeInput[] = []
		for (const ev of observation.decode ?? []) {
			const row = decodeRow(ev)
			if (row !== undefined) decodes.push(row)
		}
		const trials = bag?.trials ?? []
		const analog = bag?.analog ?? []
		const unavailable = bag?.unavailable ?? []
		if (
			decodes.length === 0 &&
			trials.length === 0 &&
			analog.length === 0 &&
			unavailable.length === 0
		)
			return null
		return {
			observationId: observation.id,
			decodes,
			trials,
			analog,
			unavailable,
			trust: observation.tuningTrust,
			digitalPlanComplete: digitalPlanCompleteOf(analog, trials, unavailable),
		}
	}

	private observationAssessment(observation: Observation): {
		proof: ScannerProof | null
		label: EvidenceLabel
	} {
		const hit = this.observationProofCache.get(observation.id)
		if (hit !== undefined) return hit
		const input = this.proofInputOf(observation)
		if (input === null) {
			const empty = { proof: null, label: UNKNOWN_LABEL }
			this.observationProofCache.set(observation.id, empty)
			return empty
		}
		const decided = labelAndFacts(input)
		const proof =
			decided.facts === null ? null : proofFromFacts(input, decided.facts)
		const row = { proof, label: decided.label }
		this.observationProofCache.set(observation.id, row)
		return row
	}

	/** An identified decode counts only for the discovery that already stores it. */
	private decodeCounts(d: Discovery, row: ProofDecodeInput): boolean {
		if (row.identity !== undefined) {
			if (d.identity === undefined) return false
			return (
				d.protocol === row.protocol && sameIdentity(d.identity, row.identity)
			)
		}
		if (d.identity === undefined) return true
		return row.protocol === d.protocol
	}

	private proofCounts(d: Discovery, proof: ScannerProof): boolean {
		if (proof.kind !== "decoded") return true
		if (proof.identity === undefined || d.identity === undefined) return false
		return (
			d.protocol === proof.protocol && sameIdentity(d.identity, proof.identity)
		)
	}

	/** Proof of one observation after decodes that do not belong to `d` are removed. */
	private filteredProof(
		d: Discovery,
		observation: Observation,
		decodedOnly: boolean,
	): ScannerProof | null {
		const input = this.proofInputOf(observation)
		if (input === null) return null
		const decodes = input.decodes.filter(row => this.decodeCounts(d, row))
		if (decodedOnly && decodes.length === 0) return null
		const filtered: ProofInput = { ...input, decodes }
		const decided = labelAndFacts(filtered)
		if (decided.facts === null) return null
		if (decodedOnly && decided.facts.kind !== "decoded") return null
		return proofFromFacts(filtered, decided.facts)
	}

	private attributedProof(
		d: Discovery,
		observation: Observation,
		foreign: boolean,
	): ScannerProof | null {
		const cached = this.observationAssessment(observation).proof
		if (cached !== null && this.proofCounts(d, cached)) {
			if (foreign && cached.kind !== "decoded") return null
			return cached
		}
		if (foreign) return this.filteredProof(d, observation, true)
		if (cached !== null && cached.kind === "decoded")
			return this.filteredProof(d, observation, false)
		return cached
	}

	private proofSources(
		d: Discovery,
	): { observation: Observation; foreign: boolean }[] {
		const out: { observation: Observation; foreign: boolean }[] = []
		const seen = new Set<string>()
		for (const observation of this.byDiscovery.get(d.id) ?? []) {
			seen.add(observation.id)
			out.push({ observation, foreign: false })
		}
		const partners = Array.isArray(d.coChannel) ? d.coChannel : []
		for (const partnerId of partners) {
			for (const observation of this.byDiscovery.get(partnerId) ?? []) {
				if (seen.has(observation.id)) continue
				seen.add(observation.id)
				out.push({ observation, foreign: true })
			}
		}
		return out
	}

	private deriveDiscovery(d: Discovery): ScannerProof | null {
		const proofs: ScannerProof[] = []
		for (const source of this.proofSources(d)) {
			const proof = this.attributedProof(d, source.observation, source.foreign)
			if (proof !== null) proofs.push(proof)
		}
		return strongestKnownProof(proofs)
	}

	/** Grammar check for a proof that is not already in the discovery cache. */
	private proofLevel(proof: ScannerProof | null): ScannerEvidenceLevel {
		if (proof === null) return "weak"
		return evidenceLevelOf({ proof }) === "proven" ? "proven" : "weak"
	}

	/**
	 * True when a retained decode or sink bag can produce a proof, including a
	 * co-channel observation. The stored protocol is then not the DTO protocol.
	 * `proofBearing` is that fact for the discovery's own observations.
	 */
	private evidenceCanNameProof(d: Discovery): boolean {
		if (this.proofBearing.has(d.id)) return true
		if (!Array.isArray(d.coChannel)) return false
		for (const partnerId of d.coChannel) {
			if (partnerId !== d.id && this.proofBearing.has(partnerId)) return true
		}
		return false
	}

	private carriesProofInput(observation: Observation): boolean {
		return (
			(observation.decode?.length ?? 0) > 0 ||
			this.evidenceByObservation.has(observation.id)
		)
	}

	/** Drops the id when none of its current observations can name a proof. */
	private refreshProofBearing(discoveryId: string): void {
		const list = this.byDiscovery.get(discoveryId)
		if (list !== undefined) {
			for (const observation of list) {
				if (!this.carriesProofInput(observation)) continue
				this.proofBearing.add(discoveryId)
				return
			}
		}
		this.proofBearing.delete(discoveryId)
	}

	private discoveryView(d: Discovery): DiscoveryProofView {
		if (d.anchor === "decode")
			return {
				label: { protocol: "adsb", family: "packet", confidence: "decoded" },
				evidence: "proven",
				proof: {
					kind: "decoded",
					protocol: "adsb",
					transport: "ambient",
					at: d.lastSeenAt,
					observationId: `decode:${d.id}`,
					tried: [],
					unavailable: [],
					encrypted: false,
					summary: "ADS-B",
				},
			}
		const hit = this.proofCache.get(d.id)
		if (hit !== undefined) return hit
		// No sink or decode input: the stored record is the label.
		if (!this.evidenceCanNameProof(d)) {
			const view: DiscoveryProofView = {
				proof: null,
				evidence: "weak",
				label: {
					protocol: d.protocol,
					family: d.family,
					confidence: d.confidence,
				},
			}
			this.proofCache.set(d.id, view)
			return view
		}
		const proof = this.deriveDiscovery(d)
		const evidence = this.proofLevel(proof)
		const label =
			(evidence === "proven" || syncOnlyProof(proof)) && proof !== null
				? this.labelOfProof(d, proof)
				: {
						protocol: d.protocol,
						family: d.family,
						confidence: d.confidence,
					}
		const view: DiscoveryProofView = { proof, evidence, label }
		this.proofCache.set(d.id, view)
		return view
	}

	private toneConfidence(d: Discovery, proof: ScannerProof): ScannerConfidence {
		const trust =
			this.observationIndex.get(proof.observationId)?.tuningTrust ??
			d.tuningTrust
		return trust === "unverified" ? "candidate" : "classified"
	}

	/**
	 * Label implied by a proof. A recorded leak or intermod cap ceilings every
	 * confidence above `candidate`, including a decoded proof, while the cap
	 * remains. Nothing here is written back onto the record.
	 */
	private labelOfProof(d: Discovery, proof: ScannerProof): EvidenceLabel {
		let protocol: ScannerProtocol
		let confidence: ScannerConfidence
		switch (proof.kind) {
			case "decoded":
				protocol = proof.protocol
				confidence = "decoded"
				break
			case "analog-tone":
				protocol = proof.protocol
				confidence = this.toneConfidence(d, proof)
				break
			case "analog-voice":
				protocol = proof.protocol
				confidence = "candidate"
				break
			case "digital-undecoded":
				protocol = syncOnlyProof(proof) ? proof.protocol : "digital-unknown"
				confidence = syncOnlyProof(proof) ? "activity" : "candidate"
				break
			case "carrier-only":
				protocol = "carrier"
				confidence = "activity"
				break
		}
		if (d.confidenceCap !== undefined && rank(confidence) > rank("candidate"))
			confidence = "candidate"
		return { protocol, family: familyOf(protocol), confidence }
	}

	/** Proof label when a proof is shown; otherwise the stored record. */
	private effectiveLabel(d: Discovery): EvidenceLabel {
		return this.discoveryView(d).label
	}

	/**
	 * Scanner-redesign 3.10: the label every read and event path publishes. A weak record
	 * publishes unknown unless a digital-voice sync hint is shown; stored fields are not rewritten.
	 */
	private publishedLabel(d: Discovery): EvidenceLabel {
		return publishedOf(this.discoveryView(d))
	}

	/** Verification depends only on persisted provenance, including co-channel proof. */
	private hasCheckedContent(d: Discovery): boolean {
		if (d.contentVerified === true) return true
		if (!this.evidenceCanNameProof(d)) return false
		return this.proofSources(d).some(({ observation }) =>
			(observation.decode ?? []).some(
				ev =>
					ev.contentVerified === true &&
					ev.crcClean === true &&
					ev.protocol === d.protocol &&
					sameIdentity(ev.identity, d.identity),
			),
		)
	}

	/** Run after observations are loaded, and before publishing or journaling mutations. */
	private normalizeCheckedContent(d: Discovery): boolean {
		if (d.anchor === "decode" || !isDsdFmeProtocol(d.protocol)) return false
		if (this.hasCheckedContent(d)) {
			if (d.contentVerified === true) return false
			d.contentVerified = true
			return true
		}
		const changed = d.encrypted || !jsonEqual(d.metadata, emptyMetadata())
		d.metadata = emptyMetadata()
		d.encrypted = false
		return changed
	}

	private presentDiscovery(d: Discovery): Discovery {
		const copy = clone(d)

		const view = this.discoveryView(d)
		if (
			(view.evidence === "proven" || syncOnlyProof(view.proof)) &&
			view.proof !== null
		) {
			copy.proof = clone(view.proof)
			copy.protocol = view.label.protocol
			copy.family = view.label.family
			copy.confidence = view.label.confidence
		} else {
			delete copy.proof
			copy.protocol = UNKNOWN_LABEL.protocol
			copy.family = UNKNOWN_LABEL.family
			copy.confidence = UNKNOWN_LABEL.confidence
			const hint = this.hintFor(d)
			if (hint !== undefined) copy.hint = hint
		}
		// Historical stored identities keep association boundaries stable. Only checked
		// content can publish a dsd-fme identity or its saved call metadata. Stored
		// provenance alone does not establish an observation proof or raise its level.
		if (isDsdFmeProtocol(d.protocol) && !this.hasCheckedContent(d)) {
			delete copy.identity
			copy.encrypted = false
			copy.metadata = emptyMetadata()
		}
		delete copy.contentVerified
		copy.evidenceLevel = view.evidence
		copy.revision = this.published.get(d.id) ?? 1
		return copy
	}

	/** Scanner-redesign 3.11 `short`: the persisted flag of the latest observation; undefined when absent. */
	private latestShort(discoveryId: string): boolean | undefined {
		let latest: Observation | undefined
		for (const o of this.byDiscovery.get(discoveryId) ?? []) {
			if (
				latest === undefined ||
				(o.endedAt ?? o.startedAt) >= (latest.endedAt ?? latest.startedAt)
			)
				latest = o
		}
		const short = (latest as StoredObservation | undefined)?.short
		return typeof short === "boolean" ? short : undefined
	}

	/** Scanner-redesign 3.11: display hint of a weak record, from the read-time scope. */
	private hintFor(d: Discovery): ScannerHint | undefined {
		const scope = this.hintScope?.()
		if (scope === undefined) return undefined
		return hintOf({
			frequencyHz: d.frequencyHz,
			bandwidthHz: d.bandwidthHz,
			class: d.class,
			short: this.latestShort(d.id),
			region: scope.region,
			ranges: scope.ranges,
		})
	}

	private presentObservation(observation: Observation): Observation {
		const copy = clone(observation)
		const proof = this.observationAssessment(observation).proof
		if (proof !== null) copy.proof = clone(proof)
		else delete copy.proof
		delete (copy as StoredObservation).classVote // store-internal (DQ 3.4), not part of the DTO
		delete (copy as StoredObservation).short // store-internal (scanner-redesign 3.11)
		return copy
	}

	private removeDiscovery(id: string): void {
		const d = this.discoveries.get(id)
		if (d === undefined) return
		// The outer delete/merge journals removal; publishing here would nest a commit.
		this.anchorWindows.delete(id)
		this.anchorPending.delete(id)
		this.anchorPublished.delete(id)
		this.discoveries.delete(id)
		const timer = this.anchorExpiry.get(id)
		if (timer) clearTimeout(timer)
		this.anchorExpiry.delete(id)
		if (d.anchor === "decode")
			this.decodeAnchors.delete(
				decodeAnchorKey(d.sourceIds[0]!, d.protocol, d.frequencyHz),
			)
		this.published.delete(id)
		const members = this.members.get(id)
		for (const s of d.sourceIds) {
			this.bySource.get(s)?.delete(id)
			members?.delete(s)
		}
		// stale `bySource` entries of sources trimmed from `sourceIds` stay, as there
		if (members?.size === 0) this.members.delete(id)
		for (const o of this.byDiscovery.get(id) ?? []) {
			this.forgetEvidence(o.id)
			this.observationIndex.delete(o.id)
			this.removal.observations.push(o.id)
		}
		this.byDiscovery.delete(id)
		this.proofBearing.delete(id)
		this.invalidateLabel(id)
		this.clearProofWatch(id)
		this.medians.delete(id)
		this.unlinked.delete(id)
		this.aliasTable.detach(id)
		this.markDirty(id)
	}

	/** Inserts an unlinked observation in canonical order and trims the per-discovery window. */
	private putObservation(o: Observation): void {
		if (this.discoveries.get(o.discoveryId)?.anchor === "decode") o.decode = []
		this.armWatchers(o.discoveryId)
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
		this.trimObservations(list)
		this.observationProofCache.delete(o.id)
		// Trim may have dropped `o` itself. Bearing follows only what is still stored.
		if (this.observationIndex.has(o.id) && this.carriesProofInput(o))
			this.proofBearing.add(o.discoveryId)
		// An observation with no decode or sink bag cannot change a proof, here
		// or on a co-channel partner. A trimmed row that held one already
		// dropped the caches through `forgetEvidence`.
		if (this.carriesProofInput(o)) this.bumpProof(o.discoveryId)
		this.medians.delete(o.discoveryId)
		this.markDirty(o.discoveryId)
	}

	/**
	 * Keeps the window at exactly 256. Pinned rows stay and the oldest
	 * unpinned row goes, so a decoded proof cannot age out of the window.
	 *
	 * Pins are the discovery's own identity anchor plus at most one newest
	 * proof source per linked co-channel discovery. The link list is capped
	 * at LINKS_MAX, so the pin set is at most 1 + LINKS_MAX = 65. The window
	 * is 256, which leaves 256 - 65 = 191 rows that can still be evicted, and
	 * trim can always return the list to 256.
	 */
	private trimObservations(list: Observation[]): void {
		if (list.length <= OBSERVATIONS_PER_DISCOVERY) return
		const pinned = this.pinnedIndexes(list)
		while (list.length > OBSERVATIONS_PER_DISCOVERY) {
			let dropAt = -1
			for (let i = 0; i < list.length; i++) {
				if (!pinned.has(i)) {
					dropAt = i
					break
				}
			}
			// 65 pins cannot cover a 256-row window. Stop rather than drop a pin.
			if (dropAt < 0) break
			const dropped = list[dropAt]
			if (dropped === undefined) break
			list.splice(dropAt, 1)
			const next = new Set<number>()
			for (const index of pinned) {
				if (index === dropAt) continue
				next.add(index > dropAt ? index - 1 : index)
			}
			pinned.clear()
			for (const index of next) pinned.add(index)
			if (this.carriesProofInput(dropped)) this.forgetEvidence(dropped.id)
			else this.observationProofCache.delete(dropped.id)
			this.observationIndex.delete(dropped.id)
			this.removal.observations.push(dropped.id) // no journal entry names it (WG11 req 3.5)
		}
	}

	/** Indexes that trim must keep: own identity, then linked proof sources. */
	private pinnedIndexes(list: readonly Observation[]): Set<number> {
		const pinned = new Set<number>()
		const anchor = this.identityAnchor(list)
		if (anchor >= 0) pinned.add(anchor)
		const discoveryId = list[0]?.discoveryId
		if (discoveryId === undefined) return pinned
		const d = this.discoveries.get(discoveryId)
		const links = d === undefined ? undefined : d.coChannel
		if (!Array.isArray(links) || links.length === 0) return pinned
		const cap = Math.min(links.length, LINKS_MAX)
		for (let n = 0; n < cap; n++) {
			const partnerId = links[n]
			if (partnerId === undefined || partnerId === d?.id) continue
			const partner = this.discoveries.get(partnerId)
			if (partner === undefined) continue
			const index = this.linkedProofPin(list, partner)
			if (index >= 0) pinned.add(index)
		}
		return pinned
	}

	/**
	 * Index of the newest observation on `list` that proves `partner`, when
	 * that observation is newer than any proof `partner` holds itself.
	 */
	private linkedProofPin(
		list: readonly Observation[],
		partner: Discovery,
	): number {
		let ownNewest: Observation | undefined
		const own = this.byDiscovery.get(partner.id)
		if (own !== undefined) {
			for (let i = own.length - 1; i >= 0; i--) {
				const o = own[i]
				if (o === undefined || !this.carriesProofInput(o)) continue
				// Only a persisted decoded proof counts here: memory-only sink rows would
				// make live and journal replay pin different observations.
				if (this.filteredProof(partner, o, true) === null) continue
				ownNewest = o
				break
			}
		}
		for (let i = list.length - 1; i >= 0; i--) {
			const o = list[i]
			if (o === undefined) continue
			if (ownNewest !== undefined && compareObs(o, ownNewest) <= 0) return -1
			if (!this.carriesProofInput(o)) continue
			if (this.attributedProof(partner, o, true) === null) continue
			return i
		}
		return -1
	}

	/** Index of the newest observation whose decode confirms `d`'s identity, or -1. */
	private identityAnchor(list: readonly Observation[]): number {
		const discoveryId = list[0]?.discoveryId
		if (discoveryId === undefined) return -1
		const d = this.discoveries.get(discoveryId)
		if (d?.identity === undefined) return -1
		for (let i = list.length - 1; i >= 0; i--) {
			const o = list[i]
			if (o !== undefined && this.holdsMatchingIdentity(d, o)) return i
		}
		return -1
	}

	private holdsMatchingIdentity(d: Discovery, o: Observation): boolean {
		const identity = d.identity
		if (identity === undefined) return false
		for (const ev of o.decode ?? []) {
			if (ev.crcClean !== true || ev.identity === undefined) continue
			if (ev.protocol !== d.protocol) continue
			if (!sameIdentity(ev.identity, identity)) continue
			if (!identityFitsProtocol(ev.protocol, ev.identity)) continue
			return true
		}
		return false
	}

	private unlinkObservation(o: Observation): void {
		this.armWatchers(o.discoveryId)
		const list = this.byDiscovery.get(o.discoveryId)
		if (list !== undefined) {
			const i = list.findIndex(x => x.id === o.id)
			if (i >= 0) list.splice(i, 1)
		}
		this.observationIndex.delete(o.id)
		this.observationProofCache.delete(o.id)
		this.invalidateLabel(o.discoveryId)
		this.dropWatcherCaches(o.discoveryId)
		this.refreshProofBearing(o.discoveryId)
		this.medians.delete(o.discoveryId)
		this.markDirty(o.discoveryId)
	}

	private applyMutation(m: StoreMutation): void {
		this.proofQuiet++
		try {
			this.applyStoredMutation(m)
		} finally {
			this.proofQuiet--
			this.pendingProof.clear()
		}
	}

	private downgradeLegacyObservation(observation: Observation): void {
		if (observation.decode !== undefined)
			observation.decode = observation.decode.map(checkedDecode)
	}

	private applyStoredMutation(m: StoreMutation): void {
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
			const observation = clone(o)
			this.downgradeLegacyObservation(observation)
			this.putObservation(observation)
		}
		for (const id of m.removedObservations ?? []) {
			this.forgetEvidence(id)
			const previous = this.observationIndex.get(id)
			if (previous !== undefined) this.unlinkObservation(previous)
		}
		this.observationProofCache.clear()
		this.proofCache.clear()
		for (const id of m.deleted) {
			this.removeDiscovery(id)
			// Replay only (no evidence removal follows): a deleted owner's aliases are released,
			// as a settled runtime removal and a snapshot restore leave them (nothing detached).
			this.aliasTable.release(id)
		}
		const checkedIds = new Set(m.discoveries.map(d => d.id))
		for (const o of m.observations) checkedIds.add(o.discoveryId)
		for (const id of [...checkedIds])
			for (const reader of this.watcherIds(id)) checkedIds.add(reader)
		for (const id of checkedIds) {
			const d = this.discoveries.get(id)
			if (d !== undefined) this.normalizeCheckedContent(d)
		}
		for (const a of m.aliases ?? []) {
			this.aliasTable.release(a.id)
			if (this.discoveries.has(a.id) || a.aliases.length === 0)
				this.aliasTable.set(a.id, a.aliases, id => this.discoveries.has(id))
		}
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
		// DQ 2.3: records whose co-channel list a prune or cap changed outside the op's own marks.
		if (this.linkTouched.size > 0) {
			const deleted = new Set(op.deleted)
			for (const id of this.linkTouched) {
				if (deleted.has(id) || !this.discoveries.has(id)) continue
				op.discoveries.add(id)
				mark(op, id, "updated")
			}
			this.linkTouched.clear()
		}
		const checkedIds = new Set(op.discoveries)
		for (const id of op.observations) {
			const o = this.observationIndex.get(id)
			if (o !== undefined) checkedIds.add(o.discoveryId)
		}
		for (const id of [...checkedIds])
			for (const reader of this.watcherIds(id)) checkedIds.add(reader)
		for (const id of checkedIds) {
			const d = this.discoveries.get(id)
			if (d !== undefined && this.normalizeCheckedContent(d))
				op.discoveries.add(id)
		}
		const pending = this.pendingProof
		this.pendingProof = new Map()
		const notified = new Set(op.changes.keys())
		for (const id of op.discoveries) this.markDirty(id)
		for (const id of op.deleted) this.markDirty(id)
		this.catchUp()
		// WG11 req 3.4: no structuredClone; the payload is one plain copy of the changed records
		// (detached, so a listener may keep it); persistence stringifies it once into the journal line
		const discoveries = plainCopy(
			[...op.discoveries]
				.map(id => this.discoveries.get(id))
				.filter((d): d is Discovery => d !== undefined)
				.sort((a, b) => compareText(a.id, b.id)),
		)
		const indexed = [...op.observations]
			.map(id => this.observationIndex.get(id))
			.filter((o): o is Observation => o !== undefined)
		const seen = new Set(indexed.map(o => o.id))
		const moved = op.trimmedMoves.filter(o => !seen.has(o.id))
		const observations = plainCopy([...indexed, ...moved].sort(compareObs))
		const removed = op.removedObservations.filter(
			id => !this.observationIndex.has(id),
		)
		if (
			discoveries.length === 0 &&
			observations.length === 0 &&
			op.deleted.length === 0 &&
			removed.length === 0 &&
			op.correction === undefined &&
			op.aliases.size === 0
		) {
			this.flushRemoval()
			this.emitPending(pending, notified)
			return
		}
		const payload: StoreMutation = {
			discoveries,
			observations,
			deleted: [...op.deleted],
		}
		if (removed.length > 0) payload.removedObservations = removed
		if (op.correction !== undefined) payload.correction = { ...op.correction }
		if (op.aliases.size > 0)
			payload.aliases = [...op.aliases]
				.sort(compareText)
				.map(id => this.aliasTable.entryOf(id))
		const entry: Omit<JournalEntry, "seq"> = {
			at: iso(this.now()),
			op: kind,
			payload,
		}
		this.publish([...op.discoveries, ...op.deleted, ...op.changes.keys()])
		this.emit("mutation", entry)
		this.flushRemoval()
		for (const [id, change] of op.changes) {
			if (change === "merged")
				this.emit("change", id, change, this.absorbedIds(op, id))
			else this.emit("change", id, change)
		}
		this.emitPending(pending, notified)
	}

	/** Ids absorbed into `survivor` by this operation, sorted, at most 64. */
	private absorbedIds(op: Op, survivor: string): string[] {
		const parent = new Map<string, string>()
		for (const [keep, drop] of op.merged) parent.set(drop, keep)
		const rootOf = (id: string): string => {
			let at = id
			const seen = new Set<string>()
			for (;;) {
				const next = parent.get(at)
				if (next === undefined || seen.has(at)) return at
				seen.add(at)
				at = next
			}
		}
		const ids: string[] = []
		for (const drop of parent.keys())
			if (rootOf(drop) === survivor) ids.push(drop)
		ids.sort(compareText)
		if (ids.length > DISCOVERY_MERGED_IDS_MAX)
			ids.length = DISCOVERY_MERGED_IDS_MAX
		return ids
	}

	// ── WG11 lane SC: revisions, indexes, counts, mirror removals ────────

	private revision(d: Discovery): number {
		return this.revisions.get(d) ?? 0
	}

	/** Band inspection UX req 3.3: the store's epoch (new on every start and restore). */
	get storeEpoch(): string {
		return this.epoch
	}

	/** Band inspection UX req 3.3: the newest revision any change was published at. */
	currentRevision(): number {
		return this.revisionSeq
	}

	/** One published change: a new revision for every id it touched (a removed id forgets its own). */
	private publish(ids: Iterable<string>): number {
		const revision = ++this.revisionSeq
		for (const id of ids)
			if (this.discoveries.has(id)) this.published.set(id, revision)
			else this.published.delete(id)
		return revision
	}

	/** A value in `d`'s JSON changed: bump its revision (and catch the indexes up). */
	private touch(d: Discovery): void {
		this.revisions.set(d, this.revision(d) + 1)
		this.markDirty(d.id)
	}

	private markDirty(id: string): void {
		this.indexDirty.add(id)
		this.countsDirty.add(id)
	}

	private catchUp(): void {
		this.syncIndex()
		this.syncCounts()
	}

	/**
	 * The cached proof label is stale. Job counts use that label, so the next
	 * sync recounts this discovery from whatever `effectiveLabel` shows.
	 */
	private invalidateLabel(id: string): void {
		this.proofCache.delete(id)
		this.countsDirty.add(id)
		// The centre list is keyed by the effective family, so a new label moves it.
		this.indexDirty.add(id)
	}

	private syncCounts(): void {
		for (const id of this.countsDirty) {
			const discovery = this.discoveries.get(id)
			this.jobCounts.sync(
				id,
				discovery === undefined
					? undefined
					: {
							confidence: this.publishedLabel(discovery).confidence,
							jobIds: discovery.jobIds,
						},
			)
		}
		this.countsDirty.clear()
	}

	/** Brings the centre, key and frequency indexes of every dirty id up to date. */
	private syncIndex(): void {
		for (const id of this.indexDirty) this.reindex(id)
		this.indexDirty.clear()
	}

	private reindex(id: string): void {
		const prev = this.indexed.get(id)
		const d = this.discoveries.get(id)
		const members = this.members.get(id)
		if (d === undefined || members === undefined || members.size === 0) {
			if (prev !== undefined) this.unindex(id, prev)
			return
		}
		const centre = this.medianCentre(d)
		const named = this.evidenceCanNameProof(d)
		// DQ 9.1: the centre lists are keyed by the association family.
		const family = named
			? this.associationFamily(d)
			: associationOf(
					{ protocol: d.protocol, family: d.family, confidence: d.confidence },
					d.identity,
					"weak",
				)
		const decoded = named
			? this.effectiveLabel(d).confidence === "decoded"
			: d.confidence === "decoded"
		if (
			prev !== undefined &&
			prev.family === family &&
			prev.decoded === decoded &&
			Object.is(prev.centre, centre) &&
			Object.is(prev.frequencyHz, d.frequencyHz) &&
			prev.key === d.frequencyKey &&
			prev.sources.length === members.size &&
			prev.sources.every(s => members.has(s))
		)
			return
		if (prev !== undefined) this.unindex(id, prev)
		const next: IndexedDiscovery = {
			family,
			decoded,
			centre,
			frequencyHz: d.frequencyHz,
			key: d.frequencyKey,
			sources: [...members],
		}
		for (const s of next.sources) {
			this.centres.add(s, next.family, centre, id)
			if (next.decoded)
				this.decodedCentres.add(s, DECODED_CENTRE_FAMILY, centre, id)
			const k = `${s}\u0000${next.key}`
			let set = this.byKey.get(k)
			if (set === undefined) {
				set = new Set()
				this.byKey.set(k, set)
			}
			set.add(id)
		}
		this.frequencies.add(next.sources, d.frequencyHz, id)
		this.indexed.set(id, next)
	}

	private unindex(id: string, prev: IndexedDiscovery): void {
		for (const s of prev.sources) {
			this.centres.remove(s, prev.family, prev.centre, id)
			if (prev.decoded)
				this.decodedCentres.remove(s, DECODED_CENTRE_FAMILY, prev.centre, id)
			const k = `${s}\u0000${prev.key}`
			const set = this.byKey.get(k)
			set?.delete(id)
			if (set?.size === 0) this.byKey.delete(k)
		}
		this.frequencies.remove(prev.sources, prev.frequencyHz, id)
		this.indexed.delete(id)
	}

	/** WG11 req 3.5: records that left the snapshot set with no journal payload naming them. */
	private flushRemoval(): void {
		const r = this.removal
		if (r.discoveries.length === 0 && r.observations.length === 0) return
		this.removal = { discoveries: [], observations: [] }
		this.emit("mirror-removal", r)
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
				d.anchor !== "decode" &&
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

/** The nearest channel of the finest positive raster (ties: the lower), or null. */
function channelOf(hz: number, rasters: readonly Raster[]): number | null {
	let r: Raster | undefined
	for (const x of rasters)
		if (x.spacingHz > 0 && (r === undefined || x.spacingHz < r.spacingHz)) r = x
	if (r === undefined || !Number.isFinite(hz)) return null
	return Math.round(
		r.firstChannelHz +
			Math.round((hz - r.firstChannelHz) / r.spacingHz) * r.spacingHz,
	)
}

/**
 * DQ 1.16: the rasters fit to key an emission of `obwHz`: those at least half its OBW wide (a
 * channel holds its emitter), or the coarsest when none is. A 3 kHz carrier keeps the 8.33 kHz
 * airband grid; a 50 kHz burst keys to 25 kHz, so it is not split across fine channels.
 * A non-finite or non-positive OBW keeps every raster.
 */
function gridFor(rasters: Raster[], obwHz: number): Raster[] {
	if (rasters.length < 2 || !(obwHz > 0) || !Number.isFinite(obwHz))
		return rasters
	const fit = rasters.filter(r => r.spacingHz >= obwHz / 2)
	if (fit.length > 0) return fit
	let widest = rasters[0]!
	for (const r of rasters) if (r.spacingHz > widest.spacingHz) widest = r
	return [widest]
}
