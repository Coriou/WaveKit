import {
	DCS_STANDARD_CODES,
	LIVE_AUDIO_AUTO_SQUELCH_HANG_MS,
} from "@wavekit/api-types"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CTCSS_HZ } from "../../../../src/core/audio-tones/ctcss.js"
import { packDcs } from "../../../../src/core/audio-tones/dcs.js"
import {
	msToSamples,
	pcmSampleBytes,
} from "../../../../src/core/evidence-squelch/contract.js"
import type { EvidencePcmFormat } from "../../../../src/core/evidence-squelch/contract.js"
import {
	EvidenceGate,
	judgeEvidence,
} from "../../../../src/core/evidence-squelch/evidence-gate.js"
import type { ToneReading } from "../../../../src/core/evidence-squelch/tone-evidence.js"
import { classifyAnalogTrial } from "../../../../src/core/scanner/analog-trial.js"
import type {
	AnalogTrialFrame,
	AnalogTrialStats,
	AnalogTrialTones,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { mulberry32 } from "../audio-tones/synth.js"
import {
	carrierSilence,
	ctcssMix,
	fskBursts,
	mix,
	toPcm,
	voiceLike,
	whiteNoise,
} from "./synthetic.js"

const RATE = 8_000
const BLOCK_SAMPLES = RATE / 100
const HANG = msToSamples(LIVE_AUDIO_AUTO_SQUELCH_HANG_MS, RATE)

// ---------------------------------------------------------------- judge-level helpers

interface VoiceStats {
	syllabic: number
	audioDb: number
	cluster: number
}

const voiceStatsArb: fc.Arbitrary<VoiceStats> = fc.record({
	syllabic: fc.double({ min: 0, max: 2, noNaN: true }),
	audioDb: fc.double({ min: -60, max: 0, noNaN: true }),
	cluster: fc.double({ min: 0, max: 1, noNaN: true }),
})

type ToneGen =
	| { kind: "none" }
	| { kind: "ctcss"; hz: number; index: number }
	| { kind: "dcs"; code: string; polarity: "normal" | "inverted" }

const toneGenArb: fc.Arbitrary<ToneGen> = fc.oneof(
	fc.constant<ToneGen>({ kind: "none" }),
	fc.integer({ min: 0, max: CTCSS_HZ.length - 1 }).map<ToneGen>(index => ({
		kind: "ctcss",
		index,
		hz: CTCSS_HZ[index] ?? 0,
	})),
	fc
		.constantFrom(61.2, 300.5, 1_000)
		.map<ToneGen>(hz => ({ kind: "ctcss", index: -1, hz })),
	fc.record({
		kind: fc.constant("dcs" as const),
		code: fc.oneof(
			fc.constantFrom(...DCS_STANDARD_CODES),
			fc.constantFrom("000", "001", "777"),
		),
		polarity: fc.constantFrom("normal" as const, "inverted" as const),
	}),
)

function toneReading(tone: ToneGen): ToneReading | null {
	if (tone.kind === "none") return null
	if (tone.kind === "ctcss")
		return { kind: "ctcss", index: tone.index, hz: tone.hz }
	const dcs = { code: tone.code, polarity: tone.polarity }
	return { kind: "dcs", packed: packDcs(dcs), dcs }
}

function oracleTones(tone: ToneGen, audioMs: number): AnalogTrialTones {
	return {
		ctcssHz: tone.kind === "ctcss" ? tone.hz : null,
		dcs:
			tone.kind === "dcs" ? { code: tone.code, polarity: tone.polarity } : null,
		audioSeconds: audioMs / 1_000,
	}
}

function gateFrames(stats: readonly VoiceStats[]): AnalogTrialFrame[] {
	return stats.map(s => ({ carrierDb: 0, hfNoiseDb: 0, ...s }))
}

describe("evidence gate properties", () => {
	// Feature: evidence-squelch, Property 1: Monotone in evidence
	// Validates: Requirements 1.2, 1.3
	it("Property 1: more voice-like evidence never opens later", () => {
		const FRAMES = 40
		const BLOCKS_PER_FRAME = 5
		const delta = fc.record({
			syllabic: fc.double({ min: 0, max: 1, noNaN: true }),
			audioDb: fc.double({ min: 0, max: 30, noNaN: true }),
			cluster: fc.double({ min: 0, max: 0.5, noNaN: true }),
		})
		const toneAt = fc.option(fc.integer({ min: 0, max: FRAMES - 1 }), {
			nil: null,
		})
		fc.assert(
			fc.property(
				fc.array(voiceStatsArb, { minLength: FRAMES, maxLength: FRAMES }),
				fc.array(delta, { minLength: FRAMES, maxLength: FRAMES }),
				fc.array(fc.boolean(), {
					minLength: FRAMES * BLOCKS_PER_FRAME,
					maxLength: FRAMES * BLOCKS_PER_FRAME,
				}),
				fc.array(fc.boolean(), {
					minLength: FRAMES * BLOCKS_PER_FRAME,
					maxLength: FRAMES * BLOCKS_PER_FRAME,
				}),
				toneAt,
				fc.integer({ min: 0, max: FRAMES - 1 }),
				fc.constantFrom("nfm" as const, "am" as const),
				(
					base,
					deltas,
					quietBase,
					quietExtra,
					baseTone,
					earlier,
					modulation,
				) => {
					const better = base.map((f, i) => {
						const d = deltas[i] ?? { syllabic: 0, audioDb: 0, cluster: 0 }
						return {
							syllabic: f.syllabic + d.syllabic,
							audioDb: f.audioDb + d.audioDb,
							cluster: Math.max(0, f.cluster - d.cluster),
						}
					})
					const quietBetter = quietBase.map(
						(q, i) => q || (quietExtra[i] ?? false),
					)
					const betterTone =
						baseTone === null ? earlier : Math.min(baseTone, earlier)
					const worse = openFrame(base, quietBase, baseTone, modulation)
					const best = openFrame(better, quietBetter, betterTone, modulation)
					if (worse !== null) expect(best).not.toBeNull()
					if (worse !== null && best !== null)
						expect(best).toBeLessThanOrEqual(worse)
				},
			),
			{ numRuns: 100 },
		)

		function openFrame(
			frames: VoiceStats[],
			quiet: boolean[],
			toneFrom: number | null,
			modulation: "nfm" | "am",
		): number | null {
			const tone: ToneReading = {
				kind: "ctcss",
				index: 0,
				hz: CTCSS_HZ[0] ?? 0,
			}
			for (let i = 0; i < frames.length; i++) {
				const audioMs = (i + 1) * 50
				const window = frames.slice(Math.max(0, i - 19), i + 1)
				const blocks = quiet.slice(
					Math.max(0, (i + 1) * BLOCKS_PER_FRAME - 100),
					(i + 1) * BLOCKS_PER_FRAME,
				)
				const verdict = judgeEvidence({
					modulation,
					stats: {
						mode: modulation,
						frames: gateFrames(window),
						gapSamples: 0,
						floorDb: 0,
					},
					tone: toneFrom !== null && i >= toneFrom ? tone : null,
					audioMs,
					quietBlocks: blocks.filter(Boolean).length,
					notedBlocks: blocks.length,
					// The gate judges voice only on a full window: a partial window is tone-only.
					framesFinite: window.length === 20,
				})
				if (verdict !== null) return i
			}
			return null
		}
	})

	// Feature: evidence-squelch, Property 2: Judge agreement
	// Validates: Requirements 1.2, 1.3, 1.4
	it("Property 2: judgeEvidence agrees with classifyAnalogTrial", () => {
		const nonFiniteArb = fc.option(
			fc.record({
				frame: fc.integer({ min: 0, max: 19 }),
				field: fc.constantFrom(
					"syllabic" as const,
					"audioDb" as const,
					"cluster" as const,
				),
				value: fc.constantFrom(NaN, Infinity, -Infinity),
			}),
			{ freq: 4, nil: null },
		)
		const caseArb = fc.integer({ min: 0, max: 100 }).chain(notedBlocks =>
			fc.record({
				modulation: fc.constantFrom("nfm" as const, "am" as const),
				frames: fc.array(voiceStatsArb, { minLength: 20, maxLength: 20 }),
				tone: toneGenArb,
				audioMs: fc.integer({ min: 0, max: 3_000 }),
				notedBlocks: fc.constant(notedBlocks),
				quietBlocks: fc.integer({ min: 0, max: notedBlocks }),
				nonFinite: nonFiniteArb,
			}),
		)
		fc.assert(
			fc.property(caseArb, c => {
				const voice = c.frames.map(f => ({ ...f }))
				const framesFinite = c.nonFinite === null
				if (c.nonFinite !== null) {
					const frame = voice[c.nonFinite.frame]
					if (frame !== undefined) frame[c.nonFinite.field] = c.nonFinite.value
				}
				// A10: a qualified tone with a non-finite frame is outside the iff.
				const tone: ToneGen = framesFinite ? c.tone : { kind: "none" }
				const quietFrames =
					c.notedBlocks === 0
						? 0
						: Math.floor((20 * c.quietBlocks) / c.notedBlocks)
				const oracleFrames: AnalogTrialFrame[] = voice.map((f, i) =>
					c.modulation === "nfm"
						? { ...f, carrierDb: -20, hfNoiseDb: i < quietFrames ? -10 : 0 }
						: { ...f, hfNoiseDb: 0, carrierDb: i < quietFrames ? -50 : -60 },
				)
				const oracleStats: AnalogTrialStats = {
					mode: c.modulation,
					frames: oracleFrames,
					gapSamples: 0,
					floorDb: -60,
				}
				const oracleToneRecord: AnalogTrialTones =
					c.modulation === "nfm"
						? oracleTones(tone, c.audioMs)
						: { ctcssHz: null, dcs: null, audioSeconds: c.audioMs / 1_000 }
				const outcome = classifyAnalogTrial(oracleStats, oracleToneRecord)
				const verdict = judgeEvidence({
					modulation: c.modulation,
					stats: {
						mode: c.modulation,
						frames: gateFrames(voice),
						gapSamples: 0,
						floorDb: 0,
					},
					tone: toneReading(tone),
					audioMs: c.audioMs,
					quietBlocks: c.quietBlocks,
					notedBlocks: c.notedBlocks,
					framesFinite,
				})
				expect(verdict !== null).toBe(
					outcome === "decoded" || outcome === "heard",
				)
				if (outcome === "decoded")
					expect(verdict).toBe(tone.kind === "none" ? null : tone.kind)
				if (outcome === "heard") expect(verdict).toBe("voice")
			}),
			{ numRuns: 300 },
		)
	})
})

// ---------------------------------------------------------------- stream-level driver

interface Run {
	samples: number
	open: boolean
}

interface Observation {
	/** Sample index (stream) just past the latching sample, per latch. */
	latches: number[]
	/** Gate state at sample index (stream position after that many samples), per call end. */
	states: Map<number, "waiting" | "open">
	/** Total guard bytes reported. */
	guardBytes: number
}

/**
 * Feed `pcm` with a stage-1 schedule. Bytes are cut at chunk boundaries (`chunks`, cycled),
 * at stage-1 edges and, while open, at each 10 ms block start where `carrier(block)` is noted
 * first. On an open→closed edge without a latch the wiring's `reset()` is called.
 * `rewrite` runs after each push on the pushed range (a pre-roll stub rewriting the chunk).
 */
function drive(
	gate: EvidenceGate,
	pcm: Buffer,
	format: EvidencePcmFormat,
	runs: readonly Run[],
	chunks: readonly number[],
	carrier: (block: number) => boolean,
	rewrite?: (buf: Buffer, start: number, end: number) => void,
): Observation {
	const width = pcmSampleBytes(format)
	const cuts = new Set<number>([0, pcm.length])
	const openAt: { start: number; end: number }[] = []
	let sample = 0
	for (const run of runs) {
		const start = sample * width
		sample += run.samples
		const end = Math.min(pcm.length, sample * width)
		if (start >= pcm.length) break
		cuts.add(start)
		cuts.add(end)
		if (run.open) {
			openAt.push({ start, end })
			for (let b = start; b < end; b += BLOCK_SAMPLES * width) cuts.add(b)
		}
	}
	let at = 0
	for (let i = 0; at < pcm.length; i++) {
		at += Math.max(1, chunks[i % chunks.length] ?? 1)
		cuts.add(Math.min(at, pcm.length))
	}
	const sorted = [...cuts].sort((a, b) => a - b)
	const latches: number[] = []
	const states = new Map<number, "waiting" | "open">()
	let guardBytes = 0
	let wasOpen = false
	for (let i = 0; i + 1 < sorted.length; i++) {
		const start = sorted[i] ?? 0
		const end = sorted[i + 1] ?? 0
		const run = openAt.find(r => start >= r.start && start < r.end)
		const open = run !== undefined
		if (wasOpen && !open && gate.state === "waiting") gate.reset()
		wasOpen = open
		if (open) {
			const offset = start - run.start
			if (offset % (BLOCK_SAMPLES * width) === 0)
				gate.noteBlock(carrier(Math.floor(start / (BLOCK_SAMPLES * width))))
			const latch = gate.push(pcm, format, start, end)
			if (latch >= 0) latches.push(Math.floor(latch / width))
			rewrite?.(pcm, start, end)
		} else {
			guardBytes += gate.closed(end - start, format)
		}
		if (end % width === 0) states.set(end / width, gate.state)
	}
	return { latches, states, guardBytes }
}

function runsArb(totalSamples: number): fc.Arbitrary<Run[]> {
	return fc
		.array(
			fc.record({
				samples: fc.integer({ min: 1, max: totalSamples }),
				open: fc.boolean(),
			}),
			{ minLength: 1, maxLength: 6 },
		)
		.map(runs => [...runs, { samples: totalSamples, open: true }])
}

const chunksArb = fc.array(fc.integer({ min: 1, max: 700 }), {
	minLength: 1,
	maxLength: 8,
})

/** 4-level NRZ baseband (DMR-like 4FSK as the discriminator delivers it). */
function nrz4(seconds: number, seed: number): Float32Array {
	const rand = mulberry32(seed)
	const out = new Float32Array(Math.round(RATE * seconds))
	let level = 0
	let next = 0
	for (let i = 0; i < out.length; i++) {
		if (i >= next) {
			level = [-1, -1 / 3, 1 / 3, 1][Math.floor(rand() * 4)] ?? 0
			next += RATE / 4_800
		}
		out[i] = 0.8 * level
	}
	return out
}

function sine(hz: number, seconds: number, amplitude: number): Float32Array {
	const out = new Float32Array(Math.round(RATE * seconds))
	for (let i = 0; i < out.length; i++)
		out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)
	return out
}

const SECONDS = 2.5
const TOTAL = Math.round(RATE * SECONDS)

describe("evidence gate stream properties", () => {
	// Feature: evidence-squelch, Property 3: Bare carrier and data never open
	// Validates: Requirements 1.4
	it("Property 3: bare carrier and data never open", () => {
		const signals: { pcm: Float32Array; carrier: boolean }[] = [
			{ pcm: new Float32Array(TOTAL), carrier: true },
			{ pcm: carrierSilence({ rate: RATE, seconds: SECONDS }), carrier: true },
			{ pcm: sine(1_000, SECONDS, 0.5), carrier: true },
			{ pcm: sine(60, SECONDS, 0.3), carrier: true },
			{
				pcm: whiteNoise({ rate: RATE, seconds: SECONDS, seed: 4, level: 0.5 }),
				carrier: false,
			},
			{
				pcm: voiceLike({ rate: RATE, seconds: SECONDS, seed: 3, level: 0.8 }),
				carrier: false,
			},
			{ pcm: nrz4(SECONDS, 8), carrier: true },
			// Audio FSK on a quiet carrier that must reject: continuous, and TDMA-like 30 ms
			// bursts (syllabic-rate bursts are escalated; see evidence-gate.test.ts).
			...(
				[
					[2, 1_200, 1_000, 0],
					[4, 4_800, 1_000, 0],
					[2, 512, 30, 30],
					[4, 4_800, 30, 30],
				] as const
			).map(([levels, baud, burstMs, gapMs]) => ({
				pcm: fskBursts({
					rate: RATE,
					seconds: SECONDS,
					levels,
					baud,
					burstMs,
					gapMs,
					seed: 6,
				}),
				carrier: true,
			})),
			{
				pcm: fskBursts({
					rate: RATE,
					seconds: SECONDS,
					levels: 4,
					baud: 4_800,
					burstMs: 1_000,
					gapMs: 0,
					seed: 5,
				}),
				carrier: false,
			},
		]
		const buffers = signals.map(s => ({
			s16le: toPcm(s.pcm, "s16le"),
			f32le: toPcm(s.pcm, "f32le"),
			carrier: s.carrier,
		}))
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: signals.length - 1 }),
				fc.constantFrom("s16le" as const, "f32le" as const),
				runsArb(TOTAL),
				chunksArb,
				fc.constantFrom("nfm" as const, "am" as const),
				(which, format, runs, chunks, modulation) => {
					const signal = buffers[which]
					if (signal === undefined) return
					const gate = new EvidenceGate({ rate: RATE, modulation, gain: 2 })
					const seen = drive(
						gate,
						Buffer.from(signal[format]),
						format,
						runs,
						chunks,
						() => signal.carrier,
					)
					expect(seen.latches).toEqual([])
					expect(gate.state).toBe("waiting")
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)

	// Feature: evidence-squelch, Property 4: Latch through the hang
	// Validates: Requirements 1.5
	it("Property 4: latch through the hang", () => {
		const latchRun = Math.round(RATE * 1.5)
		const head = toPcm(
			mix(
				ctcssMix({ rate: RATE, seconds: 1.5, hz: 67 }),
				voiceLike({ rate: RATE, seconds: 1.5, seed: 21, level: 0.5 }),
			),
			"s16le",
		)
		const tail = toPcm(
			voiceLike({ rate: RATE, seconds: 0.3, seed: 22, level: 0.8 }),
			"s16le",
		)
		const gapArb = fc.oneof(
			fc.integer({ min: 1, max: HANG - 1 }),
			fc.constantFrom(HANG - 1, HANG, HANG + 1, 3 * HANG),
			fc.integer({ min: HANG, max: 4 * HANG }),
		)
		fc.assert(
			fc.property(gapArb, chunksArb, (gap, chunks) => {
				const gate = new EvidenceGate({
					rate: RATE,
					modulation: "nfm",
					gain: 2,
				})
				const first = drive(
					gate,
					Buffer.from(head),
					"s16le",
					[{ samples: latchRun, open: true }],
					chunks,
					() => false,
				)
				expect(first.latches.length).toBe(1)
				expect(first.latches[0]).toBeLessThanOrEqual(latchRun)
				expect(gate.state).toBe("open")
				// Closed gap in random pieces, whole samples in total.
				let left = gap
				let i = 0
				while (left > 0) {
					const step = Math.min(
						left,
						Math.max(1, chunks[i % chunks.length] ?? 1),
					)
					gate.closed(step * 2, "s16le")
					left -= step
					i += 1
					if (gap - left < HANG) expect(gate.state).toBe("open")
				}
				expect(gate.state).toBe(gap < HANG ? "open" : "waiting")
				if (gap >= HANG) expect(gate.evidence).toBeNull()
				const latch = gate.push(Buffer.from(tail), "s16le", 0, tail.length)
				// No new evidence window: a reopen within the hang stays open, never re-latching;
				// after the hang a fresh 300 ms over cannot fill a window.
				expect(latch).toBe(-1)
				expect(gate.state).toBe(gap < HANG ? "open" : "waiting")
			}),
			{ numRuns: 100 },
		)
	}, 120_000)

	// Long enough for one voice latch (a 1 s window plus margin).
	const OVER_SECONDS = 1.5
	const OVER = Math.round(RATE * OVER_SECONDS)
	const voiceOver = voiceLike({
		rate: RATE,
		seconds: OVER_SECONDS,
		seed: 31,
		level: 0.8,
	})

	// Feature: evidence-squelch, Property 5: Status at received time
	// Validates: Requirements 2.7, 4.1
	it("Property 5: the open sample does not depend on a pre-roll consumer", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("s16le" as const, "f32le" as const),
				chunksArb,
				fc.integer({ min: 0, max: 100 }),
				(format, chunks, seed) => {
					const rand = mulberry32(seed)
					const quiet = Array.from(
						{ length: OVER / BLOCK_SAMPLES },
						() => rand() < 0.8,
					)
					const carrier = (b: number): boolean => quiet[b] ?? false
					const runs = [{ samples: OVER, open: true }]
					const plain = drive(
						new EvidenceGate({ rate: RATE, modulation: "nfm", gain: 2 }),
						toPcm(voiceOver, format),
						format,
						runs,
						chunks,
						carrier,
					)
					// The stub rewrites each pushed range in place (as muting or a delayed copy does).
					const rewritten = drive(
						new EvidenceGate({ rate: RATE, modulation: "nfm", gain: 2 }),
						toPcm(voiceOver, format),
						format,
						runs,
						chunks,
						carrier,
						(buf, start, end) => buf.fill(0, start, end),
					)
					expect(plain.latches.length).toBe(1)
					expect(rewritten.latches).toEqual(plain.latches)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)

	// Feature: evidence-squelch, Property 6: Chunk-split invariance
	// Validates: Requirements 2.3
	it("Property 6: two byte splits give the same state sequence", () => {
		const signal = mix(
			voiceOver,
			ctcssMix({ rate: RATE, seconds: OVER_SECONDS, hz: 100 }),
		)
		fc.assert(
			fc.property(
				fc.constantFrom("s16le" as const, "f32le" as const),
				runsArb(OVER),
				chunksArb,
				chunksArb,
				fc.boolean(),
				(format, runs, a, b, useTone) => {
					const pcm = toPcm(useTone ? signal : voiceOver, format)
					const carrier = (block: number): boolean => block % 5 !== 0
					const split = (chunks: readonly number[]): Observation =>
						drive(
							new EvidenceGate({ rate: RATE, modulation: "nfm", gain: 2 }),
							Buffer.from(pcm),
							format,
							runs,
							chunks,
							carrier,
						)
					// Reference: one byte per call, so the state is seen after every sample.
					const reference = split([1])
					for (const other of [split(a), split(b)]) {
						expect(other.latches).toEqual(reference.latches)
						expect(other.guardBytes).toBe(reference.guardBytes)
						for (const [at, state] of other.states)
							expect(state).toBe(reference.states.get(at))
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
