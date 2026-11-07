import { createHash } from "node:crypto"
import { powerToDb } from "../../../../src/core/spectrum/fft.js"
import { Tracker } from "../../../../src/core/spectrum/emissions/tracker.js"
import type {
	PipelineEvent,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import type { Harness } from "./pipeline-harness.js"

/**
 * The part of a pipeline event stream the two linear-power changes could move, for the golden
 * tests next to this file. One went linear in the short path (the 5 ms burst detector and its
 * block peak, base c838f93d), the other in Tracker.frame (the 1 ms track envelope, base 64ebbe99).
 *
 * Kept, with what each one reads:
 * - every event's `kind`, in order: the sequence of the pipeline's decisions.
 * - track events: `trackId`, `startSample`, `lastSample`, `blocks` and `flags.burst`, and a close's
 *   `endReason`: when a track opens, stays on and closes. A short-path burst segment opens and
 *   feeds tracks, so these follow its decisions.
 * - track `peakDbfs`, `meanDbfs`, `snrDb`, `maxBlockSnrDb`: tracker values from the block power,
 *   which over a burst segment is the short path's block peak (the pipeline's merged power).
 * - track `dutyCycle`: read from the 1 ms envelope Tracker.frame builds.
 * - block summary `endSample` and each segment's `startHz`, `endHz` and `flags.burst`: the short
 *   path's burst segments and the long segments they replace.
 * - a transient's `sample` and `centreHz`: a burst too short to track.
 *
 * `acf30` and `acf60` also read the 1 ms envelope, but the dB path rounded it through a Float32 dB
 * value, so they are compared with a bound (`acfOf`), not hashed. Everything else is left out: it
 * reads neither path, or belongs to another feature and would tie these goldens to it. That is
 * the classifier's `blockSwingDb` and `blockSpreadDb` (block spectrum concentration), track
 * geometry (`centreHz`, `obwHz`, `obw6Hz`, `spectralShape`, which the tracker's line join also
 * sets), gate fields, stats, masks and the summary's `bins` (long-path power only).
 */
export function project(events: readonly PipelineEvent[]): unknown[] {
	return events.map(e => {
		switch (e.kind) {
			case "track-open":
			case "track-update":
				return { kind: e.kind, track: trackFields(e.track) }
			case "track-close":
				return {
					kind: e.kind,
					track: trackFields(e.track),
					endReason: e.endReason,
				}
			case "block-summary":
				return {
					kind: e.kind,
					endSample: e.summary.endSample,
					tracks: e.summary.tracks.map(s => ({
						startHz: s.startHz,
						endHz: s.endHz,
						burst: s.flags.burst,
					})),
				}
			case "transient":
				return { kind: e.kind, sample: e.sample, centreHz: e.centreHz }
			default:
				return { kind: e.kind }
		}
	})
}

function trackFields(t: TrackSnapshot): Record<string, unknown> {
	return {
		trackId: t.trackId,
		startSample: t.startSample,
		lastSample: t.lastSample,
		blocks: t.blocks,
		burst: t.flags.burst,
		peakDbfs: t.peakDbfs,
		meanDbfs: t.meanDbfs,
		snrDb: t.snrDb,
		maxBlockSnrDb: t.maxBlockSnrDb,
		dutyCycle: t.dutyCycle,
	}
}

export const projectionDigest = (events: readonly PipelineEvent[]): string =>
	createHash("sha256")
		.update(JSON.stringify(project(events)))
		.digest("hex")

/** Every `acf30` and `acf60` in stream order. */
export function acfOf(events: readonly PipelineEvent[]): number[] {
	const out: number[] = []
	for (const e of events) {
		if (
			e.kind !== "track-open" &&
			e.kind !== "track-update" &&
			e.kind !== "track-close"
		)
			continue
		if (e.track.acf30 !== undefined) out.push(e.track.acf30)
		if (e.track.acf60 !== undefined) out.push(e.track.acf60)
	}
	return out
}

/** Changes a frame's Float32 dB values in place: the deliberate fault of a mutation check. */
export type DbFault = (db: Float32Array) => void

/**
 * Runs `body` with Tracker.frame fed through the per-frame dB conversion it replaced:
 * `powerToDb(frame, 1)` into Float32, then each bin back to 10^(dB/10). The dB path summed exactly
 * that, and `powerToDb` clamps at -200 dB, the linear path's floor, so with no `fault` this is the
 * dB path bit for bit.
 */
export function withDbFrame<T>(body: () => T, fault?: DbFault): T {
	const linear = Object.getOwnPropertyDescriptor(Tracker.prototype, "frame")
	if (!linear || typeof linear.value !== "function")
		throw new TypeError("Tracker.frame is not a method")
	const frame = linear.value as Tracker["frame"]
	let db = new Float32Array(0)
	let lin = new Float64Array(0)
	function dbFrame(
		this: Tracker,
		framePower: Float64Array,
		_scale: number,
		sample: number,
	): void {
		if (db.length !== framePower.length) {
			db = new Float32Array(framePower.length)
			lin = new Float64Array(framePower.length)
		}
		powerToDb(framePower, 1, db)
		fault?.(db)
		for (let i = 0; i < db.length; i++) lin[i] = 10 ** (db[i]! / 10)
		frame.call(this, lin, 1, sample)
	}
	Object.defineProperty(Tracker.prototype, "frame", {
		...linear,
		value: dbFrame,
	})
	try {
		return body()
	} finally {
		Object.defineProperty(Tracker.prototype, "frame", linear)
	}
}

/** The short path's private state the dB reference reaches; names as in pipeline.ts. */
interface ShortPath {
	shortOnLo: Float64Array
	shortOnHi: Float64Array
	shortOffLo: Float64Array
	shortOffHi: Float64Array
	setShortThresholds: () => void
	shortOnInDb: (d: unknown, i: number, a: number, was: boolean) => boolean
}

/**
 * Makes `h`'s short path decide every bin in dB, as Detector.detect did on `powerToDb`'s Float32
 * values: the brackets read nothing (lo = -∞, hi = +∞, which dbThresholdBracket itself returns
 * for a threshold it cannot bracket), so each comparison falls to `shortOnInDb`. `onDb` replaces
 * that comparison, for a mutation check. Call before pushing samples.
 */
export function shortInDb(
	h: Harness,
	onDb?: (exact: ShortPath["shortOnInDb"]) => ShortPath["shortOnInDb"],
): void {
	const p = h.pipeline as unknown as ShortPath
	for (const key of [
		"shortOnLo",
		"shortOnHi",
		"shortOffLo",
		"shortOffHi",
		"setShortThresholds",
		"shortOnInDb",
	] as const) {
		if (!(key in p)) throw new TypeError(`SpectrumPipeline has no ${key}`)
	}
	p.setShortThresholds = () => {
		p.shortOnLo.fill(Number.NEGATIVE_INFINITY)
		p.shortOffLo.fill(Number.NEGATIVE_INFINITY)
		p.shortOnHi.fill(Number.POSITIVE_INFINITY)
		p.shortOffHi.fill(Number.POSITIVE_INFINITY)
	}
	if (onDb) p.shortOnInDb = onDb(p.shortOnInDb.bind(p))
}
