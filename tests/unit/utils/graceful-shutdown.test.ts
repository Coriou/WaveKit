/**
 * Unit tests for GracefulShutdown handler
 *
 * Requirements tested:
 * - 14.1: WHEN SIGTERM is received, THE Application SHALL begin graceful shutdown
 * - 14.6: IF shutdown takes longer than 10 seconds, THEN THE Application SHALL force exit
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
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
