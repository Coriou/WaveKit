// GET /api/transmissions/:ref, as the core serves it (src/api/routes/transmissions.ts): a malformed ref
// is 400 TRANSMISSION_REF_INVALID, an unknown one 404 TRANSMISSION_NOT_FOUND. The mock has no
// transmission registry, so it mints no ids: `rec:` and `evt:` resolve from the mock's recordings
// and Activity rows with `id` null, and a `tx_` or `obs:` ref is 404. A digital call lists its file
// only when its Activity row links it (the core's serve rule), else privacy reads "unproven".
import type { FastifyInstance } from "fastify"
import type {
	ActivityRecord,
	ActivitySummary,
	RecordingInventoryItem,
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

function dto(
	item: RecordingInventoryItem | undefined,
	row: { summary: ActivitySummary; record: ActivityRecord } | null,
): TransmissionDto {
	const digital =
		item !== undefined
			? item.kind !== "scanner-analog"
			: row?.summary.kind === "decoder-reception"
	const linked = item !== undefined && typeof item.activityEventId === "string"
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
		privacy: digital ? (linked ? "clear" : "unproven") : null,
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
			return dto(item, row)
		}
		if (ref.startsWith("evt:")) {
			const row = options.activity(ref.slice(4))
			if (!row) return notFound()
			const key = row.summary.recording?.id
			const item =
				key === undefined ? undefined : items.find(i => i.key === key)
			return dto(item, row)
		}
		return notFound()
	})
}
