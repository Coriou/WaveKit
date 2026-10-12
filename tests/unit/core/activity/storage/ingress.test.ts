import { describe, expect, it } from "vitest"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import { resolveActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import type { ActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import { TELEMETRY_OUTPUT_TYPES } from "../../../../../src/core/activity/storage/telemetry.js"
import { envelope, logger } from "./helpers.js"

function ingress(
	overrides: Partial<ActivityLimits>,
	now: () => number = () => 0,
): ActivityIngress {
	return new ActivityIngress(
		resolveActivityLimits({
			globalRatePerSec: 0,
			decoderRatePerSec: 0,
			batchWindowMs: 0,
			...overrides,
		}),
		now,
		logger,
	)
}

describe("activity admission", () => {
	it("enforces the global and per-decoder buckets without dropping the first burst", () => {
		const gate = ingress({
			globalBurst: 2,
			globalRatePerSec: 0,
			decoderBurst: 1,
			decoderRatePerSec: 0,
		})
		expect(gate.admit(envelope({ decoderId: "a" })).admitted).toBe(true)
		expect(gate.admit(envelope({ decoderId: "a" }))).toEqual({
			admitted: false,
			reason: "rate-limited",
		})
		expect(gate.admit(envelope({ decoderId: "b" })).admitted).toBe(true)
		expect(gate.admit(envelope({ decoderId: "c" }))).toEqual({
			admitted: false,
			reason: "rate-limited",
		})
		expect(gate.dropped["rate-limited"]).toBe(2)
		expect(gate.admitted).toBe(2)
	})

	it("does not burn a token when the queue is full, and the cap is inclusive", () => {
		const gate = ingress({
			globalBurst: 2,
			globalRatePerSec: 0,
			decoderBurst: 10,
			queueMaxItems: 1,
		})
		expect(gate.admit(envelope()).admitted).toBe(true)
		expect(gate.admit(envelope())).toEqual({
			admitted: false,
			reason: "queue-full",
		})
		const batch = gate.takeBatch(10, 8 * 1024 * 1024)
		gate.ack(new Set(batch.map(row => row.eventId)))
		expect(gate.admit(envelope()).admitted).toBe(true)
		const rest = gate.takeBatch(10, 8 * 1024 * 1024)
		gate.ack(new Set(rest.map(row => row.eventId)))
		expect(gate.admit(envelope())).toEqual({
			admitted: false,
			reason: "rate-limited",
		})
		expect(gate.dropped["queue-full"]).toBe(1)
		expect(gate.dropped["rate-limited"]).toBe(1)
	})

	it("excludes telemetry output types and admits unknown types", () => {
		const gate = ingress({ globalBurst: 10, decoderBurst: 10 })
		for (const outputType of TELEMETRY_OUTPUT_TYPES) {
			expect(gate.admit(envelope({ outputType }))).toEqual({
				admitted: false,
				reason: "telemetry",
			})
		}
		expect(gate.excludedTelemetry).toBe(TELEMETRY_OUTPUT_TYPES.length)
		expect(gate.dropped["rate-limited"]).toBe(0)
		expect(
			gate.admit(envelope({ outputType: "not-reviewed-yet" })).admitted,
		).toBe(true)
		expect(gate.queueDepth()).toBe(1)
	})

	it("queues one gap for the episode's first reason outside the queue cap", () => {
		const gate = ingress({
			globalBurst: 5,
			decoderBurst: 5,
			queueMaxItems: 1,
		})
		expect(gate.admit(envelope({ decoderId: "a" })).admitted).toBe(true)
		expect(gate.admit(envelope({ decoderId: "c" })).admitted).toBe(false)
		expect(gate.admit(envelope({ decoderId: "b" })).admitted).toBe(false)
		expect(gate.dropped["queue-full"]).toBe(2)
		const held = gate.takeBatch(10, 8 * 1024 * 1024)
		gate.ack(new Set(held.map(row => row.eventId)))
		expect(gate.admit(envelope({ decoderId: "d" })).admitted).toBe(true)
		const batch = gate.takeBatch(10, 8 * 1024 * 1024)
		expect(batch[0]?.kind).toBe("ingestion-gap")
		expect(batch[1]?.kind).toBe("decoder-reception")
		const payload = JSON.parse(batch[0]?.recordJson ?? "{}") as {
			payload: { reason: string; dropped: number; decoderIds: string[] }
		}
		expect(payload.payload).toMatchObject({
			reason: "queue-full",
			dropped: 2,
			decoderIds: ["b", "c"],
		})
		expect(gate.pendingCount()).toBe(0)
	})

	it("keeps at most 32 sorted decoder ids on a rate-limit gap", () => {
		let clock = 0
		const gate = ingress(
			{
				globalBurst: 1,
				globalRatePerSec: 1,
				decoderBurst: 100,
				decoderRatePerSec: 100,
				queueMaxItems: 100,
			},
			() => clock,
		)
		expect(gate.admit(envelope({ decoderId: "keep" })).admitted).toBe(true)
		for (let index = 0; index < 40; index++) {
			const decoderId = `d${String(index).padStart(2, "0")}`
			expect(gate.admit(envelope({ decoderId })).admitted).toBe(false)
		}
		clock = 1000
		expect(gate.admit(envelope({ decoderId: "after" })).admitted).toBe(true)
		const gap = gate
			.takeBatch(10, 8 * 1024 * 1024)
			.find(row => row.kind === "ingestion-gap")
		const payload = JSON.parse(gap?.recordJson ?? "{}") as {
			payload: { reason: string; dropped: number; decoderIds: string[] }
		}
		expect(payload.payload.reason).toBe("rate-limited")
		expect(payload.payload.dropped).toBe(40)
		expect(payload.payload.decoderIds).toHaveLength(32)
		expect(payload.payload.decoderIds).toEqual(
			[...payload.payload.decoderIds].sort(),
		)
	})

	it("counts a paused store and abandons queued rows as write failures", () => {
		const gate = ingress({
			globalBurst: 10,
			decoderBurst: 10,
			queueMaxItems: 10,
		})
		gate.paused = true
		expect(gate.admit(envelope())).toEqual({
			admitted: false,
			reason: "store-paused",
		})
		gate.paused = false
		expect(gate.admit(envelope()).admitted).toBe(true)
		expect(gate.admit(envelope()).admitted).toBe(true)
		gate.abandonQueued()
		expect(gate.dropped["write-failed"]).toBe(2)
		expect(gate.dropped["store-paused"]).toBe(1)
		expect(gate.queueDepth()).toBe(0)
	})

	it("refills only forward in time", () => {
		let clock = 5_000
		const gate = ingress(
			{
				globalBurst: 1,
				globalRatePerSec: 1,
				decoderBurst: 10,
				decoderRatePerSec: 10,
			},
			() => clock,
		)
		expect(gate.admit(envelope()).admitted).toBe(true)
		clock = 4_000
		expect(gate.admit(envelope()).admitted).toBe(false)
		clock = 6_000
		expect(gate.admit(envelope()).admitted).toBe(true)
	})
})
