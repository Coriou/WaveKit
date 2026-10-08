/**
 * Health State Transitions Property-Based Tests
 *
 * Feature: wavekit-core, Property 30: Health State Transitions
 * Validates: Requirements 20.1, 20.2, 20.3, 20.4
 *
 * For any decoder D, health transitions should follow:
 * - running → degraded (after timeout without output)
 * - degraded → running (on output received)
 * - running/degraded → faulted (on crash loop)
 * - health events should be emitted for each transition
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import type {
	Decoder,
	DecoderCaps,
	DecoderConfig,
	DecoderHealth,
	DecoderOutput,
	DecoderStatus,
} from "../../../src/decoders/types.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import pino from "pino"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Test decoder implementation that allows controlling health state transitions.
 * Uses a configurable time source for testing with fake timers.
 */
class TestableDecoder extends EventEmitter implements Decoder {
	readonly id: string
	readonly type: string
	readonly caps: DecoderCaps = {
		input: "audio_pcm",
		wantsExclusiveSource: false,
		preferredSampleRates: [48000],
		output: "text",
		integrationPattern: "pure_consumer",
	}
	private outputStream = new PassThrough({ objectMode: true })
	private _running = false
	private _pid: number | undefined
	private _startTime = 0
	private _stats = { bytesIn: 0, eventsOut: 0, errors: 0 }
	private _health: DecoderHealth = "running"
	private _restartCount = 0
	private getTime: () => number

	constructor(config: DecoderConfig, getTime: () => number = Date.now) {
		super()
		this.id = config.id
		this.type = config.type
		this.getTime = getTime
	}

	async start(): Promise<void> {
		this._running = true
		this._pid = Math.floor(Math.random() * 65535) + 1
		this._startTime = this.getTime()
		this._health = "running"
		this.emit("started")
	}

	async stop(): Promise<void> {
		this._running = false
		this._pid = undefined
		this.emit("stopped")
	}

	async restart(): Promise<void> {
		await this.stop()
		await this.start()
	}

	attachInput(_stream: Readable): void {
		// No-op for test
	}

	detachInput(): void {
		// No-op for test
	}

	getOutput(): Readable {
		return this.outputStream
	}

	getAudioOutput(): Readable | null {
		return null
	}

	/**
	 * Simulates the decoder producing output.
	 */
	simulateOutput(): void {
		const output: DecoderOutput = {
			timestamp: new Date(),
			decoder: this.id,
			type: "decode",
			data: { test: true },
		}
		this._stats.eventsOut++
		this.emit("output", output)
	}

	/**
	 * Simulates the decoder process exiting unexpectedly.
	 */
	simulateExit(code: number | null = 1, signal: string | null = null): void {
		this._running = false
		this._pid = undefined
		this.emit("exit", code, signal)
	}

	getHealth(): DecoderHealth {
		return this._health
	}

	updateOptions(_updates: Record<string, unknown>): void {
		// No-op for test
	}

	getStatus(): DecoderStatus {
		const now = this.getTime()
		const uptime = this._running
			? Math.floor((now - this._startTime) / 1000)
			: 0

		return {
			id: this.id,
			type: this.type,
			running: this._running,
			health: this._health,
			pid: this._pid,
			uptime,
			stats: { ...this._stats },
			lastOutputAt: undefined,
			restartCount: this._restartCount,
			version: undefined,
		}
	}
}

/**
 * Arbitrary for generating valid decoder IDs.
 */
const decoderIdArb = fc
	.string({ minLength: 1, maxLength: 20 })
	.filter(s => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s))

/**
 * Arbitrary for generating valid decoder types.
 */
const decoderTypeArb = fc.constantFrom(
	"test-decoder",
	"mock-decoder",
	"fake-decoder",
)

/**
 * Arbitrary for generating valid decoder configs.
 */
const decoderConfigArb = fc.record({
	id: decoderIdArb,
	type: decoderTypeArb,
	enabled: fc.constant(true),
	options: fc.constant({} as Record<string, unknown>),
})

/**
 * Arbitrary for generating health check intervals (in ms).
 * Using values that work with second-based uptime tracking.
 */
const healthCheckIntervalArb = fc.integer({ min: 100, max: 500 })

/**
 * Arbitrary for generating degraded timeout values (in ms).
 * Must be >= 1000ms to work with second-based uptime tracking.
 */
const idleTimeoutArb = fc.integer({ min: 1000, max: 3000 })

/**
 * Arbitrary for generating max restart counts.
 */
const maxRestartsArb = fc.integer({ min: 1, max: 5 })

describe("Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 30: Health State Transitions
	 * Validates: Requirements 20.1, 20.2, 20.3, 20.4
	 */
	describe("Property 30: Health State Transitions", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("should transition from running to degraded after timeout without output", async () => {
			await fc.assert(
				fc.asyncProperty(
					decoderConfigArb,
					healthCheckIntervalArb,
					idleTimeoutArb,
					async (config, healthCheckInterval, idleTimeout) => {
						// Create components
						const registry = new DecoderRegistry()
						const fanout = new FanoutManager(testLogger)
						const sourceStream = new PassThrough()
						fanout.attachSource(sourceStream)

						// Register test decoder factory
						registry.register(
							config.type,
							(cfg, _logger) => new TestableDecoder(cfg),
							{
								input: "audio_pcm",
								output: "text",
								integrationPattern: "pure_consumer",
							},
						)

						const manager = new DecoderManager(registry, fanout, testLogger, {
							healthCheckInterval,
							idleTimeout,
							restartDelay: 100,
							maxRestartDelay: 1000,
							maxRestarts: 0,
						})

						// Track health events
						const healthEvents: DecoderHealth[] = []
						manager.on(
							"decoder:health",
							(_id: string, health: DecoderHealth) => {
								healthEvents.push(health)
							},
						)

						// Create and start decoder
						manager.createDecoder(config)
						await manager.startDecoder(config.id)

						// Initial health should be running
						expect(manager.getHealth(config.id)).toBe("running")

						// Advance time past the degraded timeout
						// Need to advance by idleTimeout + 1000ms (for uptime to exceed timeout)
						// plus additional health check intervals to ensure the check runs
						const timeToAdvance = idleTimeout + 1000 + healthCheckInterval * 3
						await vi.advanceTimersByTimeAsync(timeToAdvance)

						// Health should transition to degraded
						const finalHealth = manager.getHealth(config.id)

						// Cleanup
						await manager.destroy()
						fanout.detachSource()

						// Verify transition occurred and event was emitted
						return finalHealth === "idle" && healthEvents.includes("idle")
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should transition from degraded to running when output is received", async () => {
			await fc.assert(
				fc.asyncProperty(
					decoderConfigArb,
					healthCheckIntervalArb,
					idleTimeoutArb,
					async (config, healthCheckInterval, idleTimeout) => {
						// Create components
						const registry = new DecoderRegistry()
						const fanout = new FanoutManager(testLogger)
						const sourceStream = new PassThrough()
						fanout.attachSource(sourceStream)

						let testDecoder: TestableDecoder | null = null

						// Register test decoder factory that captures the instance
						registry.register(
							config.type,
							(cfg, _logger) => {
								testDecoder = new TestableDecoder(cfg)
								return testDecoder
							},
							{
								input: "audio_pcm",
								output: "text",
								integrationPattern: "pure_consumer",
							},
						)

						const manager = new DecoderManager(registry, fanout, testLogger, {
							healthCheckInterval,
							idleTimeout,
							restartDelay: 100,
							maxRestartDelay: 1000,
							maxRestarts: 0,
						})

						// Track health events
						const healthEvents: DecoderHealth[] = []
						manager.on(
							"decoder:health",
							(_id: string, health: DecoderHealth) => {
								healthEvents.push(health)
							},
						)

						// Create and start decoder
						manager.createDecoder(config)
						await manager.startDecoder(config.id)

						// Advance time to trigger degraded state
						// Need to advance by idleTimeout + 1000ms (for uptime to exceed timeout)
						const timeToAdvance = idleTimeout + 1000 + healthCheckInterval * 3
						await vi.advanceTimersByTimeAsync(timeToAdvance)

						// Verify degraded state
						expect(manager.getHealth(config.id)).toBe("idle")

						// Simulate output from decoder
						testDecoder!.simulateOutput()

						// Advance time for next health check
						await vi.advanceTimersByTimeAsync(healthCheckInterval * 2)

						// Health should transition back to running
						const finalHealth = manager.getHealth(config.id)

						// Cleanup
						await manager.destroy()
						fanout.detachSource()

						// Verify transition occurred: degraded → running
						return (
							finalHealth === "running" &&
							healthEvents.includes("idle") &&
							healthEvents.includes("running")
						)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should transition to faulted when max restarts exceeded (crash loop)", async () => {
			await fc.assert(
				fc.asyncProperty(
					decoderConfigArb,
					maxRestartsArb,
					async (config, maxRestarts) => {
						// Create components
						const registry = new DecoderRegistry()
						const fanout = new FanoutManager(testLogger)
						const sourceStream = new PassThrough()
						fanout.attachSource(sourceStream)

						let testDecoder: TestableDecoder | null = null

						// Register test decoder factory that captures the instance
						registry.register(
							config.type,
							(cfg, _logger) => {
								testDecoder = new TestableDecoder(cfg)
								return testDecoder
							},
							{
								input: "audio_pcm",
								output: "text",
								integrationPattern: "pure_consumer",
							},
						)

						const manager = new DecoderManager(registry, fanout, testLogger, {
							healthCheckInterval: 500,
							idleTimeout: 2000,
							restartDelay: 10,
							maxRestartDelay: 50,
							maxRestarts,
						})

						// Track health events
						const healthEvents: DecoderHealth[] = []
						manager.on(
							"decoder:health",
							(_id: string, health: DecoderHealth) => {
								healthEvents.push(health)
							},
						)

						// Create and start decoder
						manager.createDecoder(config)
						await manager.startDecoder(config.id)

						// Simulate crash loop by triggering exits up to maxRestarts
						for (let i = 0; i < maxRestarts; i++) {
							testDecoder!.simulateExit(1, null)
							// Wait for restart timer
							await vi.advanceTimersByTimeAsync(100)
						}

						// One more exit should trigger faulted state
						testDecoder!.simulateExit(1, null)
						await vi.advanceTimersByTimeAsync(10)

						// Health should be faulted
						const finalHealth = manager.getHealth(config.id)

						// Cleanup
						await manager.destroy()
						fanout.detachSource()

						// Verify faulted state and event was emitted
						return finalHealth === "faulted" && healthEvents.includes("faulted")
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should emit health events for each state transition", async () => {
			await fc.assert(
				fc.asyncProperty(decoderConfigArb, async config => {
					// Create components
					const registry = new DecoderRegistry()
					const fanout = new FanoutManager(testLogger)
					const sourceStream = new PassThrough()
					fanout.attachSource(sourceStream)

					let testDecoder: TestableDecoder | null = null

					// Register test decoder factory
					registry.register(
						config.type,
						(cfg, _logger) => {
							testDecoder = new TestableDecoder(cfg)
							return testDecoder
						},
						{
							input: "audio_pcm",
							output: "text",
							integrationPattern: "pure_consumer",
						},
					)

					// Use fixed values that work with second-based uptime
					const healthCheckInterval = 200
					const idleTimeout = 1000

					const manager = new DecoderManager(registry, fanout, testLogger, {
						healthCheckInterval,
						idleTimeout,
						restartDelay: 10,
						maxRestartDelay: 50,
						maxRestarts: 0,
					})

					// Track health events with decoder IDs
					const healthEvents: Array<{ id: string; health: DecoderHealth }> = []
					manager.on("decoder:health", (id: string, health: DecoderHealth) => {
						healthEvents.push({ id, health })
					})

					// Create and start decoder
					manager.createDecoder(config)
					await manager.startDecoder(config.id)

					// Advance time to trigger degraded state (need > 1000ms uptime)
					// idleTimeout + 1000ms + buffer for health checks
					await vi.advanceTimersByTimeAsync(2500)

					// Simulate output to trigger running state
					testDecoder!.simulateOutput()
					await vi.advanceTimersByTimeAsync(500)

					// Cleanup
					await manager.destroy()
					fanout.detachSource()

					// Verify events were emitted with correct decoder ID
					const eventsForDecoder = healthEvents.filter(e => e.id === config.id)

					// Should have at least one health event
					// Events should be for the correct decoder
					return (
						eventsForDecoder.length > 0 &&
						eventsForDecoder.every(e => e.id === config.id)
					)
				}),
				{ numRuns: 100 },
			)
		})

		it("should maintain valid health state transitions (no invalid transitions)", async () => {
			// Valid transitions:
			// - running → degraded
			// - degraded → running
			// - running → faulted
			// - degraded → faulted
			// Invalid transitions:
			// - faulted → running (without restart)
			// - faulted → degraded

			await fc.assert(
				fc.asyncProperty(decoderConfigArb, async config => {
					// Create components
					const registry = new DecoderRegistry()
					const fanout = new FanoutManager(testLogger)
					const sourceStream = new PassThrough()
					fanout.attachSource(sourceStream)

					let testDecoder: TestableDecoder | null = null

					// Register test decoder factory
					registry.register(
						config.type,
						(cfg, _logger) => {
							testDecoder = new TestableDecoder(cfg)
							return testDecoder
						},
						{
							input: "audio_pcm",
							output: "text",
							integrationPattern: "pure_consumer",
						},
					)

					// Use fixed values that work with second-based uptime
					const healthCheckInterval = 200
					const idleTimeout = 1000

					const manager = new DecoderManager(registry, fanout, testLogger, {
						healthCheckInterval,
						idleTimeout,
						restartDelay: 10,
						maxRestartDelay: 50,
						maxRestarts: 2,
					})

					// Track health transitions
					const transitions: Array<{ from: DecoderHealth; to: DecoderHealth }> =
						[]
					let lastHealth: DecoderHealth = "running"

					manager.on("decoder:health", (_id: string, health: DecoderHealth) => {
						transitions.push({ from: lastHealth, to: health })
						lastHealth = health
					})

					// Create and start decoder
					manager.createDecoder(config)
					await manager.startDecoder(config.id)

					// Trigger various state changes (need > 1000ms for degraded)
					// idleTimeout + 1000ms + buffer
					await vi.advanceTimersByTimeAsync(2500) // Should go to degraded
					testDecoder!.simulateOutput() // Should go back to running
					await vi.advanceTimersByTimeAsync(500)

					// Trigger crash loop
					for (let i = 0; i < 3; i++) {
						testDecoder!.simulateExit(1, null)
						await vi.advanceTimersByTimeAsync(100)
					}

					// Cleanup
					await manager.destroy()
					fanout.detachSource()

					// Validate all transitions are valid
					const validTransitions = [
						["running", "idle"],
						["idle", "running"],
						["running", "faulted"],
						["idle", "faulted"],
					]

					const allTransitionsValid = transitions.every(t =>
						validTransitions.some(
							([from, to]) => t.from === from && t.to === to,
						),
					)

					return allTransitionsValid
				}),
				{ numRuns: 100 },
			)
		})
	})
})
