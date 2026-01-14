/**
 * Aircraft Tracker - Real-time state aggregation for ADS-B tracking.
 *
 * This is an ADS-B-specific addon that does NOT affect other decoders.
 * It consumes events from the readsb decoder and maintains aggregated
 * aircraft state with position history, enrichment, and cleanup.
 *
 * @module src/core/aircraft-tracker
 */

import { EventEmitter } from "node:events"
import type { Logger } from "@wavekit/shared"
import type {
	AircraftState,
	AircraftTrackerStats,
	TrackPoint,
	AircraftIdentification,
	RawAircraftMessage,
	AircraftPosition,
	AircraftVelocity,
	AircraftAltitude,
	AircraftNavigation,
	SignalQuality,
	EmitterCategory,
	EmergencyStatus,
	MessageSourceType,
	NavMode,
} from "@wavekit/api-types"

// ============================================================================
// Configuration
// ============================================================================

export interface AircraftTrackerConfig {
	/** Maximum age before aircraft is removed (seconds, default: 60) */
	maxAge?: number
	/** Interval for cleanup sweep (ms, default: 5000) */
	cleanupInterval?: number
	/** Maximum track history points per aircraft (default: 100) */
	maxTrackPoints?: number
	/** Minimum distance between track points (meters, default: 50) */
	minTrackDistance?: number
	/** Interval for stats broadcast (ms, default: 5000) */
	statsBroadcastInterval?: number
}

const DEFAULT_CONFIG: Required<AircraftTrackerConfig> = {
	maxAge: 60,
	cleanupInterval: 5000,
	maxTrackPoints: 100,
	minTrackDistance: 50,
	statsBroadcastInterval: 5000,
}

// ============================================================================
// Events Interface
// ============================================================================

export interface AircraftTrackerEvents {
	"aircraft:new": [aircraft: AircraftState]
	"aircraft:update": [aircraft: AircraftState]
	"aircraft:lost": [icao: string, aircraft: AircraftState]
	"stats:update": [stats: AircraftTrackerStats]
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate distance between two points using Haversine formula.
 * Returns distance in meters.
 */
function haversineDistance(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const R = 6371000 // Earth radius in meters
	const φ1 = (lat1 * Math.PI) / 180
	const φ2 = (lat2 * Math.PI) / 180
	const Δφ = ((lat2 - lat1) * Math.PI) / 180
	const Δλ = ((lon2 - lon1) * Math.PI) / 180

	const a =
		Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
		Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

	return R * c
}

/**
 * Parse raw message type to our enum.
 */
function parseMessageType(type?: string): MessageSourceType | undefined {
	if (!type) return undefined
	const valid: MessageSourceType[] = [
		"adsb_icao",
		"adsb_icao_nt",
		"adsr_icao",
		"tisb_icao",
		"tisb_trackfile",
		"tisb_other",
		"mlat",
		"mode_s",
	]
	return valid.includes(type as MessageSourceType)
		? (type as MessageSourceType)
		: "unknown"
}

/**
 * Parse emergency status string to enum.
 */
function parseEmergency(emergency?: string): EmergencyStatus | undefined {
	if (!emergency) return undefined
	const valid: EmergencyStatus[] = [
		"none",
		"general",
		"lifeguard",
		"minfuel",
		"nordo",
		"unlawful",
		"downed",
		"reserved",
	]
	return valid.includes(emergency as EmergencyStatus)
		? (emergency as EmergencyStatus)
		: undefined
}

/**
 * Parse emitter category string.
 */
function parseCategory(category?: string): EmitterCategory | undefined {
	if (!category) return undefined
	// Category format is like "A0", "B2", etc.
	if (/^[A-D][0-7]$/.test(category)) {
		return category as EmitterCategory
	}
	return undefined
}

/**
 * Parse nav_modes array to typed array.
 */
function parseNavModes(modes?: string[]): NavMode[] | undefined {
	if (!modes || modes.length === 0) return undefined
	const validModes: NavMode[] = [
		"autopilot",
		"vnav",
		"althold",
		"approach",
		"lnav",
		"tcas",
	]
	return modes.filter(m => validModes.includes(m as NavMode)) as NavMode[]
}

// ============================================================================
// Cache Stats Provider Interface
// ============================================================================

/** Provider for enrichment cache statistics */
export interface EnrichmentCacheStatsProvider {
	getCacheStats(): { hits: number; misses: number; size: number }
}

// ============================================================================
// Aircraft Tracker Class
// ============================================================================

/**
 * AircraftTracker - State-of-the-art aircraft tracking and aggregation.
 *
 * Maintains a real-time view of all tracked aircraft by:
 * - Aggregating partial ADS-B messages into complete aircraft state
 * - Managing per-aircraft position history trails
 * - Handling track aging and cleanup
 *
 * Emits events for new aircraft, updates, and lost tracks.
 */
export class AircraftTracker extends EventEmitter<AircraftTrackerEvents> {
	private readonly aircraft: Map<string, AircraftState> = new Map()
	private cleanupTimer: NodeJS.Timeout | undefined
	private statsTimer: NodeJS.Timeout | undefined
	private readonly config: Required<AircraftTrackerConfig>
	private enrichmentCacheProvider: EnrichmentCacheStatsProvider | null = null

	private messagesProcessed = 0
	private lastMessageCountTime = Date.now()
	private lastMessageCount = 0

	constructor(
		config: AircraftTrackerConfig,
		private readonly logger: Logger,
	) {
		super()
		this.config = { ...DEFAULT_CONFIG, ...config }
	}

	/**
	 * Set the enrichment cache stats provider for accurate stats reporting.
	 */
	setEnrichmentCacheProvider(provider: EnrichmentCacheStatsProvider): void {
		this.enrichmentCacheProvider = provider
	}

	/**
	 * Start the tracker (begin cleanup and stats timers).
	 */
	start(): void {
		this.cleanupTimer = setInterval(
			() => this.cleanup(),
			this.config.cleanupInterval,
		)
		this.statsTimer = setInterval(
			() => this.broadcastStats(),
			this.config.statsBroadcastInterval,
		)
		this.logger.info(
			{
				maxAge: this.config.maxAge,
				cleanupInterval: this.config.cleanupInterval,
				maxTrackPoints: this.config.maxTrackPoints,
			},
			"Aircraft tracker started",
		)
	}

	/**
	 * Stop the tracker.
	 */
	stop(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer)
			this.cleanupTimer = undefined
		}
		if (this.statsTimer) {
			clearInterval(this.statsTimer)
			this.statsTimer = undefined
		}
		const count = this.aircraft.size
		this.aircraft.clear()
		this.logger.info({ aircraftCleared: count }, "Aircraft tracker stopped")
	}

	/**
	 * Process a raw aircraft update from the decoder.
	 * This is the main entry point for new ADS-B data.
	 */
	processUpdate(raw: RawAircraftMessage): void {
		const icao = raw.hex?.toUpperCase().replace(/^~/, "")
		if (!icao) return

		this.messagesProcessed++
		const now = Date.now()
		const existing = this.aircraft.get(icao)

		if (existing) {
			this.mergeUpdate(existing, raw, now)
			this.emit("aircraft:update", existing)
		} else {
			const newAircraft = this.createAircraft(icao, raw, now)
			this.aircraft.set(icao, newAircraft)
			this.emit("aircraft:new", newAircraft)
			this.logger.debug({ icao }, "New aircraft tracked")
		}
	}

	/**
	 * Get all tracked aircraft.
	 */
	getAll(): AircraftState[] {
		return Array.from(this.aircraft.values())
	}

	/**
	 * Get a specific aircraft by ICAO.
	 */
	get(icao: string): AircraftState | undefined {
		return this.aircraft.get(icao.toUpperCase())
	}

	/**
	 * Get current tracker statistics.
	 */
	getStats(): AircraftTrackerStats {
		return this.computeStats()
	}

	/**
	 * Get the number of tracked aircraft.
	 */
	get size(): number {
		return this.aircraft.size
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Create a new AircraftState from raw message.
	 */
	private createAircraft(
		icao: string,
		raw: RawAircraftMessage,
		now: number,
	): AircraftState {
		// Build base state with required properties only
		const state: AircraftState = {
			icao,
			seen: raw.seen ?? 0,
			messages: raw.messages ?? 1,
			firstSeen: now,
			lastUpdated: now,
		}

		// Add optional core identity fields only if present
		const callsign = raw.flight?.trim()
		if (callsign) state.callsign = callsign
		if (raw.squawk) state.squawk = raw.squawk
		if (raw.type) {
			const msgType = parseMessageType(raw.type)
			if (msgType) state.messageType = msgType
		}
		if (raw.category) {
			const category = parseCategory(raw.category)
			if (category) state.category = category
		}
		if (raw.emergency) {
			const emergency = parseEmergency(raw.emergency)
			if (emergency) state.emergency = emergency
		}
		if (raw.seen_pos !== undefined) state.seenPos = raw.seen_pos

		// Position
		if (raw.lat !== undefined && raw.lon !== undefined) {
			state.position = this.buildPosition(raw)
			state.trackHistory = [
				{
					lat: raw.lat,
					lon: raw.lon,
					altitude: this.getAltitudeValue(raw),
					timestamp: now,
				},
			]
		}

		// Velocity
		const velocity = this.buildVelocity(raw)
		if (Object.keys(velocity).length > 0) {
			state.velocity = velocity
		}

		// Altitude
		const altitude = this.buildAltitude(raw)
		if (Object.keys(altitude).length > 0) {
			state.altitude = altitude
		}

		// Navigation
		const navigation = this.buildNavigation(raw)
		if (Object.keys(navigation).length > 0) {
			state.navigation = navigation
		}

		// Identification (from readsb db)
		const identification = this.buildIdentification(raw)
		if (Object.keys(identification).length > 0) {
			state.identification = identification
		}

		// Signal quality
		const signalQuality = this.buildSignalQuality(raw)
		if (Object.keys(signalQuality).length > 0) {
			state.signalQuality = signalQuality
		}

		return state
	}

	/**
	 * Merge a raw message update into existing aircraft state.
	 */
	private mergeUpdate(
		state: AircraftState,
		raw: RawAircraftMessage,
		now: number,
	): void {
		// Update core fields
		if (raw.flight?.trim()) state.callsign = raw.flight.trim()
		if (raw.squawk) state.squawk = raw.squawk
		if (raw.type) {
			const msgType = parseMessageType(raw.type)
			if (msgType) state.messageType = msgType
		}
		if (raw.category) {
			const category = parseCategory(raw.category)
			if (category) state.category = category
		}
		if (raw.emergency) {
			const emergency = parseEmergency(raw.emergency)
			if (emergency) state.emergency = emergency
		}

		// Update timing
		state.seen = raw.seen ?? 0
		if (raw.seen_pos !== undefined) state.seenPos = raw.seen_pos
		state.messages = raw.messages ?? state.messages + 1
		state.lastUpdated = now

		// Update position and track history
		if (raw.lat !== undefined && raw.lon !== undefined) {
			const newPosition = this.buildPosition(raw)

			// Add to track history if moved enough
			if (this.shouldAddTrackPoint(state, raw.lat, raw.lon, now)) {
				const point: TrackPoint = {
					lat: raw.lat,
					lon: raw.lon,
					altitude: this.getAltitudeValue(raw),
					timestamp: now,
				}

				if (!state.trackHistory) {
					state.trackHistory = []
				}
				state.trackHistory.unshift(point)

				// Trim to max points
				if (state.trackHistory.length > this.config.maxTrackPoints) {
					state.trackHistory.length = this.config.maxTrackPoints
				}
			}

			state.position = newPosition
		}

		// Merge other sections (only update defined fields)
		this.mergeVelocity(state, raw)
		this.mergeAltitude(state, raw)
		this.mergeNavigation(state, raw)
		this.mergeIdentification(state, raw)
		this.mergeSignalQuality(state, raw)
	}

	/**
	 * Determine if a new track point should be added based on distance.
	 */
	private shouldAddTrackPoint(
		state: AircraftState,
		newLat: number,
		newLon: number,
		_now: number,
	): boolean {
		if (!state.trackHistory || state.trackHistory.length === 0) {
			return true
		}

		const last = state.trackHistory[0]
		if (!last) return true
		const distance = haversineDistance(last.lat, last.lon, newLat, newLon)
		return distance >= this.config.minTrackDistance
	}

	/**
	 * Get altitude value from raw message (null if on ground).
	 */
	private getAltitudeValue(raw: RawAircraftMessage): number | null {
		if (raw.alt_baro === "ground") return null
		return raw.alt_baro ?? raw.alt_geom ?? null
	}

	// ========================================================================
	// Builder Methods
	// ========================================================================

	private buildPosition(raw: RawAircraftMessage): AircraftPosition {
		const pos: AircraftPosition = {
			lat: raw.lat!,
			lon: raw.lon!,
		}
		if (raw.nic !== undefined) pos.nic = raw.nic
		if (raw.rc !== undefined) pos.rc = raw.rc
		if (raw.nac_p !== undefined) pos.nacP = raw.nac_p
		if (raw.seen_pos !== undefined) pos.seenPos = raw.seen_pos
		return pos
	}

	private buildVelocity(raw: RawAircraftMessage): Partial<AircraftVelocity> {
		const v: Partial<AircraftVelocity> = {}
		if (raw.gs !== undefined) v.gs = raw.gs
		if (raw.tas !== undefined) v.tas = raw.tas
		if (raw.ias !== undefined) v.ias = raw.ias
		if (raw.mach !== undefined) v.mach = raw.mach
		if (raw.track !== undefined) v.track = raw.track
		if (raw.track_rate !== undefined) v.trackRate = raw.track_rate
		if (raw.mag_heading !== undefined) v.magHeading = raw.mag_heading
		if (raw.true_heading !== undefined) v.trueHeading = raw.true_heading
		if (raw.roll !== undefined) v.roll = raw.roll
		return v
	}

	private buildAltitude(raw: RawAircraftMessage): Partial<AircraftAltitude> {
		const a: Partial<AircraftAltitude> = {}
		if (raw.alt_baro === "ground") {
			a.baro = null
			a.onGround = true
		} else if (raw.alt_baro !== undefined) {
			a.baro = raw.alt_baro
			a.onGround = false
		}
		if (raw.alt_geom !== undefined) a.geom = raw.alt_geom
		if (raw.baro_rate !== undefined) a.baroRate = raw.baro_rate
		if (raw.geom_rate !== undefined) a.geomRate = raw.geom_rate
		return a
	}

	private buildNavigation(
		raw: RawAircraftMessage,
	): Partial<AircraftNavigation> {
		const n: Partial<AircraftNavigation> = {}
		if (raw.nav_qnh !== undefined) n.qnh = raw.nav_qnh
		if (raw.nav_altitude_mcp !== undefined) n.altitudeMcp = raw.nav_altitude_mcp
		if (raw.nav_altitude_fms !== undefined) n.altitudeFms = raw.nav_altitude_fms
		if (raw.nav_heading !== undefined) n.heading = raw.nav_heading
		const modes = parseNavModes(raw.nav_modes)
		if (modes && modes.length > 0) n.modes = modes
		return n
	}

	private buildIdentification(
		raw: RawAircraftMessage,
	): Partial<AircraftIdentification> {
		const i: Partial<AircraftIdentification> = {}
		if (raw.r) i.registration = raw.r
		if (raw.t) i.typeCode = raw.t
		if (raw.desc) i.typeDescription = raw.desc
		if (i.registration || i.typeCode) i.source = "readsb"
		return i
	}

	private buildSignalQuality(raw: RawAircraftMessage): Partial<SignalQuality> {
		const s: Partial<SignalQuality> = {}
		if (raw.rssi !== undefined) s.rssi = raw.rssi
		if (raw.sil !== undefined) s.sil = raw.sil
		if (raw.sil_type) {
			s.silType = raw.sil_type as "unknown" | "perhour" | "persample"
		}
		if (raw.nac_v !== undefined) s.nacV = raw.nac_v
		if (raw.gva !== undefined) s.gva = raw.gva
		if (raw.sda !== undefined) s.sda = raw.sda
		if (raw.version !== undefined) s.adsbVersion = raw.version
		return s
	}

	// ========================================================================
	// Merge Methods
	// ========================================================================

	private mergeVelocity(state: AircraftState, raw: RawAircraftMessage): void {
		const updates = this.buildVelocity(raw)
		if (Object.keys(updates).length > 0) {
			state.velocity = { ...state.velocity, ...updates }
		}
	}

	private mergeAltitude(state: AircraftState, raw: RawAircraftMessage): void {
		const updates = this.buildAltitude(raw)
		if (Object.keys(updates).length > 0) {
			state.altitude = { ...state.altitude, ...updates }
		}
	}

	private mergeNavigation(state: AircraftState, raw: RawAircraftMessage): void {
		const updates = this.buildNavigation(raw)
		if (Object.keys(updates).length > 0) {
			state.navigation = { ...state.navigation, ...updates }
		}
	}

	private mergeIdentification(
		state: AircraftState,
		raw: RawAircraftMessage,
	): void {
		const updates = this.buildIdentification(raw)
		if (Object.keys(updates).length > 0) {
			state.identification = { ...state.identification, ...updates }
		}
	}

	private mergeSignalQuality(
		state: AircraftState,
		raw: RawAircraftMessage,
	): void {
		const updates = this.buildSignalQuality(raw)
		if (Object.keys(updates).length > 0) {
			state.signalQuality = { ...state.signalQuality, ...updates }
		}
	}

	// ========================================================================
	// Cleanup & Stats
	// ========================================================================

	/**
	 * Remove stale aircraft that haven't been seen recently.
	 */
	private cleanup(): void {
		const now = Date.now()
		const maxAgeMs = this.config.maxAge * 1000
		const toRemove: string[] = []

		for (const [icao, state] of this.aircraft) {
			const age = now - state.lastUpdated
			if (age > maxAgeMs) {
				toRemove.push(icao)
			}
		}

		for (const icao of toRemove) {
			const state = this.aircraft.get(icao)
			if (state) {
				this.aircraft.delete(icao)
				this.emit("aircraft:lost", icao, state)
				this.logger.debug(
					{ icao, messages: state.messages },
					"Aircraft track lost",
				)
			}
		}

		if (toRemove.length > 0) {
			this.logger.debug(
				{ removed: toRemove.length, remaining: this.aircraft.size },
				"Aircraft cleanup completed",
			)
		}
	}

	/**
	 * Compute current statistics.
	 */
	private computeStats(): AircraftTrackerStats {
		let withPosition = 0
		let withCallsign = 0
		let enrichedCount = 0

		for (const state of this.aircraft.values()) {
			if (state.position) withPosition++
			if (state.callsign) withCallsign++
			if (state.identification?.registration) enrichedCount++
		}

		// Calculate messages per second
		const now = Date.now()
		const elapsed = (now - this.lastMessageCountTime) / 1000
		const messagesDelta = this.messagesProcessed - this.lastMessageCount
		const messagesPerSecond = elapsed > 0 ? messagesDelta / elapsed : 0

		// Get enrichment cache stats if provider is available
		const cacheStats = this.enrichmentCacheProvider?.getCacheStats() ?? {
			hits: 0,
			misses: 0,
			size: 0,
		}

		return {
			aircraftCount: this.aircraft.size,
			withPosition,
			withCallsign,
			enrichedCount,
			messagesProcessed: this.messagesProcessed,
			messagesPerSecond: Math.round(messagesPerSecond * 10) / 10,
			enrichmentCache: cacheStats,
		}
	}

	/**
	 * Broadcast current statistics.
	 */
	private broadcastStats(): void {
		const stats = this.computeStats()

		// Update rate tracking
		this.lastMessageCount = this.messagesProcessed
		this.lastMessageCountTime = Date.now()

		this.emit("stats:update", stats)
	}
}
