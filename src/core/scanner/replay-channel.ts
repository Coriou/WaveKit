/**
 * The channel a replayed ACARS or VDL2 capture is decoded and attributed at, and the centre such a
 * capture is made at. A track's measured centre may sit a few hundred Hz to a few kHz off the
 * assigned channel; acarsdec reports no frequency on replay and dumpvdl2 reports the channel it was
 * given, so without this the decode would key a channel that does not exist (and miss the channel
 * anchor the live decodes of the same channel use). Pure.
 *
 * Every ACARS and VDL2 assignment lies on the 25 kHz aeronautical raster (8.33 kHz channels are
 * voice only).
 */
import {
	ACARS_CHANNEL_BANDWIDTH_HZ,
	ACARS_CHANNEL_TRANSITION_HZ,
	ACARS_OCCUPIED_HALF_HZ,
} from "../../decoders/builtin/acarsdec.js"
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

/** Half the occupied bandwidth of an ACARS block, ±3 600 Hz (acarsdec.ts owns the arithmetic). */
export { ACARS_OCCUPIED_HALF_HZ }

/**
 * acarsdec's replay filter, the replay tool's `--bandwidth 9200 --transition 1000` (the ACARS
 * channel, acarsdec.ts ACARS_CHANNEL_BANDWIDTH_HZ): 2 × (3 600 + 1 000) = 9 200 Hz flat-band
 * width with a 1 000 Hz transition, so its stop edge is 5 600 Hz from the capture centre. It is
 * the only channel filter on replay: acarsdec adds none by default (decoder option
 * channelFilter is off). The tool designs a Kaiser windowed sinc for 66 dB and grows it until
 * the stopband peak is at most −62 dB (native/wavekit-chan design.rs `lowpass`): at the 48 kHz
 * capture rate 197 taps, computed 0 dB at 4 600 Hz, −3.2 dB at 5 000 Hz, −6 dB at 5 100 Hz,
 * −72 dB at 5 600 Hz and −85 dB at the 8 333 Hz neighbour (stopband peak −65 dB). It holds a
 * block only when the capture is centred on the block's channel: a capture near a raster
 * channel is made there (rasterCaptureCentreHz), so the carrier sits within its 1 000 Hz
 * tolerance of the centre, not up to REPLAY_CHANNEL_SNAP_HZ off. The stop edge stays inside
 * the 48 kHz capture's 24 000 Hz Nyquist edge.
 */
export const ACARS_REPLAY_BANDWIDTH_HZ = ACARS_CHANNEL_BANDWIDTH_HZ
export const ACARS_REPLAY_TRANSITION_HZ = ACARS_CHANNEL_TRANSITION_HZ

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

/**
 * The centre a detection or identify capture at `rfHz` is made at: its 25 kHz raster channel when
 * one lies within REPLAY_CHANNEL_SNAP_HZ (exclusive) in the VHF aeronautical band
 * (rasterChannelOf), else `rfHz` itself. The capture tool shifts the centre to DC, so the narrow
 * ACARS replay filter (±4 600 Hz flat) and dumpvdl2's channel are centred on the channel and not
 * on a measured centre up to 4 kHz off. An 8.33 kHz voice channel is 8 333 Hz from the raster and
 * keeps its own centre; a 25 kHz one moves at most to its own channel centre.
 */
export function rasterCaptureCentreHz(rfHz: number): number {
	return rasterChannelOf("acars", rfHz) ?? rfHz
}
