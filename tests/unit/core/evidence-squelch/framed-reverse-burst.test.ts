/**
 * A18 x A20 (docs/specs/evidence-squelch requirements 9.8, 9.13 and A20.1, A20.3, A20.4): the
 * CTCSS reverse-burst end on a framed Rust run, through the production framed consumer path
 * (parser, `applyFramedMarker`, `processEvidenceChunk`, real gate and pre-roll). A reversal ends
 * the over at its onset as on csdr; RESET and DROP markers disarm the tracker with the full
 * evidence clear, so a phase jump across them is no reversal and the next over latches on fresh
 * evidence only.
 */
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EvidenceGateOptions } from "../../../../src/core/evidence-squelch/contract.js"
import {
	EVIDENCE_FADE_OUT_MS,
	evidenceDeviationHz,
} from "../../../../src/core/evidence-squelch/contract.js"
import { EvidenceGate } from "../../../../src/core/evidence-squelch/evidence-gate.js"
import { WKAF_FLAG_GATE_OPEN } from "../../../../src/core/evidence-squelch/framed-audio-parser.js"
import { PreRoll } from "../../../../src/core/evidence-squelch/pre-roll.js"
import { mulberry32 } from "../audio-tones/synth.js"
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
import { samples } from "./wiring-harness.js"

const OPTIONS: EvidenceGateOptions = {
	rate: FRAMED_RATE,
	modulation: "nfm",
	gain: 2,
	deviationHz: evidenceDeviationHz(12_500),
	drainLagSamples: 24,
}

const HZ = 100
const RATIO = FRAMED_RATE / 8_000
/** Tracker bounds (reverse-burst.test.ts, as evidence-gate-reverse.test.ts) in input samples. */
const ONSET_MIN = Math.floor(-121 * RATIO) - RATIO - 1
const ONSET_MAX = Math.ceil(-41 * RATIO) + RATIO + 1
/** Stage 1 opens here (after 0.3 s closed). */
const ONSET = Math.round(0.3 * FRAMED_RATE)
/** Reversal 2 s into the over, 150 ms before the carrier drop. */
const REV = ONSET + 2 * FRAMED_RATE
const BURST = Math.round(0.15 * FRAMED_RATE)
const TAIL = 1.5
const FADE = Math.round((FRAMED_RATE * EVIDENCE_FADE_OUT_MS) / 1_000)

/** A tone at FRAMED_RATE, reversed by `deg` from over sample `revAt` (or never), noise added. */
function tone(
	count: number,
	options: {
		revAt?: number
		deg?: number
		phase?: number
		noise?: number
		seed?: number
	} = {},
): Float32Array {
	const out = new Float32Array(count)
	const w = (2 * Math.PI * HZ) / FRAMED_RATE
	const step = ((options.deg ?? 180) * Math.PI) / 180
	const revAt = options.revAt ?? Number.MAX_SAFE_INTEGER
	const rand = mulberry32(options.seed ?? 1)
	const noise = options.noise ?? 0.018
	for (let n = 0; n < count; n++)
		out[n] =
			0.15 * Math.sin(w * n + (options.phase ?? 0) + (n >= revAt ? step : 0)) +
			noise * (2 * rand() - 1)
	return out
}

const closed = (seconds: number): OverSegment => ({
	pcm: new Float32Array(Math.round(FRAMED_RATE * seconds)),
	open: false,
	quietingDb: Number.NaN,
})
const over = (pcm: Float32Array): OverSegment => ({
	pcm,
	open: true,
	quietingDb: 30,
})

/** Reversal at REV, stage 1 closing (carrier drop) 150 ms later. */
const REVERSAL: Step[] = overSteps([
	closed(0.3),
	over(tone(REV - ONSET + BURST, { revAt: REV - ONSET })),
	closed(TAIL),
])

/** Gate observations: `endCause` at each STE back-mute, and the tracker tone at each full clear. */
interface GateLog {
	ends: Array<string | null>
	/** `reverseToneHz` and state just before each `reset()` that a full clear (RESET/DROP) made. */
	clears: Array<{ hz: number; state: string }>
	/** `reverseToneHz` right after each push that latched. */
	latchHz: number[]
}

let log: GateLog = { ends: [], clears: [], latchHz: [] }

beforeEach(() => {
	log = { ends: [], clears: [], latchHz: [] }
	const take = EvidenceGate.prototype.takeSteBack
	const reset = EvidenceGate.prototype.reset
	const push = EvidenceGate.prototype.push
	const clear = PreRoll.prototype.clear
	let lastReset: { hz: number; state: string } = { hz: 0, state: "waiting" }
	vi.spyOn(EvidenceGate.prototype, "takeSteBack").mockImplementation(function (
		this: EvidenceGate,
	): number {
		const back = take.call(this)
		if (back > 0) log.ends.push(this.endCause)
		return back
	})
	vi.spyOn(EvidenceGate.prototype, "push").mockImplementation(function (
		this: EvidenceGate,
		...args: Parameters<EvidenceGate["push"]>
	): number {
		const k = push.apply(this, args)
		if (k >= 0) log.latchHz.push(this.reverseToneHz)
		return k
	})
	vi.spyOn(EvidenceGate.prototype, "reset").mockImplementation(function (
		this: EvidenceGate,
	): void {
		lastReset = { hz: this.reverseToneHz, state: this.state }
		reset.call(this)
	})
	// The harness's full clear is `gate.reset()` then `preRoll.clear()`; nothing else clears.
	vi.spyOn(PreRoll.prototype, "clear").mockImplementation(function (
		this: PreRoll,
	): void {
		log.clears.push(lastReset)
		clear.call(this)
	})
})

afterEach(() => {
	vi.restoreAllMocks()
})

const onsets = (v: Verdicts): number[] => v.steMutes.map(m => m.at - m.back)

function comparable(v: Verdicts): Record<string, unknown> {
	return {
		latches: v.latches,
		steOnsets: onsets(v),
		firstPlayed: v.firstPlayed,
		lastPlayed: v.lastPlayed,
		client: v.client.toString("base64"),
	}
}

describe("A20 on a framed Rust run (A18)", () => {
	it("a 180° reverse burst 150 ms before the carrier drop ends the over at the reversal, as on csdr", () => {
		const ref = orderedReference(REVERSAL, OPTIONS)
		const refLog = log
		log = { ends: [], clears: [], latchHz: [] }
		const bytes = encodeFramed(REVERSAL)
		const got = framedConsumer(
			chunked(bytes, [27, 1_001, 40_000, bytes.length - 777]),
			OPTIONS,
		)
		expect(got.faults).toEqual([])
		expect(comparable(got)).toEqual(comparable(ref))
		// One CTCSS latch, one end, by the reverse-burst tracker, onset within the tracker bounds.
		expect(got.latches.length).toBe(1)
		expect(log.ends).toEqual(["reverse"])
		expect(refLog.ends).toEqual(["reverse"])
		const [onset] = onsets(got)
		expect(onset).toBeDefined()
		expect((onset ?? 0) - REV).toBeGreaterThanOrEqual(ONSET_MIN)
		expect((onset ?? 0) - REV).toBeLessThanOrEqual(ONSET_MAX)
		// The client is the over delayed by the pre-roll, up to the onset (faded), then nothing.
		const input = samples(
			Buffer.concat(REVERSAL.flatMap(s => (s.kind === "pcm" ? [s.bytes] : []))),
		)
		const client = samples(got.client)
		const delay = got.firstPlayed - input.findIndex(v => v !== 0)
		expect(delay).toBeGreaterThan(0)
		const end = got.lastPlayed - delay
		expect(end).toBeLessThan(onset ?? 0)
		expect(end).toBeGreaterThanOrEqual((onset ?? 0) - FADE - 1)
		for (let i = got.firstPlayed; i <= got.lastPlayed - FADE; i++)
			if (client[i] !== input[i - delay])
				expect([i, client[i]]).toEqual([i, input[i - delay]])
		// The csdr shape of the same audio: the same end and onset within one chunk plus the lag.
		log = { ends: [], clears: [], latchHz: [] }
		const chunk = 2_048
		const skew = chunk + 480 + (OPTIONS.drainLagSamples ?? 0)
		const csdr = csdrConsumer(REVERSAL, OPTIONS, chunk)
		expect(log.ends).toEqual(["reverse"])
		const [csdrOnset] = onsets(csdr)
		// The two onsets differ only by where stage 1 opened (at most one 40 ms tracker block).
		expect(Math.abs((csdrOnset ?? 0) - (onset ?? 0))).toBeLessThanOrEqual(
			320 * RATIO,
		)
		expect((csdrOnset ?? 0) - REV).toBeGreaterThanOrEqual(ONSET_MIN)
		expect((csdrOnset ?? 0) - REV).toBeLessThanOrEqual(ONSET_MAX)
		expect(Math.abs(csdr.lastPlayed - got.lastPlayed)).toBeLessThanOrEqual(skew)
	}, 60_000)

	/**
	 * A latched CTCSS over, a discontinuity at `at` (stage 1 stays open), then the same tone with
	 * its phase shifted by `jumpDeg` from `at` on, the carrier dropping 1.5 s later. `pastScale`
	 * scales the audio before `at` (a different past).
	 */
	function jumpScenario(
		kind: "reset" | "drop",
		at: number,
		jumpDeg: number,
		pastScale: number,
	): Step[] {
		const len = at - ONSET + Math.round(1.5 * FRAMED_RATE)
		// Over samples are whole 10 ms blocks.
		const blocks = Math.ceil(len / 480) * 480
		const pcm = tone(blocks, { revAt: at - ONSET, deg: jumpDeg }).map((v, i) =>
			i + ONSET < at ? v * pastScale : v,
		)
		return overSteps(
			[closed(0.3), over(pcm), closed(TAIL)],
			[
				{
					at,
					step: {
						kind,
						count: kind === "drop" ? 960 : 3,
						flags: WKAF_FLAG_GATE_OPEN,
					},
				},
			],
		)
	}

	for (const kind of ["reset", "drop"] as const)
		it(`${kind.toUpperCase()} while armed, then a phase jump across it: no reverse-burst end, a fresh latch, nothing held from before plays`, () => {
			const at = ONSET + Math.round(1.6 * FRAMED_RATE) + 123
			for (const jumpDeg of [180, 120, 90]) {
				// Control: without the marker the same jump is a reversal that ends the over.
				log = { ends: [], clears: [], latchHz: [] }
				const control = framedConsumer(
					[
						encodeFramed(
							jumpScenario(kind, at, jumpDeg, 1).filter(s => s.kind !== kind),
						),
					],
					OPTIONS,
				)
				expect([jumpDeg, log.ends]).toEqual([jumpDeg, ["reverse"]])
				expect([jumpDeg, control.steMutes.length]).toEqual([jumpDeg, 1])
				log = { ends: [], clears: [], latchHz: [] }
				const steps = jumpScenario(kind, at, jumpDeg, 1)
				const ref = orderedReference(steps, OPTIONS)
				log = { ends: [], clears: [], latchHz: [] }
				const bytes = encodeFramed(steps)
				const got = framedConsumer(
					chunked(bytes, [at, at * 2 + 37, 1_001, bytes.length - 999]),
					OPTIONS,
				)
				expect(got.faults).toEqual([])
				expect([jumpDeg, comparable(got)]).toEqual([jumpDeg, comparable(ref)])
				// The tracker was armed on the latched tone when the marker cleared everything.
				expect([jumpDeg, log.clears]).toEqual([
					jumpDeg,
					[{ hz: HZ, state: "open" }],
				])
				// The jump right after the clear is no reversal: no end at all.
				expect([jumpDeg, log.ends, got.steMutes]).toEqual([jumpDeg, [], []])
				// Two latches: the first before the marker, the next on fresh tone evidence after it,
				// re-arming the tracker on the tone.
				expect([jumpDeg, got.latches.length]).toEqual([jumpDeg, 2])
				expect(got.latches[0]).toBeLessThan(at)
				expect(got.latches[1]).toBeGreaterThan(at + FRAMED_RATE / 10)
				expect([jumpDeg, log.latchHz]).toEqual([jumpDeg, [HZ, HZ]])
				// Output from the marker on does not depend on the audio before it.
				const other = framedConsumer(
					[encodeFramed(jumpScenario(kind, at, jumpDeg, 0.5))],
					OPTIONS,
				)
				expect([
					jumpDeg,
					got.client.subarray(at * 2).equals(other.client.subarray(at * 2)),
				]).toEqual([jumpDeg, true])
				expect(other.latches.filter(l => l >= at)).toEqual(
					got.latches.filter(l => l >= at),
				)
			}
		}, 120_000)

	// Feature: evidence-squelch, Property 22: framed consumer equals the ordered reference
	// Validates: Requirements 9.8, A20.1, A20.3, A20.4
	it("any chunk split of the framed reversal gives the reference end position and client bytes", () => {
		const ref = comparable(orderedReference(REVERSAL, OPTIONS))
		const bytes = encodeFramed(REVERSAL)
		fc.assert(
			fc.property(
				fc.array(fc.nat(), { minLength: 0, maxLength: 60 }),
				fc.integer({ min: 1, max: 20_000 }),
				(seeds, stride) => {
					const cuts = [
						...seeds.map(s => s % bytes.length),
						...Array.from(
							{ length: Math.floor(bytes.length / stride) },
							(_, i) => (i + 1) * stride,
						),
					]
					const got = framedConsumer(chunked(bytes, cuts), OPTIONS)
					expect(got.faults).toEqual([])
					expect(comparable(got)).toEqual(ref)
				},
			),
			{ numRuns: 100 },
		)
	}, 300_000)
})
