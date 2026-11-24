/**
 * Digital-voice call rows in the Activity ingress carry their transmission: a call_start or
 * call_end whose data names a `txId` gets a `txId` ref beside its `callId` ref, which the stored
 * row indexes (storage row.ts pushRef); a malformed one is ignored (the row kept without it).
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import { createActivityIngress } from "../../../../src/core/activity/ingress.js"
import {
	ACTIVITY_RECORD_VERSION,
	type ActivityRecord,
} from "../../../../src/core/activity/storage/contract.js"
import {
	buildActivityRow,
	parseStoredRecord,
} from "../../../../src/core/activity/storage/row.js"
import type { DecodeEnvelope } from "../../../../src/core/activity/types.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"

const TX = `tx_01JTESTTX${"C".repeat(17)}`

function call(
	type: "call_start" | "call_end",
	extra: Record<string, unknown>,
): DecoderOutput {
	return {
		timestamp: new Date("2026-10-12T10:00:05.000Z"),
		decoder: "dsd-a",
		type,
		data: {
			callId: "call-1",
			protocol: "p25p1",
			talkgroup: 9,
			source: 2001,
			...(type === "call_end" ? { duration: 4200 } : {}),
			encryptionKnown: true,
			flags: { encrypted: false },
			...extra,
		},
	}
}

function setup() {
	const rows: DecodeEnvelope[] = []
	const ingress = createActivityIngress({
		sink: (_envelope, present) => {
			rows.push(present())
		},
		logger: pino({ level: "silent" }),
	})
	return { ingress, rows }
}

describe("digital-voice call rows carry their txId ref", () => {
	it("a call_end and a call_start with a txId get the ref", () => {
		const { ingress, rows } = setup()
		ingress.publish("dsd-a", "dsd-fme", call("call_start", { txId: TX }))
		ingress.publish("dsd-a", "dsd-fme", call("call_end", { txId: TX }))
		expect(rows.map(r => r.refs)).toEqual([
			{ txId: TX },
			{ callId: "call-1", txId: TX },
		])
	})

	it("a malformed txId is ignored and a call without one has only its callId ref", () => {
		const { ingress, rows } = setup()
		ingress.publish("dsd-a", "dsd-fme", call("call_end", { txId: "tx_bad" }))
		ingress.publish("dsd-a", "dsd-fme", call("call_end", {}))
		expect(rows.map(r => r.refs)).toEqual([
			{ callId: "call-1" },
			{ callId: "call-1" },
		])
	})

	it("the stored row indexes the txId ref and reads back unchanged", () => {
		const { ingress, rows } = setup()
		ingress.publish("dsd-a", "dsd-fme", call("call_end", { txId: TX }))
		const envelope = rows[0]!
		const record = {
			version: ACTIVITY_RECORD_VERSION,
			eventId: envelope.eventId,
			commitSeq: "0",
			producedAt: "2026-10-12T10:00:05.000Z",
			receivedAt: "2026-10-12T10:00:05.100Z",
			kind: "decoder-reception",
			payload: envelope,
		} as ActivityRecord
		const built = buildActivityRow(record)
		expect(built.refs).toEqual(
			expect.arrayContaining([
				{ type: "callId", value: "call-1" },
				{ type: "txId", value: TX },
			]),
		)
		const read = parseStoredRecord({
			seq: 1,
			event_id: built.eventId,
			kind: built.kind,
			summary_json: built.summaryJson,
			record_json: built.recordJson,
		})
		expect(buildActivityRow(read).recordJson).toBe(built.recordJson)
	})
})
