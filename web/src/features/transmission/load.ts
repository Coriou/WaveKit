// loadTransmission(ref): one transmission as the Transmission DTO, composed in the web from the calls that exist
// today (the recording, its Activity record, its discovery, its observation and its neighbours) until the core
// serves GET /api/transmissions/:ref. Only the first reads are required, under one overall deadline (they fail, the
// read still running is aborted, and the view offers Retry); each optional one has its own short deadline and fails to "absent", so the view never waits
// on it. One open reads a channel's recordings once (the file's folder is also its neighbours). This composition is
// the only place that knows the four calls, and it goes when the route arrives.
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
import { factsOf, freezeDto, readLiveTone, refText } from "./contract.ts"
import { noteRecordStart } from "../activity/row-time.ts"

/** Each optional read gives up after this long (the view renders without it). */
export const OPTIONAL_READ_MS = 4_000
/**
 * The required reads (one, or an Activity record then its recording) give up after this long in all: the view
 * then says so and offers Retry, never an endless load. The read still running is aborted.
 */
export const REQUIRED_READ_MS = 15_000
/** Recordings of the same channel this close to the transmission count as "around this time". */
export const AROUND_MS = 120_000
/** Observations of the discovery searched for this one's (the core keeps its last 256). */
const OBSERVATIONS = 256
/**
 * Recordings read from a folder (the route's page limit, newest first). The same page finds the file and lists its
 * neighbours, so one open reads a channel's recordings once.
 */
const NEWEST = 200
/**
 * The Conversation's bound: the route's `group.members` cap (64). The members are this recording and at most
 * NEWEST (200) recordings of its channel, 1 + 200 = 201, so the cap can bite: it keeps the window of MEMBERS_MAX
 * that holds this one (groupOf).
 */
export const MEMBERS_MAX = 64

/**
 * Transmissions kept for the player's Next and Previous (the view following the player reads a ref it showed a
 * moment ago from here). Bound: at most TRANSMISSION_CACHE_MAX entries, each no older than TRANSMISSION_CACHE_MS.
 * A DTO is its few fields, at most MEMBERS_MAX (64) members of about 200 bytes (13 KB) and the raw records it read
 * (a recording item, an Activity record, facts and an observation: a few KB), so well under 50 KB; 16 × 50 KB =
 * 800 KB at the very most.
 */
export const TRANSMISSION_CACHE_MAX = 16
export const TRANSMISSION_CACHE_MS = 60_000
const cache = new Map<string, { at: number; dto: TransmissionDto }>()

/** The cached DTO of `ref` when it is fresh; else undefined. */
export function cachedTransmission(
	ref: TransmissionRef,
	now: number = Date.now(),
): TransmissionDto | undefined {
	const key = refText(ref)
	const hit = cache.get(key)
	if (hit === undefined) return undefined
	if (now - hit.at > TRANSMISSION_CACHE_MS) {
		cache.delete(key)
		return undefined
	}
	return hit.dto
}

/** Keeps `dto` under `ref`, the oldest dropped past TRANSMISSION_CACHE_MAX. */
function remember(ref: TransmissionRef, dto: TransmissionDto, now: number) {
	const key = refText(ref)
	cache.delete(key)
	cache.set(key, { at: now, dto })
	while (cache.size > TRANSMISSION_CACHE_MAX) {
		const oldest = cache.keys().next().value
		if (oldest === undefined) break
		cache.delete(oldest)
	}
}

/** Forgets every cached transmission (tests). */
export function clearTransmissionCache(): void {
	cache.clear()
}

/** How many transmissions are cached (tests). */
export function transmissionCacheSize(): number {
	return cache.size
}

/** The required read did not answer in time. */
export class TransmissionTimeoutError extends Error {
	constructor() {
		super("The receiver did not answer in time")
		this.name = "TransmissionTimeoutError"
	}
}

/**
 * Nothing the web can read names this ref. `reason` says why, in words the view shows after "Not found"; it never
 * claims a store expired something unless that store said so.
 */
export class TransmissionNotFoundError extends Error {
	readonly reason: string
	constructor(ref: TransmissionRef, reason: string) {
		super(`No transmission is known as ${refText(ref)}: ${reason}`)
		this.name = "TransmissionNotFoundError"
		this.reason = reason
	}
}

/** The reasons a ref is not found, in words. */
export const NOT_FOUND_WORDS = {
	recordingInFolder: "The receiver does not list this recording in its channel",
	recordingNewest:
		"This recording is not among the receiver's newest, and the receiver cannot look one up by name yet",
	event: "Activity holds no event under this name",
	observation: "Only an observation of a recording loaded here can be opened",
} as const

export interface LoadTransmissionDeps {
	api: Pick<ApiClient, "get">
	/** Recordings already loaded on screen (the Recordings list), searched before any read. */
	recordings?: () => readonly RecordingInventoryItem[]
	/** The Activity row it was opened from, when it was. */
	summary?: ActivitySummary | null
	signal?: AbortSignal
	/** The optional reads' deadline (tests). */
	optionalMs?: number
	/** The required read's deadline (tests). */
	requiredMs?: number
	/** Answer from the cache when it holds a fresh copy (the view following the player's Next and Previous). */
	cached?: boolean
	/** The clock (tests). */
	now?: () => number
}

/**
 * The Transmission DTO of `ref`, frozen, and cached for the player's steps. Rejects with TransmissionNotFoundError
 * when nothing names it, and with TransmissionTimeoutError when the required read does not answer in time.
 */
export async function loadTransmission(
	ref: TransmissionRef,
	deps: LoadTransmissionDeps,
): Promise<TransmissionDto> {
	const now = deps.now ?? Date.now
	if (deps.cached === true) {
		const hit = cachedTransmission(ref, now())
		if (hit !== undefined) return hit
	}
	const dto = await compose(ref, deps)
	remember(ref, dto, now())
	return dto
}

async function compose(
	ref: TransmissionRef,
	deps: LoadTransmissionDeps,
): Promise<TransmissionDto> {
	const ctx = new Reads(deps)
	try {
		return await composeWith(ref, deps, ctx)
	} finally {
		ctx.done()
	}
}

async function composeWith(
	ref: TransmissionRef,
	deps: LoadTransmissionDeps,
	ctx: Reads,
): Promise<TransmissionDto> {
	const gone = new Set<TransmissionDto["gone"][number]>()
	let record: ActivityRecord | null = null
	let item: RecordingInventoryItem | null = null

	if ("recording" in ref) {
		const key = ref.recording
		item = await ctx.required(() => ctx.recording(key))
		if (item === null)
			throw new TransmissionNotFoundError(
				ref,
				folderOf(ref.recording) !== null
					? NOT_FOUND_WORDS.recordingInFolder
					: NOT_FOUND_WORDS.recordingNewest,
			)
	} else if ("event" in ref) {
		const summary = deps.summary ?? null
		const eventId = ref.event
		let key: string | null
		if (summary !== null) {
			// with the row in hand both reads are optional and run at once, each under the optional deadline: the
			// view renders from the row when they fail or are slow
			const rowKey = summary.recording?.id ?? null
			const [read, rowItem] = await Promise.all([
				ctx.optional(() => ctx.activity(eventId, true)),
				rowKey !== null
					? ctx.optional(() => ctx.recording(rowKey, true))
					: Promise.resolve(null),
			])
			record = read
			const named = recordingKeyOf(record, summary)
			key = named
			// a record naming another file than the row's (or a row with no link) reads that file, still optional
			item =
				named === null
					? null
					: named === rowKey
						? rowItem
						: await ctx.optional(() => ctx.recording(named, true))
		} else {
			record = await ctx.required(() => ctx.activity(eventId))
			const found = recordingKeyOf(record, summary)
			key = found
			if (found !== null) item = await ctx.required(() => ctx.recording(found))
		}
		if (record === null) gone.add("activity")
		if (record === null && item === null && summary === null)
			throw new TransmissionNotFoundError(ref, NOT_FOUND_WORDS.event)
		if (key !== null && item === null) gone.add("audio")
	} else {
		item = ctx.loaded().find(r => r.observationId === ref.observation) ?? null
		if (item === null)
			throw new TransmissionNotFoundError(ref, NOT_FOUND_WORDS.observation)
	}

	// the required reads are over: their deadline never cuts the optional ones that follow
	ctx.done()

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

/** The discovery whose folder a scanner recording key names (`scan:<discovery>~<file>`); null for other keys. */
function folderOf(key: string): string | null {
	return /^scan:([^~]+)~/.exec(key)?.[1] ?? null
}

/** The /api/recordings query that lists the recording `key` names, when it is still kept. */
export function recordingQueryOf(
	key: string,
): { discoveryId: string; limit: number } | { limit: number } {
	const discoveryId = folderOf(key)
	return discoveryId !== null
		? { discoveryId, limit: NEWEST }
		: { limit: NEWEST }
}

/**
 * The reads, each with the caller's abort and its deadline; one recordings page per query per open. The required
 * reads share one overall deadline from the first of them (a chain of two slow reads still gives up within
 * REQUIRED_READ_MS), and the deadline aborts the reads still running, so none lingers after the view gave up.
 */
class Reads {
	readonly #deps: LoadTransmissionDeps
	readonly #pages = new Map<string, Promise<RecordingInventoryPage>>()
	/** Aborts every read of this open: the caller's abort, or the required deadline. */
	readonly #abort = new AbortController()
	/** The required deadline, armed by the first required read; it rejects once and stays rejected. */
	#deadline: Promise<never> | undefined
	#timer: ReturnType<typeof setTimeout> | undefined
	constructor(deps: LoadTransmissionDeps) {
		this.#deps = deps
		const outer = deps.signal
		if (outer?.aborted) this.#abort.abort(outer.reason)
		else
			outer?.addEventListener("abort", () => this.#abort.abort(outer.reason), {
				once: true,
			})
	}

	/** The signal every read is given. */
	get signal(): AbortSignal {
		return this.#abort.signal
	}

	/** Ends the required reads (and the open): clears their deadline, so it never fires on later reads. */
	done(): void {
		clearTimeout(this.#timer)
	}

	#requiredDeadline(): Promise<never> {
		if (this.#deadline === undefined) {
			this.#deadline = new Promise<never>((_, reject) => {
				this.#timer = setTimeout(() => {
					const e = new TransmissionTimeoutError()
					reject(e)
					// the read that hit the deadline is aborted, not left running
					this.#abort.abort(e)
				}, this.#deps.requiredMs ?? REQUIRED_READ_MS)
			})
			// handled by each race; a deadline that fires after the last required read is not unhandled
			this.#deadline.catch(() => undefined)
		}
		return this.#deadline
	}

	/** A recordings page, read once per query in this open (the file's lookup and its neighbours share it). */
	#page(
		query: { discoveryId: string; limit: number } | { limit: number },
		optional: boolean,
	): Promise<RecordingInventoryPage> {
		const key = JSON.stringify(query)
		let p = this.#pages.get(key)
		if (p === undefined) {
			p = this.#deps.api.get<RecordingInventoryPage>("/api/recordings", {
				...this.#options(optional),
				query,
			})
			this.#pages.set(key, p)
		}
		return p
	}

	/**
	 * Runs a required read under the open's one required deadline: no answer in time rejects (the view offers
	 * Retry), and the read is aborted.
	 */
	async required<T>(read: () => Promise<T>): Promise<T> {
		const late = this.#requiredDeadline()
		return Promise.race([read(), late])
	}

	loaded(): readonly RecordingInventoryItem[] {
		return this.#deps.recordings?.() ?? []
	}

	#options(optional: boolean) {
		return {
			signal: this.#abort.signal,
			timeoutMs: optional
				? (this.#deps.optionalMs ?? OPTIONAL_READ_MS)
				: (this.#deps.requiredMs ?? REQUIRED_READ_MS),
		}
	}

	/**
	 * Runs an optional read: any failure (timeout, 404, older core) is absent, and so is no answer within the
	 * optional deadline (the client's own timeout aside: a read that never settles never holds the view).
	 */
	async optional<T>(read: () => Promise<T | null>): Promise<T | null> {
		let timer: ReturnType<typeof setTimeout> | undefined
		const late = new Promise<null>(resolve => {
			timer = setTimeout(
				() => resolve(null),
				this.#deps.optionalMs ?? OPTIONAL_READ_MS,
			)
		})
		try {
			return await Promise.race([read(), late])
		} catch (e) {
			if (this.#abort.signal.aborted) throw e
			return null
		} finally {
			clearTimeout(timer)
		}
	}

	async activity(
		eventId: string,
		optional = false,
	): Promise<ActivityRecord | null> {
		try {
			const record = await this.#deps.api.get<ActivityRecord>(
				`/api/activity/${encodeURIComponent(eventId)}`,
				this.#options(optional),
			)
			noteRecordStart(record)
			return record
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null
			throw e
		}
	}

	/**
	 * A recording by key or id: the loaded list first, else the /api/recordings page its key names (its
	 * channel's folder for a scanner key, the newest page for any other: the route has no by-key read).
	 */
	async recording(
		key: string,
		optional = false,
	): Promise<RecordingInventoryItem | null> {
		const match = (r: RecordingInventoryItem) => r.key === key || r.id === key
		const known = this.loaded().find(match)
		if (known) return known
		const page = await this.#page(recordingQueryOf(key), optional)
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

	/** The channel's recordings: the same page the file was found in when its folder is the channel's. */
	neighbours(discoveryId: string): Promise<RecordingInventoryItem[] | null> {
		return this.optional(async () => {
			const page = await this.#page({ discoveryId, limit: NEWEST }, true)
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

/**
 * The recorder's tone, three states: from the facts; else, when the file was kept for its tone (`keptBy`
 * "own-tone"), heard but not stored; else not measured (and why).
 */
export function recorderTone(
	facts: RecordingFacts | null,
	keptBy: string | null = facts?.finish.keptBy ?? null,
): TransmissionTone {
	const base = {
		ctcssHz: null,
		dcs: null,
		dcsChecked: false,
		from: "recorder" as const,
	}
	const ownTone = keptBy === "own-tone"
	if (facts?.toneMalformed === true)
		return { ...base, state: "not-measured", why: "malformed" }
	const tone = facts?.tone
	// kept for its own tone: a tone was heard, whatever the facts store (a stored null never says "No tone heard"
	// next to "Speech heard over a tone")
	if ((tone === undefined || tone === null) && ownTone)
		return { ...base, state: "heard", why: "not-stored" }
	if (facts === null) return { ...base, state: "not-measured", why: "no-facts" }
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
		kept: typeof item.kept === "boolean" ? item.kept : null,
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
	const self = refText({ recording: item.key ?? item.id })
	const sorted = members
		.map(memberOf)
		.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
	return {
		id: heuristic ? null : (item.observationId ?? null),
		heuristic,
		members: windowAround(sorted, self, MEMBERS_MAX),
	}
}

/** At most `max` members, oldest first, always holding `self`: the window centred on it, kept inside the list. */
export function windowAround(
	sorted: readonly TransmissionMember[],
	self: string,
	max: number,
): TransmissionMember[] {
	if (sorted.length <= max) return [...sorted]
	const at = Math.max(
		0,
		sorted.findIndex(m => m.ref === self),
	)
	const start = Math.min(
		Math.max(0, at - Math.floor(max / 2)),
		sorted.length - max,
	)
	return sorted.slice(start, start + max)
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
		recordingKind: item.kind,
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
		tone:
			item.kind === "scanner-analog"
				? recorderTone(facts, facts?.finish.keptBy ?? item.keptBy ?? null)
				: null,
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

/** The first of `times` that is a real date; null when none is (the view then shows no time). */
export function firstTime(
	...times: (string | null | undefined)[]
): string | null {
	for (const t of times)
		if (typeof t === "string" && Number.isFinite(Date.parse(t))) return t
	return null
}

/**
 * A transmission known only from Activity: a live analog transmission, a call whose file is not listed, a kept
 * scanner recording whose file is not listed (always scanner analog FM: its tone is not measured here). A live
 * transmission's row whose record could not be read is still analog voice, its tone not measured.
 */
function fromActivity(
	record: ActivityRecord | null,
	summary: ActivitySummary | null,
	gone: Set<TransmissionDto["gone"][number]>,
): TransmissionDto {
	const live = record?.kind === "analog-transmission" ? record.payload : null
	const kept = record?.kind === "recording-change" ? record.payload : null
	const keptRow = kept !== null || summary?.kind === "recording-change"
	// a live transmission's row whose record was not read: analog voice, its modulation read from the row
	const liveRow =
		live === null && record === null && summary?.kind === "analog-transmission"
	const eventId = record?.eventId ?? summary?.eventId ?? ""
	const field = (key: string) =>
		summary?.fields.find(f => f.key === key)?.value ?? null
	const rowModulation = liveRow ? modulationOfRow(summary) : null
	const rowFm = rowModulation === "nfm" || rowModulation === "wfm"
	const durationMs =
		live?.durationMs ??
		kept?.durationMs ??
		(typeof field("durationMs") === "number"
			? (field("durationMs") as number)
			: typeof field("duration") === "number"
				? (field("duration") as number)
				: (summary?.recording?.durationMs ?? null))
	// a kept file known only here has no start of its own: its record's observationStartedAt is the transmission's
	// (the view shows it as "Transmission started", knownRows), and its producedAt is when it was kept
	const startedAt = keptRow
		? null
		: firstTime(live?.startedAt, record?.producedAt, summary?.producedAt)
	const fm =
		live !== null && (live.modulation === "nfm" || live.modulation === "wfm")
	const hz =
		live?.frequency?.hz ??
		kept?.channel?.frequencyHz ??
		summary?.channel?.frequencyHz ??
		summary?.frequencyHz ??
		kept?.frequencyHz ??
		null
	const talkgroup = field("talkgroup")
	const radio = field("source")
	const rec = summary?.recording ?? null
	const recordingKeys = rec ? [rec.id] : kept !== null ? [kept.recordingId] : []
	return {
		id: null,
		refs: {
			recordingKeys,
			eventIds: eventId ? [eventId] : [],
			observationId: kept?.observationId ?? null,
			discoveryId: kept?.discoveryId ?? null,
			ownerDiscoveryId:
				kept?.channel?.discoveryId ?? summary?.channel?.discoveryId ?? null,
			operationId: null,
		},
		kind:
			live !== null || keptRow || liveRow
				? "voice-analog"
				: summary?.category === "voice"
					? "voice-digital"
					: "unknown",
		recordingKind: keptRow ? "scanner-analog" : null,
		protocol:
			live !== null
				? `analog-${live.modulation}`
				: keptRow
					? "analog-fm"
					: rowModulation !== null
						? `analog-${rowModulation}`
						: (summary?.protocol ?? null),
		sourceId: live?.sourceId ?? kept?.sourceId ?? summary?.sourceId ?? null,
		channel: {
			hz,
			measuredHz: live?.frequency?.hz ?? kept?.frequencyHz ?? null,
			name: null,
		},
		startedAt,
		endedAt:
			live?.endedAt ??
			(durationMs !== null && startedAt !== null
				? new Date(Date.parse(startedAt) + durationMs).toISOString()
				: null),
		durationMs,
		close: live
			? { reason: live.closeReason, complete: live.closeReason === "squelch" }
			: null,
		part: null,
		tone: fm
			? liveToneOf(live.tone)
			: keptRow
				? {
						state: "not-measured",
						ctcssHz: null,
						dcs: null,
						dcsChecked: false,
						from: "recorder",
						why: "no-recording",
					}
				: rowFm
					? {
							state: "not-measured",
							ctcssHz: null,
							dcs: null,
							dcsChecked: false,
							from: "live-demod",
							why: "no-record",
						}
					: null,
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
						kept: null,
						expiresAt: null,
					},
				]
			: [],
		noAudioReason: rec
			? null
			: gone.has("audio")
				? "not-listed"
				: "not-recorded",
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

/**
 * A live transmission row's modulation ("nfm", "wfm", "am", ...), from its Modulation field, else its title's
 * first word ("NFM 145.5625 MHz"); null when the row says neither. Only a known FM row gets a Tone row.
 */
export function modulationOfRow(
	summary: ActivitySummary | null,
): string | null {
	const v = summary?.fields.find(f => f.key === "modulation")?.value
	if (typeof v === "string" && /^[a-z]{2,4}$/i.test(v)) return v.toLowerCase()
	const word = /^(NFM|WFM|AM|USB|LSB|CW|DSB|RAW)\b/.exec(summary?.title ?? "")
	return word?.[1] ? word[1].toLowerCase() : null
}

/**
 * The live demodulator's tone, from a record's raw `tone` read with Zod: heard when it stored a tone or code; not
 * measured otherwise. An empty reading ({ctcssHz: null, dcs: null or absent}) is not measured, never "none": the
 * live demodulator writes exactly that when the audio was under 0.75 s, when its detector failed or threw, and old
 * records carry it too, so it cannot say no tone was heard (`live-none`, as for no reading at all). One it cannot
 * read is `malformed`.
 */
export function liveToneOf(raw: unknown): TransmissionTone {
	const t = readLiveTone(raw)
	const unknown = {
		state: "not-measured" as const,
		ctcssHz: null,
		dcs: null,
		dcsChecked: false,
		from: "live-demod" as const,
	}
	if (t === undefined) return { ...unknown, why: "live-none" }
	if (t === "malformed") return { ...unknown, why: "malformed" }
	if (t.ctcssHz === null && t.dcs === null)
		return { ...unknown, dcsChecked: t.dcsChecked, why: "live-none" }
	return {
		state: "heard",
		ctcssHz: t.ctcssHz,
		dcs: t.dcs,
		dcsChecked: t.dcsChecked,
		from: "live-demod",
		why: null,
	}
}
