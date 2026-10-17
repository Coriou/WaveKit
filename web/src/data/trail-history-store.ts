/**
 * Stored position history for the Map's trails (WG4): GET /api/activity/trails, one trail per entity
 * from the positions Activity keeps (at most one per entity per 60 s), over the core's default
 * window of one hour, the longest Map › Trail length. Read once when the Map opens and again after a
 * reconnect, so a trail is drawn at its full length at once instead of growing from the page's
 * opening. Points are turned into this browser's clock against the answer's `generatedAt`.
 */
import { z } from "zod/v4"
import type { ActivityTrails } from "@wavekit/api-types"

import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage, validated } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import type { TrailPoint } from "./fleet-store.ts"
import type { Listener, ReadableStore } from "./store.ts"
import { Store } from "./store.ts"

const PATH = "/api/activity/trails"

export const trailsSchema = z.object({
	trails: z.array(
		z.object({
			entityKey: z.string(),
			points: z.array(
				z.tuple([z.number(), z.number(), z.number(), z.number().nullable()]),
			),
		}),
	),
	generatedAt: z.string(),
})

// the schema accepts the DTO
export type TrailsCheck =
	ActivityTrails extends z.input<typeof trailsSchema> ? true : never

export interface TrailHistoryState {
	/** `unavailable`: the core has no trails route or no Activity store (404). */
	readonly status: "idle" | "loading" | "ready" | "unavailable" | "error"
	/** Oldest first, this browser's clock, by Activity entity key. */
	readonly trails: ReadonlyMap<string, readonly TrailPoint[]>
	readonly error: string | null
}

export class TrailHistoryStore implements ReadableStore<TrailHistoryState> {
	private readonly state = new Store<TrailHistoryState>({
		status: "idle",
		trails: new Map(),
		error: null,
	})
	private readonly api: ApiClient
	private readonly events: EventsClient
	private readonly clock: () => number
	private attached = 0
	private offReconnect: (() => void) | null = null
	private inflight: Promise<void> | null = null

	constructor(
		api: ApiClient,
		events: EventsClient,
		options: { now?: () => number } = {},
	) {
		this.api = api
		this.events = events
		this.clock = options.now ?? Date.now
	}

	get(): TrailHistoryState {
		return this.state.get()
	}

	subscribe = (listener: Listener<TrailHistoryState>): (() => void) =>
		this.state.subscribe(listener)

	/** Loads now and after each reconnect while attached (reference counted). */
	attach(): () => void {
		this.attached += 1
		if (this.attached === 1) {
			this.offReconnect = this.events.onReconnected(() => void this.load())
			void this.load()
		}
		let done = false
		return () => {
			if (done) return
			done = true
			this.attached -= 1
			if (this.attached > 0) return
			this.offReconnect?.()
			this.offReconnect = null
		}
	}

	/** Never rejects. */
	load(): Promise<void> {
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	private async fetch(): Promise<void> {
		if (this.state.get().status !== "ready")
			this.state.update(s => ({ ...s, status: "loading" }))
		try {
			const body = await this.api.get<unknown>(PATH)
			const answer = validated(trailsSchema, body, "GET", PATH)
			const receivedAt = this.clock()
			const coreNow = Date.parse(answer.generatedAt)
			const offset = Number.isFinite(coreNow) ? receivedAt - coreNow : 0
			const trails = new Map<string, TrailPoint[]>()
			for (const t of answer.trails)
				trails.set(
					t.entityKey,
					t.points.map(([at, lat, lon]) => ({
						lat,
						lon,
						at: Math.min(receivedAt, at + offset),
					})),
				)
			this.state.set({ status: "ready", trails, error: null })
		} catch (error) {
			if (error instanceof ApiError && error.status === 404)
				this.state.set({
					status: "unavailable",
					trails: new Map(),
					error: null,
				})
			else
				this.state.update(s => ({
					...s,
					status: s.status === "ready" ? s.status : "error",
					error: errorMessage(error),
				}))
		}
	}
}

/**
 * A live trail with the stored history in front of it: the history's points older than the live
 * trail's first point, then the live trail. The live trail wins where both cover the same time.
 */
export function withHistory(
	live: readonly TrailPoint[],
	history: readonly TrailPoint[] | undefined,
): readonly TrailPoint[] {
	if (!history || history.length === 0) return live
	const first = live[0]
	if (!first) return history
	let end = 0
	while (end < history.length && (history[end]?.at ?? 0) < first.at) end += 1
	if (end === 0) return live
	return [...history.slice(0, end), ...live]
}
