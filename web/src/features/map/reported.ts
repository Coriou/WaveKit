// Positions aircraft reported over ACARS and VDL2 (the ACARS layer): an ADS-C report decoded by libacars, or
// the rough position a VDL2 link frame (XID) carries to 0.1°. They come from GET /api/activity/trails for the
// aviation-data category only, so they never join an ADS-B track: the aircraft said where it was, at a time,
// with its own accuracy, and the Map draws that apart from what readsb heard. ReportedPositionsStore follows
// new reports live and ages them by the clock; the rest are pure functions over the trails.
import type { ActivitySummary } from "@wavekit/api-types"

import type { ApiClient } from "../../data/api-client.ts"
import type { EventsClient } from "../../data/events-client.ts"
import type { TrailPoint } from "../../data/fleet-store.ts"
import { Store, type Listener, type ReadableStore } from "../../data/store.ts"
import {
	TrailHistoryStore,
	type TrailHistoryState,
} from "../../data/trail-history-store.ts"
import { aviationLive, type AviationLive } from "./aviation-live.ts"
import { collection, type FeatureCollection } from "./features.ts"

/** Reports older than this leave the Map: the trails window the core answers by default (one hour). */
export const REPORTED_MAX_AGE_MS = 60 * 60_000
/** Ages are shown in whole minutes, so the layer is redrawn (and old reports dropped) once a minute. */
export const REPORTED_TICK_MS = 60_000
/**
 * Most entities followed live between two trail reloads. An hour of ACARS and VDL2 at a busy station
 * names a few hundred aircraft; 2,000 leaves room and keeps the map's point layer small.
 */
export const REPORTED_MAX_LIVE = 2_000

export interface ReportedState extends TrailHistoryState {
	/** This browser's clock at the last update or tick, ms: what reports are aged against. */
	readonly now: number
}

/** A live report: where, when the core says it was made (core clock, ms), and when it arrived here. */
interface LiveReport {
	readonly lat: number
	readonly lon: number
	readonly producedAt: number | null
	readonly arrivedAt: number
}

/**
 * Reported positions for the Map: the stored trails (read on attach, after a reconnect and each time
 * the live follow goes live) plus every aviation-data row with a position that arrives live while the
 * Map is open. A row keeps its real age: its `producedAt` turned into this browser's clock with the
 * offset of the last trails answer, as the stored points are, and never later than its arrival. Ticks
 * once a minute so ages advance and reports past the hour expire.
 */
export class ReportedPositionsStore implements ReadableStore<ReportedState> {
	private readonly history: TrailHistoryStore
	private readonly events: EventsClient
	private readonly state: Store<ReportedState>
	private readonly aviation: AviationLive
	private readonly clock: () => number
	private readonly tickMs: number
	/** Newest live report of each entity, oldest first (re-inserted on every report). */
	private readonly live = new Map<string, LiveReport>()
	private attached = 0
	private detach: (() => void) | null = null
	/** This store's trails read in flight, and whether another must start after it. */
	private loading: Promise<void> | null = null
	private reloadAfter = false

	constructor(
		api: ApiClient,
		events: EventsClient,
		options: {
			now?: () => number
			tickMs?: number
			aviation?: AviationLive
		} = {},
	) {
		this.events = events
		this.aviation = options.aviation ?? aviationLive(api, events)
		this.clock = options.now ?? Date.now
		this.tickMs = options.tickMs ?? REPORTED_TICK_MS
		this.history = new TrailHistoryStore(api, events, {
			categories: ["aviation-data"],
			now: this.clock,
		})
		this.state = new Store<ReportedState>({
			...this.history.get(),
			now: this.clock(),
		})
	}

	get(): ReportedState {
		return this.state.get()
	}

	subscribe = (listener: Listener<ReportedState>): (() => void) =>
		this.state.subscribe(listener)

	/** Loads the stored reports, then follows new ones while attached (reference counted). */
	attach(): () => void {
		this.attached += 1
		if (this.attached === 1) this.detach = this.start()
		let done = false
		return () => {
			if (done) return
			done = true
			this.attached -= 1
			if (this.attached > 0) return
			this.detach?.()
			this.detach = null
		}
	}

	private start(): () => void {
		const offHistoryState = this.history.subscribe(() => this.publish())
		const offRows = this.aviation.onRows(rows => this.receive(rows))
		// reports from before the live follow went live (or while it restarted) are in the stored trails
		const offReset = this.aviation.onReset(() => this.loadHistory())
		const offReconnect = this.events.onReconnected(() => this.loadHistory())
		const offLive = this.aviation.attach()
		this.loadHistory()
		const timer = setInterval(() => this.tick(), this.tickMs)
		return () => {
			clearInterval(timer)
			offLive()
			offReconnect()
			offReset()
			offRows()
			offHistoryState()
			this.reloadAfter = false
			this.live.clear()
		}
	}

	/**
	 * Reads the stored trails. A read already in flight may have been answered before what asked for
	 * this one (the subscription going live), so another starts once it settles.
	 */
	private loadHistory(): void {
		if (this.loading) {
			this.reloadAfter = true
			return
		}
		this.loading = this.history.load().finally(() => {
			this.loading = null
			if (!this.reloadAfter) return
			this.reloadAfter = false
			if (this.detach !== null) this.loadHistory()
		})
	}

	private receive(rows: readonly ActivitySummary[]): void {
		const arrivedAt = this.clock()
		let changed = false
		// newest first: the oldest is applied first, so the newest of an entity wins
		for (let i = rows.length - 1; i >= 0; i--) {
			const r = rows[i]
			const p = r?.position
			if (!r || !p || r.entityKey === null) continue
			if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue
			const produced = Date.parse(r.producedAt)
			const report: LiveReport = {
				lat: p.lat,
				lon: p.lon,
				producedAt: Number.isFinite(produced) ? produced : null,
				arrivedAt,
			}
			const held = this.live.get(r.entityKey)
			// a replayed row older than the one held does not replace it
			if (held && this.at(held) > this.at(report)) continue
			this.live.delete(r.entityKey)
			this.live.set(r.entityKey, report)
			changed = true
		}
		while (this.live.size > REPORTED_MAX_LIVE) {
			const oldest = this.live.keys().next().value
			if (oldest === undefined) break
			this.live.delete(oldest)
		}
		if (changed) this.publish()
	}

	/** A live report's time on this browser's clock. */
	private at(r: LiveReport): number {
		if (r.producedAt === null) return r.arrivedAt
		return Math.min(r.arrivedAt, r.producedAt + this.history.clockOffsetMs())
	}

	private tick(): void {
		const now = this.clock()
		for (const [key, r] of this.live)
			if (now - this.at(r) > REPORTED_MAX_AGE_MS) this.live.delete(key)
		this.publish()
	}

	private publish(): void {
		const h = this.history.get()
		let trails = h.trails
		if (this.live.size > 0) {
			const merged = new Map(h.trails)
			for (const [key, r] of this.live) {
				const stored = merged.get(key) ?? []
				const point: TrailPoint = { lat: r.lat, lon: r.lon, at: this.at(r) }
				// a live report the stored trail already holds (read again since) is not drawn twice
				const last = stored.at(-1)
				if (last && last.at >= point.at) continue
				merged.set(key, [...stored, point])
			}
			trails = merged
		}
		this.state.set({ ...h, trails, now: this.clock() })
	}
}

export interface ReportedPosition {
	/** The Activity entity key ("icao:0A0B01", "reg:N0WK01"). */
	readonly entityKey: string
	readonly lat: number
	readonly lon: number
	/** This browser's clock, ms. */
	readonly at: number
}

/** The latest report of each entity within the window, newest first. */
export function latestReports(
	trails: ReadonlyMap<string, readonly TrailPoint[]>,
	now: number,
	maxAgeMs: number = REPORTED_MAX_AGE_MS,
): ReportedPosition[] {
	const out: ReportedPosition[] = []
	for (const [entityKey, points] of trails) {
		let last: TrailPoint | undefined
		for (const p of points) if (!last || p.at >= last.at) last = p
		if (!last || now - last.at > maxAgeMs) continue
		out.push({ entityKey, lat: last.lat, lon: last.lon, at: last.at })
	}
	return out.sort((a, b) => b.at - a.at)
}

/** "N0WK01" for "reg:N0WK01", the key itself when it has no kind. */
export function reportedName(entityKey: string): string {
	const colon = entityKey.indexOf(":")
	return colon > 0 ? entityKey.slice(colon + 1) : entityKey
}

/** Whole minutes since the report, at least 0. */
export function reportAgeMin(at: number, now: number): number {
	return Math.max(0, Math.floor((now - at) / 60_000))
}

/** Points for the ACARS layer: `id` the entity key, `n` its name, `m` the age in minutes. */
export function reportedFeatures(
	list: readonly ReportedPosition[],
	now: number,
): FeatureCollection {
	return collection(
		list.map((r, i) => ({
			type: "Feature",
			id: i,
			properties: {
				id: r.entityKey,
				n: reportedName(r.entityKey),
				m: reportAgeMin(r.at, now),
			},
			geometry: { type: "Point", coordinates: [r.lon, r.lat] },
		})),
	)
}
