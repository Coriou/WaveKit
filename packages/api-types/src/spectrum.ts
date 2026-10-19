/** Core spectrum service DTOs (waterfalls for the CLI/web and the scanner). */

import type { ScannerConfidence, ScannerProtocol } from "./scanner.js"

export type SpectrumBinEncoding = "u8-halfdb-127.5"

export interface SpectrumFrameEventData {
	sourceId: string
	/** `${hz}:${bins}`: the default profile (scanner.ws) or a client's (options.spectrum). */
	profile: string
	epoch: number
	tuningTrust: "commanded" | "relay" | "unverified"
	centerHz: number
	sampleRateHz: number
	binHz: number
	/** fs / fftSize; `binHz / nativeBinHz` is the total max-hold factor. */
	nativeBinHz: number
	startHz: number
	binCount: number
	/** base64 Uint8Array; value v → dBFS = v / 2 − 127.5 (max-hold over the frame interval). */
	bins: string
	binEncoding: SpectrumBinEncoding
	floorDbfs: number
	thresholdDb: number
	tracks: SpectrumFrameTrack[]
	/** DC spike at the tuned centre ± guard; baseband spurs as RF ranges (§ 4.9). */
	masks: {
		dcHz: number
		dcGuardHz: number
		spurRanges: { startHz: number; endHz: number }[]
	}
	/** Current-state frame sent right after a `spectrum:profile` ack (not a replay). */
	snapshot?: true
	/**
	 * Waterfall backfill (WG1): a recent frame replayed after a `spectrum:profile` ack, before the
	 * snapshot and live frames, when the client asked for `backfillMs`. Oldest first; `at` is the
	 * time of the frame's newest block summary. Never set together with `snapshot`.
	 */
	backfill?: true
	at: string
}

/**
 * One segment of the frame's block (RF). WG11 req 5.1: a segment the tracker associated with an
 * open track also carries that track's stable id and its stats from the same block; a segment
 * without a track carries none of the optional fields. Key tracks by (sourceId, trackId).
 */
export interface SpectrumFrameTrack {
	startHz: number
	endHz: number
	/** WG11: `spur` = the track lies wholly on a spur line (never surfaced, never probed). */
	flags: { burst: boolean; iqImage: boolean; edge: boolean; spur?: boolean }
	/**
	 * The tracker's id without its `<sourceId>-` prefix (at most 30 characters), so it is unique
	 * only per source: key tracks by (sourceId, trackId). The full tracker id, as
	 * `ScanJobProbe.trackId` carries it, is `${sourceId}-${trackId}`. Stable for the emission's
	 * life (burst gaps within the hang included) and across the tracker's 120 s max-duration
	 * rollover, which keeps the chain's first id; a new epoch gives a new id. Never reused.
	 */
	trackId?: string
	/**
	 * Lifetime mean over the track's chain so far (mean band power over mean floor power, against
	 * the core's floor), rounded to 0.5 dB; not this block's instantaneous value.
	 */
	snrDb?: number
	/** Lifetime maximum block peak over the track's chain so far, rounded to 0.5 dB. */
	peakDbfs?: number
	/** Integration blocks the track's chain was on so far; saturates at 9 999 999. */
	blocks?: number
	/**
	 * Since the track's chain started, from sample counts; keeps growing across the 120 s
	 * rollover and saturates at 99 999 999 ms. First seen ≈ `at` − ageMs.
	 */
	ageMs?: number
	/**
	 * The display surfacing rule evaluated for this frame's block: false for a spur or an image,
	 * or while the segment is flagged iqImage in this block (not sticky across frames); a burst at
	 * threshold + 3 dB, else at least minSurfaceBlocks blocks. Survives the max-duration rollover.
	 */
	surfaced?: boolean
	/**
	 * The scanner's discovery for this track, when it holds a live observation of it on the same
	 * source. Absent for about 1 s after a rollover, until the new observation has its discovery.
	 */
	scanner?: SpectrumFrameTrackScanner
	/**
	 * WG12: channel-gate state for this frame. Absent on engines without a channel plan
	 * and on cores before the redesign. `below` is not sent.
	 */
	gate?: "pending" | "passed"
	/** WG12: SNR over the channel slot, not the per-bin `snrDb`. */
	channelSnrDb?: number
}
/** WG11 req 5.1: the scanner's identity of a frame track. */
export interface SpectrumFrameTrackScanner {
	discoveryId: string
	protocol: ScannerProtocol
	confidence: ScannerConfidence
}
/**
 * WG11 req 5.5: JSON bytes a frame track may grow by with every optional field present (measured
 * typical growth: about 105 B per track without `scanner`, 217 B with it).
 */
export const SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES = 260
/**
 * WG12: JSON bytes `gate` plus `channelSnrDb` may add to one frame track
 * (`"gate":"passed"` 15, `"channelSnrDb":12.5` 20, separators).
 */
export const SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES = 40

/** WG10 req 2.9: what an untracked-retune warning most likely means. */
export type SpectrumWarningSuspect =
	| "iq-byte-slip"
	| "signal-change"
	| "external-control"
/** WG10 req 2.9: one warn log line per source per this interval (the warning list keeps all). */
export const SPECTRUM_WARNING_LOG_INTERVAL_MS = 60_000

export interface SpectrumWarning {
	code: "untracked-retune" | "host-centre-mismatch"
	deltaHz: number | null
	at: string
	/** WG10 req 2.9: untracked-retune only; absent on host-centre-mismatch. */
	suspected?: SpectrumWarningSuspect
	/** WG10 req 2.9: ms since this core's last tuner command on the source; null when none. */
	lastCommandAgeMs?: number | null
}

export interface SpectrumSourceStatus {
	sourceId: string
	eligible: boolean
	reason?: "source-not-iq" | "source-removed"
	engine: "running" | "idle" | "error"
	consumers: number
	rbwHz: number | null
	fftSize: number | null
	floorDbfs: number | null
	floorOccupied: boolean
	kByRange: {
		startHz: number
		endHz: number
		k: number
		faPerMhzMin: number
	}[]
	settleMode: "marker" | "timer" | "none" | null
	tuningTrust: "commanded" | "relay" | "unverified" | null
	warnings: SpectrumWarning[]
	/** Bins and bin width of the latest block summary (the engine summary budget). */
	summaryBinCount: number | null
	summaryBinHz: number | null
	/** Block summaries per second (1000 / integrationMs). */
	summaryHz: number | null
	/** The latest block summary at the default profile. */
	latestFrame: SpectrumFrameEventData | null
	lastError?: string
}

/** `options.spectrum` of a WS `subscribe` that includes "spectrum". Omitted options = the default selection. */
export interface SpectrumSubscribeOptions {
	sourceId: string
	/** 0.5–25, snapped to 0.5 Hz; default `scanner.ws.spectrumHz`. */
	hz?: number
	/**
	 * 128 to SpectrumLimits.bins.max (2048 unless the host cap and summary budget allow more,
	 * WG8), rounded to an integer; default `scanner.ws.spectrumBins`.
	 */
	bins?: number
	/**
	 * Per-client averaging (WG1): exponential average over this many frames of the profile, in the dBFS
	 * domain, after the max-hold of each frame. Integer 1–32, rounded and clamped; 1 (default) = off.
	 * Part of the profile: clients with the same hz, bins and averaging share frames.
	 */
	averaging?: number
	/**
	 * Waterfall backfill (WG1): replay up to this many ms of recent frames (0–10000, default 0 = none)
	 * after the ack. Bounded by the current epoch and by SpectrumLimits.backfill.
	 */
	backfillMs?: number
}

export interface SpectrumProfileView {
	/** `${hz}:${bins}` with averaging off; `${hz}:${bins}:a${averaging}` with averaging > 1 (WG1). */
	key: string
	hz: number
	bins: number
	/** Frames averaged (WG1); present only when > 1. */
	averaging?: number
}

/** `averaging` and `backfillMs` (WG1): the requested value was rounded or clamped. */
export type SpectrumProfileAdjustment =
	| "hz"
	| "bins"
	| "profile-limit"
	| "averaging"
	| "backfillMs"

export type SpectrumSubscribeErrorCode =
	| "SPECTRUM_OPTIONS_INVALID"
	| "SPECTRUM_SOURCE_NOT_FOUND"
	| "SPECTRUM_SOURCE_NOT_IQ"
	| "SPECTRUM_SOURCE_REMOVED"
	| "SPECTRUM_ENGINE_ERROR"

/**
 * `spectrum:profile`, sent to one client only: its selection after a subscribe (ack), after a permanent source removal
 * (notice), or after a default PATCH remapped it (notice). Each resets the client's waterfalls, except that an
 * `outcome: "removed"` notice with `selection: "default"` drops only `removedSourceId`'s waterfall.
 */
export interface SpectrumProfileEventData {
	/** none: no frames; default: the default profile on every eligible source; source: one source. */
	selection: "none" | "default" | "source"
	sourceId: string | null
	/** Profile served (the current default for "default"); null with selection "none". */
	profile: SpectrumProfileView | null
	/** blockHz / summariesPerFrame of `profile` on `sourceId` (null before the engine has a config, or for "default"). */
	effectiveHz: number | null
	/**
	 * exact: as requested; nearest: see `adjusted`; default: no options; rejected: the request failed and the previous
	 * selection is kept; removed: notice that `removedSourceId` was permanently removed.
	 */
	outcome: "default" | "exact" | "nearest" | "rejected" | "removed"
	adjusted: SpectrumProfileAdjustment[]
	removedSourceId?: string
	code?: SpectrumSubscribeErrorCode
	message?: string
	/**
	 * Backfill frames that follow this ack (WG1). Present on a committed `source` ack whose request had
	 * `backfillMs` > 0 (0 when nothing of the current epoch is buffered); absent otherwise.
	 */
	backfillFrames?: number
}

export interface SpectrumActiveProfile extends SpectrumProfileView {
	sourceId: string
	isDefault: boolean
	clients: number
	/** From the latest summary (null before one). */
	binCount: number | null
	binHz: number | null
	summariesPerFrame: number | null
	/** blockHz / summariesPerFrame: the delivered cadence while summaries flow; an upper bound across pauses. */
	effectiveHz: number | null
}

/**
 * WG8 (docs/specs/web-gaps-8, requirement 5): `scanner.ws.spectrumBinsCap`. "auto" (also when
 * the key is absent) measures the host once at startup; a number fixes the cap.
 */
export type SpectrumBinsCapSetting = "auto" | 2048 | 4096 | 8192
export const SPECTRUM_BINS_CAP_SETTINGS: readonly SpectrumBinsCapSetting[] =
	Object.freeze(["auto", 2048, 4096, 8192])
/** WG8 req 5.2: the caps "auto" may pick, ascending; the first is the floor (never measured). */
export const SPECTRUM_BINS_CAP_CHOICES: readonly (2048 | 4096 | 8192)[] =
	Object.freeze([2048, 4096, 8192])
export const SPECTRUM_BINS_CAP_FLOOR = 2048
export const SPECTRUM_BINS_CAP_CEILING = 8192
/** WG8 req 5.3: upper bound of `scanner.ws.spectrumSummaryBins` once the worker carries it. */
export const SPECTRUM_SUMMARY_BINS_MAX = 8192
/**
 * WG8 req 5.2: host budgets of one source's summary stream at a candidate cap. The measured
 * cost times `margin` must fit every budget; `benchWallMs` bounds the whole startup bench.
 */
export const SPECTRUM_BINS_BUDGET = Object.freeze({
	summaryBytesPerSecond: 512 * 1024,
	cloneMsPerSecond: 10,
	profileMsPerSecond: 5,
	margin: 1.5,
	benchWallMs: 200,
})
/** WG8 req 5.4: how the bins cap was chosen. */
export interface SpectrumBinsCapView {
	setting: SpectrumBinsCapSetting
	cap: number
	/** config: a fixed setting; measured: the startup bench; fallback: the bench failed (floor). */
	source: "config" | "measured" | "fallback"
}

export interface SpectrumLimits {
	maxProfiles: number
	hz: { min: number; max: number; step: number }
	/** WG8: max = min(bins cap, ws.spectrumSummaryBins) (2048 with the default summary budget). */
	bins: { min: number; max: number }
	/** WG8 req 5.4: the bins cap behind `bins.max`. Sent by WG8 cores. */
	binsCap?: SpectrumBinsCapView
	/** Frames of `averaging` (WG1); 1 = off. */
	averaging: { min: number; max: number }
	/** Backfill bounds per subscribe (WG1): window, frames and serialized frame bytes. */
	backfill: { maxMs: number; maxFrames: number; maxBytes: number }
}

export interface SpectrumStatus {
	defaultProfile: SpectrumProfileView
	profiles: SpectrumActiveProfile[]
	limits: SpectrumLimits
	/** Clients with a current selection. */
	subscribers: number
	sources: SpectrumSourceStatus[]
}

export interface SpectrumOccupancyResponse {
	sourceId: string
	bucketHz: number
	sinceMs: number
	buckets: {
		startHz: number
		dutyByHour: (number | null)[]
		observedMs: number
		activeMs: number
	}[]
	top: { startHz: number; duty: number; observedMs: number; activeMs: number }[]
}
