import { DCS_CODE_SET, DCS_STANDARD_CODES } from "@wavekit/api-types"
import { isCtcssToneHz } from "../../audio-tones/ctcss.js"
import { isDtmfDigitString } from "../../audio-tones/dtmf.js"
import { WaveKitError } from "../../../utils/errors.js"
import {
	ACTIVITY_RECORD_VERSION,
	MAX_INDEXED_TEXT_BYTES,
	MAX_SUMMARY_BYTES,
} from "./contract.js"
import type {
	ActivityCategory,
	ActivityKind,
	ActivityRecord,
	ActivityRefType,
	ActivitySummary,
	AnalogTransmissionPayload,
	IngestionGapPayload,
} from "./contract.js"
import type { DecodeEnvelope, DecodeField, JsonValue } from "../types.js"

/**
 * Pure projection of an ActivityRecord onto one activity row.
 * `commitSeq` on the input is ignored. Stored JSON omits it; parseStoredRecord
 * and parseStoredSummary fill it from the SQLite seq column.
 */
export interface BuiltActivityRow {
	eventId: string
	kind: ActivityKind
	producedAtMs: number
	receivedAtMs: number
	sourceId: string | null
	decoderId: string | null
	protocol: string | null
	category: ActivityCategory
	frequencyHz: number | null
	entityKey: string | null
	summaryJson: string
	recordJson: string
	recordBytes: number
	ftsText: string
	refs: readonly ActivityRef[]
}

export interface ActivityRef {
	type: ActivityRefType
	value: string
}

/** One `activity` table row, as returned by node:sqlite or any equivalent reader. */
export interface StoredActivityRow {
	seq: string | number | bigint
	event_id: string
	kind: string
	produced_at_ms?: number | bigint
	received_at_ms?: number | bigint
	source_id?: string | null
	decoder_id?: string | null
	protocol?: string | null
	category?: string
	frequency_hz?: number | bigint | null
	entity_key?: string | null
	summary_json: string
	record_json: string
	record_bytes?: number | bigint
}

const CATEGORIES = new Set<ActivityCategory>([
	"aircraft",
	"marine",
	"aviation-data",
	"voice",
	"paging",
	"aprs",
	"sensors",
	"mesh",
	"other",
])

export function buildActivityRow(record: ActivityRecord): BuiltActivityRow {
	const producedAtMs = timestampMs(record.producedAt)
	const receivedAtMs = timestampMs(record.receivedAt)
	if (record.kind === "analog-transmission") {
		const payload = storedTransmission(record.payload)
		const recordJson = JSON.stringify({
			version: ACTIVITY_RECORD_VERSION,
			eventId: record.eventId,
			producedAt: record.producedAt,
			receivedAt: record.receivedAt,
			kind: record.kind,
			payload,
		})
		return transmissionRow(
			payload,
			record,
			producedAtMs,
			receivedAtMs,
			recordJson,
		)
	}
	const stored = {
		version: ACTIVITY_RECORD_VERSION,
		eventId: record.eventId,
		producedAt: record.producedAt,
		receivedAt: record.receivedAt,
		kind: record.kind,
		payload: record.payload,
	}
	const recordJson = JSON.stringify(stored)
	if (record.kind === "ingestion-gap")
		return gapRow(
			record.payload,
			record,
			producedAtMs,
			receivedAtMs,
			recordJson,
		)
	return receptionRow(
		record.payload,
		record,
		producedAtMs,
		receivedAtMs,
		recordJson,
	)
}

export function parseStoredRecord(row: StoredActivityRow): ActivityRecord {
	const seq = decimalSeq(row.seq)
	let parsed: unknown
	try {
		parsed = JSON.parse(row.record_json)
	} catch {
		return corrupt("record JSON")
	}
	const body = plain(parsed)
	if (!body) return corrupt("record")
	if (body["version"] !== ACTIVITY_RECORD_VERSION) return corrupt("version")
	if (body["eventId"] !== row.event_id || typeof body["eventId"] !== "string")
		return corrupt("eventId")
	if (body["kind"] !== row.kind) return corrupt("kind")
	if (
		typeof body["producedAt"] !== "string" ||
		typeof body["receivedAt"] !== "string"
	)
		return corrupt("timestamps")
	const kind = body["kind"]
	const payload = body["payload"]
	if (kind === "decoder-reception") {
		if (!isEnvelope(payload)) return corrupt("payload")
		return {
			version: ACTIVITY_RECORD_VERSION,
			eventId: row.event_id,
			commitSeq: seq,
			producedAt: body["producedAt"],
			receivedAt: body["receivedAt"],
			kind,
			payload,
		}
	}
	if (kind === "ingestion-gap") {
		if (!isGap(payload)) return corrupt("payload")
		return {
			version: ACTIVITY_RECORD_VERSION,
			eventId: row.event_id,
			commitSeq: seq,
			producedAt: body["producedAt"],
			receivedAt: body["receivedAt"],
			kind,
			payload,
		}
	}
	if (kind === "analog-transmission") {
		if (!isTransmission(payload)) return corrupt("payload")
		return {
			version: ACTIVITY_RECORD_VERSION,
			eventId: row.event_id,
			commitSeq: seq,
			producedAt: body["producedAt"],
			receivedAt: body["receivedAt"],
			kind,
			payload,
		}
	}
	return corrupt("kind")
}

export function parseStoredSummary(row: StoredActivityRow): ActivitySummary {
	let parsed: unknown
	try {
		parsed = JSON.parse(row.summary_json)
	} catch {
		return corrupt("summary JSON")
	}
	const body = plain(parsed)
	if (!body) return corrupt("summary")
	const category = body["category"]
	if (!isCategory(category)) return corrupt("summary category")
	const kind = body["kind"]
	if (!isKind(kind)) return corrupt("summary kind")
	if (typeof body["eventId"] !== "string") return corrupt("summary eventId")
	if (
		typeof body["producedAt"] !== "string" ||
		typeof body["receivedAt"] !== "string"
	)
		return corrupt("summary timestamps")
	const fields = body["fields"]
	if (!Array.isArray(fields) || !fields.every(isField))
		return corrupt("summary fields")
	const position = body["position"]
	const summary: ActivitySummary = {
		eventId: body["eventId"],
		commitSeq: decimalSeq(row.seq),
		kind,
		producedAt: body["producedAt"],
		receivedAt: body["receivedAt"],
		decoderId: nullableString(body["decoderId"]),
		sourceId: nullableString(body["sourceId"]),
		protocol: nullableString(body["protocol"]),
		category,
		frequencyHz: nullableNumber(body["frequencyHz"]),
		entityKey: nullableString(body["entityKey"]),
		title: body["title"] === null ? null : nullableString(body["title"]),
		fields,
	}
	if (isPosition(position)) return { ...summary, position }
	return summary
}

/** UTF-8 truncation that never splits a code point. Exported for the property test. */
export function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return ""
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
	const bytes = Buffer.from(value, "utf8")
	// bytes[maxBytes] is the first byte cut. A continuation byte there means
	// the cut splits a code point: step back to its lead byte and drop it.
	let end = maxBytes
	while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end--
	return bytes.subarray(0, end).toString("utf8")
}

const MODULATIONS = new Set<AnalogTransmissionPayload["modulation"]>([
	"nfm",
	"wfm",
	"am",
	"usb",
	"lsb",
	"dsb",
	"cw",
	"raw",
])

const CLOSE_REASONS = new Set<AnalogTransmissionPayload["closeReason"]>([
	"squelch",
	"retune",
	"config",
	"stopped",
	"max-duration",
])

const TRANSMISSION_KEYS = [
	"transmissionId",
	"sourceId",
	"startedAt",
	"endedAt",
	"durationMs",
	"frequency",
	"modulation",
	"bandwidthHz",
	"squelchMode",
	"thresholdDbfs",
	"peakChannelPowerDbfs",
	"meanChannelPowerDbfs",
	"closeReason",
] as const

function transmissionRow(
	payload: AnalogTransmissionPayload,
	record: ActivityRecord,
	producedAtMs: number,
	receivedAtMs: number,
	recordJson: string,
): BuiltActivityRow {
	const frequencyHz =
		payload.frequency === null ? null : roundHz(payload.frequency.hz)
	const modulation = payload.modulation.toUpperCase()
	const title =
		frequencyHz === null
			? `${modulation} transmission`
			: `${modulation} ${formatMHz(frequencyHz)} MHz`
	const fields: DecodeField[] = [
		{
			key: "durationMs",
			label: "Duration",
			value: payload.durationMs,
			unit: "ms",
		},
		{
			key: "modulation",
			label: "Modulation",
			value: payload.modulation,
		},
	]
	if (payload.peakChannelPowerDbfs !== null) {
		fields.push({
			key: "peakChannelPowerDbfs",
			label: "Peak channel power",
			value: payload.peakChannelPowerDbfs,
			unit: "dBFS",
		})
	}
	if (payload.tone?.ctcssHz != null) {
		fields.push({
			key: "ctcssHz",
			label: "CTCSS",
			value: payload.tone.ctcssHz,
			unit: "Hz",
		})
	}
	if (payload.tone?.dtmf != null) {
		fields.push({
			key: "dtmf",
			label: "DTMF",
			value: payload.tone.dtmf,
		})
	}
	const dcs = payload.tone?.dcs ?? null
	if (dcs !== null) {
		fields.push({
			key: "dcs",
			label: "DCS",
			value: dcsLabel(dcs),
		})
	}
	const summaryJson = fitTransmissionSummary({
		eventId: record.eventId,
		kind: "analog-transmission",
		producedAt: record.producedAt,
		receivedAt: record.receivedAt,
		decoderId: null,
		sourceId: payload.sourceId,
		protocol: "analog",
		category: "voice",
		frequencyHz,
		entityKey: null,
		title,
		fields,
	})
	const ftsParts = ["analog-transmission", payload.modulation, payload.sourceId]
	if (frequencyHz !== null) ftsParts.push(String(frequencyHz))
	if (payload.tone?.ctcssHz != null)
		ftsParts.push(`CTCSS ${payload.tone.ctcssHz}`)
	if (payload.tone?.dtmf != null) ftsParts.push(payload.tone.dtmf)
	if (dcs !== null) {
		ftsParts.push(`DCS ${dcsLabel(dcs)}`)
		const twin = dcsTwinOf(dcs)
		if (twin !== null) ftsParts.push(`DCS ${dcsLabel(twin)}`)
	}
	return {
		eventId: record.eventId,
		kind: "analog-transmission",
		producedAtMs,
		receivedAtMs,
		sourceId: payload.sourceId,
		decoderId: null,
		protocol: "analog",
		category: "voice",
		frequencyHz,
		entityKey: null,
		summaryJson,
		recordJson,
		recordBytes: Buffer.byteLength(recordJson, "utf8"),
		ftsText: truncateUtf8(ftsParts.join("\n"), MAX_INDEXED_TEXT_BYTES),
		refs: [],
	}
}

/** Megahertz with trailing zeros trimmed: 446006250 → "446.00625". */
function formatMHz(hz: number): string {
	const sign = hz < 0 ? "-" : ""
	const abs = Math.abs(hz)
	const whole = Math.trunc(abs / 1_000_000)
	const frac = abs % 1_000_000
	if (frac === 0) return `${sign}${whole}`
	const digits = String(frac).padStart(6, "0").replace(/0+$/, "")
	return `${sign}${whole}.${digits}`
}

function storedTransmission(
	payload: AnalogTransmissionPayload,
): AnalogTransmissionPayload {
	if (!isTransmission(payload)) return corrupt("payload")
	return {
		transmissionId: payload.transmissionId,
		sourceId: payload.sourceId,
		startedAt: payload.startedAt,
		endedAt: payload.endedAt,
		durationMs: payload.durationMs,
		frequency:
			payload.frequency === null
				? null
				: {
						hz: payload.frequency.hz,
						tuningTrust: payload.frequency.tuningTrust,
					},
		modulation: payload.modulation,
		bandwidthHz: payload.bandwidthHz,
		squelchMode: payload.squelchMode,
		thresholdDbfs: payload.thresholdDbfs,
		peakChannelPowerDbfs: payload.peakChannelPowerDbfs,
		meanChannelPowerDbfs: payload.meanChannelPowerDbfs,
		closeReason: payload.closeReason,
		...(payload.tone === undefined
			? {}
			: {
					tone: {
						ctcssHz: payload.tone.ctcssHz,
						dtmf: payload.tone.dtmf,
						...(payload.tone.dcs === undefined
							? {}
							: {
									dcs:
										payload.tone.dcs === null
											? null
											: {
													code: payload.tone.dcs.code,
													polarity: payload.tone.dcs.polarity,
												},
								}),
					},
				}),
	}
}

function receptionRow(
	envelope: DecodeEnvelope,
	record: ActivityRecord,
	producedAtMs: number,
	receivedAtMs: number,
	recordJson: string,
): BuiltActivityRow {
	const frequencyHz =
		envelope.provenance.frequency === null
			? null
			: roundHz(envelope.provenance.frequency.hz)
	const refs: ActivityRef[] = []
	pushRef(refs, "callId", envelope.refs?.callId)
	pushRef(refs, "discoveryId", envelope.refs?.discoveryId)
	pushRef(refs, "observationId", envelope.refs?.observationId)
	pushRef(refs, "jobId", envelope.provenance.jobId)
	pushRef(refs, "probeId", envelope.provenance.probeId)
	pushRef(refs, "channelId", envelope.provenance.channelId)
	const summaryJson = fitSummary({
		eventId: record.eventId,
		kind: "decoder-reception",
		producedAt: record.producedAt,
		receivedAt: record.receivedAt,
		decoderId: envelope.decoderId,
		sourceId: envelope.provenance.sourceId,
		protocol: envelope.protocol,
		category: envelope.category,
		frequencyHz,
		entityKey: envelope.entityKey,
		title: envelope.title,
		fields: envelope.fields.map(field => ({ ...field })),
		...(envelope.position === undefined ? {} : { position: envelope.position }),
	})
	return {
		eventId: record.eventId,
		kind: "decoder-reception",
		producedAtMs,
		receivedAtMs,
		sourceId: envelope.provenance.sourceId,
		decoderId: envelope.decoderId,
		protocol: envelope.protocol,
		category: envelope.category,
		frequencyHz,
		entityKey: envelope.entityKey,
		summaryJson,
		recordJson,
		recordBytes: Buffer.byteLength(recordJson, "utf8"),
		ftsText: indexedText(envelope),
		refs,
	}
}

function gapRow(
	payload: IngestionGapPayload,
	record: ActivityRecord,
	producedAtMs: number,
	receivedAtMs: number,
	recordJson: string,
): BuiltActivityRow {
	const summaryJson = fitSummary({
		eventId: record.eventId,
		kind: "ingestion-gap",
		producedAt: record.producedAt,
		receivedAt: record.receivedAt,
		decoderId: null,
		sourceId: null,
		protocol: null,
		category: "other",
		frequencyHz: null,
		entityKey: null,
		title: `Ingestion gap (${payload.reason})`,
		fields: [
			{
				key: "dropped",
				label: "Dropped",
				value: payload.dropped,
			},
		],
	})
	const ftsText = truncateUtf8(
		[
			"ingestion-gap",
			payload.reason,
			String(payload.dropped),
			...payload.decoderIds,
		].join("\n"),
		MAX_INDEXED_TEXT_BYTES,
	)
	return {
		eventId: record.eventId,
		kind: "ingestion-gap",
		producedAtMs,
		receivedAtMs,
		sourceId: null,
		decoderId: null,
		protocol: null,
		category: "other",
		frequencyHz: null,
		entityKey: null,
		summaryJson,
		recordJson,
		recordBytes: Buffer.byteLength(recordJson, "utf8"),
		ftsText,
		refs: [],
	}
}

interface SummaryDraft {
	eventId: string
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
	fields: DecodeField[]
	position?: DecodeEnvelope["position"]
}

/**
 * Transmission summaries drop identifier bytes until they fit. fitSummary
 * leaves eventId and sourceId intact, which is required for decoder rows;
 * a long source id must not make this summary fail the 4 KiB writer check.
 */
function fitTransmissionSummary(draft: SummaryDraft): string {
	let sourceId = draft.sourceId
	let eventId = draft.eventId
	const build = (): string => fitSummary({ ...draft, sourceId, eventId })
	let json = build()
	while (Buffer.byteLength(json, "utf8") > MAX_SUMMARY_BYTES && sourceId) {
		const next = truncateUtf8(
			sourceId,
			Math.max(0, Buffer.byteLength(sourceId, "utf8") - 64),
		)
		sourceId = next.length === sourceId.length ? "" : next
		json = build()
	}
	while (
		Buffer.byteLength(json, "utf8") > MAX_SUMMARY_BYTES &&
		eventId.length > 0
	) {
		const next = truncateUtf8(
			eventId,
			Math.max(0, Buffer.byteLength(eventId, "utf8") - 64),
		)
		eventId = next.length === eventId.length ? "" : next
		json = build()
	}
	return json
}

function fitSummary(draft: SummaryDraft): string {
	const fields = draft.fields.slice()
	let title = draft.title
	let includePosition = draft.position !== undefined
	const build = (): string => {
		const summary: Record<string, unknown> = {
			eventId: draft.eventId,
			kind: draft.kind,
			producedAt: draft.producedAt,
			receivedAt: draft.receivedAt,
			decoderId: draft.decoderId,
			sourceId: draft.sourceId,
			protocol: draft.protocol,
			category: draft.category,
			frequencyHz: draft.frequencyHz,
			entityKey: draft.entityKey,
			title,
			fields,
		}
		if (includePosition && draft.position !== undefined)
			summary["position"] = draft.position
		return JSON.stringify(summary)
	}
	let json = build()
	while (
		Buffer.byteLength(json, "utf8") > MAX_SUMMARY_BYTES &&
		fields.length > 0
	) {
		fields.pop()
		json = build()
	}
	while (
		title !== null &&
		Buffer.byteLength(json, "utf8") > MAX_SUMMARY_BYTES
	) {
		const next = truncateUtf8(
			title,
			Math.max(0, Buffer.byteLength(title, "utf8") - 32),
		)
		title = next.length === 0 ? null : next
		json = build()
	}
	if (includePosition && Buffer.byteLength(json, "utf8") > MAX_SUMMARY_BYTES) {
		includePosition = false
		json = build()
	}
	if (Buffer.byteLength(json, "utf8") > MAX_SUMMARY_BYTES) {
		title = null
		json = build()
	}
	return json
}

function indexedText(envelope: DecodeEnvelope): string {
	const parts: string[] = []
	if (envelope.title) parts.push(envelope.title)
	if (envelope.protocol) parts.push(envelope.protocol)
	for (const field of envelope.fields) {
		parts.push(field.label)
		if (typeof field.value === "string") parts.push(field.value)
		else if (
			typeof field.value === "number" ||
			typeof field.value === "boolean"
		)
			parts.push(String(field.value))
	}
	collectStrings(envelope.decodedData, parts, 0)
	return truncateUtf8(parts.join("\n"), MAX_INDEXED_TEXT_BYTES)
}

function isJsonObject(
	value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function collectStrings(value: JsonValue, out: string[], depth: number): void {
	if (typeof value === "string") {
		out.push(value)
		return
	}
	if (depth >= 16) return
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, out, depth + 1)
		return
	}
	if (isJsonObject(value)) {
		for (const key of Object.keys(value)) {
			const child = value[key]
			if (child !== undefined) collectStrings(child, out, depth + 1)
		}
	}
}

function pushRef(
	refs: ActivityRef[],
	type: ActivityRefType,
	value: string | undefined,
): void {
	if (value === undefined) return
	if (refs.some(ref => ref.type === type && ref.value === value)) return
	refs.push({ type, value })
}

function roundHz(hz: number): number {
	const rounded = Math.round(hz)
	if (!Number.isSafeInteger(rounded)) return corrupt("frequency")
	return rounded
}

function timestampMs(iso: string): number {
	const ms = Date.parse(iso)
	if (!Number.isFinite(ms)) return corrupt("timestamp")
	return ms
}

export function decimalSeq(value: string | number | bigint): string {
	if (typeof value === "bigint") {
		if (value < 0n) return corrupt("seq")
		return value.toString(10)
	}
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || value < 0) return corrupt("seq")
		return value.toString(10)
	}
	if (!/^\d+$/.test(value)) return corrupt("seq")
	return value
}

function corrupt(what: string): never {
	throw new WaveKitError(
		`Stored activity ${what} is corrupt`,
		"ACTIVITY_RECORD_CORRUPT",
	)
}

function plain(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined
	return value as Record<string, unknown>
}

function isCategory(value: unknown): value is ActivityCategory {
	return typeof value === "string" && CATEGORIES.has(value as ActivityCategory)
}

function isKind(value: unknown): value is ActivityKind {
	return (
		value === "decoder-reception" ||
		value === "call-lifecycle" ||
		value === "analog-transmission" ||
		value === "scanner-result" ||
		value === "recording-change" ||
		value === "ingestion-gap"
	)
}

function nullableString(value: unknown): string | null {
	if (value === null || value === undefined) return null
	if (typeof value !== "string") return corrupt("summary string")
	return value
}

function nullableNumber(value: unknown): number | null {
	if (value === null || value === undefined) return null
	if (typeof value !== "number" || !Number.isFinite(value))
		return corrupt("summary number")
	return value
}

function isField(value: unknown): value is DecodeField {
	const body = plain(value)
	if (!body) return false
	if (typeof body["key"] !== "string" || typeof body["label"] !== "string")
		return false
	const fieldValue = body["value"]
	if (
		fieldValue !== null &&
		typeof fieldValue !== "string" &&
		typeof fieldValue !== "number" &&
		typeof fieldValue !== "boolean"
	)
		return false
	return body["unit"] === undefined || typeof body["unit"] === "string"
}

function isPosition(
	value: unknown,
): value is NonNullable<DecodeEnvelope["position"]> {
	const body = plain(value)
	if (!body) return false
	return (
		typeof body["lat"] === "number" &&
		typeof body["lon"] === "number" &&
		(body["altM"] === undefined || typeof body["altM"] === "number")
	)
}

function isEnvelope(value: unknown): value is DecodeEnvelope {
	const body = plain(value)
	if (!body) return false
	return (
		body["version"] === 1 &&
		typeof body["eventId"] === "string" &&
		typeof body["decoderId"] === "string" &&
		typeof body["outputType"] === "string" &&
		isCategory(body["category"])
	)
}

function isIso(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function isNullableFinite(value: unknown): value is number | null {
	if (value === null) return true
	return typeof value === "number" && Number.isFinite(value)
}

function sameKeys(
	body: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const present = Object.keys(body)
	return (
		present.length === keys.length && keys.every(key => present.includes(key))
	)
}

function isTransmissionFrequency(
	value: unknown,
): value is AnalogTransmissionPayload["frequency"] {
	if (value === null) return true
	const body = plain(value)
	if (!body || !sameKeys(body, ["hz", "tuningTrust"])) return false
	if (typeof body["hz"] !== "number" || !Number.isFinite(body["hz"]))
		return false
	const trust = body["tuningTrust"]
	return trust === "commanded" || trust === "relay" || trust === "unverified"
}

type StoredDcs = { code: string; polarity: "normal" | "inverted" }

const dcsLabel = (dcs: StoredDcs): string =>
	`${dcs.code}${dcs.polarity === "normal" ? "N" : "I"}`

const DCS_MASK = (1 << 23) - 1
const DCS_STANDARD_SET: ReadonlySet<string> = new Set(DCS_STANDARD_CODES)
let dcsTwins: Map<string, string> | undefined

/** Golay(23,12) word of a 9-bit code, generator 0xC75 (TIA-603 layout, 100 prefix). */
function dcsWord(code: number): number {
	const data = code | (0b100 << 9)
	let r = data << 11
	for (let i = 22; i >= 11; i--) if (r & (1 << i)) r ^= 0xc75 << (i - 11)
	return ((data << 11) | r) & DCS_MASK
}

/** Standard code whose word is a rotation of the complement, built once per process. */
function dcsTwinTable(): Map<string, string> {
	if (dcsTwins) return dcsTwins
	const byWord = new Map<number, string>()
	for (const code of DCS_STANDARD_CODES)
		byWord.set(dcsWord(Number.parseInt(code, 8)), code)
	const table = new Map<string, string>()
	for (const code of DCS_STANDARD_CODES) {
		const inverted = ~dcsWord(Number.parseInt(code, 8)) & DCS_MASK
		for (let k = 0; k < 23; k++) {
			const rotated = ((inverted >>> k) | (inverted << (23 - k))) & DCS_MASK
			const other = byWord.get(rotated)
			if (other !== undefined) {
				table.set(code, other)
				break
			}
		}
	}
	dcsTwins = table
	return table
}

/** The same transmission read the other way round: twin code, flipped polarity. */
function dcsTwinOf(dcs: StoredDcs): StoredDcs | null {
	const code = dcsTwinTable().get(dcs.code)
	if (code === undefined) return null
	return {
		code,
		polarity: dcs.polarity === "normal" ? "inverted" : "normal",
	}
}

function isDcs(value: unknown): boolean {
	if (value === null) return true
	const body = plain(value)
	if (!body || !sameKeys(body, ["code", "polarity"])) return false
	const code = body["code"]
	if (typeof code !== "string" || !/^[0-7]{3}$/.test(code)) return false
	if (DCS_CODE_SET === "standard" && !DCS_STANDARD_SET.has(code)) return false
	return body["polarity"] === "normal" || body["polarity"] === "inverted"
}

function isTone(value: unknown): boolean {
	const body = plain(value)
	if (!body) return false
	if (!sameKeys(body, ["ctcssHz", "dtmf"])) {
		if (!sameKeys(body, ["ctcssHz", "dtmf", "dcs"])) return false
		if (!isDcs(body["dcs"])) return false
	}
	const hz = body["ctcssHz"]
	if (hz !== null && (typeof hz !== "number" || !isCtcssToneHz(hz)))
		return false
	const dtmf = body["dtmf"]
	if (dtmf !== null && (typeof dtmf !== "string" || !isDtmfDigitString(dtmf)))
		return false
	return true
}

/** Exactly the WG1 keys, or those keys plus a valid `tone`. */
function transmissionKeysOk(body: Record<string, unknown>): boolean {
	const present = Object.keys(body)
	const withTone = present.includes("tone")
	if (withTone) {
		if (present.length !== TRANSMISSION_KEYS.length + 1) return false
		if (!isTone(body["tone"])) return false
	} else if (present.length !== TRANSMISSION_KEYS.length) return false
	return TRANSMISSION_KEYS.every(key => present.includes(key))
}

function isTransmission(value: unknown): value is AnalogTransmissionPayload {
	const body = plain(value)
	if (!body || !transmissionKeysOk(body)) return false
	if (
		typeof body["transmissionId"] !== "string" ||
		body["transmissionId"].length === 0 ||
		typeof body["sourceId"] !== "string"
	)
		return false
	if (!isIso(body["startedAt"]) || !isIso(body["endedAt"])) return false
	if (
		typeof body["durationMs"] !== "number" ||
		!Number.isFinite(body["durationMs"]) ||
		body["durationMs"] < 0
	)
		return false
	if (!isTransmissionFrequency(body["frequency"])) return false
	if (
		!MODULATIONS.has(
			body["modulation"] as AnalogTransmissionPayload["modulation"],
		)
	)
		return false
	if (
		typeof body["bandwidthHz"] !== "number" ||
		!Number.isFinite(body["bandwidthHz"])
	)
		return false
	if (body["squelchMode"] !== "manual" && body["squelchMode"] !== "auto")
		return false
	if (
		typeof body["thresholdDbfs"] !== "number" ||
		!Number.isFinite(body["thresholdDbfs"])
	)
		return false
	if (
		!isNullableFinite(body["peakChannelPowerDbfs"]) ||
		!isNullableFinite(body["meanChannelPowerDbfs"])
	)
		return false
	return CLOSE_REASONS.has(
		body["closeReason"] as AnalogTransmissionPayload["closeReason"],
	)
}

function isGap(value: unknown): value is IngestionGapPayload {
	const body = plain(value)
	if (!body) return false
	const reason = body["reason"]
	if (
		reason !== "rate-limited" &&
		reason !== "queue-full" &&
		reason !== "write-failed" &&
		reason !== "store-paused"
	)
		return false
	if (typeof body["dropped"] !== "number" || !Array.isArray(body["decoderIds"]))
		return false
	return (
		typeof body["fromReceivedAt"] === "string" &&
		typeof body["toReceivedAt"] === "string" &&
		body["decoderIds"].every(id => typeof id === "string")
	)
}
