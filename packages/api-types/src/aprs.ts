/**
 * APRS station, object and item current state (WG2, docs/specs/web-gaps-2, requirements 3–4):
 * GET /api/aprs/stations, /api/aprs/stations/:key, /api/aprs/stats and the `aprs` WebSocket
 * channel. In-memory only; no position history.
 */

export type AprsEntityKind = "station" | "object" | "item"

export interface AprsPosition {
	lat: number
	lon: number
	/** ISO time of the report that carried the position. */
	at: string
}

/** Units as decoded by the direwolf adapter; a field is null when never reported. */
export interface AprsWeather {
	temperatureF: number | null
	humidityPct: number | null
	pressureMbar: number | null
	windSpeedMph: number | null
	windDirectionDeg: number | null
	rainLastHourIn: number | null
	/** ISO time of the report. */
	at: string
}

export interface AprsStation {
	/**
	 * Unique key, equal to the Activity entityKey: `callsign:<CALL[-SSID]>` (upper case, `-0`
	 * omitted), `aprs-object:<name>` or `aprs-item:<name>` (trailing spaces trimmed).
	 */
	key: string
	kind: AprsEntityKind
	/** Station: its callsign with SSID. Object or item: the station that last reported it. */
	callsign: string
	/** Object or item name; null for stations. */
	name: string | null
	/** Latest valid position; null until one is heard. */
	position: AprsPosition | null
	altitudeFt: number | null
	courseDeg: number | null
	/** Knots (APRS course/speed extension and Mic-E). */
	speedKn: number | null
	/** Two characters: symbol table and symbol code. */
	symbol: string | null
	comment: string | null
	/** Last status (`>`) text; stations only. */
	status: string | null
	weather: AprsWeather | null
	/** Digipeater path of the last unique packet. */
	path: string[]
	/** Data type of the last unique packet, as named by the adapter. */
	lastDataType: string
	/** True only in the `aprs:lost` data of a killed object or item. */
	killed: boolean
	/** Unique packets (digipeated copies excluded). */
	packetCount: number
	/** Copies of an already heard packet within 30 s. */
	digipeatedCopies: number
	/** Decoder instance that last reported the entity. */
	decoderId: string
	firstSeen: string
	lastSeen: string
}

export interface AprsTrackerStats {
	stationCount: number
	withPosition: number
	byKind: Record<AprsEntityKind, number>
	packetsProcessed: number
	duplicatesDropped: number
	invalidPackets: number
	/** Rolling 60 s average of unique packets. */
	packetsPerSecond: number
	/** ISO of the newest packet; null before any. */
	lastPacketAt: string | null
	/** Key of the entity heard most recently; null when empty. */
	latestKey: string | null
	/** Entities removed after maxAge (2 h) since start. */
	expiredTotal: number
	timestamp: string
}

/** GET /api/aprs/stations: most recently heard first. */
export interface AprsStationListResponse {
	stations: AprsStation[]
	stats: AprsTrackerStats
	timestamp: string
}

/** GET /api/aprs/stations/:key 404 body (a malformed key is a 400 with code VALIDATION_ERROR). */
export interface AprsStationNotFoundResponse {
	error: string
	code: "APRS_STATION_NOT_FOUND"
	key: string
}

/** `aprs:lost` data: the final state before expiry, eviction or a kill. */
export interface AprsLostEventData {
	key: string
	station: AprsStation
}

/** Server → client messages on the `aprs` channel. */
export type AprsServerMessage =
	| { type: "aprs:new"; channel: "aprs"; data: AprsStation }
	| { type: "aprs:update"; channel: "aprs"; data: AprsStation }
	| { type: "aprs:lost"; channel: "aprs"; data: AprsLostEventData }
	| { type: "aprs:stats"; channel: "aprs"; data: AprsTrackerStats }
