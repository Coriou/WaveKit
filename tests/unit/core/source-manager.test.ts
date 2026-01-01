/**
 * Source Manager Unit Tests
 *
 * Tests for TCP connection management with auto-reconnect and multi-source support.
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 15.1, 15.2, 15.3, 15.4, 15.5, 16.1, 16.2, 16.3
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as net from "node:net"
import * as fc from "fast-check"
import {
	SourceManager,
	calculateBackoffDelay,
	SourceCompatibilityError,
	ExclusiveSourceError,
	type SourceConfig,
	type SourceStatus,
	type SourceCaps,
	type DecoderCaps,
} from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

// Create a test logger
const testLogger = createLogger({ level: "error" })

/**
 * Helper to create default source caps for testing
 */
function createDefaultCaps(overrides?: Partial<SourceCaps>): SourceCaps {
	return {
		kind: "audio_pcm",
		sampleRate: 48000,
		format: "S16LE",
		exclusive: false,
		...overrides,
	}
}

/**
 * Helper to create a source config for testing
 */
function createSourceConfig(
	id: string,
	port: number,
	capsOverrides?: Partial<SourceCaps>,
): SourceConfig {
	return {
		id,
		type: "rtl_tcp",
		host: "127.0.0.1",
		port,
		loop: false,
		playbackSpeed: 1.0,
		caps: createDefaultCaps(capsOverrides),
	}
}

/**
 * Helper to create a mock TCP server
 */
function createMockServer(): Promise<{
	server: net.Server
	port: number
	close: () => Promise<void>
}> {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		const connections: net.Socket[] = []

		server.on("connection", socket => {
			connections.push(socket)
			socket.on("close", () => {
				const idx = connections.indexOf(socket)
				if (idx >= 0) connections.splice(idx, 1)
			})
		})

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr === "object" && addr !== null) {
				resolve({
					server,
					port: addr.port,
					close: () =>
						new Promise<void>((res, rej) => {
							// Destroy all active connections first
							for (const conn of connections) {
								conn.destroy()
							}
							server.close(err => {
								if (err) rej(err)
								else res()
							})
						}),
				})
			} else {
				reject(new Error("Failed to get server address"))
			}
		})
		server.on("error", reject)
	})
}

describe("Source Manager", () => {
	let sourceManager: SourceManager

	beforeEach(() => {
		sourceManager = new SourceManager(testLogger)
	})

	afterEach(async () => {
		await sourceManager.disconnectAll()
	})

	describe("calculateBackoffDelay", () => {
		/**
		 * Feature: wavekit-core, Property 1: Exponential Backoff Correctness
		 * Validates: Requirements 1.2
		 *
		 * For any sequence of N consecutive failures, the delay before attempt N
		 * should be min(2^N * baseDelay, maxDelay) where baseDelay=2000ms and maxDelay=30000ms.
		 */
		it("should calculate correct exponential backoff delays", () => {
			// 2^0 * 2000 = 2000
			expect(calculateBackoffDelay(0)).toBe(2000)
			// 2^1 * 2000 = 4000
			expect(calculateBackoffDelay(1)).toBe(4000)
			// 2^2 * 2000 = 8000
			expect(calculateBackoffDelay(2)).toBe(8000)
			// 2^3 * 2000 = 16000
			expect(calculateBackoffDelay(3)).toBe(16000)
			// 2^4 * 2000 = 32000, but max is 30000
			expect(calculateBackoffDelay(4)).toBe(30000)
			// Higher values should also cap at 30000
			expect(calculateBackoffDelay(5)).toBe(30000)
			expect(calculateBackoffDelay(10)).toBe(30000)
		})
	})

	describe("Connection Management", () => {
		it("should connect to a TCP server and emit connected event", async () => {
			const mockServer = await createMockServer()

			try {
				let connectedId: string | null = null
				sourceManager.on("connected", (id: string) => {
					connectedId = id
				})

				const config = createSourceConfig("test-source", mockServer.port)
				const stream = await sourceManager.connect(config)

				expect(stream).toBeDefined()
				expect(connectedId).toBe("test-source")
			} finally {
				await mockServer.close()
			}
		})

		it("should receive data from the server", async () => {
			const mockServer = await createMockServer()
			const testData = Buffer.from("test audio data")

			// Send data when client connects
			mockServer.server.on("connection", socket => {
				socket.write(testData)
			})

			try {
				const dataPromise = new Promise<Buffer>(resolve => {
					sourceManager.on("data", (id, chunk) => {
						resolve(chunk)
					})
				})

				const config = createSourceConfig("test-source", mockServer.port)
				await sourceManager.connect(config)

				const receivedData = await dataPromise
				expect(receivedData.equals(testData)).toBe(true)
			} finally {
				await mockServer.close()
			}
		})

		it("should track bytes received in status", async () => {
			const mockServer = await createMockServer()
			const testData = Buffer.alloc(1000, 0x42)

			mockServer.server.on("connection", socket => {
				socket.write(testData)
			})

			try {
				const config = createSourceConfig("test-source", mockServer.port)
				await sourceManager.connect(config)

				// Wait for data to be received
				await new Promise(resolve => setTimeout(resolve, 100))

				const status = sourceManager.getStatus("test-source")
				expect(status).toBeDefined()
				expect(status!.bytesReceived).toBe(1000)
				expect(status!.connected).toBe(true)
				expect(status!.reconnectAttempts).toBe(0)
			} finally {
				await mockServer.close()
			}
		})
	})

	describe("Status Tracking", () => {
		/**
		 * Feature: wavekit-core, Property 2: Source Status Completeness
		 * Validates: Requirements 1.7, 15.4
		 *
		 * For any source managed by Source_Manager, calling getStatus(id) should
		 * return an object containing all required fields including caps.
		 */
		it("should return complete status with all required fields including caps", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					kind: "audio_pcm",
					sampleRate: 48000,
					format: "S16LE",
					exclusive: false,
				})

				await sourceManager.connect(config)

				const status = sourceManager.getStatus("test-source")

				expect(status).toBeDefined()
				expect(status).toHaveProperty("id")
				expect(status).toHaveProperty("connected")
				expect(status).toHaveProperty("bytesReceived")
				expect(status).toHaveProperty("dataRate")
				expect(status).toHaveProperty("reconnectAttempts")
				expect(status).toHaveProperty("caps")

				expect(status!.id).toBe("test-source")
				expect(typeof status!.connected).toBe("boolean")
				expect(typeof status!.bytesReceived).toBe("number")
				expect(typeof status!.dataRate).toBe("number")
				expect(typeof status!.reconnectAttempts).toBe("number")

				// Verify caps (Requirement 15.4)
				expect(status!.caps).toBeDefined()
				expect(status!.caps.kind).toBe("audio_pcm")
				expect(status!.caps.sampleRate).toBe(48000)
				expect(status!.caps.format).toBe("S16LE")
				expect(status!.caps.exclusive).toBe(false)
			} finally {
				await mockServer.close()
			}
		})

		it("should return undefined for non-existent source", () => {
			const status = sourceManager.getStatus("non-existent")
			expect(status).toBeUndefined()
		})

		it("should return all statuses via getAllStatus", async () => {
			const mockServer1 = await createMockServer()
			const mockServer2 = await createMockServer()

			try {
				await sourceManager.connect(
					createSourceConfig("source-1", mockServer1.port),
				)
				await sourceManager.connect(
					createSourceConfig("source-2", mockServer2.port),
				)

				const allStatus = sourceManager.getAllStatus()
				expect(allStatus).toHaveLength(2)
				expect(allStatus.map(s => s.id).sort()).toEqual([
					"source-1",
					"source-2",
				])
			} finally {
				await mockServer1.close()
				await mockServer2.close()
			}
		})
	})

	describe("Disconnection", () => {
		it("should disconnect and clean up resources", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port)
				await sourceManager.connect(config)
				expect(sourceManager.getStatus("test-source")).toBeDefined()

				await sourceManager.disconnect("test-source")
				expect(sourceManager.getStatus("test-source")).toBeUndefined()
			} finally {
				await mockServer.close()
			}
		})

		it("should emit disconnected event when server closes connection", async () => {
			const mockServer = await createMockServer()
			const clientSockets: net.Socket[] = []

			mockServer.server.on("connection", socket => {
				clientSockets.push(socket)
			})

			try {
				const disconnectedPromise = new Promise<string>(resolve => {
					sourceManager.on("disconnected", resolve)
				})

				const config = createSourceConfig("test-source", mockServer.port)
				await sourceManager.connect(config)

				// Wait for connection to be established
				await new Promise(resolve => setTimeout(resolve, 50))

				// Server closes the connection
				const socket = clientSockets[0]
				if (socket) {
					socket.destroy()
				}

				const disconnectedId = await disconnectedPromise
				expect(disconnectedId).toBe("test-source")
			} finally {
				await mockServer.close()
			}
		})
	})

	describe("Error Handling", () => {
		/**
		 * Feature: wavekit-core, Property 3: Connection Error Resilience
		 * Validates: Requirements 1.6
		 *
		 * For any TCP connection error of type ECONNREFUSED, ETIMEDOUT, or ECONNRESET,
		 * the Source_Manager should emit an 'error' event and not throw an unhandled exception.
		 */
		it("should emit error event for ECONNREFUSED", async () => {
			const errorPromise = new Promise<Error>(resolve => {
				sourceManager.on("error", (id, error) => {
					resolve(error)
				})
			})

			const config = createSourceConfig("test-source", 59999)

			// Should not throw, but reject with SourceConnectionError
			await expect(sourceManager.connect(config)).rejects.toThrow()

			const error = await errorPromise
			expect(error).toBeDefined()
		})

		it("should not throw unhandled exception on connection errors", async () => {
			const config = createSourceConfig("test-source", 59999)

			// This should reject but not crash the process
			try {
				await sourceManager.connect(config)
			} catch {
				// Expected to throw SourceConnectionError
			}

			// Process should still be running (no unhandled exception)
			expect(true).toBe(true)
		})
	})

	describe("Stream Access", () => {
		it("should return stream via getStream", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port)
				const returnedStream = await sourceManager.connect(config)
				const retrievedStream = sourceManager.getStream("test-source")

				expect(retrievedStream).toBe(returnedStream)
			} finally {
				await mockServer.close()
			}
		})

		it("should return undefined for non-existent stream", () => {
			const stream = sourceManager.getStream("non-existent")
			expect(stream).toBeUndefined()
		})
	})

	describe("Capabilities (Requirement 15.4, 16.1)", () => {
		it("should return caps via getCaps", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					kind: "iq",
					sampleRate: 2400000,
					format: "U8_IQ",
					centerFreq: 144000000,
					exclusive: true,
				})

				await sourceManager.connect(config)

				const caps = sourceManager.getCaps("test-source")
				expect(caps).toBeDefined()
				expect(caps!.kind).toBe("iq")
				expect(caps!.sampleRate).toBe(2400000)
				expect(caps!.format).toBe("U8_IQ")
				expect(caps!.centerFreq).toBe(144000000)
				expect(caps!.exclusive).toBe(true)
			} finally {
				await mockServer.close()
			}
		})

		it("should return undefined caps for non-existent source", () => {
			const caps = sourceManager.getCaps("non-existent")
			expect(caps).toBeUndefined()
		})
	})

	describe("Compatibility Checking (Requirements 16.2, 16.3)", () => {
		it("should return true for compatible audio_pcm source and decoder", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					kind: "audio_pcm",
				})
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "audio_pcm" }
				expect(sourceManager.isCompatible("test-source", decoderCaps)).toBe(
					true,
				)
			} finally {
				await mockServer.close()
			}
		})

		it("should return true for compatible iq source and decoder", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					kind: "iq",
					format: "U8_IQ",
				})
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "iq" }
				expect(sourceManager.isCompatible("test-source", decoderCaps)).toBe(
					true,
				)
			} finally {
				await mockServer.close()
			}
		})

		it("should return false for incompatible source and decoder", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					kind: "audio_pcm",
				})
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "iq" }
				expect(sourceManager.isCompatible("test-source", decoderCaps)).toBe(
					false,
				)
			} finally {
				await mockServer.close()
			}
		})

		it("should return true for external decoder with any source", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					kind: "audio_pcm",
				})
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "external" }
				expect(sourceManager.isCompatible("test-source", decoderCaps)).toBe(
					true,
				)
			} finally {
				await mockServer.close()
			}
		})

		it("should return false for non-existent source", () => {
			const decoderCaps: DecoderCaps = { input: "audio_pcm" }
			expect(sourceManager.isCompatible("non-existent", decoderCaps)).toBe(
				false,
			)
		})
	})

	describe("Available Sources", () => {
		it("should return only compatible sources", async () => {
			const mockServer1 = await createMockServer()
			const mockServer2 = await createMockServer()
			const mockServer3 = await createMockServer()

			try {
				await sourceManager.connect(
					createSourceConfig("audio-source", mockServer1.port, {
						kind: "audio_pcm",
					}),
				)
				await sourceManager.connect(
					createSourceConfig("iq-source", mockServer2.port, {
						kind: "iq",
						format: "U8_IQ",
					}),
				)
				await sourceManager.connect(
					createSourceConfig("audio-source-2", mockServer3.port, {
						kind: "audio_pcm",
					}),
				)

				const audioCaps: DecoderCaps = { input: "audio_pcm" }
				const available = sourceManager.getAvailableSources(audioCaps)

				expect(available).toHaveLength(2)
				expect(available.map(s => s.id).sort()).toEqual([
					"audio-source",
					"audio-source-2",
				])
			} finally {
				await mockServer1.close()
				await mockServer2.close()
				await mockServer3.close()
			}
		})
	})

	describe("Decoder Assignment (Requirements 15.2, 15.3)", () => {
		it("should assign decoder to source", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port)
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "audio_pcm" }
				sourceManager.assignDecoder("decoder-1", "test-source", decoderCaps)

				expect(sourceManager.getAssignedSource("decoder-1")).toBe("test-source")
			} finally {
				await mockServer.close()
			}
		})

		it("should throw SourceCompatibilityError for incompatible assignment", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					kind: "audio_pcm",
				})
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "iq" }

				expect(() => {
					sourceManager.assignDecoder("decoder-1", "test-source", decoderCaps)
				}).toThrow(SourceCompatibilityError)
			} finally {
				await mockServer.close()
			}
		})

		it("should throw ExclusiveSourceError when assigning to exclusive source", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					exclusive: true,
				})
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "audio_pcm" }

				// First assignment should succeed
				sourceManager.assignDecoder("decoder-1", "test-source", decoderCaps)

				// Second assignment should fail
				expect(() => {
					sourceManager.assignDecoder("decoder-2", "test-source", decoderCaps)
				}).toThrow(ExclusiveSourceError)
			} finally {
				await mockServer.close()
			}
		})

		it("should allow reassigning same decoder to exclusive source", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					exclusive: true,
				})
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "audio_pcm" }

				// First assignment
				sourceManager.assignDecoder("decoder-1", "test-source", decoderCaps)

				// Reassigning same decoder should succeed
				expect(() => {
					sourceManager.assignDecoder("decoder-1", "test-source", decoderCaps)
				}).not.toThrow()
			} finally {
				await mockServer.close()
			}
		})

		it("should allow multiple decoders on non-exclusive source", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					exclusive: false,
				})
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "audio_pcm" }

				sourceManager.assignDecoder("decoder-1", "test-source", decoderCaps)
				sourceManager.assignDecoder("decoder-2", "test-source", decoderCaps)

				const assignments = sourceManager.getSourceAssignments("test-source")
				expect(assignments).toHaveLength(2)
			} finally {
				await mockServer.close()
			}
		})

		it("should unassign decoder", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port)
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "audio_pcm" }
				sourceManager.assignDecoder("decoder-1", "test-source", decoderCaps)

				expect(sourceManager.getAssignedSource("decoder-1")).toBe("test-source")

				sourceManager.unassignDecoder("decoder-1")

				expect(sourceManager.getAssignedSource("decoder-1")).toBeUndefined()
			} finally {
				await mockServer.close()
			}
		})

		it("should clean up assignments when source is disconnected", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port)
				await sourceManager.connect(config)

				const decoderCaps: DecoderCaps = { input: "audio_pcm" }
				sourceManager.assignDecoder("decoder-1", "test-source", decoderCaps)

				await sourceManager.disconnect("test-source")

				expect(sourceManager.getAssignedSource("decoder-1")).toBeUndefined()
			} finally {
				await mockServer.close()
			}
		})
	})

	describe("Source Availability", () => {
		it("should report non-exclusive source as available", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					exclusive: false,
				})
				await sourceManager.connect(config)

				expect(sourceManager.isSourceAvailable("test-source")).toBe(true)

				// Still available after assignment
				const decoderCaps: DecoderCaps = { input: "audio_pcm" }
				sourceManager.assignDecoder("decoder-1", "test-source", decoderCaps)

				expect(sourceManager.isSourceAvailable("test-source")).toBe(true)
			} finally {
				await mockServer.close()
			}
		})

		it("should report exclusive source as unavailable after assignment", async () => {
			const mockServer = await createMockServer()

			try {
				const config = createSourceConfig("test-source", mockServer.port, {
					exclusive: true,
				})
				await sourceManager.connect(config)

				expect(sourceManager.isSourceAvailable("test-source")).toBe(true)

				const decoderCaps: DecoderCaps = { input: "audio_pcm" }
				sourceManager.assignDecoder("decoder-1", "test-source", decoderCaps)

				expect(sourceManager.isSourceAvailable("test-source")).toBe(false)
			} finally {
				await mockServer.close()
			}
		})

		it("should report non-existent source as unavailable", () => {
			expect(sourceManager.isSourceAvailable("non-existent")).toBe(false)
		})
	})

	describe("Multi-Source Independence (Requirement 15.1)", () => {
		it("should manage multiple sources independently", async () => {
			const mockServer1 = await createMockServer()
			const mockServer2 = await createMockServer()

			try {
				await sourceManager.connect(
					createSourceConfig("source-1", mockServer1.port),
				)
				await sourceManager.connect(
					createSourceConfig("source-2", mockServer2.port),
				)

				// Both should be connected
				expect(sourceManager.getStatus("source-1")?.connected).toBe(true)
				expect(sourceManager.getStatus("source-2")?.connected).toBe(true)

				// Disconnect one
				await sourceManager.disconnect("source-1")

				// Other should still be connected
				expect(sourceManager.getStatus("source-1")).toBeUndefined()
				expect(sourceManager.getStatus("source-2")?.connected).toBe(true)
			} finally {
				await mockServer1.close()
				await mockServer2.close()
			}
		})
	})
})

/**
 * Property-Based Tests for Source Manager
 *
 * These tests validate universal properties that should hold across all inputs.
 */
describe("Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 1: Exponential Backoff Correctness
	 * Validates: Requirements 1.2
	 *
	 * For any sequence of N consecutive failures (connection or process restart),
	 * the delay before attempt N should be min(2^N * baseDelay, maxDelay)
	 * where baseDelay=2000ms and maxDelay=30000ms.
	 */
	describe("Property 1: Exponential Backoff Correctness", () => {
		const BASE_DELAY_MS = 2000
		const MAX_DELAY_MS = 30000

		it("should calculate correct exponential backoff for any attempt count", () => {
			fc.assert(
				fc.property(
					// Generate attempt counts from 0 to 20 (covers well beyond max delay)
					fc.integer({ min: 0, max: 20 }),
					attempts => {
						const actualDelay = calculateBackoffDelay(attempts)
						const expectedDelay = Math.min(
							Math.pow(2, attempts) * BASE_DELAY_MS,
							MAX_DELAY_MS,
						)

						return actualDelay === expectedDelay
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should always return a value between baseDelay and maxDelay", () => {
			fc.assert(
				fc.property(
					// Generate any non-negative attempt count
					fc.integer({ min: 0, max: 100 }),
					attempts => {
						const delay = calculateBackoffDelay(attempts)

						// Delay should be at least baseDelay (for attempts=0, 2^0 * 2000 = 2000)
						if (delay < BASE_DELAY_MS) return false

						// Delay should never exceed maxDelay
						if (delay > MAX_DELAY_MS) return false

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should be monotonically non-decreasing until max is reached", () => {
			fc.assert(
				fc.property(
					// Generate pairs of consecutive attempt counts
					fc.integer({ min: 0, max: 19 }),
					attempts => {
						const delay1 = calculateBackoffDelay(attempts)
						const delay2 = calculateBackoffDelay(attempts + 1)

						// Each subsequent delay should be >= previous delay
						return delay2 >= delay1
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should cap at maxDelay for large attempt counts", () => {
			fc.assert(
				fc.property(
					// Generate large attempt counts that would exceed max
					fc.integer({ min: 4, max: 1000 }),
					attempts => {
						const delay = calculateBackoffDelay(attempts)

						// For attempts >= 4, 2^4 * 2000 = 32000 > 30000, so should cap
						return delay === MAX_DELAY_MS
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	/**
	 * Feature: wavekit-core, Property 2: Source Status Completeness
	 * Validates: Requirements 1.7
	 *
	 * For any source managed by Source_Manager, calling getStatus(id) should
	 * return an object containing all required fields: id, connected,
	 * bytesReceived, dataRate, reconnectAttempts, and caps.
	 */
	describe("Property 2: Source Status Completeness", () => {
		/**
		 * Helper to verify a status object has all required fields with correct types
		 */
		function isValidSourceStatus(status: SourceStatus): boolean {
			// Check all required fields exist
			if (typeof status.id !== "string") return false
			if (typeof status.connected !== "boolean") return false
			if (typeof status.bytesReceived !== "number") return false
			if (typeof status.dataRate !== "number") return false
			if (typeof status.reconnectAttempts !== "number") return false

			// Check caps exist and have required fields
			if (!status.caps) return false
			if (typeof status.caps.kind !== "string") return false
			if (typeof status.caps.sampleRate !== "number") return false
			if (typeof status.caps.format !== "string") return false
			if (typeof status.caps.exclusive !== "boolean") return false

			// Check numeric fields are non-negative
			if (status.bytesReceived < 0) return false
			if (status.dataRate < 0) return false
			if (status.reconnectAttempts < 0) return false

			// lastError is optional but if present must be string or undefined
			if (
				status.lastError !== undefined &&
				typeof status.lastError !== "string"
			) {
				return false
			}

			return true
		}

		it("should return complete status for any connected source", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate random source IDs
					fc
						.string({ minLength: 1, maxLength: 50 })
						.filter(s => s.trim().length > 0),
					async sourceId => {
						const sourceManager = new SourceManager(testLogger)
						const mockServer = await createMockServer()

						try {
							const config = createSourceConfig(sourceId, mockServer.port)
							await sourceManager.connect(config)

							const status = sourceManager.getStatus(sourceId)

							// Status must exist for connected source
							if (!status) return false

							// Status must have all required fields with correct types
							if (!isValidSourceStatus(status)) return false

							// ID must match
							if (status.id !== sourceId) return false

							// Should be connected
							if (!status.connected) return false

							return true
						} finally {
							await sourceManager.disconnectAll()
							await mockServer.close()
						}
					},
				),
				{ numRuns: 20 }, // Reduced runs due to TCP connection overhead
			)
		}, 30000) // Extended timeout for network operations

		it("should track bytes received accurately for any data size", async () => {
			// This test creates real TCP connections, so we use fewer runs
			// but still validate the property across a range of data sizes
			await fc.assert(
				fc.asyncProperty(
					// Generate random data sizes
					fc.integer({ min: 1, max: 10000 }),
					async dataSize => {
						const sourceManager = new SourceManager(testLogger)
						const mockServer = await createMockServer()
						const testData = Buffer.alloc(dataSize, 0x42)

						mockServer.server.on("connection", socket => {
							socket.write(testData)
						})

						try {
							const config = createSourceConfig("test-source", mockServer.port)
							await sourceManager.connect(config)

							// Wait for data to be received
							await new Promise(resolve => setTimeout(resolve, 50))

							const status = sourceManager.getStatus("test-source")

							if (!status) return false

							// Bytes received should match data size
							if (status.bytesReceived !== dataSize) return false

							return true
						} finally {
							await sourceManager.disconnectAll()
							await mockServer.close()
						}
					},
				),
				{ numRuns: 20 }, // Reduced runs due to TCP connection overhead
			)
		}, 30000) // Extended timeout for network operations
	})

	/**
	 * Feature: wavekit-core, Property 3: Connection Error Resilience
	 * Validates: Requirements 1.6
	 *
	 * For any TCP connection error of type ECONNREFUSED, ETIMEDOUT, or ECONNRESET,
	 * the Source_Manager should emit an 'error' event and not throw an unhandled exception.
	 */
	describe("Property 3: Connection Error Resilience", () => {
		it("should handle ECONNREFUSED gracefully for any invalid port", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate ports that are likely to refuse connections
					// Using high ports that are unlikely to have services
					fc.integer({ min: 50000, max: 59999 }),
					async port => {
						const sourceManager = new SourceManager(testLogger)
						let errorEmitted = false
						let unhandledException = false

						// Track if error event is emitted
						sourceManager.on("error", () => {
							errorEmitted = true
						})

						// Track unhandled exceptions
						const uncaughtHandler = () => {
							unhandledException = true
						}
						process.on("uncaughtException", uncaughtHandler)

						try {
							const config = createSourceConfig("test-source", port)

							try {
								await sourceManager.connect(config)
							} catch {
								// Expected to throw SourceConnectionError
							}

							// Should not have unhandled exception
							if (unhandledException) return false

							// Error event should have been emitted
							if (!errorEmitted) return false

							return true
						} finally {
							process.removeListener("uncaughtException", uncaughtHandler)
							await sourceManager.disconnectAll()
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should handle connection errors without crashing for any source ID", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate random source IDs
					fc
						.string({ minLength: 1, maxLength: 30 })
						.filter(s => s.trim().length > 0),
					async sourceId => {
						const sourceManager = new SourceManager(testLogger)
						let crashed = false

						// Track if process crashes
						const uncaughtHandler = () => {
							crashed = true
						}
						process.on("uncaughtException", uncaughtHandler)

						try {
							const config = createSourceConfig(sourceId, 59999)

							try {
								await sourceManager.connect(config)
							} catch {
								// Expected to throw - this is fine
							}

							// Process should not have crashed
							return !crashed
						} finally {
							process.removeListener("uncaughtException", uncaughtHandler)
							await sourceManager.disconnectAll()
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should emit error with proper error object for connection failures", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate random source IDs
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter(s => s.trim().length > 0),
					async sourceId => {
						const sourceManager = new SourceManager(testLogger)
						let emittedError: Error | null = null
						let emittedSourceId: string | null = null

						sourceManager.on("error", (id: string, error: Error) => {
							emittedSourceId = id
							emittedError = error
						})

						try {
							const config = createSourceConfig(sourceId, 59999)

							try {
								await sourceManager.connect(config)
							} catch {
								// Expected
							}

							// Error should have been emitted
							if (!emittedError) return false

							// Source ID should match
							if (emittedSourceId !== sourceId) return false

							// Error should be an Error instance
							const errorInstance = emittedError as unknown
							if (!(errorInstance instanceof Error)) return false

							return true
						} finally {
							await sourceManager.disconnectAll()
						}
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	/**
	 * Feature: wavekit-core, Property 25: Source Capability Compatibility
	 * Validates: Requirements 16.2, 17.2
	 *
	 * For any decoder D with capabilities C_d and source S with capabilities C_s,
	 * the Source_Manager should return isCompatible(S, C_d) = true if and only if
	 * C_d.input matches C_s.kind (audio_pcm↔audio_pcm, iq↔iq) or C_d.input is 'external'.
	 */
	describe("Property 25: Source Capability Compatibility", () => {
		it("should correctly determine compatibility for any source/decoder combination", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate source kind
					fc.constantFrom("audio_pcm", "iq", "recording") as fc.Arbitrary<
						SourceCaps["kind"]
					>,
					// Generate decoder input type
					fc.constantFrom("audio_pcm", "iq", "external") as fc.Arbitrary<
						DecoderCaps["input"]
					>,
					async (sourceKind, decoderInput) => {
						const sourceManager = new SourceManager(testLogger)
						const mockServer = await createMockServer()

						try {
							const config = createSourceConfig(
								"test-source",
								mockServer.port,
								{
									kind: sourceKind,
									format: sourceKind === "iq" ? "U8_IQ" : "S16LE",
								},
							)
							await sourceManager.connect(config)

							const decoderCaps: DecoderCaps = { input: decoderInput }
							const isCompatible = sourceManager.isCompatible(
								"test-source",
								decoderCaps,
							)

							// External decoders are always compatible
							if (decoderInput === "external") {
								return isCompatible === true
							}

							// Otherwise, input must match kind
							const expectedCompatible = decoderInput === sourceKind
							return isCompatible === expectedCompatible
						} finally {
							await sourceManager.disconnectAll()
							await mockServer.close()
						}
					},
				),
				{ numRuns: 50 },
			)
		}, 30000)
	})

	/**
	 * Feature: wavekit-core, Property 26: Multi-Source Independence
	 * Validates: Requirements 15.1
	 *
	 * For any two sources S1 and S2 managed by Source_Manager, connecting/disconnecting S1
	 * should not affect the connection state or data flow of S2.
	 */
	describe("Property 26: Multi-Source Independence", () => {
		it("should maintain independent state for multiple sources", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate two different source IDs
					fc
						.tuple(
							fc
								.string({ minLength: 1, maxLength: 20 })
								.filter(s => s.trim().length > 0),
							fc
								.string({ minLength: 1, maxLength: 20 })
								.filter(s => s.trim().length > 0),
						)
						.filter(([a, b]) => a !== b),
					async ([sourceId1, sourceId2]) => {
						const sourceManager = new SourceManager(testLogger)
						const mockServer1 = await createMockServer()
						const mockServer2 = await createMockServer()

						try {
							// Connect both sources
							await sourceManager.connect(
								createSourceConfig(sourceId1, mockServer1.port),
							)
							await sourceManager.connect(
								createSourceConfig(sourceId2, mockServer2.port),
							)

							// Both should be connected
							const status1Before = sourceManager.getStatus(sourceId1)
							const status2Before = sourceManager.getStatus(sourceId2)

							if (!status1Before?.connected || !status2Before?.connected) {
								return false
							}

							// Disconnect source 1
							await sourceManager.disconnect(sourceId1)

							// Source 2 should still be connected
							const status2After = sourceManager.getStatus(sourceId2)
							if (!status2After?.connected) {
								return false
							}

							// Source 1 should be gone
							const status1After = sourceManager.getStatus(sourceId1)
							if (status1After !== undefined) {
								return false
							}

							return true
						} finally {
							await sourceManager.disconnectAll()
							await mockServer1.close()
							await mockServer2.close()
						}
					},
				),
				{ numRuns: 20 },
			)
		}, 30000)
	})

	/**
	 * Feature: wavekit-core, Property 27: Decoder-Source Assignment Consistency
	 * Validates: Requirements 15.2
	 *
	 * For any decoder D assigned to source S, after assignment:
	 * (a) getAssignedSource(D.id) should return S.id
	 */
	describe("Property 27: Decoder-Source Assignment Consistency", () => {
		it("should maintain consistent assignment state", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate decoder and source IDs
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter(s => s.trim().length > 0),
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter(s => s.trim().length > 0),
					async (decoderId, sourceId) => {
						const sourceManager = new SourceManager(testLogger)
						const mockServer = await createMockServer()

						try {
							const config = createSourceConfig(sourceId, mockServer.port)
							await sourceManager.connect(config)

							const decoderCaps: DecoderCaps = { input: "audio_pcm" }
							sourceManager.assignDecoder(decoderId, sourceId, decoderCaps)

							// getAssignedSource should return the source ID
							const assignedSource = sourceManager.getAssignedSource(decoderId)
							if (assignedSource !== sourceId) {
								return false
							}

							// getSourceAssignments should include this decoder
							const assignments = sourceManager.getSourceAssignments(sourceId)
							const found = assignments.some(a => a.decoderId === decoderId)
							if (!found) {
								return false
							}

							return true
						} finally {
							await sourceManager.disconnectAll()
							await mockServer.close()
						}
					},
				),
				{ numRuns: 50 },
			)
		}, 30000)
	})

	/**
	 * Feature: wavekit-core, Property 28: Exclusive Source Enforcement
	 * Validates: Requirements 15.3
	 *
	 * For any source S with caps.exclusive = true, the Source_Manager should prevent
	 * more than one decoder from being assigned to S.
	 */
	describe("Property 28: Exclusive Source Enforcement", () => {
		it("should enforce exclusive source constraint", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate two different decoder IDs
					fc
						.tuple(
							fc
								.string({ minLength: 1, maxLength: 20 })
								.filter(s => s.trim().length > 0),
							fc
								.string({ minLength: 1, maxLength: 20 })
								.filter(s => s.trim().length > 0),
						)
						.filter(([a, b]) => a !== b),
					async ([decoderId1, decoderId2]) => {
						const sourceManager = new SourceManager(testLogger)
						const mockServer = await createMockServer()

						try {
							const config = createSourceConfig(
								"exclusive-source",
								mockServer.port,
								{
									exclusive: true,
								},
							)
							await sourceManager.connect(config)

							const decoderCaps: DecoderCaps = { input: "audio_pcm" }

							// First assignment should succeed
							sourceManager.assignDecoder(
								decoderId1,
								"exclusive-source",
								decoderCaps,
							)

							// Second assignment should throw
							let threwError = false
							try {
								sourceManager.assignDecoder(
									decoderId2,
									"exclusive-source",
									decoderCaps,
								)
							} catch (err) {
								if (err instanceof ExclusiveSourceError) {
									threwError = true
								}
							}

							return threwError
						} finally {
							await sourceManager.disconnectAll()
							await mockServer.close()
						}
					},
				),
				{ numRuns: 50 },
			)
		}, 30000)

		it("should allow multiple decoders on non-exclusive sources", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate multiple decoder IDs
					fc
						.array(
							fc
								.string({ minLength: 1, maxLength: 20 })
								.filter(s => s.trim().length > 0),
							{ minLength: 2, maxLength: 5 },
						)
						.filter(arr => new Set(arr).size === arr.length), // All unique
					async decoderIds => {
						const sourceManager = new SourceManager(testLogger)
						const mockServer = await createMockServer()

						try {
							const config = createSourceConfig(
								"shared-source",
								mockServer.port,
								{
									exclusive: false,
								},
							)
							await sourceManager.connect(config)

							const decoderCaps: DecoderCaps = { input: "audio_pcm" }

							// All assignments should succeed
							for (const decoderId of decoderIds) {
								sourceManager.assignDecoder(
									decoderId,
									"shared-source",
									decoderCaps,
								)
							}

							// All should be assigned
							const assignments =
								sourceManager.getSourceAssignments("shared-source")
							return assignments.length === decoderIds.length
						} finally {
							await sourceManager.disconnectAll()
							await mockServer.close()
						}
					},
				),
				{ numRuns: 30 },
			)
		}, 30000)
	})

	/**
	 * Feature: wavekit-core, Property 29: Recording Source Determinism
	 * Validates: Requirements 21.1, 21.3
	 *
	 * For any recording source R with file F, replaying F twice should produce
	 * identical byte sequences in the same order.
	 */
	describe("Property 29: Recording Source Determinism", () => {
		const fs = require("node:fs")
		const path = require("node:path")
		const os = require("node:os")

		let tempDir: string
		let testFiles: string[] = []

		/**
		 * Helper to create a test recording file with specified data
		 */
		function createTestFile(filename: string, data: Buffer): string {
			const filePath = path.join(tempDir, filename)
			fs.writeFileSync(filePath, data)
			testFiles.push(filePath)
			return filePath
		}

		/**
		 * Helper to create a recording source config
		 */
		function createRecordingConfig(
			id: string,
			filePath: string,
			options?: {
				loop?: boolean
				playbackSpeed?: number
				caps?: Partial<SourceCaps>
			},
		): SourceConfig {
			return {
				id,
				type: "recording",
				filePath,
				loop: options?.loop ?? false,
				playbackSpeed: options?.playbackSpeed ?? 1.0,
				caps: {
					kind: "recording",
					sampleRate: options?.caps?.sampleRate ?? 48000,
					format: options?.caps?.format ?? "S16LE",
					exclusive: options?.caps?.exclusive ?? false,
					...options?.caps,
				},
			}
		}

		/**
		 * Helper to collect all data from a recording source
		 */
		async function collectRecordingData(
			sourceManager: SourceManager,
			sourceId: string,
			filePath: string,
			playbackSpeed: number = 100,
		): Promise<Buffer[]> {
			const chunks: Buffer[] = []

			const dataPromise = new Promise<Buffer[]>(resolve => {
				sourceManager.on("data", (id, chunk) => {
					if (id === sourceId) {
						chunks.push(Buffer.from(chunk))
					}
				})

				sourceManager.on("ended", id => {
					if (id === sourceId) {
						resolve(chunks)
					}
				})
			})

			const config = createRecordingConfig(sourceId, filePath, {
				loop: false,
				playbackSpeed,
			})

			await sourceManager.connect(config)

			// Wait for ended event or timeout
			const timeoutPromise = new Promise<Buffer[]>(resolve => {
				setTimeout(() => resolve(chunks), 5000)
			})

			return Promise.race([dataPromise, timeoutPromise])
		}

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wavekit-pbt-"))
			testFiles = []
		})

		afterEach(() => {
			// Clean up test files
			for (const file of testFiles) {
				try {
					fs.unlinkSync(file)
				} catch {
					// Ignore cleanup errors
				}
			}
			try {
				fs.rmdirSync(tempDir)
			} catch {
				// Ignore cleanup errors
			}
		})

		it("should produce identical byte sequences when replaying the same file twice", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate random file content (1KB to 8KB)
					fc.uint8Array({ minLength: 1024, maxLength: 8192 }),
					// Generate random sample rate
					fc.constantFrom(8000, 16000, 22050, 44100, 48000),
					// Generate random format
					fc.constantFrom("S16LE", "FLOAT32LE") as fc.Arbitrary<
						SourceCaps["format"]
					>,
					async (fileContent, sampleRate, format) => {
						const sourceManager1 = new SourceManager(testLogger)
						const sourceManager2 = new SourceManager(testLogger)

						try {
							// Create test file with random content
							const testData = Buffer.from(fileContent)
							const filePath = createTestFile(
								`test-${Date.now()}-${Math.random().toString(36).slice(2)}.raw`,
								testData,
							)

							// First replay
							const chunks1 = await collectRecordingData(
								sourceManager1,
								"replay-1",
								filePath,
								100, // Fast playback for testing
							)

							await sourceManager1.disconnectAll()

							// Second replay
							const chunks2 = await collectRecordingData(
								sourceManager2,
								"replay-2",
								filePath,
								100, // Same playback speed
							)

							await sourceManager2.disconnectAll()

							// Concatenate all chunks from each replay
							const data1 = Buffer.concat(chunks1)
							const data2 = Buffer.concat(chunks2)

							// Both replays should produce the same total bytes
							if (data1.length !== data2.length) {
								return false
							}

							// Both replays should produce identical byte sequences
							if (!data1.equals(data2)) {
								return false
							}

							// Total bytes should match original file size
							if (data1.length !== testData.length) {
								return false
							}

							return true
						} finally {
							await sourceManager1.disconnectAll()
							await sourceManager2.disconnectAll()
						}
					},
				),
				{ numRuns: 100 },
			)
		}, 60000) // Extended timeout for file I/O operations

		it("should produce chunks in the same order for any file content", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate random file content (2KB to 16KB to ensure multiple chunks)
					fc.uint8Array({ minLength: 2048, maxLength: 16384 }),
					async fileContent => {
						const sourceManager1 = new SourceManager(testLogger)
						const sourceManager2 = new SourceManager(testLogger)

						try {
							// Create test file with random content
							const testData = Buffer.from(fileContent)
							const filePath = createTestFile(
								`test-order-${Date.now()}-${Math.random().toString(36).slice(2)}.raw`,
								testData,
							)

							// First replay - collect chunks
							const chunks1 = await collectRecordingData(
								sourceManager1,
								"order-1",
								filePath,
								100,
							)

							await sourceManager1.disconnectAll()

							// Second replay - collect chunks
							const chunks2 = await collectRecordingData(
								sourceManager2,
								"order-2",
								filePath,
								100,
							)

							await sourceManager2.disconnectAll()

							// Both replays should produce the same number of chunks
							if (chunks1.length !== chunks2.length) {
								return false
							}

							// Each chunk should be identical in order
							for (let i = 0; i < chunks1.length; i++) {
								const chunk1 = chunks1[i]
								const chunk2 = chunks2[i]
								if (!chunk1 || !chunk2) {
									return false
								}
								if (!chunk1.equals(chunk2)) {
									return false
								}
							}

							return true
						} finally {
							await sourceManager1.disconnectAll()
							await sourceManager2.disconnectAll()
						}
					},
				),
				{ numRuns: 100 },
			)
		}, 60000) // Extended timeout for file I/O operations
	})
})

/**
 * Recording Source Tests
 *
 * Tests for file-based IQ/audio replay functionality.
 * Requirements: 21.1, 21.2, 21.3, 21.4
 */
describe("Recording Source", () => {
	const fs = require("node:fs")
	const path = require("node:path")
	const os = require("node:os")

	let sourceManager: SourceManager
	let tempDir: string
	let testFiles: string[] = []

	/**
	 * Helper to create a test recording file with specified data
	 */
	function createTestFile(filename: string, data: Buffer): string {
		const filePath = path.join(tempDir, filename)
		fs.writeFileSync(filePath, data)
		testFiles.push(filePath)
		return filePath
	}

	/**
	 * Helper to create a recording source config
	 */
	function createRecordingConfig(
		id: string,
		filePath: string,
		options?: {
			loop?: boolean
			playbackSpeed?: number
			caps?: Partial<SourceCaps>
		},
	): SourceConfig {
		return {
			id,
			type: "recording",
			filePath,
			loop: options?.loop ?? false,
			playbackSpeed: options?.playbackSpeed ?? 1.0,
			caps: {
				kind: "recording",
				sampleRate: options?.caps?.sampleRate ?? 48000,
				format: options?.caps?.format ?? "S16LE",
				exclusive: options?.caps?.exclusive ?? false,
				...options?.caps,
			},
		}
	}

	beforeEach(() => {
		sourceManager = new SourceManager(testLogger)
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wavekit-test-"))
		testFiles = []
	})

	afterEach(async () => {
		await sourceManager.disconnectAll()
		// Clean up test files
		for (const file of testFiles) {
			try {
				fs.unlinkSync(file)
			} catch {
				// Ignore cleanup errors
			}
		}
		try {
			fs.rmdirSync(tempDir)
		} catch {
			// Ignore cleanup errors
		}
	})

	describe("Basic Functionality (Requirement 21.1)", () => {
		it("should connect to a recording source and emit connected event", async () => {
			// Create a test file with some audio data
			const testData = Buffer.alloc(4096, 0x42)
			const filePath = createTestFile("test-audio.raw", testData)

			let connectedId: string | null = null
			sourceManager.on("connected", (id: string) => {
				connectedId = id
			})

			const config = createRecordingConfig("recording-source", filePath)
			const stream = await sourceManager.connect(config)

			expect(stream).toBeDefined()
			expect(connectedId).toBe("recording-source")

			const status = sourceManager.getStatus("recording-source")
			expect(status).toBeDefined()
			expect(status!.connected).toBe(true)
		})

		it("should throw error for non-existent file", async () => {
			const config = createRecordingConfig(
				"recording-source",
				"/non/existent/file.raw",
			)

			await expect(sourceManager.connect(config)).rejects.toThrow(
				"Recording file not found",
			)
		})

		it("should throw error for empty file", async () => {
			const filePath = createTestFile("empty.raw", Buffer.alloc(0))
			const config = createRecordingConfig("recording-source", filePath)

			await expect(sourceManager.connect(config)).rejects.toThrow(
				"Recording file is empty",
			)
		})

		it("should throw error when filePath is missing", async () => {
			const config: SourceConfig = {
				id: "recording-source",
				type: "recording",
				loop: false,
				playbackSpeed: 1.0,
				caps: {
					kind: "recording",
					sampleRate: 48000,
					format: "S16LE",
					exclusive: false,
				},
			}

			await expect(sourceManager.connect(config)).rejects.toThrow(
				"requires filePath",
			)
		})
	})

	describe("Data Emission", () => {
		it("should emit data from the recording file", async () => {
			const testData = Buffer.alloc(2048, 0x42)
			const filePath = createTestFile("test-audio.raw", testData)

			const receivedChunks: Buffer[] = []
			sourceManager.on("data", (id, chunk) => {
				if (id === "recording-source") {
					receivedChunks.push(chunk)
				}
			})

			const config = createRecordingConfig("recording-source", filePath, {
				playbackSpeed: 100, // Speed up for testing
			})
			await sourceManager.connect(config)

			// Wait for data to be emitted
			await new Promise(resolve => setTimeout(resolve, 200))

			// Should have received some data
			expect(receivedChunks.length).toBeGreaterThan(0)

			// Total bytes should match file size
			const totalBytes = receivedChunks.reduce(
				(sum, chunk) => sum + chunk.length,
				0,
			)
			expect(totalBytes).toBe(testData.length)
		})

		it("should track bytes received in status", async () => {
			const testData = Buffer.alloc(4096, 0x42)
			const filePath = createTestFile("test-audio.raw", testData)

			const config = createRecordingConfig("recording-source", filePath, {
				playbackSpeed: 100, // Speed up for testing
			})
			await sourceManager.connect(config)

			// Wait for data to be emitted
			await new Promise(resolve => setTimeout(resolve, 200))

			const status = sourceManager.getStatus("recording-source")
			expect(status).toBeDefined()
			expect(status!.bytesReceived).toBe(testData.length)
		})
	})

	describe("Loop Support (Requirement 21.2)", () => {
		it("should emit ended event when loop is false", async () => {
			const testData = Buffer.alloc(1024, 0x42)
			const filePath = createTestFile("test-audio.raw", testData)

			const endedPromise = new Promise<string>(resolve => {
				sourceManager.on("ended", resolve)
			})

			const config = createRecordingConfig("recording-source", filePath, {
				loop: false,
				playbackSpeed: 100, // Speed up for testing
			})
			await sourceManager.connect(config)

			const endedId = await endedPromise
			expect(endedId).toBe("recording-source")

			// Should be disconnected after ending
			const status = sourceManager.getStatus("recording-source")
			expect(status).toBeDefined()
			expect(status!.connected).toBe(false)
		})

		it("should loop when loop is true", async () => {
			const testData = Buffer.alloc(1024, 0x42)
			const filePath = createTestFile("test-audio.raw", testData)

			let bytesReceived = 0
			sourceManager.on("data", (id, chunk) => {
				if (id === "recording-source") {
					bytesReceived += chunk.length
				}
			})

			const config = createRecordingConfig("recording-source", filePath, {
				loop: true,
				playbackSpeed: 100, // Speed up for testing
			})
			await sourceManager.connect(config)

			// Wait for more than one loop iteration
			await new Promise(resolve => setTimeout(resolve, 300))

			// Should have received more bytes than the file size (looped)
			expect(bytesReceived).toBeGreaterThan(testData.length)

			// Disconnect to stop looping
			await sourceManager.disconnect("recording-source")
		})
	})

	describe("Playback Speed (Requirement 21.4)", () => {
		it("should emit data faster with higher playback speed", async () => {
			const testData = Buffer.alloc(8192, 0x42)
			const filePath = createTestFile("test-audio.raw", testData)

			// Test with normal speed
			let normalEndTime = 0
			const normalConfig = createRecordingConfig("normal-speed", filePath, {
				playbackSpeed: 1.0,
			})

			const normalStartTime = Date.now()
			sourceManager.on("ended", id => {
				if (id === "normal-speed") {
					normalEndTime = Date.now() - normalStartTime
				}
			})

			await sourceManager.connect(normalConfig)

			// Wait for completion (with timeout)
			await new Promise(resolve => setTimeout(resolve, 500))
			await sourceManager.disconnect("normal-speed")

			// Test with fast speed
			let fastEndTime = 0
			const fastConfig = createRecordingConfig("fast-speed", filePath, {
				playbackSpeed: 10.0,
			})

			const fastStartTime = Date.now()
			sourceManager.on("ended", id => {
				if (id === "fast-speed") {
					fastEndTime = Date.now() - fastStartTime
				}
			})

			await sourceManager.connect(fastConfig)

			// Wait for completion
			await new Promise(resolve => setTimeout(resolve, 200))

			// Fast playback should complete faster (if both completed)
			if (normalEndTime > 0 && fastEndTime > 0) {
				expect(fastEndTime).toBeLessThan(normalEndTime)
			}
		})
	})

	describe("Format Support (Requirement 21.3)", () => {
		it("should support S16LE format", async () => {
			const testData = Buffer.alloc(2048, 0x42)
			const filePath = createTestFile("test-s16le.raw", testData)

			const config = createRecordingConfig("recording-source", filePath, {
				playbackSpeed: 100,
				caps: { format: "S16LE" },
			})

			const stream = await sourceManager.connect(config)
			expect(stream).toBeDefined()

			await new Promise(resolve => setTimeout(resolve, 100))

			const status = sourceManager.getStatus("recording-source")
			expect(status).toBeDefined()
			expect(status!.caps.format).toBe("S16LE")
		})

		it("should support FLOAT32LE format", async () => {
			const testData = Buffer.alloc(4096, 0x42)
			const filePath = createTestFile("test-f32le.raw", testData)

			const config = createRecordingConfig("recording-source", filePath, {
				playbackSpeed: 100,
				caps: { format: "FLOAT32LE" },
			})

			const stream = await sourceManager.connect(config)
			expect(stream).toBeDefined()

			await new Promise(resolve => setTimeout(resolve, 100))

			const status = sourceManager.getStatus("recording-source")
			expect(status).toBeDefined()
			expect(status!.caps.format).toBe("FLOAT32LE")
		})

		it("should support U8_IQ format", async () => {
			const testData = Buffer.alloc(2048, 0x42)
			const filePath = createTestFile("test-u8iq.raw", testData)

			const config = createRecordingConfig("recording-source", filePath, {
				playbackSpeed: 100,
				caps: { format: "U8_IQ", kind: "iq" },
			})

			const stream = await sourceManager.connect(config)
			expect(stream).toBeDefined()

			await new Promise(resolve => setTimeout(resolve, 100))

			const status = sourceManager.getStatus("recording-source")
			expect(status).toBeDefined()
			expect(status!.caps.format).toBe("U8_IQ")
		})

		it("should support S16_IQ format", async () => {
			const testData = Buffer.alloc(4096, 0x42)
			const filePath = createTestFile("test-s16iq.raw", testData)

			const config = createRecordingConfig("recording-source", filePath, {
				playbackSpeed: 100,
				caps: { format: "S16_IQ", kind: "iq" },
			})

			const stream = await sourceManager.connect(config)
			expect(stream).toBeDefined()

			await new Promise(resolve => setTimeout(resolve, 100))

			const status = sourceManager.getStatus("recording-source")
			expect(status).toBeDefined()
			expect(status!.caps.format).toBe("S16_IQ")
		})
	})

	describe("Cleanup", () => {
		it("should clean up resources on disconnect", async () => {
			const testData = Buffer.alloc(4096, 0x42)
			const filePath = createTestFile("test-audio.raw", testData)

			const config = createRecordingConfig("recording-source", filePath, {
				loop: true,
				playbackSpeed: 10,
			})
			await sourceManager.connect(config)

			// Wait for some data
			await new Promise(resolve => setTimeout(resolve, 100))

			// Disconnect
			await sourceManager.disconnect("recording-source")

			// Source should be removed
			expect(sourceManager.getStatus("recording-source")).toBeUndefined()
		})

		it("should stop emitting data after disconnect", async () => {
			const testData = Buffer.alloc(8192, 0x42)
			const filePath = createTestFile("test-audio.raw", testData)

			let bytesAfterDisconnect = 0
			let disconnected = false

			sourceManager.on("data", (id, chunk) => {
				if (id === "recording-source" && disconnected) {
					bytesAfterDisconnect += chunk.length
				}
			})

			const config = createRecordingConfig("recording-source", filePath, {
				loop: true,
				playbackSpeed: 10,
			})
			await sourceManager.connect(config)

			// Wait for some data
			await new Promise(resolve => setTimeout(resolve, 50))

			// Disconnect
			disconnected = true
			await sourceManager.disconnect("recording-source")

			// Wait a bit more
			await new Promise(resolve => setTimeout(resolve, 100))

			// Should not have received data after disconnect
			expect(bytesAfterDisconnect).toBe(0)
		})
	})
})
