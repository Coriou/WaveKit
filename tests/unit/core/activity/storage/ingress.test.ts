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
			gapQuietMs: 0,
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
				gapQuietMs: 1_000,
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

	it("refunds a token when the built row exceeds the byte cap", () => {
		const gate = ingress({
			globalBurst: 2,
			globalRatePerSec: 0,
			decoderBurst: 10,
			queueMaxItems: 10,
			queueMaxBytes: 1,
		})
		expect(gate.admit(envelope())).toEqual({
			admitted: false,
			reason: "queue-full",
		})
		expect(gate.admit(envelope())).toEqual({
			admitted: false,
			reason: "queue-full",
		})
		expect(gate.dropped["queue-full"]).toBe(2)
		expect(gate.dropped["rate-limited"]).toBe(0)
	})

	it("counts admits rejected because the writer is closed", () => {
		const gate = ingress({ globalBurst: 10, decoderBurst: 10 })
		gate.markClosed()
		expect(gate.admit(envelope())).toEqual({
			admitted: false,
			reason: "closed",
		})
		expect(gate.admit(envelope())).toEqual({
			admitted: false,
			reason: "closed",
		})
		expect(gate.dropped.closed).toBe(2)
		expect(gate.dropped["rate-limited"]).toBe(0)
		expect(gate.admitted).toBe(0)
	})

	it("emits at most one gap per minute under a sustained offered load", () => {
		let clock = 0
		const warnings: string[] = []
		const gate = new ActivityIngress(
			resolveActivityLimits({
				globalRatePerSec: 1_000,
				globalBurst: 1_000,
				decoderRatePerSec: 50,
				decoderBurst: 200,
				queueMaxItems: 1024,
				batchWindowMs: 0,
			}),
			() => clock,
			{
				warn(_object: unknown, message?: string) {
					warnings.push(message ?? "")
				},
			} as unknown as typeof logger,
		)
		const durationMs = 180_000
		let gaps = 0
		let real = 0
		for (let step = 0; step < durationMs; step++) {
			clock += 1
			const result = gate.admit(
				envelope({ decoderId: "adsb", eventId: `e${step}` }),
			)
			if (!result.admitted && gate.pendingCount() === 0) continue
			const batch = gate.takeBatch(64, 8 * 1024 * 1024)
			for (const row of batch) {
				if (row.kind === "ingestion-gap") gaps += 1
				else real += 1
			}
			gate.ack(new Set(batch.map(row => row.eventId)))
		}
		expect(gaps).toBeGreaterThan(0)
		expect(gaps).toBeLessThanOrEqual(durationMs / 60_000)
		expect(real).toBeGreaterThanOrEqual(9_000)
		expect(real).toBeLessThanOrEqual(9_400)
		expect(warnings).toHaveLength(gaps)
	})

	it("stages a quiet episode from the clock without another admit", () => {
		let clock = 0
		const gate = ingress(
			{
				globalBurst: 1,
				globalRatePerSec: 0,
				decoderBurst: 10,
				gapQuietMs: 1_000,
			},
			() => clock,
		)
		expect(gate.admit(envelope({ decoderId: "a" })).admitted).toBe(true)
		expect(gate.admit(envelope({ decoderId: "a" })).admitted).toBe(false)
		expect(gate.hasOpenEpisode()).toBe(true)
		expect(gate.stageDueEpisode(999)).toBe(false)
		expect(gate.hasOpenEpisode()).toBe(true)
		expect(gate.stageDueEpisode(1_000)).toBe(true)
		expect(gate.hasOpenEpisode()).toBe(false)
		const gap = gate
			.takeBatch(10, 8 * 1024 * 1024)
			.find(row => row.kind === "ingestion-gap")
		const payload = JSON.parse(gap?.recordJson ?? "{}") as {
			payload: { reason: string; dropped: number }
		}
		expect(payload.payload).toMatchObject({
			reason: "rate-limited",
			dropped: 1,
		})
	})

	it("stages an open episode immediately when shutdown asks", () => {
		const gate = ingress({
			globalBurst: 1,
			globalRatePerSec: 0,
			decoderBurst: 10,
			gapQuietMs: 60_000,
		})
		expect(gate.admit(envelope({ decoderId: "radio" })).admitted).toBe(true)
		expect(gate.admit(envelope({ decoderId: "radio" })).admitted).toBe(false)
		expect(gate.stageDueEpisode(0)).toBe(false)
		expect(gate.stageOpenEpisode(0)).toBe(true)
		expect(gate.stageOpenEpisode(0)).toBe(false)
		const gap = gate.takeBatch(10, 8 * 1024 * 1024)[0]
		expect(gap?.kind).toBe("ingestion-gap")
		const payload = JSON.parse(gap?.recordJson ?? "{}") as {
			payload: { reason: string; dropped: number; decoderIds: string[] }
		}
		expect(payload.payload).toMatchObject({
			reason: "rate-limited",
			dropped: 1,
			decoderIds: ["radio"],
		})
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

describe("meshtastic flood copies", () => {
	const BIG = 64 * 1024 * 1024

	function mesh(
		offsetMs: number,
		patch: Record<string, unknown> = {},
	): ReturnType<typeof envelope> {
		return envelope({
			outputType: "meshtastic",
			category: "mesh",
			protocol: "meshtastic",
			entityKey: null,
			receivedAt: new Date(
				Date.parse("2026-10-12T00:00:00.000Z") + offsetMs,
			).toISOString(),
			decodedData: {
				from: 0x1234abcd,
				id: 42,
				portnum: 1,
				payloadB64: "aGk=",
				...patch,
			} as Record<string, number | string>,
		})
	}

	const roomy = { globalBurst: 100, decoderBurst: 100 }

	it("rejects a copy, takes no token and opens no gap", () => {
		const gate = ingress({ globalBurst: 1, decoderBurst: 1 })
		expect(gate.admit(mesh(0))).toEqual({ admitted: true })
		expect(gate.admit(mesh(2000))).toEqual({
			admitted: false,
			reason: "flood-copy",
		})
		expect(gate.floodCopies).toBe(1)
		expect(gate.dropped["rate-limited"]).toBe(0)
		expect(gate.hasOpenEpisode()).toBe(false)
		expect(gate.pendingCount()).toBe(1)
	})

	it("stores a copy at 30 001 ms; 30 000 ms is still a copy", () => {
		const gate = ingress(roomy)
		gate.admit(mesh(0))
		expect(gate.admit(mesh(30_000)).admitted).toBe(false)
		expect(gate.admit(mesh(30_001))).toEqual({ admitted: true })
	})

	it("stores a copy with a different payload or portnum", () => {
		const gate = ingress(roomy)
		gate.admit(mesh(0))
		expect(gate.admit(mesh(1, { payloadB64: "eW8=" })).admitted).toBe(true)
		expect(gate.admit(mesh(2, { portnum: 67 })).admitted).toBe(true)
		expect(gate.floodCopies).toBe(0)
	})

	it("stores the copy when the original was rate-limited", () => {
		let now = 0
		const gate = ingress(
			{
				globalBurst: 1,
				decoderBurst: 1,
				decoderRatePerSec: 1,
				globalRatePerSec: 1,
			},
			() => now,
		)
		gate.admit(envelope())
		expect(gate.admit(mesh(0))).toEqual({
			admitted: false,
			reason: "rate-limited",
		})
		now = 1000
		expect(gate.admit(mesh(1000))).toEqual({ admitted: true })
	})

	it("stores the next copy after a failed or skipped write, keeps it on ack and timeout", () => {
		const gate = ingress(roomy)
		gate.admit(mesh(0))
		gate.takeBatch(10, BIG)
		gate.nack()
		expect(gate.admit(mesh(1)).admitted).toBe(true)
		const batch = gate.takeBatch(10, BIG)
		gate.noteSkipped(
			batch,
			batch.map(row => row.eventId),
		)
		gate.ack(new Set())
		expect(gate.admit(mesh(2)).admitted).toBe(true)
		gate.takeBatch(10, BIG)
		gate.ack(new Set(["x"]))
		expect(gate.admit(mesh(3))).toEqual({
			admitted: false,
			reason: "flood-copy",
		})
		gate.admit(mesh(4, { id: 43 }))
		gate.takeBatch(10, BIG)
		gate.forgetInFlight()
		expect(gate.admit(mesh(5, { id: 43 }))).toEqual({
			admitted: false,
			reason: "flood-copy",
		})
		expect(gate.floodCopies).toBe(2)
	})

	it("a copy dropped while the original is queued is not re-admitted if that write fails", () => {
		const gate = ingress(roomy)
		gate.admit(mesh(0))
		expect(gate.admit(mesh(1))).toEqual({
			admitted: false,
			reason: "flood-copy",
		})
		gate.takeBatch(10, BIG)
		gate.nack()
		expect(gate.floodCopies).toBe(1)
		expect(gate.dropped["write-failed"]).toBe(1)
	})

	it("never dedupes id 0, malformed fields or a backward clock step", () => {
		const gate = ingress(roomy)
		gate.admit(mesh(0, { id: 0 }))
		expect(gate.admit(mesh(1, { id: 0 })).admitted).toBe(true)
		gate.admit(mesh(0, { from: -1 }))
		expect(gate.admit(mesh(1, { from: -1 })).admitted).toBe(true)
		gate.admit(mesh(0, { id: "42" }))
		expect(gate.admit(mesh(1, { id: "42" })).admitted).toBe(true)
		gate.admit(mesh(10_000, { id: 9 }))
		expect(gate.admit(mesh(9_999, { id: 9 })).admitted).toBe(true)
		expect(gate.floodCopies).toBe(0)
	})

	it("leaves non-mesh outputs with mesh-shaped data unaffected", () => {
		const gate = ingress(roomy)
		const data = { from: 1, id: 2, portnum: 1, payloadB64: "QQ==" }
		expect(
			gate.admit(envelope({ outputType: "pocsag", decodedData: data }))
				.admitted,
		).toBe(true)
		expect(
			gate.admit(envelope({ outputType: "pocsag", decodedData: data }))
				.admitted,
		).toBe(true)
		expect(gate.floodCopies).toBe(0)
	})
})
