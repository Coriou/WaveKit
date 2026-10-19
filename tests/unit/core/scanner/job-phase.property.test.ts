// Feature: scanner-redesign, Property 15: Phase follows the precedence
// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 1.3
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ScanJobPhase, ScannerProtocol } from "@wavekit/api-types"
import {
	jobPhase,
	jobProgressFields,
} from "../../../../src/core/scanner/job-phase.js"
import type { JobPhaseInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"

const PROTOCOLS = [
	"dmr",
	"pocsag",
	"aprs",
	"analog-fm",
	"nxdn48",
] as const satisfies readonly ScannerProtocol[]

/** Independent of jobPhase: settling, then a hold, then a parked live probe, then replay, then capture. */
function expectedPhase(input: JobPhaseInput): ScanJobPhase {
	if (input.schedulerPhase === "tuning" || input.schedulerPhase === "settling")
		return "settling"
	if (input.hold !== null) return "holding"
	if (input.liveProbe !== null && input.parked) return "trialing"
	if (input.activity.replaying !== null) return "replaying"
	if (input.activity.capturing > 0) return "capturing"
	return "watching"
}

function expectedHolding(input: JobPhaseInput): JobPhaseInput["hold"] {
	const phase = expectedPhase(input)
	if (phase === "holding") return input.hold
	if (phase === "trialing" && input.liveProbe !== null) {
		return {
			discoveryId: input.liveProbe.discoveryId,
			frequencyHz: input.liveProbe.frequencyHz,
			trackId: input.liveProbe.trackId,
		}
	}
	return null
}

function expectedTrial(input: JobPhaseInput): {
	protocol: ScannerProtocol
	decoder: string
	transport: "offset" | "channel" | "replay"
	discoveryId: string | null
} | null {
	if (input.liveProbe !== null) {
		return {
			protocol: input.liveProbe.protocol,
			decoder: input.liveProbe.decoder,
			transport: input.liveProbe.transport,
			discoveryId: input.liveProbe.discoveryId,
		}
	}
	if (input.activity.replaying !== null) {
		return {
			protocol: input.activity.replaying.protocol,
			decoder: input.activity.replaying.decoder,
			transport: "replay",
			discoveryId: input.activity.replaying.discoveryId,
		}
	}
	return null
}

const protocolArb = fc.constantFrom(...PROTOCOLS)
const idArb = fc.string({ minLength: 1, maxLength: 8 })
const liveArb = fc.oneof(
	fc.constant(null),
	fc.record({
		protocol: protocolArb,
		decoder: fc.string({ minLength: 1, maxLength: 12 }),
		transport: fc.constantFrom("offset" as const, "channel" as const),
		discoveryId: fc.oneof(fc.constant(null), idArb),
		frequencyHz: fc.integer({ min: 0, max: 1_000_000_000 }),
		trackId: idArb,
	}),
)
const holdArb = fc.oneof(
	fc.constant(null),
	fc.record({
		discoveryId: fc.oneof(fc.constant(null), idArb),
		frequencyHz: fc.integer({ min: 0, max: 1_000_000_000 }),
		trackId: idArb,
	}),
)
const replayArb = fc.oneof(
	fc.constant(null),
	fc.record({
		protocol: protocolArb,
		decoder: fc.string({ minLength: 1, maxLength: 12 }),
		discoveryId: fc.oneof(fc.constant(null), idArb),
	}),
)

describe("job phase property", () => {
	it("follows settling > holding > trialing > replaying > capturing > watching", () => {
		// Feature: scanner-redesign, Property 15: Phase follows the precedence
		// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 1.3
		fc.assert(
			fc.property(
				fc.record({
					schedulerPhase: fc.constantFrom(
						"tuning" as const,
						"settling" as const,
						"hold" as const,
						"dwell" as const,
						null,
					),
					parked: fc.boolean(),
					liveProbe: liveArb,
					hold: holdArb,
					activity: fc.record({
						capturing: fc.integer({ min: 0, max: 4 }),
						replaying: replayArb,
						replayQueueDepth: fc.integer({ min: 0, max: 6 }),
					}),
				}),
				fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 60_000 })),
				(row, period) => {
					const phase = expectedPhase(row)
					expect(jobPhase(row)).toBe(phase)
					const fields = jobProgressFields(row, period)
					expect(fields.phase).toBe(phase)
					expect(fields.parked).toBe(row.parked)
					expect(fields.replayQueueDepth).toBe(row.activity.replayQueueDepth)
					const holding = expectedHolding(row)
					if (holding) expect(fields.holding).toEqual(holding)
					else expect(fields.holding).toBeUndefined()
					expect(phase === "holding" || phase === "trialing").toBe(
						holding !== null,
					)
					const trial = expectedTrial(row)
					if (trial) expect(fields.trial).toEqual(trial)
					else expect(fields.trial).toBeUndefined()
					if (row.parked) expect(fields.sweepPeriodMs).toBeNull()
					else expect(fields.sweepPeriodMs).toBe(period)
				},
			),
			{ numRuns: 100 },
		)
	})
})
