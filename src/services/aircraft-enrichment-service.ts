/**
 * Aircraft Enrichment Service - ICAO database lookups for aircraft identification
 *
 * This is an ADS-B-specific addon that does NOT affect other decoders.
 * It enriches aircraft data by looking up ICAO hex codes in external databases
 * to obtain registration, type, operator, and other identification information.
 *
 * Features:
 * - hexdb.io API integration
 * - LRU cache with TTL to minimize API calls
 * - Rate limiting (1 request/second)
 * - Async non-blocking enrichment
 *
 * @module src/services/aircraft-enrichment-service
 */

import { EventEmitter } from "node:events"
import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "../utils/logger.js"
import type { AircraftTracker } from "../core/aircraft-tracker.js"
import type {
	AircraftIdentification,
	AircraftState,
	EnrichmentSource,
} from "@wavekit/api-types"

// ============================================================================
// Configuration
// ============================================================================

export interface AircraftEnrichmentConfig {
	/** Base URL for hexdb.io API (default: https://hexdb.io) */
	hexdbUrl?: string
	/** Cache TTL in milliseconds (default: 24 hours) */
	cacheTtlMs?: number
	/** Maximum cache entries (default: 10000) */
	maxCacheSize?: number
	/** Minimum delay between API requests in ms (default: 1000) */
	rateLimitMs?: number
	/** Request timeout in ms (default: 5000) */
	requestTimeoutMs?: number
	/** Enable enrichment (default: true) */
	enabled?: boolean
}

const DEFAULT_CONFIG: Required<AircraftEnrichmentConfig> = {
	hexdbUrl: "https://hexdb.io",
	cacheTtlMs: 24 * 60 * 60 * 1000, // 24 hours
	maxCacheSize: 10000,
	rateLimitMs: 1000, // 1 request per second
	requestTimeoutMs: 5000,
	enabled: true,
}

// ============================================================================
// Cache Types
// ============================================================================

interface CacheEntry {
	data: AircraftIdentification | null // null = lookup failed or not found
	timestamp: number
}

// ============================================================================
// hexdb.io API Response Types
// ============================================================================

/** Response from hexdb.io /api/v1/aircraft/{icao} endpoint */
interface HexdbAircraftResponse {
	Registration?: string
	ICAOTypeCode?: string
	Type?: string
	Manufacturer?: string
	OperatorFlagCode?: string
	RegisteredOwners?: string
	ModeS?: string
}

// ============================================================================
// Events Interface
// ============================================================================

export interface AircraftEnrichmentEvents {
	"enrichment:success": [icao: string, data: AircraftIdentification]
	"enrichment:failed": [icao: string, error: Error]
	"enrichment:cached": [icao: string]
	"enrichment:rate-limited": [icao: string]
}

// ============================================================================
// Aircraft Enrichment Service
// ============================================================================

/**
 * AircraftEnrichmentService - Enriches aircraft data from ICAO databases.
 *
 * Provides async enrichment of aircraft by looking up ICAO hex codes
 * in external databases (hexdb.io). Features LRU caching with TTL
 * and rate limiting to be a good API citizen.
 */
export class AircraftEnrichmentService extends EventEmitter<AircraftEnrichmentEvents> {
	private readonly log: Logger
	private readonly config: Required<AircraftEnrichmentConfig>

	// LRU cache implemented with Map (insertion order preserved)
	private readonly cache: Map<string, CacheEntry> = new Map()

	// Rate limiting queue
	private readonly pendingQueue: string[] = []
	private isProcessingQueue = false
	private lastRequestTime = 0

	// Stats
	private cacheHits = 0
	private cacheMisses = 0
	private requestsSuccessful = 0
	private requestsFailed = 0

	private tracker: AircraftTracker | null = null
	private started = false

	constructor(config: AircraftEnrichmentConfig, logger: Logger) {
		super()
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.log = createComponentLogger(logger, "AircraftEnrichment")
	}

	/**
	 * Wire up to an AircraftTracker to automatically enrich new aircraft.
	 */
	wireToTracker(tracker: AircraftTracker): void {
		this.tracker = tracker

		// Listen for new aircraft and queue enrichment
		tracker.on("aircraft:new", (aircraft: AircraftState) => {
			if (this.config.enabled && this.started) {
				this.enqueue(aircraft.icao)
			}
		})

		this.log.debug("Wired to AircraftTracker for automatic enrichment")
	}

	/**
	 * Start the enrichment service.
	 */
	start(): void {
		if (this.started) return
		this.started = true
		this.log.info(
			{
				enabled: this.config.enabled,
				cacheTtlHours: this.config.cacheTtlMs / (1000 * 60 * 60),
				maxCacheSize: this.config.maxCacheSize,
				rateLimitMs: this.config.rateLimitMs,
			},
			"Aircraft enrichment service started",
		)
	}

	/**
	 * Stop the enrichment service.
	 */
	stop(): void {
		if (!this.started) return
		this.started = false
		this.pendingQueue.length = 0
		this.log.info(
			{
				cacheSize: this.cache.size,
				cacheHits: this.cacheHits,
				cacheMisses: this.cacheMisses,
			},
			"Aircraft enrichment service stopped",
		)
	}

	/**
	 * Queue an ICAO for enrichment lookup.
	 */
	enqueue(icao: string): void {
		const normalizedIcao = icao.toUpperCase()

		// Check if already in cache
		const cached = this.getFromCache(normalizedIcao)
		if (cached !== undefined) {
			this.cacheHits++
			this.emit("enrichment:cached", normalizedIcao)
			return
		}

		// Check if already in queue
		if (this.pendingQueue.includes(normalizedIcao)) {
			return
		}

		this.cacheMisses++
		this.pendingQueue.push(normalizedIcao)
		this.log.debug(
			{ icao: normalizedIcao, queueSize: this.pendingQueue.length },
			"Queued for enrichment",
		)

		// Start processing if not already
		if (!this.isProcessingQueue) {
			void this.processQueue()
		}
	}

	/**
	 * Lookup enrichment data for an ICAO (direct, bypasses queue).
	 * Returns cached data if available, otherwise fetches from API.
	 */
	async lookup(icao: string): Promise<AircraftIdentification | null> {
		const normalizedIcao = icao.toUpperCase()

		// Check cache first
		const cached = this.getFromCache(normalizedIcao)
		if (cached !== undefined) {
			this.cacheHits++
			return cached
		}

		this.cacheMisses++
		return this.fetchAndCache(normalizedIcao)
	}

	/**
	 * Get cache statistics.
	 */
	getCacheStats(): { hits: number; misses: number; size: number } {
		return {
			hits: this.cacheHits,
			misses: this.cacheMisses,
			size: this.cache.size,
		}
	}

	/**
	 * Clear the cache.
	 */
	clearCache(): void {
		this.cache.clear()
		this.log.debug("Cache cleared")
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Process the pending queue with rate limiting.
	 */
	private async processQueue(): Promise<void> {
		if (this.isProcessingQueue || !this.started) return
		this.isProcessingQueue = true

		while (this.pendingQueue.length > 0 && this.started) {
			const icao = this.pendingQueue.shift()
			if (!icao) continue

			// Rate limiting - wait if needed
			const now = Date.now()
			const elapsed = now - this.lastRequestTime
			if (elapsed < this.config.rateLimitMs) {
				const delay = this.config.rateLimitMs - elapsed
				await this.sleep(delay)
			}

			// Skip if no longer started
			if (!this.started) break

			// Fetch and update tracker
			const data = await this.fetchAndCache(icao)
			if (data && this.tracker) {
				this.applyEnrichmentToTracker(icao, data)
			}
		}

		this.isProcessingQueue = false
	}

	/**
	 * Fetch enrichment from API and cache the result.
	 */
	private async fetchAndCache(
		icao: string,
	): Promise<AircraftIdentification | null> {
		this.lastRequestTime = Date.now()

		try {
			const data = await this.fetchFromHexdb(icao)
			this.setCache(icao, data)

			if (data) {
				this.requestsSuccessful++
				this.emit("enrichment:success", icao, data)
				this.log.debug(
					{ icao, registration: data.registration, type: data.typeCode },
					"Aircraft enriched",
				)
			} else {
				// Not found - cache null to avoid repeated lookups
				this.requestsSuccessful++
			}

			return data
		} catch (err) {
			this.requestsFailed++
			// Cache null on failure to avoid hammering API
			this.setCache(icao, null)
			const error = err instanceof Error ? err : new Error(String(err))
			this.emit("enrichment:failed", icao, error)
			this.log.warn({ icao, error: error.message }, "Enrichment lookup failed")
			return null
		}
	}

	/**
	 * Fetch aircraft data from hexdb.io API.
	 */
	private async fetchFromHexdb(
		icao: string,
	): Promise<AircraftIdentification | null> {
		const url = `${this.config.hexdbUrl}/api/v1/aircraft/${icao}`

		const controller = new AbortController()
		const timeoutId = setTimeout(
			() => controller.abort(),
			this.config.requestTimeoutMs,
		)

		try {
			const response = await fetch(url, {
				method: "GET",
				headers: {
					Accept: "application/json",
					"User-Agent": "WaveKit/1.0 (Aircraft Tracker)",
				},
				signal: controller.signal,
			})

			clearTimeout(timeoutId)

			if (!response.ok) {
				if (response.status === 404) {
					// Aircraft not in database
					return null
				}
				throw new Error(`HTTP ${response.status}: ${response.statusText}`)
			}

			const data = (await response.json()) as HexdbAircraftResponse
			return this.parseHexdbResponse(data)
		} catch (err) {
			clearTimeout(timeoutId)
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error("Request timeout")
			}
			throw err
		}
	}

	/**
	 * Parse hexdb.io response into our AircraftIdentification format.
	 */
	private parseHexdbResponse(
		data: HexdbAircraftResponse,
	): AircraftIdentification | null {
		// If no meaningful data, return null
		if (!data.Registration && !data.ICAOTypeCode && !data.RegisteredOwners) {
			return null
		}

		const identification: AircraftIdentification = {
			source: "hexdb" as EnrichmentSource,
		}

		if (data.Registration) {
			identification.registration = data.Registration
		}
		if (data.ICAOTypeCode) {
			identification.typeCode = data.ICAOTypeCode
		}
		if (data.Type) {
			identification.typeDescription = data.Type
		}
		if (data.Manufacturer) {
			identification.manufacturer = data.Manufacturer
		}
		if (data.RegisteredOwners) {
			identification.operator = data.RegisteredOwners
		}
		if (data.OperatorFlagCode) {
			identification.operatorCode = data.OperatorFlagCode
		}

		return identification
	}

	/**
	 * Apply enrichment data to the tracker's aircraft state.
	 */
	private applyEnrichmentToTracker(
		icao: string,
		data: AircraftIdentification,
	): void {
		if (!this.tracker) return

		const aircraft = this.tracker.get(icao)
		if (!aircraft) return

		// Build merged identification, only including defined properties
		const merged: AircraftIdentification = {}

		// Copy existing identification fields
		const existingId = aircraft.identification
		if (existingId) {
			if (existingId.registration) merged.registration = existingId.registration
			if (existingId.typeCode) merged.typeCode = existingId.typeCode
			if (existingId.typeDescription)
				merged.typeDescription = existingId.typeDescription
			if (existingId.manufacturer) merged.manufacturer = existingId.manufacturer
			if (existingId.operator) merged.operator = existingId.operator
			if (existingId.operatorCode) merged.operatorCode = existingId.operatorCode
			if (existingId.country) merged.country = existingId.country
			if (existingId.source) merged.source = existingId.source
		}

		// Override with enrichment data (hexdb takes precedence)
		if (data.registration) merged.registration = data.registration
		if (data.typeCode) merged.typeCode = data.typeCode
		if (data.typeDescription) merged.typeDescription = data.typeDescription
		if (data.manufacturer) merged.manufacturer = data.manufacturer
		if (data.operator) merged.operator = data.operator
		if (data.operatorCode) merged.operatorCode = data.operatorCode
		if (data.country) merged.country = data.country
		if (data.source) merged.source = data.source

		aircraft.identification = merged
	}

	/**
	 * Get entry from cache if valid (not expired).
	 */
	private getFromCache(
		icao: string,
	): AircraftIdentification | null | undefined {
		const entry = this.cache.get(icao)
		if (!entry) return undefined

		const now = Date.now()
		if (now - entry.timestamp > this.config.cacheTtlMs) {
			// Entry expired, remove it
			this.cache.delete(icao)
			return undefined
		}

		// Move to end for LRU behavior (delete and re-add)
		this.cache.delete(icao)
		this.cache.set(icao, entry)

		return entry.data
	}

	/**
	 * Set cache entry with LRU eviction if needed.
	 */
	private setCache(icao: string, data: AircraftIdentification | null): void {
		// Evict oldest entries if at capacity
		while (this.cache.size >= this.config.maxCacheSize) {
			const oldestKey = this.cache.keys().next().value
			if (oldestKey) {
				this.cache.delete(oldestKey)
			} else {
				break
			}
		}

		this.cache.set(icao, {
			data,
			timestamp: Date.now(),
		})
	}

	/**
	 * Sleep helper for rate limiting.
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms))
	}
}
