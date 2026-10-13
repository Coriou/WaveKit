/**
 * Meshtastic node current state (WG2, docs/specs/web-gaps-2, requirements 5–6):
 * GET /api/mesh/nodes, /api/mesh/nodes/:nodeId, /api/mesh/stats and the `mesh` WebSocket
 * channel. In-memory only; no position history, telemetry or links.
 */

export interface MeshPosition {
	lat: number
	lon: number
	/** Metres, as reported; null when absent. */
	altitudeM: number | null
	/** ISO time the packet was received. */
	at: string
}

export interface MeshNode {
	/** `!` plus 8 lowercase hex digits of the node number. */
	nodeId: string
	/** `node:<nodeId>`, equal to the Activity entityKey. */
	key: string
	/** Node number (uint32). */
	nodeNum: number
	/** From NODEINFO (port 4); null until received. */
	longName: string | null
	shortName: string | null
	/** Meshtastic HardwareModel enum value. */
	hwModel: number | null
	/** Meshtastic Config.DeviceConfig.Role enum value. */
	role: number | null
	isLicensed: boolean | null
	/** Latest valid POSITION (port 3); null until received. */
	position: MeshPosition | null
	/** Of the last unique packet; null when the wrapper reported 0. */
	snrDb: number | null
	rssiDbm: number | null
	/** hopStart − hopLimit of the last unique packet; null when unknown. */
	hopsAway: number | null
	/** The last unique packet came through MQTT. */
	viaMqtt: boolean
	/** Unique packets (flood copies excluded). */
	packetCount: number
	/** Copies of an already heard (from, id) packet within 60 s. */
	duplicateCopies: number
	/** Unique packets per portnum (decimal string keys), at most 64 keys. */
	portnums: Record<string, number>
	lastPortnum: number
	/** Decoder instance that last reported the node. */
	decoderId: string
	firstSeen: string
	lastSeen: string
	/** Last NODEINFO; null if none. */
	lastNodeInfoAt: string | null
}

export interface MeshTrackerStats {
	nodeCount: number
	withPosition: number
	withName: number
	packetsProcessed: number
	duplicatesDropped: number
	invalidPackets: number
	/** Payloads of a known port that did not decode. */
	decodeErrors: number
	/** Rolling 60 s average of unique packets. */
	packetsPerSecond: number
	lastPacketAt: string | null
	latestNodeId: string | null
	/** Nodes removed after maxAge (4 h) since start. */
	expiredTotal: number
	timestamp: string
}

/** GET /api/mesh/nodes: most recently heard first. */
export interface MeshNodeListResponse {
	nodes: MeshNode[]
	stats: MeshTrackerStats
	timestamp: string
}

/** GET /api/mesh/nodes/:nodeId 404 body (a malformed id is a 400 with code VALIDATION_ERROR). */
export interface MeshNodeNotFoundResponse {
	error: string
	code: "MESH_NODE_NOT_FOUND"
	nodeId: string
}

/** `mesh:lost` data: the final state before expiry or eviction. */
export interface MeshLostEventData {
	nodeId: string
	node: MeshNode
}

/** Server → client messages on the `mesh` channel. */
export type MeshServerMessage =
	| { type: "mesh:new"; channel: "mesh"; data: MeshNode }
	| { type: "mesh:update"; channel: "mesh"; data: MeshNode }
	| { type: "mesh:lost"; channel: "mesh"; data: MeshLostEventData }
	| { type: "mesh:stats"; channel: "mesh"; data: MeshTrackerStats }
