/**
 * WG11 frozen contract (docs/specs/web-gaps-11, requirements 1.7 and 1.8): the known-protocol
 * memory. A discovery's known protocol is its stored `protocol` while its confidence is
 * `decoded` and its in-memory miss count is below KNOWN_PROTOCOL_MAX_MISSES. Lane ID implements
 * it (`src/core/scanner/known-protocol.ts`); Main wires one instance into identify, the job
 * drivers and the replay sink. Constants and types only.
 */
import type { ScannerProtocol } from "./types.js"

/** Consecutive full-hold misses of the known protocol after which planning ignores it. */
export const KNOWN_PROTOCOL_MAX_MISSES = 2

export interface KnownProtocolMemory {
	/** The known protocol of the discovery for planning; null when none or decayed. Never throws. */
	known(discoveryId: string): ScannerProtocol | null
	/** The known protocol's trial ran its full hold on a transmission of the discovery and did not decode. */
	recordMiss(discoveryId: string, protocol: ScannerProtocol): void
	/** Any accepted decode on the discovery: the miss count returns to zero. */
	recordDecode(discoveryId: string): void
	/** The discovery is gone (deleted, merged away): its count is dropped. */
	forget(discoveryId: string): void
}
