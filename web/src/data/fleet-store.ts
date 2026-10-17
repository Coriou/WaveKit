/**
 * Current state of one fleet with a position (aircraft, vessels, APRS stations, mesh nodes): the REST
 * snapshot, then `<prefix>:new | update | lost` on the fleet's WebSocket channel. Every body is
 * validated with the fleet's Zod schema; a message that does not match is dropped. Updates are
 * batched: messages land in a pending map and one flush (at most every `flushMs`) publishes a new
 * snapshot, so a busy channel never renders per message. Attached on demand (the Map view): the
 * first attach subscribes and loads, the last detach unsubscribes.
 *
 * Times: positions and "last heard" are kept in this browser's clock. The core's times are turned
 * into ages against the core's own "now" (the list timestamp, or the entity's last update for a
 * WebSocket message), so a clock difference between the core and the browser does not move them.
 */
import type { ZodType } from "zod/v4"

import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage } from "./api-client.ts"
import type { EventChannel, EventsClient, EventType } from "./events-client.ts"
import type { Listener, ReadableStore } from "./store.ts"
import { Store } from "./store.ts"

/** One point of a trail, oldest first; `at` in this browser's clock (ms). */
export interface TrailPoint {
	readonly lat: number
	readonly lon: number
	readonly at: number
}

export interface FleetEntry<T> {
	readonly value: T
	/** When the core last heard the entity, in this browser's clock (ms). */
	readonly heardAt: number
	/** When the position was received by the core, in this browser's clock (ms); null without a position. */
	readonly posAt: number | null
	/** Oldest first: the core's track when it keeps one, else the positions seen since the page opened. */
	readonly trail: readonly TrailPoint[]
	/** The trail came from the core (ADS-B track history), not from this page. */
	readonly trailFromCore: boolean
}

/** `unavailable`: the core does not run this tracker (its routes answer 404). */
export type FleetStatus = "idle" | "loading" | "live" | "unavailable" | "error"

export interface FleetState<T> {
	readonly status: FleetStatus
	readonly error: string | null
	readonly entries: ReadonlyMap<string, FleetEntry<T>>
	/** Bumped on every published change. */
	readonly revision: number
}

/** A position as the core reports it: `at` in the core's clock (ms). */
export interface ReportedPosition {
	readonly lat: number
	readonly lon: number
	readonly at: number
}

export interface FleetSpec<T> {
	/** For error texts. */
	readonly name: string
	/** GET path of the list. */
	readonly path: string
	readonly channel: EventChannel
	readonly events: {
		readonly new: EventType
		readonly update: EventType
		readonly lost: EventType
	}
	/** Validates one entity. */
	readonly item: ZodType<T, unknown>
	/** The list body: its items and the core's time of the answer (ms). */
	readonly list: (body: unknown) => { items: unknown[]; now: number } | null
	/** The key of a `lost` message's data, or null when it does not parse. */
	readonly lostKey: (data: unknown) => string | null
	readonly keyOf: (value: T) => string
	/** When the core last heard the entity, in the core's clock (ms). */
	readonly heardAt: (value: T) => number
	/** When the core last changed the entity, in the core's clock (ms): "now" for a WebSocket message about it. Default heardAt. */
	readonly updatedAt?: (value: T) => number
	readonly positionOf: (value: T) => ReportedPosition | null
	/** The core's own track (oldest first, core clock), when the fleet keeps one. */
	readonly coreTrail?: (value: T) => readonly ReportedPosition[] | null
}

export interface FleetStoreOptions {
	/** Minimum time between published snapshots. Default 250 ms. */
	flushMs?: number
	/** This browser's clock. Default Date.now. */
	now?: () => number
	/** Trail points older than this are dropped. Default one hour. */
	trailMs?: number
	/** At most this many points per trail. Default 120. */
	trailPoints?: number
}

/** A pending change: the new value with its core "now", or null when the entity was lost. */
type Pending<T> = { value: T; coreNow: number; receivedAt: number } | null

const TRAIL_MIN_M = 25

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const rad = Math.PI / 180
	const dLat = (b.lat - a.lat) * rad
	const dLon = (b.lon - a.lon) * rad
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
	return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export class FleetStore<T> implements ReadableStore<FleetState<T>> {
	private readonly state: Store<FleetState<T>>
	private readonly api: ApiClient
	private readonly events: EventsClient
	private readonly spec: FleetSpec<T>
	private readonly flushMs: number
	private readonly clock: () => number
	private readonly trailMs: number
	private readonly trailPoints: number
	private readonly pending = new Map<string, Pending<T>>()
	private timer: ReturnType<typeof setTimeout> | null = null
	private lastFlush = Number.NEGATIVE_INFINITY
	private attached = 0
	private offs: (() => void)[] = []
	private loading: Promise<void> | null = null
	/** Messages that arrive while the snapshot loads are applied over it. */
	private loadSeq = 0

	constructor(
		api: ApiClient,
		events: EventsClient,
		spec: FleetSpec<T>,
		options: FleetStoreOptions = {},
	) {
		this.api = api
		this.events = events
		this.spec = spec
		this.flushMs = options.flushMs ?? 250
		this.clock = options.now ?? Date.now
		this.trailMs = options.trailMs ?? 3_600_000
		this.trailPoints = options.trailPoints ?? 120
		this.state = new Store<FleetState<T>>({
			status: "idle",
			error: null,
			entries: new Map(),
			revision: 0,
		})
	}

	get(): FleetState<T> {
		return this.state.get()
	}

	subscribe = (listener: Listener<FleetState<T>>): (() => void) =>
		this.state.subscribe(listener)

	/** Subscribes to the channel and loads the snapshot (reference counted). Returns the detach. */
	attach(): () => void {
		this.attached += 1
		if (this.attached === 1) {
			const ev = this.spec.events
			this.offs = [
				this.events.subscribe([this.spec.channel]),
				this.events.on(ev.new, data => this.receive(data)),
				this.events.on(ev.update, data => this.receive(data)),
				this.events.on(ev.lost, data => this.receiveLost(data)),
				this.events.onReconnected(() => void this.load()),
			]
			void this.load()
		}
		let done = false
		return () => {
			if (done) return
			done = true
			this.attached -= 1
			if (this.attached > 0) return
			for (const off of this.offs) off()
			this.offs = []
			this.cancelFlush()
			this.pending.clear()
			this.state.update(s => ({ ...s, status: "idle" }))
		}
	}

	/** GET the list. Never rejects: a 404 is `unavailable`, anything else `error`. */
	load(): Promise<void> {
		this.loading ??= this.fetch().finally(() => {
			this.loading = null
		})
		return this.loading
	}

	/** Publishes pending changes now (tests, and the flush timer). */
	flush(): void {
		this.cancelFlush()
		if (this.pending.size === 0) return
		this.lastFlush = this.clock()
		const entries = new Map(this.state.get().entries)
		for (const [key, change] of this.pending) {
			if (change === null) entries.delete(key)
			else
				entries.set(
					key,
					this.entryOf(change.value, change.coreNow, change.receivedAt, entries.get(key)),
				)
		}
		this.pending.clear()
		this.state.update(s => ({ ...s, entries, revision: s.revision + 1 }))
	}

	// ---- internals

	private async fetch(): Promise<void> {
		const seq = ++this.loadSeq
		if (this.state.get().status !== "live")
			this.state.update(s => ({ ...s, status: "loading" }))
		try {
			const body = await this.api.get<unknown>(this.spec.path)
			if (seq !== this.loadSeq) return
			const list = this.spec.list(body)
			if (!list) throw new Error(`Unexpected answer from ${this.spec.path}`)
			const receivedAt = this.clock()
			const before = this.state.get().entries
			const entries = new Map<string, FleetEntry<T>>()
			for (const raw of list.items) {
				const parsed = this.spec.item.safeParse(raw)
				if (!parsed.success) continue
				const key = this.spec.keyOf(parsed.data)
				entries.set(
					key,
					this.entryOf(parsed.data, list.now, receivedAt, before.get(key)),
				)
			}
			this.state.update(s => ({
				status: "live",
				error: null,
				entries,
				revision: s.revision + 1,
			}))
			// messages that arrived meanwhile are newer than the snapshot
			if (this.pending.size > 0) this.flush()
		} catch (error) {
			if (seq !== this.loadSeq) return
			const unavailable = error instanceof ApiError && error.status === 404
			this.state.update(s => ({
				...s,
				status: unavailable ? "unavailable" : "error",
				error: unavailable ? null : errorMessage(error),
				revision: s.revision + 1,
			}))
		}
	}

	private receive(data: unknown): void {
		const parsed = this.spec.item.safeParse(data)
		if (!parsed.success) return
		const value = parsed.data
		this.pending.set(this.spec.keyOf(value), {
			value,
			coreNow: (this.spec.updatedAt ?? this.spec.heardAt)(value),
			receivedAt: this.clock(),
		})
		this.scheduleFlush()
	}

	private receiveLost(data: unknown): void {
		const key = this.spec.lostKey(data)
		if (key === null) return
		this.pending.set(key, null)
		this.scheduleFlush()
	}

	private scheduleFlush(): void {
		if (this.timer !== null) return
		const wait = Math.max(0, this.lastFlush + this.flushMs - this.clock())
		this.timer = setTimeout(() => {
			this.timer = null
			this.flush()
		}, wait)
	}

	private cancelFlush(): void {
		if (this.timer !== null) clearTimeout(this.timer)
		this.timer = null
	}

	/** Core times → this browser's clock: receivedAt minus the age the core reports. */
	private entryOf(
		value: T,
		coreNow: number,
		receivedAt: number,
		previous: FleetEntry<T> | undefined,
	): FleetEntry<T> {
		const local = (coreMs: number) => receivedAt - Math.max(0, coreNow - coreMs)
		const heardAt = local(this.spec.heardAt(value))
		const pos = this.spec.positionOf(value)
		const posAt = pos ? local(pos.at) : null
		const core = this.spec.coreTrail?.(value) ?? null
		if (core) {
			const trail = core.map(p => ({ lat: p.lat, lon: p.lon, at: local(p.at) }))
			return { value, heardAt, posAt, trail, trailFromCore: true }
		}
		let trail = previous?.trail ?? []
		if (pos && posAt !== null) {
			const last = trail[trail.length - 1]
			if (!last || (posAt > last.at && metres(last, pos) >= TRAIL_MIN_M))
				trail = [...trail, { lat: pos.lat, lon: pos.lon, at: posAt }]
		}
		const cutoff = receivedAt - this.trailMs
		let start = 0
		while (start < trail.length && (trail[start]?.at ?? 0) < cutoff) start += 1
		if (trail.length - start > this.trailPoints) start = trail.length - this.trailPoints
		if (start > 0) trail = trail.slice(start)
		return { value, heardAt, posAt, trail, trailFromCore: false }
	}
}
