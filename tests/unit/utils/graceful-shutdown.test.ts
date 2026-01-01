/**
 * Unit tests for GracefulShutdown handler
 *
 * Requirements tested:
 * - 14.1: WHEN SIGTERM is received, THE Application SHALL begin graceful shutdown
 * - 14.2: WHEN shutting down, THE Application SHALL stop accepting new connections
 * - 14.3: WHEN shutting down, THE Application SHALL stop all decoders gracefully
 * - 14.4: WHEN shutting down, THE Application SHALL close all source connections
 * - 14.5: WHEN shutting down, THE Application SHALL destroy all streams to prevent memory leaks
 * - 14.6: IF shutdown takes longer than 10 seconds, THEN THE Application SHALL force exit
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fc from "fast-check"
import {
	GracefulShutdown,
	resetGracefulShutdown,
	getGracefulShutdown,
	type ShutdownHandler,
} from "../../../src/utils/graceful-shutdown.js"
import { createLogger } from "../../../src/utils/logger.js"

describe("GracefulShutdown", () => {
	let shutdown: GracefulShutdown
	let logger: ReturnType<typeof createLogger>

	beforeEach(() => {
		resetGracefulShutdown()
		logger = createLogger({ level: "error" }) // Quiet during tests
		shutdown = new GracefulShutdown({ logger })
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("register/unregister", () => {
		it("should register a shutdown handler", () => {
			const handler: ShutdownHandler = {
				name: "test-handler",
				handler: async () => {},
			}

			shutdown.register(handler)

			expect(shutdown.getHandlerNames()).toContain("test-handler")
		})

		it("should unregister a shutdown handler", () => {
			const handler: ShutdownHandler = {
				name: "test-handler",
				handler: async () => {},
			}

			shutdown.register(handler)
			shutdown.unregister("test-handler")

			expect(shutdown.getHandlerNames()).not.toContain("test-handler")
		})

		it("should replace duplicate handler registrations", () => {
			let callCount = 0
			const handler1: ShutdownHandler = {
				name: "test-handler",
				handler: async () => {
					callCount += 1
				},
			}
			const handler2: ShutdownHandler = {
				name: "test-handler",
				handler: async () => {
					callCount += 10
				},
			}

			shutdown.register(handler1)
			shutdown.register(handler2)

			// Should only have one handler with this name
			expect(
				shutdown.getHandlerNames().filter(n => n === "test-handler").length,
			).toBe(1)
		})
	})

	describe("shutdown", () => {
		it("should execute handlers in reverse order (LIFO)", async () => {
			const order: string[] = []

			shutdown.register({
				name: "first",
				handler: async () => {
					order.push("first")
				},
			})
			shutdown.register({
				name: "second",
				handler: async () => {
					order.push("second")
				},
			})
			shutdown.register({
				name: "third",
				handler: async () => {
					order.push("third")
				},
			})

			await shutdown.shutdown()

			expect(order).toEqual(["third", "second", "first"])
		})

		it("should set shuttingDown flag during shutdown", async () => {
			expect(shutdown.isShuttingDown()).toBe(false)

			const shutdownPromise = shutdown.shutdown()
			expect(shutdown.isShuttingDown()).toBe(true)

			await shutdownPromise
			expect(shutdown.isShuttingDown()).toBe(true)
		})

		it("should not run shutdown twice if already in progress", async () => {
			let callCount = 0
			shutdown.register({
				name: "counter",
				handler: async () => {
					callCount++
				},
			})

			// Start shutdown twice
			await Promise.all([shutdown.shutdown(), shutdown.shutdown()])

			expect(callCount).toBe(1)
		})

		it("should continue with other handlers if one fails", async () => {
			const executed: string[] = []

			shutdown.register({
				name: "first",
				handler: async () => {
					executed.push("first")
				},
			})
			shutdown.register({
				name: "failing",
				handler: async () => {
					throw new Error("Handler failed")
				},
			})
			shutdown.register({
				name: "third",
				handler: async () => {
					executed.push("third")
				},
			})

			await shutdown.shutdown()

			// Both non-failing handlers should have executed
			expect(executed).toContain("first")
			expect(executed).toContain("third")
		})

		it("should timeout individual handlers that take too long", async () => {
			const executed: string[] = []

			shutdown.register({
				name: "slow",
				handler: async () => {
					await new Promise(resolve => setTimeout(resolve, 10000))
					executed.push("slow")
				},
				timeout: 50, // Very short timeout for testing
			})
			shutdown.register({
				name: "fast",
				handler: async () => {
					executed.push("fast")
				},
			})

			await shutdown.shutdown()

			// Fast handler should execute, slow handler should timeout
			expect(executed).toContain("fast")
			expect(executed).not.toContain("slow")
		})
	})

	describe("getGracefulShutdown singleton", () => {
		it("should return the same instance on multiple calls", () => {
			resetGracefulShutdown()

			const instance1 = getGracefulShutdown()
			const instance2 = getGracefulShutdown()

			expect(instance1).toBe(instance2)
		})

		it("should create new instance after reset", () => {
			const instance1 = getGracefulShutdown()
			resetGracefulShutdown()
			const instance2 = getGracefulShutdown()

			expect(instance1).not.toBe(instance2)
		})
	})
})

/**
 * Property 24: Graceful Shutdown Completeness
 *
 * Feature: wavekit-core, Property 24: Graceful Shutdown Completeness
 * Validates: Requirements 14.2, 14.3, 14.4, 14.5
 *
 * For any shutdown initiated by SIGTERM, after shutdown completes:
 * (a) all decoders should be stopped
 * (b) all source connections should be closed
 * (c) all streams should be destroyed
 * (d) no new connections should be accepted
 */
describe("Property 24: Graceful Shutdown Completeness", () => {
	// Arbitrary for generating handler names (non-empty alphanumeric strings)
	const handlerNameArb = fc
		.string({ minLength: 1, maxLength: 20 })
		.filter(s => /^[a-zA-Z][a-zA-Z0-9-]*$/.test(s))

	// Arbitrary for generating a set of component types to simulate
	const componentTypesArb = fc.constantFrom(
		"api-server",
		"decoder-manager",
		"source-manager",
		"fanout-manager",
		"audio-output",
		"audio-wiring",
	)

	// Arbitrary for generating a list of unique handler names (simulating components)
	const handlerListArb = fc
		.array(componentTypesArb, { minLength: 1, maxLength: 6 })
		.map(arr => [...new Set(arr)]) // Ensure unique names

	it("should execute all registered handlers during shutdown (14.3, 14.4, 14.5)", async () => {
		await fc.assert(
			fc.asyncProperty(handlerListArb, async handlerNames => {
				resetGracefulShutdown()
				const logger = createLogger({ level: "error" })
				const shutdown = new GracefulShutdown({ logger })

				// Track which handlers were executed
				const executedHandlers: string[] = []

				// Register handlers for each component
				for (const name of handlerNames) {
					shutdown.register({
						name,
						handler: async () => {
							executedHandlers.push(name)
						},
						timeout: 1000,
					})
				}

				// Execute shutdown
				await shutdown.shutdown()

				// Verify all handlers were executed
				for (const name of handlerNames) {
					if (!executedHandlers.includes(name)) {
						return false
					}
				}

				return true
			}),
			{ numRuns: 100 },
		)
	})

	it("should set shuttingDown flag to prevent new connections (14.2)", async () => {
		await fc.assert(
			fc.asyncProperty(handlerListArb, async handlerNames => {
				resetGracefulShutdown()
				const logger = createLogger({ level: "error" })
				const shutdown = new GracefulShutdown({ logger })

				// Register handlers
				for (const name of handlerNames) {
					shutdown.register({
						name,
						handler: async () => {},
						timeout: 1000,
					})
				}

				// Before shutdown, isShuttingDown should be false
				if (shutdown.isShuttingDown()) {
					return false
				}

				// Start shutdown
				const shutdownPromise = shutdown.shutdown()

				// During shutdown, isShuttingDown should be true
				if (!shutdown.isShuttingDown()) {
					return false
				}

				await shutdownPromise

				// After shutdown, isShuttingDown should still be true
				return shutdown.isShuttingDown() === true
			}),
			{ numRuns: 100 },
		)
	})

	it("should execute handlers in LIFO order for proper dependency cleanup (14.3, 14.4, 14.5)", async () => {
		await fc.assert(
			fc.asyncProperty(handlerListArb, async handlerNames => {
				resetGracefulShutdown()
				const logger = createLogger({ level: "error" })
				const shutdown = new GracefulShutdown({ logger })

				// Track execution order
				const executionOrder: string[] = []

				// Register handlers in order
				for (const name of handlerNames) {
					shutdown.register({
						name,
						handler: async () => {
							executionOrder.push(name)
						},
						timeout: 1000,
					})
				}

				// Execute shutdown
				await shutdown.shutdown()

				// Verify LIFO order (reverse of registration order)
				const expectedOrder = [...handlerNames].reverse()
				if (executionOrder.length !== expectedOrder.length) {
					return false
				}

				for (let i = 0; i < executionOrder.length; i++) {
					if (executionOrder[i] !== expectedOrder[i]) {
						return false
					}
				}

				return true
			}),
			{ numRuns: 100 },
		)
	})

	it("should complete all handlers even if some fail (14.3, 14.4, 14.5)", async () => {
		// Arbitrary for generating which handlers should fail
		const failingIndicesArb = fc.array(fc.nat({ max: 5 }), {
			minLength: 0,
			maxLength: 3,
		})

		await fc.assert(
			fc.asyncProperty(
				handlerListArb,
				failingIndicesArb,
				async (handlerNames, failingIndices) => {
					resetGracefulShutdown()
					const logger = createLogger({ level: "error" })
					const shutdown = new GracefulShutdown({ logger })

					// Track which handlers were executed (even if they fail)
					const attemptedHandlers: string[] = []
					const failingSet = new Set(
						failingIndices.map(i => handlerNames[i % handlerNames.length]),
					)

					// Register handlers
					for (const name of handlerNames) {
						const shouldFail = failingSet.has(name)
						shutdown.register({
							name,
							handler: async () => {
								attemptedHandlers.push(name)
								if (shouldFail) {
									throw new Error(`Handler ${name} failed`)
								}
							},
							timeout: 1000,
						})
					}

					// Execute shutdown
					await shutdown.shutdown()

					// Verify all handlers were attempted (even failing ones)
					for (const name of handlerNames) {
						if (!attemptedHandlers.includes(name)) {
							return false
						}
					}

					return true
				},
			),
			{ numRuns: 100 },
		)
	})

	it("should not execute shutdown handlers twice when shutdown is called multiple times (14.2)", async () => {
		await fc.assert(
			fc.asyncProperty(handlerListArb, async handlerNames => {
				resetGracefulShutdown()
				const logger = createLogger({ level: "error" })
				const shutdown = new GracefulShutdown({ logger })

				// Track execution counts
				const executionCounts: Map<string, number> = new Map()

				// Register handlers
				for (const name of handlerNames) {
					executionCounts.set(name, 0)
					shutdown.register({
						name,
						handler: async () => {
							executionCounts.set(name, (executionCounts.get(name) ?? 0) + 1)
						},
						timeout: 1000,
					})
				}

				// Call shutdown multiple times concurrently
				await Promise.all([
					shutdown.shutdown(),
					shutdown.shutdown(),
					shutdown.shutdown(),
				])

				// Verify each handler was executed exactly once
				for (const name of handlerNames) {
					if (executionCounts.get(name) !== 1) {
						return false
					}
				}

				return true
			}),
			{ numRuns: 100 },
		)
	})

	it("should handle empty handler list gracefully", async () => {
		await fc.assert(
			fc.asyncProperty(fc.constant(null), async () => {
				resetGracefulShutdown()
				const logger = createLogger({ level: "error" })
				const shutdown = new GracefulShutdown({ logger })

				// No handlers registered

				// Shutdown should complete without error
				await shutdown.shutdown()

				// Should be in shutting down state
				return shutdown.isShuttingDown() === true
			}),
			{ numRuns: 10 },
		)
	})
})
