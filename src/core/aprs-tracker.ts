/**
 * APRS station, object and item current-state tracker (WG2 req 3).
 *
 * In-memory only. A report updates fields it carries and leaves the rest
 * alone. Invalid reports are counted and dropped. Digipeated copies of a
 * packet already heard within 30 s change only the duplicate counts.
 */

import { EventEmitter } from "node:events"
import type { Logger } from "@wavekit/shared"
import { z } from "zod"
import type {
	AprsEntityKind,
	AprsStation,
	AprsTrackerStats,
	AprsWeather,
} from "@wavekit/api-types"
import { createComponentLogger } from "../utils/logger.js"

export interface AprsTrackerConfig {
	/** Drop an entity not heard for this long. Default 2 h. */
	maxAgeMs?: number
	/** How often the expiry sweep runs. Default 30 s. */
	cleanupIntervalMs?: number
	/** Hard cap. Default 2000. Least recently heard is evicted. */
	maxStations?: number
	/** How often `stats:update` is emitted while running. Default 5 s. */
	statsIntervalMs?: number
	/** How long a digipeat key is remembered. Default 30 s. */
	duplicateWindowMs?: number
	/** Cap on remembered digipeat keys. Default 4096. Oldest is dropped. */
	maxDuplicateKeys?: number
	/** Clock for sweeps, the rate window and the default report time. */
	now?: () => number
}

export interface AprsTrackerEvents {
	"aprs:new": [station: AprsStation]
	"aprs:update": [station: AprsStation]
	"aprs:lost": [key: string, station: AprsStation]
	"stats:update": [stats: AprsTrackerStats]
}

const DEFAULTS = {
	maxAgeMs: 7_200_000,
	cleanupIntervalMs: 30_000,
	maxStations: 2_000,
	statsIntervalMs: 5_000,
	duplicateWindowMs: 30_000,
	maxDuplicateKeys: 4_096,
} as const

const RATE_WINDOW_MS = 60_000
const MAX_TEXT = 256
const MAX_RAW = 256
const MAX_CALL = 16
const MAX_PATH = 8
const CONTROL = /[\u0000-\u001f\u007f]/g
const ISO_TIMESTAMP =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const finite = z.number().finite()

const weatherSchema = z.object({
	temperature: finite.nullish(),
	humidity: finite.nullish(),
	pressure: finite.nullish(),
	windSpeed: finite.nullish(),
	windDirection: finite.nullish(),
	rainfall: finite.nullish(),
})

const aprsPacketSchema = z.object({
	timestamp: z.union([
		z.date().refine(date => !Number.isNaN(date.getTime())),
		z
			.string()
			.refine(
				value => ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value)),
			),
	]),
	source: z.string().min(1).max(MAX_CALL),
	destination: z.string().min(1).max(MAX_CALL),
	path: z.array(z.string().min(1).max(MAX_CALL)).max(MAX_PATH).default([]),
	dataType: z.string().min(1).max(64),
	lat: finite.min(-90).max(90).nullish(),
	lon: finite.min(-180).max(180).nullish(),
	altitude: finite.nullish(),
	course: finite.nullish(),
	speed: finite.nullish(),
	symbol: z.string().max(8).nullish(),
	comment: z.string().max(MAX_TEXT).nullish(),
	raw: z.string().max(MAX_RAW).nullish(),
	objectName: z.string().max(9).nullish(),
	objectKind: z.enum(["object", "item"]).nullish(),
	objectKilled: z.boolean().nullish(),
	weather: weatherSchema.nullish(),
})

type AprsPacket = z.infer<typeof aprsPacketSchema>
type WeatherPacket = z.infer<typeof weatherSchema>

interface ResolvedEntity {
	key: string
	kind: AprsEntityKind
	name: string | null
	callsign: string
	killed: boolean
}

const STRING_FIELDS = [
	"source",
	"destination",
	"dataType",
	"comment",
	"raw",
	"symbol",
] as const

function stripControls(value: unknown): unknown {
	if (typeof value !== "string") return value
	return value.replace(CONTROL, "")
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null
	}
	return { ...(value as Record<string, unknown>) }
}

/**
 * Strip C0 controls and DEL from free-text fields. Object and item names are
 * not stripped: a `:` or a control character makes the key invalid.
 */
function prepareAprs(data: unknown): unknown {
	const record = asRecord(data)
	if (!record) return data
	for (const key of STRING_FIELDS) {
		if (key in record) record[key] = stripControls(record[key])
	}
	if (Array.isArray(record["path"])) {
		record["path"] = record["path"].map(item => stripControls(item))
	}
	return record
}

function canonicalCallsign(source: string): string | null {
	const match = /^([A-Z0-9]{1,6})(?:-(\d{1,2}))?$/.exec(source.toUpperCase())
	const base = match?.[1]
	if (base === undefined) return null
	const ssid = match?.[2]
	if (ssid === undefined || Number(ssid) === 0) return base
	return `${base}-${ssid}`
}

function objectIdentity(
	name: string,
	kind: "object" | "item",
): { key: string; name: string } | null {
	const trimmed = name.replace(/ +$/, "")
	if (trimmed.length < 1 || trimmed.length > 9) return null
	if (/[:\u0000-\u001f]/.test(trimmed)) return null
	const prefix = kind === "object" ? "aprs-object" : "aprs-item"
	return { key: `${prefix}:${trimmed}`, name: trimmed }
}

function resolveEntity(report: AprsPacket): ResolvedEntity | null {
	const callsign = canonicalCallsign(report.source)
	if (!callsign) return null
	if (report.objectKind === "object" || report.objectKind === "item") {
		const identity = objectIdentity(report.objectName ?? "", report.objectKind)
		if (!identity) return null
		return {
			key: identity.key,
			kind: report.objectKind,
			name: identity.name,
			callsign,
			killed: report.objectKilled === true,
		}
	}
	return {
		key: `callsign:${callsign}`,
		kind: "station",
		name: null,
		callsign,
		killed: false,
	}
}

function carriedText(value: string | null | undefined): string | null {
	if (value == null) return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : null
}

function carriedNumber(
	value: number | null | undefined,
	accept: (value: number) => boolean,
): number | null {
	if (value == null || !accept(value)) return null
	return value
}

function acceptAltitude(value: number): boolean {
	return value >= -99_999 && value <= 999_999
}

function acceptCourse(value: number): boolean {
	return value >= 0 && value < 360
}

function acceptSpeed(value: number): boolean {
	return value >= 0 && value <= 2_000
}

function acceptTemp(value: number): boolean {
	return value >= -99 && value <= 999
}

function acceptHumidity(value: number): boolean {
	return value >= 0 && value <= 100
}

function acceptPressure(value: number): boolean {
	return value >= 0 && value <= 2_000
}

function acceptWindSpeed(value: number): boolean {
	return value >= 0 && value <= 999
}

function acceptWindDirection(value: number): boolean {
	return value >= 0 && value <= 359
}

function acceptRain(value: number): boolean {
	return value >= 0 && value <= 100
}

function emptyWeather(at: string): AprsWeather {
	return {
		temperatureF: null,
		humidityPct: null,
		pressureMbar: null,
		windSpeedMph: null,
		windDirectionDeg: null,
		rainLastHourIn: null,
		at,
	}
}

function cloneStation(station: AprsStation): AprsStation {
	return {
		...station,
		path: [...station.path],
		position: station.position ? { ...station.position } : null,
		weather: station.weather ? { ...station.weather } : null,
	}
}

export class AprsTracker extends EventEmitter<AprsTrackerEvents> {
	private readonly log: Logger
	private readonly stations = new Map<string, AprsStation>()
	/** Process order, used to break lastSeen ties. */
	private readonly order = new Map<string, number>()
	private nextOrder = 0
	private readonly dedupe = new Map<string, number>()
	private readonly limits: {
		maxAgeMs: number
		cleanupIntervalMs: number
		maxStations: number
		statsIntervalMs: number
		duplicateWindowMs: number
		maxDuplicateKeys: number
	}
	private readonly now: () => number
	private cleanupTimer: ReturnType<typeof setInterval> | undefined
	private statsTimer: ReturnType<typeof setInterval> | undefined
	private packetsProcessed = 0
	private duplicatesDropped = 0
	private invalidPackets = 0
	/** Unique packets per processing second. At most one bucket per second of the window. */
	private readonly rateBuckets = new Map<number, number>()
	private lastPacketAtMs: number | null = null
	private expiredTotal = 0

	constructor(config: AprsTrackerConfig = {}, logger: Logger) {
		super()
		this.log = createComponentLogger(logger, "AprsTracker")
		this.now = config.now ?? Date.now
		this.limits = {
			maxAgeMs: config.maxAgeMs ?? DEFAULTS.maxAgeMs,
			cleanupIntervalMs: config.cleanupIntervalMs ?? DEFAULTS.cleanupIntervalMs,
			maxStations: config.maxStations ?? DEFAULTS.maxStations,
			statsIntervalMs: config.statsIntervalMs ?? DEFAULTS.statsIntervalMs,
			duplicateWindowMs: config.duplicateWindowMs ?? DEFAULTS.duplicateWindowMs,
			maxDuplicateKeys: config.maxDuplicateKeys ?? DEFAULTS.maxDuplicateKeys,
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
				maxStations: this.limits.maxStations,
				cleanupIntervalMs: this.limits.cleanupIntervalMs,
				statsIntervalMs: this.limits.statsIntervalMs,
				duplicateWindowMs: this.limits.duplicateWindowMs,
				maxDuplicateKeys: this.limits.maxDuplicateKeys,
			},
			"APRS tracker started",
		)
	}

	/** Stop the timers. Idempotent. Current stations are kept. */
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
		this.log.info({ stationCount: this.stations.size }, "APRS tracker stopped")
	}

	/**
	 * Apply one APRS report. `at` is the report time (position `at` and
	 * lastSeen). Invalid data is counted and dropped, never thrown.
	 */
	processAprs(decoderId: string, data: unknown, at?: Date): void {
		this.packetsProcessed += 1
		try {
			this.ingest(decoderId, data, at)
		} catch (error: unknown) {
			this.invalidPackets += 1
			this.log.error({ err: error }, "APRS packet processing failed")
		}
	}

	/** Most recently heard first. Equal times keep later processing first. */
	getAll(): AprsStation[] {
		return [...this.stations.values()].sort((a, b) => {
			if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? 1 : -1
			const seqA = this.order.get(a.key) ?? 0
			const seqB = this.order.get(b.key) ?? 0
			if (seqA !== seqB) return seqB - seqA
			if (a.key < b.key) return -1
			if (a.key > b.key) return 1
			return 0
		})
	}

	/** Exact key. Does not normalize. */
	get(key: string): AprsStation | undefined {
		return this.stations.get(key)
	}

	getStats(): AprsTrackerStats {
		const byKind: Record<AprsEntityKind, number> = {
			station: 0,
			object: 0,
			item: 0,
		}
		let withPosition = 0
		let latest: { key: string; at: number; seq: number } | null = null
		for (const [key, station] of this.stations) {
			byKind[station.kind] += 1
			if (station.position) withPosition += 1
			const at = Date.parse(station.lastSeen)
			const seq = this.order.get(key) ?? 0
			if (!latest || at > latest.at || (at === latest.at && seq > latest.seq)) {
				latest = { key, at, seq }
			}
		}
		const now = this.now()
		return {
			stationCount: this.stations.size,
			withPosition,
			byKind,
			packetsProcessed: this.packetsProcessed,
			duplicatesDropped: this.duplicatesDropped,
			invalidPackets: this.invalidPackets,
			packetsPerSecond: this.packetsPerSecond(now),
			lastPacketAt:
				this.lastPacketAtMs === null
					? null
					: new Date(this.lastPacketAtMs).toISOString(),
			latestKey: latest?.key ?? null,
			expiredTotal: this.expiredTotal,
			timestamp: new Date(now).toISOString(),
		}
	}

	private ingest(decoderId: string, data: unknown, at?: Date): void {
		const parsed = aprsPacketSchema.safeParse(prepareAprs(data))
		if (!parsed.success) {
			this.invalidPackets += 1
			return
		}
		const entity = resolveEntity(parsed.data)
		if (!entity) {
			this.invalidPackets += 1
			return
		}
		const atMs = this.resolveAt(at)
		if (this.isDuplicate(parsed.data, entity.key, atMs)) return
		this.noteUnique(atMs)
		if (entity.killed) {
			this.remove(entity.key, "kill")
			return
		}
		const atIso = new Date(atMs).toISOString()
		const existing = this.stations.get(entity.key)
		if (existing) {
			this.merge(existing, parsed.data, entity, decoderId, atIso)
			this.order.set(entity.key, this.nextOrder++)
			this.emit("aprs:update", existing)
			return
		}
		this.makeRoom()
		if (this.stations.size >= this.limits.maxStations) return
		const created = this.create(parsed.data, entity, decoderId, atIso)
		this.stations.set(entity.key, created)
		this.order.set(entity.key, this.nextOrder++)
		this.emit("aprs:new", created)
	}

	private resolveAt(at: Date | undefined): number {
		if (at instanceof Date && !Number.isNaN(at.getTime())) return at.getTime()
		return this.now()
	}

	private noteHeard(atMs: number): void {
		if (this.lastPacketAtMs === null || atMs > this.lastPacketAtMs) {
			this.lastPacketAtMs = atMs
		}
	}

	private noteUnique(atMs: number): void {
		this.noteHeard(atMs)
		const now = this.now()
		const second = Math.floor(now / 1000)
		this.rateBuckets.set(second, (this.rateBuckets.get(second) ?? 0) + 1)
		this.pruneMarks(now)
	}

	/** Drops seconds that ended before the rolling 60 s window. */
	private pruneMarks(now: number): void {
		const cutoff = now - RATE_WINDOW_MS
		for (const second of this.rateBuckets.keys()) {
			if (second * 1000 + 999 < cutoff) this.rateBuckets.delete(second)
		}
	}

	private packetsPerSecond(now: number): number {
		this.pruneMarks(now)
		let count = 0
		for (const value of this.rateBuckets.values()) count += value
		return count / 60
	}

	/**
	 * @returns true when this is a copy of a packet heard within the window.
	 * Packets with no `raw` information field are never deduped.
	 */
	private isDuplicate(
		report: AprsPacket,
		entityKey: string,
		atMs: number,
	): boolean {
		if (report.raw == null) return false
		const dedupeKey = `${report.source}>${report.destination}:${report.raw}`
		const seen = this.dedupe.get(dedupeKey)
		if (
			seen !== undefined &&
			atMs >= seen &&
			atMs - seen < this.limits.duplicateWindowMs
		) {
			this.duplicatesDropped += 1
			const station = this.stations.get(entityKey)
			if (station) station.digipeatedCopies += 1
			this.noteHeard(atMs)
			this.pruneDedupe(atMs)
			return true
		}
		this.rememberDedupe(dedupeKey, atMs)
		return false
	}

	private rememberDedupe(dedupeKey: string, atMs: number): void {
		this.pruneDedupe(atMs)
		if (this.dedupe.has(dedupeKey)) this.dedupe.delete(dedupeKey)
		if (this.limits.maxDuplicateKeys <= 0) return
		while (this.dedupe.size >= this.limits.maxDuplicateKeys) {
			if (!this.dropOldestDedupe()) break
		}
		this.dedupe.set(dedupeKey, atMs)
	}

	private pruneDedupe(atMs: number): void {
		// Keys are inserted oldest first (re-inserted on remember): stop at the first live one.
		// An out-of-order stale key may linger until reached; matching re-checks the window.
		const dead: string[] = []
		for (const [key, seen] of this.dedupe) {
			if (atMs - seen < this.limits.duplicateWindowMs) break
			dead.push(key)
		}
		for (const key of dead) this.dedupe.delete(key)
	}

	private dropOldestDedupe(): boolean {
		let oldestKey: string | undefined
		let oldestAt = Infinity
		for (const [key, seen] of this.dedupe) {
			if (seen < oldestAt) {
				oldestAt = seen
				oldestKey = key
			}
		}
		if (oldestKey === undefined) return false
		this.dedupe.delete(oldestKey)
		return true
	}

	private create(
		report: AprsPacket,
		entity: ResolvedEntity,
		decoderId: string,
		atIso: string,
	): AprsStation {
		const station: AprsStation = {
			key: entity.key,
			kind: entity.kind,
			callsign: entity.callsign,
			name: entity.name,
			position: null,
			altitudeFt: null,
			courseDeg: null,
			speedKn: null,
			symbol: null,
			comment: null,
			status: null,
			weather: null,
			path: [...report.path],
			lastDataType: report.dataType,
			killed: false,
			packetCount: 1,
			digipeatedCopies: 0,
			decoderId,
			firstSeen: atIso,
			lastSeen: atIso,
		}
		this.applyContent(station, report, atIso)
		return station
	}

	/** A report never clears a field it does not carry. */
	private merge(
		station: AprsStation,
		report: AprsPacket,
		entity: ResolvedEntity,
		decoderId: string,
		atIso: string,
	): void {
		station.callsign = entity.callsign
		station.decoderId = decoderId
		station.lastSeen = atIso
		station.lastDataType = report.dataType
		station.path = [...report.path]
		station.packetCount += 1
		this.applyContent(station, report, atIso)
	}

	private applyContent(
		station: AprsStation,
		report: AprsPacket,
		atIso: string,
	): void {
		if (report.dataType === "Message") return
		if (report.lat != null && report.lon != null) {
			station.position = { lat: report.lat, lon: report.lon, at: atIso }
		}
		const altitude = carriedNumber(report.altitude, acceptAltitude)
		const course = carriedNumber(report.course, acceptCourse)
		const speed = carriedNumber(report.speed, acceptSpeed)
		if (altitude !== null) station.altitudeFt = altitude
		if (course !== null) station.courseDeg = course
		if (speed !== null) station.speedKn = speed
		if (report.symbol != null && report.symbol.length === 2) {
			station.symbol = report.symbol
		}
		const text = carriedText(report.comment)
		if (report.dataType === "Status") {
			if (text && station.kind === "station") station.status = text
		} else if (text) {
			station.comment = text
		}
		if (report.weather) this.applyWeather(station, report.weather, atIso)
	}

	private applyWeather(
		station: AprsStation,
		weather: WeatherPacket,
		atIso: string,
	): void {
		const temperatureF = carriedNumber(weather.temperature, acceptTemp)
		const humidityPct = carriedNumber(weather.humidity, acceptHumidity)
		const pressureMbar = carriedNumber(weather.pressure, acceptPressure)
		const windSpeedMph = carriedNumber(weather.windSpeed, acceptWindSpeed)
		const windDirectionDeg = carriedNumber(
			weather.windDirection,
			acceptWindDirection,
		)
		const rainLastHourIn = carriedNumber(weather.rainfall, acceptRain)
		if (
			temperatureF === null &&
			humidityPct === null &&
			pressureMbar === null &&
			windSpeedMph === null &&
			windDirectionDeg === null &&
			rainLastHourIn === null
		) {
			return
		}
		const next = station.weather ? { ...station.weather } : emptyWeather(atIso)
		if (temperatureF !== null) next.temperatureF = temperatureF
		if (humidityPct !== null) next.humidityPct = humidityPct
		if (pressureMbar !== null) next.pressureMbar = pressureMbar
		if (windSpeedMph !== null) next.windSpeedMph = windSpeedMph
		if (windDirectionDeg !== null) next.windDirectionDeg = windDirectionDeg
		if (rainLastHourIn !== null) next.rainLastHourIn = rainLastHourIn
		next.at = atIso
		station.weather = next
	}

	/** Evict the least recently heard entity until a new key fits. */
	private makeRoom(): void {
		while (this.stations.size >= this.limits.maxStations) {
			const victim = this.leastRecentlyHeard()
			if (victim === undefined) return
			this.remove(victim, "cap")
		}
	}

	private leastRecentlyHeard(): string | undefined {
		let bestKey: string | undefined
		let bestAt = Infinity
		let bestSeq = Infinity
		for (const [key, station] of this.stations) {
			const at = Date.parse(station.lastSeen)
			const seq = this.order.get(key) ?? 0
			if (
				bestKey === undefined ||
				at < bestAt ||
				(at === bestAt && seq < bestSeq) ||
				(at === bestAt && seq === bestSeq && key < bestKey)
			) {
				bestKey = key
				bestAt = at
				bestSeq = seq
			}
		}
		return bestKey
	}

	private sweep(): void {
		const now = this.now()
		this.pruneDedupe(now)
		const doomed: string[] = []
		for (const [key, station] of this.stations) {
			if (now - Date.parse(station.lastSeen) > this.limits.maxAgeMs) {
				doomed.push(key)
			}
		}
		for (const key of doomed) this.remove(key, "age")
		if (doomed.length > 0) {
			this.log.debug(
				{ removed: doomed.length, remaining: this.stations.size },
				"APRS expiry sweep",
			)
		}
	}

	private remove(key: string, reason: "age" | "cap" | "kill"): void {
		const station = this.stations.get(key)
		if (!station) return
		this.stations.delete(key)
		this.order.delete(key)
		if (reason === "age") this.expiredTotal += 1
		if (reason === "kill") {
			const lost = cloneStation(station)
			lost.killed = true
			this.emit("aprs:lost", key, lost)
			return
		}
		this.emit("aprs:lost", key, station)
	}
}
