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
}

export interface SpectrumProfileView {
	key: string
	hz: number
	bins: number
}

export type SpectrumProfileAdjustment = "hz" | "bins" | "profile-limit"

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
