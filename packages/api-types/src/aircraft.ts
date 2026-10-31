/**
 * Aircraft Tracking Types for WaveKit ADS-B System
 *
 * This module defines comprehensive types for state-of-the-art aircraft tracking.
 * Used by the AircraftTracker service to maintain real-time aggregated state.
 *
 * @module @wavekit/api-types/aircraft
 */

// ============================================================================
// Position Types
// ============================================================================

/**
 * A single position point for track history.
 */
export interface TrackPoint {
	lat: number
	lon: number
	/** Altitude in feet, null if on ground */
	altitude: number | null
	/** Unix timestamp in milliseconds */
	timestamp: number
}

/**
 * Position data with integrity metrics.
 */
export interface AircraftPosition {
	lat: number
	lon: number
	/** Navigation Integrity Category (0-11, higher is better) */
	nic?: number
	/** Radius of Containment in meters (derived from NIC) */
	rc?: number
	/** Navigation Accuracy Category - Position */
	nacP?: number
	/** Seconds since position update */
	seenPos?: number
}

// ============================================================================
// Velocity Types
// ============================================================================

/**
 * Velocity data with multiple sources.
 */
export interface AircraftVelocity {
	/** Ground speed (knots) */
	gs?: number
	/** True airspeed (knots) */
	tas?: number
	/** Indicated airspeed (knots) */
	ias?: number
	/** Mach number */
	mach?: number
	/** Track over ground (degrees, 0-359) */
	track?: number
	/** Track rate of change (deg/sec, positive = right turn) */
	trackRate?: number
	/** Magnetic heading (degrees) */
	magHeading?: number
	/** True heading (degrees) */
	trueHeading?: number
	/** Roll angle (degrees, positive = right bank) */
	roll?: number
}

// ============================================================================
// Altitude Types
// ============================================================================

/**
 * Altitude data with multiple sources.
 */
export interface AircraftAltitude {
	/** Barometric altitude (feet), null if on ground */
	baro?: number | null
	/** Geometric/GNSS altitude (feet) - more accurate for relative measurements */
	geom?: number
	/** Barometric vertical rate (ft/min) */
	baroRate?: number
	/** Geometric vertical rate (ft/min) */
	geomRate?: number
	/** True if aircraft is on the ground */
	onGround?: boolean
}

// ============================================================================
// Navigation / Autopilot Types
// ============================================================================

/** Active navigation modes */
export type NavMode =
	| "autopilot"
	| "vnav"
	| "althold"
	| "approach"
	| "lnav"
	| "tcas"

/**
 * Navigation/autopilot state - shows pilot intent.
 */
export interface AircraftNavigation {
	/** QNH altimeter setting (hPa) */
	qnh?: number
	/** Selected altitude MCP/FCU (feet) */
	altitudeMcp?: number
	/** Selected altitude FMS (feet) */
	altitudeFms?: number
	/** Selected heading (degrees) */
	heading?: number
	/** Active navigation modes */
	modes?: NavMode[]
}

// ============================================================================
// Enrichment Types (from ICAO database)
// ============================================================================

/** Source of enrichment data */
export type EnrichmentSource =
	| "readsb"
	| "local"
	| "hexdb"
	| "opensky"
	| "adsbdb"
	| "planespotters"
	| "airport-data"

/** Airline flying a callsign (from the callsign's three-letter ICAO prefix). */
export interface AircraftAirline {
	/** Airline name (e.g., "WaveKit Air") */
	name: string
	/** ICAO airline designator (e.g., "EZY") */
	icao: string
	/** IATA airline designator (e.g., "U2") */
	iata?: string
	/** Radio telephony callsign (e.g., "EASY") */
	callsign?: string
	/** Airline's country */
	country?: string
	/** ISO 3166-1 alpha-2 code of the airline's country */
	countryIso?: string
	/** "local" (bundled OpenFlights table) or "adsbdb" */
	source: EnrichmentSource
}

/** An airport at one end of a flight route. */
export interface AircraftAirport {
	/** ICAO airport code (e.g., "LFPO") */
	icao: string
	/** IATA airport code (e.g., "ORY") */
	iata?: string
	/** Airport name */
	name: string
	/** City or municipality */
	city?: string
	/** Country name */
	country?: string
	/** ISO 3166-1 alpha-2 country code */
	countryIso?: string
	lat: number
	lon: number
}

/**
 * Scheduled route for a callsign. Crowd-sourced (adsbdb), so it can be stale or
 * wrong: clients present it as the planned route and may hide it when the track
 * disagrees.
 */
export interface AircraftRoute {
	/** Callsign the route was looked up for */
	callsign: string
	origin: AircraftAirport
	destination: AircraftAirport
	source: EnrichmentSource
}

/** One photo of the airframe. Clients must show the photographer and link back. */
export interface AircraftPhoto {
	/** Small thumbnail (about 200 px wide) */
	thumbnailUrl: string
	/** Larger thumbnail (about 420 px wide), when the source has one */
	largeUrl?: string
	/** Photographer credit */
	photographer?: string
	/** Page of the photo on the source's site */
	link?: string
	source: EnrichmentSource
}

/** Database flags (tar1090-db / readsb dbFlags). */
export interface AircraftFlags {
	military?: boolean
	interesting?: boolean
	/** Privacy ICAO Address (rotating anonymous address) */
	pia?: boolean
	/** Limiting Aircraft Data Displayed (owner asked not to be shown on public sites) */
	ladd?: boolean
}

/**
 * Aircraft identification from ICAO database enrichment.
 */
export interface AircraftIdentification {
	/** Aircraft registration (e.g., "N12345", "G-ABCD") */
	registration?: string
	/** ICAO type designator (e.g., "B738", "A320") */
	typeCode?: string
	/** Full aircraft type description (e.g., "Boeing 737-800") */
	typeDescription?: string
	/** Aircraft manufacturer (e.g., "Boeing", "Airbus") */
	manufacturer?: string
	/** Registered owner or operator name */
	operator?: string
	/** Operator ICAO code (e.g., "BAW", "UAL") */
	operatorCode?: string
	/** Country of registration (from the ICAO address block) */
	country?: string
	/** ISO 3166-1 alpha-2 code of the country of registration */
	countryIso?: string
	/** Year built, when the database knows it */
	year?: number
	/** Database flags (military, interesting, PIA, LADD) */
	flags?: AircraftFlags
	/** Airline flying the current callsign */
	airline?: AircraftAirline
	/** Planned route of the current callsign */
	route?: AircraftRoute
	/** Photo of the airframe */
	photo?: AircraftPhoto
	/**
	 * URL to an aircraft image (kept for older clients; equals photo.thumbnailUrl
	 * when a photo is known).
	 */
	imageUrl?: string
	/** Main data source of the identity fields */
	source?: EnrichmentSource
}

// ============================================================================
// Status & Quality Types
// ============================================================================

/** Emergency status codes */
export type EmergencyStatus =
	| "none"
	| "general" // General emergency
	| "lifeguard" // Medical emergency
	| "minfuel" // Minimum fuel
	| "nordo" // No radio
	| "unlawful" // Unlawful interference (hijack)
	| "downed" // Aircraft downed
	| "reserved"

/** Emitter category (aircraft type classification) */
export type EmitterCategory =
	// Category A: Aircraft
	| "A0"
	| "A1"
	| "A2"
	| "A3"
	| "A4"
	| "A5"
	| "A6"
	| "A7"
	// Category B: Non-aircraft
	| "B0"
	| "B1"
	| "B2"
	| "B3"
	| "B4"
	| "B5"
	| "B6"
	| "B7"
	// Category C: Surface vehicles
	| "C0"
	| "C1"
	| "C2"
	| "C3"
	// Category D: Reserved
	| "D0"
	| "D1"
	| "D2"
	| "D3"
	| "D4"
	| "D5"
	| "D6"
	| "D7"

/** ADS-B message source type */
export type MessageSourceType =
	| "adsb_icao" // Standard ADS-B with ICAO address
	| "adsb_icao_nt" // ADS-B with non-transponder
	| "adsr_icao" // Rebroadcast
	| "tisb_icao" // TIS-B with ICAO
	| "tisb_trackfile" // TIS-B from trackfile
	| "tisb_other" // Other TIS-B
	| "mlat" // Multilateration
	| "mode_s" // Mode-S only (no ADS-B)
	| "unknown"

/**
 * Signal quality and data reliability metrics.
 */
export interface SignalQuality {
	/** Received signal strength (dBFS, -50 to 0, higher is stronger) */
	rssi?: number
	/** Surveillance Integrity Level */
	sil?: number
	/** SIL type */
	silType?: "unknown" | "perhour" | "persample"
	/** Navigation Accuracy Category - Velocity */
	nacV?: number
	/** Geometric Vertical Accuracy */
	gva?: number
	/** System Design Assurance */
	sda?: number
	/** ADS-B version (0, 1, or 2) */
	adsbVersion?: number
}

// ============================================================================
// Complete Aircraft State
// ============================================================================

/**
 * Complete aircraft state - the core tracking object.
 * This is the aggregated state of an aircraft from all received messages.
 */
export interface AircraftState {
	// === Core Identity ===
	/** 24-bit ICAO address (hex, uppercase, e.g., "A12345") */
	icao: string
	/** Callsign/flight number (e.g., "UAL123") */
	callsign?: string
	/** Transponder squawk code (e.g., "1200", "7700") */
	squawk?: string
	/** Message source type */
	messageType?: MessageSourceType

	// === Structured State Data ===
	position?: AircraftPosition
	velocity?: AircraftVelocity
	altitude?: AircraftAltitude
	navigation?: AircraftNavigation
	identification?: AircraftIdentification
	signalQuality?: SignalQuality

	// === Status ===
	/** Emitter category (aircraft classification) */
	category?: EmitterCategory
	/** Emergency status */
	emergency?: EmergencyStatus

	// === Track History ===
	/** Position history for flight trail (most recent first) */
	trackHistory?: TrackPoint[]

	// === Timing & Statistics ===
	/** Seconds since last message of any type */
	seen: number
	/** Seconds since last position update (may differ from seen) */
	seenPos?: number
	/** Total messages received from this aircraft */
	messages: number
	/** First time this aircraft was seen (Unix ms) */
	firstSeen: number
	/** Last update timestamp (Unix ms) */
	lastUpdated: number
}

// ============================================================================
// Tracker Statistics
// ============================================================================

/**
 * Statistics for the aircraft tracker.
 */
export interface AircraftTrackerStats {
	/** Number of aircraft currently being tracked */
	aircraftCount: number
	/** Number of aircraft with position data */
	withPosition: number
	/** Number of aircraft with callsign */
	withCallsign: number
	/** Number of enriched aircraft (have registration data) */
	enrichedCount: number
	/** Total messages processed */
	messagesProcessed: number
	/** Messages per second (rolling average) */
	messagesPerSecond: number
	/** Enrichment cache stats */
	enrichmentCache: {
		hits: number
		misses: number
		size: number
	}
}

// ============================================================================
// WebSocket Event Types
// ============================================================================

/**
 * Aircraft update event - sent when any aircraft state changes.
 */
export interface AircraftUpdateEvent {
	type: "aircraft:update"
	data: AircraftState
}

/**
 * New aircraft event - sent when a new ICAO is first seen.
 */
export interface AircraftNewEvent {
	type: "aircraft:new"
	data: AircraftState
}

/**
 * Aircraft lost event - sent when aircraft track times out.
 */
export interface AircraftLostEvent {
	type: "aircraft:lost"
	data: {
		icao: string
		lastSeen: number
		totalMessages: number
		trackDuration: number // seconds
	}
}

/**
 * Tracker snapshot event - periodic full state broadcast.
 */
export interface AircraftSnapshotEvent {
	type: "aircraft:snapshot"
	data: {
		aircraft: AircraftState[]
		stats: AircraftTrackerStats
		timestamp: number
	}
}

/** Union type for all aircraft-related WebSocket events */
export type AircraftEvent =
	| AircraftUpdateEvent
	| AircraftNewEvent
	| AircraftLostEvent
	| AircraftSnapshotEvent

// ============================================================================
// Raw Message Types (for decoder output)
// ============================================================================

/**
 * Raw aircraft message from readsb JSON output.
 * Contains all possible fields from readsb aircraft.json format.
 * Used internally for parsing before aggregation.
 */
export interface RawAircraftMessage {
	// Core identity
	hex?: string
	type?: string
	flight?: string
	squawk?: string
	emergency?: string
	category?: string

	// Position
	lat?: number
	lon?: number
	seen_pos?: number
	nic?: number
	rc?: number
	nac_p?: number

	// Altitude
	alt_baro?: number | "ground"
	alt_geom?: number
	baro_rate?: number
	geom_rate?: number

	// Velocity
	gs?: number
	tas?: number
	ias?: number
	mach?: number
	track?: number
	track_rate?: number
	mag_heading?: number
	true_heading?: number
	roll?: number

	// Navigation
	nav_qnh?: number
	nav_altitude_mcp?: number
	nav_altitude_fms?: number
	nav_heading?: number
	nav_modes?: string[]

	// Enrichment (from readsb DB)
	r?: string
	t?: string
	desc?: string

	// Signal quality
	rssi?: number
	seen?: number
	messages?: number
	sil?: number
	sil_type?: string
	nac_v?: number
	gva?: number
	sda?: number
	version?: number
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Response for GET /api/aircraft endpoint.
 */
export interface AircraftListResponse {
	aircraft: AircraftState[]
	stats: AircraftTrackerStats
	timestamp: number
}

/**
 * Response for GET /api/aircraft/:icao endpoint when not found.
 */
export interface AircraftNotFoundResponse {
	error: string
	icao: string
}

// ============================================================================
// Aircraft info settings (GET/PUT /api/aircraft/info)
// ============================================================================

/** How the core enriches aircraft, and the switch the web app can flip. */
export interface AircraftInfoSettings {
	/** Enrichment runs at all. */
	enabled: boolean
	/** Free online sources are queried (adsbdb, hexdb, Planespotters). */
	online: boolean
	/** `config`: from aircraftInfo.online; `ui`: set with PUT and kept across restarts. */
	onlineFrom: "config" | "ui"
	/** Answers are cached on disk (stateDir and node:sqlite available). */
	persistent: boolean
	localDb: {
		enabled: boolean
		/** Airframes in the local database; null without a store. */
		aircraft: number | null
		/** ISO time of the last download; null before the first. */
		updatedAt: string | null
	}
}

/** PUT /api/aircraft/info body. */
export interface AircraftInfoUpdate {
	online: boolean
}
