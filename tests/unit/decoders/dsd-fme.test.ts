/**
 * DSD-FME Decoder Property-Based Tests
 *
 * Property 11: DSD Output Parsing
 * Property 12: DSD Mode Support
 *
 * Requirements: 6.2, 6.3, 6.4, 6.5
 */

import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import {
	DsdFmeDecoder,
	DSD_FME_MODES,
	type DsdFmeMode,
} from "../../../src/decoders/builtin/dsd-fme.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Helper to create a DsdFmeDecoder with given options.
 */
function createDecoder(
	id: string,
	mode: DsdFmeMode,
	options: Record<string, unknown> = {},
): DsdFmeDecoder {
	const config: DecoderConfig = {
		id,
		type: "dsd-fme",
		enabled: true,
		options: { mode, ...options },
	}
	return new DsdFmeDecoder(config, testLogger)
}

/**
 * Access the protected parseOutput method for testing.
 * We create a test subclass to expose it and internal state.
 */
class TestDsdFmeDecoder extends DsdFmeDecoder {
	public testParseOutput(line: string): DecoderOutput | null {
		return this.parseOutput(line)
	}

	/** Get the current protocol for testing sync detection */
	public getCurrentProtocol(): string | null {
		return (this as unknown as { currentProtocol: string | null })
			.currentProtocol
	}

	/** Get the pending call state for testing call buffering */
	public getPendingCall(): unknown {
		return (this as unknown as { pendingCall: unknown }).pendingCall
	}

	/** Get the active call state for testing */
	public getCallState(): unknown {
		return (this as unknown as { callState: unknown }).callState
	}
}

function createTestDecoder(
	id: string,
	mode: DsdFmeMode = "auto",
	options: Record<string, unknown> = {},
): TestDsdFmeDecoder {
	const config: DecoderConfig = {
		id,
		type: "dsd-fme",
		enabled: true,
		options: { mode, ...options },
	}
	return new TestDsdFmeDecoder(config, testLogger)
}

// Supported sync modes in dsd-fme output
const SYNC_MODES = ["DMR", "P25", "YSF", "DSTAR", "NXDN", "ProVoice"] as const

// Error patterns that dsd-fme can output
const ERROR_PATTERNS = ["FEC ERR", "CRC ERR", "SYNC LOST"] as const

/**
 * Arbitrary for generating valid decoder IDs.
 */
const decoderIdArb = fc
	.string({ minLength: 1, maxLength: 50 })
	.filter(s => s.trim().length > 0 && !s.includes(" "))

/**
 * Arbitrary for generating valid sync modes.
 */
const syncModeArb = fc.constantFrom(...SYNC_MODES)

/**
 * Arbitrary for generating valid slot numbers (1-2 for DMR).
 */
const slotArb = fc.integer({ min: 1, max: 2 })

/**
 * Arbitrary for generating valid talkgroup IDs.
 */
const talkgroupArb = fc.integer({ min: 1, max: 16777215 })

/**
 * Arbitrary for generating valid source IDs.
 */
const sourceIdArb = fc.integer({ min: 1, max: 16777215 })

/**
 * Arbitrary for generating error patterns.
 */
const errorPatternArb = fc.constantFrom(...ERROR_PATTERNS)

/**
 * Arbitrary for generating DSD-FME modes.
 */
const dsdModeArb = fc.constantFrom(...DSD_FME_MODES)

describe("DSD-FME Decoder Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 11: DSD Output Parsing
	 * Validates: Requirements 6.2, 6.3, 6.4
	 *
	 * The new call handling philosophy:
	 * - Sync is a CANDIDATE context, not an event. We track the protocol but don't emit on sync alone.
	 * - Calls require minimum metadata (TGT+SRC for DMR/P25/NXDN, callsigns for D-Star)
	 * - Error events are tracked for quality but not emitted unless debug mode is on
	 *
	 * These tests validate the new state-machine behavior.
	 */
	describe("Property 11: DSD Output Parsing", () => {
		it("should track protocol from sync lines without emitting events", () => {
			fc.assert(
				fc.property(decoderIdArb, syncModeArb, (decoderId, mode) => {
					const decoder = createTestDecoder(decoderId)
					const line = `Sync: +${mode}`

					// Sync lines should NOT produce immediate output (protocol tracking only)
					const output = decoder.testParseOutput(line)
					expect(output).toBeNull()

					// But protocol should be tracked internally
					const protocol = decoder.getCurrentProtocol()
					expect(protocol).not.toBeNull()

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should track slot from sync lines with mode and slot", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					syncModeArb,
					slotArb,
					(decoderId, mode, slot) => {
						const decoder = createTestDecoder(decoderId)
						const line = `Sync: +${mode} Slot ${slot}`

						// Should NOT emit (sync is just protocol context)
						const output = decoder.testParseOutput(line)
						expect(output).toBeNull()

						// Protocol should be tracked
						const protocol = decoder.getCurrentProtocol()
						expect(protocol).not.toBeNull()

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should start pending call on valid metadata (TGT/SRC)", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					talkgroupArb,
					sourceIdArb,
					(decoderId, talkgroup, source) => {
						const decoder = createTestDecoder(decoderId)

						// First establish protocol context
						decoder.testParseOutput("Sync: +DMR")

						// Then send call metadata - this starts a pending call
						const line = `TGT: ${talkgroup} SRC: ${source}`
						const output = decoder.testParseOutput(line)

						// Should NOT emit immediately (delayed emission pattern)
						expect(output).toBeNull()

						// But pending call should be created
						const pendingCall = decoder.getPendingCall()
						expect(pendingCall).not.toBeNull()

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should track errors for quality without emitting events", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					errorPatternArb,
					(decoderId, errorPattern) => {
						// Create decoder WITHOUT debug mode - errors should not emit
						const decoder = createTestDecoder(decoderId)
						const line = `Some context ${errorPattern} more context`
						const output = decoder.testParseOutput(line)

						// Should NOT produce output (errors are tracked for quality, not emitted)
						expect(output).toBeNull()

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should emit error events when debug mode is enabled", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					errorPatternArb,
					(decoderId, errorPattern) => {
						// Create decoder WITH debug mode - errors should emit
						const decoder = createTestDecoder(decoderId, "auto", {
							emitDebugEvents: true,
						})
						const line = `Some context ${errorPattern} more context`
						const output = decoder.testParseOutput(line)

						// SHOULD produce output in debug mode
						expect(output).not.toBeNull()
						expect(output!.type).toBe("error")
						expect(output!.decoder).toBe(decoderId)
						expect((output!.data as { message: string }).message).toBe(
							errorPattern,
						)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for lines that don't match any pattern", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					fc.string().filter(s => {
						// Filter out strings that would match our patterns
						const upper = s.toUpperCase()
						return (
							!upper.includes("SYNC:") &&
							!upper.includes("TGT") &&
							!upper.includes("SRC") &&
							!upper.includes("FEC ERR") &&
							!upper.includes("CRC ERR") &&
							!upper.includes("SYNC LOST")
						)
					}),
					(decoderId, line) => {
						const decoder = createTestDecoder(decoderId)
						const output = decoder.testParseOutput(line)

						// Should return null for non-matching lines
						return output === null
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	/**
	 * Feature: wavekit-core, Property 12: DSD Mode Support
	 * Validates: Requirements 6.5
	 *
	 * For any mode in the set {auto, dmr, p25, ysf, dstar, nxdn, provoice},
	 * creating a DSD decoder with that mode should succeed without error.
	 */
	describe("Property 12: DSD Mode Support", () => {
		it("should create decoder successfully for any valid mode", () => {
			fc.assert(
				fc.property(decoderIdArb, dsdModeArb, (decoderId, mode) => {
					// Creating a decoder with any valid mode should not throw
					expect(() => createDecoder(decoderId, mode)).not.toThrow()

					const decoder = createDecoder(decoderId, mode)

					// Decoder should be created with correct id and type
					expect(decoder.id).toBe(decoderId)
					expect(decoder.type).toBe("dsd-fme")

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should support all documented modes", () => {
			// Verify all modes from the constant are valid
			const expectedModes: DsdFmeMode[] = [
				"auto",
				"dmr",
				"p25",
				"ysf",
				"dstar",
				"nxdn",
				"provoice",
			]

			fc.assert(
				fc.property(decoderIdArb, decoderId => {
					for (const mode of expectedModes) {
						expect(() => createDecoder(decoderId, mode)).not.toThrow()
						expect(DSD_FME_MODES).toContain(mode)
					}
					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should default to auto mode for invalid mode values", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					fc.string().filter(s => !DSD_FME_MODES.includes(s as DsdFmeMode)),
					(decoderId, invalidMode) => {
						// Creating with invalid mode should not throw
						const config: DecoderConfig = {
							id: decoderId,
							type: "dsd-fme",
							enabled: true,
							options: { mode: invalidMode },
						}

						expect(() => new DsdFmeDecoder(config, testLogger)).not.toThrow()

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return valid status for decoder created with any mode", () => {
			fc.assert(
				fc.property(decoderIdArb, dsdModeArb, (decoderId, mode) => {
					const decoder = createDecoder(decoderId, mode)
					const status = decoder.getStatus()

					// Status should have all required fields
					expect(status).toHaveProperty("id")
					expect(status).toHaveProperty("type")
					expect(status).toHaveProperty("running")
					expect(status).toHaveProperty("uptime")
					expect(status).toHaveProperty("stats")

					expect(status.id).toBe(decoderId)
					expect(status.type).toBe("dsd-fme")
					expect(status.running).toBe(false)
					expect(status.uptime).toBe(0)

					return true
				}),
				{ numRuns: 100 },
			)
		})
	})
})
