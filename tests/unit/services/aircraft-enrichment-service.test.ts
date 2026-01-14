/**
 * Aircraft Enrichment Service Unit Tests
 *
 * Tests for the AircraftEnrichmentService hexdb.io integration.
 * This is an ADS-B-specific component that does NOT affect other decoders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
	AircraftEnrichmentService,
	type AircraftEnrichmentConfig,
} from "../../../src/services/aircraft-enrichment-service.js"
import { AircraftTracker } from "../../../src/core/aircraft-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"
import type {
	AircraftIdentification,
	RawAircraftMessage,
} from "@wavekit/api-types"

// Create a test logger
const testLogger = createLogger({ level: "error" })

// Default config for tests
const defaultConfig: AircraftEnrichmentConfig = {
	hexdbUrl: "https://hexdb.io",
	cacheTtlMs: 60000, // 1 minute for tests
	maxCacheSize: 100,
	rateLimitMs: 10, // Fast for tests
	requestTimeoutMs: 1000,
	enabled: true,
}

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

/**
 * Helper to create a mock hexdb response
 */
function createHexdbResponse(overrides: Record<string, string> = {}) {
	return {
		Registration: "N12345",
		ICAOTypeCode: "B738",
		Type: "Boeing 737-800",
		Manufacturer: "Boeing",
		RegisteredOwners: "United Airlines",
		OperatorFlagCode: "UAL",
		ModeS: "ABC123",
		...overrides,
	}
}

/**
 * Helper to create a successful fetch response
 */
function mockFetchSuccess(data: Record<string, unknown>) {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		status: 200,
		json: () => Promise.resolve(data),
	})
}

/**
 * Helper to create a successful text (image URL) fetch response
 */
function mockFetchTextSuccess(text: string) {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		status: 200,
		text: () => Promise.resolve(text),
	})
}

/**
 * Helper to create a 404 fetch response
 */
function mockFetch404() {
	mockFetch.mockResolvedValueOnce({
		ok: false,
		status: 404,
		statusText: "Not Found",
	})
}

/**
 * Helper to create a 404 text response for image lookups
 */
function mockFetch404Text() {
	mockFetch.mockResolvedValueOnce({
		ok: false,
		status: 404,
		statusText: "Not Found",
		text: () => Promise.resolve("n/a"),
	})
}

/**
 * Helper to create a failed fetch response
 */
function mockFetchError(status: number, statusText: string) {
	mockFetch.mockResolvedValueOnce({
		ok: false,
		status,
		statusText,
	})
}

/**
 * Helper to create a network error
 */
function mockFetchNetworkError() {
	mockFetch.mockRejectedValueOnce(new Error("Network error"))
}

describe("AircraftEnrichmentService", () => {
	let service: AircraftEnrichmentService

	beforeEach(() => {
		mockFetch.mockReset()
		service = new AircraftEnrichmentService(defaultConfig, testLogger)
	})

	afterEach(() => {
		service.stop()
	})

	describe("Initialization", () => {
		it("should initialize with default config", () => {
			const stats = service.getCacheStats()
			expect(stats.hits).toBe(0)
			expect(stats.misses).toBe(0)
			expect(stats.size).toBe(0)
		})

		it("should start and stop correctly", () => {
			service.start()
			// Should not throw
			service.stop()
		})
	})

	describe("Direct Lookup", () => {
		it("should lookup aircraft from hexdb.io", async () => {
			mockFetchSuccess(createHexdbResponse())
			service.start()

			const result = await service.lookup("ABC123")

			expect(result).toBeDefined()
			expect(result!.registration).toBe("N12345")
			expect(result!.typeCode).toBe("B738")
			expect(result!.typeDescription).toBe("Boeing 737-800")
			expect(result!.manufacturer).toBe("Boeing")
			expect(result!.operator).toBe("United Airlines")
			expect(result!.operatorCode).toBe("UAL")
			expect(result!.source).toBe("hexdb")
		})

		it("should return null for 404 responses", async () => {
			mockFetch404()
			service.start()

			const result = await service.lookup("UNKNOWN")

			expect(result).toBeNull()
		})

		it("should handle API errors gracefully", async () => {
			mockFetchError(500, "Internal Server Error")
			service.start()

			const result = await service.lookup("ABC123")

			expect(result).toBeNull()
		})

		it("should handle network errors gracefully", async () => {
			mockFetchNetworkError()
			service.start()

			const result = await service.lookup("ABC123")

			expect(result).toBeNull()
		})

		it("should normalize ICAO to uppercase", async () => {
			mockFetchSuccess(createHexdbResponse())
			service.start()

			await service.lookup("abc123")

			expect(mockFetch).toHaveBeenCalledWith(
				"https://hexdb.io/api/v1/aircraft/ABC123",
				expect.any(Object),
			)
		})
	})

	describe("Caching", () => {
		it("should cache successful lookups", async () => {
			mockFetchSuccess(createHexdbResponse())
			mockFetch404Text() // Image fetch
			service.start()

			// First lookup
			await service.lookup("ABC123")

			// Second lookup - should use cache
			const result = await service.lookup("ABC123")

			expect(result).toBeDefined()
			expect(result!.registration).toBe("N12345")
			expect(mockFetch).toHaveBeenCalledTimes(2) // Aircraft + image fetch
		})

		it("should cache 404 responses to avoid repeated lookups", async () => {
			mockFetch404()
			mockFetch404Text() // Image fetch also returns 404
			service.start()

			// First lookup
			await service.lookup("UNKNOWN")

			// Second lookup - should use cache (null)
			const result = await service.lookup("UNKNOWN")

			expect(result).toBeNull()
			expect(mockFetch).toHaveBeenCalledTimes(2) // Aircraft + image fetch
		})

		it("should track cache statistics", async () => {
			mockFetchSuccess(createHexdbResponse())
			mockFetch404Text() // Image fetch
			service.start()

			// First lookup - miss
			await service.lookup("ABC123")

			// Second lookup - hit
			await service.lookup("ABC123")

			const stats = service.getCacheStats()
			expect(stats.misses).toBe(1)
			expect(stats.hits).toBe(1)
			expect(stats.size).toBe(1)
		})

		it("should evict oldest entries when cache is full", async () => {
			const smallCacheService = new AircraftEnrichmentService(
				{ ...defaultConfig, maxCacheSize: 2, fetchImages: false },
				testLogger,
			)
			smallCacheService.start()

			// Add 3 entries to a cache with size 2
			mockFetchSuccess(createHexdbResponse({ Registration: "N111" }))
			await smallCacheService.lookup("ICAO1")

			mockFetchSuccess(createHexdbResponse({ Registration: "N222" }))
			await smallCacheService.lookup("ICAO2")

			mockFetchSuccess(createHexdbResponse({ Registration: "N333" }))
			await smallCacheService.lookup("ICAO3")

			const stats = smallCacheService.getCacheStats()
			expect(stats.size).toBe(2) // Should be limited to max size

			smallCacheService.stop()
		})

		it("should expire cache entries after TTL", async () => {
			const shortTtlService = new AircraftEnrichmentService(
				{ ...defaultConfig, cacheTtlMs: 50, fetchImages: false }, // 50ms TTL, no images
				testLogger,
			)
			shortTtlService.start()

			mockFetchSuccess(createHexdbResponse())
			await shortTtlService.lookup("ABC123")

			// Wait for TTL to expire
			await new Promise(resolve => setTimeout(resolve, 60))

			// Should make a new request
			mockFetchSuccess(createHexdbResponse())
			await shortTtlService.lookup("ABC123")

			expect(mockFetch).toHaveBeenCalledTimes(2)

			shortTtlService.stop()
		})

		it("should clear cache when requested", async () => {
			mockFetchSuccess(createHexdbResponse())
			mockFetch404Text() // Image fetch
			service.start()

			await service.lookup("ABC123")
			expect(service.getCacheStats().size).toBe(1)

			service.clearCache()
			expect(service.getCacheStats().size).toBe(0)
		})
	})

	describe("Queue Processing", () => {
		it("should queue lookups and process them", async () => {
			mockFetchSuccess(createHexdbResponse())
			mockFetch404Text() // Image fetch
			service.start()

			// Enqueue should not await
			service.enqueue("ABC123")

			// Wait for queue processing
			await new Promise(resolve => setTimeout(resolve, 50))

			expect(mockFetch).toHaveBeenCalledTimes(2) // Aircraft + image fetch
		})

		it("should not enqueue duplicate ICAOs that are still in queue", async () => {
			// Use rate limiting to ensure items stay in queue longer
			const slowService = new AircraftEnrichmentService(
				{ ...defaultConfig, rateLimitMs: 200, fetchImages: false },
				testLogger,
			)
			slowService.start()

			// Queue first item with slow mock to keep it processing
			mockFetchSuccess(createHexdbResponse())
			mockFetchSuccess(createHexdbResponse())

			// Enqueue same ICAO twice quickly (before first can be processed)
			slowService.enqueue("ABC123")
			slowService.enqueue("ABC123") // Should be ignored since it's in queue

			// Wait for queue to empty (need more time due to rate limiting)
			await new Promise(resolve => setTimeout(resolve, 100))

			// Only one request should have been made
			expect(mockFetch).toHaveBeenCalledTimes(1)

			slowService.stop()
		})

		it("should skip already cached ICAOs in queue", async () => {
			mockFetchSuccess(createHexdbResponse())
			mockFetch404Text() // Image fetch
			service.start()

			// Direct lookup to populate cache
			await service.lookup("ABC123")

			// Enqueue same ICAO
			service.enqueue("ABC123")

			// Wait for processing
			await new Promise(resolve => setTimeout(resolve, 50))

			// Only aircraft + image fetch from direct lookup
			expect(mockFetch).toHaveBeenCalledTimes(2)
		})
	})

	describe("Tracker Integration", () => {
		it("should wire to tracker and enrich on aircraft:new", async () => {
			const tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60000 },
				testLogger,
			)

			mockFetchSuccess(createHexdbResponse())
			mockFetch404Text() // Image fetch
			service.wireToTracker(tracker)
			service.start()

			// Add new aircraft to tracker
			const raw: RawAircraftMessage = { hex: "ABC123", flight: "UAL123" }
			tracker.processUpdate(raw)

			// Wait for enrichment
			await new Promise(resolve => setTimeout(resolve, 50))

			// Check that aircraft was enriched
			const aircraft = tracker.get("ABC123")
			expect(aircraft).toBeDefined()
			expect(aircraft!.identification?.registration).toBe("N12345")
			expect(aircraft!.identification?.source).toBe("hexdb")

			tracker.stop()
		})

		it("should merge enrichment with existing identification", async () => {
			const tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60000 },
				testLogger,
			)

			// Return partial enrichment (no manufacturer)
			mockFetchSuccess({
				Registration: "N99999",
				ICAOTypeCode: "A320",
			})
			mockFetch404Text() // Image fetch
			service.wireToTracker(tracker)
			service.start()

			// Add aircraft with existing identification from readsb
			const raw: RawAircraftMessage = {
				hex: "DEF456",
				r: "N88888", // readsb registration
				t: "B738", // readsb type code
				desc: "Boeing 737-800", // readsb description
			}
			tracker.processUpdate(raw)

			// Wait for enrichment
			await new Promise(resolve => setTimeout(resolve, 50))

			const aircraft = tracker.get("DEF456")
			expect(aircraft).toBeDefined()
			// hexdb data should override readsb
			expect(aircraft!.identification?.registration).toBe("N99999")
			expect(aircraft!.identification?.typeCode).toBe("A320")
			// But readsb description should be preserved (hexdb didn't provide it)
			expect(aircraft!.identification?.typeDescription).toBe("Boeing 737-800")

			tracker.stop()
		})

		it("should not enrich when service is disabled", async () => {
			const disabledService = new AircraftEnrichmentService(
				{ ...defaultConfig, enabled: false },
				testLogger,
			)
			const tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60000 },
				testLogger,
			)

			disabledService.wireToTracker(tracker)
			disabledService.start()

			tracker.processUpdate({ hex: "ABC123" })

			await new Promise(resolve => setTimeout(resolve, 50))

			expect(mockFetch).not.toHaveBeenCalled()

			disabledService.stop()
			tracker.stop()
		})

		it("should not enrich when service is stopped", async () => {
			const tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60000 },
				testLogger,
			)

			service.wireToTracker(tracker)
			// Note: service not started

			tracker.processUpdate({ hex: "ABC123" })

			await new Promise(resolve => setTimeout(resolve, 50))

			expect(mockFetch).not.toHaveBeenCalled()

			tracker.stop()
		})
	})

	describe("Events", () => {
		it("should emit enrichment:success on successful lookup", async () => {
			mockFetchSuccess(createHexdbResponse())
			mockFetch404Text() // Image fetch
			service.start()

			const eventPromise = new Promise<[string, AircraftIdentification]>(
				resolve => {
					service.once("enrichment:success", (icao, data) => {
						resolve([icao, data])
					})
				},
			)

			await service.lookup("ABC123")

			const [icao, data] = await eventPromise
			expect(icao).toBe("ABC123")
			expect(data.registration).toBe("N12345")
		})

		it("should emit enrichment:failed on API error", async () => {
			mockFetchNetworkError()
			service.start()

			const eventPromise = new Promise<[string, Error]>(resolve => {
				service.once("enrichment:failed", (icao, err) => {
					resolve([icao, err])
				})
			})

			await service.lookup("ABC123")

			const [icao, err] = await eventPromise
			expect(icao).toBe("ABC123")
			expect(err).toBeInstanceOf(Error)
		})

		it("should emit enrichment:cached when using cached data", async () => {
			mockFetchSuccess(createHexdbResponse())
			mockFetch404Text() // Image fetch
			service.start()

			// Populate cache
			await service.lookup("ABC123")

			const eventPromise = new Promise<string>(resolve => {
				service.once("enrichment:cached", icao => {
					resolve(icao)
				})
			})

			// Enqueue cached ICAO
			service.enqueue("ABC123")

			const icao = await eventPromise
			expect(icao).toBe("ABC123")
		})
	})

	describe("Rate Limiting", () => {
		it("should respect rate limit between requests", async () => {
			const rateLimitedService = new AircraftEnrichmentService(
				{ ...defaultConfig, rateLimitMs: 100, fetchImages: false },
				testLogger,
			)
			rateLimitedService.start()

			mockFetchSuccess(createHexdbResponse({ Registration: "N111" }))
			mockFetchSuccess(createHexdbResponse({ Registration: "N222" }))

			const startTime = Date.now()

			// Enqueue two requests
			rateLimitedService.enqueue("ICAO1")
			rateLimitedService.enqueue("ICAO2")

			// Wait for both to complete
			await new Promise(resolve => setTimeout(resolve, 300))

			const elapsed = Date.now() - startTime
			expect(elapsed).toBeGreaterThanOrEqual(100) // Should have waited at least rateLimitMs

			rateLimitedService.stop()
		})
	})

	describe("Response Parsing", () => {
		it("should handle empty response data", async () => {
			mockFetchSuccess({})
			mockFetch404Text() // Image fetch (will still run)
			service.start()

			const result = await service.lookup("ABC123")

			// Should return null for empty/meaningless response
			expect(result).toBeNull()
		})

		it("should handle partial response data", async () => {
			mockFetchSuccess({
				Registration: "N12345",
				// No other fields
			})
			mockFetch404Text() // Image fetch
			service.start()

			const result = await service.lookup("ABC123")

			expect(result).toBeDefined()
			expect(result!.registration).toBe("N12345")
			expect(result!.typeCode).toBeUndefined()
			expect(result!.manufacturer).toBeUndefined()
		})

		it("should handle response with only type code", async () => {
			mockFetchSuccess({
				ICAOTypeCode: "B738",
			})
			mockFetch404Text() // Image fetch
			service.start()

			const result = await service.lookup("ABC123")

			expect(result).toBeDefined()
			expect(result!.typeCode).toBe("B738")
			expect(result!.registration).toBeUndefined()
		})
	})

	describe("EnrichmentCacheStatsProvider Interface", () => {
		it("should provide cache stats to tracker", async () => {
			const tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60000 },
				testLogger,
			)

			mockFetchSuccess(createHexdbResponse())
			mockFetch404Text() // Image fetch - no image
			service.wireToTracker(tracker)
			tracker.setEnrichmentCacheProvider(service)
			service.start()

			// Perform lookups to generate stats
			await service.lookup("ABC123")
			await service.lookup("ABC123") // Cache hit

			const trackerStats = tracker.getStats()
			expect(trackerStats.enrichmentCache.hits).toBe(1)
			expect(trackerStats.enrichmentCache.misses).toBe(1)
			expect(trackerStats.enrichmentCache.size).toBe(1)

			tracker.stop()
		})
	})

	describe("Image URL Fetching", () => {
		it("should fetch image URL along with aircraft data", async () => {
			// Mock aircraft API response
			mockFetchSuccess(createHexdbResponse({ Registration: "N628TS" }))
			// Mock image URL response
			mockFetchTextSuccess("https://hexdb.io/static/aircraft-images/N628TS.jpg")
			service.start()

			const result = await service.lookup("A835AF")

			expect(result).toBeDefined()
			expect(result!.registration).toBe("N628TS")
			expect(result!.imageUrl).toBe(
				"https://hexdb.io/static/aircraft-images/N628TS.jpg",
			)
		})

		it("should handle missing image gracefully (404 response)", async () => {
			mockFetchSuccess(createHexdbResponse())
			mockFetch404Text()
			service.start()

			const result = await service.lookup("ABC123")

			expect(result).toBeDefined()
			expect(result!.registration).toBe("N12345")
			expect(result!.imageUrl).toBeUndefined()
		})

		it("should handle 'n/a' image response", async () => {
			mockFetchSuccess(createHexdbResponse())
			// Mock image fetch returning "n/a" (no image available)
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				text: () => Promise.resolve("n/a"),
			})
			service.start()

			const result = await service.lookup("ABC123")

			expect(result).toBeDefined()
			expect(result!.imageUrl).toBeUndefined()
		})

		it("should handle invalid image URL response", async () => {
			mockFetchSuccess(createHexdbResponse())
			// Mock image fetch returning non-URL text
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				text: () => Promise.resolve("invalid-not-a-url"),
			})
			service.start()

			const result = await service.lookup("ABC123")

			expect(result).toBeDefined()
			expect(result!.imageUrl).toBeUndefined()
		})

		it("should not fetch images when fetchImages config is false", async () => {
			const noImagesService = new AircraftEnrichmentService(
				{ ...defaultConfig, fetchImages: false },
				testLogger,
			)
			mockFetchSuccess(createHexdbResponse())
			noImagesService.start()

			const result = await noImagesService.lookup("ABC123")

			expect(result).toBeDefined()
			expect(result!.imageUrl).toBeUndefined()
			// Only one fetch call (aircraft API only, no image fetch)
			expect(mockFetch).toHaveBeenCalledTimes(1)

			noImagesService.stop()
		})

		it("should fetch aircraft and image in parallel", async () => {
			// Set up responses for parallel calls
			mockFetchSuccess(createHexdbResponse())
			mockFetchTextSuccess("https://hexdb.io/static/aircraft-images/N12345.jpg")
			service.start()

			await service.lookup("ABC123")

			// Both calls should have been made
			expect(mockFetch).toHaveBeenCalledTimes(2)

			// Verify the URLs called
			const calls = mockFetch.mock.calls
			expect(calls[0]?.[0]).toContain("/api/v1/aircraft/")
			expect(calls[1]?.[0]).toContain("/hex-image?hex=")
		})

		it("should handle image fetch network error gracefully", async () => {
			mockFetchSuccess(createHexdbResponse())
			// Mock image fetch network failure
			mockFetch.mockRejectedValueOnce(new Error("Network error"))
			service.start()

			const result = await service.lookup("ABC123")

			// Aircraft data should still be returned
			expect(result).toBeDefined()
			expect(result!.registration).toBe("N12345")
			expect(result!.imageUrl).toBeUndefined()
		})

		it("should include imageUrl in tracker enrichment", async () => {
			const tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60000 },
				testLogger,
			)

			mockFetchSuccess(createHexdbResponse())
			mockFetchTextSuccess("https://hexdb.io/static/aircraft-images/N12345.jpg")
			service.wireToTracker(tracker)
			service.start()

			// Add new aircraft to tracker
			const raw: RawAircraftMessage = { hex: "ABC123", flight: "UAL123" }
			tracker.processUpdate(raw)

			// Wait for enrichment
			await new Promise(resolve => setTimeout(resolve, 100))

			// Check that aircraft was enriched with image URL
			const aircraft = tracker.get("ABC123")
			expect(aircraft).toBeDefined()
			expect(aircraft!.identification?.registration).toBe("N12345")
			expect(aircraft!.identification?.imageUrl).toBe(
				"https://hexdb.io/static/aircraft-images/N12345.jpg",
			)

			tracker.stop()
		})

		it("should cache image URL with aircraft data", async () => {
			mockFetchSuccess(createHexdbResponse())
			mockFetchTextSuccess("https://hexdb.io/static/aircraft-images/N12345.jpg")
			service.start()

			// First lookup
			const result1 = await service.lookup("ABC123")
			expect(result1!.imageUrl).toBe(
				"https://hexdb.io/static/aircraft-images/N12345.jpg",
			)

			// Second lookup - should use cache
			const result2 = await service.lookup("ABC123")
			expect(result2!.imageUrl).toBe(
				"https://hexdb.io/static/aircraft-images/N12345.jpg",
			)

			// Only 2 fetch calls total (1 aircraft + 1 image from first lookup)
			expect(mockFetch).toHaveBeenCalledTimes(2)
		})
	})
})
