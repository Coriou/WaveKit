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
import type { TrialMemoryEntry } from "./trial-memory.js"
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
/** 256 MiB in total (174 full 48 kHz captures, 87 at 96 kHz, 43 at 192 kHz). */
export const IQ_CAPTURE_TOTAL_MAX_BYTES = 256 * 1024 * 1024
/**
 * Output rates a capture may have (`wavekit-iqcap` `CAPTURE_RATES`): 48 kHz × 2^k, so the native
 * decimation keeps a small rational stage at every common source rate; 250 kHz is not offered
 * (its ratio to 1.024 and 2.048 Msps needs an interpolation factor of 125).
 * The 192 kHz passband scales by four, capped at 125000 + 2 × 12500 = 150000 Hz
 * to hold 125 kHz LoRa cheaply; 96 kHz keeps the narrow passband for short pulses.
 */
export const IQ_CAPTURE_RATES = [48_000, 96_000, 192_000] as const
export type IqCaptureRateHz = (typeof IQ_CAPTURE_RATES)[number]
/**
 * One capture file's bound at `rateHz`: 4 s × rate × 8 B. 48 kHz: 1 536 000 B; 96 kHz:
 * 3 072 000 B; 192 kHz: 6 144 000 B. A rate outside IQ_CAPTURE_RATES has no bound (0).
 */
export function iqCaptureMaxBytes(rateHz: number): number {
	return (IQ_CAPTURE_RATES as readonly number[]).includes(rateHz)
		? (IQ_CAPTURE_MAX_MS / 1000) * rateHz * IQ_CAPTURE_BYTES_PER_SAMPLE
		: 0
}
/**
 * The capture rate a protocol needs; absent = 48 kHz. ISM: rtl_433 decodes short-pulse OOK
 * sensors (229 µs pulses, measured) at 96 kHz but not at 48 kHz, where its envelope detector
 * merges them; 96 kHz decodes them as 192 kHz does. Disk: a full 96 kHz capture is 3 072 000 B,
 * so 6 captures per source per minute are at most 18.4 MB per minute (9.2 MB at 48 kHz), within
 * the unchanged 256 MiB total (the store refuses "full" past it).
 */
export const IQ_CAPTURE_RATE_BY_PROTOCOL: Readonly<
	Partial<Record<ScannerProtocol, IqCaptureRateHz>>
> = Object.freeze({ ism: 96_000, lora: 192_000 })
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
/**
 * The probe decoder types that have a replay input path. dsd-fme, multimon-ng and direwolf: the
 * capture service filters a capture to their probe channel shape and the decoder FM-demodulates
 * the cf32 at 48 kHz. rtl433: rtl_433 reads the 48 kHz cf32 capture as captured (`-r cf32:-`);
 * OOK sensors (pulses of hundreds of µs, a few kHz wide) decode at 48 kHz as at 250 kHz, FSK
 * sensors deviating past ±23.7 kHz do not fit the capture and stay live-only. Capture size is
 * unchanged: 4 s × 48 000 samples/s × 8 B = 1 536 000 B. acarsdec: the capture filtered to its
 * 25 kHz ACARS channel, AM-demodulated at 48 kHz and resampled to 12 kHz audio (replay only). The
 * VDL2/LoRa: native rational conversion to 105/250 kHz U8, respectively.
 * The replay planner and the replay transport skip any decoder not listed here.
 */
export const REPLAY_INPUT_DECODERS: ReadonlySet<string> = new Set([
	"dsd-fme",
	"multimon-ng",
	"direwolf",
	"rtl433",
	"acarsdec",
	"dumpvdl2",
	"lora-meshtastic",
])

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
	/** The capture's output rate; absent = 48 kHz (IQ_CAPTURE_RATE_HZ). */
	rateHz?: IqCaptureRateHz
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
	/** Output rate (one of IQ_CAPTURE_RATES); absent = 48 kHz. */
	rateHz?: IqCaptureRateHz
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
	 * (cf32 for audio/rtl_433, U8 for VDL2/LoRa at replayRateOf), or null when the
	 * capture is gone, unverified or too narrow for that decoder.
	 */
	openReplay(
		captureId: string,
		decoderType: ProbeDecoderType | "dumpvdl2" | "lora-meshtastic",
	): Readable | null
	/**
	 * The rate `openReplay` delivers to `decoderType`: the capture's own rate for rtl433, 48 kHz
	 * for the 48 kHz decoders (a faster capture is brought down to 48 kHz); null when the capture
	 * is gone. VDL2 gets 105 kHz U8 and LoRa 250 kHz U8. Absent on an older port: 48 kHz.
	 */
	replayRateOf?(
		captureId: string,
		decoderType: ProbeDecoderType | "dumpvdl2" | "lora-meshtastic",
	): number | null
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
	/**
	 * the discovery's remembered trial outcomes (`TrialMemory.view`); absent or null
	 * keeps the prior order.
	 */
	trialMemory?: readonly TrialMemoryEntry[] | null
	/** the clock the memory's backoff is measured against; absent = the capture time. */
	nowMs?: number
}

/** One replay trial; at most IQ_REPLAY_MAX_TRIALS per capture, `known` ones first. */
export interface IqReplayTrial {
	protocol: ScannerProtocol
	mode: ProbeMode
	/**
	 * Queue priority: the replay queue runs `known` trials first. The planner keeps it only on a
	 * leading run so the queue executes the planned order; see `knownProtocol` for the identity.
	 */
	known: boolean
	/**
	 * The trial of the discovery's known protocol (a miss counts per requirement 1.8), also when
	 * the memory moved it behind other trials and `known` is false. Absent = equals `known`.
	 */
	knownProtocol?: boolean
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
	/** WG12 req 4.6: a later digital trial did not run after analog decoded or heard. */
	| "not-needed"
	/** WG12: the analog trial's core reservation was refused. */
	| "skipped-budget"

/** The result of one capture's queue entry, delivered once, before the capture is discarded. */
export interface IqReplayResult {
	captureId: string
	sourceId: string
	observationId: string | null
	epoch: number
	/**
	 * The captured channel (the capture's `rfHz`), so a decode is attributed to its channel even
	 * when the observation is gone. Absent on older queues: the scanner reads the capture's view.
	 */
	rfHz?: number
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
