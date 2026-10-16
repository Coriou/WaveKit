/**
 * Analog transmission rows, WG7 req 2.4: `squelchMode: "noise"` and its
 * `noiseQuietingDb` are stored and read back; rows without them are unchanged;
 * a quieting value outside the contract (range, type, mode) is corrupt.
 */

import { describe, expect, it } from "vitest"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import type { AnalogTransmissionPayload } from "../../../../../src/core/activity/storage/contract.js"
import {
	buildActivityRow,
	parseStoredRecord,
	parseStoredSummary,
} from "../../../../../src/core/activity/storage/row.js"

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

function build(body: AnalogTransmissionPayload) {
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

function row(built: ReturnType<typeof build>, recordJson = built.recordJson) {
	return {
		seq: "9",
		event_id: built.eventId,
		kind: built.kind,
		summary_json: built.summaryJson,
		record_json: recordJson,
	}
}

/** The stored record JSON with its payload patched (a tampered or foreign row). */
function tampered(patch: Record<string, unknown>, drop: string[] = []): string {
	const built = build(payload({ squelchMode: "noise", noiseQuietingDb: 6 }))
	const record = JSON.parse(built.recordJson) as {
		payload: Record<string, unknown>
	}
	Object.assign(record.payload, patch)
	for (const key of drop) delete record.payload[key]
	return JSON.stringify(record)
}

describe("analog transmission rows in noise mode", () => {
	it("stores and reads back squelchMode noise with its quieting threshold", () => {
		const built = build(payload({ squelchMode: "noise", noiseQuietingDb: 8 }))
		const parsed = parseStoredRecord(row(built))
		expect(parsed.kind).toBe("analog-transmission")
		if (parsed.kind !== "analog-transmission") return
		expect(parsed.payload.squelchMode).toBe("noise")
		expect(parsed.payload.noiseQuietingDb).toBe(8)
		expect(parsed.payload.thresholdDbfs).toBe(-40)
		for (const db of [1, 30]) {
			const bound = build(
				payload({ squelchMode: "noise", noiseQuietingDb: db }),
			)
			const back = parseStoredRecord(row(bound))
			expect(
				back.kind === "analog-transmission" && back.payload.noiseQuietingDb,
			).toBe(db)
		}
		// Noise mode without the value (it is optional in the contract) is valid.
		const bare = build(payload({ squelchMode: "noise" }))
		expect(parseStoredRecord(row(bare)).kind).toBe("analog-transmission")
		// The summary fields are unchanged by the mode.
		expect(parseStoredSummary(row(built)).fields.map(f => f.key)).toEqual([
			"durationMs",
			"modulation",
			"peakChannelPowerDbfs",
		])
	})

	it("leaves manual and auto rows byte-identical", () => {
		for (const squelchMode of ["manual", "auto"] as const) {
			const body = payload({ squelchMode })
			const built = build(body)
			expect(JSON.parse(built.recordJson).payload).toEqual(body)
			expect(Object.keys(JSON.parse(built.recordJson).payload)).not.toContain(
				"noiseQuietingDb",
			)
			const parsed = parseStoredRecord(row(built))
			expect(parsed.kind === "analog-transmission" && parsed.payload).toEqual(
				body,
			)
		}
	})

	it("treats an out-of-contract quieting value or mode as corrupt", () => {
		const base = build(payload())
		for (const recordJson of [
			tampered({ noiseQuietingDb: 0.5 }),
			tampered({ noiseQuietingDb: 31 }),
			tampered({ noiseQuietingDb: "6" }),
			tampered({ noiseQuietingDb: null }),
			tampered({ noiseQuietingDb: 1e400 }),
			tampered({ squelchMode: "manual" }),
			tampered({ squelchMode: "auto" }),
			tampered({ squelchMode: "loud" }),
			tampered({ noiseQuietingDb: 6, extra: true }),
		]) {
			expect(() => parseStoredRecord(row(base, recordJson))).toThrow()
		}
		expect(() =>
			build(payload({ squelchMode: "manual", noiseQuietingDb: 6 })),
		).toThrow()
		expect(() =>
			build(payload({ squelchMode: "noise", noiseQuietingDb: 0 })),
		).toThrow()
	})
})
