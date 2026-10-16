/**
 * Meshtastic node current state (WG2, docs/specs/web-gaps-2, requirements 5–6):
 * GET /api/mesh/nodes, /api/mesh/nodes/:nodeId, /api/mesh/stats and the `mesh` WebSocket
 * channel. In-memory only; no position history. WG3 (docs/specs/web-gaps-3, requirement 8)
 * adds optional device telemetry (TELEMETRY_APP 67) and neighbour links (NEIGHBORINFO_APP 71).
 */

export interface MeshPosition {
	lat: number
	lon: number
	/** Metres, as reported; null when absent. */
	altitudeM: number | null
	/** ISO time the packet was received. */
	at: string
	/**
	 * WG4: ISO of the sender's GPS fix time (`Position.time`) when it lies between 7 days before
	 * and 60 s after `at`; null otherwise. Absent on older cores.
	 */
	fixAt?: string | null
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
	/** WG3: latest device metrics the node reported about itself; absent on older cores. */
	telemetry?: MeshDeviceTelemetry | null
	/**
	 * WG3: neighbours from the node's latest NEIGHBORINFO report, at most 32, by nodeId
	 * ascending; entries older than the node expiry (4 h) are dropped. Absent on older cores.
	 */
	neighbours?: MeshNeighbour[]
}

/** WG3: Telemetry.device_metrics (TELEMETRY_APP, port 67). Every metric is null when absent. */
export interface MeshDeviceTelemetry {
	/** 0-100 percent; null when absent or when the node reports external power. */
	batteryPct: number | null
	/** True when battery_level was above 100 (Meshtastic's "powered" convention). */
	powered: boolean | null
	voltageV: number | null
	/** Percent of airtime the node hears as busy. */
	channelUtilizationPct: number | null
	/** Percent of airtime the node transmitted in the last hour. */
	airUtilTxPct: number | null
	uptimeS: number | null
	/** ISO time the telemetry packet was received. */
	at: string
}

/** WG3: one NeighborInfo.neighbors entry (NEIGHBORINFO_APP, port 71). */
export interface MeshNeighbour {
	/** `!` plus 8 lowercase hex digits; may be a node the tracker has not heard itself. */
	nodeId: string
	/** SNR at which the reporting node last heard this neighbour; null when absent. */
	snrDb: number | null
	/** ISO time of the report that carried this entry. */
	at: string
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
	/** WG3: unique TELEMETRY_APP packets with device metrics applied. Absent on older cores. */
	telemetryPackets?: number
	/** WG3: unique NEIGHBORINFO_APP reports applied. Absent on older cores. */
	neighbourReports?: number
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
