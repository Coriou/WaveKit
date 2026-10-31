/**
 * Aircraft identity links: which identifiers name the same aircraft, how WaveKit knows, and for
 * how long the link holds. Served by GET /api/aircraft-identity/:kind/:value.
 *
 * Only an ICAO address or a registration ever resolves to an aircraft. A callsign or a flight
 * number names a flight, not an airframe, and is never used on its own to join two aircraft.
 */

/** The identifiers WaveKit links. */
export type AircraftIdentifierKind = "icao" | "reg" | "callsign" | "flight"

export interface AircraftIdentifier {
	kind: AircraftIdentifierKind
	/** Canonical value: ICAO upper-case hex, registration without dots, callsign trimmed. */
	value: string
}

/**
 * How a link is known:
 * - observed: one decoded frame carried both identifiers (a VDL2 frame from or to the aircraft
 *   with its registration, an ADS-B message with its callsign, an ACARS downlink with its
 *   registration and flight);
 * - database: an aircraft database says so (reserved; nothing produces it yet);
 * - hint: a resemblance only. Shown, never used to resolve.
 */
export type AircraftIdentityEvidence = "observed" | "database" | "hint"

/** Which decoder output gave the link. */
export type AircraftIdentitySource = "adsb" | "vdl2" | "acars" | "database"

export interface AircraftIdentityLink {
	a: AircraftIdentifier
	b: AircraftIdentifier
	evidence: AircraftIdentityEvidence
	source: AircraftIdentitySource
	/** ISO 8601. */
	firstSeen: string
	/** ISO 8601. */
	lastSeen: string
	/** ISO 8601: the link is forgotten after this unless seen again. */
	expiresAt: string
	/** Frames that carried this link. */
	count: number
}

export interface AircraftIdentityResponse {
	query: AircraftIdentifier
	/** The aircraft's ICAO address, or null when the query cannot be resolved safely. */
	icao: string | null
	/** How `icao` was found: the query itself, an observed link, a database link, or not at all. */
	resolvedBy: "self" | "observed" | "database" | null
	/** Two different aircraft claim the query (a registration linked to two ICAO addresses). */
	conflict: boolean
	/** Every live link around the query and the resolved aircraft, most recent first. */
	links: AircraftIdentityLink[]
	/**
	 * Activity entity keys of the aircraft (`icao:…`, `reg:…`), for reading its messages from
	 * GET /api/activity. Always holds the query's own key when it is an ICAO address or a
	 * registration, even when it did not resolve.
	 */
	entityKeys: string[]
	/** Unix time in ms. */
	timestamp: number
}
