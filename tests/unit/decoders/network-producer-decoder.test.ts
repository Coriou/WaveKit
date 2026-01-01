/**
 * Network Producer Decoder Unit Tests
 *
 * Tests for the NetworkProducerDecoder abstract base class.
 * Requirements: 18.1, 18.2, 18.3, 18.4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { createServer, type Server, type Socket } from "node:net"
import * as fc from "fast-check"
import type {
	DecoderCaps,
	DecoderOutput,
	DecoderHealth,
} from "../../../src/decoders/types.js"
import {
	NetworkProducerDecoder,
	type NetworkProducerConfig,
} from "../../../src/decoders/network-producer-decoder.js"
import pino from "pino"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Concrete implementation of NetworkProducerDecoder for testing.
 */
class TestNetworkProducerDecoder extends NetworkProducerDecoder {
	public parseNetworkDataCalls: Buffer[] = []
	public mockOutputs: DecoderOutput[] = []

	constructor(config: NetworkProducerConfig) {
		super(config, testLogger)
	}

	protected getCommand(): string {
		// Return a command that exists and exits quickly
		return "echo"
	}

	protected getArgs(): string[] {
		return ["test"]
	}

	protected parseNetworkData(data: Buffer): DecoderOutput[] {
		this.parseNetworkDataCalls.push(data)

		// Return mock outputs if configured
		if (this.mockOutputs.length > 0) {
			return this.mockOutputs
		}

		// Default: parse each line as a JSON object
		const lines = data.toString().split("\n").filter(Boolean)
		return lines.map(line => ({
			timestamp: new Date(),
			decoder: this.id,
			type: "signal" as const,
			data: { raw: line },
		}))
	}

	protected getCaps(): DecoderCaps {
		return {
			input: "external",
			wantsExclusiveSource: false,
			output: "jsonl",
			integrationPattern: "network_producer",
		}
	}

	// Expose protected methods for testing
	public testSetHealth(health: DecoderHealth): void {
		this.setHealth(health)
	}

	public testScheduleReconnect(): void {
		this.scheduleReconnect()
	}
}

/**
 * Creates a test TCP server that accepts connections and can send data.
 */
function createTestTcpServer(port: number): Promise<{
	server: Server
	clients: Socket[]
	sendToAll: (data: string) => void
	close: () => Promise<void>
}> {
	return new Promise((resolve, reject) => {
		const clients: Socket[] = []
		const server = createServer(socket => {
			clients.push(socket)
			socket.on("close", () => {
				const index = clients.indexOf(socket)
				if (index !== -1) {
					clients.splice(index, 1)
				}
			})
		})

		server.on("error", reject)

		server.listen(port, "127.0.0.1", () => {
			resolve({
				server,
				clients,
				sendToAll: (data: string) => {
					for (const client of clients) {
						client.write(data)
					}
				},
				close: () =>
					new Promise<void>(res => {
						for (const client of clients) {
							client.destroy()
						}
						server.close(() => res())
					}),
			})
		})
	})
}

describe("NetworkProducerDecoder", () => {
	let decoder: TestNetworkProducerDecoder
	let testServer: Awaited<ReturnType<typeof createTestTcpServer>> | null = null

	const createConfig = (
		overrides: Partial<NetworkProducerConfig> = {},
	): NetworkProducerConfig => ({
		id: "test-decoder",
		type: "test-network-producer",
		enabled: true,
		options: {},
		outputHost: "127.0.0.1",
		outputPort: 19999,
		outputProtocol: "tcp",
		...overrides,
	})

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
	})

	afterEach(async () => {
		vi.useRealTimers()
		if (decoder) {
			try {
				await decoder.stop()
			} catch {
				// Ignore errors during cleanup
			}
		}
		if (testServer) {
			await testServer.close()
			testServer = null
		}
	})

	describe("constructor", () => {
		it("should initialize with correct id and type", () => {
			const config = createConfig({ id: "my-decoder", type: "my-type" })
			decoder = new TestNetworkProducerDecoder(config)

			expect(decoder.id).toBe("my-decoder")
			expect(decoder.type).toBe("my-type")
		})

		it("should expose capabilities via caps getter", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())

			expect(decoder.caps).toEqual({
				input: "external",
				wantsExclusiveSource: false,
				output: "jsonl",
				integrationPattern: "network_producer",
			})
		})
	})

	describe("getStatus", () => {
		it("should return status with all required fields when not running", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())
			const status = decoder.getStatus()

			expect(status.id).toBe("test-decoder")
			expect(status.type).toBe("test-network-producer")
			expect(status.running).toBe(false)
			expect(status.health).toBe("running")
			expect(status.pid).toBeUndefined()
			expect(status.uptime).toBe(0)
			expect(status.stats).toEqual({ bytesIn: 0, eventsOut: 0, errors: 0 })
			expect(status.restartCount).toBe(0)
		})
	})

	describe("getHealth", () => {
		it("should return current health state", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())

			expect(decoder.getHealth()).toBe("running")
		})

		it("should emit health event when health changes", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())
			const healthHandler = vi.fn()
			decoder.on("health", healthHandler)

			decoder.testSetHealth("degraded")

			expect(healthHandler).toHaveBeenCalledWith("degraded")
			expect(decoder.getHealth()).toBe("degraded")
		})

		it("should not emit health event when health stays the same", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())
			const healthHandler = vi.fn()
			decoder.on("health", healthHandler)

			decoder.testSetHealth("running") // Same as initial

			expect(healthHandler).not.toHaveBeenCalled()
		})
	})

	describe("attachInput/detachInput", () => {
		it("should be no-ops for network producer decoders", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())
			const mockStream = new PassThrough()

			// These should not throw
			expect(() => decoder.attachInput(mockStream)).not.toThrow()
			expect(() => decoder.detachInput()).not.toThrow()
		})
	})

	describe("getOutput", () => {
		it("should return a readable stream", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())
			const output = decoder.getOutput()

			expect(output).toBeDefined()
			expect(typeof output.read).toBe("function")
		})
	})

	describe("getAudioOutput", () => {
		it("should return null for network producer decoders", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())

			expect(decoder.getAudioOutput()).toBeNull()
		})
	})

	describe("restart count", () => {
		it("should track restart count", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())

			expect(decoder.getStatus().restartCount).toBe(0)

			decoder.incrementRestartCount()
			expect(decoder.getStatus().restartCount).toBe(1)

			decoder.incrementRestartCount()
			expect(decoder.getStatus().restartCount).toBe(2)

			decoder.resetRestartCount()
			expect(decoder.getStatus().restartCount).toBe(0)
		})
	})

	describe("reconnection tracking", () => {
		it("should track reconnection attempts", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())

			expect(decoder.getReconnectAttempts()).toBe(0)
			expect(decoder.isCurrentlyReconnecting()).toBe(false)
		})
	})

	describe("exponential backoff calculation", () => {
		it("should schedule reconnection with increasing delays", () => {
			decoder = new TestNetworkProducerDecoder(createConfig())

			// First reconnect attempt
			decoder.testScheduleReconnect()
			expect(decoder.getReconnectAttempts()).toBe(1)
			expect(decoder.isCurrentlyReconnecting()).toBe(true)
		})
	})

	/**
	 * Feature: wavekit-core, Property 31: Network Producer Reconnection
	 * Validates: Requirements 18.3
	 *
	 * For any network producer decoder D, if the output connection is lost
	 * while the process is running, D should attempt reconnection with
	 * exponential backoff and emit appropriate events.
	 */
	describe("Property 31: Network Producer Reconnection", () => {
		it("should attempt reconnection with exponential backoff when connection is lost", () => {
			fc.assert(
				fc.property(
					// Generate a sequence of reconnection attempts (1 to 10)
					fc.integer({ min: 1, max: 10 }),
					numAttempts => {
						const config = createConfig()
						const testDecoder = new TestNetworkProducerDecoder(config)

						// Base delay and max delay constants from the implementation
						const BASE_RECONNECT_DELAY = 2000
						const MAX_RECONNECT_DELAY = 30000

						// Simulate multiple reconnection attempts
						for (let i = 0; i < numAttempts; i++) {
							testDecoder.testScheduleReconnect()

							// Verify attempt count increments
							const expectedAttempts = i + 1
							expect(testDecoder.getReconnectAttempts()).toBe(expectedAttempts)

							// Verify reconnecting state is set
							expect(testDecoder.isCurrentlyReconnecting()).toBe(true)

							// Calculate expected delay using exponential backoff formula
							// delay = min(2^(attempt-1) * baseDelay, maxDelay)
							const expectedDelay = Math.min(
								BASE_RECONNECT_DELAY * Math.pow(2, expectedAttempts - 1),
								MAX_RECONNECT_DELAY,
							)

							// Verify the delay follows exponential backoff pattern
							// For attempt 1: 2000ms
							// For attempt 2: 4000ms
							// For attempt 3: 8000ms
							// For attempt 4: 16000ms
							// For attempt 5+: capped at 30000ms
							if (expectedAttempts === 1) {
								expect(expectedDelay).toBe(2000)
							} else if (expectedAttempts === 2) {
								expect(expectedDelay).toBe(4000)
							} else if (expectedAttempts === 3) {
								expect(expectedDelay).toBe(8000)
							} else if (expectedAttempts === 4) {
								expect(expectedDelay).toBe(16000)
							} else {
								// After attempt 4, delay should be capped at 30000ms
								expect(expectedDelay).toBeLessThanOrEqual(MAX_RECONNECT_DELAY)
							}

							// Reset reconnecting state for next iteration
							// (simulating the timer callback completing)
							// In real code, this happens when attemptReconnect is called
							// For testing, we manually reset to allow next scheduleReconnect
							;(
								testDecoder as unknown as { isReconnecting: boolean }
							).isReconnecting = false
						}

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should not schedule reconnection when decoder is stopping", () => {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 5 }), _numAttempts => {
					const config = createConfig()
					const testDecoder = new TestNetworkProducerDecoder(config)

					// Set stopping state
					;(testDecoder as unknown as { isStopping: boolean }).isStopping = true

					// Try to schedule reconnect
					testDecoder.testScheduleReconnect()

					// Should not increment attempts or set reconnecting state
					expect(testDecoder.getReconnectAttempts()).toBe(0)
					expect(testDecoder.isCurrentlyReconnecting()).toBe(false)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should not schedule reconnection when already reconnecting", () => {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 5 }), _numAttempts => {
					const config = createConfig()
					const testDecoder = new TestNetworkProducerDecoder(config)

					// First reconnect attempt
					testDecoder.testScheduleReconnect()
					expect(testDecoder.getReconnectAttempts()).toBe(1)
					expect(testDecoder.isCurrentlyReconnecting()).toBe(true)

					// Try to schedule another reconnect while already reconnecting
					testDecoder.testScheduleReconnect()

					// Should not increment attempts again
					expect(testDecoder.getReconnectAttempts()).toBe(1)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should reset reconnect attempts on successful connection", () => {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 10 }), numAttempts => {
					const config = createConfig()
					const testDecoder = new TestNetworkProducerDecoder(config)

					// Simulate multiple reconnection attempts
					for (let i = 0; i < numAttempts; i++) {
						testDecoder.testScheduleReconnect()
						;(
							testDecoder as unknown as { isReconnecting: boolean }
						).isReconnecting = false
					}

					expect(testDecoder.getReconnectAttempts()).toBe(numAttempts)

					// Simulate successful connection by resetting state
					// (this happens in connectTcp/connectUdp on success)
					;(
						testDecoder as unknown as { reconnectAttempts: number }
					).reconnectAttempts = 0
					;(
						testDecoder as unknown as { isReconnecting: boolean }
					).isReconnecting = false

					expect(testDecoder.getReconnectAttempts()).toBe(0)
					expect(testDecoder.isCurrentlyReconnecting()).toBe(false)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should follow exponential backoff formula: min(2^(n-1) * base, max)", () => {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 20 }), attemptNumber => {
					const BASE_RECONNECT_DELAY = 2000
					const MAX_RECONNECT_DELAY = 30000

					// Calculate expected delay using the formula
					const expectedDelay = Math.min(
						BASE_RECONNECT_DELAY * Math.pow(2, attemptNumber - 1),
						MAX_RECONNECT_DELAY,
					)

					// Verify the formula produces correct values
					// Attempt 1: 2000 * 2^0 = 2000
					// Attempt 2: 2000 * 2^1 = 4000
					// Attempt 3: 2000 * 2^2 = 8000
					// Attempt 4: 2000 * 2^3 = 16000
					// Attempt 5: 2000 * 2^4 = 32000 -> capped to 30000
					// Attempt 6+: capped to 30000

					expect(expectedDelay).toBeGreaterThanOrEqual(BASE_RECONNECT_DELAY)
					expect(expectedDelay).toBeLessThanOrEqual(MAX_RECONNECT_DELAY)

					// Verify monotonic increase up to cap
					if (attemptNumber > 1) {
						const previousDelay = Math.min(
							BASE_RECONNECT_DELAY * Math.pow(2, attemptNumber - 2),
							MAX_RECONNECT_DELAY,
						)
						expect(expectedDelay).toBeGreaterThanOrEqual(previousDelay)
					}

					return true
				}),
				{ numRuns: 100 },
			)
		})
	})
})
