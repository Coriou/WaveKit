/**
 * Batch-1 event foundation: the frozen contract shared by the storage lane
 * (writer, ingress, retention) and the query lane (search, facets, cursor,
 * replay). See docs/specs/activity-recording-catalog/event-foundation-batch1.md.
 * Changing anything here is a Main-only contract change.
 */
import type { DecodeEnvelope } from "../types.js"

export const ACTIVITY_SCHEMA_VERSION = 1
export const ACTIVITY_RECORD_VERSION = 1

/** Closed kind union; batch 1 produces the first and last, WG1 adds analog-transmission. */
export type ActivityKind =
	| "decoder-reception"
	| "call-lifecycle"
	| "analog-transmission"
	| "scanner-result"
	| "recording-change"
	| "ingestion-gap"

export type ActivityCategory = DecodeEnvelope["category"]

export interface IngestionGapPayload {
	reason: "rate-limited" | "queue-full" | "write-failed" | "store-paused"
	/** Count of envelopes dropped since the previous gap record. */
	dropped: number
	/** Decoder instance IDs affected, at most 32, sorted. */
	decoderIds: readonly string[]
	fromReceivedAt: string
	toReceivedAt: string
}

/**
 * Payload of an `analog-transmission` record (WG1): one closed squelch-delimited transmission of
 * the live demodulator. The record's eventId equals `transmissionId`.
 */
export interface AnalogTransmissionPayload {
	transmissionId: string
	sourceId: string
	startedAt: string
	endedAt: string
	durationMs: number
	frequency: {
		hz: number
		tuningTrust: "commanded" | "relay" | "unverified"
	} | null
	modulation: "nfm" | "wfm" | "am" | "usb" | "lsb" | "dsb" | "cw" | "raw"
	bandwidthHz: number
	squelchMode: "manual" | "auto"
	thresholdDbfs: number
	peakChannelPowerDbfs: number | null
	meanChannelPowerDbfs: number | null
	closeReason: "squelch" | "retune" | "config" | "stopped" | "max-duration"
	/**
	 * WG2: sub-audible tone and DTMF digits heard during the transmission. Present on closed
	 * transmissions produced since WG2; absent on open events and on records stored before it.
	 */
	tone?: {
		/** One of the 50 standard CTCSS tones (67.0–254.1 Hz), or null when none qualified. */
		ctcssHz: number | null
		/** DTMF symbols `0-9*#A-D` in order, at most 32; null when none. */
		dtmf: string | null
	}
}

/** Stored and returned record. commitSeq is assigned by the writer. */
export type ActivityRecord =
	| DecoderReceptionRecord
	| IngestionGapRecord
	| AnalogTransmissionRecord

export interface DecoderReceptionRecord extends ActivityRecordBase {
	kind: "decoder-reception"
	payload: DecodeEnvelope
}

export interface IngestionGapRecord extends ActivityRecordBase {
	kind: "ingestion-gap"
	payload: IngestionGapPayload
}

export interface AnalogTransmissionRecord extends ActivityRecordBase {
	kind: "analog-transmission"
	payload: AnalogTransmissionPayload
}

export interface ActivityRecordBase {
	version: typeof ACTIVITY_RECORD_VERSION
	eventId: string
	/** Decimal string; never a JS number on the wire. */
	commitSeq: string
	producedAt: string
	receivedAt: string
}

/** List/replay summary, at most 4 KiB serialized. */
export interface ActivitySummary {
	eventId: string
	commitSeq: string
	kind: ActivityKind
	producedAt: string
	receivedAt: string
	decoderId: string | null
	sourceId: string | null
	protocol: string | null
	category: ActivityCategory
	frequencyHz: number | null
	entityKey: string | null
	title: string | null
	/** First fields that fit the 4 KiB budget. */
	fields: DecodeEnvelope["fields"]
	position?: DecodeEnvelope["position"]
}

export const MAX_RECORD_BYTES = 144 * 1024
export const MAX_SUMMARY_BYTES = 4 * 1024
export const MAX_INDEXED_TEXT_BYTES = 8 * 1024

/** Rows in store_meta. Values are text. */
export type StoreMetaKey =
	| "schemaVersion"
	| "storeUuid"
	| "restoreGeneration"
	| "pruneWatermark"
	| "pruneGeneration"
	| "cursorKey"

/**
 * v1 schema. The writer applies it inside one transaction on first open;
 * an existing store with a different schemaVersion is refused, never migrated
 * in batch 1. seq uses AUTOINCREMENT so a pruned maximum is never reused.
 * activity_fts is contentless with rowid = activity.seq; the writer inserts
 * and deletes FTS rows in the same transaction as the activity row.
 */
export const ACTIVITY_SCHEMA_V1 = `
CREATE TABLE store_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT;
CREATE TABLE activity (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	event_id TEXT NOT NULL UNIQUE,
	kind TEXT NOT NULL,
	produced_at_ms INTEGER NOT NULL,
	received_at_ms INTEGER NOT NULL,
	source_id TEXT,
	decoder_id TEXT,
	protocol TEXT,
	category TEXT NOT NULL,
	frequency_hz INTEGER,
	entity_key TEXT,
	summary_json TEXT NOT NULL,
	record_json TEXT NOT NULL,
	record_bytes INTEGER NOT NULL
) STRICT;
CREATE INDEX activity_kind ON activity (kind, seq);
CREATE INDEX activity_category ON activity (category, seq);
CREATE INDEX activity_protocol ON activity (protocol, seq);
CREATE INDEX activity_decoder ON activity (decoder_id, seq);
CREATE INDEX activity_source ON activity (source_id, seq);
CREATE INDEX activity_entity ON activity (entity_key, seq);
CREATE INDEX activity_frequency ON activity (frequency_hz);
CREATE INDEX activity_produced ON activity (produced_at_ms);
CREATE INDEX activity_received ON activity (received_at_ms);
CREATE TABLE activity_refs (
	seq INTEGER NOT NULL REFERENCES activity (seq) ON DELETE CASCADE,
	ref_type TEXT NOT NULL,
	ref_value TEXT NOT NULL,
	PRIMARY KEY (ref_type, ref_value, seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX activity_refs_seq ON activity_refs (seq);
CREATE VIRTUAL TABLE activity_fts USING fts5 (
	text,
	content = '',
	contentless_delete = 1,
	tokenize = 'unicode61 remove_diacritics 2'
);
`

/** ref_type values; ref_value is the matching provenance/refs string. */
export type ActivityRefType =
	| "callId"
	| "discoveryId"
	| "observationId"
	| "jobId"
	| "probeId"
	| "channelId"

export interface StoreIdentity {
	storeUuid: string
	restoreGeneration: number
	/** Greatest deleted seq; 0 when nothing was pruned. Decimal string. */
	pruneWatermark: string
	pruneGeneration: number
	/** Greatest committed seq; "0" for an empty store. */
	committedMax: string
}

/** Provided by the storage lane; consumed by the query lane and Main. */
export interface ActivityStoreHandle {
	readonly dbPath: string
	/** Fresh values from the writer after the last commit/prune. */
	identity(): StoreIdentity
	/** 32 random bytes generated on create, persisted in store_meta. */
	cursorKey(): Buffer
	/** Wakeup only; listeners must re-read committed rows. Returns unsubscribe. */
	onCommit(listener: (identity: StoreIdentity) => void): () => void
	/** Non-blocking; never throws on overload, counts loss instead. */
	admit(envelope: DecodeEnvelope): AdmitResult
	/**
	 * WG1: admits one closed analog transmission as an `analog-transmission` record (eventId =
	 * payload.transmissionId), with the same non-blocking, loss-counting semantics as admit().
	 * Never "telemetry".
	 */
	admitTransmission(input: AnalogTransmissionAdmission): AdmitResult
	stats(): ActivityStoreStats
	close(): Promise<void>
}

export interface AnalogTransmissionAdmission {
	payload: AnalogTransmissionPayload
	/** ISO; the transmission's endedAt by convention. */
	producedAt: string
	/** ISO; allocated by the producer when it hands the record over. */
	receivedAt: string
}

export type AdmitRejection =
	| "rate-limited"
	| "queue-full"
	| "store-paused"
	| "closed"
	/** Excluded telemetry output; counted, not a loss. */
	| "telemetry"
	/** A position-only update inside its entity's coalescing window; counted, not a loss. */
	| "coalesced"

export type AdmitResult =
	| { admitted: true }
	| { admitted: false; reason: AdmitRejection }

export interface ActivityStoreStats {
	admitted: number
	committed: number
	duplicates: number
	dropped: Record<
		"rate-limited" | "queue-full" | "store-paused" | "write-failed" | "closed",
		number
	>
	excludedTelemetry: number
	/** Position-only receptions not stored inside their entity's window (WG1). */
	coalescedPositions: number
	queueDepth: number
	queueBytes: number
	dbBytes: number
	walBytes: number
	rows: number
	oldestReceivedAt: string | null
	pruneWatermark: string
	paused: boolean
	/** `stopped` after the writer exits or a write times out. No restart in this batch. */
	writer: "running" | "stopped"
}

/** Query filters shared by REST, facets and WS replay (query lane). */
export interface ActivityQuery {
	kinds?: readonly ActivityKind[]
	sourceIds?: readonly string[]
	decoderIds?: readonly string[]
	protocols?: readonly string[]
	categories?: readonly ActivityCategory[]
	frequencyHz?: { min?: number; max?: number }
	/** ISO timestamps; a filter, not chronology authority. */
	producedAt?: { from?: string; to?: string }
	refs?: readonly { type: ActivityRefType; value: string }[]
	entityKey?: string
	/** Plain text, at most 256 UTF-8 bytes; never raw FTS syntax. */
	text?: string
}

/** Provided by the query lane; Main mounts it. */
export interface ActivityQueryService {
	search(input: ActivitySearchRequest): Promise<ActivitySearchPage>
	detail(eventId: string): Promise<ActivityRecord | null>
	facets(input: ActivityFacetRequest): Promise<ActivityFacetResult>
	/** Starts catch-up then live follow; frames are delivered in commitSeq order. */
	replay(
		input: ActivityReplayRequest,
		sink: ActivityReplaySink,
	): ActivityReplayHandle
	close(): Promise<void>
}

export interface ActivitySearchRequest {
	query: ActivityQuery
	order?: "desc" | "asc"
	limit?: number
	/** Continuation from a previous page; query must hash identically. */
	pageToken?: string
}

export interface ActivitySearchPage {
	items: readonly ActivitySummary[]
	nextPageToken: string | null
	/** Replay cursor positioned at the snapshot's high-water mark H. */
	replayCursor: string
	snapshot: { lowBarrier: string; highWater: string; expiresAt: string }
	searchCoverage: "bounded-projection"
}

export interface ActivityFacetRequest {
	query: ActivityQuery
	dimensions: readonly (
		| "category"
		| "protocol"
		| "decoderId"
		| "sourceId"
		| "kind"
	)[]
}

export interface ActivityFacetResult {
	/** At most 32 values per dimension, count descending then value ascending. */
	facets: Record<string, readonly { value: string | null; count: number }[]>
	/** Rows examined, capped; truncated means counts are lower bounds. */
	scanned: number
	truncated: boolean
	snapshot: { lowBarrier: string; highWater: string }
}

export interface ActivityReplayRequest {
	query: ActivityQuery
	/** Omit to start live at the current committed max. */
	cursor?: string
}

export type ActivityReplayFrame =
	| ActivityReplayRecordsFrame
	| ActivityReplayProgressFrame
	| ActivityReplayResetFrame

export interface ActivityReplayRecordsFrame {
	type: "records"
	items: readonly ActivitySummary[]
	scannedThrough: string
	cursor: string
}

export interface ActivityReplayProgressFrame {
	type: "progress"
	scannedThrough: string
	cursor: string
}

export interface ActivityReplayResetFrame {
	type: "reset"
	reason:
		| "cursor-gap"
		| "cursor-expired"
		| "store-changed"
		| "query-changed"
		| "invalid-cursor"
		| "reader-failed"
}

export interface ActivityReplaySink {
	/** Returns false when the client buffer is full; replay pauses until resume(). */
	send(frame: ActivityReplayFrame): boolean
}

export interface ActivityReplayHandle {
	resume(): void
	stop(): void
}
