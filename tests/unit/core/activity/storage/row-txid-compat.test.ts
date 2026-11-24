/**
 * Transmission ids in Activity rows: records stored before them (no txId) read and rebuild
 * byte-identical; records with `txId` / `moreTxIds` / `startedAt` round-trip and carry one `txId`
 * ref per transmission; a malformed member is a corrupt payload. Synthetic rows only.
 */
import { describe, expect, it } from "vitest"
import {
	ACTIVITY_RECORD_VERSION,
	type ActivityRecord,
	type AnalogTransmissionPayload,
	type RecordingChangePayload,
} from "../../../../../src/core/activity/storage/contract.js"
import {
	buildActivityRow,
	parseStoredRecord,
} from "../../../../../src/core/activity/storage/row.js"
import { envelope } from "./helpers.js"

const TX_A = "tx_01JTESTTXAAAAAAAAAAAAAAAAA"
const TX_B = "tx_01JTESTTXBBBBBBBBBBBBBBBBB"
const TX_C = "tx_01JTESTTXCCCCCCCCCCCCCCCCC"
const DISCOVERY = "d_01JTESTDISCOVERY"
const KEY = `scan:${DISCOVERY}~analog-6f0a2c1e-1111-4222-8333-444455556666.wav`

function transmission(
	patch: Partial<AnalogTransmissionPayload> = {},
): AnalogTransmissionPayload {
	return {
		transmissionId: "t-1",
		sourceId: "source-1",
		startedAt: "2026-10-13T12:00:00.000Z",
		endedAt: "2026-10-13T12:00:02.500Z",
		durationMs: 2_500,
		frequency: { hz: 100_000_000, tuningTrust: "commanded" },
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

function kept(
	patch: Partial<RecordingChangePayload> = {},
): RecordingChangePayload {
	return {
		change: "finalized",
		recordingId: KEY,
		recordingKind: "scanner-analog",
		discoveryId: DISCOVERY,
		observationId: "o_01JTESTOBSERVATION",
		sourceId: "source-1",
		frequencyHz: 100_000_300,
		observationStartedAt: "2026-10-12T00:00:00.000Z",
		durationMs: 3500,
		finalizedAt: "2026-10-12T00:00:30.000Z",
		...patch,
	}
}

function record(
	kind: ActivityRecord["kind"],
	payload: unknown,
	eventId = "e-1",
): ActivityRecord {
	return {
		version: ACTIVITY_RECORD_VERSION,
		eventId,
		commitSeq: "0",
		producedAt: "2026-10-12T00:00:30.000Z",
		receivedAt: "2026-10-12T00:00:30.100Z",
		kind,
		payload,
	} as ActivityRecord
}

/** Store, read back and rebuild: the record JSON must come back byte for byte. */
function roundTrip(r: ActivityRecord): { first: string; again: string } {
	const built = buildActivityRow(r)
	const read = parseStoredRecord({
		seq: 7,
		event_id: built.eventId,
		kind: built.kind,
		summary_json: built.summaryJson,
		record_json: built.recordJson,
	})
	return { first: built.recordJson, again: buildActivityRow(read).recordJson }
}

describe("Activity rows with transmission ids", () => {
	it("pre-P1 records of every kind round-trip byte-identical and carry no txId", () => {
		const records = [
			record("analog-transmission", transmission(), "t-1"),
			record(
				"analog-transmission",
				transmission({
					tone: { ctcssHz: 88.5, dtmf: null, dcs: null },
					squelchMode: "noise",
					noiseQuietingDb: 12,
				}),
				"t-1",
			),
			record("recording-change", kept()),
			record(
				"recording-change",
				kept({ channel: { discoveryId: DISCOVERY, frequencyHz: 100_000_000 } }),
			),
			record("decoder-reception", envelope({ eventId: "e-1" })),
			record("ingestion-gap", {
				reason: "queue-full",
				dropped: 3,
				decoderIds: ["d1"],
				fromReceivedAt: "2026-10-12T00:00:00.000Z",
				toReceivedAt: "2026-10-12T00:00:01.000Z",
			}),
		]
		for (const r of records) {
			const { first, again } = roundTrip(r)
			expect(again).toBe(first)
			expect(first).not.toContain("txId")
			expect(buildActivityRow(r).refs.some(ref => ref.type === "txId")).toBe(
				false,
			)
		}
	})

	it("a pre-P1 transmission's stored JSON is the base's byte for byte", () => {
		const built = buildActivityRow(
			record("analog-transmission", transmission(), "t-1"),
		)
		expect(built.recordJson).toBe(
			JSON.stringify({
				version: ACTIVITY_RECORD_VERSION,
				eventId: "t-1",
				producedAt: "2026-10-12T00:00:30.000Z",
				receivedAt: "2026-10-12T00:00:30.100Z",
				kind: "analog-transmission",
				payload: transmission(),
			}),
		)
	})

	it("P1 records round-trip with their members and one txId ref per transmission", () => {
		const change = kept({
			txId: TX_A,
			moreTxIds: [TX_B, TX_C],
			startedAt: "2026-10-12T00:00:05.000Z",
		})
		const { first, again } = roundTrip(record("recording-change", change))
		expect(again).toBe(first)
		const built = buildActivityRow(record("recording-change", change))
		expect(
			built.refs.filter(ref => ref.type === "txId").map(ref => ref.value),
		).toEqual([TX_A, TX_B, TX_C])
		const tx = record(
			"analog-transmission",
			transmission({ txId: TX_A }),
			"t-1",
		)
		const trip = roundTrip(tx)
		expect(trip.again).toBe(trip.first)
		expect(JSON.parse(trip.first).payload.txId).toBe(TX_A)
		expect(buildActivityRow(tx).refs).toEqual([{ type: "txId", value: TX_A }])
	})

	it("a malformed transmission member is a corrupt payload", () => {
		const bad: Partial<RecordingChangePayload>[] = [
			{ txId: "tx_bad" },
			{ moreTxIds: [TX_B] },
			{ txId: TX_A, moreTxIds: [] },
			{ txId: TX_A, moreTxIds: [TX_A] },
			{ txId: TX_A, moreTxIds: [TX_B, TX_B] },
			{
				txId: TX_A,
				moreTxIds: Array.from(
					{ length: 8 },
					(_, i) => `tx_01JTESTTX${String(i).padStart(17, "D")}`,
				),
			},
			{ startedAt: "yesterday" },
		]
		for (const patch of bad)
			expect(() =>
				buildActivityRow(record("recording-change", kept(patch))),
			).toThrow()
		expect(() =>
			buildActivityRow(
				record("analog-transmission", transmission({ txId: "nope" }), "t-1"),
			),
		).toThrow()
	})

	it("seven more transmissions are within the bound", () => {
		const more = Array.from(
			{ length: 7 },
			(_, i) => `tx_01JTESTTX${String(i).padStart(17, "D")}`,
		)
		expect(() =>
			buildActivityRow(
				record("recording-change", kept({ txId: TX_A, moreTxIds: more })),
			),
		).not.toThrow()
	})
})
