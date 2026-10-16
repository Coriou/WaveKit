import { describe, expect, it } from "vitest"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import type { AnalogTransmissionPayload } from "../../../../../src/core/activity/storage/contract.js"
import { MAX_SUMMARY_BYTES } from "../../../../../src/core/activity/storage/contract.js"
import {
	buildActivityRow,
	parseStoredRecord,
	parseStoredSummary,
} from "../../../../../src/core/activity/storage/row.js"
import { WaveKitError } from "../../../../../src/utils/errors.js"

function payload(
	patch: Partial<AnalogTransmissionPayload> = {},
): AnalogTransmissionPayload {
	return {
		transmissionId: "tx-446",
		sourceId: "rtl0",
		startedAt: "2026-10-13T12:00:00.000Z",
		endedAt: "2026-10-13T12:00:02.500Z",
		durationMs: 2_500,
		frequency: { hz: 446_006_250, tuningTrust: "commanded" },
		modulation: "nfm",
		bandwidthHz: 12_500,
		squelchMode: "manual",
		thresholdDbfs: -40,
		peakChannelPowerDbfs: -12.5,
		meanChannelPowerDbfs: -18,
		closeReason: "squelch",
		...patch,
	}
}

function rowFor(body: AnalogTransmissionPayload) {
	return buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId: body.transmissionId,
		commitSeq: "0",
		producedAt: body.endedAt,
		receivedAt: "2026-10-13T12:00:02.600Z",
		kind: "analog-transmission",
		payload: body,
	})
}

describe("analog transmission rows", () => {
	it("projects the voice summary and round-trips the payload", () => {
		const body = payload()
		const built = rowFor(body)
		expect(built).toMatchObject({
			eventId: "tx-446",
			kind: "analog-transmission",
			sourceId: "rtl0",
			decoderId: null,
			protocol: "analog",
			category: "voice",
			frequencyHz: 446_006_250,
			entityKey: null,
			refs: [],
		})
		expect(Buffer.byteLength(built.summaryJson, "utf8")).toBeLessThanOrEqual(
			MAX_SUMMARY_BYTES,
		)
		const stored = {
			seq: "4",
			event_id: built.eventId,
			kind: built.kind,
			summary_json: built.summaryJson,
			record_json: built.recordJson,
		}
		expect(parseStoredRecord(stored)).toMatchObject({
			commitSeq: "4",
			kind: "analog-transmission",
			producedAt: body.endedAt,
			payload: body,
		})
		expect(parseStoredSummary(stored)).toMatchObject({
			kind: "analog-transmission",
			category: "voice",
			protocol: "analog",
			decoderId: null,
			sourceId: "rtl0",
			frequencyHz: 446_006_250,
			entityKey: null,
			title: "NFM 446.00625 MHz",
			fields: [
				{ key: "durationMs", label: "Duration", value: 2_500, unit: "ms" },
				{ key: "modulation", label: "Modulation", value: "nfm" },
				{
					key: "peakChannelPowerDbfs",
					label: "Peak channel power",
					value: -12.5,
					unit: "dBFS",
				},
			],
		})
		expect(built.ftsText).toContain("analog-transmission")
		expect(built.ftsText).toContain("nfm")
		expect(built.ftsText).toContain("rtl0")
		expect(built.ftsText).toContain("446006250")
	})

	it("titles a transmission without a frequency and omits a null peak", () => {
		const built = rowFor(
			payload({
				frequency: null,
				peakChannelPowerDbfs: null,
				modulation: "usb",
			}),
		)
		const summary = parseStoredSummary({
			seq: "1",
			event_id: built.eventId,
			kind: built.kind,
			summary_json: built.summaryJson,
			record_json: built.recordJson,
		})
		expect(summary.title).toBe("USB transmission")
		expect(summary.frequencyHz).toBeNull()
		expect(summary.fields.map(field => field.key)).toEqual([
			"durationMs",
			"modulation",
		])
	})

	it("keeps the summary inside 4 KiB when the source id is huge", () => {
		const sourceId = `rtl-${"x".repeat(5_000)}`
		const built = rowFor(payload({ sourceId }))
		expect(built.sourceId).toBe(sourceId)
		expect(Buffer.byteLength(built.summaryJson, "utf8")).toBeLessThanOrEqual(
			MAX_SUMMARY_BYTES,
		)
		const stored = {
			seq: "1",
			event_id: built.eventId,
			kind: built.kind,
			summary_json: built.summaryJson,
			record_json: built.recordJson,
		}
		const record = parseStoredRecord(stored)
		expect(
			record.kind === "analog-transmission" && record.payload.sourceId,
		).toBe(sourceId)
		const summary = parseStoredSummary(stored)
		expect(summary.sourceId?.startsWith("rtl-")).toBe(true)
		expect(summary.sourceId).not.toBe(sourceId)
	})

	it("rejects an unknown or invalid stored payload as corrupt", () => {
		const built = rowFor(payload())
		const cases = [
			built.recordJson.replace('"squelch"', '"nope"'),
			built.recordJson.replace('"nfm"', '"fm"'),
			built.recordJson.replace(
				'"frequency":{"hz":446006250,"tuningTrust":"commanded"}',
				'"frequency":{"hz":446006250,"tuningTrust":"commanded","extra":1}',
			),
		]
		for (const recordJson of cases) {
			expect(() =>
				parseStoredRecord({
					seq: "1",
					event_id: built.eventId,
					kind: "analog-transmission",
					summary_json: built.summaryJson,
					record_json: recordJson,
				}),
			).toThrow(WaveKitError)
		}
	})
})
