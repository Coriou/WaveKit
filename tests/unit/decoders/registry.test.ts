/**
 * Decoder Registry Property-Based Tests
 *
 * Tests for the decoder plugin registration system.
 * Requirements: 5.1, 5.2, 5.3, 5.4
 */

import { describe, it, expect, beforeEach } from "vitest"
import * as fc from "fast-check"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import {
	DecoderRegistry,
	type DecoderFactory,
} from "../../../src/decoders/registry.js"
import type {
	Decoder,
	DecoderConfig,
	DecoderStatus,
} from "../../../src/decoders/types.js"
import { RegistryError } from "../../../src/utils/errors.js"
import pino from "pino"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Mock decoder implementation for testing the registry.
 * Implements the Decoder interface with minimal functionality.
 */
class MockDecoder extends EventEmitter implements Decoder {
	readonly id: string
	readonly type: string
	private outputStream = new PassThrough({ objectMode: true })

	constructor(config: DecoderConfig) {
		super()
		this.id = config.id
		this.type = config.type
	}

	async start(): Promise<void> {
		this.emit("started")
	}

	async stop(): Promise<void> {
		this.emit("stopped")
	}

	async restart(): Promise<void> {
		await this.stop()
		await this.start()
	}

	attachInput(_stream: Readable): void {
		// No-op for mock
	}

	detachInput(): void {
		// No-op for mock
	}

	getOutput(): Readable {
		return this.outputStream
	}

	getAudioOutput(): Readable | null {
		return null
	}

	getStatus(): DecoderStatus {
		return {
			id: this.id,
			type: this.type,
			running: false,
			uptime: 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
		}
	}
}

/**
 * Creates a mock decoder factory for testing.
 */
function createMockFactory(): DecoderFactory {
	return (config: DecoderConfig) => new MockDecoder(config)
}

/**
 * Arbitrary for generating valid decoder type names.
 * Decoder types are non-empty strings without whitespace.
 */
const decoderTypeArb = fc
	.string({ minLength: 1, maxLength: 50 })
	.filter(s => s.trim().length > 0 && !s.includes(" "))

/**
 * Arbitrary for generating valid decoder configs.
 */
const decoderConfigArb = (type: string) =>
	fc.record({
		id: fc
			.string({ minLength: 1, maxLength: 50 })
			.filter(s => s.trim().length > 0),
		type: fc.constant(type),
		enabled: fc.boolean(),
		options: fc.constant({} as Record<string, unknown>),
	})

describe("Decoder Registry", () => {
	let registry: DecoderRegistry

	beforeEach(() => {
		registry = new DecoderRegistry()
	})

	describe("Unit Tests", () => {
		it("should register a decoder factory", () => {
			const factory = createMockFactory()
			registry.register("test-decoder", factory)
			expect(registry.has("test-decoder")).toBe(true)
		})

		it("should unregister a decoder factory", () => {
			const factory = createMockFactory()
			registry.register("test-decoder", factory)
			expect(registry.unregister("test-decoder")).toBe(true)
			expect(registry.has("test-decoder")).toBe(false)
		})

		it("should return false when unregistering non-existent type", () => {
			expect(registry.unregister("non-existent")).toBe(false)
		})

		it("should create a decoder using registered factory", () => {
			const factory = createMockFactory()
			registry.register("test-decoder", factory)

			const config: DecoderConfig = {
				id: "decoder-1",
				type: "test-decoder",
				enabled: true,
				options: {},
			}

			const decoder = registry.create(config, testLogger)
			expect(decoder).toBeInstanceOf(MockDecoder)
			expect(decoder.id).toBe("decoder-1")
			expect(decoder.type).toBe("test-decoder")
		})

		it("should throw RegistryError for unregistered type", () => {
			const config: DecoderConfig = {
				id: "decoder-1",
				type: "unknown-decoder",
				enabled: true,
				options: {},
			}

			expect(() => registry.create(config, testLogger)).toThrow(RegistryError)
		})

		it("should list all registered types", () => {
			registry.register("decoder-a", createMockFactory())
			registry.register("decoder-b", createMockFactory())
			registry.register("decoder-c", createMockFactory())

			const types = registry.getRegisteredTypes()
			expect(types).toContain("decoder-a")
			expect(types).toContain("decoder-b")
			expect(types).toContain("decoder-c")
			expect(types).toHaveLength(3)
		})
	})
})

describe("Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 9: Decoder Registry Consistency
	 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
	 *
	 * For any decoder type T registered with factory F, the registry should:
	 * (a) return true for has(T)
	 * (b) include T in getRegisteredTypes()
	 * (c) successfully create a decoder when create({type: T, ...}) is called
	 * (d) return an error for any unregistered type U
	 */
	describe("Property 9: Decoder Registry Consistency", () => {
		it("should return true for has() after registering a type (5.1)", () => {
			fc.assert(
				fc.property(decoderTypeArb, decoderType => {
					const registry = new DecoderRegistry()
					const factory = createMockFactory()

					// Before registration, has() should return false
					expect(registry.has(decoderType)).toBe(false)

					// Register the type
					registry.register(decoderType, factory)

					// After registration, has() should return true
					return registry.has(decoderType) === true
				}),
				{ numRuns: 100 },
			)
		})

		it("should include registered type in getRegisteredTypes() (5.4)", () => {
			fc.assert(
				fc.property(decoderTypeArb, decoderType => {
					const registry = new DecoderRegistry()
					const factory = createMockFactory()

					// Before registration, type should not be in list
					expect(registry.getRegisteredTypes()).not.toContain(decoderType)

					// Register the type
					registry.register(decoderType, factory)

					// After registration, type should be in list
					return registry.getRegisteredTypes().includes(decoderType)
				}),
				{ numRuns: 100 },
			)
		})

		it("should successfully create decoder for registered type (5.2)", () => {
			fc.assert(
				fc.property(
					decoderTypeArb,
					fc
						.string({ minLength: 1, maxLength: 50 })
						.filter(s => s.trim().length > 0),
					(decoderType, decoderId) => {
						const registry = new DecoderRegistry()
						const factory = createMockFactory()

						// Register the type
						registry.register(decoderType, factory)

						// Create a decoder with this type
						const config: DecoderConfig = {
							id: decoderId,
							type: decoderType,
							enabled: true,
							options: {},
						}

						const decoder = registry.create(config, testLogger)

						// Verify decoder was created correctly
						return (
							decoder !== null &&
							decoder !== undefined &&
							decoder.id === decoderId &&
							decoder.type === decoderType
						)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should throw RegistryError for unregistered type (5.3)", () => {
			fc.assert(
				fc.property(
					decoderTypeArb,
					decoderTypeArb,
					fc
						.string({ minLength: 1, maxLength: 50 })
						.filter(s => s.trim().length > 0),
					(registeredType, unregisteredType, decoderId) => {
						// Skip if types are the same
						if (registeredType === unregisteredType) return true

						const registry = new DecoderRegistry()
						const factory = createMockFactory()

						// Register only one type
						registry.register(registeredType, factory)

						// Try to create decoder with unregistered type
						const config: DecoderConfig = {
							id: decoderId,
							type: unregisteredType,
							enabled: true,
							options: {},
						}

						try {
							registry.create(config, testLogger)
							// Should not reach here
							return false
						} catch (error) {
							// Should throw RegistryError
							return error instanceof RegistryError
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should maintain consistency with multiple registered types", () => {
			fc.assert(
				fc.property(
					fc.array(decoderTypeArb, { minLength: 1, maxLength: 20 }),
					decoderTypes => {
						const registry = new DecoderRegistry()
						const factory = createMockFactory()

						// Get unique types
						const uniqueTypes = [...new Set(decoderTypes)]

						// Register all types
						for (const type of uniqueTypes) {
							registry.register(type, factory)
						}

						// Verify all types are registered
						const registeredTypes = registry.getRegisteredTypes()

						// All unique types should be in the registry
						for (const type of uniqueTypes) {
							if (!registry.has(type)) return false
							if (!registeredTypes.includes(type)) return false
						}

						// Registry should have exactly the unique types count
						return registeredTypes.length === uniqueTypes.length
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should correctly handle unregister operations", () => {
			fc.assert(
				fc.property(decoderTypeArb, decoderType => {
					const registry = new DecoderRegistry()
					const factory = createMockFactory()

					// Register the type
					registry.register(decoderType, factory)
					expect(registry.has(decoderType)).toBe(true)

					// Unregister the type
					const result = registry.unregister(decoderType)

					// Verify unregister was successful
					return (
						result === true &&
						registry.has(decoderType) === false &&
						!registry.getRegisteredTypes().includes(decoderType)
					)
				}),
				{ numRuns: 100 },
			)
		})
	})
})
