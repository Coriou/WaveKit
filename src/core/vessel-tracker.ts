/**
 * AIS vessel current-state tracker (WG1).
 *
 * In-memory only. A report updates fields it carries and leaves the rest
 * alone. Invalid reports are counted and dropped.
 */

import { EventEmitter } from "node:events"
import type { Logger } from "@wavekit/shared"
import { z } from "zod"
import type {
	VesselClass,
	VesselState,
	VesselTrackerStats,
} from "@wavekit/api-types"
import { createComponentLogger } from "../utils/logger.js"

export interface VesselTrackerConfig {
	/** Drop a vessel not heard for this long. Default 15 min. */
	maxAgeMs?: number
	/** How often the expiry sweep runs. Default 10 s. */
	cleanupIntervalMs?: number
	/** Hard cap. Default 5000. Least recently heard is evicted. */
	maxVessels?: number
	/** How often `stats:update` is emitted while running. Default 5 s. */
	statsIntervalMs?: number
	/** Clock for sweeps, stats and the default report time. Not a YAML key. */
	now?: () => number
}

export interface VesselTrackerEvents {
	"vessel:new": [vessel: VesselState]
	"vessel:update": [vessel: VesselState]
	"vessel:lost": [mmsi: string, vessel: VesselState]
	"stats:update": [stats: VesselTrackerStats]
}

const DEFAULTS = {
	maxAgeMs: 900_000,
	cleanupIntervalMs: 10_000,
	maxVessels: 5_000,
	statsIntervalMs: 5_000,
} as const

const RATE_WINDOW_MS = 60_000

const finite = z.number().finite()

/** ShipData at the boundary. Unknown keys are ignored. Invalid ETA is dropped later. */
const shipReportSchema = z.object({
	mmsi: z.union([z.string(), z.number()]),
	messageType: z.number().int(),
	name: z.string().nullish(),
	callsign: z.string().nullish(),
	imo: finite.nullish(),
	shipType: finite.nullish(),
	lat: finite.nullish(),
	lon: finite.nullish(),
	cog: finite.nullish(),
	sog: finite.nullish(),
	heading: finite.nullish(),
	navStatus: finite.nullish(),
	destination: z.string().nullish(),
	eta: z.union([z.date(), z.string()]).nullish(),
	draught: finite.nullish(),
})

type ShipReport = z.infer<typeof shipReportSchema>

const CLASS_A = new Set([1, 2, 3, 5])
const CLASS_B = new Set([18, 19, 24])

/**
 * First match on the types seen: base station, aid to navigation, SAR,
 * class B, class A, otherwise unknown.
 */
function vesselClassFor(types: readonly number[]): VesselClass {
	if (types.includes(4) || types.includes(11)) return "base-station"
	if (types.includes(21)) return "aton"
	if (types.includes(9)) return "sar"
	if (types.some(type => CLASS_B.has(type))) return "B"
	if (types.some(type => CLASS_A.has(type))) return "A"
	return "unknown"
}

/** 1–9 digits, zero-padded. Anything else is not an MMSI. */
function normalizeMmsi(value: string | number): string | null {
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < 0 || value > 999_999_999) {
			return null
		}
		return String(value).padStart(9, "0")
	}
	if (!/^\d{1,9}$/.test(value)) return null
	return value.padStart(9, "0")
}

/** Trim and strip AIS "@" padding. Empty text is absent. */
function carriedText(value: string | null | undefined): string | null {
	if (value == null) return null
	const cleaned = value.replace(/@+$/g, "").trim()
	return cleaned.length > 0 ? cleaned : null
}

function carriedEta(value: Date | string | null | undefined): string | null {
	if (value == null) return null
	const date = value instanceof Date ? value : new Date(value)
	if (Number.isNaN(date.getTime())) return null
	return date.toISOString()
}

function carriedNumber(
	value: number | null | undefined,
	accept: (value: number) => boolean,
): number | null {
	if (value == null || !accept(value)) return null
	return value
}

function acceptLat(value: number): boolean {
	return value !== 91 && Math.abs(value) <= 90
}

function acceptLon(value: number): boolean {
	return value !== 181 && Math.abs(value) <= 180
}

function acceptCog(value: number): boolean {
	return value >= 0 && value < 360
}

function acceptSog(value: number): boolean {
	return value >= 0 && value < 102.3
}

function acceptHeading(value: number): boolean {
	return value >= 0 && value <= 359
}

function acceptNavStatus(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 14
}

function acceptShipType(value: number): boolean {
	return Number.isInteger(value) && value >= 1 && value <= 99
}

function acceptDraught(value: number): boolean {
	return value > 0
}

function acceptImo(value: number): boolean {
	return Number.isInteger(value) && value > 0
}

/**
 * A non-date ETA must not fail the rest of the report. Zod only accepts
 * Date or string; other shapes are treated as absent.
 */
function prepareReport(data: unknown): unknown {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return data
	}
	const record = { ...(data as Record<string, unknown>) }
	const eta = record["eta"]
	if (eta != null && !(eta instanceof Date) && typeof eta !== "string") {
		delete record["eta"]
	}
	return record
}

function emptyByClass(): Record<VesselClass, number> {
	return {
		A: 0,
		B: 0,
		"base-station": 0,
		aton: 0,
		sar: 0,
		unknown: 0,
	}
}

export class VesselTracker extends EventEmitter<VesselTrackerEvents> {
	private readonly log: Logger
	private readonly vessels = new Map<string, VesselState>()
	/** Process order, used to break lastSeen ties for latestMmsi. */
	private readonly order = new Map<string, number>()
	private nextOrder = 0
	private readonly limits: {
		maxAgeMs: number
		cleanupIntervalMs: number
		maxVessels: number
		statsIntervalMs: number
	}
	private readonly now: () => number
	private cleanupTimer: ReturnType<typeof setInterval> | undefined
	private statsTimer: ReturnType<typeof setInterval> | undefined
	private messagesProcessed = 0
	private readonly messageMarks: number[] = []
	private lastMessageAtMs: number | null = null
	private expiredTotal = 0

	constructor(config: VesselTrackerConfig = {}, logger: Logger) {
		super()
		this.log = createComponentLogger(logger, "VesselTracker")
		this.now = config.now ?? Date.now
		this.limits = {
			maxAgeMs: config.maxAgeMs ?? DEFAULTS.maxAgeMs,
			cleanupIntervalMs: config.cleanupIntervalMs ?? DEFAULTS.cleanupIntervalMs,
			maxVessels: config.maxVessels ?? DEFAULTS.maxVessels,
			statsIntervalMs: config.statsIntervalMs ?? DEFAULTS.statsIntervalMs,
		}
	}

	/** Start the expiry sweep and the stats timer. Idempotent. */
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
				maxVessels: this.limits.maxVessels,
				cleanupIntervalMs: this.limits.cleanupIntervalMs,
				statsIntervalMs: this.limits.statsIntervalMs,
			},
			"Vessel tracker started",
		)
	}

	/** Stop the timers. Idempotent. Current vessels are kept. */
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
		this.log.info({ vesselCount: this.vessels.size }, "Vessel tracker stopped")
	}

	/**
	 * Apply one ship report. `at` is the report time (position `at` and
	 * lastSeen). Invalid data is counted and dropped.
	 */
	processShip(decoderId: string, data: unknown, at?: Date): void {
		this.noteMessage()
		const parsed = shipReportSchema.safeParse(prepareReport(data))
		if (!parsed.success) return
		const mmsi = normalizeMmsi(parsed.data.mmsi)
		if (!mmsi) return

		const atMs =
			at !== undefined && !Number.isNaN(at.getTime())
				? at.getTime()
				: this.now()
		const atIso = new Date(atMs).toISOString()
		const existing = this.vessels.get(mmsi)
		if (!existing) {
			this.makeRoom()
			if (this.vessels.size >= this.limits.maxVessels) return
		}
		if (this.lastMessageAtMs === null || atMs > this.lastMessageAtMs) {
			this.lastMessageAtMs = atMs
		}

		if (existing) {
			this.merge(existing, parsed.data, decoderId, atIso)
			this.order.set(mmsi, this.nextOrder++)
			this.emit("vessel:update", existing)
			return
		}

		const created = this.create(mmsi, parsed.data, decoderId, atIso)
		this.vessels.set(mmsi, created)
		this.order.set(mmsi, this.nextOrder++)
		this.emit("vessel:new", created)
	}

	/** Most recently heard first. */
	getAll(): VesselState[] {
		return [...this.vessels.values()].sort((a, b) => {
			if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? 1 : -1
			if (a.mmsi < b.mmsi) return -1
			if (a.mmsi > b.mmsi) return 1
			return 0
		})
	}

	/** Accepts 1–9 digits and zero-pads. */
	get(mmsi: string): VesselState | undefined {
		const key = normalizeMmsi(mmsi)
		if (!key) return undefined
		return this.vessels.get(key)
	}

	getStats(): VesselTrackerStats {
		const byClass = emptyByClass()
		let withPosition = 0
		let withName = 0
		let latest: { mmsi: string; at: number; seq: number } | null = null
		for (const [mmsi, state] of this.vessels) {
			byClass[state.vesselClass] += 1
			if (state.position) withPosition += 1
			if (state.name) withName += 1
			const at = Date.parse(state.lastSeen)
			const seq = this.order.get(mmsi) ?? 0
			if (!latest || at > latest.at || (at === latest.at && seq > latest.seq)) {
				latest = { mmsi, at, seq }
			}
		}
		const now = this.now()
		return {
			vesselCount: this.vessels.size,
			withPosition,
			withName,
			byClass,
			messagesProcessed: this.messagesProcessed,
			messagesPerSecond: this.messagesPerSecond(now),
			lastMessageAt:
				this.lastMessageAtMs === null
					? null
					: new Date(this.lastMessageAtMs).toISOString(),
			latestMmsi: latest?.mmsi ?? null,
			expiredTotal: this.expiredTotal,
			timestamp: new Date(now).toISOString(),
		}
	}

	private noteMessage(): void {
		this.messagesProcessed += 1
		const now = this.now()
		this.messageMarks.push(now)
		this.pruneMarks(now)
	}

	private pruneMarks(now: number): void {
		const cutoff = now - RATE_WINDOW_MS
		let drop = 0
		while (
			drop < this.messageMarks.length &&
			(this.messageMarks[drop] ?? 0) < cutoff
		) {
			drop += 1
		}
		if (drop > 0) this.messageMarks.splice(0, drop)
	}

	private messagesPerSecond(now: number): number {
		this.pruneMarks(now)
		return this.messageMarks.length / 60
	}

	private create(
		mmsi: string,
		report: ShipReport,
		decoderId: string,
		atIso: string,
	): VesselState {
		const name = carriedText(report.name)
		const state: VesselState = {
			mmsi,
			vesselClass: vesselClassFor([report.messageType]),
			name,
			callsign: carriedText(report.callsign),
			imo: carriedNumber(report.imo, acceptImo),
			shipType: carriedNumber(report.shipType, acceptShipType),
			destination: carriedText(report.destination),
			eta: carriedEta(report.eta),
			draught: carriedNumber(report.draught, acceptDraught),
			position: null,
			cog: carriedNumber(report.cog, acceptCog),
			sog: carriedNumber(report.sog, acceptSog),
			heading: carriedNumber(report.heading, acceptHeading),
			navStatus: carriedNumber(report.navStatus, acceptNavStatus),
			messageTypes: [report.messageType],
			messageCount: 1,
			decoderId,
			firstSeen: atIso,
			lastSeen: atIso,
			lastStaticAt: null,
		}
		const lat = carriedNumber(report.lat, acceptLat)
		const lon = carriedNumber(report.lon, acceptLon)
		if (lat !== null && lon !== null) {
			state.position = { lat, lon, at: atIso }
		}
		if (isStaticReport(report.messageType, name)) state.lastStaticAt = atIso
		return state
	}

	/** A report never clears a field it does not carry. */
	private merge(
		state: VesselState,
		report: ShipReport,
		decoderId: string,
		atIso: string,
	): void {
		const name = carriedText(report.name)
		const callsign = carriedText(report.callsign)
		const destination = carriedText(report.destination)
		const imo = carriedNumber(report.imo, acceptImo)
		const shipType = carriedNumber(report.shipType, acceptShipType)
		const eta = carriedEta(report.eta)
		const draught = carriedNumber(report.draught, acceptDraught)
		const cog = carriedNumber(report.cog, acceptCog)
		const sog = carriedNumber(report.sog, acceptSog)
		const heading = carriedNumber(report.heading, acceptHeading)
		const navStatus = carriedNumber(report.navStatus, acceptNavStatus)
		const lat = carriedNumber(report.lat, acceptLat)
		const lon = carriedNumber(report.lon, acceptLon)

		if (name !== null) state.name = name
		if (callsign !== null) state.callsign = callsign
		if (destination !== null) state.destination = destination
		if (imo !== null) state.imo = imo
		if (shipType !== null) state.shipType = shipType
		if (eta !== null) state.eta = eta
		if (draught !== null) state.draught = draught
		if (cog !== null) state.cog = cog
		if (sog !== null) state.sog = sog
		if (heading !== null) state.heading = heading
		if (navStatus !== null) state.navStatus = navStatus
		if (lat !== null && lon !== null) {
			state.position = { lat, lon, at: atIso }
		}
		if (!state.messageTypes.includes(report.messageType)) {
			state.messageTypes.push(report.messageType)
			state.messageTypes.sort((a, b) => a - b)
			state.vesselClass = vesselClassFor(state.messageTypes)
		}
		state.messageCount += 1
		state.decoderId = decoderId
		state.lastSeen = atIso
		if (isStaticReport(report.messageType, name)) state.lastStaticAt = atIso
	}

	/**
	 * Evict the least recently heard vessel until a new MMSI fits.
	 * The new vessel is inserted by the caller and is not a candidate.
	 */
	private makeRoom(): void {
		while (this.vessels.size >= this.limits.maxVessels) {
			const victim = this.leastRecentlyHeard()
			if (victim === undefined) return
			this.remove(victim, "cap")
		}
	}

	private leastRecentlyHeard(): string | undefined {
		let bestMmsi: string | undefined
		let bestAt = Infinity
		for (const [mmsi, state] of this.vessels) {
			const at = Date.parse(state.lastSeen)
			if (
				bestMmsi === undefined ||
				at < bestAt ||
				(at === bestAt && mmsi < bestMmsi)
			) {
				bestMmsi = mmsi
				bestAt = at
			}
		}
		return bestMmsi
	}

	private sweep(): void {
		const now = this.now()
		const doomed: string[] = []
		for (const [mmsi, state] of this.vessels) {
			if (now - Date.parse(state.lastSeen) > this.limits.maxAgeMs) {
				doomed.push(mmsi)
			}
		}
		for (const mmsi of doomed) this.remove(mmsi, "age")
		if (doomed.length > 0) {
			this.log.debug(
				{ removed: doomed.length, remaining: this.vessels.size },
				"Vessel expiry sweep",
			)
		}
	}

	private remove(mmsi: string, reason: "age" | "cap"): void {
		const state = this.vessels.get(mmsi)
		if (!state) return
		this.vessels.delete(mmsi)
		this.order.delete(mmsi)
		if (reason === "age") this.expiredTotal += 1
		this.emit("vessel:lost", mmsi, state)
	}
}

function isStaticReport(messageType: number, name: string | null): boolean {
	if (messageType === 5 || messageType === 19 || messageType === 24) return true
	return messageType === 21 && name !== null
}
