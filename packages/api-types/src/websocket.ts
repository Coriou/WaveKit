import type { DecoderInfo, DecoderOutput } from "./decoders.js"
import type { ExtendedSourceStatus } from "./sources.js"

export interface DecoderOutputMessage {
	decoderId: string
	output: DecoderOutput
}

/** `decoder:status` on the `decoders` channel: identical to GET /api/decoders/:id. */
export type DecoderStatusEventData = DecoderInfo

/** `source:status` on the `sources` channel: identical to a GET /api/sources item. */
export type SourceStatusEventData = ExtendedSourceStatus

/**
 * `source:removed` on the `sources` channel: sent once when a source is
 * removed. Clients drop the row and any cached `source:status`.
 */
export interface SourceRemovedEventData {
	sourceId: string
	/** ISO 8601 timestamp of the removal. */
	removedAt: string
}
