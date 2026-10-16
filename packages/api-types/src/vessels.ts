/**
 * AIS vessel current state (WG1, docs/specs/web-gaps-1): GET /api/vessels, /api/vessels/stats,
 * /api/vessels/:mmsi and the `vessels` WebSocket channel. In-memory only; no position history.
 */

/** From the message types seen: A (1–3, 5), B (18, 19, 24), base station (4, 11), aid to navigation (21), SAR aircraft (9). */
export type VesselClass =
	| "A"
	| "B"
	| "base-station"
	| "aton"
	| "sar"
	| "unknown"

export interface VesselPosition {
	lat: number
	lon: number
	/** ISO time the position was received. */
	at: string
}

/** WG5 (web-gaps-5 req 5.5): aid-to-navigation fields from the newest type 21 report. */
export interface VesselAton {
	/** ITU-R M.1371 aid type 0–31; null when the report lacked it. */
	aidType: number | null
	/** Virtual aid (no physical aid at the position). */
	virtual: boolean | null
	/** Off position; null when the report's UTC second was not available. */
	offPosition: boolean | null
}

export interface VesselState {
	/** 9 digits, zero-padded. */
	mmsi: string
	vesselClass: VesselClass
	/** Static and voyage data; null until received (trimmed, AIS "@" padding removed). */
	name: string | null
	callsign: string | null
	imo: number | null
	/** ITU-R M.1371 ship type code 1–99. */
	shipType: number | null
	destination: string | null
	/** ISO; null when absent or invalid. */
	eta: string | null
	/** Metres. */
	draught: number | null
	/** Latest valid position (lat ±90, lon ±180; the 91 / 181 "not available" values are ignored). */
	position: VesselPosition | null
	/** Degrees 0–359.9; null for 360 (not available). */
	cog: number | null
	/** Knots; null for 102.3 (not available). */
	sog: number | null
	/** Degrees 0–359; null for 511 (not available). */
	heading: number | null
	/** Navigation status code 0–14; null for 15 (not defined) or absent. */
	navStatus: number | null
	/** Distinct AIS message types seen, ascending. */
	messageTypes: number[]
	messageCount: number
	/** Decoder instance that last reported the vessel. */
	decoderId: string
	firstSeen: string
	lastSeen: string
	/** Last static or voyage message (5, 19, 24, 21 with a name); null if none. */
	lastStaticAt: string | null
	/**
	 * WG5: radio channel of the newest message that carried one; null before any.
	 * Optional for older producers; WG5 trackers always set it.
	 */
	channel?: "A" | "B" | null
	/** WG5: set only for class `aton`, from the newest type 21; null otherwise. */
	aton?: VesselAton | null
	/** WG5: SAR aircraft altitude in metres (type 9; 4094 means 4094 or higher); null otherwise. */
	altitudeM?: number | null
}

export interface VesselTrackerStats {
	vesselCount: number
	withPosition: number
	withName: number
	byClass: Record<VesselClass, number>
	messagesProcessed: number
	/** Rolling 60 s average. */
	messagesPerSecond: number
	/** ISO of the newest message; null before any. */
	lastMessageAt: string | null
	/** MMSI of the vessel heard most recently; null when empty. */
	latestMmsi: string | null
	/** Vessels removed after maxAge since start. */
	expiredTotal: number
	timestamp: string
}

/** GET /api/vessels: most recently heard first. */
export interface VesselListResponse {
	vessels: VesselState[]
	stats: VesselTrackerStats
	timestamp: string
}

/** GET /api/vessels/:mmsi 404 body (a malformed MMSI is a 400 with code VALIDATION_ERROR). */
export interface VesselNotFoundResponse {
	/** Human-readable message. */
	error: string
	code: "VESSEL_NOT_FOUND"
	mmsi: string
}

/** `vessel:lost` data: the final state before expiry. */
export interface VesselLostEventData {
	mmsi: string
	vessel: VesselState
}

/** Server → client messages on the `vessels` channel. */
export type VesselServerMessage =
	| { type: "vessel:new"; channel: "vessels"; data: VesselState }
	| { type: "vessel:update"; channel: "vessels"; data: VesselState }
	| { type: "vessel:lost"; channel: "vessels"; data: VesselLostEventData }
	| { type: "vessel:stats"; channel: "vessels"; data: VesselTrackerStats }
