/**
 * Meshtastic node current-state tracker (WG2 req 5).
 *
 * In-memory only. One node per `from` (`!` + 8 lowercase hex). The broadcast
 * address 0xffffffff is never a node, and `to` never creates one. A flood copy
 * of the same `(from, id)` within 60 s either side of the latest copy bumps
 * `duplicateCopies` and nothing else. The remembered time stays at the latest.
 */

import { EventEmitter } from "node:events"
import type { Logger } from "@wavekit/shared"
import { z } from "zod"
import type {
	MeshNode,
	MeshPosition,
	MeshTrackerStats,
} from "@wavekit/api-types"
import { createComponentLogger } from "../utils/logger.js"
import {
	readPosition,
	readUser,
	type MeshUserFields,
} from "./meshtastic-protobuf.js"

export interface MeshTrackerConfig {
	/** Drop a node not heard for this long. Default 4 h. */
	maxAgeMs?: number
	/** Hard cap. Default 1_000. Least recently heard is evicted. */
	maxNodes?: number
	/** Flood-copy window for `(from, id)`. Default 60 s. */
	duplicateWindowMs?: number
	/** How many `(from, id)` keys to remember. Default 4_096. Oldest dropped. */
	maxDuplicateKeys?: number
	/** How often the expiry sweep runs. Default 30 s. */
	cleanupIntervalMs?: number
	/** How often `stats:update` is emitted while running. Default 5 s. */
	statsIntervalMs?: number
	/**
	 * Clock for sweeps, the rate window and the default packet time.
	 * Dedupe and `lastSeen` use the packet's own `at` when it is valid.
	 * Not a YAML key.
	 */
	now?: () => number
}

export interface MeshTrackerEvents {
	"mesh:new": [node: MeshNode]
	"mesh:update": [node: MeshNode]
	"mesh:lost": [nodeId: string, node: MeshNode]
	"stats:update": [stats: MeshTrackerStats]
}

const DEFAULTS = {
	maxAgeMs: 14_400_000,
	maxNodes: 1_000,
	duplicateWindowMs: 60_000,
	maxDuplicateKeys: 4_096,
	cleanupIntervalMs: 30_000,
	statsIntervalMs: 5_000,
} as const

const RATE_WINDOW_MS = 60_000
const BROADCAST = 0xffffffff
const PORT_POSITION = 3
const PORT_NODEINFO = 4
const MAX_PAYLOAD_BYTES = 512
/** Base64 of 512 bytes is 684 characters. Longer strings are rejected unread. */
const MAX_PAYLOAD_B64 = 684
/**
 * `portnums` holds at most 64 keys (req 5.7). The first 63 distinct portnums
 * keep their own decimal key; every later new portnum increments "other".
 */
const MAX_SPECIFIC_PORTNUMS = 63

const NODE_ID_RE = /^![0-9a-fA-F]{8}$/

const uint32 = z.number().int().nonnegative().max(0xffffffff)

const packetSchema = z.object({
	from: uint32,
	to: uint32,
	id: uint32,
	hopLimit: uint32,
	hopStart: uint32,
	portnum: uint32,
	payloadB64: z.string().max(MAX_PAYLOAD_B64),
	rxRssi: z.number().finite(),
	rxSnr: z.number().finite(),
	viaMqtt: z.boolean().optional(),
})

type Packet = z.infer<typeof packetSchema>

/** `!` plus 8 lowercase hex digits of the uint32 node number. */
export function formatNodeId(nodeNum: number): string {
	return "!" + (nodeNum >>> 0).toString(16).padStart(8, "0")
}

/** `!` + 8 hex digits, case-insensitive. Anything else is null. */
export function canonicalNodeId(value: string): string | null {
	if (!NODE_ID_RE.test(value)) return null
	return value.toLowerCase()
}

function duplicateKey(from: number, id: number): string {
	return `${from}:${id}`
}

function decodePayload(payloadB64: string): Uint8Array | null {
	if (payloadB64.length > MAX_PAYLOAD_B64) return null
	if (payloadB64.length === 0) return new Uint8Array()
	if (payloadB64.length % 4 !== 0) return null
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payloadB64)) return null
	const buf = Buffer.from(payloadB64, "base64")
	if (buf.length > MAX_PAYLOAD_BYTES) return null
	if (buf.toString("base64") !== payloadB64) return null
	return new Uint8Array(buf)
}

function hopsAway(hopStart: number, hopLimit: number): number | null {
	if (hopStart > 0 && hopStart >= hopLimit) return hopStart - hopLimit
	return null
}

function radioLevel(value: number): number | null {
	return value === 0 ? null : value
}

function userIdMatches(userId: string, nodeId: string): boolean {
	return userId.toLowerCase() === nodeId
}

/** Ignore out-of-range coordinates and the exact (0, 0) default. */
function carriedPosition(
	lat: number,
	lon: number,
	altitudeM: number | null,
	at: string,
): MeshPosition | null {
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
	if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
	if (lat === 0 && lon === 0) return null
	return { lat, lon, altitudeM, at }
}

function bumpPortnum(portnums: Record<string, number>, portnum: number): void {
	const key = String(portnum)
	const existing = portnums[key]
	if (existing !== undefined) {
		portnums[key] = existing + 1
		return
	}
	let specific = 0
	for (const name of Object.keys(portnums)) {
		if (name !== "other") specific += 1
	}
	if (specific < MAX_SPECIFIC_PORTNUMS) {
		portnums[key] = 1
		return
	}
	portnums["other"] = (portnums["other"] ?? 0) + 1
}

export class MeshTracker extends EventEmitter<MeshTrackerEvents> {
	private readonly log: Logger
	private readonly nodes = new Map<string, MeshNode>()
	/** Process order, used to break lastSeen ties for latestNodeId. */
	private readonly order = new Map<string, number>()
	private nextOrder = 0
	/** `(from, id)` -> packet time of the latest copy inside the window. */
	private readonly duplicates = new Map<string, number>()
	private readonly limits: {
		maxAgeMs: number
		maxNodes: number
		duplicateWindowMs: number
		maxDuplicateKeys: number
		cleanupIntervalMs: number
		statsIntervalMs: number
	}
	private readonly now: () => number
	private cleanupTimer: ReturnType<typeof setInterval> | undefined
	private statsTimer: ReturnType<typeof setInterval> | undefined
	private packetsProcessed = 0
	private duplicatesDropped = 0
	private invalidPackets = 0
	private decodeErrors = 0
	private readonly uniqueMarks: number[] = []
	private lastPacketAtMs: number | null = null
	private expiredTotal = 0

	constructor(config: MeshTrackerConfig = {}, logger: Logger) {
		super()
		this.log = createComponentLogger(logger, "MeshTracker")
		this.now = config.now ?? Date.now
		this.limits = {
			maxAgeMs: config.maxAgeMs ?? DEFAULTS.maxAgeMs,
			maxNodes: config.maxNodes ?? DEFAULTS.maxNodes,
			duplicateWindowMs: config.duplicateWindowMs ?? DEFAULTS.duplicateWindowMs,
			maxDuplicateKeys: config.maxDuplicateKeys ?? DEFAULTS.maxDuplicateKeys,
			cleanupIntervalMs: config.cleanupIntervalMs ?? DEFAULTS.cleanupIntervalMs,
			statsIntervalMs: config.statsIntervalMs ?? DEFAULTS.statsIntervalMs,
		}
	}

	/** Start the expiry sweep and the stats timer. Idempotent. Timers are unref'd. */
	start(): void {
		if (this.cleanupTimer || this.statsTimer) return
		this.cleanupTimer = setInterval(() => {
			this.sweep()
		}, this.limits.cleanupIntervalMs)
		this.cleanupTimer.unref()
		this.statsTimer = setInterval(() => {
			this.emit("stats:update", this.getStats())
		}, this.limits.statsIntervalMs)
		this.statsTimer.unref()
		this.log.info(
			{
				maxAgeMs: this.limits.maxAgeMs,
				maxNodes: this.limits.maxNodes,
				duplicateWindowMs: this.limits.duplicateWindowMs,
				maxDuplicateKeys: this.limits.maxDuplicateKeys,
				cleanupIntervalMs: this.limits.cleanupIntervalMs,
				statsIntervalMs: this.limits.statsIntervalMs,
			},
			"Mesh tracker started",
		)
	}

	/** Stop the timers. Idempotent. Current nodes are kept. */
	stop(): void {
		if (!this.cleanupTimer && !this.statsTimer) return
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer)
			this.cleanupTimer = undefined
		}
		if (this.statsTimer) {
			clearInterval(this.statsTimer)
			this.statsTimer = undefined
		}
		this.log.info({ nodeCount: this.nodes.size }, "Mesh tracker stopped")
	}

	/**
	 * Apply one Meshtastic packet. `at` is the receive time (`lastSeen` and
	 * position `at`). Invalid data is counted and dropped. Never throws on
	 * malformed input.
	 */
	processPacket(decoderId: string, data: unknown, at?: Date): void {
		const parsed = packetSchema.safeParse(data)
		if (!parsed.success) {
			this.invalidPackets += 1
			return
		}
		const packet = parsed.data
		if (packet.from === BROADCAST) {
			this.invalidPackets += 1
			return
		}
		const payload = decodePayload(packet.payloadB64)
		if (!payload) {
			this.invalidPackets += 1
			return
		}
		const atMs =
			at !== undefined && !Number.isNaN(at.getTime())
				? at.getTime()
				: this.now()
		const atIso = new Date(atMs).toISOString()
		if (this.takeDuplicate(packet.from, packet.id, atMs)) {
			this.packetsProcessed += 1
			this.duplicatesDropped += 1
			const existing = this.nodes.get(formatNodeId(packet.from))
			if (existing) existing.duplicateCopies += 1
			return
		}

		const nodeId = formatNodeId(packet.from)
		let node = this.nodes.get(nodeId)
		const isNew = node === undefined
		if (node === undefined) {
			this.makeRoom()
			if (this.nodes.size >= this.limits.maxNodes) return
			node = this.blank(nodeId, packet.from >>> 0, decoderId, atIso)
			this.nodes.set(nodeId, node)
		}
		this.remember(packet.from, packet.id, atMs)
		this.packetsProcessed += 1
		this.noteUnique()
		if (this.lastPacketAtMs === null || atMs > this.lastPacketAtMs) {
			this.lastPacketAtMs = atMs
		}
		this.apply(node, packet, payload, decoderId, atIso)
		this.order.set(nodeId, this.nextOrder++)
		this.emit(isNew ? "mesh:new" : "mesh:update", node)
	}

	/** Most recently heard first. Equal times break toward the smaller node id. */
	getAll(): MeshNode[] {
		return [...this.nodes.values()].sort((a, b) => {
			if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? 1 : -1
			if (a.nodeId < b.nodeId) return -1
			if (a.nodeId > b.nodeId) return 1
			return 0
		})
	}

	/** Case-insensitive `!` + 8 hex digits. Anything else is undefined. */
	get(nodeId: string): MeshNode | undefined {
		const key = canonicalNodeId(nodeId)
		if (!key) return undefined
		return this.nodes.get(key)
	}

	getStats(): MeshTrackerStats {
		let withPosition = 0
		let withName = 0
		let latest: { id: string; at: number; seq: number } | null = null
		for (const [id, node] of this.nodes) {
			if (node.position) withPosition += 1
			if (node.longName !== null || node.shortName !== null) withName += 1
			const at = Date.parse(node.lastSeen)
			const seq = this.order.get(id) ?? 0
			if (!latest || at > latest.at || (at === latest.at && seq > latest.seq)) {
				latest = { id, at, seq }
			}
		}
		const now = this.now()
		return {
			nodeCount: this.nodes.size,
			withPosition,
			withName,
			packetsProcessed: this.packetsProcessed,
			duplicatesDropped: this.duplicatesDropped,
			invalidPackets: this.invalidPackets,
			decodeErrors: this.decodeErrors,
			packetsPerSecond: this.packetsPerSecond(now),
			lastPacketAt:
				this.lastPacketAtMs === null
					? null
					: new Date(this.lastPacketAtMs).toISOString(),
			latestNodeId: latest?.id ?? null,
			expiredTotal: this.expiredTotal,
			timestamp: new Date(now).toISOString(),
		}
	}

	private blank(
		nodeId: string,
		nodeNum: number,
		decoderId: string,
		atIso: string,
	): MeshNode {
		return {
			nodeId,
			key: `node:${nodeId}`,
			nodeNum,
			longName: null,
			shortName: null,
			hwModel: null,
			role: null,
			isLicensed: null,
			position: null,
			snrDb: null,
			rssiDbm: null,
			hopsAway: null,
			viaMqtt: false,
			packetCount: 0,
			duplicateCopies: 0,
			portnums: {},
			lastPortnum: 0,
			decoderId,
			firstSeen: atIso,
			lastSeen: atIso,
			lastNodeInfoAt: null,
		}
	}

	private apply(
		node: MeshNode,
		packet: Packet,
		payload: Uint8Array,
		decoderId: string,
		atIso: string,
	): void {
		node.packetCount += 1
		node.decoderId = decoderId
		node.lastSeen = atIso
		node.lastPortnum = packet.portnum
		node.snrDb = radioLevel(packet.rxSnr)
		node.rssiDbm = radioLevel(packet.rxRssi)
		node.hopsAway = hopsAway(packet.hopStart, packet.hopLimit)
		node.viaMqtt = packet.viaMqtt === true
		bumpPortnum(node.portnums, packet.portnum)
		if (packet.portnum === PORT_POSITION) {
			const decoded = readPosition(payload)
			if (!decoded) {
				this.decodeErrors += 1
				return
			}
			const position = carriedPosition(
				decoded.lat,
				decoded.lon,
				decoded.altitudeM,
				atIso,
			)
			if (position) node.position = position
			return
		}
		if (packet.portnum === PORT_NODEINFO) {
			const decoded = readUser(payload)
			if (!decoded) {
				this.decodeErrors += 1
				return
			}
			this.applyUser(node, decoded, atIso)
		}
	}

	/**
	 * A User whose id is not this node is counted on `invalidPackets` and does
	 * not change names, hardware, role or `lastNodeInfoAt` (req 5.4). Empty
	 * names do not clear a name already stored.
	 */
	private applyUser(node: MeshNode, user: MeshUserFields, atIso: string): void {
		if (!userIdMatches(user.id, node.nodeId)) {
			this.invalidPackets += 1
			return
		}
		if (user.longName !== null && user.longName.length > 0) {
			node.longName = user.longName
		}
		if (user.shortName !== null && user.shortName.length > 0) {
			node.shortName = user.shortName
		}
		if (user.hwModel !== null) node.hwModel = user.hwModel
		if (user.role !== null) node.role = user.role
		if (user.isLicensed !== null) node.isLicensed = user.isLicensed
		node.lastNodeInfoAt = atIso
	}

	private takeDuplicate(from: number, id: number, atMs: number): boolean {
		this.pruneDuplicates(atMs)
		const key = duplicateKey(from, id)
		const seen = this.duplicates.get(key)
		if (
			seen !== undefined &&
			Math.abs(atMs - seen) <= this.limits.duplicateWindowMs
		) {
			// Keep the later timestamp so an older copy cannot shrink the window.
			this.duplicates.set(key, Math.max(seen, atMs))
			return true
		}
		return false
	}

	private remember(from: number, id: number, atMs: number): void {
		const key = duplicateKey(from, id)
		const existing = this.duplicates.get(key)
		if (existing === undefined) {
			while (this.duplicates.size >= this.limits.maxDuplicateKeys) {
				const before = this.duplicates.size
				this.evictOldestDuplicate()
				if (this.duplicates.size >= before) return
			}
			this.duplicates.set(key, atMs)
			return
		}
		this.duplicates.set(key, Math.max(existing, atMs))
	}

	private pruneDuplicates(atMs: number): void {
		const cutoff = atMs - this.limits.duplicateWindowMs
		for (const [key, seen] of this.duplicates) {
			if (seen < cutoff) this.duplicates.delete(key)
		}
	}

	private evictOldestDuplicate(): void {
		let oldestKey: string | undefined
		let oldestAt = Infinity
		for (const [key, seen] of this.duplicates) {
			if (
				oldestKey === undefined ||
				seen < oldestAt ||
				(seen === oldestAt && key < oldestKey)
			) {
				oldestKey = key
				oldestAt = seen
			}
		}
		if (oldestKey !== undefined) this.duplicates.delete(oldestKey)
	}

	private noteUnique(): void {
		const now = this.now()
		this.uniqueMarks.push(now)
		this.pruneMarks(now)
	}

	private pruneMarks(now: number): void {
		const cutoff = now - RATE_WINDOW_MS
		let drop = 0
		while (
			drop < this.uniqueMarks.length &&
			(this.uniqueMarks[drop] ?? 0) < cutoff
		) {
			drop += 1
		}
		if (drop > 0) this.uniqueMarks.splice(0, drop)
	}

	private packetsPerSecond(now: number): number {
		this.pruneMarks(now)
		return this.uniqueMarks.length / 60
	}

	private makeRoom(): void {
		while (this.nodes.size >= this.limits.maxNodes) {
			const victim = this.leastRecentlyHeard()
			if (victim === undefined) return
			const before = this.nodes.size
			this.remove(victim, "cap")
			if (this.nodes.size >= before) return
		}
	}

	private leastRecentlyHeard(): string | undefined {
		let bestId: string | undefined
		let bestAt = Infinity
		for (const [id, node] of this.nodes) {
			const at = Date.parse(node.lastSeen)
			if (
				bestId === undefined ||
				at < bestAt ||
				(at === bestAt && id < bestId)
			) {
				bestId = id
				bestAt = at
			}
		}
		return bestId
	}

	private sweep(): void {
		const now = this.now()
		const doomed: string[] = []
		for (const [id, node] of this.nodes) {
			if (now - Date.parse(node.lastSeen) > this.limits.maxAgeMs)
				doomed.push(id)
		}
		for (const id of doomed) this.remove(id, "age")
		if (doomed.length > 0) {
			this.log.debug(
				{ removed: doomed.length, remaining: this.nodes.size },
				"Mesh node expiry sweep",
			)
		}
	}

	private remove(nodeId: string, reason: "age" | "cap"): void {
		const node = this.nodes.get(nodeId)
		if (!node) return
		this.nodes.delete(nodeId)
		this.order.delete(nodeId)
		if (reason === "age") this.expiredTotal += 1
		this.emit("mesh:lost", nodeId, node)
	}
}
