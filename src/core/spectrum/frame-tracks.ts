/**
 * WG11 req 5.1-5.5 (lane TR): stable tracks on spectrum frames. Pure helpers: the 0.5 dB
 * rounding, the display surfacing rule, the copy of the tracker's own association state into
 * a block track, the bounded host-side check of those fields after the worker boundary, and
 * the shape check of a scanner identity. No I/O, no clock.
 *
 * Size bound (req 5.5, `SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES` = 260): with every field at its
 * longest accepted value the JSON growth of one track is
 *   `,"spur":false` 13 + `,"trackId":""` 13 + 30 id + `,"snrDb":-999.5` 15
 *   + `,"peakDbfs":-999.5` 18 + `,"blocks":9999999` 17 + `,"ageMs":99999999` 17
 *   + `,"surfaced":false` 17 + `,"scanner":{"discoveryId":"","protocol":"digital-unknown",`
 *   `"confidence":"classified"}` 84 + 36 id = 260 bytes (ids are ASCII by the charset below).
 */
import {
	BANDPLAN_SCANNER_PROTOCOLS,
	type ScannerConfidence,
	type SpectrumFrameTrackScanner,
} from "@wavekit/api-types"
import type { BlockTrack } from "./types.js"

/** Longest frame `trackId` (tracker ids are `<sourceId>-<base36 ms>-<base36 seq>`, ≤ 30 for a sourceId of ≤ 16). */
export const FRAME_TRACK_ID_MAX_CHARS = 30
/** Longest scanner `discoveryId` on a frame (store ids are `d_` + a 26-char ULID; a UUID fits too). */
export const FRAME_TRACK_DISCOVERY_ID_MAX_CHARS = 36
/** `blocks` bound: ≤ 7 digits (a track closes at maxTrackMs = 120 s, ≤ 24 000 blocks at 5 ms). */
export const FRAME_TRACK_BLOCKS_MAX = 9_999_999
/** `ageMs` bound: ≤ 8 digits (≈ 27.8 h; a track closes at maxTrackMs = 120 s). */
export const FRAME_TRACK_AGE_MS_MAX = 99_999_999
/** `snrDb` / `peakDbfs` bound: |x| ≤ 999.5, so at most 6 characters on the 0.5 dB grid. */
export const FRAME_TRACK_DB_ABS_MAX = 999.5
/** A burst track surfaces at the block threshold + 3 dB (spec § 4.10, the store's BURST_EXTRA_DB). */
export const BURST_SURFACE_EXTRA_DB = 3

/** Id charset: ASCII without JSON escapes, so a character is one byte in the frame. */
const ID_PATTERN = /^[A-Za-z0-9._~:-]+$/

const SCANNER_CONFIDENCES = [
	"activity",
	"candidate",
	"classified",
	"decoded",
] as const satisfies readonly ScannerConfidence[]
// Compile-time completeness: every ScannerConfidence is listed.
const confidenceCompleteness: Exclude<
	ScannerConfidence,
	(typeof SCANNER_CONFIDENCES)[number]
> extends never
	? true
	: never = true
void confidenceCompleteness

/** The tracker's own state of the open track a segment was associated with, in that block. */
export interface TrackAssociation {
	trackId: string
	/** The TrackSnapshot `snrDb` (mean band over mean floor, dB). */
	snrDb: number
	peakDbfs: number
	/** On-blocks so far. */
	blocks: number
	startSample: number
	lastSample: number
	maxBlockSnrDb: number
	thresholdDb: number
	spur: boolean
	iqImage: boolean
	burst: boolean
}

/** Half-dB rounding (the summary bins' grid); null when not finite or beyond ±999.5. */
export function roundHalfDb(x: number): number | null {
	if (!Number.isFinite(x)) return null
	const r = Math.round(x * 2) / 2
	if (Math.abs(r) > FRAME_TRACK_DB_ABS_MAX) return null
	return r === 0 ? 0 : r
}

/**
 * Req 5.1 display surfacing rule: never a spur or an image; a burst track at its threshold
 * + 3 dB (best per-bin block SNR); any other track at ≥ minSurfaceBlocks on-blocks.
 */
export function surfacedOf(
	t: Pick<
		TrackAssociation,
		"spur" | "iqImage" | "burst" | "blocks" | "maxBlockSnrDb" | "thresholdDb"
	>,
	minSurfaceBlocks: number,
): boolean {
	if (t.spur || t.iqImage) return false
	if (t.burst) return t.maxBlockSnrDb >= t.thresholdDb + BURST_SURFACE_EXTRA_DB
	return t.blocks >= minSurfaceBlocks
}

export function isFrameTrackId(v: unknown): v is string {
	return (
		typeof v === "string" &&
		v.length >= 1 &&
		v.length <= FRAME_TRACK_ID_MAX_CHARS &&
		ID_PATTERN.test(v)
	)
}

const isCount = (v: unknown, max: number): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max

const isHalfDb = (v: unknown): v is number =>
	typeof v === "number" &&
	Number.isFinite(v) &&
	Math.abs(v) <= FRAME_TRACK_DB_ABS_MAX &&
	Number.isInteger(v * 2)

/**
 * A block track of one segment: the raw segment fields and, when the tracker associated the
 * segment with an open track in this block, that track's fields (req 5.1). `segmentImage` is
 * the segment's own `iqImage` flag (an image either way does not surface). A track whose id
 * is outside the frame bound carries no field (fail safe: the frame is today's).
 */
export function blockTrackOf(
	startHz: number,
	endHz: number,
	flags: { burst: boolean; iqImage: boolean; edge: boolean },
	a: TrackAssociation | null,
	sampleRateHz: number,
	minSurfaceBlocks: number,
): BlockTrack {
	if (a === null || !isFrameTrackId(a.trackId)) return { startHz, endHz, flags }
	const out: BlockTrack = {
		startHz,
		endHz,
		flags: { ...flags, spur: a.spur },
		trackId: a.trackId,
	}
	const snr = roundHalfDb(a.snrDb)
	if (snr !== null) out.snrDb = snr
	const peak = roundHalfDb(a.peakDbfs)
	if (peak !== null) out.peakDbfs = peak
	if (isCount(a.blocks, FRAME_TRACK_BLOCKS_MAX)) out.blocks = a.blocks
	const age =
		sampleRateHz > 0
			? Math.round(((a.lastSample - a.startSample) / sampleRateHz) * 1000)
			: Number.NaN
	if (isCount(age, FRAME_TRACK_AGE_MS_MAX)) out.ageMs = age
	out.surfaced = surfacedOf(
		{ ...a, iqImage: a.iqImage || flags.iqImage },
		minSurfaceBlocks,
	)
	return out
}

const WG11_KEYS = [
	"trackId",
	"snrDb",
	"peakDbfs",
	"blocks",
	"ageMs",
	"surfaced",
] as const

/**
 * Host side, after the worker boundary (req 5.5, bounded decode): drops every malformed WG11
 * field of a block track in place, never the track or the frame. Without a valid `trackId`
 * the track keeps none of them (`flags.spur` included). `surfaced` true next to a spur or an
 * image is a contradiction and is dropped. A `scanner` field never crosses the worker and is
 * dropped. O(1) per track.
 */
export function sanitizeBlockTrack(t: BlockTrack): void {
	const o = t as unknown as LooseTrack
	const flags =
		typeof o.flags === "object" && o.flags !== null
			? (o.flags as LooseFlags)
			: null
	delete o.scanner
	if (!isFrameTrackId(o.trackId)) {
		for (const k of WG11_KEYS) delete o[k]
		if (flags) delete flags.spur
		return
	}
	if (flags && "spur" in flags && typeof flags.spur !== "boolean")
		delete flags.spur
	if ("snrDb" in o && !isHalfDb(o.snrDb)) delete o.snrDb
	if ("peakDbfs" in o && !isHalfDb(o.peakDbfs)) delete o.peakDbfs
	if ("blocks" in o && !isCount(o.blocks, FRAME_TRACK_BLOCKS_MAX))
		delete o.blocks
	if ("ageMs" in o && !isCount(o.ageMs, FRAME_TRACK_AGE_MS_MAX)) delete o.ageMs
	if ("surfaced" in o) {
		const contradicts =
			o.surfaced === true && (flags?.spur === true || flags?.iqImage === true)
		if (typeof o.surfaced !== "boolean" || contradicts) delete o.surfaced
	}
}

/** A block track as received across the worker: every WG11 field unchecked. */
interface LooseTrack {
	flags?: unknown
	trackId?: unknown
	snrDb?: unknown
	peakDbfs?: unknown
	blocks?: unknown
	ageMs?: unknown
	surfaced?: unknown
	scanner?: unknown
}
interface LooseFlags {
	spur?: unknown
	iqImage?: unknown
}

/**
 * A scanner identity answer, re-built from its three known fields; null (no `scanner` field)
 * for anything else: unknown protocol or confidence, an id outside the bound or charset.
 */
export function frameTrackScannerOf(
	v: unknown,
): SpectrumFrameTrackScanner | null {
	if (typeof v !== "object" || v === null) return null
	const o = v as {
		discoveryId?: unknown
		protocol?: unknown
		confidence?: unknown
	}
	const id = o.discoveryId
	if (
		typeof id !== "string" ||
		id.length < 1 ||
		id.length > FRAME_TRACK_DISCOVERY_ID_MAX_CHARS ||
		!ID_PATTERN.test(id)
	)
		return null
	const protocol = o.protocol
	const confidence = o.confidence
	if (
		typeof protocol !== "string" ||
		!(BANDPLAN_SCANNER_PROTOCOLS as readonly string[]).includes(protocol)
	)
		return null
	if (
		typeof confidence !== "string" ||
		!(SCANNER_CONFIDENCES as readonly string[]).includes(confidence)
	)
		return null
	return {
		discoveryId: id,
		protocol: protocol as SpectrumFrameTrackScanner["protocol"],
		confidence: confidence as ScannerConfidence,
	}
}
