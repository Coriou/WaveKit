/**
 * Aircraft Enrichment Service: who an aircraft is, from free sources only.
 *
 * Three layers, in order:
 * 1. Local and instant: the ICAO address block (country), the tar1090-db aircraft
 *    table (registration, type, flags, year) and the bundled OpenFlights airline
 *    table (callsign prefix to airline). Works offline.
 * 2. The on-disk cache of earlier online answers (stateDir/aircraft-info.sqlite),
 *    which survives restarts and keeps working offline.
 * 3. Online, in the background and rate limited: adsbdb.com (airframe, callsign
 *    route and airline), hexdb.io (airframe fallback) and planespotters.net (photo).
 *    Each source has a circuit breaker; an unavailable source never blocks the rest.
 *
 * Online lookups are off by default (`online: false`): nothing leaves the core until
 * the config or Settings › Map turns them on, and the tar1090-db download (layer 1) is
 * an online request too, so it waits for the same switch. The switch is read again
 * right before every request, so turning it off stops a lookup already under way.
 * Without node:sqlite or a stateDir the cache lives in memory and the local database
 * is off.
 *
 * This is an ADS-B-specific addon that does NOT affect other decoders.
 *
 * @module src/services/aircraft-enrichment-service
 */

import { EventEmitter } from "node:events"
import { mkdir, rename, rm } from "node:fs/promises"
import { createWriteStream, createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "../utils/logger.js"
import type { AircraftTracker } from "../core/aircraft-tracker.js"
import type {
	AircraftAirline,
	AircraftIdentification,
	AircraftInfoSettings,
	AircraftPhoto,
	AircraftState,
} from "@wavekit/api-types"
import { getCountryFromIcao } from "../data/icao-country-prefixes.js"
import { AIRLINES } from "../data/airlines.js"
import {
	SourceClient,
	SourceUnavailableError,
	USER_AGENT,
	type FetchLike,
} from "./aircraft-info/http.js"
import {
	adsbdbAirframe,
	adsbdbCallsign,
	hexdbAirframe,
	planespottersPhoto,
	type AirframeInfo,
	type CallsignInfo,
} from "./aircraft-info/sources.js"
import {
	AircraftInfoStore,
	type CacheKind,
	type LocalAircraftRow,
} from "./aircraft-info/store.js"
import { routePlausible } from "./aircraft-info/route-fit.js"
import { openSqliteFile } from "../core/activity/storage/probe.js"
import type { SqliteDatabase } from "../core/activity/storage/sqlite.js"

// ============================================================================
// Configuration
// ============================================================================

export interface AircraftEnrichmentConfig {
	/** Enrichment on at all (default: true) */
	enabled?: boolean
	/** Query free online sources and download tar1090-db (default: false) */
	online?: boolean
	/** Directory for aircraft-info.sqlite; absent keeps the cache in memory */
	stateDir?: string
	localDb?: {
		enabled?: boolean
		url?: string
		refreshDays?: number
	}
	/** Minimum delay between online lookups in ms (default: 1000) */
	rateLimitMs?: number
	/** Request timeout in ms (default: 6000) */
	requestTimeoutMs?: number
	/** Fetch photos (default: true) */
	fetchImages?: boolean
	/** Most aircraft waiting for an online lookup (default: 300) */
	maxQueue?: number
}

export interface AircraftEnrichmentDeps {
	fetch?: FetchLike
	now?: () => number
	/** Pre-opened store (tests); otherwise opened from stateDir on start */
	store?: AircraftInfoStore | null
}

const DAY = 24 * 60 * 60 * 1000
export const CACHE_TTL = {
	airframe: 30 * DAY,
	airframeMissing: 7 * DAY,
	photo: 30 * DAY,
	photoMissing: 7 * DAY,
	callsign: 12 * 60 * 60 * 1000,
	callsignMissing: 12 * 60 * 60 * 1000,
	airline: 90 * DAY,
} as const

/** Retry delay after a lookup failed because every source was unavailable. */
const RETRY_AFTER_MS = 10 * 60_000
/** A lookup that found the queue full is tried again this much later. */
const QUEUE_FULL_RETRY_MS = 60_000
/** First local database check after start or after online lookups are turned on. */
export const LOCAL_DB_FIRST_CHECK_MS = 20_000
/** Expired cache rows are dropped this often (hourly: the shortest TTL is 12 h). */
export const CACHE_PRUNE_INTERVAL_MS = 60 * 60_000

const DEFAULT_DB_URL =
	"https://github.com/wiedehopf/tar1090-db/raw/refs/heads/csv/aircraft.csv.gz"

type Job =
	| { kind: "airframe"; icao: string }
	| { kind: "callsign"; icao: string; callsign: string }

export interface AircraftEnrichmentEvents {
	"enrichment:success": [icao: string, data: AircraftIdentification]
	"enrichment:failed": [icao: string, error: Error]
	"enrichment:cached": [icao: string]
	"localdb:updated": [rows: number]
	/**
	 * The local database or an online source gave this ICAO address a registration. Feeds
	 * the aircraft identity registry as a database link (weaker than one seen on the air).
	 */
	"identity:registration": [
		icao: string,
		registration: string,
		from: "local" | "online",
	]
}

/** A three-letter ICAO airline prefix followed by a flight number (WKS45UL, ZZA6116). */
export function airlinePrefix(callsign: string): string | null {
	const m = /^([A-Z]{3})(\d[A-Z0-9]{0,4})$/.exec(callsign.trim().toUpperCase())
	return m?.[1] ?? null
}

/** Airline of a prefix from the bundled OpenFlights table. */
export function bundledAirline(prefix: string): AircraftAirline | null {
	const row = AIRLINES[prefix]
	if (!row) return null
	const [name, iata, callsign, country] = row
	const out: AircraftAirline = { name, icao: prefix, source: "local" }
	if (iata) out.iata = iata
	if (callsign) out.callsign = callsign
	if (country) out.country = country
	return out
}

/** Title-cases an all-caps database description ("AIRBUS A-320" -> "Airbus A-320"). */
function tidy(desc: string): string {
	if (desc !== desc.toUpperCase()) return desc
	return desc.replace(/[A-Z][A-Z]+/g, w => w[0] + w.slice(1).toLowerCase())
}

// ============================================================================
// Service
// ============================================================================

export class AircraftEnrichmentService extends EventEmitter<AircraftEnrichmentEvents> {
	private readonly log: Logger
	private readonly enabled: boolean
	private online: boolean
	/** Set from the web app (persisted in the store's meta table); null: the config's value. */
	private onlineOverride: boolean | null = null
	private readonly configOnline: boolean
	private readonly fetchImages: boolean
	private readonly rateLimitMs: number
	private readonly maxQueue: number
	private readonly localDb: {
		enabled: boolean
		url: string
		refreshDays: number
	}
	private readonly now: () => number
	private readonly fetchImpl: FetchLike
	private readonly stateDir: string | undefined

	private readonly adsbdb: SourceClient
	private readonly hexdb: SourceClient
	private readonly planespotters: SourceClient

	private store: AircraftInfoStore | null
	private readonly ownsStore: boolean
	/** Cache used when no store is available. */
	private readonly memory = new Map<
		string,
		{ value: unknown; expires: number }
	>()

	private readonly queue: Job[] = []
	private readonly queued = new Set<string>()
	private processing = false
	private lastRequestAt = 0
	/** Aircraft whose lookup failed, keyed to when to try again. */
	private readonly retryAt = new Map<string, number>()
	/** Callsign each aircraft's route was resolved for. */
	private readonly callsignOf = new Map<string, string>()
	/** Aircraft whose callsign lookup failed or was not queued, keyed to when to try again. */
	private readonly callsignRetryAt = new Map<string, number>()
	/** Online requests go out one at a time, rateLimitMs apart (shared by the queue and lookup). */
	private paceChain: Promise<void> = Promise.resolve()

	private cacheHits = 0
	private cacheMisses = 0
	private tracker: AircraftTracker | null = null
	private started = false
	/** start() in progress: settings are not known yet, so nothing is looked up. */
	private starting: Promise<void> | null = null
	/** The generation `starting` opens: a start() after a stop() begins a new one. */
	private startingGeneration = -1
	/** Bumped by stop(), so a start() that finishes after it does not come alive. */
	private generation = 0
	private refreshTimer: NodeJS.Timeout | undefined
	private pruneTimer: NodeJS.Timeout | undefined
	private refreshing: Promise<void> | null = null
	/** Aborts the tar1090-db download when online lookups are turned off. */
	private download: AbortController | null = null

	constructor(
		config: AircraftEnrichmentConfig,
		logger: Logger,
		deps: AircraftEnrichmentDeps = {},
	) {
		super()
		this.log = createComponentLogger(logger, "AircraftEnrichment")
		this.enabled = config.enabled ?? true
		this.configOnline = config.online ?? false
		// Off until start() has read the saved preference: no lookup before settings settle.
		this.online = false
		this.fetchImages = config.fetchImages ?? true
		this.rateLimitMs = config.rateLimitMs ?? 1000
		this.maxQueue = config.maxQueue ?? 300
		this.localDb = {
			enabled: (config.localDb?.enabled ?? true) && !!config.stateDir,
			url: config.localDb?.url ?? DEFAULT_DB_URL,
			refreshDays: config.localDb?.refreshDays ?? 7,
		}
		this.stateDir = config.stateDir
		this.now = deps.now ?? Date.now
		this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init))
		const client = {
			fetch: this.fetchImpl,
			timeoutMs: config.requestTimeoutMs ?? 6000,
			now: this.now,
		}
		this.adsbdb = new SourceClient("adsbdb", client)
		this.hexdb = new SourceClient("hexdb", client)
		this.planespotters = new SourceClient("planespotters", client)
		this.store = deps.store ?? null
		this.ownsStore = deps.store === undefined
	}

	// ---- lifecycle -----------------------------------------------------------

	/** Wire to an AircraftTracker: identify new aircraft, resolve callsigns as they arrive. */
	wireToTracker(tracker: AircraftTracker): void {
		this.tracker = tracker
		tracker.on("aircraft:new", (aircraft: AircraftState) => {
			if (!this.enabled || !this.started) return
			// After the other aircraft:new listeners (the WebSocket relay): an update
			// must never reach clients before the aircraft's new event.
			queueMicrotask(() => {
				if (!this.started || !tracker.get(aircraft.icao)) return
				this.identify(aircraft.icao)
				this.observeCallsign(aircraft)
			})
		})
		tracker.on("aircraft:update", (aircraft: AircraftState) => {
			if (!this.enabled || !this.started) return
			this.observeCallsign(aircraft)
			this.judgeRoute(aircraft)
			if (!this.online) return
			const now = this.now()
			const retry = this.retryAt.get(aircraft.icao)
			if (retry !== undefined && now >= retry) {
				this.retryAt.delete(aircraft.icao)
				this.enqueue({ kind: "airframe", icao: aircraft.icao })
			}
			const callsignRetry = this.callsignRetryAt.get(aircraft.icao)
			const callsign = this.callsignOf.get(aircraft.icao)
			if (callsignRetry !== undefined && now >= callsignRetry) {
				this.callsignRetryAt.delete(aircraft.icao)
				if (callsign)
					this.enqueue({ kind: "callsign", icao: aircraft.icao, callsign })
			}
		})
		tracker.on("aircraft:lost", (icao: string) => {
			this.callsignOf.delete(icao)
			this.retryAt.delete(icao)
			this.callsignRetryAt.delete(icao)
		})
	}

	/**
	 * Opens the on-disk cache, restores the saved online preference, then admits work:
	 * aircraft already tracked are identified and the local database refresh is scheduled.
	 */
	async start(): Promise<void> {
		if (this.started) return
		const generation = this.generation
		if (this.starting && this.startingGeneration === generation)
			return this.starting
		// A start cancelled by stop() may still be opening the cache: let it settle (it closes
		// what it opened) before this generation opens its own.
		const previous = this.starting
		const opening = (
			previous
				? previous.catch(() => undefined).then(() => this.open(generation))
				: this.open(generation)
		).finally(() => {
			if (this.starting === opening) this.starting = null
		})
		this.starting = opening
		this.startingGeneration = generation
		return opening
	}

	private async open(generation: number): Promise<void> {
		if (this.ownsStore && this.stateDir && this.enabled) {
			let db: SqliteDatabase | undefined
			try {
				await mkdir(this.stateDir, { recursive: true })
				db = await openSqliteFile(join(this.stateDir, "aircraft-info.sqlite"))
				this.store = new AircraftInfoStore(db, this.now)
				this.store.prune()
			} catch (err) {
				if (this.store) this.store.close()
				else
					try {
						db?.close()
					} catch {
						// already closed
					}
				this.store = null
				this.log.warn(
					{ err: err instanceof Error ? err.message : String(err) },
					"Aircraft info cache unavailable; keeping it in memory",
				)
			}
		}
		if (generation !== this.generation) {
			// stop() ran while the cache was opening
			if (this.ownsStore && this.store) {
				this.store.close()
				this.store = null
			}
			return
		}
		if (this.onlineOverride === null) {
			const saved = this.readOnlineOverride()
			if (saved !== null) this.onlineOverride = saved
		} else this.saveOnline(this.onlineOverride) // switched while opening
		this.online = this.onlineOverride ?? this.configOnline
		this.started = true
		if (this.store) {
			this.pruneTimer = setInterval(() => {
				try {
					this.store?.prune()
				} catch (err) {
					this.log.debug(
						{ err: err instanceof Error ? err.message : String(err) },
						"Aircraft info cache prune failed",
					)
				}
			}, CACHE_PRUNE_INTERVAL_MS)
			this.pruneTimer.unref()
		}
		this.scheduleFirstRefresh()
		this.identifyTracked()
		this.log.info(
			{
				enabled: this.enabled,
				online: this.online,
				persistent: this.store !== null,
				localAircraft: this.store?.localAircraftCount() ?? 0,
			},
			"Aircraft enrichment service started",
		)
	}

	/** Identifies what is on the map now: aircraft heard while starting, or before lookups came on. */
	private identifyTracked(): void {
		if (!this.started || !this.enabled || !this.tracker) return
		for (const aircraft of this.tracker.getAll()) {
			this.identify(aircraft.icao)
			const callsign = this.callsignOf.get(aircraft.icao)
			if (callsign) this.resolveCallsign(aircraft.icao, callsign)
			else this.observeCallsign(aircraft)
		}
	}

	/** The local database is downloaded only while online lookups are on. */
	private scheduleFirstRefresh(): void {
		if (this.refreshTimer || this.refreshing) return
		if (!this.started || !this.online) return
		if (!this.enabled || !this.localDb.enabled || !this.store) return
		// Shortly after start (not during boot) or after the switch, then daily checks.
		this.refreshTimer = setTimeout(
			() => this.scheduleRefresh(),
			LOCAL_DB_FIRST_CHECK_MS,
		)
		this.refreshTimer.unref()
	}

	stop(): void {
		this.generation++
		if (!this.started) return
		this.started = false
		this.queue.length = 0
		this.queued.clear()
		if (this.refreshTimer) clearTimeout(this.refreshTimer)
		this.refreshTimer = undefined
		if (this.pruneTimer) clearInterval(this.pruneTimer)
		this.pruneTimer = undefined
		this.download?.abort()
		if (this.ownsStore && this.store && !this.refreshing) {
			this.store.close()
			this.store = null
		}
		this.log.info(
			{ cacheHits: this.cacheHits, cacheMisses: this.cacheMisses },
			"Aircraft enrichment service stopped",
		)
	}

	getCacheStats(): { hits: number; misses: number; size: number } {
		return {
			hits: this.cacheHits,
			misses: this.cacheMisses,
			size: this.store?.cacheSize() ?? this.memory.size,
		}
	}

	/** ICAO address of a registration from the local database (for ACARS). */
	hexForRegistration(registration: string): string | undefined {
		try {
			return this.store?.hexForRegistration(registration)
		} catch {
			return undefined
		}
	}

	/** What GET /api/aircraft/info reports: online lookups, where that comes from, the local database. */
	settings(): AircraftInfoSettings {
		let aircraft: number | null = null
		let updatedAt: number | null = null
		try {
			if (this.store) {
				aircraft = this.store.localAircraftCount()
				const at = Number(this.store.meta("aircraft_db_updated_at") ?? 0)
				updatedAt = at > 0 ? at : null
			}
		} catch {
			aircraft = null
		}
		return {
			enabled: this.enabled,
			online: this.online,
			onlineFrom: this.onlineOverride === null ? "config" : "ui",
			persistent: this.store !== null,
			localDb: {
				enabled: this.enabled && this.localDb.enabled,
				aircraft,
				updatedAt:
					updatedAt === null ? null : new Date(updatedAt).toISOString(),
			},
		}
	}

	/**
	 * Turns online lookups on or off at runtime (Settings › Map). Kept across restarts in
	 * the store; without one it lasts until the core restarts. Off drops the queued lookups,
	 * stops the ones under way before their next request and aborts a database download.
	 * On looks up what is on the map now and schedules the local database check.
	 */
	setOnline(on: boolean): AircraftInfoSettings {
		this.onlineOverride = on
		// While start() is still reading settings, it applies this choice when it finishes.
		if (this.started) this.online = on
		if (!on) {
			this.online = false
			this.queue.length = 0
			this.queued.clear()
			this.retryAt.clear()
			this.callsignRetryAt.clear()
			if (this.refreshTimer) clearTimeout(this.refreshTimer)
			this.refreshTimer = undefined
			this.download?.abort()
		} else {
			this.identifyTracked()
			this.scheduleFirstRefresh()
		}
		if (this.started) this.saveOnline(on)
		this.log.info({ online: on }, "Aircraft online lookups changed")
		return this.settings()
	}

	private saveOnline(on: boolean): void {
		try {
			this.store?.setMeta("online", on ? "1" : "0")
		} catch (err) {
			this.log.warn(
				{ err: err instanceof Error ? err.message : String(err) },
				"Could not save the online lookups setting",
			)
		}
	}

	private readOnlineOverride(): boolean | null {
		try {
			const v = this.store?.meta("online")
			return v === "1" ? true : v === "0" ? false : null
		} catch {
			return null
		}
	}

	clearCache(): void {
		this.memory.clear()
	}

	// ---- identity ------------------------------------------------------------

	/**
	 * Applies what is known locally right away, then queues an online lookup for
	 * what is missing.
	 */
	identify(icao: string): void {
		const hex = icao.toUpperCase()
		const local = this.localIdentity(hex)
		const airframe = this.cached<AirframeInfo>("airframe", hex)
		const photo = this.cached<AircraftPhoto>("photo", hex)
		const merged = this.mergeIdentity(
			hex,
			local,
			airframe?.value ?? null,
			photo?.value ?? null,
		)
		if (Object.keys(merged).length > 0)
			this.tracker?.applyIdentification(hex, merged)
		this.noteRegistration(hex, local, merged)
		const needsAirframe = airframe === undefined
		const needsPhoto = this.fetchImages && photo === undefined
		if (airframe && (!this.fetchImages || photo)) {
			this.cacheHits++
			this.emit("enrichment:cached", hex)
		}
		if (this.online && (needsAirframe || needsPhoto)) {
			this.cacheMisses++
			this.enqueue({ kind: "airframe", icao: hex })
		}
	}

	/** Looks one aircraft up now (local, cache, then online), bypassing the queue. */
	async lookup(icao: string): Promise<AircraftIdentification | null> {
		const hex = icao.toUpperCase()
		const local = this.localIdentity(hex)
		let airframe = this.cached<AirframeInfo>("airframe", hex)
		let photo = this.cached<AircraftPhoto>("photo", hex)
		if (
			this.online &&
			(airframe === undefined || (this.fetchImages && photo === undefined))
		) {
			this.cacheMisses++
			const fetched = await this.fetchAirframe(hex, local?.registration)
			airframe = fetched.airframe ?? airframe
			photo = fetched.photo ?? photo
		} else this.cacheHits++
		const merged = this.mergeIdentity(
			hex,
			local,
			airframe?.value ?? null,
			photo?.value ?? null,
		)
		this.noteRegistration(hex, local, merged)
		return Object.keys(merged).length > 0 ? merged : null
	}

	private noteRegistration(
		hex: string,
		local: LocalAircraftRow | undefined,
		merged: AircraftIdentification,
	): void {
		if (!merged.registration) return
		const from = local?.registration ? "local" : "online"
		this.emit("identity:registration", hex, merged.registration, from)
	}

	private localIdentity(hex: string): LocalAircraftRow | undefined {
		if (!this.store) return undefined
		try {
			return this.store.localAircraft(hex)
		} catch {
			return undefined
		}
	}

	private mergeIdentity(
		hex: string,
		local: LocalAircraftRow | undefined,
		online: AirframeInfo | null,
		photo: AircraftPhoto | null,
	): AircraftIdentification {
		const out: AircraftIdentification = {}
		const country = getCountryFromIcao(hex)
		if (country) {
			out.country = country.country
			if (country.iso) out.countryIso = country.iso
		}
		const registration = local?.registration ?? online?.registration
		const typeCode = local?.typeCode ?? online?.typeCode
		const typeDescription =
			online?.typeDescription ??
			(local?.description ? tidy(local.description) : undefined)
		const operator = online?.operator ?? local?.owner
		if (registration) out.registration = registration
		if (typeCode) out.typeCode = typeCode
		if (typeDescription) out.typeDescription = typeDescription
		if (online?.manufacturer) out.manufacturer = online.manufacturer
		if (operator) out.operator = operator
		if (online?.operatorCode) out.operatorCode = online.operatorCode
		// country and countryIso both name the ICAO address block; the owner's country only fills a gap
		if (online?.countryIso && !out.countryIso)
			out.countryIso = online.countryIso
		if (local?.year) out.year = local.year
		if (
			local &&
			(local.military || local.interesting || local.pia || local.ladd)
		) {
			out.flags = {}
			if (local.military) out.flags.military = true
			if (local.interesting) out.flags.interesting = true
			if (local.pia) out.flags.pia = true
			if (local.ladd) out.flags.ladd = true
		}
		const shownPhoto = photo ?? online?.photo
		if (shownPhoto) {
			out.photo = shownPhoto
			out.imageUrl = shownPhoto.thumbnailUrl
		}
		if (local) out.source = "local"
		else if (online?.source) out.source = online.source
		return out
	}

	// ---- callsign: airline and route -----------------------------------------

	private observeCallsign(aircraft: AircraftState): void {
		const callsign = aircraft.callsign?.trim().toUpperCase()
		if (!callsign || this.callsignOf.get(aircraft.icao) === callsign) return
		this.callsignOf.set(aircraft.icao, callsign)
		this.resolveCallsign(aircraft.icao, callsign)
	}

	private resolveCallsign(icao: string, callsign: string): void {
		const cached = this.cached<CallsignInfo>("callsign", callsign)
		if (cached) {
			this.applyCallsign(icao, callsign, cached.value)
			return
		}
		// Offline answer first; the online one replaces it when it arrives.
		this.applyCallsign(icao, callsign, null)
		if (this.online) this.enqueue({ kind: "callsign", icao, callsign })
	}

	private applyCallsign(
		icao: string,
		callsign: string,
		info: CallsignInfo | null,
	): void {
		const prefix = airlinePrefix(callsign)
		const airline =
			info?.airline ??
			(prefix
				? (this.cached<AircraftAirline>("airline", prefix)?.value ??
					bundledAirline(prefix))
				: null)
		const route = info?.route?.callsign === callsign ? info.route : undefined
		const state = this.tracker?.get(icao)
		this.tracker?.applyIdentification(icao, {
			airline: airline ?? undefined,
			route:
				route && state
					? { ...route, plausible: routePlausible(route, state) }
					: route,
		})
	}

	/**
	 * Keeps `route.plausible` current as the aircraft moves. Applying a change emits another
	 * update, which finds the verdict unchanged and stops there.
	 */
	private judgeRoute(aircraft: AircraftState): void {
		const route = aircraft.identification?.route
		if (!route) return
		const plausible = routePlausible(route, aircraft)
		if (route.plausible === plausible) return
		this.tracker?.applyIdentification(aircraft.icao, {
			route: { ...route, plausible },
		})
	}

	// ---- queue ---------------------------------------------------------------

	private enqueue(job: Job): void {
		const key =
			job.kind === "airframe"
				? `a:${job.icao}`
				: `c:${job.icao}:${job.callsign}`
		if (this.queued.has(key)) return
		if (this.queue.length >= this.maxQueue) {
			// Full: try again on a later update rather than never
			const at = this.now() + QUEUE_FULL_RETRY_MS
			if (job.kind === "airframe") this.retryAt.set(job.icao, at)
			else this.callsignRetryAt.set(job.icao, at)
			return
		}
		this.queued.add(key)
		this.queue.push(job)
		if (!this.processing) void this.processQueue()
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return
		this.processing = true
		try {
			while (this.queue.length > 0 && this.started) {
				const job = this.queue.shift()
				if (!job) continue
				this.queued.delete(
					job.kind === "airframe"
						? `a:${job.icao}`
						: `c:${job.icao}:${job.callsign}`,
				)
				// Gone while waiting, or online lookups turned off: not worth a request.
				if (!this.online) continue
				if (this.tracker && !this.tracker.get(job.icao)) continue
				try {
					if (job.kind === "airframe") await this.runAirframe(job.icao)
					else await this.runCallsign(job.icao, job.callsign)
				} catch (err) {
					const error = err instanceof Error ? err : new Error(String(err))
					this.emit("enrichment:failed", job.icao, error)
					this.log.debug(
						{ icao: job.icao, error: error.message },
						"Aircraft lookup failed",
					)
				}
			}
		} finally {
			this.processing = false
		}
	}

	/** Waits for this request's turn: one online request per rateLimitMs, whoever asks. */
	private pace(): Promise<void> {
		const turn = this.paceChain.then(async () => {
			const wait = this.lastRequestAt + this.rateLimitMs - this.now()
			if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
			this.lastRequestAt = this.now()
		})
		this.paceChain = turn.catch(() => undefined)
		return turn
	}

	/**
	 * Waits for this request's turn, then says whether it may still go out: the switch is
	 * read after the wait, so a lookup turned off while it queued sends nothing more.
	 */
	private async turn(): Promise<boolean> {
		if (!this.mayRequest()) return false
		await this.pace()
		return this.mayRequest()
	}

	private mayRequest(): boolean {
		return this.started && this.enabled && this.online
	}

	private async runAirframe(hex: string): Promise<void> {
		const local = this.localIdentity(hex)
		const { airframe, photo, failed } = await this.fetchAirframe(
			hex,
			local?.registration,
		)
		if (failed) this.retryAt.set(hex, this.now() + RETRY_AFTER_MS)
		const merged = this.mergeIdentity(
			hex,
			local,
			airframe?.value ??
				this.cached<AirframeInfo>("airframe", hex)?.value ??
				null,
			photo?.value ?? this.cached<AircraftPhoto>("photo", hex)?.value ?? null,
		)
		if (Object.keys(merged).length === 0) return
		this.tracker?.applyIdentification(hex, merged)
		this.noteRegistration(hex, local, merged)
		this.emit("enrichment:success", hex, merged)
	}

	/**
	 * Online airframe and photo lookups, each cached (found or not found). A source
	 * that is unavailable leaves nothing cached so a later attempt can succeed.
	 */
	private async fetchAirframe(
		hex: string,
		knownRegistration: string | undefined,
	): Promise<{
		airframe: { value: AirframeInfo | null } | undefined
		photo: { value: AircraftPhoto | null } | undefined
		failed: boolean
	}> {
		let failed = false
		let airframe = this.cached<AirframeInfo>("airframe", hex)
		if (airframe === undefined) {
			let found: AirframeInfo | null | undefined
			for (const [client, fn] of [
				[this.adsbdb, adsbdbAirframe],
				[this.hexdb, hexdbAirframe],
			] as const) {
				if (!client.available()) continue
				try {
					if (!(await this.turn()))
						return { airframe, photo: undefined, failed }
					found = await fn(client, hex)
					if (found) break
				} catch (err) {
					if (!(err instanceof SourceUnavailableError)) throw err
				}
			}
			if (found !== undefined) {
				this.remember(
					"airframe",
					hex,
					found,
					found ? CACHE_TTL.airframe : CACHE_TTL.airframeMissing,
				)
				airframe = { value: found }
			} else failed = true
		}
		let photo = this.fetchImages
			? this.cached<AircraftPhoto>("photo", hex)
			: undefined
		if (
			this.fetchImages &&
			photo === undefined &&
			this.planespotters.available()
		) {
			const registration = knownRegistration ?? airframe?.value?.registration
			try {
				if (!(await this.turn())) return { airframe, photo, failed }
				const found = await planespottersPhoto(
					this.planespotters,
					registration ? { registration, hex } : { hex },
				)
				const value = found ?? airframe?.value?.photo ?? null
				this.remember(
					"photo",
					hex,
					value,
					value ? CACHE_TTL.photo : CACHE_TTL.photoMissing,
				)
				photo = { value }
			} catch (err) {
				if (!(err instanceof SourceUnavailableError)) throw err
				failed = true
			}
		}
		return { airframe, photo, failed }
	}

	private async runCallsign(icao: string, callsign: string): Promise<void> {
		if (this.callsignOf.get(icao) !== callsign) return
		let info = this.cached<CallsignInfo>("callsign", callsign)?.value
		if (info === undefined) {
			const later = (): void => {
				this.callsignRetryAt.set(icao, this.now() + RETRY_AFTER_MS)
			}
			if (!this.adsbdb.available()) return later()
			try {
				if (!(await this.turn())) return
				info = await adsbdbCallsign(this.adsbdb, callsign)
			} catch (err) {
				if (err instanceof SourceUnavailableError) return later()
				throw err
			}
			this.remember(
				"callsign",
				callsign,
				info,
				info ? CACHE_TTL.callsign : CACHE_TTL.callsignMissing,
			)
			// Learn the airline of the prefix for offline use later.
			const prefix = airlinePrefix(callsign)
			if (info?.airline && prefix === info.airline.icao)
				this.remember("airline", prefix, info.airline, CACHE_TTL.airline)
		}
		if (this.callsignOf.get(icao) === callsign)
			this.applyCallsign(icao, callsign, info)
	}

	// ---- cache ---------------------------------------------------------------

	private cached<T>(
		kind: CacheKind,
		key: string,
	): { value: T | null } | undefined {
		if (this.store) {
			try {
				return this.store.cached<T>(kind, key)
			} catch {
				return undefined
			}
		}
		const hit = this.memory.get(`${kind}:${key}`)
		if (!hit || hit.expires <= this.now()) return undefined
		return { value: hit.value as T | null }
	}

	private remember<T>(
		kind: CacheKind,
		key: string,
		value: T | null,
		ttlMs: number,
	): void {
		if (this.store) {
			try {
				this.store.remember(kind, key, value, ttlMs)
				return
			} catch (err) {
				this.log.debug(
					{ err: err instanceof Error ? err.message : String(err) },
					"Aircraft info cache write failed",
				)
			}
		}
		if (this.memory.size >= 10_000) {
			const oldest = this.memory.keys().next().value
			if (oldest !== undefined) this.memory.delete(oldest)
		}
		this.memory.set(`${kind}:${key}`, { value, expires: this.now() + ttlMs })
	}

	// ---- local aircraft database ---------------------------------------------

	private scheduleRefresh(): void {
		if (!this.started) return
		void this.refreshLocalDb()
			.catch((err: unknown) =>
				this.log.warn(
					{ err: err instanceof Error ? err.message : String(err) },
					"Local aircraft database check failed",
				),
			)
			.finally(() => {
				if (!this.started || !this.online) return
				this.refreshTimer = setTimeout(() => this.scheduleRefresh(), DAY)
				this.refreshTimer.unref()
			})
	}

	/**
	 * Downloads tar1090-db when missing or older than refreshDays. Only while online lookups
	 * are on: the download is an online request like any other.
	 */
	async refreshLocalDb(force = false): Promise<void> {
		if (this.refreshing) return this.refreshing
		if (!this.mayRequest()) return
		const store = this.store
		if (!store || !this.stateDir) return
		let current: { last: number; rows: number }
		try {
			current = {
				last: Number(store.meta("aircraft_db_updated_at") ?? 0),
				rows: store.localAircraftCount(),
			}
		} catch (err) {
			this.log.warn(
				{ err: err instanceof Error ? err.message : String(err) },
				"Local aircraft database unreadable; skipping this check",
			)
			return
		}
		const due = this.now() - current.last >= this.localDb.refreshDays * DAY
		if (!force && current.rows > 0 && !due) return
		const stateDir = this.stateDir
		const download = new AbortController()
		this.download = download
		this.refreshing = (async () => {
			const tmp = join(stateDir, "aircraft-db.csv.gz.part")
			try {
				const response = await this.fetchImpl(this.localDb.url, {
					headers: { "User-Agent": USER_AGENT },
					signal: AbortSignal.any([
						download.signal,
						AbortSignal.timeout(120_000),
					]),
				})
				if (!response.ok || !response.body)
					throw new SourceUnavailableError(
						"tar1090-db",
						`HTTP ${response.status}`,
					)
				await pipeline(
					Readable.fromWeb(response.body as WebReadableStream),
					createWriteStream(tmp),
				)
				const file = join(stateDir, "aircraft-db.csv.gz")
				await rename(tmp, file)
				const lines = createInterface({
					input: createReadStream(file).pipe(createGunzip()),
					crlfDelay: Infinity,
				})
				const rows = await store.replaceAircraftDb(lines)
				store.setMeta("aircraft_db_updated_at", String(this.now()))
				await rm(file, { force: true })
				this.log.info({ rows }, "Local aircraft database updated")
				this.emit("localdb:updated", rows)
			} catch (err) {
				await rm(tmp, { force: true }).catch(() => undefined)
				this.log.warn(
					{ err: err instanceof Error ? err.message : String(err) },
					"Local aircraft database refresh failed; keeping the current one",
				)
			} finally {
				this.refreshing = null
				if (this.download === download) this.download = null
				if (!this.started && this.ownsStore && this.store) {
					this.store.close()
					this.store = null
				}
			}
		})()
		return this.refreshing
	}
}
