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
	EvidenceGate,
	judgeEvidence,
} from "../../../../src/core/evidence-squelch/evidence-gate.js"
import { VoiceFrameMeter } from "../../../../src/core/evidence-squelch/voice-meter.js"
import type { AnalogTrialFrame } from "../../../../src/core/scanner/scanner-redesign-contract.js"
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
		// Without A13 the marginal seed latches only after the pre-roll (1.85 s).
		const marginal = toPcm(
			voiceLike({
				rate: SYNTH_RATE,
				seconds: 3,
				seed: 24,
				level: NARROW_VOICE_LEVEL,
			}),
			"s16le",
		)
		expect(
			gateLatch(marginal, SYNTH_RATE, EVIDENCE_WIDE_DEVIATION_HZ),
		).toBeCloseTo(1.85, 6)
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
		expect(expired - overEnd).toBeLessThanOrEqual(HANG / 250 + 50)
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

	// Feature: evidence-squelch, Property 16: Latch needs carrier evidence to survive
	// Validates: Requirements 1.5
	it("Property 16: after the over's last quieted block, any pattern of unquieted re-opens and closes ends the latch exactly at the hang", () => {
		const over = ctcssOver(2)
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
				(pattern, seed) => {
					const g = gate()
					// The over ends with stage 1 closing for one block (its carrier is gone).
					drive(g, [
						{ pcm: over, open: true, quieted: true },
						{ pcm: Buffer.alloc(BLOCK_BYTES), open: false, quieted: false },
					])
					expect(g.state).toBe("open")
					const rand = mulberry32(seed)
					let since = BLOCK_BYTES / 2
					for (const step of pattern)
						for (let b = 0; b < step.blocks; b++) {
							const block = Buffer.alloc(BLOCK_BYTES)
							for (let i = 0; i < BLOCK_BYTES; i += 2)
								block.writeInt16LE(Math.round((rand() * 2 - 1) * 20_000), i)
							const before = g.state
							drive(g, [{ pcm: block, open: step.open, quieted: false }])
							if (before === "open") since += BLOCK_BYTES / 2
							if (since < HANG) expect(g.state).toBe("open")
							else if (before === "open") expect(g.state).toBe("waiting")
						}
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
