// GET /api/transmissions/:ref, as the core serves it (src/api/routes/transmissions.ts): a malformed ref
// is 400 TRANSMISSION_REF_INVALID, an unknown one 404 TRANSMISSION_NOT_FOUND. The mock has no
// transmission registry, so it mints no ids: `rec:` and `evt:` resolve from the mock's recordings
// and Activity rows with `id` null, and a `tx_` or `obs:` ref is 404. A digital call is "clear" and
// lists its file only when its decoder call row (decoder-reception) links that file in `recording`,
// the decoder's link the core accepts; a row whose `encrypted` field is true reads "encrypted";
// anything else "unproven" with no audio. An analog recording's `copy` comes from the catalogue items'
// `copyOf` (the original it names, the listed copies naming it), as the core builds it.
import type { FastifyInstance } from "fastify"
import type {
	ActivityRecord,
	ActivitySummary,
	RecordingInventoryItem,
	TransmissionCopy,
	TransmissionDto,
	TransmissionTone,
} from "@wavekit/api-types"

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
	item: RecordingInventoryItem | undefined,
	row: { summary: ActivitySummary; record: ActivityRecord } | null,
	items: readonly RecordingInventoryItem[] = [],
): TransmissionDto {
	const digital =
		item !== undefined
			? item.kind !== "scanner-analog"
			: row?.summary.kind === "decoder-reception"
	const encrypted =
		row?.record.kind === "decoder-reception" &&
		row.record.payload.fields.some(
			f => f.key === "encrypted" && f.value === true,
		)
	const linked =
		item !== undefined &&
		!encrypted &&
		row?.summary.kind === "decoder-reception" &&
		row.summary.recording?.id === (item.key ?? item.id)
	const audio = item !== undefined && (!digital || linked) ? [item] : []
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
					talkgroup: item?.talkgroup ?? null,
					radio: item?.source ?? null,
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
		noAudioReason: null,
		group: null,
		sameTime: null,
		channelSummary: null,
		gone: [],
		raw: {
			recording: item ?? null,
			activity: row?.record ?? null,
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
			return dto(item, row, items)
		}
		if (ref.startsWith("evt:")) {
			const row = options.activity(ref.slice(4))
			if (!row) return notFound()
			const key = row.summary.recording?.id
			const item =
				key === undefined ? undefined : items.find(i => i.key === key)
			return dto(item, row, items)
		}
		return notFound()
	})
}
