import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import { resolveActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import type { AnalogTransmissionPayload } from "../../../../../src/core/activity/storage/contract.js"
import { parseStoredRecord } from "../../../../../src/core/activity/storage/row.js"
import { createActivityQueryService } from "../../../../../src/core/activity/query/service.js"
import {
	envelope,
	logger,
	openStore,
	readRecords,
	roots,
	stores,
} from "./helpers.js"

function payload(
	sourceId: string,
	transmissionId: string,
): AnalogTransmissionPayload {
	return {
		transmissionId,
		sourceId,
		startedAt: "2026-10-13T00:00:00.000Z",
		endedAt: "2026-10-13T00:00:01.000Z",
		durationMs: 1_000,
		frequency: { hz: 145_500_000, tuningTrust: "relay" },
		modulation: "nfm",
		bandwidthHz: 12_500,
		squelchMode: "manual",
		thresholdDbfs: -50,
		peakChannelPowerDbfs: -20,
		meanChannelPowerDbfs: -24,
		closeReason: "squelch",
	}
}

function admission(sourceId: string, transmissionId: string) {
	const body = payload(sourceId, transmissionId)
	return {
		payload: body,
		producedAt: body.endedAt,
		receivedAt: body.endedAt,
	}
}

function ingress(overrides: Parameters<typeof resolveActivityLimits>[0] = {}) {
	return new ActivityIngress(
		resolveActivityLimits({
			globalRatePerSec: 0,
			decoderRatePerSec: 0,
			batchWindowMs: 0,
			...overrides,
		}),
		() => 0,
		logger,
	)
}

afterEach(async () => {
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("analog transmission admission", () => {
	it("gives each source its own bucket and records that key on a gap", () => {
		const gate = ingress({
			globalBurst: 5,
			decoderBurst: 1,
		})
		expect(gate.admitTransmission(admission("src-a", "t1")).admitted).toBe(true)
		expect(gate.admitTransmission(admission("src-a", "t2"))).toEqual({
			admitted: false,
			reason: "rate-limited",
		})
		expect(gate.admitTransmission(admission("src-b", "t3")).admitted).toBe(true)
		expect(gate.admit(envelope({ decoderId: "analog:src-a" })).admitted).toBe(
			false,
		)
		expect(gate.excludedTelemetry).toBe(0)
		expect(gate.stageOpenEpisode(1_000)).toBe(true)
		const batch = gate.takeBatch(10, 8 * 1024 * 1024)
		const gap = batch.find(row => row.kind === "ingestion-gap")
		expect(gap).toBeDefined()
		const parsed = parseStoredRecord({
			seq: "1",
			event_id: gap!.eventId,
			kind: gap!.kind,
			summary_json: gap!.summaryJson,
			record_json: gap!.recordJson,
		})
		expect(parsed.kind).toBe("ingestion-gap")
		if (parsed.kind === "ingestion-gap")
			expect(parsed.payload.decoderIds).toEqual(["analog:src-a"])
		const stored = batch.find(row => row.eventId === "t1")
		expect(stored?.kind).toBe("analog-transmission")
		expect(stored?.eventId).toBe("t1")
	})

	it("rejects a paused, full or closed gate without counting telemetry", () => {
		const paused = ingress({ globalBurst: 2, decoderBurst: 2 })
		paused.paused = true
		expect(paused.admitTransmission(admission("s", "p"))).toEqual({
			admitted: false,
			reason: "store-paused",
		})
		const full = ingress({
			globalBurst: 2,
			decoderBurst: 2,
			queueMaxItems: 1,
		})
		expect(full.admitTransmission(admission("s", "a")).admitted).toBe(true)
		expect(full.admitTransmission(admission("s", "b"))).toEqual({
			admitted: false,
			reason: "queue-full",
		})
		const tiny = ingress({
			globalBurst: 2,
			decoderBurst: 2,
			queueMaxBytes: 1,
		})
		expect(tiny.admitTransmission(admission("s", "c"))).toEqual({
			admitted: false,
			reason: "queue-full",
		})
		expect(tiny.dropped["rate-limited"]).toBe(0)
		const closed = ingress({ globalBurst: 2, decoderBurst: 2 })
		closed.markClosed()
		expect(closed.admitTransmission(admission("s", "d"))).toEqual({
			admitted: false,
			reason: "closed",
		})
		expect(closed.excludedTelemetry).toBe(0)
	})

	it("stores a transmission and finds it by kind, source and frequency", async () => {
		const store = await openStore()
		const input = admission("rtl0", "tx-live")
		expect(store.admitTransmission(input)).toEqual({ admitted: true })
		expect(store.admit(envelope({ outputType: "stats" })).admitted).toBe(false)
		const records = await readRecords(store.dbPath)
		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({
			kind: "analog-transmission",
			eventId: "tx-live",
			producedAt: input.producedAt,
			payload: input.payload,
		})
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		try {
			const page = await service.search({
				query: { kinds: ["analog-transmission"] },
				order: "asc",
			})
			expect(page.items).toHaveLength(1)
			expect(page.items[0]).toMatchObject({
				kind: "analog-transmission",
				eventId: "tx-live",
				sourceId: "rtl0",
				frequencyHz: 145_500_000,
				category: "voice",
				protocol: "analog",
			})
			const bySource = await service.search({
				query: {
					kinds: ["analog-transmission"],
					sourceIds: ["rtl0"],
					frequencyHz: { min: 145_000_000, max: 146_000_000 },
				},
				order: "asc",
			})
			expect(bySource.items.map(item => item.eventId)).toEqual(["tx-live"])
		} finally {
			await service.close()
		}
	})
})
