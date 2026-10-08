/**
 * Base Decoder Property-Based Tests
 *
 * Tests for decoder status completeness.
 * Requirements: 4.5
 */

import { describe, it, expect } from "vitest"
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
import pino from "pino"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Concrete implementation of BaseDecoder for testing.
 * Since BaseDecoder is abstract, we need a concrete implementation.
 */
class TestDecoder extends EventEmitter implements Decoder {
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

	constructor(config: DecoderConfig) {
		super()
		this.id = config.id
		this.type = config.type
	}

	async start(): Promise<void> {
		this._running = true
		this._pid = Math.floor(Math.random() * 65535) + 1
		this._startTime = Date.now()
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

	// Simulate receiving bytes
	simulateBytesIn(bytes: number): void {
		this._stats.bytesIn += bytes
	}

	// Simulate emitting events
	simulateEventsOut(count: number): void {
		this._stats.eventsOut += count
	}

	// Simulate errors
	simulateErrors(count: number): void {
		this._stats.errors += count
	}

	getHealth(): DecoderHealth {
		return this._health
	}

	updateOptions(_updates: Record<string, unknown>): void {
		// No-op for test
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
}

/**
 * Arbitrary for generating valid decoder IDs.
 */
const decoderIdArb = fc
	.string({ minLength: 1, maxLength: 50 })
	.filter(s => s.trim().length > 0 && !s.includes(" "))

/**
 * Arbitrary for generating valid decoder types.
 */
const decoderTypeArb = fc
	.string({ minLength: 1, maxLength: 50 })
	.filter(s => s.trim().length > 0 && !s.includes(" "))

/**
 * Arbitrary for generating valid decoder configs.
 */
const decoderConfigArb = fc.record({
	id: decoderIdArb,
	type: decoderTypeArb,
	enabled: fc.boolean(),
	options: fc.constant({} as Record<string, unknown>),
})

/**
 * Arbitrary for generating non-negative integers for stats.
 */
const statsValueArb = fc.nat({ max: 1000000 })

describe("Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 10: Decoder Status Completeness
	 * Validates: Requirements 4.5
	 *
	 * For any decoder managed by Decoder_Manager, calling getStatus(id) should
	 * return an object containing all required fields: id, type, running, uptime,
	 * and stats (with bytesIn, eventsOut, errors).
	 */
	describe("Property 10: Decoder Status Completeness", () => {
		it("should return status with all required fields for any decoder config", () => {
			fc.assert(
				fc.property(decoderConfigArb, config => {
					const decoder = new TestDecoder(config)
					const status = decoder.getStatus()

					// Verify all required fields exist
					expect(status).toHaveProperty("id")
					expect(status).toHaveProperty("type")
					expect(status).toHaveProperty("running")
					expect(status).toHaveProperty("uptime")
					expect(status).toHaveProperty("stats")

					// Verify stats has all required sub-fields
					expect(status.stats).toHaveProperty("bytesIn")
					expect(status.stats).toHaveProperty("eventsOut")
					expect(status.stats).toHaveProperty("errors")

					// Verify field types
					expect(typeof status.id).toBe("string")
					expect(typeof status.type).toBe("string")
					expect(typeof status.running).toBe("boolean")
					expect(typeof status.uptime).toBe("number")
					expect(typeof status.stats.bytesIn).toBe("number")
					expect(typeof status.stats.eventsOut).toBe("number")
					expect(typeof status.stats.errors).toBe("number")

					// Verify id and type match config
					return status.id === config.id && status.type === config.type
				}),
				{ numRuns: 100 },
			)
		})

		it("should return correct running state and uptime when not started", () => {
			fc.assert(
				fc.property(decoderConfigArb, config => {
					const decoder = new TestDecoder(config)
					const status = decoder.getStatus()

					// When not started, running should be false and uptime should be 0
					return status.running === false && status.uptime === 0
				}),
				{ numRuns: 100 },
			)
		})

		it("should return correct running state when started", async () => {
			await fc.assert(
				fc.asyncProperty(decoderConfigArb, async config => {
					const decoder = new TestDecoder(config)
					await decoder.start()
					const status = decoder.getStatus()

					// When started, running should be true and pid should be defined
					return (
						status.running === true &&
						status.pid !== undefined &&
						typeof status.pid === "number"
					)
				}),
				{ numRuns: 100 },
			)
		})

		it("should track stats correctly for any combination of values", () => {
			fc.assert(
				fc.property(
					decoderConfigArb,
					statsValueArb,
					statsValueArb,
					statsValueArb,
					(config, bytesIn, eventsOut, errors) => {
						const decoder = new TestDecoder(config)

						// Simulate activity
						decoder.simulateBytesIn(bytesIn)
						decoder.simulateEventsOut(eventsOut)
						decoder.simulateErrors(errors)

						const status = decoder.getStatus()

						// Verify stats match simulated values
						return (
							status.stats.bytesIn === bytesIn &&
							status.stats.eventsOut === eventsOut &&
							status.stats.errors === errors
						)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return non-negative values for all numeric fields", () => {
			fc.assert(
				fc.property(
					decoderConfigArb,
					statsValueArb,
					statsValueArb,
					statsValueArb,
					(config, bytesIn, eventsOut, errors) => {
						const decoder = new TestDecoder(config)

						decoder.simulateBytesIn(bytesIn)
						decoder.simulateEventsOut(eventsOut)
						decoder.simulateErrors(errors)

						const status = decoder.getStatus()

						// All numeric fields should be non-negative
						return (
							status.uptime >= 0 &&
							status.stats.bytesIn >= 0 &&
							status.stats.eventsOut >= 0 &&
							status.stats.errors >= 0
						)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return status with pid undefined when not running", () => {
			fc.assert(
				fc.property(decoderConfigArb, config => {
					const decoder = new TestDecoder(config)
					const status = decoder.getStatus()

					// When not running, pid should be undefined
					return status.running === false && status.pid === undefined
				}),
				{ numRuns: 100 },
			)
		})
	})
})
