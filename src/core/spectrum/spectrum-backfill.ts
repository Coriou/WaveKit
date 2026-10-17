/**
 * Waterfall backfill (WG1 req 1). The ring is per source entry; frame building is pure so the
 * bounds and the live-hold equality can be tested without a service.
 *
 * BlockSummary.bins is a fresh array per summary (pipeline.summary) and postMessage clones it
 * on the worker path. Nothing writes those arrays afterwards, so the ring keeps the reference.
 */
import type { SpectrumFrameEventData } from "@wavekit/api-types"
import type { EngineEpoch } from "./spectrum-engine.js"
import type { BlockSummary } from "./types.js"
import { BACKFILL_LIMITS } from "./subscribe-options.js"
import type { TuningTrust } from "./types.js"
import { averagingOf, type SpectrumProfile } from "./spectrum-averaging.js"
import {
	BIN_ENCODING,
	accumulateHold,
	averageTrusted,
	encodeBins,
	reduceMaxHold,
	summariesPerFrame,
	type SpectrumHold,
} from "./spectrum-service.js"

export interface SummaryStamp {
	summary: BlockSummary
	epoch: EngineEpoch
	atMs: number
}

export interface BackfillBuild {
	ring: readonly SummaryStamp[]
	now: number
	backfillMs: number
	stream: number
	epoch: number
	/** The summary the snapshot frame used, excluded so it is not replayed. */
	snapshot: BlockSummary | null
	profile: SpectrumProfile
	sourceId: string
	integrationMs: number
	sampleRateHz: number
	fftSize: number
}

/** `ceil(maxMs / integrationMs) + 1` summaries: a full window plus the snapshot summary. */
export function summaryRingCapacity(integrationMs: number): number {
	const ms =
		integrationMs > 0 && Number.isFinite(integrationMs) ? integrationMs : 50
	return Math.ceil(BACKFILL_LIMITS.maxMs / ms) + 1
}

/** Round and clamp to 0..maxMs. Absent stays 0 and is not an adjustment. */
export function normaliseBackfillMs(raw: number | undefined): {
	ms: number
	adjusted: boolean
} {
	if (raw === undefined) return { ms: 0, adjusted: false }
	const ms = Math.min(BACKFILL_LIMITS.maxMs, Math.max(0, Math.round(raw)))
	return { ms, adjusted: ms !== raw }
}

/**
 * Append one summary. A different stream or epoch than the previous entry clears the ring
 * first. Entries older than maxMs, then the oldest past capacity, are dropped.
 */
export function appendSummary(
	ring: SummaryStamp[],
	stamp: SummaryStamp,
	integrationMs: number,
	now: number,
): void {
	const prev = ring.at(-1)
	if (
		prev &&
		(prev.summary.stream !== stamp.summary.stream ||
			prev.summary.epoch !== stamp.summary.epoch)
	)
		ring.length = 0
	ring.push(stamp)
	const cutoff = now - BACKFILL_LIMITS.maxMs
	let drop = 0
	while (drop < ring.length && ring[drop]!.atMs < cutoff) drop++
	if (drop > 0) ring.splice(0, drop)
	const overflow = ring.length - summaryRingCapacity(integrationMs)
	if (overflow > 0) ring.splice(0, overflow)
}

export function spectrumFrameJsonLength(frame: SpectrumFrameEventData): number {
	return JSON.stringify({ type: "spectrum:frame", data: frame }).length
}

/** Newest `maxFrames`, then drop the oldest until the summed frame JSON fits in `maxBytes`. */
export function limitBackfillFrames(
	frames: readonly SpectrumFrameEventData[],
	maxFrames: number = BACKFILL_LIMITS.maxFrames,
	maxBytes: number = BACKFILL_LIMITS.maxBytes,
): SpectrumFrameEventData[] {
	const newest = frames.slice(-Math.max(0, maxFrames))
	const sizes = newest.map(frame => spectrumFrameJsonLength(frame))
	let total = sizes.reduce((sum, n) => sum + n, 0)
	let start = 0
	while (start < newest.length && total > maxBytes) {
		total -= sizes[start]!
		start++
	}
	return newest.slice(start)
}

interface BuiltRun {
	raw: Float32Array
	factor: number
	newest: SummaryStamp
	/** WG9 R3: the worst label of the run's summaries. */
	trust: TuningTrust
}

function holdRun(
	run: readonly SummaryStamp[],
	profile: SpectrumProfile,
): BuiltRun {
	let hold: SpectrumHold | undefined
	for (const stamp of run) {
		hold = accumulateHold(
			hold,
			reduceMaxHold(stamp.summary.bins, profile.bins),
			stamp.summary.epoch,
			stamp.summary.stream,
			stamp.epoch.tuningTrust,
		)
	}
	const newest = run[run.length - 1]!
	return {
		raw: hold?.bins ?? new Float32Array(),
		factor: hold?.factor ?? 1,
		newest,
		trust: hold?.trust ?? newest.epoch.tuningTrust,
	}
}

function frameFromRun(
	run: BuiltRun,
	profile: SpectrumProfile,
	sourceId: string,
	sampleRateHz: number,
	fftSize: number,
	bins: ArrayLike<number>,
	trust: TuningTrust,
	backfill: boolean,
): SpectrumFrameEventData {
	const summary = run.newest.summary
	return {
		sourceId,
		profile: profile.key,
		epoch: summary.epoch,
		tuningTrust: trust,
		centerHz: summary.centreHz,
		sampleRateHz: summary.sampleRateHz,
		binHz: summary.binHz * run.factor,
		nativeBinHz: sampleRateHz / fftSize,
		startHz: summary.startHz,
		binCount: bins.length,
		bins: encodeBins(bins),
		binEncoding: BIN_ENCODING,
		floorDbfs: summary.floorDbfs,
		thresholdDb: summary.thresholdDb,
		tracks: summary.tracks,
		masks: summary.masks,
		...(backfill ? { backfill: true as const } : {}),
		at: new Date(run.newest.atMs).toISOString(),
	}
}

function framesFromRuns(
	runs: readonly SummaryStamp[][],
	profile: SpectrumProfile,
	sourceId: string,
	sampleRateHz: number,
	fftSize: number,
	backfill: boolean,
): SpectrumFrameEventData[] {
	const built = runs.map(run => holdRun(run, profile))
	const n = averagingOf(profile)
	let avg: Float32Array | null = null
	let avgTrust: TuningTrust | undefined
	return built.map(run => {
		let bins = run.raw
		let trust = run.trust
		// WG9 R3: the live rule; an unverified average restarts at the first trusted run.
		if (n > 1) {
			const next = averageTrusted(avg, avgTrust, run.raw, run.trust, n)
			avg = bins = next.avg
			avgTrust = trust = next.trust
		}
		return frameFromRun(
			run,
			profile,
			sourceId,
			sampleRateHz,
			fftSize,
			bins,
			trust,
			backfill,
		)
	})
}

/**
 * Backfill at commit: in-window summaries of this stream and epoch, excluding the snapshot,
 * grouped from the newest end (a partial oldest run is dropped). Averaged on a fresh
 * averager, then capped at 64 frames and 512 KiB, oldest first.
 */
export function buildBackfillFrames(
	req: BackfillBuild,
): SpectrumFrameEventData[] {
	if (req.backfillMs <= 0) return []
	const cutoff = req.now - req.backfillMs
	const selected = req.ring.filter(
		stamp =>
			stamp.atMs >= cutoff &&
			stamp.summary.stream === req.stream &&
			stamp.summary.epoch === req.epoch &&
			stamp.summary !== req.snapshot,
	)
	const n = summariesPerFrame(1000 / req.integrationMs, req.profile.hz)
	const drop = selected.length % n
	const aligned = drop === 0 ? selected : selected.slice(drop)
	const runs: SummaryStamp[][] = []
	for (let i = 0; i < aligned.length; i += n) runs.push(aligned.slice(i, i + n))
	return limitBackfillFrames(
		framesFromRuns(
			runs,
			req.profile,
			req.sourceId,
			req.sampleRateHz,
			req.fftSize,
			true,
		),
	)
}
