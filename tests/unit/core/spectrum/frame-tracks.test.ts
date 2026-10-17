import { describe, expect, it } from "vitest"
import { SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES } from "@wavekit/api-types"
import {
	BURST_SURFACE_EXTRA_DB,
	FRAME_TRACK_AGE_MS_MAX,
	FRAME_TRACK_BLOCKS_MAX,
	FRAME_TRACK_DB_ABS_MAX,
	FRAME_TRACK_DISCOVERY_ID_MAX_CHARS,
	FRAME_TRACK_ID_MAX_CHARS,
	blockTrackOf,
	frameTrackScannerOf,
	isFrameTrackId,
	roundHalfDb,
	sanitizeBlockTrack,
	surfacedOf,
	type TrackAssociation,
} from "../../../../src/core/spectrum/frame-tracks.js"
import type { BlockTrack } from "../../../../src/core/spectrum/types.js"

const FS = 2_048_000
const FLAGS = { burst: false, iqImage: false, edge: false }

function assoc(over: Partial<TrackAssociation> = {}): TrackAssociation {
	return {
		trackId: "mguu1x2s-1",
		snrDb: 12.26,
		peakDbfs: -40.74,
		blocks: 3,
		startSample: 0,
		lastSample: 102_400,
		maxBlockSnrDb: 20,
		thresholdDb: 10,
		spur: false,
		iqImage: false,
		burst: false,
		...over,
	}
}

describe("roundHalfDb", () => {
	it("rounds to the 0.5 dB grid and normalises -0", () => {
		expect(roundHalfDb(12.26)).toBe(12.5)
		expect(roundHalfDb(12.24)).toBe(12)
		expect(roundHalfDb(-40.74)).toBe(-40.5)
		expect(Object.is(roundHalfDb(-0.1), 0)).toBe(true)
	})
	it("bounds at ±999.5: at the bound kept, one step past dropped", () => {
		expect(roundHalfDb(FRAME_TRACK_DB_ABS_MAX)).toBe(999.5)
		expect(roundHalfDb(-FRAME_TRACK_DB_ABS_MAX)).toBe(-999.5)
		expect(roundHalfDb(999.74)).toBe(999.5)
		expect(roundHalfDb(999.75)).toBeNull()
		expect(roundHalfDb(-1000)).toBeNull()
	})
	it("drops non-finite values", () => {
		for (const v of [Number.NaN, Infinity, -Infinity])
			expect(roundHalfDb(v)).toBeNull()
	})
})

describe("surfacedOf (req 5.1 display rule)", () => {
	const base = {
		spur: false,
		iqImage: false,
		burst: false,
		blocks: 2,
		maxBlockSnrDb: 0,
		thresholdDb: 10,
	}
	it("an ordinary track surfaces at exactly minSurfaceBlocks, not one below", () => {
		expect(surfacedOf({ ...base, blocks: 2 }, 2)).toBe(true)
		expect(surfacedOf({ ...base, blocks: 1 }, 2)).toBe(false)
		expect(surfacedOf({ ...base, blocks: 20 }, 20)).toBe(true)
		expect(surfacedOf({ ...base, blocks: 19 }, 20)).toBe(false)
	})
	it("a burst track surfaces at exactly threshold + 3 dB, not just below, whatever its blocks", () => {
		const burst = { ...base, burst: true, blocks: 50 }
		expect(BURST_SURFACE_EXTRA_DB).toBe(3)
		expect(surfacedOf({ ...burst, maxBlockSnrDb: 13 }, 2)).toBe(true)
		expect(surfacedOf({ ...burst, maxBlockSnrDb: 12.99 }, 2)).toBe(false)
		expect(surfacedOf({ ...burst, blocks: 1, maxBlockSnrDb: 13 }, 2)).toBe(true)
	})
	it("a spur or an image never surfaces", () => {
		const strong = { ...base, blocks: 100, maxBlockSnrDb: 90 }
		expect(surfacedOf({ ...strong, spur: true }, 2)).toBe(false)
		expect(surfacedOf({ ...strong, iqImage: true }, 2)).toBe(false)
		expect(surfacedOf({ ...strong, burst: true, spur: true }, 2)).toBe(false)
		expect(surfacedOf({ ...strong, burst: true, iqImage: true }, 2)).toBe(false)
	})
})

describe("blockTrackOf", () => {
	it("an untracked segment is today's segment: no WG11 key, no flags.spur", () => {
		const t = blockTrackOf(1, 2, FLAGS, null, FS, 2)
		expect(JSON.stringify(t)).toBe(
			'{"startHz":1,"endHz":2,"flags":{"burst":false,"iqImage":false,"edge":false}}',
		)
	})
	it("a tracked segment copies the association: ids, rounded dB, blocks, age from samples, surfaced, spur", () => {
		const t = blockTrackOf(1, 2, FLAGS, assoc(), FS, 2)
		expect(t).toEqual({
			startHz: 1,
			endHz: 2,
			flags: { ...FLAGS, spur: false },
			trackId: "mguu1x2s-1",
			snrDb: 12.5,
			peakDbfs: -40.5,
			blocks: 3,
			ageMs: 50,
			surfaced: true,
		})
		// key order: the frozen keys first, flags.spur last in flags
		expect(Object.keys(t)).toEqual([
			"startHz",
			"endHz",
			"flags",
			"trackId",
			"snrDb",
			"peakDbfs",
			"blocks",
			"ageMs",
			"surfaced",
		])
	})
	it("ageMs rounds (lastSample - startSample) / fs to ms", () => {
		const t = blockTrackOf(
			1,
			2,
			FLAGS,
			assoc({ startSample: 1_000, lastSample: 1_000 + 3_071 }),
			FS,
			2,
		)
		expect(t.ageMs).toBe(Math.round((3_071 / FS) * 1000))
		expect(blockTrackOf(1, 2, FLAGS, assoc(), 0, 2).ageMs).toBeUndefined()
	})
	it("a segment flagged as an image does not surface even when its track is not (yet) an image", () => {
		const t = blockTrackOf(1, 2, { ...FLAGS, iqImage: true }, assoc(), FS, 2)
		expect(t.surfaced).toBe(false)
	})
	it("spur is carried and never surfaces", () => {
		const t = blockTrackOf(1, 2, FLAGS, assoc({ spur: true }), FS, 2)
		expect(t.flags.spur).toBe(true)
		expect(t.surfaced).toBe(false)
	})
	it("a too-young track does not surface", () => {
		expect(
			blockTrackOf(1, 2, FLAGS, assoc({ blocks: 1 }), FS, 2).surfaced,
		).toBe(false)
	})
	it("a track id at the bound is carried; one past it (or off the charset) carries no field", () => {
		const at = "a".repeat(FRAME_TRACK_ID_MAX_CHARS)
		expect(
			blockTrackOf(1, 2, FLAGS, assoc({ trackId: at }), FS, 2).trackId,
		).toBe(at)
		for (const bad of [`${at}a`, "", 'a"b', "a\\b", "ä", "a b"]) {
			const t = blockTrackOf(1, 2, FLAGS, assoc({ trackId: bad }), FS, 2)
			expect(Object.keys(t)).toEqual(["startHz", "endHz", "flags"])
			expect(t.flags).toEqual(FLAGS)
		}
	})
	it("drops a non-finite or out-of-bound stat, keeps the rest", () => {
		const t = blockTrackOf(
			1,
			2,
			FLAGS,
			assoc({ snrDb: Number.NaN, peakDbfs: -Infinity }),
			FS,
			2,
		)
		expect(t.snrDb).toBeUndefined()
		expect(t.peakDbfs).toBeUndefined()
		expect(t.trackId).toBe("mguu1x2s-1")
		const old = blockTrackOf(
			1,
			2,
			FLAGS,
			assoc({ lastSample: ((FRAME_TRACK_AGE_MS_MAX + 1) / 1000) * FS }),
			FS,
			2,
		)
		expect(old.ageMs).toBeUndefined()
		const atAge = blockTrackOf(
			1,
			2,
			FLAGS,
			assoc({ lastSample: (FRAME_TRACK_AGE_MS_MAX / 1000) * FS }),
			FS,
			2,
		)
		expect(atAge.ageMs).toBe(FRAME_TRACK_AGE_MS_MAX)
	})
})

describe("isFrameTrackId", () => {
	it("accepts the tracker's id form and rejects non-strings", () => {
		expect(isFrameTrackId("mguu1x2s-1")).toBe(true)
		expect(isFrameTrackId("rtl-mguu1x2s-w-1")).toBe(true)
		for (const v of [1, null, undefined, {}, ["a"]])
			expect(isFrameTrackId(v)).toBe(false)
	})
})

describe("sanitizeBlockTrack (worker boundary, hostile values)", () => {
	const good = (): BlockTrack => ({
		startHz: 1,
		endHz: 2,
		flags: { ...FLAGS, spur: false },
		trackId: "rtl-1",
		snrDb: 10.5,
		peakDbfs: -30,
		blocks: 4,
		ageMs: 200,
		surfaced: true,
	})
	const loose = (over: Record<string, unknown>): BlockTrack =>
		({ ...good(), ...over }) as unknown as BlockTrack

	it("keeps a valid track unchanged", () => {
		const t = good()
		sanitizeBlockTrack(t)
		expect(t).toEqual(good())
	})
	it("drops each malformed field, keeps the track and its other fields", () => {
		const cases: [string, unknown][] = [
			["snrDb", Number.NaN],
			["snrDb", Infinity],
			["snrDb", "10"],
			["snrDb", 10.25],
			["snrDb", 1000],
			["peakDbfs", -Infinity],
			["peakDbfs", null],
			["blocks", -1],
			["blocks", 1.5],
			["blocks", FRAME_TRACK_BLOCKS_MAX + 1],
			["blocks", "4"],
			["ageMs", -1],
			["ageMs", FRAME_TRACK_AGE_MS_MAX + 1],
			["ageMs", Number.NaN],
			["surfaced", "true"],
			["surfaced", 1],
		]
		for (const [key, value] of cases) {
			const t = loose({ [key]: value })
			sanitizeBlockTrack(t)
			expect(key in t, `${key}=${String(value)}`).toBe(false)
			expect(t.trackId).toBe("rtl-1")
			expect(t.startHz).toBe(1)
		}
	})
	it("keeps the count bounds at the bound", () => {
		const t = loose({
			blocks: FRAME_TRACK_BLOCKS_MAX,
			ageMs: FRAME_TRACK_AGE_MS_MAX,
			snrDb: -999.5,
			peakDbfs: 999.5,
		})
		sanitizeBlockTrack(t)
		expect(t.blocks).toBe(FRAME_TRACK_BLOCKS_MAX)
		expect(t.ageMs).toBe(FRAME_TRACK_AGE_MS_MAX)
		expect(t.snrDb).toBe(-999.5)
		expect(t.peakDbfs).toBe(999.5)
	})
	it("without a valid trackId the track keeps none of the fields", () => {
		for (const id of [
			"x".repeat(FRAME_TRACK_ID_MAX_CHARS + 1),
			"",
			42,
			{ toString: () => "rtl-1" },
			"a\u0000b",
		]) {
			const t = loose({ trackId: id })
			sanitizeBlockTrack(t)
			expect(Object.keys(t)).toEqual(["startHz", "endHz", "flags"])
			expect(Object.keys(t.flags)).toEqual(["burst", "iqImage", "edge"])
		}
	})
	it("a non-boolean spur is dropped; surfaced next to a spur or an image is dropped", () => {
		const a = loose({ flags: { ...FLAGS, spur: "yes" } })
		sanitizeBlockTrack(a)
		expect("spur" in a.flags).toBe(false)
		const b = loose({ flags: { ...FLAGS, spur: true } })
		sanitizeBlockTrack(b)
		expect("surfaced" in b).toBe(false)
		const c = loose({ flags: { ...FLAGS, iqImage: true, spur: false } })
		sanitizeBlockTrack(c)
		expect("surfaced" in c).toBe(false)
		const d = loose({ flags: { ...FLAGS, spur: true }, surfaced: false })
		sanitizeBlockTrack(d)
		expect(d.surfaced).toBe(false)
	})
	it("a scanner field never crosses the worker", () => {
		const t = loose({
			scanner: {
				discoveryId: "d_1",
				protocol: "dmr",
				confidence: "decoded",
			},
		})
		sanitizeBlockTrack(t)
		expect("scanner" in t).toBe(false)
	})
	it("tolerates a track without flags", () => {
		const t = { startHz: 1, endHz: 2 } as unknown as BlockTrack
		sanitizeBlockTrack(t)
		expect(t).toEqual({ startHz: 1, endHz: 2 })
	})
})

describe("frameTrackScannerOf", () => {
	const ok = {
		discoveryId: "d_01JABCDEFGHJKMNPQRSTVWXYZ0",
		protocol: "dmr",
		confidence: "decoded",
	}
	it("rebuilds a valid identity from its three fields only", () => {
		expect(frameTrackScannerOf({ ...ok, extra: "x", note: "<b>" })).toEqual(ok)
	})
	it("refuses unknown protocol or confidence, wrong types and non-objects", () => {
		for (const v of [
			{ ...ok, protocol: "tetra" },
			{ ...ok, protocol: "DMR" },
			{ ...ok, confidence: "proven" },
			{ ...ok, confidence: null },
			{ ...ok, discoveryId: 7 },
			{ ...ok, discoveryId: "" },
			{ ...ok, discoveryId: 'd_"x' },
			null,
			undefined,
			"dmr",
			42,
		])
			expect(frameTrackScannerOf(v)).toBeNull()
	})
	it("bounds the discovery id: at 36 chars kept, at 37 refused", () => {
		const at = "d".repeat(FRAME_TRACK_DISCOVERY_ID_MAX_CHARS)
		expect(frameTrackScannerOf({ ...ok, discoveryId: at })?.discoveryId).toBe(
			at,
		)
		expect(frameTrackScannerOf({ ...ok, discoveryId: `${at}d` })).toBeNull()
	})
})

describe("frame-track size bound (req 5.5)", () => {
	const segment = {
		startHz: 446_000_000,
		endHz: 446_012_500,
		flags: { burst: false, iqImage: false, edge: false },
	}
	/** Every field present at its longest accepted value (frame-tracks.ts arithmetic). */
	function worst(idChars: number, discoveryChars: number) {
		return {
			...segment,
			flags: { ...segment.flags, spur: false },
			trackId: "t".repeat(idChars),
			snrDb: -FRAME_TRACK_DB_ABS_MAX,
			peakDbfs: -FRAME_TRACK_DB_ABS_MAX,
			blocks: FRAME_TRACK_BLOCKS_MAX,
			ageMs: FRAME_TRACK_AGE_MS_MAX,
			surfaced: false,
			scanner: {
				discoveryId: "d".repeat(discoveryChars),
				protocol: "digital-unknown",
				confidence: "classified",
			},
		}
	}
	const growth = (v: object): number =>
		Buffer.byteLength(JSON.stringify(v)) -
		Buffer.byteLength(JSON.stringify(segment))

	it("grows by at most 260 bytes at the worst accepted lengths (exactly at the bound)", () => {
		expect(
			growth(
				worst(FRAME_TRACK_ID_MAX_CHARS, FRAME_TRACK_DISCOVERY_ID_MAX_CHARS),
			),
		).toBe(SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES)
	})
	it("one character past either id bound would exceed it, and is refused", () => {
		const over = worst(
			FRAME_TRACK_ID_MAX_CHARS + 1,
			FRAME_TRACK_DISCOVERY_ID_MAX_CHARS,
		)
		expect(growth(over)).toBe(SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES + 1)
		expect(isFrameTrackId(over.trackId)).toBe(false)
		expect(
			frameTrackScannerOf({
				...over.scanner,
				discoveryId: "d".repeat(FRAME_TRACK_DISCOVERY_ID_MAX_CHARS + 1),
			}),
		).toBeNull()
	})
	it("the longest value blockTrackOf can emit stays within the bound with any valid scanner", () => {
		const t = blockTrackOf(
			segment.startHz,
			segment.endHz,
			segment.flags,
			assoc({
				trackId: "t".repeat(FRAME_TRACK_ID_MAX_CHARS),
				snrDb: -999.5,
				peakDbfs: -999.5,
				blocks: FRAME_TRACK_BLOCKS_MAX,
				lastSample: (FRAME_TRACK_AGE_MS_MAX / 1000) * FS,
				spur: true,
			}),
			FS,
			2,
		)
		const scanner = frameTrackScannerOf({
			discoveryId: "d".repeat(FRAME_TRACK_DISCOVERY_ID_MAX_CHARS),
			protocol: "digital-unknown",
			confidence: "classified",
		})
		expect(growth({ ...t, scanner })).toBeLessThanOrEqual(
			SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES,
		)
	})
})
