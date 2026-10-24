/**
 * A20 reverse burst through the gate, the real wiring (`processEvidenceChunk`) and the real
 * pre-roll: arming, ending the over, one end per over, a retained latch across a short close
 * (drained pre-roll, restarted tracker), false-detection recovery and its conditional cost, the
 * CTCSS bank's blocks around a reversal, and the short-burst fallback to the A16 tail mute.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CTCSS_HZ } from "../../../../src/core/audio-tones/ctcss.js"
import {
	EVIDENCE_FADE_OUT_MS,
	EVIDENCE_NOTE_DISCARD,
} from "../../../../src/core/evidence-squelch/contract.js"
import { EvidenceGate } from "../../../../src/core/evidence-squelch/evidence-gate.js"
import { PreRoll } from "../../../../src/core/evidence-squelch/pre-roll.js"
import { processEvidenceChunk } from "../../../../src/core/evidence-squelch/wiring.js"
import type { EvidenceWiring } from "../../../../src/core/evidence-squelch/wiring.js"
import { mulberry32 } from "../audio-tones/synth.js"
import { dcsMix, toPcm, voiceLike, whiteNoise } from "./synthetic.js"
import { referencePreRoll, samples } from "./wiring-harness.js"
import type { ModelTag } from "./wiring-harness.js"

const RATE = 25_000
const BLOCK_BYTES = 500
const FADE = Math.round((RATE * EVIDENCE_FADE_OUT_MS) / 1_000)
const RATIO = RATE / 8_000
/** Tracker bounds (reverse-burst.test.ts) in input samples, plus one decimation group. */
const ONSET_MIN = Math.floor(-121 * RATIO) - 4
const ONSET_MAX = Math.ceil(-41 * RATIO) + 4
const DECISION_MAX = Math.ceil(892 * RATIO) + 4

interface Seg {
	pcm: Buffer
	open: boolean
	quieted: boolean
}

/** The live client path (as `WiredGate`), with the A20 switch and a `muteTail` counter. */
class Wired {
	readonly gate: EvidenceGate
	readonly preRoll = new PreRoll({ rate: RATE, format: "s16le" })
	private readonly wiring: EvidenceWiring
	private phase = 0
	private wasOpen = false
	private bytesIn = 0
	private chunkStart = 0
	latchSample = -1
	muteTails = 0
	readonly out: Buffer[] = []
	/** `endCause` after each 10 ms block. */
	readonly causes: (string | null)[] = []

	constructor(reverseBurst = true) {
		this.gate = new EvidenceGate({
			rate: RATE,
			modulation: "nfm",
			gain: 2,
			deviationHz: 2_500,
			drainLagSamples: 1,
			reverseBurst,
		})
		const gate = this.gate
		const push = gate.push.bind(gate)
		gate.push = (pcm, format, start, end): number => {
			const k = push(pcm, format, start, end)
			if (k >= 0 && this.latchSample < 0)
				this.latchSample = Math.floor((this.chunkStart + k) / 2)
			return k
		}
		const preRoll = this.preRoll
		const mute = preRoll.muteTail.bind(preRoll)
		preRoll.muteTail = (n: number, fade: number): void => {
			this.muteTails += 1
			mute(n, fade)
		}
		this.wiring = { gate, preRoll, tailTag: "drop", aligned: false }
	}

	block(bytes: Buffer, open: boolean, quieted: boolean, cuts: number[]): void {
		if (this.wasOpen && !open && this.gate.state === "waiting") {
			this.gate.reset()
			this.preRoll.abandon()
		}
		this.wasOpen = open
		let from = 0
		for (const to of [
			...cuts.filter(c => c > 0 && c < bytes.length),
			bytes.length,
		]) {
			const chunk = Buffer.from(bytes.subarray(from, to))
			this.chunkStart = this.bytesIn
			this.bytesIn += chunk.length
			processEvidenceChunk(this.wiring, chunk, this.phase, open, "s16le", RATE)
			this.phase = (this.phase + chunk.length) % 4
			this.out.push(chunk)
			from = to
		}
		if (open && (this.gate.noteBlock(quieted) & EVIDENCE_NOTE_DISCARD) !== 0)
			this.preRoll.abandon()
		this.causes.push(this.gate.endCause)
	}

	segments(
		segs: readonly Seg[],
		cuts: (block: number) => number[] = () => [],
	): void {
		let index = 0
		for (const seg of segs)
			for (let s = 0; s < seg.pcm.length; s += BLOCK_BYTES) {
				this.block(
					seg.pcm.subarray(s, Math.min(seg.pcm.length, s + BLOCK_BYTES)),
					seg.open,
					seg.quieted,
					cuts(index),
				)
				index += 1
			}
	}

	received(): number[] {
		return samples(Buffer.concat(this.out))
	}
}

/** A tone at RATE: `amplitude`, `phase`, reversed by `deg` from sample `revAt` (or never). */
function tone(
	hz: number,
	count: number,
	options: {
		revAt?: number
		deg?: number
		phase?: number
		amplitude?: number
		errorHz?: number
		noise?: number
		seed?: number
	} = {},
): Float32Array {
	const out = new Float32Array(count)
	const w = (2 * Math.PI * (hz + (options.errorHz ?? 0))) / RATE
	const step = ((options.deg ?? 180) * Math.PI) / 180
	const revAt = options.revAt ?? Number.MAX_SAFE_INTEGER
	const rand = mulberry32(options.seed ?? 1)
	const noise = options.noise ?? 0
	for (let n = 0; n < count; n++)
		out[n] =
			(options.amplitude ?? 0.15) *
				Math.sin(w * n + (options.phase ?? 0) + (n >= revAt ? step : 0)) +
			noise * (2 * rand() - 1)
	return out
}

function add(a: Float32Array, b: Float32Array): Float32Array {
	return Float32Array.from(a, (v, i) => v + (b[i] ?? 0))
}

const pcm = (x: Float32Array): Buffer => toPcm(x, "s16le")
const closed = (seconds: number): Seg => ({
	pcm: Buffer.alloc(Math.round(RATE * seconds) * 2),
	open: false,
	quieted: false,
})
const noiseSeg = (seconds: number, seed: number): Seg => ({
	pcm: pcm(whiteNoise({ rate: RATE, seconds, seed, level: 0.9 })),
	open: true,
	quieted: false,
})

describe("A20: reverse burst through the gate", () => {
	it("arms only on a CTCSS latch or renewal, at the latched tone; never on voice or DCS", () => {
		const w = new Wired()
		w.segments([{ pcm: pcm(tone(67, RATE * 1.5)), open: true, quieted: true }])
		expect([w.gate.state, w.gate.evidence]).toEqual(["open", "ctcss"])
		expect(w.gate.reverseToneHz).toBe(67)
		// Renewal to another standard tone re-arms on it.
		w.segments([{ pcm: pcm(tone(100, RATE * 1.5)), open: true, quieted: true }])
		expect(w.gate.reverseToneHz).toBe(100)
		const v = new Wired()
		v.segments([
			{
				pcm: pcm(voiceLike({ rate: RATE, seconds: 2, seed: 31, level: 0.8 })),
				open: true,
				quieted: true,
			},
		])
		expect(v.gate.state).toBe("open")
		expect(v.gate.reverseToneHz).toBe(0)
		const d = new Wired()
		d.segments([
			{
				pcm: pcm(
					dcsMix({ rate: RATE, seconds: 2, code: 0o23, polarity: "normal" }),
				),
				open: true,
				quieted: true,
			},
		])
		expect(d.gate.reverseToneHz).toBe(0)
		// Waiting (nothing latched yet) and after a reset: disarmed.
		expect(new Wired().gate.reverseToneHz).toBe(0)
		w.gate.reset()
		expect(w.gate.reverseToneHz).toBe(0)
	})

	// Feature: evidence-squelch, Property 21: reverse burst ends the over
	// Validates: Requirements A20.3, A20.4
	it("Property 21: for any tone, error, phase, reversal, burst and chunking, the client output is the over up to the onset (faded) and nothing after", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: CTCSS_HZ.length - 1 }),
				fc.double({ min: -0.5, max: 0.5, noNaN: true }),
				fc.double({ min: 0, max: 6.28, noNaN: true }),
				fc.constantFrom(120, 180),
				fc.integer({ min: 0, max: 999 }),
				fc.integer({ min: 150, max: 200 }),
				fc.integer({ min: 1, max: 100_000 }),
				fc.integer({ min: 0, max: 3 }),
				(index, errorHz, phase, deg, offset, burstMs, seed, cutsPerBlock) => {
					const hz = CTCSS_HZ[index] ?? 67
					const rev = 2 * RATE + offset
					const overLen = rev + Math.round((RATE * burstMs) / 1_000)
					const over = pcm(
						tone(hz, overLen, {
							revAt: rev,
							deg,
							phase,
							errorHz,
							noise: 0.018,
							seed,
						}),
					)
					const noise = noiseSeg(0.3, seed + 1)
					const tail = closed(1)
					const rand = mulberry32(seed)
					const w = new Wired()
					w.segments(
						[{ pcm: over, open: true, quieted: true }, noise, tail],
						b => {
							if (b === 0) return [27]
							const out: number[] = []
							for (let i = 0; i < cutsPerBlock; i++)
								out.push(1 + Math.floor(rand() * (BLOCK_BYTES - 1)))
							return out.sort((a, c) => a - c)
						},
					)
					const overBlocks = Math.ceil(over.length / BLOCK_BYTES)
					expect(w.causes[overBlocks - 1]).toBe("reverse")
					expect(w.muteTails).toBe(1)
					const onset = w.gate.steOnset
					expect(onset - rev).toBeGreaterThanOrEqual(ONSET_MIN)
					expect(onset - rev).toBeLessThanOrEqual(ONSET_MAX)
					const input = samples(Buffer.concat([over, noise.pcm, tail.pcm]))
					const closeAt = (over.length + noise.pcm.length) / 2
					const values = input.map((v, i) => {
						const j = onset - i
						return j >= 1 && j <= FADE
							? Math.round((v * j) / (FADE + 1)) || 0
							: v
					})
					const tags: ModelTag[] = input.map((_, i) =>
						i < w.latchSample
							? "pending"
							: i < onset
								? "pass"
								: i < closeAt
									? "pending"
									: "drop",
					)
					const events = new Map<number, "latch" | "abandon">([
						[w.latchSample, "latch"],
						[closeAt, "abandon"],
					])
					expect(w.received()).toEqual(
						referencePreRoll(values, tags, events, RATE * 1.5),
					)
				},
			),
			{ numRuns: 100 },
		)
	}, 300_000)

	// Feature: evidence-squelch, Property 23: one end per over
	// Validates: Requirements A20.5
	it("Property 23: within one uninterrupted hold, a 55 Hz STE and a reverse burst in either order end the over once", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.integer({ min: 0, max: 300 }),
				fc.integer({ min: 0, max: 2 }),
				fc.integer({ min: 1, max: 100_000 }),
				(reverseFirst, spacingMs, toneIndex, seed) => {
					const hz = [67, 100, 151.4][toneIndex] ?? 67
					const start = 2 * RATE
					const spacing = Math.round((RATE * spacingMs) / 1_000)
					const revAt = reverseFirst ? start : start + spacing
					const steAt = reverseFirst ? start + spacing : start
					const total = Math.max(revAt, steAt) + Math.round(RATE * 0.45)
					// The CTCSS tone drops to 0.2 of its level while the 55 Hz tone sounds (A17 revision).
					const x = tone(hz, total, {
						revAt,
						phase: seed % 6,
						noise: 0.01,
						seed,
					})
					for (let n = steAt; n < total; n++)
						x[n] =
							0.2 * (x[n] ?? 0) + 0.12 * Math.sin((2 * Math.PI * 55 * n) / RATE)
					const w = new Wired()
					w.segments([
						{ pcm: pcm(x), open: true, quieted: true },
						noiseSeg(0.2, seed),
						closed(0.5),
					])
					expect(w.muteTails).toBe(1)
					const first = w.causes.findIndex(c => c !== null)
					expect(first).toBeGreaterThanOrEqual(0)
					const cause = w.causes[first]
					const heldBlocks = Math.ceil((total * 2) / BLOCK_BYTES) + 20
					for (let b = first; b < heldBlocks; b++)
						expect(w.causes[b]).toBe(cause)
				},
			),
			{ numRuns: 100 },
		)
	}, 300_000)

	it("a retained latch across a short close: the tracker restarts (a reopen phase jump is no reversal) and same-tone resumption detects a later reversal", () => {
		for (const gapMs of [20, 100, 300, 700, 1_000])
			for (const reopenPhase of [0, 1.3, 3.14, 4.4]) {
				const w = new Wired()
				w.segments([
					{ pcm: pcm(tone(127.3, RATE * 1.5)), open: true, quieted: true },
					closed(gapMs / 1_000),
				])
				const reopen = Math.round(RATE * 1.5)
				const rev = reopen
				w.segments([
					{
						pcm: pcm(tone(127.3, rev, { phase: reopenPhase })),
						open: true,
						quieted: true,
					},
				])
				expect([
					gapMs,
					w.gate.state,
					w.gate.endCause,
					w.gate.reverseToneHz,
				]).toEqual([gapMs, "open", null, 127.3])
				w.segments([
					{
						pcm: pcm(
							tone(127.3, RATE * 0.2, {
								phase:
									reopenPhase + (2 * Math.PI * 127.3 * rev) / RATE + Math.PI,
							}),
						),
						open: true,
						quieted: true,
					},
				])
				expect([gapMs, reopenPhase, w.gate.endCause]).toEqual([
					gapMs,
					reopenPhase,
					"reverse",
				])
			}
	})

	it("a drained pre-roll after a short close limits the retroactive mute to what is queued; nothing plays after the decision", () => {
		const w = new Wired()
		const first = pcm(tone(67, RATE * 1.5))
		// A close longer than the tone latch's 0.75 s delay plays the queue out; the latch is kept.
		const gap = closed(1)
		const rev = RATE * 1
		const after = pcm(
			tone(67, rev + Math.round(RATE * 0.18), { revAt: rev, phase: 2 }),
		)
		w.segments([
			{ pcm: first, open: true, quieted: true },
			gap,
			{ pcm: after, open: true, quieted: true },
		])
		expect(w.gate.endCause).toBe("reverse")
		expect(w.muteTails).toBe(1)
		w.segments([noiseSeg(0.3, 9), closed(0.5)])
		const out = w.received()
		const base = (first.length + gap.pcm.length) / 2
		const revStream = base + rev
		const decided = revStream + DECISION_MAX + RATE / 100
		const input = samples(Buffer.concat([first, gap.pcm, after]))
		const lagOf = (t: number): number => {
			for (let d = 0; d < RATE * 2; d++) {
				let ok = true
				for (let i = t; i < t + 200; i++)
					if (out[i] !== input[i - d]) ok = false
				if (ok) return d
			}
			return -1
		}
		// The queue was drained by the close: the reopened over plays at delay 0.
		expect(lagOf(base + 2_000)).toBe(0)
		expect(lagOf(revStream - 3_000)).toBe(0)
		// The over plays live up to the onset...
		expect(
			out.slice(revStream - 2_000, revStream - 1_000).some(v => v !== 0),
		).toBe(true)
		// ...the span between onset and decision may have played (A20.4 limit, at most the
		// decision latency), and nothing plays after the decision.
		expect(out.slice(decided).every(v => v === 0)).toBe(true)
		const played = out.slice(revStream, decided).filter(v => v !== 0).length
		expect(played).toBeLessThanOrEqual(DECISION_MAX + RATE / 100)
	})

	it("a false detection mid-over (tone and voice continue) holds the audio and replays it on fresh evidence", () => {
		const total = RATE * 5
		const rev = RATE * 2
		const x = add(
			tone(88.5, total, { revAt: rev, amplitude: 0.15 }),
			voiceLike({ rate: RATE, seconds: 5, seed: 7, level: 0.25 }),
		)
		const w = new Wired()
		w.segments([{ pcm: pcm(x), open: true, quieted: true }])
		const held = w.causes.findIndex(c => c === "reverse")
		expect(held).toBeGreaterThan(0)
		// Fresh evidence (the tone requalifies, or voice) resumes the over: open, no hold.
		expect([w.gate.state, w.gate.muted]).toEqual(["open", false])
		const out = w.received()
		// Held audio replays: the last second of output is audio, not silence.
		expect(out.slice(-RATE).filter(v => v !== 0).length).toBeGreaterThan(
			RATE / 2,
		)
	})

	it("conditional cost: when stage 1 closes before fresh evidence, the held audio after the onset is lost", () => {
		const rev = RATE * 2
		const x = add(
			tone(88.5, rev + Math.round(RATE * 0.4), { revAt: rev }),
			voiceLike({ rate: RATE, seconds: 2.4, seed: 7, level: 0.25 }),
		)
		const w = new Wired()
		w.segments([{ pcm: pcm(x), open: true, quieted: true }, closed(2)])
		const onset = w.gate.steOnset
		expect(onset).toBeGreaterThan(rev + ONSET_MIN)
		expect(onset).toBeLessThan(rev + ONSET_MAX)
		// Nothing from the onset on was ever played: the played sample count is at most the onset.
		const out = w.received()
		expect(out.filter(v => v !== 0).length).toBeLessThanOrEqual(onset)
		expect(out.slice(-RATE).every(v => v === 0)).toBe(true)
	})

	it("the CTCSS bank's blocks around a reversal never resume the latch during the burst (reversal at every 25 ms of a 250 ms hop)", () => {
		for (let j = 0; j < 10; j++) {
			const rev = 2 * RATE + Math.round((RATE * 25 * j) / 1_000)
			const w = new Wired()
			w.segments([
				{
					pcm: pcm(tone(67, rev + Math.round(RATE * 0.2), { revAt: rev })),
					open: true,
					quieted: true,
				},
				noiseSeg(0.3, j + 1),
			])
			const first = w.causes.findIndex(c => c === "reverse")
			expect([j, first > 0]).toEqual([j, true])
			for (let b = first; b < w.causes.length; b++)
				expect([j, b, w.causes[b]]).toEqual([j, b, "reverse"])
			expect(w.gate.muted).toBe(true)
		}
	})

	it("a reversal while carrier evidence is lost (A16 guard on tone pass) still mutes from the onset", () => {
		const rev = 2 * RATE
		const x = tone(67, rev + Math.round(RATE * 0.18), { revAt: rev })
		const lostAt = rev - Math.round(RATE * 0.2)
		const w = new Wired()
		w.segments([
			{ pcm: pcm(x.subarray(0, lostAt)), open: true, quieted: true },
			{ pcm: pcm(x.subarray(lostAt)), open: true, quieted: false },
			closed(1),
		])
		expect(w.muteTails).toBe(1)
		const onset = w.gate.steOnset
		expect(onset - rev).toBeGreaterThanOrEqual(ONSET_MIN)
		expect(onset - rev).toBeLessThanOrEqual(ONSET_MAX)
		expect(w.received().filter(v => v !== 0).length).toBeLessThanOrEqual(onset)
	})

	it("fallback: a 50 ms burst with stage 1 closing at the carrier drop ends through A16, byte-identical to the gate without A20", () => {
		// Pinned: reversal at stream sample 50 000 (2.0 s), 10 ms blocks, no cuts; stage 1 closes
		// at the carrier drop. The smallest measured decision latency is 520 samples at 8 kHz
		// (65 ms), so the tracker cannot decide inside 50 ms.
		const rev = 2 * RATE
		const over = pcm(tone(67, rev + Math.round(RATE * 0.05), { revAt: rev }))
		const run = (on: boolean): number[] => {
			const w = new Wired(on)
			w.segments([{ pcm: over, open: true, quieted: true }, closed(1)])
			expect(w.muteTails).toBe(0)
			return w.received()
		}
		expect(run(true)).toEqual(run(false))
	})
})
