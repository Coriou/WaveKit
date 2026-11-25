// GET /api/transmissions/:ref, as the core serves it (src/api/routes/transmissions.ts): a malformed ref
// is 400 TRANSMISSION_REF_INVALID, an unknown one 404 TRANSMISSION_NOT_FOUND. The mock has no
// transmission registry, so it mints no ids: `rec:` and `evt:` resolve from the mock's recordings
// and Activity rows with `id` null, and a `tx_` or `obs:` ref is 404. A digital call is "clear" and
// lists its file only when its decoder call row (decoder-reception) links that file in `recording`,
// the decoder's link the core accepts; a row whose `encrypted` field is true reads "encrypted";
// anything else "unproven" with no audio. Rule six as the core applies it: an unproven or encrypted
// call shows nothing of its file (no key, facts, times, file name in the raw row), and its file's
// own `rec:` ref answers exactly as an unknown ref (404). An analog recording's `copy` comes from the catalogue items'
// `copyOf` (the original it names, the listed copies naming it), as the core builds it.
import type { FastifyInstance } from "fastify"
import type {
	ActivityRecord,
	ActivitySummary,
	JsonValue,
	RecordingInventoryItem,
	TransmissionCopy,
	TransmissionDto,
	TransmissionTone,
} from "@wavekit/api-types"

/** A field key or value that names a recording file (the core's redact.ts). */
const RECORDING_FIELD_KEY = /wav|recording|^file(name)?$|path/i
const namesRecording = (v: unknown): boolean =>
	typeof v === "string" && (/\.wav$/i.test(v) || v.startsWith("dsd~"))

/**
 * A digital call row's stored record with every file reference gone unless `keep` admits its
 * `dsd~` key: the core's redactCallRecordingRefs (src/core/transmissions/redact.ts). Other kinds
 * pass unchanged.
 */
export function redactMockCallRecord(
	record: ActivityRecord,
	keep: (key: string) => boolean,
): ActivityRecord {
	if (record.kind !== "decoder-reception") return record
	const kept = (v: unknown) => typeof v === "string" && keep(`dsd~${v}`)
	const payload = record.payload
	const fields = payload.fields.filter(
		f =>
			!(
				(RECORDING_FIELD_KEY.test(f.key) || namesRecording(f.value)) &&
				!kept(f.value)
			),
	)
	let decodedData = payload.decodedData
	if (
		typeof decodedData === "object" &&
		decodedData !== null &&
		!Array.isArray(decodedData)
	) {
		const rest: { [key: string]: JsonValue } = {}
		for (const [field, value] of Object.entries(decodedData)) {
			if (field === "wavFile") {
				if (kept(value)) rest[field] = value
				continue
			}
			if (
				(RECORDING_FIELD_KEY.test(field) || namesRecording(value)) &&
				!kept(value)
			)
				continue
			rest[field] = value
		}
		decodedData = rest
	}
	const out: Record<string, unknown> = { ...payload, fields, decodedData }
	const link = (payload as { recording?: { id?: unknown } }).recording
	if (link !== undefined && !(typeof link.id === "string" && keep(link.id)))
		delete out["recording"]
	return { ...record, payload: out as unknown as typeof payload }
}

/** Whether a mock row's stored record says its call is encrypted (its `encrypted` field). */
function encryptedRow(record: ActivityRecord): boolean {
	return (
		record.kind === "decoder-reception" &&
		record.payload.fields.some(f => f.key === "encrypted" && f.value === true)
	)
}

/**
 * The key a call row's file may be named by: its decoder link (`recording`) when the call is not
 * encrypted, else null (nothing of its file is named).
 */
export function mockCallLinkedKey(row: {
	summary: ActivitySummary
	record: ActivityRecord
}): string | null {
	if (row.summary.kind !== "decoder-reception") return null
	if (encryptedRow(row.record)) return null
	return row.summary.recording?.id ?? null
}

const REF = /^(tx_[0-9A-HJKMNP-TV-Z]{26}|(rec|evt|obs):[^\s]{1,512})$/

export interface TransmissionsMockOptions {
	/** The mock's catalogue items now. */
	recordings: () => readonly RecordingInventoryItem[]
	/** A mock Activity row and its stored record, by event id. */
	activity: (
		eventId: string,
	) => { summary: ActivitySummary; record: ActivityRecord } | null
}

function toneOf(item: RecordingInventoryItem | undefined): TransmissionTone {
	const tone = item?.facts?.tone
	if (tone === undefined || item?.facts == null)
		return {
			state: "not-measured",
			ctcssHz: null,
			dcs: null,
			dcsChecked: false,
			from: null,
			why: item?.facts == null ? "no-facts" : "undetermined",
		}
	if (tone === null)
		return {
			state: "none",
			ctcssHz: null,
			dcs: null,
			dcsChecked: false,
			from: "recorder",
			why: null,
		}
	return {
		state: "heard",
		ctcssHz: tone.kind === "ctcss" ? tone.hz : null,
		dcs: tone.kind === "dcs" ? { code: tone.code, polarity: null } : null,
		dcsChecked: false,
		from: "recorder",
		why: null,
	}
}

/** Copies listed per transmission (the core's TRANSMISSION_COPIES_MAX). */
const COPIES_MAX = 8

const keyOf = (i: RecordingInventoryItem): string => i.key ?? i.id
const hzOf = (i: RecordingInventoryItem): number | null =>
	i.facts?.frequencyHz ?? i.frequencyHz ?? null

/** TransmissionDto.copy of an analog item, from the catalogue's `copyOf` links only. */
function copyOf(
	item: RecordingInventoryItem | undefined,
	items: readonly RecordingInventoryItem[],
): TransmissionCopy | null {
	if (item?.kind !== "scanner-analog") return null
	const named = item.copyOf ?? null
	const root =
		named === null ? undefined : items.find(i => keyOf(i) === named.key)
	const of =
		named === null
			? null
			: { ref: `rec:${named.key}`, hz: root ? hzOf(root) : null }
	const all = items.filter(c => c.copyOf?.key === keyOf(item))
	const copies = all.slice(0, COPIES_MAX).map(c => ({
		ref: `rec:${keyOf(c)}`,
		hz: hzOf(c),
		recordingKey: keyOf(c),
		evidence: [...(c.copyOf?.evidence ?? [])],
	}))
	if (of === null && copies.length === 0) return null
	return { of, copies, copiesTotal: all.length }
}

function dto(
	listed: RecordingInventoryItem | undefined,
	row: { summary: ActivitySummary; record: ActivityRecord } | null,
	items: readonly RecordingInventoryItem[] = [],
): TransmissionDto {
	const digital =
		listed !== undefined
			? listed.kind !== "scanner-analog"
			: row?.summary.kind === "decoder-reception"
	const encrypted = row !== null && encryptedRow(row.record)
	const linkedKey = row === null ? null : mockCallLinkedKey(row)
	const linked = listed !== undefined && linkedKey === (listed.key ?? listed.id)
	// Rule six: a digital call's unlinked file shows nothing (key, facts, times, frequency).
	const item = digital && !linked ? undefined : listed
	const audio = item !== undefined ? [item] : []
	const field = (key: string) =>
		row?.record.kind === "decoder-reception"
			? row.record.payload.fields.find(f => f.key === key)?.value
			: undefined
	const text = (v: unknown): string | null =>
		typeof v === "number" || (typeof v === "string" && v.length > 0)
			? String(v)
			: null
	const facts = item?.facts ?? null
	const startedAt =
		item?.startedAt ??
		facts?.startedAt ??
		(row?.record.kind === "analog-transmission"
			? row.record.payload.startedAt
			: null)
	return {
		id: null,
		refs: {
			recordingKeys: item ? [item.key ?? item.id] : [],
			eventIds: row ? [row.summary.eventId] : [],
			observationId: item?.observationId ?? null,
			discoveryId: item?.discoveryId ?? null,
			ownerDiscoveryId: item?.ownerDiscoveryId ?? null,
			operationId: facts?.operationId ?? null,
		},
		kind: digital ? "voice-digital" : "voice-analog",
		recordingKind: audio[0]?.kind ?? null,
		protocol: row?.summary.protocol ?? null,
		sourceId: row?.summary.sourceId ?? null,
		channel: {
			hz: item?.frequencyHz ?? row?.summary.frequencyHz ?? null,
			measuredHz: facts?.frequencyHz ?? null,
			name: null,
		},
		startedAt,
		endedAt: facts?.endedAt ?? null,
		durationMs: item?.durationMs ?? null,
		close: null,
		part:
			item?.part != null && item.parts != null
				? { index: item.part, of: item.parts }
				: null,
		tone: digital ? null : toneOf(item),
		identity: digital
			? {
					talkgroup: item?.talkgroup ?? text(field("talkgroup")),
					radio: item?.source ?? text(field("source")),
					label: null,
				}
			: null,
		signal: null,
		verdict: {
			speech: item?.speech ?? "unchecked",
			keptBy: facts?.finish.keptBy ?? item?.keptBy ?? null,
			itemCut: facts === null ? (item?.cut ?? null) : null,
		},
		admission: facts?.admission ?? null,
		artefacts: audio.map(i => ({
			kind: "audio" as const,
			id: i.key ?? i.id,
			inventoryId: i.id,
			bytes: i.bytes,
			durationMs: i.durationMs,
			state: "kept",
			kept: i.kept ?? null,
			expiresAt: null,
		})),
		noAudioReason: audio.length === 0 && encrypted ? "encrypted" : null,
		group: null,
		sameTime: null,
		channelSummary: null,
		gone: [],
		raw: {
			recording: item ?? null,
			activity:
				row === null
					? null
					: digital
						? redactMockCallRecord(
								row.record,
								key => linked && key === linkedKey,
							)
						: row.record,
			facts,
			observation: null,
		},
		privacy: digital
			? encrypted
				? "encrypted"
				: linked
					? "clear"
					: "unproven"
			: null,
		copy: digital ? null : copyOf(item, items),
	}
}

export function registerTransmissionsMock(
	app: FastifyInstance,
	options: TransmissionsMockOptions,
): void {
	app.get("/api/transmissions/*", async (request, reply) => {
		const ref = (request.params as { "*"?: unknown })["*"]
		const notFound = () =>
			reply.code(404).send({
				error: "Not Found",
				code: "TRANSMISSION_NOT_FOUND",
				message: "Transmission not found",
			})
		if (typeof ref !== "string" || ref.length > 520 || !REF.test(ref))
			return reply.code(400).send({
				error: "Bad Request",
				code: "TRANSMISSION_REF_INVALID",
				message: "The transmission reference is invalid",
			})
		const items = options.recordings()
		if (ref.startsWith("rec:")) {
			const key = ref.slice(4)
			const item = items.find(i => (i.key ?? i.id) === key)
			if (!item) return notFound()
			const row =
				typeof item.activityEventId === "string"
					? options.activity(item.activityEventId)
					: null
			// A digital file its call row does not link answers exactly as an unknown ref.
			if (
				item.kind !== "scanner-analog" &&
				(row === null || mockCallLinkedKey(row) !== key)
			)
				return notFound()
			return dto(item, row, items)
		}
		if (ref.startsWith("evt:")) {
			const row = options.activity(ref.slice(4))
			if (!row) return notFound()
			const key = row.summary.recording?.id
			const item =
				key === undefined ? undefined : items.find(i => (i.key ?? i.id) === key)
			return dto(item, row, items)
		}
		return notFound()
	})
}
