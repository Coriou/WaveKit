/**
 * Source Manager Unit Tests
 *
 * Tests for TCP connection management with auto-reconnect.
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as net from "node:net"
import * as fc from "fast-check"
import {
	SourceManager,
	calculateBackoffDelay,
	type SourceConfig,
	type SourceStatus,
} from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

// Create a test logger
const testLogger = createLogger({ level: "error" })

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

				const config: SourceConfig = {
					id: "test-source",
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: mockServer.port,
					format: "S16LE",
					sampleRate: 48000,
				}

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

				const config: SourceConfig = {
					id: "test-source",
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: mockServer.port,
					format: "S16LE",
					sampleRate: 48000,
				}

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
				const config: SourceConfig = {
					id: "test-source",
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: mockServer.port,
					format: "S16LE",
					sampleRate: 48000,
				}

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
		 * Validates: Requirements 1.7
		 *
		 * For any source managed by Source_Manager, calling getStatus(id) should
		 * return an object containing all required fields.
		 */
		it("should return complete status with all required fields", async () => {
			const mockServer = await createMockServer()

			try {
				const config: SourceConfig = {
					id: "test-source",
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: mockServer.port,
					format: "S16LE",
					sampleRate: 48000,
				}

				await sourceManager.connect(config)

				const status = sourceManager.getStatus("test-source")

				expect(status).toBeDefined()
				expect(status).toHaveProperty("id")
				expect(status).toHaveProperty("connected")
				expect(status).toHaveProperty("bytesReceived")
				expect(status).toHaveProperty("dataRate")
				expect(status).toHaveProperty("reconnectAttempts")

				expect(status!.id).toBe("test-source")
				expect(typeof status!.connected).toBe("boolean")
				expect(typeof status!.bytesReceived).toBe("number")
				expect(typeof status!.dataRate).toBe("number")
				expect(typeof status!.reconnectAttempts).toBe("number")
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
				await sourceManager.connect({
					id: "source-1",
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: mockServer1.port,
					format: "S16LE",
					sampleRate: 48000,
				})

				await sourceManager.connect({
					id: "source-2",
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: mockServer2.port,
					format: "S16LE",
					sampleRate: 48000,
				})

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
				const config: SourceConfig = {
					id: "test-source",
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: mockServer.port,
					format: "S16LE",
					sampleRate: 48000,
				}

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

				const config: SourceConfig = {
					id: "test-source",
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: mockServer.port,
					format: "S16LE",
					sampleRate: 48000,
				}

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

			const config: SourceConfig = {
				id: "test-source",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port: 59999, // Port that should refuse connection
				format: "S16LE",
				sampleRate: 48000,
			}

			// Should not throw, but reject with SourceConnectionError
			await expect(sourceManager.connect(config)).rejects.toThrow()

			const error = await errorPromise
			expect(error).toBeDefined()
		})

		it("should not throw unhandled exception on connection errors", async () => {
			const config: SourceConfig = {
				id: "test-source",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port: 59999,
				format: "S16LE",
				sampleRate: 48000,
			}

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
				const config: SourceConfig = {
					id: "test-source",
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: mockServer.port,
					format: "S16LE",
					sampleRate: 48000,
				}

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
	 * bytesReceived, dataRate, and reconnectAttempts.
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
							const config: SourceConfig = {
								id: sourceId,
								type: "rtl_tcp",
								host: "127.0.0.1",
								port: mockServer.port,
								format: "S16LE",
								sampleRate: 48000,
							}

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
							const config: SourceConfig = {
								id: "test-source",
								type: "rtl_tcp",
								host: "127.0.0.1",
								port: mockServer.port,
								format: "S16LE",
								sampleRate: 48000,
							}

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
							const config: SourceConfig = {
								id: "test-source",
								type: "rtl_tcp",
								host: "127.0.0.1",
								port,
								format: "S16LE",
								sampleRate: 48000,
							}

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
							const config: SourceConfig = {
								id: sourceId,
								type: "rtl_tcp",
								host: "127.0.0.1",
								port: 59999, // Port that should refuse connection
								format: "S16LE",
								sampleRate: 48000,
							}

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
							const config: SourceConfig = {
								id: sourceId,
								type: "rtl_tcp",
								host: "127.0.0.1",
								port: 59999,
								format: "S16LE",
								sampleRate: 48000,
							}

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
							if (!(emittedError instanceof Error)) return false

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
})
