import type { DecoderOutput } from "../../../../../src/decoders/types.js"
import { createDecodeEnvelope } from "../../../../../src/core/activity/envelope.js"
import { presentDecoderOutput } from "../../../../../src/core/activity/presentation/registry.js"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import { buildActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type { DecodeEnvelope } from "../../../../../src/core/activity/types.js"

const RECEIVED = new Date("2026-10-13T00:00:00.000Z")

export function decoderOutput(
	type: DecoderOutput["type"],
	data: unknown,
	decoder = "dec-1",
): DecoderOutput {
	return { timestamp: new Date(RECEIVED), decoder, type, data }
}

export function rowBytes(envelope: DecodeEnvelope): number {
	const row = buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId: envelope.eventId,
		commitSeq: "0",
		producedAt: envelope.producedAt,
		receivedAt: envelope.receivedAt,
		kind: "decoder-reception",
		payload: envelope,
	})
	return (
		Buffer.byteLength(row.summaryJson, "utf8") +
		Buffer.byteLength(row.recordJson, "utf8") +
		Buffer.byteLength(row.ftsText, "utf8")
	)
}

/** Built-row bytes with and without the presentation of one output. */
export function presentationGrowth(output: DecoderOutput): {
	plain: number
	presented: number
	growth: number
} {
	const context = {
		eventId: "evt-measure",
		receivedAt: RECEIVED,
		decoderId: output.decoder,
		decoderType: "measure",
		provenance: { sourceId: null, frequency: null },
	}
	const plain = createDecodeEnvelope(output, context)
	const view = presentDecoderOutput(output, "measure")
	const presented =
		view === undefined ? plain : createDecodeEnvelope(output, context, view)
	const plainBytes = rowBytes(plain)
	const presentedBytes = rowBytes(presented)
	return {
		plain: plainBytes,
		presented: presentedBytes,
		growth: presentedBytes - plainBytes,
	}
}
