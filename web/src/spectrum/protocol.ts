/**
 * Messages between the main thread (SpectrumEngine) and the spectrum worker.
 * Bins never cross to the main thread in the OffscreenCanvas path; in the fallback path the worker
 * posts decoded rows as transferable buffers and the main thread hands them back for reuse.
 */

export interface SpectrumSubscription {
	sourceId: string
	/** Frames per second asked of the core (0.5–25). */
	hz?: number
	/** Bins asked of the core (128–2048). */
	bins?: number
	/** Waterfall backfill to replay after the ack, ms (0–10000). */
	backfillMs?: number
}

/** Visible frequency span; null shows the whole capture. */
export interface SpectrumViewSpan {
	startHz: number
	endHz: number
}

export interface SpectrumLevels {
	minDb: number
	maxDb: number
}

export interface SpectrumLayout {
	/** Share of the height given to the spectrum trace (0–1); the waterfall takes the rest. */
	splitRatio: number
	/** Empty band between the trace and the waterfall, CSS px (room for DOM axes). */
	gapCss: number
	/** CSS px per waterfall row. */
	rowHeightCss: number
	/** Draw the peak-hold trace. */
	peakHold: boolean
	/** Peak-hold decay, dB per second (0 holds forever). */
	peakDecayDbPerSec: number
}

export interface SpectrumSize {
	widthCss: number
	heightCss: number
	dpr: number
}

export type TuningTrust = "commanded" | "relay" | "unverified"

/** Axis and summary of the latest frame, for DOM overlays (posted at most ~10 times per second). */
export interface SpectrumFrameMeta {
	sourceId: string
	centerHz: number
	startHz: number
	binHz: number
	binCount: number
	sampleRateHz: number
	floorDbfs: number
	thresholdDb: number
	tracks: {
		startHz: number
		endHz: number
		flags: { burst: boolean; iqImage: boolean; edge: boolean }
		/** Peak dBFS over the track in the newest row (web-side, rounded to 3 dB); null when unknown. */
		peakDb?: number | null
	}[]
	tuningTrust: TuningTrust
	epoch: number
	at: string
}

/** Axis a waterfall row belongs to; history never mixes rows of two axes. */
export interface RowAxis {
	sourceId: string
	epoch: number
	profile: string
	binHz: number
	startHz: number
	binCount: number
}

export interface InitMessage {
	type: "init"
	wsUrl: string
	/** Present in the OffscreenCanvas path: the worker renders. Absent: the worker posts rows. */
	canvas?: OffscreenCanvas
	size: SpectrumSize
	layout: SpectrumLayout
	levels: SpectrumLevels
	ramp: Uint8Array
	historyRows: number
}

export type MainToWorker =
	| InitMessage
	| { type: "subscribe"; subscription: SpectrumSubscription | null }
	| { type: "view"; view: SpectrumViewSpan | null }
	| { type: "levels"; levels: SpectrumLevels }
	| { type: "ramp"; ramp: Uint8Array }
	| { type: "layout"; layout: SpectrumLayout }
	| { type: "resize"; size: SpectrumSize }
	/** Fallback path: a row buffer the main thread has uploaded, back for reuse. */
	| { type: "recycle"; buffer: ArrayBuffer }
	/** The newest row's level over [startHz, endHz] (the hover readout); answered with a `probe`. */
	| { type: "probe"; id: number; startHz: number; endHz: number }
	| { type: "dispose" }

export type WorkerToMain =
	| { type: "meta"; meta: SpectrumFrameMeta }
	/** History was cleared (new profile, source or frequency axis). */
	| { type: "reset"; reason: ResetReason }
	/** Fallback path only: one decoded row (byte v ↔ v / 2 − 127.5 dBFS), `binCount` bytes used. */
	| { type: "row"; axis: RowAxis; buffer: ArrayBuffer; binCount: number }
	| { type: "connection"; state: "connecting" | "open" | "closed" }
	| { type: "profile"; outcome: string; code?: string; message?: string }
	| { type: "error"; message: string }
	/** Answer to a probe: the peak dBFS there, null when no row covers it. */
	| { type: "probe"; id: number; db: number | null }

export type ResetReason = "profile" | "subscription" | "source" | "axis"

export const DEFAULT_LAYOUT: SpectrumLayout = {
	splitRatio: 0.3,
	gapCss: 0,
	rowHeightCss: 1,
	// The design always draws the faint peak trace; ~3 dB/s is its 0.12 dB per row at 24 rows/s.
	peakHold: true,
	peakDecayDbPerSec: 3,
}

export const DEFAULT_LEVELS: SpectrumLevels = { minDb: -120, maxDb: -20 }

/** Waterfall rows kept (texture height). */
export const DEFAULT_HISTORY_ROWS = 1024

/** Widest row the core sends (`bins` ≤ 2048); the waterfall texture width. */
export const MAX_BINS = 2048
