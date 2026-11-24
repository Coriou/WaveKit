/**
 * "No tone heard" (tone null) through the real recorder (wideband-analog-recorder.ts gapTo,
 * toneFrames, finishFile): a toned file never reads null.
 * - Source gaps: the silence a short input gap leaves in the file never reaches the CTCSS bank or
 *   the DCS decoder. Zero-filled gaps would pass the quiet ceilings (an all-zero block hides
 *   nothing) and count as analysed coverage.
 * - Loud blocks: quiet blocks prove only that the tone was off during them. A tone hidden under
 *   voice, then dropped for a carrier hang (or a toned over joined to an untoned one), leaves ten
 *   quiet blocks beside many loud ones: null also needs at most TONE_LOUD_EDGE_BLOCKS (2) loud blocks,
 *   whatever the file's length: a short toned burst on a long carrier never reads null.
 * The coverage the finish freezes is captured from toneFactOf. Modelled audio (NfmSource) only.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	TONE_QUIET_MIN_BLOCKS,
	TONE_LOUD_EDGE_BLOCKS,
	type ToneCoverage,
} from "../../../../src/core/scanner/store/recording-facts.js"
import type * as RecordingFacts from "../../../../src/core/scanner/store/recording-facts.js"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import { WIDEBAND_MAX_SILENCE_GAP_MS } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input as trackInput,
	snapshot,
} from "./wideband-recorder-harness.js"
import { voicePitchDeviation } from "./wideband-nfm-fixtures.js"

const seen = vi.hoisted(() => ({
	calls: [] as { coverage: unknown; result: unknown }[],
}))

vi.mock(
	"../../../../src/core/scanner/store/recording-facts.js",
	async importOriginal => {
		const actual = await importOriginal<typeof RecordingFacts>()
		return {
			...actual,
			toneFactOf: (...args: Parameters<typeof actual.toneFactOf>) => {
				const result = actual.toneFactOf(...args)
				seen.calls.push({ coverage: args[1], result })
				return result
			},
		}
	},
)

afterEach(() => {
	seen.calls.length = 0
})

const analogFm: VoicePrior = {
	labels: [],
	class: "analog-fm",
	analogVoice: () => false,
}

/** One keyed over: its seconds on the air and what the modelled source sends t s into it. */
interface Over {
	seconds: number
	/** The over's CTCSS at t s (each 25 ms chunk), 250 Hz of deviation; null: none. */
	ctcssAt: (t: number) => number | null
	/** The talker speaks at t s (voice and `subAudible` keyed together); default always. */
	voiceAt?: (t: number) => boolean
	/** A sub-audible voice pitch while speaking (NfmSource.setSubAudible); default none. */
	subAudible?: (t: number) => number
	/** `subAudible` is on at t s (while speaking); default always. */
	subAudibleOn?: (t: number) => boolean
	/** Carrier-off seconds after the over: under the 2 s hang joins the next over. */
	gapAfter: number
	/** Source gaps (IQ skipped: a ring gap) of `gapSeconds`, spread evenly; default none. */
	gaps?: number
	gapSeconds?: number
}

/**
 * Kept files of a scene of overs (modelled syllabic voice: its bursts from 400 Hz up leave the
 * tone band quiet), each its own observation closed 600 ms into the gap after it. Returns the
 * fake operations and, per finished file, the coverage the finish gave toneFactOf.
 */
async function scene(overs: readonly Over[]) {
	const r = harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		source: { ctcssHz: null, syllables: true },
		decodedLabel: () => null,
		voicePrior: () => analogFm,
	})
	await r.feed(1, false)
	r.src.setCtcssDeviation(250)
	const chunk = r.fs / 40
	for (const [n, over] of overs.entries()) {
		const id = `o${n}`
		const chunks = Math.round(over.seconds * 40)
		const gaps = over.gaps ?? 0
		const every = Math.floor(chunks / (gaps + 1))
		const skip = Math.round((over.gapSeconds ?? 0) * r.fs)
		const onset = r.engine.liveEdge()
		const end = onset + over.seconds * r.fs + gaps * skip
		let skipped = 0
		for (let i = 0; i < chunks; i++) {
			const t = i / 40
			const speaking = over.voiceAt?.(t) ?? true
			r.src.setCtcss(over.ctcssAt(t))
			r.src.setVoice(speaking)
			r.src.setSubAudible(
				speaking && (over.subAudibleOn?.(t) ?? true)
					? (over.subAudible ?? null)
					: null,
			)
			const gapHere = gaps > 0 && i > 0 && i % every === 0 && skipped < gaps
			if (gapHere) skipped++
			r.engine.write(r.src.next(chunk, true), gapHere ? skip : 0)
			const edge = r.engine.liveEdge()
			if (edge - onset >= 0.1 * r.fs)
				r.rec.track(
					trackInput(id, snapshot(id, onset, Math.min(edge, end), LOW)),
				)
			await r.pump()
		}
		expect(skipped).toBe(gaps)
		r.src.setSubAudible(null)
		const closeAfter = Math.min(0.6, over.gapAfter)
		await r.feed(closeAfter, false)
		r.rec.closed(id, snapshot(id, onset, end, LOW), null, {
			analogFm: true,
			discoveryId: "d_1",
		})
		await r.feed(over.gapAfter - closeAfter, false)
	}
	await r.rec.idle()
	await r.fire()
	await r.rec.idle()
	return {
		ops: r.ops,
		files: seen.calls.map(c => ({
			coverage: c.coverage as ToneCoverage,
			result: c.result as { tone?: unknown },
		})),
	}
}

/** One kept file: its operation and coverage. */
async function oneFile(overs: readonly Over[]) {
	const { ops, files } = await scene(overs)
	expect(ops).toHaveLength(1)
	expect(ops[0]!.outcome).toBe("finalized")
	expect(ops[0]!.cut).toBe("completed")
	expect(files).toHaveLength(1)
	return { op: ops[0]!, ...files[0]! }
}

/** CTCSS blocks in `seconds` of 8 kHz tone audio: 4 000 samples, then one per 2 000. */
const blocksIn = (seconds: number) =>
	Math.max(0, Math.floor((seconds * 8000 - 4000) / 2000) + 1)

/** The weakest tone ruled out (254.1 Hz at 250 Hz) hidden under a voice pitch 4 times its level. */
const HIDDEN_HZ = 254.1
const hiddenPitch = voicePitchDeviation(1000)

describe("recorder tone path across source gaps", () => {
	it("the gaps are under the silence limit the file survives", () => {
		expect(950).toBeLessThan(WIDEBAND_MAX_SILENCE_GAP_MS)
	})

	// A 10 s over whose tone hides under a continuous voice pitch (no block votes, leans or is
	// quiet), five 0.95 s gaps. Fed to the bank, the fill's 4.75 s of zeros made 10 quiet blocks
	// (measured before the fix): "No tone heard" for a toned file. The fill never reaches the
	// detectors now: no quiet block, never null.
	it("five 0.95 s gaps in a hidden-tone over: no quiet block, never null", async () => {
		const { op, coverage, result } = await oneFile([
			{
				seconds: 10,
				ctcssAt: () => HIDDEN_HZ,
				subAudible: hiddenPitch,
				gapAfter: 4.1,
				gaps: 5,
				gapSeconds: 0.95,
			},
		])
		expect(op.gaps).toBeGreaterThan(0)
		expect(coverage.quietBlocks).toBe(0)
		expect(result.tone).not.toBeNull()
		// The detectors analysed the over's own audio only (10 s, both ends inclusive), never its
		// 4.75 s of gaps (34 blocks with them).
		expect(coverage.ctcssBlocks).toBeLessThanOrEqual(blocksIn(10))
		expect(coverage.dcsSamples).toBeLessThanOrEqual(10 * 8000 + 1)
	}, 240_000)

	// The same gaps in an untoned over: the real audio still proves no tone, so the gaps neither
	// add blocks nor stop its null.
	it("gaps in an untoned over add no analysed coverage and leave its null", async () => {
		const { op, coverage, result } = await oneFile([
			{
				seconds: 6,
				ctcssAt: () => null,
				gapAfter: 4.1,
				gaps: 3,
				gapSeconds: 0.95,
			},
		])
		expect(op.gaps).toBeGreaterThan(0)
		expect(coverage.ctcssBlocks).toBeLessThanOrEqual(blocksIn(6))
		expect(coverage.dcsSamples).toBeLessThanOrEqual(6 * 8000 + 1)
		expect(result.tone).toBeNull()
	}, 240_000)
})

describe("recorder tone path: quiet blocks beside loud ones", () => {
	/** Loud (not quiet) blocks of a file's coverage. */
	const loud = (c: ToneCoverage) => c.ctcssBlocks - c.quietBlocks

	// 7 s of the hidden tone under the talker, then the repeater drops its CTCSS and hangs the
	// carrier for 3 s (the talker silent). The hang alone gives ten quiet blocks or more, which
	// read null before the loud-block bound; the 7 s of voice are about 27 loud blocks.
	it("7 s hidden tone, then a 3 s tone-dropped carrier: never null", async () => {
		const { coverage, result } = await oneFile([
			{
				seconds: 10,
				ctcssAt: t => (t < 7 ? HIDDEN_HZ : null),
				voiceAt: t => t < 7,
				subAudible: hiddenPitch,
				gapAfter: 4.1,
			},
		])
		expect(coverage.votedBlocks).toBe(0)
		expect(coverage.partialBlocks).toBe(0)
		expect(coverage.quietBlocks).toBeGreaterThanOrEqual(TONE_QUIET_MIN_BLOCKS)
		expect(loud(coverage)).toBeGreaterThan(TONE_LOUD_EDGE_BLOCKS)
		expect(result.tone).not.toBeNull()
	}, 240_000)

	// A 6 s over with the hidden tone joined across a 1 s carrier-off gap to a 4 s untoned over
	// (another station, or the same one without its encoder): the untoned over's quiet blocks
	// are no proof about the first over's loud ones.
	it("a hidden-tone over joined to an untoned one: never null", async () => {
		const { coverage, result } = await oneFile([
			{
				seconds: 6,
				ctcssAt: () => HIDDEN_HZ,
				subAudible: hiddenPitch,
				gapAfter: 1,
			},
			{ seconds: 4, ctcssAt: () => null, gapAfter: 4.1 },
		])
		expect(coverage.quietBlocks).toBeGreaterThanOrEqual(TONE_QUIET_MIN_BLOCKS)
		expect(loud(coverage)).toBeGreaterThan(TONE_LOUD_EDGE_BLOCKS)
		expect(result.tone).not.toBeNull()
	}, 240_000)

	// A 40 s over with nothing in the tone band (the modelled voice sits from 400 Hz up) but a
	// 2 s burst mid-file of the hidden tone under a sub-audible voice pitch. The burst's loud blocks are well under a tenth of the file's (a share
	// of the blocks would have read null): only the keying edge and the squelch tail may be
	// loud, so the burst keeps it not determined.
	it("a 2 s toned burst in a 40 s over quiet in the tone band: never null", async () => {
		const burst = (t: number) => t >= 19 && t < 21
		const { coverage, result } = await oneFile([
			{
				seconds: 40,
				ctcssAt: t => (burst(t) ? HIDDEN_HZ : null),
				subAudible: hiddenPitch,
				subAudibleOn: burst,
				gapAfter: 4.1,
			},
		])
		expect(coverage.votedBlocks).toBe(0)
		expect(coverage.partialBlocks).toBe(0)
		expect(coverage.quietBlocks).toBeGreaterThanOrEqual(TONE_QUIET_MIN_BLOCKS)
		expect(loud(coverage)).toBeGreaterThan(TONE_LOUD_EDGE_BLOCKS)
		expect(loud(coverage)).toBeLessThanOrEqual(
			Math.floor(0.1 * coverage.ctcssBlocks),
		)
		expect(result.tone).not.toBeNull()
	}, 240_000)

	// The same talker untoned, then the same 3 s carrier: nothing tone-like, but the voice's loud
	// blocks could have hidden a tone: not determined, never a measured "no tone".
	it("an untoned talker with an in-band pitch, then a 3 s carrier: absent", async () => {
		const { coverage, result } = await oneFile([
			{
				seconds: 10,
				ctcssAt: () => null,
				voiceAt: t => t < 7,
				subAudible: hiddenPitch,
				gapAfter: 4.1,
			},
		])
		expect(coverage.quietBlocks).toBeGreaterThanOrEqual(TONE_QUIET_MIN_BLOCKS)
		expect("tone" in result).toBe(false)
	}, 240_000)

	// The positive case: a carrier with nothing in the sub-audible band (the modelled voice's
	// bursts sit from 400 Hz up) for 4 s: every block but the keying edges is quiet: null.
	it("a 4 s carrier with nothing in the tone band: null, its loud blocks within the bound", async () => {
		const { coverage, result } = await oneFile([
			{ seconds: 4, ctcssAt: () => null, gapAfter: 4.1 },
		])
		expect(coverage.ctcssBlocks).toBeGreaterThanOrEqual(TONE_QUIET_MIN_BLOCKS)
		expect(loud(coverage)).toBeLessThanOrEqual(TONE_LOUD_EDGE_BLOCKS)
		expect(result.tone).toBeNull()
	}, 240_000)
})
