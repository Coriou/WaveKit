/**
 * The channel a replayed ACARS or VDL2 capture is decoded and attributed at. A capture is centred
 * on its track's measured centre, which may sit a few hundred Hz to a few kHz off the assigned
 * channel; acarsdec reports no frequency on replay and dumpvdl2 reports the channel it was given,
 * so without this the decode would key a channel that does not exist (and miss the channel anchor
 * the live decodes of the same channel use). Pure.
 *
 * Every ACARS and VDL2 assignment lies on the 25 kHz aeronautical raster (8.33 kHz channels are
 * voice only): 129.125, 130.025, 131.550, 131.725, 131.825 MHz ACARS; 136.650 to 136.975 MHz VDL2.
 */
import { AERO_VHF_MAX_HZ, AERO_VHF_MIN_HZ } from "./store/decode-anchor.js"
import { ambientReachHz } from "./probes/ambient-placement.js"
import type { ScannerProtocol } from "./types.js"

/** The ACARS/VDL2 channel raster. */
export const AERO_DATALINK_RASTER_HZ = 25_000

/**
 * How far a capture centre may sit from a raster channel and still be that channel: the point
 * placement reach a live channel decode uses to prove a spectrum discovery (proveChannelDiscovery),
 * ambientReachHz(protocol, 0) = 1 500 + 2 500 = 4 000 Hz, exclusive. So a replay attributes a
 * capture to exactly the channel a live decode of the same discovery would.
 */
export const REPLAY_CHANNEL_SNAP_HZ = ambientReachHz("vdl2", 0)

/**
 * Half the occupied bandwidth of a VDL2 burst: 10 500 symbols/s D8PSK with a raised-cosine
 * roll-off of 0.6 occupies 10 500 × (1 + 0.6) = 16 800 Hz, 8 400 Hz each side. The VDL2 replay
 * passband is ±12 500 Hz (probeReplayShapes: 25 000 Hz), so a channel at most
 * 12 500 − 8 400 = 4 100 Hz off the capture centre still fits whole; the 4 000 Hz snap stays below.
 */
export const VDL2_OCCUPIED_HALF_HZ = 8_400
export const VDL2_REPLAY_MAX_OFFSET_HZ = 12_500 - VDL2_OCCUPIED_HALF_HZ

/**
 * Half the occupied bandwidth of an ACARS block: AM with 2 400 bit/s MSK audio tones at 1 200 and
 * 2 400 Hz, so the sidebands reach 2 400 + 2 400 / 2 = 3 600 Hz each side of the carrier.
 */
export const ACARS_OCCUPIED_HALF_HZ = 3_600

/**
 * acarsdec's replay filter, centred on the capture centre (the replay tool does not shift): wide
 * enough for a block up to REPLAY_CHANNEL_SNAP_HZ off centre, 2 × (4 000 + 3 600) = 15 200 Hz.
 * Its stop edge, 15 200 / 2 + 4 000 = 11 600 Hz, stays short of the nearest sideband of the
 * neighbouring 25 kHz channel, 25 000 − 4 000 − 3 600 = 17 400 Hz from the centre, and inside the
 * 48 kHz capture's 24 000 Hz Nyquist edge.
 */
export const ACARS_REPLAY_BANDWIDTH_HZ =
	2 * (REPLAY_CHANNEL_SNAP_HZ + ACARS_OCCUPIED_HALF_HZ)
export const ACARS_REPLAY_TRANSITION_HZ = 4_000

/** True for the protocols decoded and attributed at a raster channel. */
export function isRasterReplayProtocol(protocol: ScannerProtocol): boolean {
	return protocol === "acars" || protocol === "vdl2"
}

/**
 * The raster channel a capture centred at `rfHz` holds, or null: not ACARS/VDL2, not finite, not
 * within REPLAY_CHANNEL_SNAP_HZ (exclusive) of a 25 kHz raster point, or outside the VHF
 * aeronautical band (AERO_VHF_MIN_HZ..AERO_VHF_MAX_HZ inclusive, as a channel anchor).
 */
export function rasterChannelOf(
	protocol: ScannerProtocol,
	rfHz: number,
): number | null {
	if (!isRasterReplayProtocol(protocol) || !Number.isFinite(rfHz)) return null
	const channel =
		Math.round(rfHz / AERO_DATALINK_RASTER_HZ) * AERO_DATALINK_RASTER_HZ
	if (Math.abs(rfHz - channel) >= REPLAY_CHANNEL_SNAP_HZ) return null
	if (channel < AERO_VHF_MIN_HZ || channel > AERO_VHF_MAX_HZ) return null
	return channel
}

/**
 * The channel a replay of `protocol` from a capture centred at `rfHz` decodes and attributes at:
 * its raster channel when it has one, else the capture centre (every other protocol, and a centre
 * no channel claims).
 */
export function replayChannelHz(
	protocol: ScannerProtocol,
	rfHz: number,
): number {
	return rasterChannelOf(protocol, rfHz) ?? rfHz
}
