/**
 * A18 differential (docs/specs/evidence-squelch requirements 9.8, 9.13): the production framed
 * consumer path (parser, `applyFramedMarker`, `processEvidenceChunk`, real gate and pre-roll)
 * equals the ordered reference exactly for any chunking; the csdr shape matches it within the
 * documented skew (one PCM chunk plus the lag).
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { EvidenceGateOptions } from "../../../../src/core/evidence-squelch/contract.js"
import { evidenceDeviationHz } from "../../../../src/core/evidence-squelch/contract.js"
import { WKAF_FLAG_GATE_OPEN } from "../../../../src/core/evidence-squelch/framed-audio-parser.js"
import {
	FRAMED_RATE,
	chunked,
	csdrConsumer,
	encodeFramed,
	framedConsumer,
	orderedReference,
	overSteps,
	type OverSegment,
	type Step,
	type Verdicts,
} from "./framed-harness.js"
import {
	carrierSilence,
	ctcssMix,
	dcsMix,
	fskBursts,
	mix,
	voiceLike,
} from "./synthetic.js"

const OPTIONS: EvidenceGateOptions = {
	rate: FRAMED_RATE,
	modulation: "nfm",
	gain: 2,
	deviationHz: evidenceDeviationHz(12_500),
	drainLagSamples: 24,
}

const zeros = (seconds: number): Float32Array =>
	new Float32Array(Math.round(FRAMED_RATE * seconds))
const voice = (seconds: number, seed: number): Float32Array =>
	voiceLike({ rate: FRAMED_RATE, seconds, seed, level: 0.8 })
const ste = (seconds: number): Float32Array =>
	Float32Array.from(
		{ length: Math.round(FRAMED_RATE * seconds) },
		(_, i) => 0.12 * Math.sin((2 * Math.PI * 55 * i) / FRAMED_RATE),
	)

const closed = (seconds: number): OverSegment => ({
	pcm: zeros(seconds),
	open: false,
	quietingDb: Number.NaN,
})
const over = (pcm: Float32Array, quietingDb = 30): OverSegment => ({
	pcm,
	open: true,
	quietingDb,
})

/**
 * Trailing stage-1-closed time: longer than the pre-roll delay (up to 1 s) plus the close guard,
 * so the whole tail reaches the client and `lastPlayed` is the tail end, not the stream cut.
 */
const TAIL = 1.5

/** Voice-over start sample after 0.3 s closed (stage 1 opens here). */
const ONSET = Math.round(0.3 * FRAMED_RATE)

const OVERS: Record<string, Step[]> = {
	"ctcss voice": overSteps([
		closed(0.3),
		over(
			mix(voice(2, 3), ctcssMix({ rate: FRAMED_RATE, seconds: 2, hz: 88.5 })),
		),
		closed(TAIL),
	]),
	"dcs voice": overSteps([
		closed(0.3),
		over(
			mix(
				voice(2, 5),
				dcsMix({
					rate: FRAMED_RATE,
					seconds: 2,
					code: 0o23,
					polarity: "normal",
				}),
			),
		),
		closed(TAIL),
	]),
	"plain voice": overSteps([closed(0.3), over(voice(2, 7)), closed(TAIL)]),
	"bare carrier": overSteps([
		closed(0.3),
		over(carrierSilence({ rate: FRAMED_RATE, seconds: 2 })),
		closed(TAIL),
	]),
	"data-like": overSteps([
		closed(0.3),
		over(
			fskBursts({
				rate: FRAMED_RATE,
				seconds: 2,
				levels: 2,
				baud: 1_200,
				burstMs: 300,
				gapMs: 100,
				seed: 9,
			}),
		),
		closed(TAIL),
	]),
	"ste tail": overSteps([
		closed(0.3),
		over(voice(2, 11)),
		over(ste(0.3)),
		closed(TAIL),
	]),
	"two overs inside the hang": overSteps([
		closed(0.3),
		over(voice(1.5, 13)),
		closed(0.1),
		over(voice(1.5, 17)),
		closed(TAIL),
	]),
	"drop and reset inside an over": overSteps(
		[closed(0.3), over(voice(2.5, 19)), closed(TAIL)],
		[
			{
				at: ONSET + 7_001,
				step: { kind: "drop", count: 333, flags: WKAF_FLAG_GATE_OPEN },
			},
			{
				at: ONSET + 9_013,
				step: { kind: "reset", count: 50, flags: WKAF_FLAG_GATE_OPEN },
			},
		],
	),
	"drop after a latch": overSteps(
		[closed(0.3), over(voice(2.5, 23)), closed(TAIL)],
		[
			{
				at: ONSET + 72_000,
				step: { kind: "drop", count: 480, flags: WKAF_FLAG_GATE_OPEN },
			},
		],
	),
	"reset after a latch": overSteps(
		[closed(0.3), over(voice(2.5, 29)), closed(TAIL)],
		[
			{
				at: ONSET + 72_000,
				step: { kind: "reset", count: 9, flags: WKAF_FLAG_GATE_OPEN },
			},
		],
	),
}

function comparable(v: Verdicts): Record<string, unknown> {
	return {
		latches: v.latches,
		// The STE onset (input sample); the detection point depends on the push range.
		steOnsets: v.steMutes.map(m => m.at - m.back),
		firstPlayed: v.firstPlayed,
		lastPlayed: v.lastPlayed,
		client: v.client.toString("base64"),
	}
}

const references = new Map<string, Verdicts>()
function reference(name: string): Verdicts {
	const cached = references.get(name)
	if (cached) return cached
	const steps = OVERS[name]
	if (steps === undefined) throw new Error(name)
	const v = orderedReference(steps, OPTIONS)
	references.set(name, v)
	return v
}

describe("A18 framed consumer equals the ordered reference", () => {
	it("the overs give the expected verdicts on the reference", () => {
		for (const name of ["ctcss voice", "dcs voice", "plain voice"])
			expect([name, reference(name).latches.length]).toEqual([name, 1])
		expect(reference("bare carrier").latches).toEqual([])
		expect(reference("bare carrier").firstPlayed).toBe(-1)
		expect(reference("ste tail").steMutes.length).toBeGreaterThan(0)
		// The held onset plays from the latch on (client output index), up to the over's end.
		const plain = reference("plain voice")
		expect(plain.firstPlayed).toBe(plain.latches[0])
		expect(plain.lastPlayed).toBeGreaterThan(ONSET + 2 * FRAMED_RATE)
	})

	// Feature: evidence-squelch, Property 22: framed consumer equals the ordered reference
	// Validates: Requirements 9.7, 9.8, 9.13
	it("every over, any chunking: identical latches, STE mutes, onset, tail end and client bytes", () => {
		const names = Object.keys(OVERS)
		fc.assert(
			fc.property(
				fc.constantFrom(...names),
				fc.array(fc.nat(), { minLength: 0, maxLength: 80 }),
				fc.integer({ min: 1, max: 9_000 }),
				(name, seeds, stride) => {
					const steps = OVERS[name] ?? []
					const bytes = encodeFramed(steps)
					// Random cuts plus a regular stride (splits inside headers, payloads, samples).
					const cuts = [
						...seeds.map(s => s % bytes.length),
						...Array.from(
							{ length: Math.floor(bytes.length / stride) },
							(_, i) => (i + 1) * stride,
						),
					]
					const got = framedConsumer(chunked(bytes, cuts), OPTIONS)
					expect(got.faults).toEqual([])
					expect(comparable(got)).toEqual(comparable(reference(name)))
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)

	it("1-byte chunks of an over with a drop and a reset equal the reference", () => {
		const name = "drop and reset inside an over"
		const bytes = encodeFramed(OVERS[name] ?? [])
		const got = framedConsumer(
			chunked(
				bytes,
				Array.from({ length: bytes.length }, (_, i) => i),
			),
			OPTIONS,
		)
		expect(comparable(got)).toEqual(comparable(reference(name)))
	}, 60_000)

	it("csdr shape matches the reference within one PCM chunk plus the lag", () => {
		const chunk = 2_048
		const skew = chunk + 480 + (OPTIONS.drainLagSamples ?? 0)
		for (const name of [
			"ctcss voice",
			"dcs voice",
			"plain voice",
			"two overs inside the hang",
		]) {
			const ref = reference(name)
			const csdr = csdrConsumer(OVERS[name] ?? [], OPTIONS, chunk)
			expect([name, csdr.latches.length > 0]).toEqual([name, true])
			expect(
				Math.abs((csdr.latches[0] ?? 0) - (ref.latches[0] ?? 0)),
			).toBeLessThanOrEqual(skew)
			expect(Math.abs(csdr.firstPlayed - ref.firstPlayed)).toBeLessThanOrEqual(
				skew,
			)
			const tail = Math.abs(csdr.lastPlayed - ref.lastPlayed)
			expect([name, tail <= skew]).toEqual([name, true])
			// The tail ends inside the stream (not cut by it).
			expect(ref.lastPlayed).toBeLessThan(ref.client.length / 2 - 4_800)
		}
		expect(
			csdrConsumer(OVERS["bare carrier"] ?? [], OPTIONS, chunk).firstPlayed,
		).toBe(-1)
	}, 60_000)
})

describe("A18 discontinuities clear evidence (9.13)", () => {
	const VOICE = voice(3, 31)
	/** The over with its audio before `cut` (input samples) scaled: a different past. */
	function scenario(
		at: number,
		kind: "reset" | "drop",
		pastScale: number,
	): Step[] {
		const pcm = Float32Array.from(VOICE, (v, i) =>
			i + ONSET < at ? v * pastScale : v,
		)
		return overSteps(
			[closed(0.3), over(pcm), closed(0.6)],
			[
				{
					at,
					step: {
						kind,
						count: kind === "drop" ? 960 : 3,
						flags: at < ONSET + VOICE.length ? WKAF_FLAG_GATE_OPEN : 0,
					},
				},
			],
		)
	}

	for (const kind of ["reset", "drop"] as const) {
		it(`${kind} before a latch, after a latch and inside the close guard: nothing from before it plays`, () => {
			const latch = orderedReference(
				overSteps([closed(0.3), over(VOICE), closed(0.6)]),
				OPTIONS,
			).latches[0]
			expect(latch).toBeDefined()
			const closeAt = ONSET + VOICE.length
			const points = {
				"before the latch": ONSET + 2_400,
				"after the latch": (latch ?? 0) + 960,
				"inside the close guard": closeAt + 100,
			}
			for (const [label, at] of Object.entries(points)) {
				const a = scenario(at, kind, 1)
				const b = scenario(at, kind, 0.5)
				const ref = orderedReference(a, OPTIONS)
				const bytes = encodeFramed(a)
				const got = framedConsumer(
					chunked(bytes, [at, at * 2 + 37, 1_001, bytes.length - 999]),
					OPTIONS,
				)
				expect([label, comparable(got)]).toEqual([label, comparable(ref)])
				// Output from the discontinuity on (one output sample per delivered input sample)
				// does not depend on the audio before it: no held byte is played, and later
				// verdicts rest on fresh evidence only.
				const other = framedConsumer([encodeFramed(b)], OPTIONS)
				expect([
					label,
					got.client.subarray(at * 2).equals(other.client.subarray(at * 2)),
				]).toEqual([label, true])
				expect([label, got.latches.filter(l => l >= at)]).toEqual([
					label,
					other.latches.filter(l => l >= at),
				])
			}
		}, 60_000)
	}
	it("a drop right after a latch mutes the bytes the pre-roll still held", () => {
		const steps0 = overSteps([closed(0.3), over(voice(3, 37)), closed(0.6)])
		const base = orderedReference(steps0, OPTIONS)
		const latch = base.latches[0] ?? 0
		const at = latch + 48
		const steps = overSteps(
			[closed(0.3), over(voice(3, 37)), closed(0.6)],
			[{ at, step: { kind: "drop", count: 0, flags: WKAF_FLAG_GATE_OPEN } }],
		)
		const got = framedConsumer([encodeFramed(steps)], OPTIONS)
		// After the drop the pre-roll is cleared, so output right after the cut is silence while
		// the held lead-in would have played in the base run.
		const window = (s: Buffer): number[] => {
			const out: number[] = []
			for (let i = at; i < at + 480; i++) out.push(s.readInt16LE(i * 2))
			return out
		}
		expect(window(base.client).some(v => v !== 0)).toBe(true)
		expect(window(got.client).every(v => v === 0)).toBe(true)
	})
})
