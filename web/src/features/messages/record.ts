// Hooks for showing a decoded message card outside Activity (the tuned card, the Map's selection panel): the stored
// record of one event (all fields and the decoded JSON), and the latest event for a query, followed live.
import type {
	ActivityQuery,
	ActivityRecord,
	ActivitySummary,
} from "@wavekit/api-types"
import { useEffect, useState } from "react"

import { useServices } from "../../app/context.ts"
import { ActivityFeed, fetchActivityRecord } from "../../data/activity-feed.ts"

/** The stored record of `eventId` once loaded; null while loading, when gone, on error, or for a null id. */
export function useActivityRecord(
	eventId: string | null,
): ActivityRecord | null {
	const { data } = useServices()
	const [record, setRecord] = useState<{
		id: string
		r: ActivityRecord | null
	} | null>(null)
	useEffect(() => {
		if (eventId === null) return
		const abort = new AbortController()
		fetchActivityRecord(data.api, eventId, abort.signal).then(
			r => {
				if (!abort.signal.aborted) setRecord({ id: eventId, r })
			},
			() => undefined,
		)
		return () => abort.abort()
	}, [data.api, eventId])
	return record !== null && record.id === eventId ? record.r : null
}

/**
 * The newest Activity event matching `query` (a stable key names it: the query changes only when the key does),
 * snapshot then live; null for a null query or before anything matched. One small feed per caller.
 */
export function useLatestActivity(
	key: string | null,
	query: ActivityQuery | null,
	id: string,
): ActivitySummary | null {
	const { data } = useServices()
	const [latest, setLatest] = useState<{
		key: string
		item: ActivitySummary | null
	} | null>(null)
	useEffect(() => {
		if (key === null || query === null) return
		const feed = new ActivityFeed(data.api, data.events, {
			id,
			pageSize: 1,
			maxItems: 3,
		})
		const off = feed.subscribe(s =>
			setLatest({ key, item: s.items[0] ?? null }),
		)
		void feed.setQuery(query)
		return () => {
			off()
			feed.dispose()
		}
		// the key names the query: a new object for the same key does not reload
	}, [data.api, data.events, id, key])
	return latest !== null && latest.key === key ? latest.item : null
}
