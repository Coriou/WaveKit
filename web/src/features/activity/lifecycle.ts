import type { ActivityLifecycleStatus } from "@wavekit/api-types"
import { useEffect, useState } from "react"

import type { ApiClient } from "../../data/api-client.ts"

/**
 * While the core answered 404/503 to an Activity read, the drawer polls
 * `GET /api/activity/status` this often to tell "starting" and "retrying" from "off". The
 * core's first retry is 5 s after a failed open, so 3 s sees each state change within one
 * retry; one small request every 3 s only while the drawer shows the notice.
 */
export const ACTIVITY_LIFECYCLE_POLL_MS = 3_000

/** What the drawer shows instead of an empty list while Activity is not open. */
export type ActivityAvailability =
	| { kind: "unknown" }
	| { kind: "off" }
	| { kind: "lifecycle"; lifecycle: ActivityLifecycleStatus }

/** GET /api/activity/status: the lifecycle, "off" on 404 (Activity disabled), else unknown. */
export async function fetchActivityAvailability(
	api: ApiClient,
	signal?: AbortSignal,
): Promise<ActivityAvailability> {
	try {
		const body = await api.request<{
			stats?: { lifecycle?: ActivityLifecycleStatus }
		}>("GET", "/api/activity/status", undefined, signal ? { signal } : {})
		const lifecycle = body.stats?.lifecycle
		// An older core without the lifecycle answered 200: the store is open.
		return lifecycle
			? { kind: "lifecycle", lifecycle }
			: {
					kind: "lifecycle",
					lifecycle: {
						state: "available",
						reason: null,
						attempts: 1,
						nextAttemptAt: null,
						droppedWhileClosed: 0,
					},
				}
	} catch (error) {
		if ((error as { status?: number }).status === 404) return { kind: "off" }
		// An older core answers 503 for a store that did not open: unavailable, no retry.
		if ((error as { status?: number }).status === 503)
			return {
				kind: "lifecycle",
				lifecycle: {
					state: "unavailable",
					reason: null,
					attempts: 1,
					nextAttemptAt: null,
					droppedWhileClosed: 0,
				},
			}
		return { kind: "unknown" }
	}
}

/** The notice text for a lifecycle that is not available, or null once it is. */
export function lifecycleNotice(
	availability: ActivityAvailability,
): { text: string; tone: "info" | "warn" } | null {
	if (availability.kind === "off")
		return {
			text: "Activity is turned off on this receiver. Decodes still show on the spectrum.",
			tone: "info",
		}
	if (availability.kind === "unknown")
		return { text: "Activity is starting…", tone: "info" }
	switch (availability.lifecycle.state) {
		case "opening":
			return { text: "Activity is starting…", tone: "info" }
		case "retrying":
			return { text: "Activity store unavailable, retrying", tone: "warn" }
		case "unavailable":
			return {
				text: "Activity store is unavailable on this receiver. Decodes still show on the spectrum.",
				tone: "warn",
			}
		case "available":
			return null
	}
}

/**
 * Polls the lifecycle while `active` (the feed answered 404/503) and calls `onAvailable`
 * once the store reports `available`, so the list loads without a page reload.
 */
export function useActivityAvailability(
	api: ApiClient,
	active: boolean,
	onAvailable: () => void,
): ActivityAvailability {
	const [availability, setAvailability] = useState<ActivityAvailability>({
		kind: "unknown",
	})
	useEffect(() => {
		if (!active) return
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | null = null
		const poll = async () => {
			const next = await fetchActivityAvailability(api, controller.signal)
			if (controller.signal.aborted) return
			setAvailability(next)
			if (next.kind === "lifecycle" && next.lifecycle.state === "available") {
				onAvailable()
				return
			}
			// Off and permanently unavailable do not change without a core restart.
			if (
				next.kind === "off" ||
				(next.kind === "lifecycle" && next.lifecycle.state === "unavailable")
			)
				return
			timer = setTimeout(() => void poll(), ACTIVITY_LIFECYCLE_POLL_MS)
		}
		void poll()
		return () => {
			controller.abort()
			if (timer !== null) clearTimeout(timer)
		}
	}, [api, active, onAvailable])
	return availability
}
