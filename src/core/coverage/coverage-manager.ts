import { CoverageTracker } from "./coverage-tracker.js"
import type {
	AircraftState,
	CoverageProtocol,
	CoverageResponse,
	VesselState,
} from "@wavekit/api-types"

export interface AircraftEmitter {
	on(
		event: "aircraft:new" | "aircraft:update",
		l: (s: AircraftState) => void,
	): unknown
	on(
		event: "aircraft:lost",
		l: (icao: string, s: AircraftState) => void,
	): unknown
	off(
		event: "aircraft:new" | "aircraft:update",
		l: (s: AircraftState) => void,
	): unknown
	off(
		event: "aircraft:lost",
		l: (icao: string, s: AircraftState) => void,
	): unknown
}

export interface VesselEmitter {
	on(
		event: "vessel:new" | "vessel:update",
		l: (s: VesselState) => void,
	): unknown
	on(event: "vessel:lost", l: (mmsi: string, s: VesselState) => void): unknown
	off(
		event: "vessel:new" | "vessel:update",
		l: (s: VesselState) => void,
	): unknown
	off(event: "vessel:lost", l: (mmsi: string, s: VesselState) => void): unknown
}

export interface CoverageManagerOptions {
	station: { lat: number; lon: number } | null
	aircraft?: AircraftEmitter
	vessels?: VesselEmitter
	now?: () => number
}

/**
 * Feeds ADS-B and AIS positions into a CoverageTracker. The per-entity maps follow the trackers'
 * entities and are cleared on `:lost`: the aircraft maps are bounded by the aircraft tracker's
 * expiry (`maxAge`; it has no entity cap), the vessel map by the vessel tracker's `maxVessels`
 * cap and expiry. No extra cap is kept here.
 */
export class CoverageManager {
	private readonly tracker: CoverageTracker
	private readonly aircraft: AircraftEmitter | undefined
	private readonly vessels: VesselEmitter | undefined
	private readonly now: () => number
	private readonly lastAircraft = new Map<string, number>()
	private readonly lastVessel = new Map<string, number>()
	/**
	 * The tracker builds a fresh position object per position report and keeps it (and seenPos)
	 * across non-position messages while lastUpdated advances; identity tells the two apart.
	 */
	private readonly lastAircraftPos = new Map<
		string,
		AircraftState["position"]
	>()
	private started = false

	private readonly onAircraft = (s: AircraftState): void => {
		this.observeAircraft(s)
	}
	private readonly onAircraftLost = (icao: string): void => {
		this.lastAircraft.delete(icao)
		this.lastAircraftPos.delete(icao)
	}
	private readonly onVessel = (s: VesselState): void => {
		this.observeVessel(s)
	}
	private readonly onVesselLost = (mmsi: string): void => {
		this.lastVessel.delete(mmsi)
	}

	constructor(options: CoverageManagerOptions) {
		this.tracker = new CoverageTracker(options.station)
		this.aircraft = options.aircraft
		this.vessels = options.vessels
		this.now = options.now ?? Date.now
	}

	start(): void {
		if (this.started) return
		this.started = true
		this.aircraft?.on("aircraft:new", this.onAircraft)
		this.aircraft?.on("aircraft:update", this.onAircraft)
		this.aircraft?.on("aircraft:lost", this.onAircraftLost)
		this.vessels?.on("vessel:new", this.onVessel)
		this.vessels?.on("vessel:update", this.onVessel)
		this.vessels?.on("vessel:lost", this.onVesselLost)
	}

	stop(): void {
		if (!this.started) return
		this.started = false
		this.aircraft?.off("aircraft:new", this.onAircraft)
		this.aircraft?.off("aircraft:update", this.onAircraft)
		this.aircraft?.off("aircraft:lost", this.onAircraftLost)
		this.vessels?.off("vessel:new", this.onVessel)
		this.vessels?.off("vessel:update", this.onVessel)
		this.vessels?.off("vessel:lost", this.onVesselLost)
	}

	query(protocol?: CoverageProtocol): CoverageResponse {
		return this.tracker.query(this.now(), protocol)
	}

	observeAircraft(state: AircraftState): void {
		const pos = state.position
		if (!pos) return
		if (this.lastAircraftPos.get(state.icao) === pos) return
		this.lastAircraftPos.set(state.icao, pos)
		const at =
			state.seenPos !== undefined
				? state.lastUpdated - state.seenPos * 1000
				: state.lastUpdated
		this.observe("adsb", this.lastAircraft, state.icao, pos.lat, pos.lon, at)
	}

	observeVessel(state: VesselState): void {
		const pos = state.position
		if (!pos) return
		this.observe(
			"ais",
			this.lastVessel,
			state.mmsi,
			pos.lat,
			pos.lon,
			Date.parse(pos.at),
		)
	}

	private observe(
		protocol: CoverageProtocol,
		last: Map<string, number>,
		id: string,
		lat: number,
		lon: number,
		at: number,
	): void {
		if (!Number.isFinite(at)) return
		const prev = last.get(id)
		if (prev !== undefined && at <= prev) return
		last.set(id, at)
		try {
			this.tracker.observe(protocol, lat, lon, at, this.now())
		} catch {
			// listeners must never throw into the tracker's emit
		}
	}
}
