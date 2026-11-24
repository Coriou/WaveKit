/**
 * The Transmission DTO (GET /api/transmissions/:ref) built from what the core holds: the
 * registry's view while it holds the transmission, the stored Activity records (record_json,
 * never a summary alone: an older core's relink rebuilds summaries from the keys it knows), the
 * catalogue items the recordings route serves, and the group members still held. Pure: the route
 * does the bounded lookups, this only shapes them. Fields nothing holds yet are null.
 */
import type {
	ActivityRecord,
	RecordingInventoryItem,
	RecordingTone,
	TransmissionArtefact,
	TransmissionDto,
	TransmissionKind,
	TransmissionMember,
	TransmissionPrivacy,
	TransmissionTone,
} from "@wavekit/api-types"
import { deriveTone } from "./tone.js"
import { isTxId } from "./types.js"
import type { TxToneReading, TxView } from "./types.js"

/**
 * Group members listed at most: a channel's run of overs inside the 15 s group gap (and hop
 * returns within 120 s) rarely passes a dozen; 64 bounds the body (about 130 B per member).
 */
export const TRANSMISSION_GROUP_MEMBERS_MAX = 64

export interface TransmissionDtoSources {
	/** The registry's view; null once it no longer holds the transmission. */
	view: TxView | null
	/** The id the stored records or catalogue name (the registry missed); null when none does. */
	storedTxId: string | null
	/** Every recording key named (aliases, stored rows, catalogue index), first seen first. */
	recordingKeys: readonly string[]
	/** The catalogue items of those keys that a listing serves now. */
	items: readonly RecordingInventoryItem[]
	/** Every Activity event id named (aliases, the txId ref), first seen first. */
	eventIds: readonly string[]
	/** The stored records read (by event id). */
	records: readonly ActivityRecord[]
	/** Event ids read whose record is gone. */
	missingEventIds: number
	/**
	 * Recording keys a call row links to (its `recording`): dsd-fme links a call's file only when
	 * recordingLinkable passed, so a linked key is the digital serve rule's answer.
	 */
	linkedRecordingKeys: readonly string[]
	/** The group's members the registry still holds (the transmission itself included). */
	members: readonly TxView[]
	/** The recordings routes are mounted (the inventory is served at all). */
	audioServed: boolean
}

type CallFields = {
	talkgroup: string | null
	radio: string | null
	encrypted: boolean | null
}

const iso = (ms: number | null): string | null =>
	ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString()

const isoText = (v: unknown): string | null =>
	typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null

function pushUnique(list: string[], value: string | null | undefined): void {
	if (typeof value === "string" && value.length > 0 && !list.includes(value))
		list.push(value)
}

function callFieldsOf(record: ActivityRecord | undefined): CallFields | null {
	if (record?.kind !== "decoder-reception") return null
	const field = (key: string) =>
		record.payload.fields.find(f => f.key === key)?.value
	const text = (v: unknown): string | null =>
		typeof v === "number" && Number.isFinite(v)
			? String(v)
			: typeof v === "string" && v.length > 0
				? v
				: null
	const encrypted = field("encrypted")
	return {
		talkgroup: text(field("talkgroup")),
		radio: text(field("source")),
		encrypted: typeof encrypted === "boolean" ? encrypted : null,
	}
}

function kindOf(
	view: TxView | null,
	item: RecordingInventoryItem | undefined,
	records: readonly ActivityRecord[],
): TransmissionKind {
	if (view !== null) return view.kind
	if (item?.kind === "scanner-analog") return "voice-analog"
	if (item !== undefined) return "voice-digital"
	for (const r of records) {
		if (r.kind === "analog-transmission" || r.kind === "recording-change")
			return "voice-analog"
		if (r.kind === "decoder-reception" && r.payload.category === "voice")
			return "voice-digital"
	}
	return "unknown"
}

/** The web's three-state tone from the derived reading (a live empty reading is never "none"). */
function toneOf(
	reading: TxToneReading,
	recorderTones: readonly (RecordingTone | null | undefined)[],
	liveRecord: boolean,
): TransmissionTone {
	if (reading.state === "heard")
		return {
			state: "heard",
			ctcssHz: reading.ctcssHz,
			dcs: reading.dcs === null ? null : { code: reading.dcs, polarity: null },
			dcsChecked: reading.dcsChecked,
			from: reading.source,
			why: null,
		}
	if (reading.state === "none" && reading.source === "recorder")
		return {
			state: "none",
			ctcssHz: null,
			dcs: null,
			dcsChecked: reading.dcsChecked,
			from: "recorder",
			why: null,
		}
	const why: TransmissionTone["why"] =
		reading.source === "live-demod"
			? "live-none"
			: recorderTones.length > 0
				? "undetermined"
				: liveRecord
					? "no-record"
					: "no-facts"
	return {
		state: "not-measured",
		ctcssHz: null,
		dcs: null,
		dcsChecked: reading.dcsChecked,
		from: null,
		why,
	}
}

/** A stored live tone (an `analog-transmission` record), when the registry no longer holds it. */
function storedLiveTone(
	record: ActivityRecord | undefined,
): Parameters<typeof deriveTone>[0] {
	if (record?.kind !== "analog-transmission") return null
	const tone = record.payload.tone
	if (tone === undefined) return null
	return {
		ctcssHz:
			typeof tone.ctcssHz === "number" && Number.isFinite(tone.ctcssHz)
				? tone.ctcssHz
				: null,
		dcs:
			tone.dcs === undefined || tone.dcs === null
				? null
				: { code: tone.dcs.code, polarity: tone.dcs.polarity },
	}
}

function privacyOf(
	kind: TransmissionKind,
	view: TxView | null,
	call: CallFields | null,
	linked: readonly string[],
): TransmissionPrivacy | null {
	if (kind !== "voice-digital") return null
	if (view?.refusal === "encrypted" || call?.encrypted === true)
		return "encrypted"
	// Only a call the decoder proved clear links its file; nothing else is ever clear.
	return linked.length > 0 ? "clear" : "unproven"
}

function artefactOf(item: RecordingInventoryItem): TransmissionArtefact {
	return {
		kind: "audio",
		id: item.key ?? item.id,
		inventoryId: item.id,
		bytes: item.bytes,
		durationMs: item.durationMs,
		state: "kept",
		kept: item.kept ?? null,
		expiresAt: null,
	}
}

function memberOf(m: TxView): TransmissionMember {
	const audioId = m.aliases.rec[0]?.slice("rec:".length) ?? null
	return {
		ref: m.id,
		startedAt: new Date(m.startedAtMs).toISOString(),
		durationMs:
			m.endedAtMs === null ? null : Math.max(0, m.endedAtMs - m.startedAtMs),
		hasAudio: audioId !== null,
		audioId,
	}
}

export function buildTransmissionDto(
	src: TransmissionDtoSources,
): TransmissionDto {
	const { view, records } = src
	const analog = records.find(r => r.kind === "analog-transmission")
	const change = records.find(r => r.kind === "recording-change")
	const call = records.find(r => r.kind === "decoder-reception")
	const callFields = callFieldsOf(call)
	const item = src.items.find(i => i.kind === "scanner-analog") ?? src.items[0]
	const facts = item?.facts ?? null
	const kind = kindOf(view, item, records)
	const privacy = privacyOf(kind, view, callFields, src.linkedRecordingKeys)

	// Audio: only what the recordings route serves, and for a digital call only the file the
	// decoder linked (recordingLinkable). An unproven or encrypted call lists none.
	const served = src.audioServed ? src.items : []
	const audio =
		kind === "voice-digital"
			? privacy === "clear"
				? served.filter(i => src.linkedRecordingKeys.includes(i.key ?? i.id))
				: []
			: served
	const artefacts = audio.map(artefactOf)

	const recordingKeys: string[] = []
	for (const k of src.recordingKeys) pushUnique(recordingKeys, k)
	const eventIds: string[] = []
	for (const e of src.eventIds) pushUnique(eventIds, e)

	// Times: the registry's, else the stored record's own fields (record_json), else the facts.
	const changeStarted =
		change?.kind === "recording-change"
			? isoText(change.payload.startedAt)
			: null
	const startedAt =
		view !== null
			? iso(view.startedAtMs)
			: (isoText(
					analog?.kind === "analog-transmission"
						? analog.payload.startedAt
						: null,
				) ??
				changeStarted ??
				facts?.startedAt ??
				item?.startedAt ??
				null)
	const endedAt =
		view !== null
			? iso(view.endedAtMs)
			: (isoText(
					analog?.kind === "analog-transmission"
						? analog.payload.endedAt
						: null,
				) ??
				facts?.endedAt ??
				null)
	const startMs = startedAt === null ? Number.NaN : Date.parse(startedAt)
	const endMs = endedAt === null ? Number.NaN : Date.parse(endedAt)
	const durationMs =
		Number.isFinite(startMs) && Number.isFinite(endMs)
			? Math.max(0, endMs - startMs)
			: view !== null
				? null
				: analog?.kind === "analog-transmission"
					? analog.payload.durationMs
					: (facts?.durationMs ?? item?.durationMs ?? null)

	const recorderTones: (RecordingTone | null | undefined)[] = []
	for (const i of src.items)
		if (i.kind === "scanner-analog" && i.facts) recorderTones.push(i.facts.tone)
	const tone =
		kind === "voice-analog"
			? toneOf(
					deriveTone(view?.liveTone ?? storedLiveTone(analog), recorderTones),
					recorderTones,
					analog !== undefined,
				)
			: null

	const identity =
		view?.identity != null
			? {
					talkgroup: view.identity.talkgroup,
					radio: view.identity.source,
					label: null,
				}
			: callFields !== null
				? {
						talkgroup: callFields.talkgroup,
						radio: callFields.radio,
						label: null,
					}
				: null

	const gone: TransmissionDto["gone"] = []
	if (src.missingEventIds > 0) gone.push("activity")
	if (recordingKeys.some(k => !src.items.some(i => (i.key ?? i.id) === k)))
		gone.push("audio")

	const members = src.members
		.slice(0, TRANSMISSION_GROUP_MEMBERS_MAX)
		.map(memberOf)

	const speech = item?.speech ?? "unchecked"
	const close =
		view?.close != null ? { reason: view.close, complete: view.complete } : null
	const changePayload =
		change?.kind === "recording-change" ? change.payload : null
	const txId = view?.id ?? (isTxId(src.storedTxId) ? src.storedTxId : null)

	return {
		id: txId,
		refs: {
			recordingKeys,
			eventIds,
			observationId:
				view?.aliases.obs[0]?.slice("obs:".length) ??
				item?.observationId ??
				facts?.observationId ??
				changePayload?.observationId ??
				null,
			discoveryId:
				item?.discoveryId ??
				facts?.discoveryId ??
				changePayload?.discoveryId ??
				null,
			ownerDiscoveryId: item?.ownerDiscoveryId ?? null,
			operationId: facts?.operationId ?? null,
		},
		kind,
		recordingKind: audio[0]?.kind ?? null,
		protocol:
			view?.protocol ??
			(call?.kind === "decoder-reception" ? call.payload.protocol : null),
		sourceId:
			view?.sourceId ??
			(analog?.kind === "analog-transmission"
				? analog.payload.sourceId
				: null) ??
			changePayload?.sourceId ??
			null,
		channel: {
			hz:
				item?.frequencyHz ??
				changePayload?.channel?.frequencyHz ??
				view?.hz ??
				null,
			measuredHz:
				facts?.frequencyHz ??
				changePayload?.frequencyHz ??
				(analog?.kind === "analog-transmission"
					? (analog.payload.frequency?.hz ?? null)
					: null),
			name: null,
		},
		startedAt,
		endedAt,
		durationMs,
		close,
		part:
			item?.part != null && item.parts != null
				? { index: item.part, of: item.parts }
				: null,
		tone,
		identity,
		signal: null,
		verdict: {
			speech,
			keptBy: facts?.finish.keptBy ?? item?.keptBy ?? null,
			itemCut: facts === null ? (item?.cut ?? null) : null,
		},
		admission: facts?.admission ?? null,
		artefacts,
		noAudioReason:
			artefacts.length > 0
				? null
				: (view?.noAudioReason ??
					(privacy === "encrypted" ? "encrypted" : null)),
		group:
			view === null ? null : { id: view.groupId, heuristic: false, members },
		sameTime: null,
		channelSummary: null,
		gone,
		raw: {
			recording: item ?? null,
			activity: change ?? analog ?? call ?? null,
			facts,
			observation: null,
		},
		privacy,
	}
}
