import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { createActivityIngress } from "../../../../../src/core/activity/ingress.js"
import {
	AIS_CHANNEL_A_HZ,
	AIS_CHANNEL_B_HZ,
	MAX_PROVENANCE_HZ,
} from "../../../../../src/core/activity/provenance/resolve.js"
import type {
	ActivityDecoderBinding,
	DecodeEnvelope,
} from "../../../../../src/core/activity/types.js"
import type {
	DecoderOutput,
	DecoderOutputType,
} from "../../../../../src/decoders/types.js"

const types: DecoderOutputType[] = [
	"acars",
	"vdl2",
	"meshtastic",
	"ship",
	"aircraft",
	"message",
	"aprs",
]
const hostileNumber = fc.oneof(
	fc.double(),
	fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, -1, 1e13, 0.4, 0.5),
	fc.integer({ min: 1, max: 2_000_000_000 }),
	fc.string(),
	fc.constant(null),
)
const sourceId = fc.oneof(
	fc.constant(null),
	fc.string({ maxLength: 8 }),
	fc.string({ minLength: 129, maxLength: 200 }),
	fc.constant("bad\u0000id"),
	fc.constant(""),
)
const binding = fc.oneof(
	fc.constant(null),
	fc.constant("throw" as const),
	fc.record({
		sourceId,
		targetFrequenciesHz: fc.array(hostileNumber, { maxLength: 3 }),
		tuningTrust: fc.constantFrom("commanded", "relay", "unverified", "x"),
	}),
)

function expectedHz(type: string, data: unknown, b: unknown): number | null {
	const valid = (v: unknown) => {
		if (typeof v !== "number") return null
		const hz = Math.round(v)
		return hz > 0 && hz <= MAX_PROVENANCE_HZ ? hz : null
	}
	const d = data as Record<string, unknown>
	let hz: number | null = null
	if (type === "acars" || type === "vdl2" || type === "meshtastic")
		hz = valid(d["frequency"])
	else if (type === "ship")
		hz = ["A", "a", "1", "87B", 1].includes(d["channel"] as string)
			? AIS_CHANNEL_A_HZ
			: ["B", "b", "2", "88B", 2].includes(d["channel"] as string)
				? AIS_CHANNEL_B_HZ
				: null
	if (hz === null && b !== null && typeof b === "object") {
		const t = (b as ActivityDecoderBinding).targetFrequenciesHz
		if (t.length === 1) hz = valid(t[0])
	}
	return hz
}

describe("provenance property", () => {
	it("yields exactly one table-conformant envelope", () => {
		// Feature: web-gaps-3, Property 8: Provenance resolution
		// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.7
		fc.assert(
			fc.property(
				fc.constantFrom(...types),
				fc.record({
					frequency: hostileNumber,
					channel: fc.oneof(
						hostileNumber,
						fc.constantFrom("A", "B", "1", "2", "87B", "88B", "c"),
					),
				}),
				binding,
				(type, data, b) => {
					const envelopes: DecodeEnvelope[] = []
					const ingress = createActivityIngress({
						sink: (_e, present) => envelopes.push(present()),
						logger: pino({ level: "silent" }),
						resolveProvenance: () => {
							if (b === "throw") throw new Error("lookup")
							return b as ActivityDecoderBinding | null
						},
					})
					const output: DecoderOutput = {
						timestamp: new Date(0),
						decoder: "d",
						type,
						data,
					}
					// Outputs that cannot be built even without provenance (e.g. a
					// NaN in decodedData) are build failures today; provenance must
					// never add a loss on top of that.
					const baseline: DecodeEnvelope[] = []
					createActivityIngress({
						sink: e => baseline.push(e),
						logger: pino({ level: "silent" }),
					}).publish("d", undefined, output)
					ingress.publish("d", undefined, output)
					expect(envelopes).toHaveLength(baseline.length)
					if (baseline.length === 0) {
						expect(ingress.counters().buildFailures).toBe(1)
						return
					}
					const p = envelopes[0]!.provenance
					expect(ingress.counters().buildFailures).toBe(0)
					if (b === "throw") {
						expect(p).toEqual({ sourceId: null, frequency: null })
						expect(ingress.counters().provenanceFailures).toBe(1)
						return
					}
					const sid = b?.sourceId
					const hz = expectedHz(type, data, b)
					const failures = ingress.counters().provenanceFailures ?? 0
					if (failures === 1) {
						// Rejected because of provenance: rebuilt with null, counted.
						expect(p).toEqual({ sourceId: null, frequency: null })
						// A plain short id is never the cause.
						expect(
							typeof sid === "string" && /^[a-z0-9-]{1,8}$/.test(sid),
						).toBe(false)
						return
					}
					expect(failures).toBe(0)
					if (p.frequency !== null) {
						expect(Number.isInteger(p.frequency.hz)).toBe(true)
						expect(p.frequency.hz).toBeGreaterThan(0)
						expect(p.frequency.hz).toBeLessThanOrEqual(MAX_PROVENANCE_HZ)
						expect(p.frequency.basis).toBe("channel")
						const trust = b?.tuningTrust
						expect(p.frequency.tuningTrust).toBe(
							trust === "commanded" || trust === "relay" ? trust : "unverified",
						)
					}
					expect(p.frequency?.hz ?? null).toBe(hz)
					expect(p.sourceId).toBe(typeof sid === "string" ? sid : null)
				},
			),
			{ numRuns: 300 },
		)
	})
})
