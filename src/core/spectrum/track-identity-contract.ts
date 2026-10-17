/**
 * WG11 frozen contract (docs/specs/web-gaps-11, requirement 5.3): the port the spectrum service
 * reads a frame track's scanner identity through. Main wires it from the scanner service
 * (`ScannerService.trackIdentity`). Types only.
 */
import type { SpectrumFrameTrackScanner } from "@wavekit/api-types"

/**
 * The scanner's identity of a live track of `sourceId`; null when the scanner holds no live
 * observation with a discovery for it. Must not throw (callers still guard) and must be O(1).
 */
export type SpectrumTrackIdentityLookup = (
	sourceId: string,
	trackId: string,
) => SpectrumFrameTrackScanner | null
