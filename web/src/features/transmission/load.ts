// loadTransmission(ref): one transmission as the Transmission DTO, composed in the web from the calls that exist
// today (the recording, its Activity record, its discovery, its observation and its neighbours) until the core
// serves GET /api/transmissions/:ref. Only the first read is required; each optional one has its own short
// deadline and fails to "absent", so the view never waits on it. This composition is the only place that knows
// the four calls, and it goes when the route arrives.
import type {
	ActivityRecord,
	ActivitySummary,
	Discovery,
	Observation,
	RecordingInventoryItem,
	RecordingInventoryPage,
} from "@wavekit/api-types"

import type { ApiClient } from "../../data/api-client.ts"
import type {
	RecordingFacts,
	TransmissionArtefact,
	TransmissionDto,
	TransmissionMember,
	TransmissionRef,
	TransmissionTone,
} from "./contract.ts"
import { factsOf, freezeDto, refText } from "./contract.ts"

/** Each optional read gives up after this long (the view renders without it). */
export const OPTIONAL_READ_MS = 4_000
/** Recordings of the same channel this close to the transmission count as "around this time". */
export const AROUND_MS = 120_000
/** Neighbours read from the channel's recordings (newest first). */
const NEIGHBOURS = 50
/** Observations of the discovery searched for this one's (the core keeps its last 256). */
const OBSERVATIONS = 256
/** Bounds of the DTO (the route's). */
const MEMBERS_MAX = 64

export class TransmissionNotFoundError extends Error {
	constructor(ref: TransmissionRef) {
		super(`No transmission is known as ${refText(ref)}`)
		this.name = "TransmissionNotFoundError"
	}
}

export interface LoadTransmissionDeps {
	api: Pick<ApiClient, "get">
	/** Recordings already loaded on screen (the Recordings list), searched before any read. */
	recordings?: () => readonly RecordingInventoryItem[]
	/** The Activity row it was opened from, when it was. */
	summary?: ActivitySummary | null
	signal?: AbortSignal
	/** The optional reads' deadline (tests). */
	optionalMs?: number
}

/** The Transmission DTO of `ref`, frozen. Rejects with TransmissionNotFoundError when nothing names it. */
export async function loadTransmission(
	ref: TransmissionRef,
	deps: LoadTransmissionDeps,
): Promise<TransmissionDto> {
	const ctx = new Reads(deps)
	const gone = new Set<TransmissionDto["gone"][number]>()
	let record: ActivityRecord | null = null
	let item: RecordingInventoryItem | null = null

	if ("recording" in ref) {
		item = await ctx.recording(ref.recording)
		if (item === null) throw new TransmissionNotFoundError(ref)
	} else if ("event" in ref) {
		record = await ctx.activity(ref.event)
		if (record === null) gone.add("activity")
		const key = recordingKeyOf(record, deps.summary ?? null)
		if (key !== null) item = await ctx.recording(key)
		if (record === null && item === null && !deps.summary)
			throw new TransmissionNotFoundError(ref)
		if (key !== null && item === null) gone.add("audio")
	} else {
		item = ctx.loaded().find(r => r.observationId === ref.observation) ?? null
		if (item === null) throw new TransmissionNotFoundError(ref)
	}

	if ("recording" in ref && item !== null && item.activityEventId) {
		const eventId = item.activityEventId
		record = await ctx.optional(() => ctx.activity(eventId))
		if (record === null) gone.add("activity")
	}

	if (item !== null)
		return freezeDto(await fromRecording(item, record, ctx, gone))
	return freezeDto(fromActivity(record, deps.summary ?? null, gone))
}

/** The recording a row or record names: a recording-change's file, else the row's playable link. */
function recordingKeyOf(
	record: ActivityRecord | null,
	summary: ActivitySummary | null,
): string | null {
	if (record?.kind === "recording-change") return record.payload.recordingId
	return summary?.recording?.id ?? null
}

/** The reads, each with the caller's abort and the optional ones' deadline. */
class Reads {
	readonly #deps: LoadTransmissionDeps
	constructor(deps: LoadTransmissionDeps) {
		this.#deps = deps
	}

	loaded(): readonly RecordingInventoryItem[] {
		return this.#deps.recordings?.() ?? []
	}

	#options(optional: boolean) {
		const signal = this.#deps.signal
		return {
			...(signal ? { signal } : {}),
			...(optional
				? { timeoutMs: this.#deps.optionalMs ?? OPTIONAL_READ_MS }
				: {}),
		}
	}

	/** Runs an optional read: any failure (timeout, 404, older core) is absent. */
	async optional<T>(read: () => Promise<T | null>): Promise<T | null> {
		try {
			return await read()
		} catch (e) {
			if (this.#deps.signal?.aborted) throw e
			return null
		}
	}

	async activity(eventId: string): Promise<ActivityRecord | null> {
		try {
			return await this.#deps.api.get<ActivityRecord>(
				`/api/activity/${encodeURIComponent(eventId)}`,
				this.#options(false),
			)
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null
			throw e
		}
	}

	/** A recording by key or id: the loaded list first, else its discovery's recordings. */
	async recording(key: string): Promise<RecordingInventoryItem | null> {
		const match = (r: RecordingInventoryItem) => r.key === key || r.id === key
		const known = this.loaded().find(match)
		if (known) return known
		const discoveryId = /^scan:([^~]+)~/.exec(key)?.[1] ?? null
		if (discoveryId === null) return null
		const page = await this.#deps.api.get<RecordingInventoryPage>(
			"/api/recordings",
			{ ...this.#options(false), query: { discoveryId, limit: 200 } },
		)
		return page.items.find(match) ?? null
	}

	discovery(id: string): Promise<Discovery | null> {
		return this.optional(() =>
			this.#deps.api.get<Discovery>(
				`/api/scanner/discoveries/${encodeURIComponent(id)}`,
				this.#options(true),
			),
		)
	}

	observations(discoveryId: string): Promise<Observation[] | null> {
		return this.optional(async () => {
			const page = await this.#deps.api.get<{ items?: Observation[] }>(
				`/api/scanner/discoveries/${encodeURIComponent(discoveryId)}/observations`,
				{ ...this.#options(true), query: { limit: OBSERVATIONS } },
			)
			return page.items ?? []
		})
	}

	neighbours(discoveryId: string): Promise<RecordingInventoryItem[] | null> {
		return this.optional(async () => {
			const page = await this.#deps.api.get<RecordingInventoryPage>(
				"/api/recordings",
				{ ...this.#options(true), query: { discoveryId, limit: NEIGHBOURS } },
			)
			return page.items
		})
	}
}

/** When a recording's audio starts: the receipt's first sample, the facts', the file name's, the file's write. */
export function audioStartOf(
	item: RecordingInventoryItem,
	facts: RecordingFacts | null = factsOf(item),
): string {
	const iso = item.startedAt ?? facts?.startedAt ?? null
	if (iso !== null && Number.isFinite(Date.parse(iso))) return iso
	if (item.startedAtLocal) {
		const d = new Date(item.startedAtLocal)
		if (!Number.isNaN(d.getTime())) return d.toISOString()
	}
	return item.modifiedAt
}

function isCall(item: RecordingInventoryItem): boolean {
	return item.kind === "dsd-fme-call" || item.kind === "dv-call"
}

/** The recorder's tone, three states: from the facts, else not measured (and why). */
export function recorderTone(facts: RecordingFacts | null): TransmissionTone {
	const base = {
		ctcssHz: null,
		dcs: null,
		dcsChecked: false,
		from: "recorder" as const,
	}
	if (facts === null) return { ...base, state: "not-measured", why: "no-facts" }
	if (facts.toneMalformed === true)
		return { ...base, state: "not-measured", why: "malformed" }
	const tone = facts.tone
	if (tone === undefined)
		return { ...base, state: "not-measured", why: "undetermined" }
	if (tone === null) return { ...base, state: "none", why: null }
	return tone.kind === "ctcss"
		? { ...base, state: "heard", ctcssHz: tone.hz, why: null }
		: {
				...base,
				state: "heard",
				dcs: { code: tone.code, polarity: null },
				why: null,
			}
}

function audioOf(item: RecordingInventoryItem): TransmissionArtefact {
	return {
		kind: "audio",
		id: item.key ?? item.id,
		inventoryId: item.id,
		bytes: item.bytes,
		durationMs: item.durationMs,
		state: "kept",
		kept: item.kept === true,
		expiresAt: null,
	}
}

function memberOf(item: RecordingInventoryItem): TransmissionMember {
	return {
		ref: refText({ recording: item.key ?? item.id }),
		startedAt: audioStartOf(item),
		durationMs: item.durationMs,
		hasAudio: true,
		audioId: item.key ?? item.id,
	}
}

/**
 * The exchange a recording belongs to: the parts of its observation (certain), plus recordings of the same
 * channel within AROUND_MS of it (a heuristic, said so). Oldest first; null when it is alone.
 */
export function groupOf(
	item: RecordingInventoryItem,
	neighbours: readonly RecordingInventoryItem[],
): TransmissionDto["group"] {
	const start = Date.parse(audioStartOf(item))
	const end = start + (item.durationMs ?? 0)
	let heuristic = false
	const seen = new Set<string>()
	const members: RecordingInventoryItem[] = []
	for (const r of [item, ...neighbours]) {
		const key = r.key ?? r.id
		if (seen.has(key)) continue
		const samePart =
			item.observationId != null && r.observationId === item.observationId
		const s = Date.parse(audioStartOf(r))
		const e = s + (r.durationMs ?? 0)
		const near =
			r.frequencyHz === item.frequencyHz &&
			Number.isFinite(s) &&
			s <= end + AROUND_MS &&
			e >= start - AROUND_MS
		if (r !== item && !samePart && !near) continue
		if (r !== item && !samePart) heuristic = true
		seen.add(key)
		members.push(r)
	}
	if (members.length < 2) return null
	const sorted = members
		.map(memberOf)
		.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
		.slice(0, MEMBERS_MAX)
	return {
		id: heuristic ? null : (item.observationId ?? null),
		heuristic,
		members: sorted,
	}
}

const FLAG_NAMES: readonly (keyof Observation["flags"])[] = [
	"overload",
	"gap",
	"offRaster",
	"obwBiased",
	"adjacentLeak",
	"suspectedIntermod",
	"edge",
]

async function fromRecording(
	item: RecordingInventoryItem,
	record: ActivityRecord | null,
	ctx: Reads,
	gone: Set<TransmissionDto["gone"][number]>,
): Promise<TransmissionDto> {
	const facts = factsOf(item)
	const owner =
		item.ownerDiscoveryId ?? item.discoveryId ?? facts?.discoveryId ?? null
	const scanner = item.kind === "scanner-analog" || item.kind === "scanner-dv"
	const [discovery, observations, neighbours] =
		scanner && owner !== null
			? await Promise.all([
					ctx.discovery(owner),
					item.observationId ? ctx.observations(owner) : Promise.resolve(null),
					ctx.neighbours(owner),
				])
			: [null, null, null]
	if (scanner && owner !== null && discovery === null) gone.add("discovery")
	const observationId = item.observationId ?? facts?.observationId ?? null
	const observation =
		observationId === null
			? null
			: (observations?.find(o => o.id === observationId) ?? null)
	if (observations !== null && observationId !== null && observation === null)
		gone.add("observation")
	const startedAt = audioStartOf(item, facts)
	const durationMs = item.durationMs ?? facts?.durationMs ?? null
	const endedAt =
		facts?.endedAt ??
		(durationMs !== null
			? new Date(Date.parse(startedAt) + durationMs).toISOString()
			: null)
	const cut = facts?.finish.cut ?? null
	const measuredHz =
		facts?.frequencyHz ??
		(record?.kind === "recording-change" ? record.payload.frequencyHz : null)
	const proofTone =
		discovery?.proof?.kind === "analog-tone" ? discovery.proof.tone : undefined
	return {
		id: null,
		refs: {
			recordingKeys: [item.key ?? item.id],
			eventIds: item.activityEventId
				? [item.activityEventId]
				: record
					? [record.eventId]
					: [],
			observationId,
			discoveryId: item.discoveryId,
			ownerDiscoveryId: item.ownerDiscoveryId ?? null,
			operationId: facts?.operationId ?? null,
		},
		kind:
			item.kind === "scanner-analog"
				? "voice-analog"
				: item.kind === "scanner-dv" || isCall(item)
					? "voice-digital"
					: "unknown",
		protocol:
			item.kind === "scanner-analog"
				? "analog-fm"
				: (discovery?.protocol ?? null),
		sourceId:
			observation?.sourceId ??
			(record?.kind === "recording-change" ? record.payload.sourceId : null),
		channel: {
			hz: item.frequencyHz,
			measuredHz,
			name: discovery?.operator?.label?.trim() || null,
		},
		startedAt,
		endedAt,
		durationMs,
		close:
			cut !== null
				? {
						reason: cut,
						complete: cut === "completed" || cut === "track-ended",
					}
				: item.cut
					? { reason: item.cut, complete: false }
					: null,
		part:
			item.part != null && item.parts != null && item.parts > 1
				? { index: item.part, of: item.parts }
				: null,
		tone: item.kind === "scanner-analog" ? recorderTone(facts) : null,
		identity: isCall(item)
			? { talkgroup: item.talkgroup, radio: item.source, label: null }
			: null,
		signal: observation
			? {
					snrDb: observation.snrDb,
					peakDbfs: observation.peakDbfs,
					flags: FLAG_NAMES.filter(f => observation.flags[f]),
				}
			: null,
		verdict: {
			speech: item.speech ?? "unchecked",
			keptBy: facts?.finish.keptBy ?? item.keptBy ?? null,
			itemCut: item.cut ?? null,
		},
		admission: facts?.admission ?? null,
		artefacts: [audioOf(item)],
		noAudioReason: null,
		group: groupOf(item, neighbours ?? []),
		sameTime: null,
		channelSummary: discovery
			? {
					timesHeard: discovery.observationCount,
					since: discovery.firstSeenAt,
					usualCtcssHz: proofTone?.ctcssHz ?? null,
				}
			: null,
		gone: [...gone],
		raw: {
			recording: structuredClone(item),
			activity: record === null ? null : structuredClone(record),
			facts: facts === null ? null : structuredClone(facts),
			observation: observation === null ? null : structuredClone(observation),
		},
	}
}

/** A transmission known only from Activity: a live analog transmission, a call whose file is not listed. */
function fromActivity(
	record: ActivityRecord | null,
	summary: ActivitySummary | null,
	gone: Set<TransmissionDto["gone"][number]>,
): TransmissionDto {
	const live = record?.kind === "analog-transmission" ? record.payload : null
	const eventId = record?.eventId ?? summary?.eventId ?? ""
	const field = (key: string) =>
		summary?.fields.find(f => f.key === key)?.value ?? null
	const durationMs =
		live?.durationMs ??
		(typeof field("durationMs") === "number"
			? (field("durationMs") as number)
			: typeof field("duration") === "number"
				? (field("duration") as number)
				: (summary?.recording?.durationMs ?? null))
	const startedAt =
		live?.startedAt ??
		record?.producedAt ??
		summary?.producedAt ??
		new Date(0).toISOString()
	const fm =
		live !== null && (live.modulation === "nfm" || live.modulation === "wfm")
	const hz =
		live?.frequency?.hz ??
		summary?.channel?.frequencyHz ??
		summary?.frequencyHz ??
		null
	const talkgroup = field("talkgroup")
	const radio = field("source")
	const rec = summary?.recording ?? null
	return {
		id: null,
		refs: {
			recordingKeys: rec ? [rec.id] : [],
			eventIds: eventId ? [eventId] : [],
			observationId: null,
			discoveryId: null,
			ownerDiscoveryId: null,
			operationId: null,
		},
		kind:
			live !== null
				? "voice-analog"
				: summary?.category === "voice"
					? "voice-digital"
					: "unknown",
		protocol:
			live !== null ? `analog-${live.modulation}` : (summary?.protocol ?? null),
		sourceId: live?.sourceId ?? summary?.sourceId ?? null,
		channel: { hz, measuredHz: live?.frequency?.hz ?? null, name: null },
		startedAt,
		endedAt:
			live?.endedAt ??
			(durationMs !== null
				? new Date(Date.parse(startedAt) + durationMs).toISOString()
				: null),
		durationMs,
		close: live
			? { reason: live.closeReason, complete: live.closeReason === "squelch" }
			: null,
		part: null,
		tone: fm ? liveTone(live) : null,
		identity:
			talkgroup !== null || radio !== null
				? {
						talkgroup: talkgroup === null ? null : String(talkgroup),
						radio: radio === null ? null : String(radio),
						label: summary?.title ?? null,
					}
				: null,
		signal: live
			? { snrDb: null, peakDbfs: live.peakChannelPowerDbfs, flags: [] }
			: null,
		verdict: { speech: "unchecked", keptBy: null, itemCut: null },
		admission: null,
		artefacts: rec
			? [
					{
						kind: "audio",
						id: rec.id,
						inventoryId: null,
						bytes: 0,
						durationMs: rec.durationMs,
						state: "kept",
						kept: false,
						expiresAt: null,
					},
				]
			: [],
		noAudioReason: rec ? null : gone.has("audio") ? "deleted" : "not-recorded",
		group: null,
		sameTime: null,
		channelSummary: null,
		gone: [...gone],
		raw: {
			recording: null,
			activity: record === null ? null : structuredClone(record),
			facts: null,
			observation: null,
		},
	}
}

/** The live demodulator's tone: it checks CTCSS and DCS when it stored a tone at all. */
function liveTone(
	live: Extract<ActivityRecord, { kind: "analog-transmission" }>["payload"],
): TransmissionTone {
	const t = live.tone
	const base = { from: "live-demod" as const, why: null }
	if (t === undefined)
		return {
			...base,
			state: "not-measured",
			ctcssHz: null,
			dcs: null,
			dcsChecked: false,
			why: "no-facts",
		}
	const dcs = t.dcs ?? null
	return {
		...base,
		state: t.ctcssHz !== null || dcs !== null ? "heard" : "none",
		ctcssHz: t.ctcssHz,
		dcs,
		dcsChecked: t.dcs !== undefined,
	}
}
