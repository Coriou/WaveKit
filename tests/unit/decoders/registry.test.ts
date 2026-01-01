/**
 * Decoder Registry Property-Based Tests
 *
 * Tests for the decoder plugin registration system.
 * Requirements: 5.1, 5.2, 5.3, 5.4, 17.1, 17.2
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
	DecoderCaps,
	DecoderConfig,
	DecoderHealth,
	DecoderStatus,
	DecoderInputType,
	DecoderOutputFormat,
	DecoderIntegrationPattern,
} from "../../../src/decoders/types.js"
import type { SourceCaps } from "../../../src/config.js"
import { RegistryError } from "../../../src/utils/errors.js"
import pino from "pino"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Default decoder capabilities for testing.
 */
const defaultCaps: DecoderCaps = {
	input: "audio_pcm",
	wantsExclusiveSource: false,
	preferredSampleRates: [48000],
	output: "text",
	integrationPattern: "pure_consumer",
}

/**
 * Mock decoder implementation for testing the registry.
 * Implements the Decoder interface with minimal functionality.
 */
class MockDecoder extends EventEmitter implements Decoder {
	readonly id: string
	readonly type: string
	readonly caps: DecoderCaps
	private outputStream = new PassThrough({ objectMode: true })
	private _health: DecoderHealth = "running"

	constructor(config: DecoderConfig, caps: DecoderCaps = defaultCaps) {
		super()
		this.id = config.id
		this.type = config.type
		this.caps = caps
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

	getHealth(): DecoderHealth {
		return this._health
	}

	getStatus(): DecoderStatus {
		return {
			id: this.id,
			type: this.type,
			running: false,
			health: this._health,
			uptime: 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			lastOutputAt: undefined,
			restartCount: 0,
			version: undefined,
		}
	}
}

/**
 * Creates a mock decoder factory for testing.
 */
function createMockFactory(caps: DecoderCaps = defaultCaps): DecoderFactory {
	return (config: DecoderConfig) => new MockDecoder(config, caps)
}

/**
 * Arbitrary for generating valid decoder type names.
 * Decoder types are non-empty strings without whitespace.
 */
const decoderTypeArb = fc
	.string({ minLength: 1, maxLength: 50 })
	.filter(s => s.trim().length > 0 && !s.includes(" "))

/**
 * Arbitrary for generating decoder input types.
 */
const decoderInputTypeArb: fc.Arbitrary<DecoderInputType> = fc.constantFrom(
	"audio_pcm",
	"iq",
	"external",
)

/**
 * Arbitrary for generating decoder output formats.
 */
const decoderOutputFormatArb: fc.Arbitrary<DecoderOutputFormat> =
	fc.constantFrom("jsonl", "nmea", "beast", "text")

/**
 * Arbitrary for generating decoder integration patterns.
 */
const decoderIntegrationPatternArb: fc.Arbitrary<DecoderIntegrationPattern> =
	fc.constantFrom("pure_consumer", "network_producer", "external_sdr")

/**
 * Arbitrary for generating decoder capabilities.
 */
const decoderCapsArb: fc.Arbitrary<DecoderCaps> = fc.record({
	input: decoderInputTypeArb,
	wantsExclusiveSource: fc.option(fc.boolean(), { nil: undefined }),
	preferredSampleRates: fc.option(
		fc.array(fc.integer({ min: 8000, max: 192000 }), {
			minLength: 1,
			maxLength: 5,
		}),
		{ nil: undefined },
	),
	output: decoderOutputFormatArb,
	integrationPattern: decoderIntegrationPatternArb,
})

/**
 * Arbitrary for generating source capabilities.
 */
const sourceCapsArb: fc.Arbitrary<SourceCaps> = fc.record({
	kind: fc.constantFrom(
		"audio_pcm" as const,
		"iq" as const,
		"recording" as const,
	),
	sampleRate: fc.integer({ min: 8000, max: 192000 }),
	format: fc.constantFrom(
		"S16LE" as const,
		"FLOAT32LE" as const,
		"U8_IQ" as const,
		"S16_IQ" as const,
	),
	channels: fc.option(fc.integer({ min: 1, max: 2 }), { nil: undefined }),
	centerFreq: fc.option(fc.integer({ min: 1000000, max: 6000000000 }), {
		nil: undefined,
	}),
	exclusive: fc.boolean(),
})

describe("Decoder Registry", () => {
	let registry: DecoderRegistry

	beforeEach(() => {
		registry = new DecoderRegistry()
	})

	describe("Unit Tests", () => {
		it("should register a decoder factory with capabilities", () => {
			const factory = createMockFactory()
			registry.register("test-decoder", factory, defaultCaps)
			expect(registry.has("test-decoder")).toBe(true)
		})

		it("should unregister a decoder factory", () => {
			const factory = createMockFactory()
			registry.register("test-decoder", factory, defaultCaps)
			expect(registry.unregister("test-decoder")).toBe(true)
			expect(registry.has("test-decoder")).toBe(false)
		})

		it("should return false when unregistering non-existent type", () => {
			expect(registry.unregister("non-existent")).toBe(false)
		})

		it("should create a decoder using registered factory", () => {
			const factory = createMockFactory()
			registry.register("test-decoder", factory, defaultCaps)

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
			registry.register("decoder-a", createMockFactory(), defaultCaps)
			registry.register("decoder-b", createMockFactory(), defaultCaps)
			registry.register("decoder-c", createMockFactory(), defaultCaps)

			const types = registry.getRegisteredTypes()
			expect(types).toContain("decoder-a")
			expect(types).toContain("decoder-b")
			expect(types).toContain("decoder-c")
			expect(types).toHaveLength(3)
		})

		it("should return capabilities for registered type", () => {
			const caps: DecoderCaps = {
				input: "iq",
				wantsExclusiveSource: true,
				preferredSampleRates: [2400000],
				output: "jsonl",
				integrationPattern: "external_sdr",
			}
			registry.register("test-decoder", createMockFactory(caps), caps)

			const retrievedCaps = registry.getCaps("test-decoder")
			expect(retrievedCaps).toEqual(caps)
		})

		it("should return undefined for unregistered type capabilities", () => {
			expect(registry.getCaps("non-existent")).toBeUndefined()
		})

		it("should return metadata for registered type", () => {
			const caps: DecoderCaps = {
				input: "audio_pcm",
				output: "text",
				integrationPattern: "pure_consumer",
			}
			const factory = createMockFactory(caps)
			registry.register("test-decoder", factory, caps, {
				min: "1.0.0",
				max: "2.0.0",
			})

			const meta = registry.getMeta("test-decoder")
			expect(meta).toBeDefined()
			expect(meta?.factory).toBe(factory)
			expect(meta?.caps).toEqual(caps)
			expect(meta?.minVersion).toBe("1.0.0")
			expect(meta?.maxVersion).toBe("2.0.0")
		})

		it("should get decoders by input type", () => {
			const audioCaps: DecoderCaps = {
				input: "audio_pcm",
				output: "text",
				integrationPattern: "pure_consumer",
			}
			const iqCaps: DecoderCaps = {
				input: "iq",
				output: "jsonl",
				integrationPattern: "pure_consumer",
			}
			const externalCaps: DecoderCaps = {
				input: "external",
				output: "jsonl",
				integrationPattern: "external_sdr",
			}

			registry.register(
				"audio-decoder",
				createMockFactory(audioCaps),
				audioCaps,
			)
			registry.register("iq-decoder", createMockFactory(iqCaps), iqCaps)
			registry.register(
				"external-decoder",
				createMockFactory(externalCaps),
				externalCaps,
			)

			expect(registry.getDecodersByInput("audio_pcm")).toEqual([
				"audio-decoder",
			])
			expect(registry.getDecodersByInput("iq")).toEqual(["iq-decoder"])
			expect(registry.getDecodersByInput("external")).toEqual([
				"external-decoder",
			])
		})

		it("should get decoders by output format", () => {
			const textCaps: DecoderCaps = {
				input: "audio_pcm",
				output: "text",
				integrationPattern: "pure_consumer",
			}
			const jsonlCaps: DecoderCaps = {
				input: "audio_pcm",
				output: "jsonl",
				integrationPattern: "pure_consumer",
			}
			const nmeaCaps: DecoderCaps = {
				input: "audio_pcm",
				output: "nmea",
				integrationPattern: "network_producer",
			}

			registry.register("text-decoder", createMockFactory(textCaps), textCaps)
			registry.register(
				"jsonl-decoder",
				createMockFactory(jsonlCaps),
				jsonlCaps,
			)
			registry.register("nmea-decoder", createMockFactory(nmeaCaps), nmeaCaps)

			expect(registry.getDecodersByOutput("text")).toEqual(["text-decoder"])
			expect(registry.getDecodersByOutput("jsonl")).toEqual(["jsonl-decoder"])
			expect(registry.getDecodersByOutput("nmea")).toEqual(["nmea-decoder"])
		})

		it("should get compatible decoders for source capabilities", () => {
			const audioCaps: DecoderCaps = {
				input: "audio_pcm",
				output: "text",
				integrationPattern: "pure_consumer",
			}
			const iqCaps: DecoderCaps = {
				input: "iq",
				output: "jsonl",
				integrationPattern: "pure_consumer",
			}
			const externalCaps: DecoderCaps = {
				input: "external",
				output: "jsonl",
				integrationPattern: "external_sdr",
			}

			registry.register(
				"audio-decoder",
				createMockFactory(audioCaps),
				audioCaps,
			)
			registry.register("iq-decoder", createMockFactory(iqCaps), iqCaps)
			registry.register(
				"external-decoder",
				createMockFactory(externalCaps),
				externalCaps,
			)

			const audioSource: SourceCaps = {
				kind: "audio_pcm",
				sampleRate: 48000,
				format: "S16LE",
				exclusive: false,
			}
			const iqSource: SourceCaps = {
				kind: "iq",
				sampleRate: 2400000,
				format: "U8_IQ",
				exclusive: false,
			}

			// Audio source should be compatible with audio-decoder and external-decoder
			const audioCompatible = registry.getCompatibleDecoders(audioSource)
			expect(audioCompatible).toContain("audio-decoder")
			expect(audioCompatible).toContain("external-decoder")
			expect(audioCompatible).not.toContain("iq-decoder")

			// IQ source should be compatible with iq-decoder and external-decoder
			const iqCompatible = registry.getCompatibleDecoders(iqSource)
			expect(iqCompatible).toContain("iq-decoder")
			expect(iqCompatible).toContain("external-decoder")
			expect(iqCompatible).not.toContain("audio-decoder")
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
				fc.property(decoderTypeArb, decoderCapsArb, (decoderType, caps) => {
					const registry = new DecoderRegistry()
					const factory = createMockFactory(caps)

					// Before registration, has() should return false
					expect(registry.has(decoderType)).toBe(false)

					// Register the type with capabilities
					registry.register(decoderType, factory, caps)

					// After registration, has() should return true
					return registry.has(decoderType) === true
				}),
				{ numRuns: 100 },
			)
		})

		it("should include registered type in getRegisteredTypes() (5.4)", () => {
			fc.assert(
				fc.property(decoderTypeArb, decoderCapsArb, (decoderType, caps) => {
					const registry = new DecoderRegistry()
					const factory = createMockFactory(caps)

					// Before registration, type should not be in list
					expect(registry.getRegisteredTypes()).not.toContain(decoderType)

					// Register the type with capabilities
					registry.register(decoderType, factory, caps)

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
					decoderCapsArb,
					(decoderType, decoderId, caps) => {
						const registry = new DecoderRegistry()
						const factory = createMockFactory(caps)

						// Register the type with capabilities
						registry.register(decoderType, factory, caps)

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
					decoderCapsArb,
					(registeredType, unregisteredType, decoderId, caps) => {
						// Skip if types are the same
						if (registeredType === unregisteredType) return true

						const registry = new DecoderRegistry()
						const factory = createMockFactory(caps)

						// Register only one type with capabilities
						registry.register(registeredType, factory, caps)

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
					fc.array(fc.tuple(decoderTypeArb, decoderCapsArb), {
						minLength: 1,
						maxLength: 20,
					}),
					typeCapsPairs => {
						const registry = new DecoderRegistry()

						// Get unique types (by type name)
						const uniqueTypes = new Map<string, DecoderCaps>()
						for (const [type, caps] of typeCapsPairs) {
							uniqueTypes.set(type, caps)
						}

						// Register all types with their capabilities
						for (const [type, caps] of uniqueTypes) {
							const factory = createMockFactory(caps)
							registry.register(type, factory, caps)
						}

						// Verify all types are registered
						const registeredTypes = registry.getRegisteredTypes()

						// All unique types should be in the registry
						for (const type of uniqueTypes.keys()) {
							if (!registry.has(type)) return false
							if (!registeredTypes.includes(type)) return false
						}

						// Registry should have exactly the unique types count
						return registeredTypes.length === uniqueTypes.size
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should correctly handle unregister operations", () => {
			fc.assert(
				fc.property(decoderTypeArb, decoderCapsArb, (decoderType, caps) => {
					const registry = new DecoderRegistry()
					const factory = createMockFactory(caps)

					// Register the type with capabilities
					registry.register(decoderType, factory, caps)
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

		it("should store and retrieve capabilities correctly (17.1)", () => {
			fc.assert(
				fc.property(decoderTypeArb, decoderCapsArb, (decoderType, caps) => {
					const registry = new DecoderRegistry()
					const factory = createMockFactory(caps)

					// Register the type with capabilities
					registry.register(decoderType, factory, caps)

					// Retrieve capabilities
					const retrievedCaps = registry.getCaps(decoderType)

					// Verify capabilities match
					return (
						retrievedCaps !== undefined &&
						retrievedCaps.input === caps.input &&
						retrievedCaps.output === caps.output &&
						retrievedCaps.integrationPattern === caps.integrationPattern
					)
				}),
				{ numRuns: 100 },
			)
		})

		it("should filter decoders by input type correctly", () => {
			fc.assert(
				fc.property(
					fc.array(fc.tuple(decoderTypeArb, decoderCapsArb), {
						minLength: 1,
						maxLength: 10,
					}),
					decoderInputTypeArb,
					(typeCapsPairs, targetInput) => {
						const registry = new DecoderRegistry()

						// Get unique types
						const uniqueTypes = new Map<string, DecoderCaps>()
						for (const [type, caps] of typeCapsPairs) {
							uniqueTypes.set(type, caps)
						}

						// Register all types
						for (const [type, caps] of uniqueTypes) {
							registry.register(type, createMockFactory(caps), caps)
						}

						// Get decoders by input type
						const matchingDecoders = registry.getDecodersByInput(targetInput)

						// Verify all returned decoders have the correct input type
						for (const type of matchingDecoders) {
							const caps = registry.getCaps(type)
							if (!caps || caps.input !== targetInput) return false
						}

						// Verify all decoders with matching input are returned
						for (const [type, caps] of uniqueTypes) {
							if (
								caps.input === targetInput &&
								!matchingDecoders.includes(type)
							) {
								return false
							}
						}

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should filter decoders by output format correctly", () => {
			fc.assert(
				fc.property(
					fc.array(fc.tuple(decoderTypeArb, decoderCapsArb), {
						minLength: 1,
						maxLength: 10,
					}),
					decoderOutputFormatArb,
					(typeCapsPairs, targetOutput) => {
						const registry = new DecoderRegistry()

						// Get unique types
						const uniqueTypes = new Map<string, DecoderCaps>()
						for (const [type, caps] of typeCapsPairs) {
							uniqueTypes.set(type, caps)
						}

						// Register all types
						for (const [type, caps] of uniqueTypes) {
							registry.register(type, createMockFactory(caps), caps)
						}

						// Get decoders by output format
						const matchingDecoders = registry.getDecodersByOutput(targetOutput)

						// Verify all returned decoders have the correct output format
						for (const type of matchingDecoders) {
							const caps = registry.getCaps(type)
							if (!caps || caps.output !== targetOutput) return false
						}

						// Verify all decoders with matching output are returned
						for (const [type, caps] of uniqueTypes) {
							if (
								caps.output === targetOutput &&
								!matchingDecoders.includes(type)
							) {
								return false
							}
						}

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should find compatible decoders for source capabilities", () => {
			fc.assert(
				fc.property(
					fc.array(fc.tuple(decoderTypeArb, decoderCapsArb), {
						minLength: 1,
						maxLength: 10,
					}),
					sourceCapsArb,
					(typeCapsPairs, sourceCaps) => {
						const registry = new DecoderRegistry()

						// Get unique types
						const uniqueTypes = new Map<string, DecoderCaps>()
						for (const [type, caps] of typeCapsPairs) {
							uniqueTypes.set(type, caps)
						}

						// Register all types
						for (const [type, caps] of uniqueTypes) {
							registry.register(type, createMockFactory(caps), caps)
						}

						// Get compatible decoders
						const compatibleDecoders =
							registry.getCompatibleDecoders(sourceCaps)

						// Verify all returned decoders are compatible
						for (const type of compatibleDecoders) {
							const caps = registry.getCaps(type)
							if (!caps) return false

							// External decoders are always compatible
							if (caps.input === "external") continue

							// Otherwise, input type must match source kind
							if (caps.input !== sourceCaps.kind) return false
						}

						// Verify all compatible decoders are returned
						for (const [type, caps] of uniqueTypes) {
							const isCompatible =
								caps.input === "external" || caps.input === sourceCaps.kind
							if (isCompatible && !compatibleDecoders.includes(type)) {
								return false
							}
						}

						return true
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})
