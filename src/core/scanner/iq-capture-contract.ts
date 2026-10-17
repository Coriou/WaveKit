/**
 * WG11 frozen contract (docs/specs/web-gaps-11, requirement 6): narrowband IQ capture on
 * detection, replayed into identify. Lane IQ implements the port (`src/core/iq-capture/service.ts`)
 * with the native `wavekit-iqcap` tool and the `replay` probe transport; Main wires it into the
 * scanner service, identify and the probe pool. Constants and types only.
 */
import type { Readable } from "node:stream"
import type { TuningTrust } from "@wavekit/api-types"
import type { ProbeDecoderType } from "./probes/probe-pool.js"

/** Capture output rate: the probe decoders' channel rate (48 kHz audio family). */
export const IQ_CAPTURE_RATE_HZ = 48_000
/** cf32: interleaved little-endian float32 I and Q. */
export const IQ_CAPTURE_BYTES_PER_SAMPLE = 8
/** One capture, pre-roll included. */
export const IQ_CAPTURE_MAX_MS = 4_000
/** 4 s × 48 000 samples/s × 8 B = 1 536 000 B per capture file. */
export const IQ_CAPTURE_MAX_BYTES =
	(IQ_CAPTURE_MAX_MS / 1000) * IQ_CAPTURE_RATE_HZ * IQ_CAPTURE_BYTES_PER_SAMPLE
/** 256 MiB in total (174 full captures). */
export const IQ_CAPTURE_TOTAL_MAX_BYTES = 256 * 1024 * 1024
/** A capture is deleted at the latest this long after it was taken. */
export const IQ_CAPTURE_RETENTION_MS = 86_400_000
/** The native full-rate ring: 2 s × fs × 2 B (8.2 MB at 2.048 Msps). */
export const IQ_CAPTURE_PREROLL_MAX_MS = 2_000
/** Captures being written at once (per core). */
export const IQ_CAPTURE_MAX_CONCURRENT = 2
/** Detection-triggered captures per source per minute (≤ 9.2 MB/min of disk). */
export const IQ_CAPTURE_PER_SOURCE_PER_MINUTE = 6
/** Directory under the scanner storage root. */
export const IQ_CAPTURE_DIR = "iq-captures"
/** `<uuid v4>.cf32`: the only file names the store writes, replays or sweeps. */
export const IQ_CAPTURE_FILE_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cf32$/
/** Bound of one JSON control or event line exchanged with the native tool. */
export const IQ_CAPTURE_CONTROL_LINE_MAX_BYTES = 4_096
/** Replay probes running at once. */
export const IQ_REPLAY_MAX_PROBES = 1
/** CPU budget cost of one replay probe (cores). */
export const IQ_REPLAY_PROBE_CORES = 0.15
/** Captures replayed per identify target at most (newest first). */
export const IDENTIFY_REPLAY_MAX_CAPTURES = 2

/** A finished capture as identify and the replay transport see it. */
export interface IqCaptureView {
	captureId: string
	sourceId: string
	/** The scanner observation of the captured track; null when none was known. */
	observationId: string | null
	/** Spectrum engine epoch of the capture (decode evidence carries it). */
	epoch: number
	/** RF centre of the captured channel. */
	rfHz: number
	tuningTrust: TuningTrust
	capturedAtMs: number
	durationMs: number
	/** Samples missing inside the capture (reported by the tool; never filled). */
	gapSamples: number
}

export interface IqCaptureRequest {
	sourceId: string
	observationId: string | null
	epoch: number
	rfHz: number
	tuningTrust: TuningTrust
	/** Engine sample of the track start; the capture starts at most the configured pre-roll earlier. */
	fromSample: number
	reason: "detection" | "identify"
}

/** Why a capture request was not accepted (counted; never logged with ids or frequencies). */
export type IqCaptureRefusal =
	| "disabled"
	| "not-protected"
	| "unavailable"
	| "rate-limited"
	| "busy"
	| "full"
	| "epoch-changed"
	| "invalid"

export interface IqCapturePort {
	/** Finished, verified captures near `hz` (newest first, at most `limit`). Never throws. */
	near(
		sourceId: string,
		hz: number,
		toleranceHz: number,
		opts: { observationId: string | null; limit: number },
	): readonly IqCaptureView[]
	/** Starts a capture; its id, or a refusal. Never throws. */
	capture(
		req: IqCaptureRequest,
	): { captureId: string } | { refused: IqCaptureRefusal }
	/** The captured track closed: finish the capture early (no-op when already finished). */
	end(captureId: string): void
	/** Holds a capture for `holder` (an identify job id); false when it is gone or not ready. */
	retain(captureId: string, holder: string): boolean
	/** Releases a hold; the last release after `retain` deletes the capture. */
	release(captureId: string, holder: string): void
	/**
	 * A fresh replay stream of the capture filtered to the decoder type's probe channel shape
	 * (cf32 at the shape's rate), or null when the capture is gone, unverified or `rtl433`.
	 */
	openReplay(captureId: string, decoderType: ProbeDecoderType): Readable | null
}
