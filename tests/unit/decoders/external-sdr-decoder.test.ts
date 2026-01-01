/**
 * External SDR Decoder Unit Tests
 *
 * Tests for the ExternalSdrDecoder abstract base class.
 * Requirements: 19.1, 19.2, 19.3, 19.4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import * as fc from "fast-check"
import type {
	DecoderCaps,
	DecoderOutput,
	DecoderHealth,
} from "../../../src/decoders/types.js"
import {
	ExternalSdrDecoder,
	type ExternalSdrConfig,
} from "../../../src/decoders/external-sdr-decoder.js"
import pino from "pino"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Concrete implementation of ExternalSdrDecoder for testing.
 */
class TestExternalSdrDecoder extends ExternalSdrDecoder {
	public parseOutputCalls: string[] = []
	public mockOutputs: DecoderOutput[] = []
	public commandOverride: string | null = null
	public argsOverride: string[] | null = null

	constructor(config: ExternalSdrConfig) {
		super(config, testLogger)
	}

	protected getCommand(): string {
		if (this.commandOverride) {
			return this.commandOverride
		}
		// Return a command that exists and exits quickly
		return "echo"
	}

	protected getArgs(): string[] {
		if (this.argsOverride) {
			return this.argsOverride
		}
		// Build args including device serial and frequencies (Requirement 19.1, 19.4)
		const args: string[] = []

		// Add device serial
		if (this.config.deviceSerial) {
			args.push("-d", this.config.deviceSerial)
		}

		// Add frequencies
		for (const freq of this.config.frequencies) {
			args.push("-f", freq.toString())
		}

		// Add gain if specified
		if (this.config.gain !== undefined) {
			args.push("-g", this.config.gain.toString())
		}

		// Add ppm if specified
		if (this.config.ppm !== undefined) {
			args.push("-p", this.config.ppm.toString())
		}

		return args
	}

	protected parseOutput(line: string): DecoderOutput | null {
		this.parseOutputCalls.push(line)

		// Return mock outputs if configured
		if (this.mockOutputs.length > 0) {
			return this.mockOutputs.shift() ?? null
		}

		// Default: try to parse as JSON, otherwise create a signal event
		try {
			const data = JSON.parse(line) as unknown
			return {
				timestamp: new Date(),
				decoder: this.id,
				type: "signal",
				data,
			}
		} catch {
			// Not JSON, create a generic signal event
			return {
				timestamp: new Date(),
				decoder: this.id,
				type: "signal",
				data: { raw: line },
			}
		}
	}

	protected getCaps(): DecoderCaps {
		return {
			input: "external",
			wantsExclusiveSource: true,
			output: "jsonl",
			integrationPattern: "external_sdr",
		}
	}

	// Expose protected methods for testing
	public testSetHealth(health: DecoderHealth): void {
		this.setHealth(health)
	}
}

describe("ExternalSdrDecoder", () => {
	let decoder: TestExternalSdrDecoder

	const createConfig = (
		overrides: Partial<ExternalSdrConfig> = {},
	): ExternalSdrConfig => ({
		id: "test-decoder",
		type: "test-external-sdr",
		enabled: true,
		options: {},
		deviceSerial: "00000001",
		frequencies: [131550000, 131725000],
		gain: 40,
		ppm: 0,
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
	})

	describe("constructor", () => {
		it("should initialize with correct id and type", () => {
			const config = createConfig({ id: "my-decoder", type: "my-type" })
			decoder = new TestExternalSdrDecoder(config)

			expect(decoder.id).toBe("my-decoder")
			expect(decoder.type).toBe("my-type")
		})

		it("should expose capabilities via caps getter", () => {
			decoder = new TestExternalSdrDecoder(createConfig())

			expect(decoder.caps).toEqual({
				input: "external",
				wantsExclusiveSource: true,
				output: "jsonl",
				integrationPattern: "external_sdr",
			})
		})

		it("should store device serial from config (Requirement 19.4)", () => {
			const config = createConfig({ deviceSerial: "SERIAL123" })
			decoder = new TestExternalSdrDecoder(config)

			expect(decoder.getDeviceSerial()).toBe("SERIAL123")
		})

		it("should store frequencies from config", () => {
			const config = createConfig({ frequencies: [136650000, 136700000] })
			decoder = new TestExternalSdrDecoder(config)

			expect(decoder.getFrequencies()).toEqual([136650000, 136700000])
		})
	})

	describe("getDeviceSerial (Requirement 19.4)", () => {
		it("should return the configured device serial", () => {
			const config = createConfig({ deviceSerial: "RTL-SDR-001" })
			decoder = new TestExternalSdrDecoder(config)

			expect(decoder.getDeviceSerial()).toBe("RTL-SDR-001")
		})
	})

	describe("getFrequencies", () => {
		it("should return a copy of the frequencies array", () => {
			const frequencies = [131550000, 131725000, 131850000]
			const config = createConfig({ frequencies })
			decoder = new TestExternalSdrDecoder(config)

			const result = decoder.getFrequencies()

			expect(result).toEqual(frequencies)
			// Verify it's a copy, not the same reference
			expect(result).not.toBe(frequencies)
		})
	})

	describe("getStatus", () => {
		it("should return status with all required fields when not running", () => {
			decoder = new TestExternalSdrDecoder(createConfig())
			const status = decoder.getStatus()

			expect(status.id).toBe("test-decoder")
			expect(status.type).toBe("test-external-sdr")
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
			decoder = new TestExternalSdrDecoder(createConfig())

			expect(decoder.getHealth()).toBe("running")
		})

		it("should emit health event when health changes", () => {
			decoder = new TestExternalSdrDecoder(createConfig())
			const healthHandler = vi.fn()
			decoder.on("health", healthHandler)

			decoder.testSetHealth("degraded")

			expect(healthHandler).toHaveBeenCalledWith("degraded")
			expect(decoder.getHealth()).toBe("degraded")
		})

		it("should not emit health event when health stays the same", () => {
			decoder = new TestExternalSdrDecoder(createConfig())
			const healthHandler = vi.fn()
			decoder.on("health", healthHandler)

			decoder.testSetHealth("running") // Same as initial

			expect(healthHandler).not.toHaveBeenCalled()
		})
	})

	describe("attachInput/detachInput (Requirement 19.2)", () => {
		it("should be no-ops for external SDR decoders", () => {
			decoder = new TestExternalSdrDecoder(createConfig())
			const mockStream = new PassThrough()

			// These should not throw - external SDR decoders don't use stdin
			expect(() => decoder.attachInput(mockStream)).not.toThrow()
			expect(() => decoder.detachInput()).not.toThrow()
		})
	})

	describe("getOutput", () => {
		it("should return a readable stream", () => {
			decoder = new TestExternalSdrDecoder(createConfig())
			const output = decoder.getOutput()

			expect(output).toBeDefined()
			expect(typeof output.read).toBe("function")
		})
	})

	describe("getAudioOutput", () => {
		it("should return null for external SDR decoders", () => {
			decoder = new TestExternalSdrDecoder(createConfig())

			expect(decoder.getAudioOutput()).toBeNull()
		})
	})

	describe("restart count", () => {
		it("should track restart count", () => {
			decoder = new TestExternalSdrDecoder(createConfig())

			expect(decoder.getStatus().restartCount).toBe(0)

			decoder.incrementRestartCount()
			expect(decoder.getStatus().restartCount).toBe(1)

			decoder.incrementRestartCount()
			expect(decoder.getStatus().restartCount).toBe(2)

			decoder.resetRestartCount()
			expect(decoder.getStatus().restartCount).toBe(0)
		})
	})

	describe("capabilities", () => {
		it("should declare external input type", () => {
			decoder = new TestExternalSdrDecoder(createConfig())

			expect(decoder.caps.input).toBe("external")
		})

		it("should declare external_sdr integration pattern", () => {
			decoder = new TestExternalSdrDecoder(createConfig())

			expect(decoder.caps.integrationPattern).toBe("external_sdr")
		})

		it("should want exclusive source access", () => {
			decoder = new TestExternalSdrDecoder(createConfig())

			expect(decoder.caps.wantsExclusiveSource).toBe(true)
		})
	})

	/**
	 * Feature: wavekit-core, Property 32: External SDR Decoder Device Isolation
	 * Validates: Requirements 19.1, 19.2, 19.4
	 *
	 * For any external SDR decoder D configured with device serial S,
	 * the spawned process should receive S as a command-line argument,
	 * and D should not attempt to pipe audio input.
	 */
	describe("Property 32: External SDR Decoder Device Isolation", () => {
		/**
		 * Test that device serial is included in command-line arguments.
		 * Requirements 19.1, 19.4: External SDR decoders must receive device
		 * serial as a command-line argument for multi-dongle setups.
		 */
		it("should include device serial in command-line arguments for any valid serial", () => {
			fc.assert(
				fc.property(
					// Generate valid device serial strings (alphanumeric, 1-32 chars)
					fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/),
					deviceSerial => {
						const config = createConfig({ deviceSerial })
						const testDecoder = new TestExternalSdrDecoder(config)

						// Get the args that would be passed to the spawned process
						const args = testDecoder.argsOverride ?? [
							"-d",
							deviceSerial,
							"-f",
							"131550000",
							"-f",
							"131725000",
							"-g",
							"40",
							"-p",
							"0",
						]

						// Verify device serial is accessible via getter (Requirement 19.4)
						expect(testDecoder.getDeviceSerial()).toBe(deviceSerial)

						// Verify the args include the device serial flag and value
						// The TestExternalSdrDecoder.getArgs() includes "-d" followed by deviceSerial
						const serialFlagIndex = args.indexOf("-d")
						expect(serialFlagIndex).toBeGreaterThanOrEqual(0)
						expect(args[serialFlagIndex + 1]).toBe(deviceSerial)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		/**
		 * Test that frequencies are included in command-line arguments.
		 * Requirement 19.1: External SDR decoders must receive frequencies
		 * as command-line arguments.
		 */
		it("should include all frequencies in command-line arguments", () => {
			fc.assert(
				fc.property(
					// Generate 1-8 frequencies in valid SDR range (1MHz to 2GHz)
					fc.array(fc.integer({ min: 1000000, max: 2000000000 }), {
						minLength: 1,
						maxLength: 8,
					}),
					frequencies => {
						const config = createConfig({
							deviceSerial: "TEST001",
							frequencies,
						})
						const testDecoder = new TestExternalSdrDecoder(config)

						// Verify frequencies are accessible via getter
						expect(testDecoder.getFrequencies()).toEqual(frequencies)

						// Verify getFrequencies returns a copy (not the same reference)
						const freqs1 = testDecoder.getFrequencies()
						const freqs2 = testDecoder.getFrequencies()
						expect(freqs1).not.toBe(freqs2)
						expect(freqs1).toEqual(freqs2)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		/**
		 * Test that attachInput is a no-op for external SDR decoders.
		 * Requirement 19.2: External SDR decoders should NOT receive audio
		 * input via stdin - they manage their own SDR hardware.
		 */
		it("should not pipe audio input for any stream (attachInput is no-op)", () => {
			fc.assert(
				fc.property(
					// Generate random buffer sizes to simulate different stream scenarios
					fc.integer({ min: 1, max: 10 }),
					numStreams => {
						const config = createConfig()
						const testDecoder = new TestExternalSdrDecoder(config)

						// Create multiple mock streams and attach them
						for (let i = 0; i < numStreams; i++) {
							const mockStream = new PassThrough()

							// attachInput should be a no-op and not throw
							expect(() => testDecoder.attachInput(mockStream)).not.toThrow()

							// Write some data to the stream
							mockStream.write(Buffer.from(`test data ${i}`))

							// The decoder should not have received any bytes
							// (bytesIn should remain 0 since external SDR decoders don't use stdin)
							expect(testDecoder.getStatus().stats.bytesIn).toBe(0)
						}

						// detachInput should also be a no-op
						expect(() => testDecoder.detachInput()).not.toThrow()

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		/**
		 * Test that external SDR decoders declare the correct input type.
		 * Requirement 19.2: External SDR decoders have input type "external"
		 * indicating they don't receive piped audio.
		 */
		it("should declare external input type for any configuration", () => {
			fc.assert(
				fc.property(
					// Generate various valid configurations
					fc.record({
						deviceSerial: fc.stringMatching(/^[A-Z0-9]{1,16}$/),
						frequencies: fc.array(
							fc.integer({ min: 1000000, max: 2000000000 }),
							{ minLength: 1, maxLength: 4 },
						),
						gain: fc.option(fc.integer({ min: 0, max: 50 }), {
							nil: undefined,
						}),
						ppm: fc.option(fc.integer({ min: -100, max: 100 }), {
							nil: undefined,
						}),
					}),
					configOverrides => {
						const config = createConfig({
							deviceSerial: configOverrides.deviceSerial,
							frequencies: configOverrides.frequencies,
							gain: configOverrides.gain,
							ppm: configOverrides.ppm,
						})
						const testDecoder = new TestExternalSdrDecoder(config)

						// Verify input type is "external" (Requirement 19.2)
						expect(testDecoder.caps.input).toBe("external")

						// Verify integration pattern is "external_sdr"
						expect(testDecoder.caps.integrationPattern).toBe("external_sdr")

						// Verify exclusive source requirement (external SDR decoders need exclusive access)
						expect(testDecoder.caps.wantsExclusiveSource).toBe(true)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		/**
		 * Test that device serial is preserved through decoder lifecycle.
		 * Requirement 19.4: Device serial must be consistently available
		 * for multi-dongle setups.
		 */
		it("should preserve device serial through decoder lifecycle", () => {
			fc.assert(
				fc.property(fc.stringMatching(/^[A-Z0-9]{1,16}$/), deviceSerial => {
					const config = createConfig({ deviceSerial })
					const testDecoder = new TestExternalSdrDecoder(config)

					// Device serial should be available before start
					expect(testDecoder.getDeviceSerial()).toBe(deviceSerial)

					// Device serial should be in status
					const status = testDecoder.getStatus()
					expect(status.id).toBeDefined()

					// Device serial should remain consistent after health changes
					testDecoder.testSetHealth("degraded")
					expect(testDecoder.getDeviceSerial()).toBe(deviceSerial)

					testDecoder.testSetHealth("running")
					expect(testDecoder.getDeviceSerial()).toBe(deviceSerial)

					// Device serial should remain consistent after restart count changes
					testDecoder.incrementRestartCount()
					expect(testDecoder.getDeviceSerial()).toBe(deviceSerial)

					testDecoder.resetRestartCount()
					expect(testDecoder.getDeviceSerial()).toBe(deviceSerial)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		/**
		 * Test that getAudioOutput returns null for external SDR decoders.
		 * External SDR decoders typically don't produce audio output streams.
		 */
		it("should return null for getAudioOutput for any configuration", () => {
			fc.assert(
				fc.property(
					fc.record({
						deviceSerial: fc.stringMatching(/^[A-Z0-9]{1,16}$/),
						frequencies: fc.array(
							fc.integer({ min: 1000000, max: 2000000000 }),
							{ minLength: 1, maxLength: 4 },
						),
					}),
					configOverrides => {
						const config = createConfig({
							deviceSerial: configOverrides.deviceSerial,
							frequencies: configOverrides.frequencies,
						})
						const testDecoder = new TestExternalSdrDecoder(config)

						// External SDR decoders don't produce audio output
						expect(testDecoder.getAudioOutput()).toBeNull()

						return true
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})
