/**
 * WG11 frozen contract (docs/specs/web-gaps-11, requirement 6): narrowband IQ capture on
 * detection, replayed into the probe decoders after the transmission ended. Queue order:
 * capture → queue → replay trials → result → discard. Lane IQ implements the port and the queue
 * (`src/core/iq-capture/**`) with the native `wavekit-iqcap` tool and the `replay` probe
 * transport; lane ID implements the planner (`planReplayTrials`); Main wires the result sink into
 * the scanner service, identify and the probe pool. Constants and types only.
 */
import type { Readable } from "node:stream"
import type { TuningTrust } from "@wavekit/api-types"
import type { TrackSnapshot } from "../spectrum/types.js"
import type { ProbeDecoderType, ProbeMode } from "./probes/probe-pool.js"
import type {
	AnalogTrialMode,
	AnalogTrialResult,
	AnalyzeEvent,
} from "./scanner-redesign-contract.js"
import type { Identity, ScannerProtocol } from "./types.js"

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
/**
 * A capture is discarded as soon as its result exists; one that never got a result (backlog,
 * decoders unavailable) is discarded this long after it finished (10 minutes).
 */
export const IQ_CAPTURE_ORPHAN_TTL_MS = 600_000
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
/** Replay trials per capture at most (known protocol first). */
export const IQ_REPLAY_MAX_TRIALS = 8

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

/** Why a capture left the store (counted). */
export type IqCaptureDiscardReason =
	| "result"
	| "confirmed-live"
	| "orphan-ttl"
	| "invalid"
	| "shutdown"

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
	/**
	 * An identify job takes a queued capture over from the replay queue (`holder` = the job id);
	 * false when it is gone, not ready, already replaying or held by another job.
	 */
	claim(captureId: string, holder: string): boolean
	/** The holder reached its result (or ended): the capture is discarded at once. */
	settle(captureId: string, holder: string): void
	/**
	 * A live probe or identify run decoded the observation: its captures whose replay has not
	 * started are discarded (`confirmed-live`). Returns how many were discarded.
	 */
	confirmLive(sourceId: string, observationId: string): number
	/**
	 * A fresh replay stream of the capture filtered to the decoder type's probe channel shape
	 * (cf32 at the shape's rate), or null when the capture is gone, unverified or `rtl433`.
	 */
	openReplay(captureId: string, decoderType: ProbeDecoderType): Readable | null
	/**
	 * WG12: spawn `wavekit-iqcap analyze` for one capture. Stdout is s16le 8 kHz audio;
	 * `event` is the single JSON line from fd 4. Null when the capture is gone. Absent
	 * on a port that has no analyze child.
	 */
	openAnalyze?(
		captureId: string,
		mode: AnalogTrialMode,
	): {
		audio: Readable
		event: Promise<AnalyzeEvent>
		kill(): void
	} | null
}

/** What `planReplayTrials` (lane ID) gets for one capture (Main composes it from the scanner). */
export interface IqReplayPlanInput {
	capture: IqCaptureView
	/** The captured track's last snapshot; null when the scanner no longer holds it. */
	track: TrackSnapshot | null
	/** The discovery's known protocol (requirement 1.7); null when none or decayed. */
	knownProtocol: ScannerProtocol | null
	priors: Partial<Record<ScannerProtocol, number>>
	/** `narrowRasterAt(ranges, capture.rfHz)` (requirement 1.3). */
	narrowRaster: boolean
}

/** One replay trial; at most IQ_REPLAY_MAX_TRIALS per capture, `known` ones first. */
export interface IqReplayTrial {
	protocol: ScannerProtocol
	mode: ProbeMode
	/** The trial of the discovery's known protocol (a miss counts per requirement 1.8). */
	known: boolean
	/** WG12: absent means `probe`. */
	kind?: "probe" | "analog"
	/** WG12: set when `kind` is `analog`. */
	analogMode?: AnalogTrialMode
}

export type IqReplayPlanner = (
	input: IqReplayPlanInput,
) => readonly IqReplayTrial[]

export type IqReplayTrialOutcome =
	| "decoded"
	| "no-sync"
	| "crc-errors"
	| "timeout"
	| "cancelled"
	/** WG12 analog replay trial. */
	| "heard"
	| "data-like"
	| "carrier-only"
	/** WG12: the decoder program was missing before any output (requirement 4.5). */
	| "unsupported"

/** The result of one capture's queue entry, delivered once, before the capture is discarded. */
export interface IqReplayResult {
	captureId: string
	sourceId: string
	observationId: string | null
	epoch: number
	trials: readonly {
		protocol: ScannerProtocol
		decoderType: ProbeDecoderType
		known: boolean
		outcome: IqReplayTrialOutcome
		/** WG12: the decoder that ran, when it is not `decoderType`. */
		decoder?: string
		/** WG12: analog trial mode, when this trial was the analog step. */
		mode?: AnalogTrialMode
		/** WG12: set when the outcome is `unsupported` because the program could not run. */
		reason?: "decoder-unavailable"
	}[]
	/** The first accepted (H2) decode; null when no trial decoded. */
	decoded: { protocol: ScannerProtocol; identity: Identity } | null
	/** WG12: the analog replay trial, when the plan included one. */
	analog?: AnalogTrialResult
	/** WG12: probe decoder types that could not run. Absent when none. */
	unavailable?: ProbeDecoderType[]
}

/** Main's scanner side: decode evidence or undecoded reason, and the known-protocol memory. */
export type IqReplaySink = (result: IqReplayResult) => void
