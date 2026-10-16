/** Core spectrum service DTOs (waterfalls for the CLI/web and the scanner). */

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
	tracks: {
		startHz: number
		endHz: number
		flags: { burst: boolean; iqImage: boolean; edge: boolean }
	}[]
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

export interface SpectrumWarning {
	code: "untracked-retune" | "host-centre-mismatch"
	deltaHz: number | null
	at: string
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
	/** 128–2048, rounded to an integer; default `scanner.ws.spectrumBins`. */
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

export interface SpectrumLimits {
	maxProfiles: number
	hz: { min: number; max: number; step: number }
	bins: { min: number; max: number }
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
