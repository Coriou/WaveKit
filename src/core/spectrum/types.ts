/**
 * Spectrum and activity layer types (spec § 3 `spectrum/types.ts`, § 4): IQ
 * formats, tuning epochs, tracks, block summaries, pipeline I/O, engine state
 * and the settings the layer reads. The scanner (src/core/scanner/) imports
 * these; nothing here imports from the scanner. Type-only file.
 *
 * Conventions: frequencies in Hz, powers in dBFS (10·log10 of mean |z|² with
 * full scale |z| = 1), sample indices are absolute per source stream (§ 4.1).
 */
import type { z } from "zod"
import type { SpectrumWarningSuspect } from "@wavekit/api-types"

export type TuningTrust = "commanded" | "relay" | "unverified"
export type SettleMode = "marker" | "timer" | "none"
export type IqFormat = "U8_IQ" | "S16_IQ" | "FLOAT32LE"

export interface FreqRange {
	startHz: number
	endHz: number
}

/**
 * SF1: a CFAR range of the detector masks. `faTargetPerMhzMin` overrides the pipeline's
 * false-alarm target for this range only (per-range sensitivity); absent = the pipeline's.
 */
export interface CfarMaskRange extends FreqRange {
	faTargetPerMhzMin?: number
}

/** A channel raster (§ 5.1): channels at firstChannelHz + n·spacingHz. */
export interface Raster {
	spacingHz: number
	firstChannelHz: number
}

/**
 * A mask raster that may name the range it applies to. Absent bounds: the whole tuned
 * window (the pre-amendment 10 behaviour).
 */
export interface MaskRaster extends Raster {
	startHz?: number
	endHz?: number
}

// ---------------------------------------------------------------- spectrum pipeline (§ 4)

export interface PendingEpoch {
	epoch: number
	/** Absolute sample index received when the command was written. */
	commandSample: number
	/** Samples already held in the core at that moment. */
	bufferedSamples: number
	/** Timer-mode upstream allowance. */
	settleSamples: number
	expectMarker: boolean
	markerTimeoutSamples: number
	pllSettleSamples: number
	centreHz: number
	sampleRateHz: number
	/** e.g. "m:496" (manual 49.6 dB) or "agc". */
	gainKey: string
	tuningTrust: TuningTrust
	centreChanged: boolean
	/**
	 * WG9 req 3.4: stale-content discard cap for a non-scanner retune (ms). Absent = the
	 * pipeline's own cap (the scanner's epochs never set it).
	 */
	staleMaxMs?: number
	/**
	 * WG9 req 3.4: first sample past a non-scanner retune's network settle. Tracks that start
	 * before it are `unverified`. Absent = no unverified window (the scanner's epochs never set it).
	 */
	verifiedFromSample?: number
}

export interface TrackFlags {
	overload: boolean
	gap: boolean
	truncated: boolean
	edge: boolean
	skirt: boolean
	obwBiased: boolean
	/** Every block the track was on was a short-path burst block (spec § 4.10); surfaces at k_short + 3 dB or by repetition. */
	burst: boolean
	/** Mirror image of a stronger track at the opposite baseband offset (spec § 4.9): never surfaces, never probed. */
	iqImage: boolean
	/** Sticky: the track lies wholly on a spur line (baseband, provisional or comb; § 4.9, Task 7a). Never surfaced, never probed. */
	spur: boolean
}

export interface TrackSnapshot {
	trackId: string
	sourceId: string
	stream: number
	epoch: number
	startSample: number
	lastSample: number
	/** RF, power-weighted centroid. */
	centreHz: number
	obwHz: number
	obwMethod: "-20dB" | "on-bins"
	peakDbfs: number
	meanDbfs: number
	snrDb: number
	floorDbfs: number
	thresholdDb: number
	/** Integration blocks the track was on. */
	blocks: number
	/** Best per-bin SNR in any block. */
	maxBlockSnrDb: number
	dutyCycle: number
	acf30?: number
	acf60?: number
	spectralShape: "flat" | "peaked" | "narrow"
	flags: TrackFlags
	tuningTrust: TuningTrust
	/**
	 * WG12 channel gate (`ChannelGateState` in scanner-redesign-contract.ts). Absent on
	 * engines without a channel plan.
	 */
	gate?: "pending" | "passed" | "below"
	/** WG12: SNR summed over the covering channel slots. */
	channelSnrDb?: number
	/**
	 * SNR of the best single covering slot, present only when it differs from
	 * `channelSnrDb` (a track wider than one slot). Admission reads the higher of the two.
	 */
	peakChannelSnrDb?: number
	/**
	 * Mean over the track's blocks of its segment power above the local floor (median
	 * of the neighbouring bins), dB. Absent without neighbours or without a channel plan.
	 */
	localSnrDb?: number
	/** WG12: engine sample when the gate first passed. */
	gatePassedSample?: number
}

export interface BlockSummary {
	sourceId: string
	stream: number
	epoch: number
	endSample: number
	centreHz: number
	sampleRateHz: number
	/** Of the decimated feed bins. */
	binHz: number
	startHz: number
	/** ≤ PipelineConfig.spectrumBins (the engine summary budget), dBFS max-hold, rounded to 0.5. */
	bins: number[]
	floorDbfs: number
	thresholdDb: number
	/** Segments of this block (RF), with flags for waterfall overlays (§ 12.2). */
	tracks: BlockTrack[]
	/** Masked regions (§ 4.9): DC at the tuned centre ± guard, baseband spurs as RF ranges. */
	masks: { dcHz: number; dcGuardHz: number; spurRanges: FreqRange[] }
	floorOccupied: boolean
	overload: boolean
}

export interface BlockTrack {
	startHz: number
	endHz: number
	/** burst: short-path burst segment (Task 10a); iqImage: mirror image (Task 11a); edge: touches the usable span in-window. */
	flags: { burst: boolean; iqImage: boolean; edge: boolean; spur?: boolean }
	/**
	 * WG11 req 5.1 (frame-tracks.ts): set only when the tracker associated this segment with an
	 * open track in this same block; then also `flags.spur`. Absent on an untracked segment.
	 */
	trackId?: string
	/** The track's SNR against the core's floor, 0.5 dB grid. */
	snrDb?: number
	/** The track's peak, 0.5 dB grid. */
	peakDbfs?: number
	/** On-blocks so far. */
	blocks?: number
	/** (lastSample − startSample) / fs, ms. */
	ageMs?: number
	/** Display surfacing rule (req 5.1). */
	surfaced?: boolean
	/**
	 * Host-internal, never on a frame: the chain's current tracker id without the source prefix,
	 * set only after a max-duration rollover (then it differs from `trackId`, the chain id). The
	 * spectrum service keys the scanner identity lookup on it and strips it from every frame.
	 */
	trackerId?: string
	/**
	 * WG12 channel gate on a block segment that can ride a frame. Frames carry only
	 * `"pending" | "passed"`; `"below"` stays on `TrackSnapshot`. Absent without a channel plan.
	 */
	gate?: "pending" | "passed"
	/** WG12: SNR summed over the covering channel slots. */
	channelSnrDb?: number
}

export interface PipelineStats {
	sourceId: string
	floorDbfs: number
	absoluteFloorDbfs: number | null
	kByRange: { range: FreqRange; k: number; faPerMhzMin: number }[]
	overloadedBlocks: number
	gapSamples: number
	staleAfterSettle: number
	stuckTestMode: boolean
	settledSamples: number
	observedSamples: number
	/** Frames blanked as broadband impulses since the pipeline started (§ 4.9, Task 7a). */
	blankedFrames: number
	/** Periodic broadband RFI (`broadband-rfi`, § 4.9): its period while active, else null. */
	broadbandRfi: { periodMs: number } | null
}

// Single-line variants: prettier would align them with spaces after tabs (no-mixed-spaces-and-tabs).
// prettier-ignore
export type PipelineInput =
	| { kind: "bytes"; startSample: number; bytes: Uint8Array }
	| { kind: "gap"; startSample: number; samples: number }
	| { kind: "pending-epoch"; pending: PendingEpoch }
	| { kind: "new-stream"; stream: number; centreHz: number; sampleRateHz: number; gainKey: string; tuningTrust: TuningTrust }
	/** inWindow: true while no sweep lease holds the source; truncated segments then report as `edge` (§ 6.2). */
	| { kind: "masks"; exclusions: FreqRange[]; cfarRanges: CfarMaskRange[]; burstRanges: FreqRange[]; rasters: MaskRaster[]; obwHz: number[]; inWindow: boolean }
	| { kind: "spectrum-feed"; enabled: boolean }

export type ObservationEndReason =
	| "quiet"
	| "retune"
	| "hop"
	| "job-end"
	| "max-duration"
	| "gap"

/** Spec § 4.7: the scene moved without an observed command (WG10 req 2.9 fields optional). */
export interface UntrackedRetuneEvent {
	kind: "untracked-retune"
	epoch: number
	startSample: number
	deltaHz: number | null
	/** WG10 req 2.9: the alarm's classification (absent: `external-control`). */
	suspected?: SpectrumWarningSuspect
	/**
	 * WG10 req 2.9: `false` for `signal-change` (no new epoch: the current epoch keeps its
	 * label and `epoch` is the current one). Absent: a new unverified epoch started.
	 */
	newEpoch?: false
}

// prettier-ignore
export type PipelineEvent =
	| { kind: "epoch-started"; epoch: number; startSample: number; settleMode: SettleMode; markerRunSamples?: number }
	| { kind: "stale-discard"; epoch: number; blocks: number }
	| { kind: "track-open"; track: TrackSnapshot }
	| { kind: "track-update"; track: TrackSnapshot }
	| { kind: "track-close"; track: TrackSnapshot; endReason: ObservationEndReason }
	| { kind: "transient"; centreHz: number; epoch: number; sample: number }
	| { kind: "block-summary"; summary: BlockSummary }
	| { kind: "stats"; stats: PipelineStats }
	/** Spec § 4.7: the scene moved without an observed command; a new unverified epoch starts at startSample. */
	| UntrackedRetuneEvent

export interface PipelineConfig {
	sourceId: string
	format: IqFormat
	sampleRateHz: number
	fftSize: number
	integrationMs: number
	usableFraction: number
	dcGuardHz: number
	ppmMargin: number
	hysteresisDb: number
	clipFraction: number
	minSurfaceBlocks: number
	/** Pinned k, or null for table + CFAR. */
	thresholdDb: number | null
	faTargetPerMhzMin: number
	/** Summary budget (ws.spectrumSummaryBins), never a client's bins. */
	spectrumBins: number
	/** 500 */
	trackHangMs: number
	/** 512 */
	maxTracks: number
	/** 120000 → endReason max-duration */
	maxTrackMs: number
	/** Short-burst path integration (spec § 4.10); default 5, null disables the path. */
	shortIntegrationMs?: number | null
	/** FFT frame overlap; 0.5 doubles FFT cost (spec § 4.2). Default 0, the measured setting. */
	overlap?: 0 | 0.5
	persistedEngine?: EngineState
}

/** Persisted per source (§ 8). */
export interface EngineState {
	version: 1
	/** key `${fs}:${gainKey}:${fftSize}` */
	absoluteFloors: { key: string; dbfs: number }[]
	spurs: {
		key: string
		basebandBin: number
		widthBins: number
		kind: "baseband" | "rf"
		rfHz?: number
	}[]
	kByRange: { startHz: number; endHz: number; k: number }[]
	/** Fast-path spur lines per key, core bins (§ 4.9, Task 7a). Optional: files written before Task 7a still load. */
	provisionalSpurs?: {
		key: string
		basebandBin: number
		widthBins: number
		comb: boolean
	}[]
}

// ---------------------------------------------------------------- settings read by the layer (§ 12.3)

/** `scanner.detection` (§ 12.3); the scanner's ScannerSettings.detection is this type. */
export interface DetectionSettings {
	fftSize: number | "auto"
	integrationMs: number
	sensitivity: "low" | "normal" | "high"
	faTargetPerMhzMin: number
	dcGuardHz: number
	ppmMargin: number
	clipFraction: number
	hysteresisDb: number
	minSurfaceBlocks: number
	/** Short-burst path integration (§ 4.10); null disables the path. Default 5. */
	shortIntegrationMs: number | null
	/** FFT frame overlap (§ 4.2); 0.5 doubles the FFT cost. Default 0. */
	overlap: 0 | 0.5
}

/**
 * What the spectrum layer reads from settings (engine, service, feed). The
 * scanner's ScannerSettings is structurally a superset, so `() => ScannerSettings`
 * is passed where `() => SpectrumSettings` is expected.
 */
export interface SpectrumSettings {
	ringSeconds: number
	detection: DetectionSettings
	sweep: { settleMs: { local: number; network: number } }
	ws: {
		spectrumHz: number
		spectrumBins: number
		spectrumSummaryBins: number
		spectrumMaxProfiles: number
	}
}

// ---------------------------------------------------------------- schema drift checks (persisted records)

type SameKeys<A, B> = [
	Exclude<keyof A, keyof B>,
	Exclude<keyof B, keyof A>,
] extends [never, never]
	? true
	: false
/** True when every T is a valid schema output and both have the same top-level keys. */
export type SchemaMatches<T, S extends z.ZodTypeAny> =
	T extends z.output<S> ? SameKeys<T, z.output<S>> : false
export type Assert<T extends true> = T
