// The selected aircraft's datalink story (Map › selection, "Datalink"): what it said over ACARS and VDL2, newest
// first, with link upkeep counted instead of listed. The aircraft is found by its ICAO address and by the
// registrations the core links to it (GET /api/aircraft-identity, observed or database evidence only); never by
// callsign or flight number, which name a flight, not an airframe. Pure helpers, DatalinkFollower and one hook.
import { z } from "zod/v4"
import type { ActivitySummary } from "@wavekit/api-types"
import { useEffect, useState } from "react"

import { useServices } from "../../app/context.ts"
import { mergeNewest, queryParams } from "../../data/activity-feed.ts"
import { ApiError, type ApiClient } from "../../data/api-client.ts"
import type { EventsClient } from "../../data/events-client.ts"
import { isLinkTraffic, timeOf } from "../activity/fold.ts"
import { aviationLive, type AviationLive } from "./aviation-live.ts"

/** Messages listed in the panel; the rest are in Activity. */
export const STORY_MAX = 5
/** Rows read per entity key: enough to list STORY_MAX messages among the link upkeep around them. */
const ROWS_PER_KEY = 30
/** Entity keys followed: the ICAO address and at most two registrations. */
const MAX_KEYS = 3
/**
 * The identity is asked again this often while the aircraft stays selected, so a link learnt later adds its
 * registration and an expired or conflicted one drops it: one small GET a minute for the one selected aircraft.
 */
export const IDENTITY_REFRESH_MS = 60_000
/**
 * A new datalink message may carry a new link, so it asks again sooner, but at most once per this gap: a burst
 * of messages costs one request.
 */
export const IDENTITY_MIN_GAP_MS = 5_000

const identifierSchema = z.object({ kind: z.string(), value: z.string() })
export const identitySchema = z.object({
	icao: z.string().nullable(),
	conflict: z.boolean(),
	links: z.array(
		z.object({
			a: identifierSchema,
			b: identifierSchema,
			evidence: z.string(),
			source: z.string(),
			lastSeen: z.string(),
		}),
	),
	entityKeys: z.array(z.string()),
})
export type IdentityAnswer = z.infer<typeof identitySchema>

/** The entity keys whose aviation-data rows belong to this aircraft: always its own address first. */
export function storyKeys(
	icao: string,
	identity: IdentityAnswer | null,
): string[] {
	const own = `icao:${icao.toUpperCase()}`
	const keys = [own]
	for (const k of identity?.entityKeys ?? [])
		if (k.startsWith("reg:") && !keys.includes(k)) keys.push(k)
	return keys.slice(0, MAX_KEYS)
}

/** How the registration was tied to the address, in words; null when it was not. */
export function linkedByText(identity: IdentityAnswer | null): string | null {
	if (!identity || identity.icao === null) return null
	// Only a registration the story follows: one another address also claims is left out.
	const followed = (l: (typeof identity.links)[number]) =>
		identity.entityKeys.includes(
			`reg:${l.a.kind === "reg" ? l.a.value : l.b.value}`,
		)
	const link = identity.links.find(
		l =>
			l.evidence !== "hint" &&
			((l.a.kind === "icao" && l.b.kind === "reg") ||
				(l.a.kind === "reg" && l.b.kind === "icao")) &&
			followed(l),
	)
	if (!link) return null
	const reg = link.a.kind === "reg" ? link.a.value : link.b.value
	return link.evidence === "observed"
		? `Registration ${reg} heard with this address on ${link.source === "vdl2" ? "VDL2" : link.source.toUpperCase()}`
		: `Registration ${reg} from the aircraft database`
}

export interface DatalinkStory {
	/** Messages that say something, newest first, at most STORY_MAX. */
	readonly messages: readonly ActivitySummary[]
	/** All messages loaded (more than `messages` when Activity holds more). */
	readonly messageCount: number
	/** Link upkeep frames loaded (folded in Activity). */
	readonly linkCount: number
}

/** The story from the rows of every key, deduplicated by event. */
export function datalinkStory(rows: readonly ActivitySummary[]): DatalinkStory {
	const seen = new Set<string>()
	const unique = rows.filter(r => {
		if (seen.has(r.eventId)) return false
		seen.add(r.eventId)
		return true
	})
	const messages = unique
		.filter(r => !isLinkTraffic(r))
		.sort((a, b) => timeOf(b) - timeOf(a))
	return {
		messages: messages.slice(0, STORY_MAX),
		messageCount: messages.length,
		linkCount: unique.length - messages.length,
	}
}

/** The answer, null when the core has none (an older core, a malformed body), undefined when the request failed. */
async function fetchIdentity(
	api: ApiClient,
	icao: string,
	signal: AbortSignal,
): Promise<IdentityAnswer | null | undefined> {
	try {
		const body = await api.get<unknown>(
			`/api/aircraft-identity/icao/${encodeURIComponent(icao)}`,
			{ signal },
		)
		const parsed = identitySchema.safeParse(body)
		return parsed.success ? parsed.data : null
	} catch (error) {
		// an older core without the route: the address alone still finds its VDL2 rows
		if (error instanceof ApiError && error.status === 404) return null
		return undefined
	}
}

/** Which followed keys to stop and which to start for the new set. */
export function keyChanges(
	followed: readonly string[],
	wanted: readonly string[],
): { readonly add: readonly string[]; readonly remove: readonly string[] } {
	return {
		add: wanted.filter(k => !followed.includes(k)),
		remove: followed.filter(k => !wanted.includes(k)),
	}
}

export interface FollowedStory {
	readonly story: DatalinkStory
	readonly linkedBy: string | null
}

const rowsSchema = z.object({
	items: z.array(
		z
			.object({
				eventId: z.string(),
				commitSeq: z.string(),
				producedAt: z.string(),
				entityKey: z.string().nullable(),
				fields: z.array(z.unknown()),
			})
			.passthrough(),
	),
}) as unknown as z.ZodType<{ items: ActivitySummary[] }>

/** The newest rows of one entity key; empty when Activity is off or the request failed. */
async function fetchRows(
	api: ApiClient,
	key: string,
	signal: AbortSignal,
): Promise<readonly ActivitySummary[] | null> {
	try {
		const body = await api.request<unknown>("GET", "/api/activity", undefined, {
			query: {
				...queryParams({ categories: ["aviation-data"], entityKey: key }),
				order: "desc",
				limit: ROWS_PER_KEY,
			},
			signal,
		})
		const parsed = rowsSchema.safeParse(body)
		return parsed.success ? parsed.data.items : null
	} catch {
		return null
	}
}

/**
 * Follows one aircraft's story: its identity (asked again every IDENTITY_REFRESH_MS, and soon after a new
 * message), the newest rows of each entity key the identity gives, and new rows from the Map's one shared
 * aviation-data subscription (AviationLive). A later link adds its registration; an expired or conflicted one
 * drops it. `onStory` runs once rows have arrived, and on every change after that.
 */
export class DatalinkFollower {
	private readonly abort = new AbortController()
	/** Followed keys, each with its rows (null until its first read answers). */
	private readonly rows = new Map<string, readonly ActivitySummary[] | null>()
	private identity: IdentityAnswer | null = null
	private inflight = false
	private lastAsked = Number.NEGATIVE_INFINITY
	private soon: ReturnType<typeof setTimeout> | null = null
	private timer: ReturnType<typeof setInterval> | null = null
	private offs: (() => void)[] = []
	private readonly clock: () => number
	private readonly aviation: AviationLive

	constructor(
		private readonly api: ApiClient,
		events: EventsClient,
		private readonly icao: string,
		private readonly onStory: (story: FollowedStory) => void,
		options: { now?: () => number; aviation?: AviationLive } = {},
	) {
		this.clock = options.now ?? Date.now
		this.aviation = options.aviation ?? aviationLive(api, events)
	}

	/** The keys followed now. */
	get keys(): readonly string[] {
		return [...this.rows.keys()]
	}

	start(): void {
		this.offs = [
			this.aviation.onRows(rows => this.receive(rows)),
			this.aviation.onReset(() => {
				for (const key of this.rows.keys()) this.read(key)
			}),
			this.aviation.attach(),
		]
		this.ask()
		this.timer = setInterval(() => this.ask(), IDENTITY_REFRESH_MS)
	}

	stop(): void {
		this.abort.abort()
		if (this.timer !== null) clearInterval(this.timer)
		this.timer = null
		if (this.soon !== null) clearTimeout(this.soon)
		this.soon = null
		for (const off of this.offs) off()
		this.offs = []
		this.rows.clear()
	}

	private loaded(): boolean {
		for (const r of this.rows.values()) if (r !== null) return true
		return false
	}

	private publish(): void {
		if (!this.loaded()) return
		const all: ActivitySummary[] = []
		for (const r of this.rows.values()) if (r) all.push(...r)
		this.onStory({
			story: datalinkStory(all),
			linkedBy: linkedByText(this.identity),
		})
	}

	private receive(fresh: readonly ActivitySummary[]): void {
		let changed = false
		for (const [key, held] of this.rows) {
			const mine = fresh.filter(r => r.entityKey === key)
			if (mine.length === 0) continue
			this.rows.set(key, mergeNewest(held ?? [], mine, ROWS_PER_KEY))
			changed = true
		}
		if (!changed) return
		this.publish()
		// a new message may carry a new link: ask again soon
		this.askSoon()
	}

	private read(key: string): void {
		void fetchRows(this.api, key, this.abort.signal).then(rows => {
			if (this.abort.signal.aborted || !this.rows.has(key)) return
			const held = this.rows.get(key) ?? []
			// live rows that came while reading stay
			this.rows.set(key, mergeNewest(rows ?? [], held, ROWS_PER_KEY))
			this.publish()
		})
	}

	private ask(): void {
		if (this.inflight || this.abort.signal.aborted) return
		this.inflight = true
		this.lastAsked = this.clock()
		void fetchIdentity(this.api, this.icao, this.abort.signal).then(answer => {
			this.inflight = false
			if (this.abort.signal.aborted) return
			// a failed request keeps what was known; the first one still reads the address's own rows
			if (answer === undefined && this.rows.size > 0) return
			this.follow(answer === undefined ? this.identity : answer)
		})
	}

	private askSoon(): void {
		if (this.soon !== null) return
		const wait = Math.max(
			0,
			this.lastAsked + IDENTITY_MIN_GAP_MS - this.clock(),
		)
		this.soon = setTimeout(() => {
			this.soon = null
			this.ask()
		}, wait)
	}

	private follow(answer: IdentityAnswer | null): void {
		const before = linkedByText(this.identity)
		this.identity = answer
		const { add, remove } = keyChanges(this.keys, storyKeys(this.icao, answer))
		for (const key of remove) this.rows.delete(key)
		for (const key of add) {
			this.rows.set(key, null)
			this.read(key)
		}
		// a dropped key or a new link text shows at once
		if (remove.length > 0 || linkedByText(answer) !== before) this.publish()
	}
}

/**
 * The selected aircraft's story, followed live (DatalinkFollower); null until its first rows arrive or for a
 * null address.
 */
export function useDatalinkStory(
	icao: string | null,
): (DatalinkStory & { linkedBy: string | null }) | null {
	const { data } = useServices()
	const [state, setState] = useState<{
		icao: string
		story: DatalinkStory
		linkedBy: string | null
	} | null>(null)
	useEffect(() => {
		if (icao === null) return
		const follower = new DatalinkFollower(data.api, data.events, icao, s =>
			setState({ icao, ...s }),
		)
		follower.start()
		return () => follower.stop()
	}, [data.api, data.events, icao])
	return state !== null && state.icao === icao
		? { ...state.story, linkedBy: state.linkedBy }
		: null
}
