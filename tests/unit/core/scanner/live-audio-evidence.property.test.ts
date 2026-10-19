// Feature: scanner-redesign, Property 16: Live-audio evidence attaches only where it belongs
// Validates: Requirements 6.3, 6.5
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CTCSS_HZ } from "../../../../src/core/audio-tones/ctcss.js"
import { DCS_STANDARD_CODES } from "@wavekit/api-types"
import { DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ } from "@wavekit/api-types"
import { createLiveAudioEvidence } from "../../../../src/core/scanner/live-audio-evidence.js"
import type { AnalogEvidenceTransmission } from "../../../../src/core/scanner/identify-analog-contract.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	Discovery,
	Observation,
} from "../../../../src/core/scanner/types.js"
import type { TuningTrust } from "../../../../src/core/spectrum/types.js"
import type { Logger } from "../../../../src/utils/logger.js"

const CTCSS = new Set<number>(CTCSS_HZ)
const DCS = new Set<string>(DCS_STANDARD_CODES)
const HZ = 446_006_250
const T0 = Date.parse("2026-10-17T12:00:00.000Z")

const TRUSTS = ["commanded", "relay", "unverified"] as const

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

interface Row {
	trust: (typeof TRUSTS)[number] | "unknown" | "throw"
	eventTrust: (typeof TRUSTS)[number]
	offsetHz: number
	hasDiscovery: boolean
	overlaps: boolean
	ctcssHz: number | null
	dcsCode: string | null
	polarity: "normal" | "inverted"
	modulation: AnalogEvidenceTransmission["modulation"]
	open: boolean
}

function expected(row: Row): ProofAnalogInput | null {
	if (row.open) return null
	if (row.trust !== "commanded" && row.trust !== "relay") return null
	if (row.eventTrust !== "commanded" && row.eventTrust !== "relay") return null
	if (!row.hasDiscovery) return null
	if (Math.abs(row.offsetHz) > DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ) return null
	if (!row.overlaps) return null
	const ctcssHz =
		row.ctcssHz !== null && CTCSS.has(row.ctcssHz) ? row.ctcssHz : null
	const dcs =
		row.dcsCode !== null && DCS.has(row.dcsCode)
			? { code: row.dcsCode, polarity: row.polarity }
			: null
	return {
		outcome: ctcssHz !== null || dcs !== null ? "decoded" : "heard",
		mode: row.modulation === "am" || row.modulation === "dsb" ? "am" : "nfm",
		voice: true,
		tone: { ctcssHz, dcs },
		transport: "live",
		at: T0 + 2_000,
	}
}

const rowArb: fc.Arbitrary<Row> = fc.record({
	trust: fc.constantFrom(...TRUSTS, "unknown" as const, "throw" as const),
	eventTrust: fc.constantFrom(...TRUSTS),
	offsetHz: fc.integer({ min: -20_000, max: 20_000 }),
	hasDiscovery: fc.boolean(),
	overlaps: fc.boolean(),
	ctcssHz: fc.oneof(
		fc.constant(null),
		fc.constantFrom(...CTCSS_HZ),
		fc.constant(12),
	),
	dcsCode: fc.oneof(
		fc.constant(null),
		fc.constantFrom(...DCS_STANDARD_CODES.slice(0, 8)),
		fc.constant("999"),
	),
	polarity: fc.constantFrom("normal" as const, "inverted" as const),
	modulation: fc.constantFrom(
		"nfm" as const,
		"wfm" as const,
		"am" as const,
		"dsb" as const,
		"usb" as const,
	),
	open: fc.boolean(),
})

describe("live-audio evidence property", () => {
	it("attaches only on commanded or relay, within tolerance, to an overlapping observation", () => {
		// Feature: scanner-redesign, Property 16: Live-audio evidence attaches only where it belongs
		// Validates: Requirements 6.3, 6.5
		fc.assert(
			fc.property(rowArb, row => {
				const recorded: ProofAnalogInput[] = []
				let created = 0
				const calls: string[] = []
				const discovery = {
					id: "d_1",
					frequencyHz: HZ + row.offsetHz,
					sourceIds: ["rtl"],
				} as unknown as Discovery
				const observation = {
					id: "o_1",
					discoveryId: "d_1",
					sourceId: "rtl",
					startedAt: iso(row.overlaps ? T0 - 50 : T0 + 9_000),
					endedAt: iso(row.overlaps ? T0 + 2_500 : T0 + 10_000),
				} as unknown as Observation
				const listeners = new Set<(t: AnalogEvidenceTransmission) => void>()
				const store = {
					near: (hz: number, toleranceHz: number, sourceId?: string) => {
						calls.push("near")
						expect(hz).toBe(HZ)
						expect(toleranceHz).toBe(DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ)
						expect(sourceId).toBe("rtl")
						if (!row.hasDiscovery) return []
						if (sourceId !== "rtl") return []
						if (Math.abs(discovery.frequencyHz - hz) > toleranceHz) return []
						return [discovery]
					},
					observations: () => {
						calls.push("observations")
						return { items: [observation], nextCursor: null }
					},
					recordAnalog: (_id: string, analog: ProofAnalogInput) => {
						calls.push("recordAnalog")
						recorded.push(analog)
						return true
					},
					create: () => {
						created += 1
					},
				}
				const evidence = createLiveAudioEvidence({
					store,
					analogLog: {
						subscribe: (
							listener: (transmission: AnalogEvidenceTransmission) => void,
						) => {
							listeners.add(listener)
							return () => {
								listeners.delete(listener)
							}
						},
					} as unknown as Parameters<
						typeof createLiveAudioEvidence
					>[0]["analogLog"],
					trust: () => {
						if (row.trust === "throw") throw new Error("trust down")
						return row.trust as TuningTrust
					},
					logger: { child: () => ({ warn() {} }) } as unknown as Logger,
				})
				evidence.start()
				const tx: AnalogEvidenceTransmission = {
					transmissionId: "tx",
					sourceId: "rtl",
					startedAtMs: T0,
					endedAtMs: row.open ? null : T0 + 2_000,
					hz: HZ,
					tuningTrust: row.eventTrust,
					modulation: row.modulation,
					ctcssHz: row.ctcssHz,
					dcs:
						row.dcsCode === null
							? null
							: { code: row.dcsCode, polarity: row.polarity },
				}
				for (const listener of listeners) listener(tx)
				const want = expected(row)
				expect(created).toBe(0)
				if (want === null) {
					expect(recorded).toEqual([])
					expect(calls.includes("recordAnalog")).toBe(false)
				} else {
					expect(recorded).toEqual([want])
					expect(calls).toEqual(["near", "observations", "recordAnalog"])
				}
				if (row.trust !== "commanded" && row.trust !== "relay")
					expect(calls).toEqual([])
				expect(calls.length).toBeLessThanOrEqual(3)
			}),
			{ numRuns: 100 },
		)
	})
})
