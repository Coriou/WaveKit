/**
 * `aircraft` channel publisher. The tracker emits an `aircraft:update` per decoded message (several
 * per aircraft per second on SBS) and each state carries the whole trail (up to 100 points, 7.3 KB
 * of JSON). Sent as is, 150 aircraft cost a client about 1.1 MB/s. This publisher:
 *
 * - throttles updates per aircraft to one per `windowMs` (1 s): the first goes at once, later ones
 *   inside the window coalesce to the latest state, sent when the window ends (EntityUpdateThrottle);
 * - a change of callsign, squawk or emergency is sent at once;
 * - `aircraft:lost` drops the pending update and carries the final state, so it is never lost;
 * - sends the trail as a delta: `trackAppend` with the points added since the previous update. The
 *   full `trackHistory` goes with `aircraft:new`, `aircraft:lost`, GET /api/aircraft, the first
 *   update of an aircraft this publisher has no record of, a trail that no longer contains the last
 *   point sent (reset, or more than a whole trail of new points), and every `resyncEvery` updates.
 *
 * The broadcaster serialises nothing when no client subscribes to `aircraft`; the bookkeeping here
 * still runs so a later subscriber, which loads GET /api/aircraft, gets deltas that follow it.
 */

import type {
	AircraftState,
	AircraftUpdateData,
	TrackPoint,
} from "@wavekit/api-types"
import { EntityUpdateThrottle } from "../../core/entity-update-throttle.js"

/** At most one `aircraft:update` per aircraft per second. */
export const AIRCRAFT_UPDATE_WINDOW_MS = 1000
/**
 * Full trail every 300 updates per aircraft: at ≤ 1 update/s that is at most once per 5 min, so a
 * 100-point trail (7.3 KB) adds ≤ 7,300 / 300 ≈ 24 B/s per aircraft, and any client that missed a
 * delta heals within 5 min. New records start at staggered points of the cycle, so aircraft that
 * appear together (a startup, a retune to 1090 MHz) do not all resync in the same second: 150 full
 * trails at once would be 1.1 MB, past a client's 1 MiB outbound cap.
 */
export const AIRCRAFT_TRAIL_RESYNC_UPDATES = 300
/**
 * Aircraft remembered (trail anchor and throttle slot). Mirrors EntityUpdateThrottle's default key
 * cap; a busy site sees a few hundred aircraft at once. Past it an aircraft is sent unthrottled with
 * its full trail, which is correct, only larger.
 */
export const AIRCRAFT_UPDATE_MAX_KEYS = 10_000

export interface AircraftUpdatePublisherOptions {
	publishNew: (state: AircraftState) => void
	publishUpdate: (data: AircraftUpdateData) => void
	publishLost: (icao: string, state: AircraftState) => void
	windowMs?: number
	resyncEvery?: number
	maxKeys?: number
	/** Clock of the throttle window. Default Date.now. */
	now?: () => number
}

interface TrailRecord {
	/** The newest point sent (tracker points are never mutated); null when no trail was sent. */
	anchor: TrackPoint | null
	/** Updates since the full trail was last sent. */
	sinceFull: number
}

const identity = (a: AircraftState): string =>
	JSON.stringify([a.callsign, a.squawk, a.emergency])

export class AircraftUpdatePublisher {
	private readonly options: AircraftUpdatePublisherOptions
	private readonly resyncEvery: number
	private readonly maxKeys: number
	private readonly throttle: EntityUpdateThrottle<AircraftState>
	private readonly trails = new Map<string, TrailRecord>()
	private stagger = 0

	constructor(options: AircraftUpdatePublisherOptions) {
		this.options = options
		this.resyncEvery = options.resyncEvery ?? AIRCRAFT_TRAIL_RESYNC_UPDATES
		this.maxKeys = options.maxKeys ?? AIRCRAFT_UPDATE_MAX_KEYS
		this.throttle = new EntityUpdateThrottle<AircraftState>({
			windowMs: options.windowMs ?? AIRCRAFT_UPDATE_WINDOW_MS,
			maxKeys: this.maxKeys,
			identity,
			emit: (key, state) => this.emitUpdate(key, state),
			...(options.now ? { now: options.now } : {}),
		})
	}

	/** Aircraft with a trail record. */
	size(): number {
		return this.trails.size
	}

	onNew(state: AircraftState): void {
		this.throttle.clear(state.icao)
		this.remember(state.icao, state.trackHistory?.[0] ?? null)
		this.options.publishNew(state)
	}

	onUpdate(state: AircraftState): void {
		this.throttle.offer(state.icao, state)
	}

	/** The pending update must not follow the lost message, which carries the final state. */
	onLost(icao: string, state: AircraftState): void {
		this.throttle.clear(icao)
		this.trails.delete(icao)
		this.options.publishLost(icao, state)
	}

	stop(): void {
		this.throttle.stop()
		this.trails.clear()
	}

	private emitUpdate(icao: string, state: AircraftState): void {
		const data: AircraftUpdateData = { ...state }
		delete data.trackHistory
		const history = state.trackHistory
		const newest = history?.[0]
		const record = this.trails.get(icao)
		if (history && newest) {
			const at =
				record?.anchor && record.sinceFull + 1 < this.resyncEvery
					? history.indexOf(record.anchor)
					: -1
			if (at < 0) {
				data.trackHistory = history
				this.remember(icao, newest)
			} else {
				if (at > 0) data.trackAppend = history.slice(0, at)
				if (record) {
					record.anchor = newest
					record.sinceFull += 1
				}
			}
		}
		this.options.publishUpdate(data)
	}

	private remember(icao: string, anchor: TrackPoint | null): void {
		const record = this.trails.get(icao)
		if (record) {
			record.anchor = anchor
			record.sinceFull = 0
		} else if (this.trails.size < this.maxKeys) {
			this.trails.set(icao, { anchor, sinceFull: this.stagger })
			this.stagger = (this.stagger + 1) % this.resyncEvery
		}
	}
}
