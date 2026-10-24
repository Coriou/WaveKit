/**
 * Live-found evidence squelch defects (docs/specs/evidence-squelch, amendments A13 and A14,
 * 2026-10-24).
 *
 * A13: two plain voice overs from a PMR446 handheld (12.5 kHz channel, csdr engine, gain 2,
 * channel power about +1 dBFS), recorded ungated. No audio is kept in the repository: the
 * regression is `live-pmr446-frames.json`, the voice meter's rounded per-frame outputs of both
 * overs from carrier onset (at the 5 kHz and the 2.5 kHz deviation reference) and each 10 ms
 * block's FM quieting (39-54 dB). It is replayed through the judge below the meter. A synthetic
 * 12.5 kHz-plan voice runs through the real meter and gate. With
 * `EVIDENCE_SQUELCH_PRIVATE_FIXTURES` pointing at a directory holding the recorded excerpts, a
 * local-only test also replays them; it is skipped otherwise.
 *
 * A14: the latch survives only pauses of the same transmission. Weak re-opens of stage 1 without
 * carrier evidence (interference flicker every 0.5-1 s) no longer carry it.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS,
	LIVE_AUDIO_AUTO_SQUELCH_HANG_MS,
	LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS,
	LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES,
	LIVE_AUDIO_NOISE_QUIETING_DB,
} from "@wavekit/api-types"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
	EVIDENCE_NARROW_DEVIATION_HZ,
	EVIDENCE_WIDE_DEVIATION_HZ,
	evidenceDeviationHz,
} from "../../../../src/core/evidence-squelch/contract.js"
import {
	EVIDENCE_TONE_HANG_GRACE_MS,
	EvidenceGate,
	judgeEvidence,
	syllableRuns,
	voicePath,
} from "../../../../src/core/evidence-squelch/evidence-gate.js"
import { ToneEvidence } from "../../../../src/core/evidence-squelch/tone-evidence.js"
import { VoiceFrameMeter } from "../../../../src/core/evidence-squelch/voice-meter.js"
import type { AnalogTrialFrame } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { PcmDecimator } from "../../../../src/core/audio-tones/tone-detector.js"
import { dataLike, isVoice } from "../../../../src/core/scanner/analog-trial.js"
import { mulberry32 } from "../audio-tones/synth.js"
import {
	carrierSilence,
	ctcssMix,
	dcsMix,
	mix,
	toPcm,
	voiceLike,
	whiteNoise,
} from "./synthetic.js"

const FrameSchema = z.tuple([z.number(), z.number(), z.number()])
const LiveFramesSchema = z.object({
	frameMs: z.literal(50),
	blockMs: z.literal(10),
	overs: z
		.array(
			z.object({
				name: z.string(),
				quietingDb: z.array(z.number()),
				frames: z.object({
					"5000": z.array(FrameSchema),
					"2500": z.array(FrameSchema),
				}),
			}),
		)
		.length(2),
})

const live = LiveFramesSchema.parse(
	JSON.parse(
		readFileSync(
			new URL(
				"../../../mocks/fixtures/evidence-squelch/live-pmr446-frames.json",
				import.meta.url,
			),
			"utf8",
		),
	),
)

/**
 * The gate's voice judgement on recorded meter frames (below the meter): from the onset, after
 * each 50 ms frame the last 20 frames and the quiet ring of the last 100 blocks (quieted: FM
 * quieting at least the carrier observer's 6 dB) go to `judgeEvidence`, as `EvidenceGate` does.
 * Returns the latch time from the onset in seconds, or null.
 */
function replayFrames(
	frames: readonly (readonly [number, number, number])[],
	quietingDb: readonly number[],
): number | null {
	const blocksPerFrame = 5
	for (let k = LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES; k <= frames.length; k++) {
		const window: AnalogTrialFrame[] = frames
			.slice(k - LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES, k)
			.map(([audioDb, syllabic, cluster]) => ({
				carrierDb: 0,
				hfNoiseDb: 0,
				audioDb,
				syllabic,
				cluster,
			}))
		const blocks = quietingDb.slice(
			Math.max(
				0,
				k * blocksPerFrame - LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS,
			),
			k * blocksPerFrame,
		)
		const quiet = blocks.filter(
			q => q >= LIVE_AUDIO_NOISE_QUIETING_DB.default,
		).length
		const verdict = judgeEvidence({
			modulation: "nfm",
			stats: { mode: "nfm", frames: window, gapSamples: 0, floorDb: 0 },
			tone: null,
			audioMs: k * live.frameMs,
			quietBlocks: quiet,
			notedBlocks: blocks.length,
			framesFinite: true,
		})
		if (verdict === "voice") return (k * live.frameMs) / 1_000
	}
	return null
}

const SYNTH_RATE = 25_000
/** Synthetic speech at the ±2.5 kHz plan's level: peak 0.4 (0.8 = ±5 kHz at gain 2). */
const NARROW_VOICE_LEVEL = 0.4

/** Seconds from the onset to the latch with every block quieted, or null. */
function gateLatch(
	pcm: Buffer,
	rate: number,
	deviationHz: number,
): number | null {
	const gate = new EvidenceGate({
		rate,
		modulation: "nfm",
		gain: 2,
		deviationHz,
	})
	const block = Math.round(rate / 100) * 2
	for (let s = 0; s < pcm.length; s += block) {
		gate.noteBlock(true)
		const k = gate.push(pcm, "s16le", s, Math.min(pcm.length, s + block))
		if (k >= 0) return k / 2 / rate
	}
	return null
}

/** First latch time (s) of the pinned median rule alone (`isVoice`, not data-like), or null. */
function medianLatch(
	samples: Float32Array,
	deviationHz: number,
): number | null {
	const decimator = new PcmDecimator()
	decimator.arm(SYNTH_RATE)
	const meter = new VoiceFrameMeter({ gain: 2, deviationHz })
	const frames: AnalogTrialFrame[] = []
	for (const x of samples) {
		if (!decimator.take(x) || !meter.push(decimator.output)) continue
		const { audioDb, syllabic, cluster } = meter.frame
		frames.push({ carrierDb: 0, hfNoiseDb: 0, audioDb, syllabic, cluster })
		if (frames.length < LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES) continue
		const stats = {
			mode: "nfm" as const,
			frames: frames.slice(-LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES),
			gapSamples: 0,
			floorDb: 0,
		}
		if (!dataLike(stats) && isVoice(stats)) return (frames.length * 50) / 1_000
	}
	return null
}

const privateDir = process.env["EVIDENCE_SQUELCH_PRIVATE_FIXTURES"] ?? ""
const privateFiles = [1, 2].map(n =>
	join(privateDir, `live-pmr446-voice-${n}.audio.s16le`),
)
const havePrivate =
	privateDir !== "" && privateFiles.every(file => existsSync(file))

describe("A13: live PMR446 overs on a 12.5 kHz channel", () => {
	it("the deviation reference follows the channel plan", () => {
		expect(evidenceDeviationHz(12_500)).toBe(EVIDENCE_NARROW_DEVIATION_HZ)
		expect(evidenceDeviationHz(6_250)).toBe(EVIDENCE_NARROW_DEVIATION_HZ)
		expect(evidenceDeviationHz(12_501)).toBe(EVIDENCE_WIDE_DEVIATION_HZ)
		expect(evidenceDeviationHz(25_000)).toBe(EVIDENCE_WIDE_DEVIATION_HZ)
		for (const bad of [0, -1, NaN, Infinity])
			expect(evidenceDeviationHz(bad)).toBe(EVIDENCE_WIDE_DEVIATION_HZ)
	})

	it("recorded frames: every block of both overs is quieted", () => {
		for (const over of live.overs)
			expect(
				over.quietingDb.every(q => q >= LIVE_AUDIO_NOISE_QUIETING_DB.default),
			).toBe(true)
	})

	it("recorded frames: with A13 both overs latch voice within the 1.5 s pre-roll", () => {
		for (const over of live.overs) {
			const latch = replayFrames(over.frames["2500"], over.quietingDb)
			expect(latch).not.toBeNull()
			expect(latch ?? Infinity).toBeLessThanOrEqual(1.5)
		}
	})

	it("recorded frames: without A13 over 1 latches only at 2.6 s, after the pre-roll", () => {
		const [first] = live.overs
		expect(first).toBeDefined()
		if (first === undefined) return
		expect(replayFrames(first.frames["5000"], first.quietingDb)).toBeCloseTo(
			2.6,
			6,
		)
	})

	it("synthetic 12.5 kHz-plan voice through the real meter latches within 1.5 s", () => {
		for (const seed of [11, 24, 31, 47]) {
			const pcm = toPcm(
				voiceLike({
					rate: SYNTH_RATE,
					seconds: 3,
					seed,
					level: NARROW_VOICE_LEVEL,
				}),
				"s16le",
			)
			const latch = gateLatch(pcm, SYNTH_RATE, EVIDENCE_NARROW_DEVIATION_HZ)
			expect(latch).not.toBeNull()
			expect(latch ?? Infinity).toBeLessThanOrEqual(1.5)
		}
		// Without A13 the marginal seed passes the median rule only after the pre-roll (1.85 s);
		// since A15 the gate also takes it on the syllable-run path at 1.0 s.
		const marginal = voiceLike({
			rate: SYNTH_RATE,
			seconds: 3,
			seed: 24,
			level: NARROW_VOICE_LEVEL,
		})
		expect(medianLatch(marginal, EVIDENCE_WIDE_DEVIATION_HZ)).toBeCloseTo(
			1.85,
			6,
		)
		expect(
			gateLatch(
				toPcm(marginal, "s16le"),
				SYNTH_RATE,
				EVIDENCE_WIDE_DEVIATION_HZ,
			),
		).toBe(1)
	})

	it.skipIf(!havePrivate)(
		"local only: the recorded excerpts latch within 1.5 s with A13 (×1, ×2, ×4 clipped)",
		() => {
			for (const file of privateFiles) {
				const bytes = readFileSync(file)
				const samples = new Int16Array(
					bytes.buffer,
					bytes.byteOffset,
					bytes.length / 2,
				)
				for (const gain of [1, 2, 4]) {
					const pcm = Buffer.alloc(samples.length * 2)
					for (let i = 0; i < samples.length; i++)
						pcm.writeInt16LE(
							Math.max(
								-32_768,
								Math.min(32_767, Math.round((samples[i] ?? 0) * gain)),
							),
							i * 2,
						)
					const latch = gateLatch(pcm, 8_000, EVIDENCE_NARROW_DEVIATION_HZ)
					expect(latch ?? Infinity).toBeLessThanOrEqual(1.5)
				}
			}
		},
	)

	it("an invalid deviation throws", () => {
		for (const deviationHz of [0, -5, NaN])
			expect(() => new VoiceFrameMeter({ gain: 2, deviationHz })).toThrow(
				expect.objectContaining({ code: "EVIDENCE_DEVIATION" }),
			)
	})

	// Feature: evidence-squelch, Property 15: Deviation normalisation
	// Validates: Requirements 1.3, 5.2
	it("Property 15: a meter at deviation d equals the 5 kHz meter fed samples × 5 000 / d", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(1_250, 2_500, 3_000, 5_000, 7_500),
				fc.integer({ min: 1, max: 1_000 }),
				fc.constantFrom(1, 2, 4),
				(deviationHz, seed, gain) => {
					const samples = voiceLike({
						rate: 8_000,
						seconds: 0.3,
						seed,
						level: 0.4,
					})
					const narrow = new VoiceFrameMeter({ gain, deviationHz })
					const wide = new VoiceFrameMeter({ gain })
					const factor = EVIDENCE_WIDE_DEVIATION_HZ / deviationHz
					const close = (a: number, b: number): boolean =>
						Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a))
					for (const x of samples) {
						const a = narrow.push(x)
						if (a !== wide.push(x * factor)) return false
						if (!a) continue
						if (
							!close(narrow.frame.audioDb, wide.frame.audioDb) ||
							!close(narrow.frame.syllabic, wide.frame.syllabic) ||
							!close(narrow.frame.cluster, wide.frame.cluster)
						)
							return false
					}
					return true
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})

const RATE = 25_000
const HANG = Math.round((RATE * LIVE_AUDIO_AUTO_SQUELCH_HANG_MS) / 1_000)
const TONE_GRACE = Math.round((RATE * EVIDENCE_TONE_HANG_GRACE_MS) / 1_000)
/** One 10 ms block at 25 kHz, in bytes. */
const BLOCK_BYTES = 500

interface Segment {
	pcm: Buffer
	open: boolean
	quieted: boolean
}

interface Trace {
	/** Gate state after each 10 ms block. */
	states: ("waiting" | "open")[]
	/** Evidence after each 10 ms block. */
	evidence: (string | null)[]
}

/** Drives the gate as the wiring does: per 10 ms block noteBlock (open only), then push/closed. */
function drive(gate: EvidenceGate, segments: readonly Segment[]): Trace {
	const trace: Trace = { states: [], evidence: [] }
	let wasOpen = false
	for (const segment of segments) {
		for (let s = 0; s < segment.pcm.length; s += BLOCK_BYTES) {
			const end = Math.min(segment.pcm.length, s + BLOCK_BYTES)
			if (segment.open) {
				gate.noteBlock(segment.quieted)
				gate.push(segment.pcm, "s16le", s, end)
			} else {
				// The wiring resets a waiting gate when stage 1 closes before a latch.
				if (wasOpen && gate.state === "waiting") gate.reset()
				gate.closed(end - s, "s16le")
			}
			wasOpen = segment.open
			trace.states.push(gate.state)
			trace.evidence.push(gate.evidence)
		}
	}
	return trace
}

function gate(): EvidenceGate {
	return new EvidenceGate({
		rate: RATE,
		modulation: "nfm",
		gain: 2,
		deviationHz: EVIDENCE_NARROW_DEVIATION_HZ,
	})
}

function ctcssOver(seconds: number, hz = 79.7, seed = 3): Buffer {
	return toPcm(
		mix(
			ctcssMix({ rate: RATE, seconds, hz }),
			voiceLike({ rate: RATE, seconds, seed, level: 0.4 }),
		),
		"s16le",
	)
}

/** Weak interference: unquieted discriminator noise. */
function flicker(ms: number, seed: number): Segment {
	return {
		pcm: toPcm(
			whiteNoise({ rate: RATE, seconds: ms / 1_000, seed, level: 0.9 }),
			"s16le",
		),
		open: true,
		quieted: false,
	}
}

function closedFor(ms: number): Segment {
	return {
		pcm: Buffer.alloc(Math.round((RATE * ms) / 1_000) * 2),
		open: false,
		quieted: false,
	}
}

/** Stage 1 flickering on interference: `onMs` open, `offMs` closed, for `totalMs`. */
function flickerTrain(
	totalMs: number,
	onMs: number,
	offMs: number,
	seed: number,
): Segment[] {
	const out: Segment[] = []
	for (let t = 0, i = 0; t < totalMs; t += onMs + offMs, i++)
		out.push(flicker(onMs, seed + i), closedFor(offMs))
	return out
}

/** Blocks from the start of segment `index` in `segments`. */
function blocksBefore(segments: readonly Segment[], index: number): number {
	let blocks = 0
	for (let i = 0; i < index; i++)
		blocks += Math.ceil((segments[i]?.pcm.length ?? 0) / BLOCK_BYTES)
	return blocks
}

describe("A14: the latch survives only the same transmission", () => {
	it("run2 replay: a CTCSS over, then weak flicker every 0.5 s for 20 s: the latch expires within the hang and the flicker stays muted", () => {
		const segments: Segment[] = [
			{ pcm: ctcssOver(5), open: true, quieted: true },
			closedFor(300),
			...flickerTrain(20_000, 200, 300, 100),
		]
		const g = gate()
		const t = drive(g, segments)
		const overEnd = blocksBefore(segments, 1)
		expect(t.states[overEnd - 1]).toBe("open")
		expect(t.evidence[overEnd - 1]).toBe("ctcss")
		// Expired by the hang after the over's last quieted block (150 blocks of 10 ms).
		const expired = t.states.indexOf("waiting", overEnd)
		expect(expired).toBeGreaterThan(overEnd)
		expect(expired - overEnd).toBeLessThanOrEqual(HANG / 250)
		expect(t.states.slice(expired).every(s => s === "waiting")).toBe(true)
	})

	it("flicker at 1 s spacing that starts before stage 1 closes also expires (bound: hang + one CTCSS block)", () => {
		const segments: Segment[] = [
			{ pcm: ctcssOver(4), open: true, quieted: true },
			...flickerTrain(10_000, 400, 600, 200),
		]
		const t = drive(gate(), segments)
		const overEnd = blocksBefore(segments, 1)
		const expired = t.states.indexOf("waiting", overEnd)
		// Without a close the tone stage keeps its last 500 ms CTCSS block current: up to 50
		// more blocks of refresh after the tone ended (design, A14).
		// Without a close a block straddling the tone's end can still sight it: bound hang +
		// grace + one 500 ms block (50 blocks of 10 ms) after the tone (design, A14).
		expect(expired - overEnd).toBeLessThanOrEqual(
			(HANG + TONE_GRACE) / 250 + 50,
		)
		expect(t.states.slice(expired).every(s => s === "waiting")).toBe(true)
	})

	it("a pause inside a real over keeps the latch (carrier held, or a short drop and back)", () => {
		const silence = toPcm(carrierSilence({ rate: RATE, seconds: 3 }), "s16le")
		// 3 s of held carrier with no speech: quieted blocks keep the latch for as long as it lasts.
		const held = drive(gate(), [
			{ pcm: ctcssOver(3), open: true, quieted: true },
			{ pcm: silence, open: true, quieted: true },
			{ pcm: ctcssOver(1, 79.7, 9), open: true, quieted: true },
		])
		expect(held.states.slice(80).every(s => s === "open")).toBe(true)
		// Stage 1 drops for 1.2 s (a fade), then the same transmission resumes quieted.
		const segments: Segment[] = [
			{ pcm: ctcssOver(3), open: true, quieted: true },
			closedFor(1_200),
			{ pcm: ctcssOver(1, 79.7, 9), open: true, quieted: true },
		]
		const faded = drive(gate(), segments)
		expect(faded.states.slice(80).every(s => s === "open")).toBe(true)
		expect(faded.evidence.at(-1)).toBe("ctcss")
	})

	it("a different code re-latches with the new evidence", () => {
		const dcs = toPcm(
			mix(
				dcsMix({ rate: RATE, seconds: 3, code: 0o31, polarity: "normal" }),
				voiceLike({ rate: RATE, seconds: 3, seed: 5, level: 0.4 }),
			),
			"s16le",
		)
		// After the hang: a new episode that must earn its own evidence (no carried label).
		const later: Segment[] = [
			{ pcm: ctcssOver(3), open: true, quieted: true },
			...flickerTrain(5_000, 200, 300, 300),
			closedFor(500),
			{ pcm: dcs, open: true, quieted: true },
		]
		const t = drive(gate(), later)
		const dcsStart = blocksBefore(later, later.length - 1)
		expect(t.states[dcsStart]).toBe("waiting")
		expect(t.evidence[dcsStart]).toBeNull()
		expect(t.evidence.at(-1)).toBe("dcs")
		// Within the hang (a quick new over): the different code renews the label.
		const quick: Segment[] = [
			{ pcm: ctcssOver(3), open: true, quieted: true },
			closedFor(400),
			{ pcm: dcs, open: true, quieted: true },
		]
		expect(drive(gate(), quick).evidence.at(-1)).toBe("dcs")
	})

	// Review round 1 (A14 revised): a tone over with weak or no quieting survives short fades.
	it("review repro: 2 s CTCSS unquieted, 1.2 s close, the same tone back unquieted: stays open/ctcss", () => {
		const g = gate()
		drive(g, [{ pcm: ctcssOver(2), open: true, quieted: false }])
		expect([g.state, g.evidence]).toEqual(["open", "ctcss"])
		const t = drive(g, [
			closedFor(1_200),
			{ pcm: ctcssOver(3, 79.7, 8), open: true, quieted: false },
		])
		expect(t.states.every(s => s === "open")).toBe(true)
		expect(t.evidence.every(e => e === "ctcss")).toBe(true)
	})

	it("DCS: 2 s of 023N unquieted, 1.2 s close, the same code back unquieted: stays open/dcs", () => {
		const dcs = (seconds: number, seed: number): Buffer =>
			toPcm(
				mix(
					dcsMix({ rate: RATE, seconds, code: 0o23, polarity: "normal" }),
					voiceLike({ rate: RATE, seconds, seed, level: 0.4 }),
				),
				"s16le",
			)
		const g = gate()
		drive(g, [{ pcm: dcs(2, 1), open: true, quieted: false }])
		expect([g.state, g.evidence]).toEqual(["open", "dcs"])
		const t = drive(g, [
			closedFor(1_200),
			{ pcm: dcs(3, 2), open: true, quieted: false },
		])
		expect(t.states.every(s => s === "open")).toBe(true)
		expect(t.evidence.at(-1)).toBe("dcs")
	})

	it("review repro: repeated 10 ms closes between 600 ms unquieted tone stretches keep the latch", () => {
		// Latched first (a close before a latch discards the evidence, requirement 1.5).
		const segments: Segment[] = [
			{ pcm: ctcssOver(2), open: true, quieted: false },
		]
		for (let i = 0; i < 10; i++)
			segments.push(
				{ pcm: ctcssOver(0.6, 79.7, 20 + i), open: true, quieted: false },
				closedFor(10),
			)
		const t = drive(gate(), segments)
		const latched = t.states.indexOf("open")
		expect(latched).toBeGreaterThan(0)
		expect(t.states.slice(latched).every(s => s === "open")).toBe(true)
		expect(t.evidence.at(-1)).toBe("ctcss")
	})

	it("a tone over with no quieting at all stays open to its end, then ends at the hang", () => {
		for (const tone of ["ctcss", "dcs"] as const) {
			const pcm =
				tone === "ctcss"
					? ctcssOver(6)
					: toPcm(
							mix(
								dcsMix({
									rate: RATE,
									seconds: 6,
									code: 0o23,
									polarity: "normal",
								}),
								voiceLike({ rate: RATE, seconds: 6, seed: 4, level: 0.4 }),
							),
							"s16le",
						)
			const g = gate()
			const t = drive(g, [{ pcm, open: true, quieted: false }])
			const latched = t.states.indexOf("open")
			expect(latched).toBeGreaterThan(0)
			expect(t.states.slice(latched).every(s => s === "open")).toBe(true)
			expect(g.evidence).toBe(tone)
			const after = drive(g, [closedFor(LIVE_AUDIO_AUTO_SQUELCH_HANG_MS)])
			expect(after.states.at(-1)).toBe("waiting")
		}
	})

	it("flicker after an unquieted tone over still expires (bound: hang + tone grace + one block)", () => {
		const segments: Segment[] = [
			{ pcm: ctcssOver(4), open: true, quieted: false },
			closedFor(300),
			...flickerTrain(10_000, 200, 300, 400),
		]
		const t = drive(gate(), segments)
		const overEnd = blocksBefore(segments, 1)
		const expired = t.states.indexOf("waiting", overEnd)
		expect(expired).toBeGreaterThan(overEnd)
		expect(expired - overEnd).toBeLessThanOrEqual(
			(HANG + TONE_GRACE) / 250 + 50,
		)
		expect(t.states.slice(expired).every(s => s === "waiting")).toBe(true)
	})

	it("a different tone after a fade cannot keep the latch: it ends, and the new tone latches on its own", () => {
		const g = gate()
		drive(g, [{ pcm: ctcssOver(2), open: true, quieted: false }])
		const t = drive(g, [
			closedFor(1_300),
			{ pcm: ctcssOver(3, 100, 6), open: true, quieted: false },
		])
		const ended = t.states.indexOf("waiting")
		// 130 blocks closed, then the hang + grace (2.0 s from the last 79.7 Hz sighting, at most
		// 250 ms before the close) runs out before 100 Hz can qualify (750 ms after the re-open):
		// its own sightings have another key and never refresh the latch.
		expect(ended).toBeGreaterThanOrEqual(130)
		expect(ended).toBeLessThanOrEqual(130 + 70)
		expect(t.states.at(-1)).toBe("open")
		expect(t.evidence.at(-1)).toBe("ctcss")
	})

	// Review round 2: a retained tone-stage block must not date old tone as fresh evidence.
	it("review repro: 2.1 s tone, 1.2 s closed, low noise after: the latch ends within hang + grace of the tone's end", () => {
		const rows: string[] = []
		for (const toneMs of [
			2_100, 2_137, 2_174, 2_211, 2_248, 2_285, 2_322, 2_359,
		])
			for (const noise of [100, 300, 1_000, 3_000]) {
				const tone = Buffer.alloc(Math.round((RATE * toneMs) / 1_000) * 2)
				for (let i = 0; i < tone.length / 2; i++)
					tone.writeInt16LE(
						Math.round(6_000 * Math.sin((2 * Math.PI * 79.7 * i) / RATE)),
						i * 2,
					)
				const rand = mulberry32(toneMs + noise)
				const after = Buffer.alloc(4 * RATE * 2)
				for (let i = 0; i < after.length / 2; i++)
					after.writeInt16LE(Math.round((rand() * 2 - 1) * noise), i * 2)
				const g = gate()
				drive(g, [{ pcm: tone, open: true, quieted: false }])
				expect(g.state).toBe("open")
				const t = drive(g, [
					closedFor(1_200),
					{ pcm: after, open: true, quieted: false },
				])
				const ended = t.states.indexOf("waiting")
				rows.push(`${toneMs}/${noise}:${ended}`)
				// The tone ends at the close: at most hang + grace (200 blocks of 10 ms) later.
				expect(ended).toBeGreaterThan(0)
				expect(ended).toBeLessThanOrEqual((HANG + TONE_GRACE) / 250)
				expect(t.states.slice(ended).every(s => s === "waiting")).toBe(true)
			}
		console.info(`EVIDENCE-SQUELCH A14 dated sightings: ${rows.join(" ")}`)
	})

	// Review round 2 (minor): a DCS sighting is a word pair; a CTCSS sighting one won block.
	it("sightings in seeded noise and voice: none in 10 min of white noise at 0.5 and 5 min of voice (single DCS words: about 68 and 7 per hour)", () => {
		let count = 0
		const feed = (samples: Float32Array): void => {
			const evidence = new ToneEvidence()
			let last = evidence.sightingCount
			for (const x of samples) {
				evidence.push(x)
				if (evidence.sightingCount !== last) {
					last = evidence.sightingCount
					count += 1
				}
			}
		}
		for (let minute = 0; minute < 10; minute++)
			feed(
				whiteNoise({
					rate: 8_000,
					seconds: 60,
					seed: 900 + minute,
					level: 0.5,
				}),
			)
		for (let minute = 0; minute < 5; minute++)
			feed(
				voiceLike({ rate: 8_000, seconds: 60, seed: 950 + minute, level: 0.8 }),
			)
		expect(count).toBe(0)
	}, 120_000)

	// Feature: evidence-squelch, Property 16: Latch needs carrier evidence to survive
	// Validates: Requirements 1.5
	it("Property 16: after a tone over and a stage-1 close, any pattern of re-opens on noise of any level ends the latch within its hang", () => {
		// A bare 79.7 Hz tone (the review repro) and tone + voice.
		const sine = (amplitude: number, ms: number): Buffer => {
			const out = Buffer.alloc(Math.round((RATE * ms) / 1_000) * 2)
			for (let i = 0; i < out.length / 2; i++)
				out.writeInt16LE(
					Math.round(amplitude * Math.sin((2 * Math.PI * 79.7 * i) / RATE)),
					i * 2,
				)
			return out
		}
		const voiced = ctcssOver(2)
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						open: fc.boolean(),
						blocks: fc.integer({ min: 1, max: 60 }),
					}),
					{ minLength: 1, maxLength: 20 },
				),
				fc.integer({ min: 1, max: 1_000 }),
				fc.boolean(),
				fc.constantFrom(20_000, 3_000, 1_000, 300, 100),
				fc.constantFrom(6_000, 2_000, 0),
				fc.integer({ min: 1_500, max: 2_600 }),
				(pattern, seed, quieted, level, amplitude, toneMs) => {
					const g = gate()
					// The over ends with stage 1 closing for one block (its carrier is gone).
					drive(g, [
						{
							// 0: tone + voice; otherwise a bare tone of random length (block phase).
							pcm: amplitude === 0 ? voiced : sine(amplitude, toneMs),
							open: true,
							quieted,
						},
						{ pcm: Buffer.alloc(BLOCK_BYTES), open: false, quieted: false },
					])
					expect(g.state).toBe("open")
					const rand = mulberry32(seed)
					// Samples since the over's last carrier evidence: exact for a quieted over; an
					// unquieted over's last sighting is at most one CTCSS hop (250 ms) before the close.
					let since = BLOCK_BYTES / 2
					const stale = quieted ? 0 : RATE / 4
					let expired = false
					for (const step of pattern)
						for (let b = 0; b < step.blocks; b++) {
							const block = Buffer.alloc(BLOCK_BYTES)
							for (let i = 0; i < BLOCK_BYTES; i += 2)
								block.writeInt16LE(Math.round((rand() * 2 - 1) * level), i)
							drive(g, [{ pcm: block, open: step.open, quieted: false }])
							since += BLOCK_BYTES / 2
							// A tone latch gets the tone grace while stage 1 is open (A14).
							const limit = step.open ? HANG + TONE_GRACE : HANG
							if (expired || since >= limit) {
								expect(g.state).toBe("waiting")
								expired = true
							} else if (since + stale < limit) expect(g.state).toBe("open")
							else if (g.state === "waiting") expired = true
						}
				},
			),
			{
				numRuns: 100,
				// The review repro shape: a 1.2 s close, then low-level noise.
				examples: [
					[
						[
							{ open: false, blocks: 119 },
							{ open: true, blocks: 150 },
						],
						7,
						false,
						1_000,
						6_000,
						2_100,
					],
					[
						[
							{ open: false, blocks: 60 },
							{ open: true, blocks: 150 },
						],
						8,
						false,
						100,
						2_000,
						2_248,
					],
				],
			},
		)
	}, 120_000)
})

/**
 * Live retest 2026-10-24 (run4) and amendment A15: the only voice the gated stream holds (a CTCSS
 * over, played once the tone latched) is sparse speech: 4-5 frames (200-250 ms) at -7 to -16 dB
 * about once a second over a -33 dB floor (the CTCSS tone's residue under the meter's 300 Hz
 * high-pass), so the median audioDb of every 1 s window stays near -33 dB. A15 adds the
 * syllable-run path: two runs of at least 3 consecutive sustained frames at -30 dB or more within
 * the last 2 s, with the syllabic median unchanged.
 */
describe("A15: sparse syllables and the diagnostic status", () => {
	/** Sub-audible 75.5 Hz hum (not a CTCSS tone) at the run4 CTCSS level: a -33 dB floor. */
	function floor(seconds: number): Float32Array {
		const out = new Float32Array(Math.round(RATE * seconds))
		for (let i = 0; i < out.length; i++)
			out[i] = 0.12 * Math.sin((2 * Math.PI * 75.5 * i) / RATE)
		return out
	}

	/** Syllables of `burstMs` every `everyMs`, the first at `firstMs`, over the floor. */
	function syllables(
		seconds: number,
		burstMs: number,
		everyMs: number,
		firstMs = 0,
		level = 0.5,
	): Float32Array {
		const out = floor(seconds)
		const burst = voiceLike({
			rate: RATE,
			seconds: burstMs / 1_000,
			seed: 77,
			level,
		})
		for (let at = firstMs; at + burstMs <= seconds * 1_000; at += everyMs) {
			const start = Math.round((RATE * at) / 1_000)
			for (let i = 0; i < burst.length; i++)
				out[start + i] = (out[start + i] ?? 0) + (burst[i] ?? 0)
		}
		return out
	}

	function latchSeconds(samples: Float32Array): number | null {
		const g = gate()
		const t = drive(g, [
			{ pcm: toPcm(samples, "s16le"), open: true, quieted: true },
		])
		const at = t.states.indexOf("open")
		if (at >= 0) expect(g.diagnostics().path).toBe("runs")
		return at < 0 ? null : (at + 1) / 100
	}

	it("run4 pattern: 225-250 ms syllables once a second from the onset latch within 1.5 s on the run path", () => {
		for (const burstMs of [225, 250])
			for (const level of [0.5, 0.8]) {
				const samples = syllables(5, burstMs, 1_000, 0, level)
				// The median rule alone never passes this speech.
				expect(medianLatch(samples, EVIDENCE_NARROW_DEVIATION_HZ)).toBeNull()
				const latch = latchSeconds(samples)
				console.info(
					`EVIDENCE-SQUELCH A15 run4 pattern ${burstMs} ms x${level}: latch ${latch ?? "-"} s`,
				)
				expect(latch).not.toBeNull()
				expect(latch ?? Infinity).toBeLessThanOrEqual(1.5)
			}
	})

	it("150 ms syllables every 0.8 s latch within 1.5 s", () => {
		const latch = latchSeconds(syllables(5, 150, 800))
		console.info(`EVIDENCE-SQUELCH A15 150 ms / 0.8 s: latch ${latch ?? "-"} s`)
		expect(latch).not.toBeNull()
		expect(latch ?? Infinity).toBeLessThanOrEqual(1.5)
	})

	it("runs more than 2 s apart never accumulate: one syllable every 2.1 s for 10 s stays waiting", () => {
		// Five syllables; a history that never expired would count two runs at the second one.
		const g = gate()
		const pcm = toPcm(syllables(10, 250, 2_100, 300), "s16le")
		let maxRuns = 0
		let sawRun = false
		for (let s = 0; s < pcm.length; s += BLOCK_BYTES) {
			drive(g, [
				{ pcm: pcm.subarray(s, s + BLOCK_BYTES), open: true, quieted: true },
			])
			expect(g.state).toBe("waiting")
			const runs = g.diagnostics().syllableRuns
			maxRuns = Math.max(maxRuns, runs)
			if (runs === 1) sawRun = true
		}
		expect(sawRun).toBe(true)
		expect(maxRuns).toBe(1)
		const d = g.diagnostics()
		expect(d.verdict === "low-audio" || d.verdict === "low-syllabic").toBe(true)
	})

	/**
	 * Review of A15 (2026-10-24), accepted as a known limitation: periodic 150 ms audio bursts on a
	 * fully quieted carrier latch through the run path. A quieted carrier carrying periodic audio
	 * is a real transmission, not the weak interference the evidence squelch targets.
	 */
	for (const [name, make] of [
		[
			"100 Hz click trains (1 ms exponential pulses peaking at 0.8)",
			(n: number, i: number): number => {
				const t = (i % (RATE / 100)) / RATE
				return t < 0.001 ? 0.8 * Math.exp(-t / 0.0002) : 0
			},
		],
		[
			"seeded ±0.3 white-noise bursts",
			(() => {
				const rand = mulberry32(99)
				return (): number => 0.3 * (2 * rand() - 1)
			})(),
		],
		[
			"0.3-amplitude 1 kHz beeps",
			(_n: number, i: number): number =>
				0.3 * Math.sin((2 * Math.PI * 1_000 * i) / RATE),
		],
	] as const)
		it(`known limitation (A15 review): 150 ms ${name} once a second on a quieted carrier latch via runs at 1.15 s`, () => {
			const out = floor(5)
			for (let at = 0; at + 0.15 <= 5; at += 1) {
				const start = Math.round(RATE * at)
				const n = Math.round(RATE * 0.15)
				for (let i = 0; i < n; i++)
					out[start + i] = (out[start + i] ?? 0) + make(n, i)
			}
			expect(latchSeconds(out)).toBe(1.15)
		})

	// Feature: evidence-squelch, Property 17: Short loud stretches are not syllables
	// Validates: Requirements 1.3, 1.4
	it("Property 17: windows whose loud frames come only in runs of at most 2 never qualify via the run path", () => {
		const frameArb = fc.record({
			loud: fc.boolean(),
			audioDb: fc.double({ min: -60, max: 10, noNaN: true }),
			sustained: fc.integer({ min: 0, max: 10 }),
			syllabic: fc.double({ min: 0, max: 3, noNaN: true }),
			cluster: fc.double({ min: 0, max: 0.59, noNaN: true }),
		})
		fc.assert(
			fc.property(
				fc.array(frameArb, { minLength: 20, maxLength: 40 }),
				drafts => {
					// Break every loud stretch after 2 frames: "loud" = a syllable frame.
					let run = 0
					const frames = drafts.map(d => {
						let loud = d.loud
						if (loud && run >= 2) loud = false
						run = loud ? run + 1 : 0
						return {
							carrierDb: 0,
							hfNoiseDb: 0,
							audioDb: loud
								? Math.max(-30, d.audioDb)
								: Math.min(-30.01, d.audioDb),
							sustained: d.sustained,
							syllabic: d.syllabic,
							cluster: d.cluster,
						}
					})
					const runs = syllableRuns(frames)
					expect(runs).toBe(0)
					const stats = {
						mode: "nfm" as const,
						frames: frames.slice(-20),
						gapSamples: 0,
						floorDb: 0,
					}
					expect(voicePath(stats, runs)).not.toBe("runs")
					// Also through the judge: voice only if the pinned median rule passes.
					const verdict = judgeEvidence({
						modulation: "nfm",
						stats,
						tone: null,
						audioMs: 2_000,
						quietBlocks: 100,
						notedBlocks: 100,
						framesFinite: true,
						syllableRuns: runs,
					})
					expect(verdict === "voice").toBe(!dataLike(stats) && isVoice(stats))
				},
			),
			{ numRuns: 200 },
		)
	})

	it("the diagnostic verdict follows the judge's order and names the path", () => {
		const filling = gate()
		drive(filling, [
			{
				pcm: toPcm(voiceLike({ rate: RATE, seconds: 0.5, seed: 3 }), "s16le"),
				open: true,
				quieted: true,
			},
		])
		expect(filling.diagnostics().verdict).toBe("window-filling")
		const notQuiet = gate()
		drive(notQuiet, [
			{
				pcm: toPcm(
					voiceLike({ rate: RATE, seconds: 2, seed: 3, level: 0.8 }),
					"s16le",
				),
				open: true,
				quieted: false,
			},
		])
		expect(notQuiet.diagnostics().verdict).toBe("not-quiet")
		const silent = gate()
		drive(silent, [
			{
				pcm: toPcm(carrierSilence({ rate: RATE, seconds: 2 }), "s16le"),
				open: true,
				quieted: true,
			},
		])
		expect(silent.diagnostics().verdict).toBe("low-syllabic")
		const median = gate()
		drive(median, [
			{
				pcm: toPcm(
					voiceLike({ rate: RATE, seconds: 2, seed: 3, level: 0.8 }),
					"s16le",
				),
				open: true,
				quieted: true,
			},
		])
		expect(median.diagnostics()).toMatchObject({
			verdict: "latched",
			path: "median",
		})
		const tone = gate()
		drive(tone, [{ pcm: ctcssOver(2), open: true, quieted: false }])
		expect(tone.diagnostics()).toMatchObject({
			verdict: "latched",
			path: "tone",
		})
		// A noise lead-in, then the over: one window reset at the onset.
		const lead = gate()
		drive(lead, [
			flicker(300, 9),
			{
				pcm: toPcm(carrierSilence({ rate: RATE, seconds: 0.5 }), "s16le"),
				open: true,
				quieted: true,
			},
		])
		expect(lead.diagnostics().windowResets).toBe(1)
		lead.reset()
		expect(lead.diagnostics()).toMatchObject({
			frames: 0,
			windowResets: 0,
			audioDb: null,
			syllableRuns: 0,
		})
	})
})

/**
 * Amendment A16 (2026-10-24): tail mute. While latched, the gate passes PCM only with current
 * carrier evidence: the last noted block quieted, the 200 ms close guard after it (back-chain
 * drain), or (tone latches) a sighting of the latched tone within 300 ms.
 */
describe("A16: tail mute", () => {
	const GUARD = Math.round(
		(RATE * LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS) / 1_000,
	)

	// Feature: evidence-squelch, Property 18: No unquieted, tone-less audio passes after the guard
	// Validates: Requirements 1.5
	it("Property 18: on a voice latch, an open block passes exactly while the last note was quieted or within the guard after it", () => {
		const over = toPcm(
			voiceLike({ rate: RATE, seconds: 1.5, seed: 31, level: 0.8 }),
			"s16le",
		)
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						open: fc.boolean(),
						quieted: fc.boolean(),
						blocks: fc.integer({ min: 1, max: 40 }),
					}),
					{ minLength: 1, maxLength: 25 },
				),
				fc.integer({ min: 1, max: 1_000 }),
				(pattern, seed) => {
					const g = gate()
					drive(g, [{ pcm: over, open: true, quieted: true }])
					expect(g.state).toBe("open")
					expect(g.passing).toBe(true)
					const rand = mulberry32(seed)
					let guard = GUARD
					let lastQuieted = true
					for (const step of pattern)
						for (let b = 0; b < step.blocks; b++) {
							const block = Buffer.alloc(BLOCK_BYTES)
							for (let i = 0; i < BLOCK_BYTES; i += 2)
								block.writeInt16LE(Math.round((rand() * 2 - 1) * 20_000), i)
							drive(g, [{ pcm: block, open: step.open, quieted: step.quieted }])
							if (!step.open) {
								guard = 0
								lastQuieted = false
							} else if (step.quieted) {
								guard = GUARD
								lastQuieted = true
							} else {
								guard = Math.max(0, guard - BLOCK_BYTES / 2)
								lastQuieted = false
							}
							const expected = g.state === "open" && (lastQuieted || guard > 0)
							expect(g.passing).toBe(expected)
						}
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)

	it("a tone latch passes while its tone is sighted, and stops 300 ms after it ends", () => {
		const g = gate()
		drive(g, [{ pcm: ctcssOver(2), open: true, quieted: false }])
		expect([g.state, g.evidence, g.passing]).toEqual(["open", "ctcss", true])
		// Unquieted noise with stage 1 open: passes for at most 300 ms (+ one block), then muted.
		const noise = flicker(1_000, 7)
		const t: boolean[] = []
		for (let s = 0; s < noise.pcm.length; s += BLOCK_BYTES) {
			drive(g, [
				{
					pcm: noise.pcm.subarray(s, s + BLOCK_BYTES),
					open: true,
					quieted: false,
				},
			])
			t.push(g.passing)
		}
		const muted = t.indexOf(false)
		expect(muted).toBeGreaterThanOrEqual(0)
		expect(muted).toBeLessThanOrEqual(31)
		expect(t.slice(muted).every(p => !p)).toBe(true)
		expect(g.state).toBe("open")
	})
})
