import { describe, expect, it } from "vitest"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import { resolveActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import { envelope, logger } from "./helpers.js"

const T0 = Date.parse("2026-10-13T00:00:00.000Z")

function ingress() {
	return new ActivityIngress(
		resolveActivityLimits({
			globalRatePerSec: 1_000_000,
			globalBurst: 1_000_000,
			decoderBurst: 1_000_000,
			decoderRatePerSec: 100_000,
		}),
		() => T0,
		logger,
	)
}

function report(eventId: string, ms: number, extra: Record<string, string>) {
	return envelope({
		eventId,
		decoderId: "readsb",
		outputType: "aircraft",
		receivedAt: new Date(T0 + ms).toISOString(),
		decodedData: { icao: "abc123", lat: 51, lon: 4, ...extra },
	})
}

// WG1 req 7.9: rows of one entity in one failed batch roll back independently.
describe("coalescing rollback across rows of one entity", () => {
	it("forgets both rows of a fully failed batch (nack), whatever the order", () => {
		const i = ingress()
		expect(i.admit(report("a1", 0, { callsign: "UAL1" })).admitted).toBe(true)
		expect(i.admit(report("a2", 1_000, { squawk: "7000" })).admitted).toBe(true)
		expect(i.takeBatch(64, 1 << 20).map(r => r.eventId)).toEqual(["a1", "a2"])
		i.nack()
		// Nothing was stored: the callsign, the squawk and the window are unknown.
		expect(i.admit(report("r1", 2_000, { callsign: "UAL1" })).admitted).toBe(
			true,
		)
		expect(i.admit(report("r2", 3_000, { squawk: "7000" })).admitted).toBe(true)
	})

	it("forgets only the skipped row's identity when a later row of the batch is written", () => {
		const i = ingress()
		expect(i.admit(report("a1", 0, { callsign: "UAL1" })).admitted).toBe(true)
		expect(i.admit(report("a2", 1_000, { squawk: "7000" })).admitted).toBe(true)
		const batch = i.takeBatch(64, 1 << 20)
		i.noteSkipped(batch, ["a1"])
		i.ack(new Set(["a2"]))
		// a2 was stored: its squawk and window hold; a1's callsign never was.
		expect(i.admit(report("p", 2_000, { squawk: "7000" }))).toEqual({
			admitted: false,
			reason: "coalesced",
		})
		expect(i.admit(report("r1", 3_000, { callsign: "UAL1" })).admitted).toBe(
			true,
		)
	})

	it("keeps the window of an earlier written row when a later one fails", () => {
		const i = ingress()
		expect(i.admit(report("a1", 0, {})).admitted).toBe(true)
		i.ack(new Set(i.takeBatch(64, 1 << 20).map(r => r.eventId)))
		expect(i.admit(report("a2", 1_000, { callsign: "UAL1" })).admitted).toBe(
			true,
		)
		const batch = i.takeBatch(64, 1 << 20)
		i.noteSkipped(batch, ["a2"])
		i.ack(new Set())
		expect(i.admit(report("p", 2_000, {}))).toEqual({
			admitted: false,
			reason: "coalesced",
		})
		expect(i.admit(report("r2", 3_000, { callsign: "UAL1" })).admitted).toBe(
			true,
		)
	})
})
