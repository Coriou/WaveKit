/**
 * Property-Based Test: Decoder Failure Isolation
 *
 * Feature: docker-setup, Property 19: Decoder Failure Isolation
 * Validates: Requirements 10.1
 *
 * For any decoder that fails or crashes, all other configured decoders
 * SHALL continue operating without interruption.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
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
 * Mock decoder implementation for testing isolation behavior.
 * Allows simulating failures, crashes, and output production.
 */
class MockDecoder extends EventEmitter implements Decoder {
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
	private _shouldFailOnStart = false
	private _shouldCrashAfterStart = false
	private _crashDelay = 0

	constructor(config: DecoderConfig) {
		super()
		this.id = config.id
		this.type = config.type
	}

	// Test helpers to configure failure behavior
	setShouldFailOnStart(fail: boolean): void {
		this._shouldFailOnStart = fail
	}

	setShouldCrashAfterStart(crash: boolean, delay = 10): void {
		this._shouldCrashAfterStart = crash
		this._crashDelay = delay
	}

	async start(): Promise<void> {
		if (this._shouldFailOnStart) {
			throw new Error(`Simulated start failure for decoder ${this.id}`)
		}

		this._running = true
		this._pid = Math.floor(Math.random() * 65535) + 1
		this._startTime = Date.now()
		this.emit("started")

		// Schedule crash if configured
		if (this._shouldCrashAfterStart) {
			setTimeout(() => {
				if (this._running) {
					this._running = false
					this._pid = undefined
					this.emit("exit", 1, null)
				}
			}, this._crashDelay)
		}
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

	// Simulate producing output
	simulateOutput(): void {
		const output: DecoderOutput = {
			timestamp: new Date(),
			decoder: this.id,
			type: "decode",
			data: { test: true },
		}
		this._stats.eventsOut++
		this.outputStream.write(output)
		this.emit("output", output)
	}

	// Simulate an error event
	simulateError(error: Error): void {
		this._stats.errors++
		this.emit("error", error)
	}

	// Simulate a crash (exit event)
	simulateCrash(code = 1): void {
		if (this._running) {
			this._running = false
			this._pid = undefined
			this.emit("exit", code, null)
		}
	}

	getHealth(): DecoderHealth {
		return this._health
	}

	getStatus(): DecoderStatus {
		const uptime = this._running
			? Math.floor((Date.now() - this._startTime) / 1000)
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

	isRunning(): boolean {
		return this._running
	}
}

/**
 * Arbitrary for generating valid decoder IDs.
 */
const decoderIdArb = fc
	.stringMatching(/^[a-z][a-z0-9-]{0,15}$/)
	.filter(s => s.length > 0)

/**
 * Arbitrary for generating a set of unique decoder IDs.
 */
const decoderIdSetArb = (minSize: number, maxSize: number) =>
	fc
		.array(decoderIdArb, { minLength: minSize, maxLength: maxSize })
		.map(ids => [...new Set(ids)])
		.filter(ids => ids.length >= minSize)

describe("Feature: docker-setup, Property 19: Decoder Failure Isolation", () => {
	let registry: DecoderRegistry
	let fanout: FanoutManager
	let manager: DecoderManager
	let createdDecoders: Map<string, MockDecoder>

	beforeEach(() => {
		createdDecoders = new Map()
		registry = new DecoderRegistry()

		// Register a mock decoder factory that tracks created instances
		registry.register(
			"mock",
			(config, _logger) => {
				const decoder = new MockDecoder(config)
				createdDecoders.set(config.id, decoder)
				return decoder
			},
			{
				input: "audio_pcm",
				wantsExclusiveSource: false,
				preferredSampleRates: [48000],
				output: "text",
				integrationPattern: "pure_consumer",
			},
		)

		// Create a mock fanout manager
		fanout = {
			addBranch: vi.fn().mockReturnValue(new PassThrough()),
			removeBranch: vi.fn(),
		} as unknown as FanoutManager

		// Create manager with short restart delay for faster tests
		manager = new DecoderManager(registry, fanout, testLogger, {
			restartDelay: 10,
			maxRestartDelay: 50,
			maxRestarts: 3,
			healthCheckInterval: 1000,
			degradedTimeout: 5000,
			validateVersions: false,
		})
	})

	afterEach(async () => {
		await manager.destroy()
		createdDecoders.clear()
	})

	/**
	 * Property 19.1: Single decoder crash does not affect other running decoders
	 *
	 * For any set of running decoders, when one decoder crashes,
	 * all other decoders SHALL remain running.
	 */
	it("should keep other decoders running when one decoder crashes", async () => {
		await fc.assert(
			fc.asyncProperty(
				// Generate 2-5 unique decoder IDs
				decoderIdSetArb(2, 5),
				// Select which decoder will crash (index)
				fc.nat(),
				async (decoderIds, crashIndexRaw) => {
					// Ensure we have at least 2 decoders
					if (decoderIds.length < 2) return true

					const crashIndex = crashIndexRaw % decoderIds.length

					// Create and start all decoders
					for (const id of decoderIds) {
						manager.createDecoder({
							id,
							type: "mock",
							enabled: true,
							options: {},
						})
						await manager.startDecoder(id)
					}

					// Verify all decoders are running
					for (const id of decoderIds) {
						const status = manager.getStatus(id)
						if (!status?.running) return false
					}

					// Get the decoder that will crash
					const crashingId = decoderIds[crashIndex]!
					const crashingDecoder = createdDecoders.get(crashingId)
					if (!crashingDecoder) return false

					// Simulate crash
					crashingDecoder.simulateCrash()

					// Wait a bit for event processing
					await new Promise(resolve => setTimeout(resolve, 5))

					// Property: All OTHER decoders should still be running
					for (let i = 0; i < decoderIds.length; i++) {
						if (i === crashIndex) continue // Skip the crashed decoder

						const id = decoderIds[i]!
						const decoder = createdDecoders.get(id)
						if (!decoder?.isRunning()) {
							return false // Other decoder stopped - isolation failed
						}
					}

					// Clean up for next iteration
					for (const id of decoderIds) {
						await manager.removeDecoder(id)
					}

					return true
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 19.2: Decoder error events do not affect other decoders
	 *
	 * For any set of running decoders, when one decoder emits an error event,
	 * all other decoders SHALL continue operating.
	 */
	it("should keep other decoders running when one decoder emits an error", async () => {
		await fc.assert(
			fc.asyncProperty(
				// Generate 2-5 unique decoder IDs
				decoderIdSetArb(2, 5),
				// Select which decoder will error (index)
				fc.nat(),
				// Error message
				fc.string({ minLength: 1, maxLength: 50 }),
				async (decoderIds, errorIndexRaw, errorMessage) => {
					// Ensure we have at least 2 decoders
					if (decoderIds.length < 2) return true

					const errorIndex = errorIndexRaw % decoderIds.length

					// Create and start all decoders
					for (const id of decoderIds) {
						manager.createDecoder({
							id,
							type: "mock",
							enabled: true,
							options: {},
						})
						await manager.startDecoder(id)
					}

					// Get the decoder that will error
					const erroringId = decoderIds[errorIndex]!
					const erroringDecoder = createdDecoders.get(erroringId)
					if (!erroringDecoder) return false

					// Simulate error
					erroringDecoder.simulateError(new Error(errorMessage))

					// Wait a bit for event processing
					await new Promise(resolve => setTimeout(resolve, 5))

					// Property: All decoders (including the erroring one) should still be running
					// Error events don't stop decoders, only exit events do
					for (const id of decoderIds) {
						const decoder = createdDecoders.get(id)
						if (!decoder?.isRunning()) {
							return false // Decoder stopped - isolation failed
						}
					}

					// Clean up for next iteration
					for (const id of decoderIds) {
						await manager.removeDecoder(id)
					}

					return true
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 19.3: Multiple decoder crashes are isolated from each other
	 *
	 * For any set of running decoders, when multiple decoders crash sequentially,
	 * the remaining decoders SHALL continue operating.
	 */
	it("should keep remaining decoders running when multiple decoders crash", async () => {
		await fc.assert(
			fc.asyncProperty(
				// Generate 3-5 unique decoder IDs (need at least 3 to have survivors)
				decoderIdSetArb(3, 5),
				// Number of decoders to crash (1 to n-1)
				fc.nat(),
				async (decoderIds, crashCountRaw) => {
					// Ensure we have at least 3 decoders
					if (decoderIds.length < 3) return true

					// Crash at most n-1 decoders (leave at least 1 running)
					const crashCount = (crashCountRaw % (decoderIds.length - 1)) + 1

					// Create and start all decoders
					for (const id of decoderIds) {
						manager.createDecoder({
							id,
							type: "mock",
							enabled: true,
							options: {},
						})
						await manager.startDecoder(id)
					}

					// Crash the first N decoders
					const crashedIds = new Set<string>()
					for (let i = 0; i < crashCount; i++) {
						const id = decoderIds[i]!
						crashedIds.add(id)
						const decoder = createdDecoders.get(id)
						decoder?.simulateCrash()
						// Small delay between crashes
						await new Promise(resolve => setTimeout(resolve, 2))
					}

					// Wait for event processing
					await new Promise(resolve => setTimeout(resolve, 10))

					// Property: All non-crashed decoders should still be running
					for (const id of decoderIds) {
						if (crashedIds.has(id)) continue

						const decoder = createdDecoders.get(id)
						if (!decoder?.isRunning()) {
							return false // Survivor decoder stopped - isolation failed
						}
					}

					// Clean up for next iteration
					for (const id of decoderIds) {
						await manager.removeDecoder(id)
					}

					return true
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 19.4: Decoder output continues from healthy decoders during failures
	 *
	 * For any set of running decoders, when one decoder crashes,
	 * other decoders SHALL continue producing output.
	 */
	it("should allow other decoders to produce output when one crashes", async () => {
		await fc.assert(
			fc.asyncProperty(
				// Generate 2-4 unique decoder IDs
				decoderIdSetArb(2, 4),
				// Select which decoder will crash (index)
				fc.nat(),
				async (decoderIds, crashIndexRaw) => {
					// Ensure we have at least 2 decoders
					if (decoderIds.length < 2) return true

					const crashIndex = crashIndexRaw % decoderIds.length

					// Track output events
					const outputReceived = new Map<string, number>()
					for (const id of decoderIds) {
						outputReceived.set(id, 0)
					}

					// Listen for output events
					manager.on("decoder:output", (decoderId: string) => {
						const current = outputReceived.get(decoderId) ?? 0
						outputReceived.set(decoderId, current + 1)
					})

					// Create and start all decoders
					for (const id of decoderIds) {
						manager.createDecoder({
							id,
							type: "mock",
							enabled: true,
							options: {},
						})
						await manager.startDecoder(id)
					}

					// Get the decoder that will crash
					const crashingId = decoderIds[crashIndex]!
					const crashingDecoder = createdDecoders.get(crashingId)
					if (!crashingDecoder) return false

					// Simulate crash
					crashingDecoder.simulateCrash()

					// Wait a bit for event processing
					await new Promise(resolve => setTimeout(resolve, 5))

					// Have surviving decoders produce output
					for (let i = 0; i < decoderIds.length; i++) {
						if (i === crashIndex) continue

						const id = decoderIds[i]!
						const decoder = createdDecoders.get(id)
						decoder?.simulateOutput()
					}

					// Wait for output events
					await new Promise(resolve => setTimeout(resolve, 5))

					// Property: All surviving decoders should have produced output
					for (let i = 0; i < decoderIds.length; i++) {
						if (i === crashIndex) continue

						const id = decoderIds[i]!
						const count = outputReceived.get(id) ?? 0
						if (count === 0) {
							return false // Surviving decoder couldn't produce output
						}
					}

					// Clean up
					manager.removeAllListeners()
					for (const id of decoderIds) {
						await manager.removeDecoder(id)
					}

					return true
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 19.5: Manager continues to accept new decoders after failures
	 *
	 * For any decoder that crashes, the manager SHALL continue to accept
	 * and start new decoder instances.
	 */
	it("should accept new decoders after existing decoder crashes", async () => {
		await fc.assert(
			fc.asyncProperty(
				// Initial decoder ID
				decoderIdArb,
				// New decoder ID (must be different)
				decoderIdArb,
				async (initialId, newIdBase) => {
					// Ensure IDs are different
					const newId = initialId === newIdBase ? `${newIdBase}-new` : newIdBase

					// Create and start initial decoder
					manager.createDecoder({
						id: initialId,
						type: "mock",
						enabled: true,
						options: {},
					})
					await manager.startDecoder(initialId)

					// Crash the initial decoder
					const initialDecoder = createdDecoders.get(initialId)
					initialDecoder?.simulateCrash()

					// Wait for crash processing
					await new Promise(resolve => setTimeout(resolve, 5))

					// Property: Should be able to create and start a new decoder
					try {
						manager.createDecoder({
							id: newId,
							type: "mock",
							enabled: true,
							options: {},
						})
						await manager.startDecoder(newId)

						const newDecoder = createdDecoders.get(newId)
						const result = newDecoder?.isRunning() === true

						// Clean up
						await manager.removeDecoder(initialId)
						await manager.removeDecoder(newId)

						return result
					} catch {
						// Clean up on failure
						await manager.removeDecoder(initialId)
						return false
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
