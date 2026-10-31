// The selected aircraft's datalink story (Map › selection, "Datalink"): what it said over ACARS and VDL2, newest
// first, with link upkeep counted instead of listed. The aircraft is found by its ICAO address and by the
// registrations the core links to it (GET /api/aircraft-identity, observed or database evidence only); never by
// callsign or flight number, which name a flight, not an airframe. Pure helpers plus one hook.
import { z } from "zod/v4"
import type { ActivitySummary } from "@wavekit/api-types"
import { useEffect, useState } from "react"

import { useServices } from "../../app/context.ts"
import { ActivityFeed } from "../../data/activity-feed.ts"
import type { ApiClient } from "../../data/api-client.ts"
import { isLinkTraffic, timeOf } from "../activity/fold.ts"

/** Messages listed in the panel; the rest are in Activity. */
export const STORY_MAX = 5
/** Rows read per entity key: enough to list STORY_MAX messages among the link upkeep around them. */
const ROWS_PER_KEY = 30
/** Entity keys followed: the ICAO address and at most two registrations. */
const MAX_KEYS = 3

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
	const link = identity.links.find(
		l =>
			l.evidence !== "hint" &&
			((l.a.kind === "icao" && l.b.kind === "reg") ||
				(l.a.kind === "reg" && l.b.kind === "icao")),
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

async function fetchIdentity(
	api: ApiClient,
	icao: string,
	signal: AbortSignal,
): Promise<IdentityAnswer | null> {
	try {
		const body = await api.get<unknown>(
			`/api/aircraft-identity/icao/${encodeURIComponent(icao)}`,
			{ signal },
		)
		const parsed = identitySchema.safeParse(body)
		return parsed.success ? parsed.data : null
	} catch {
		// an older core without the route, or offline: the address alone still finds its VDL2 rows
		return null
	}
}

/** The selected aircraft's story, followed live; null until its first rows arrive or for a null address. */
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
		const abort = new AbortController()
		const feeds: ActivityFeed[] = []
		const offs: (() => void)[] = []
		let identity: IdentityAnswer | null = null
		const rows = new Map<string, readonly ActivitySummary[]>()
		const publish = () =>
			setState({
				icao,
				story: datalinkStory([...rows.values()].flat()),
				linkedBy: linkedByText(identity),
			})
		void fetchIdentity(data.api, icao, abort.signal).then(answer => {
			if (abort.signal.aborted) return
			identity = answer
			for (const key of storyKeys(icao, answer)) {
				const feed = new ActivityFeed(data.api, data.events, {
					id: `map-datalink-${key}`,
					pageSize: ROWS_PER_KEY,
					maxItems: ROWS_PER_KEY,
				})
				feeds.push(feed)
				offs.push(
					feed.subscribe(s => {
						rows.set(key, s.items)
						publish()
					}),
				)
				void feed.setQuery({ categories: ["aviation-data"], entityKey: key })
			}
		})
		return () => {
			abort.abort()
			for (const off of offs) off()
			for (const feed of feeds) feed.dispose()
		}
	}, [data.api, data.events, icao])
	return state !== null && state.icao === icao
		? { ...state.story, linkedBy: state.linkedBy }
		: null
}
