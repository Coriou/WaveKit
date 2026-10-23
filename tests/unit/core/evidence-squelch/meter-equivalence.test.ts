/**
 * Meter equivalence (requirements 5.1, 5.2, 8.4; plan Task FX.2; design "Meter equivalence",
 * amendment 2026-10-23).
 *
 * (a) Same path (the asserted contract): the TypeScript `VoiceFrameMeter` against
 *     `<name>.pcmstats.json`, an adapted reference of the analyzer's statistic definitions
 *     applied to the same committed 8 kHz PCM (`scripts/evidence-squelch/pcm_reference.py`;
 *     float64 histogram arithmetic where analyze.rs uses binary32, so not an exact oracle).
 * (b) Cross path: against the analyzer's own 48 kHz statistics (`<name>.stats.json`), which
 *     measure a different signal path; NFM verdicts agree except the documented flip; numeric
 *     deltas are informational (no bound asserted); AM rows are informational (A8).
 * Requirement 5.1 (1.5 dB, identical verdicts) is not met cross-path; design.md "Meter
 * equivalence" proposes a revision, pending decision.
 * Plus gate-level replays of every golden through the real `EvidenceGate`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { EvidenceGate } from "../../../../src/core/evidence-squelch/evidence-gate.js"
import { VoiceFrameMeter } from "../../../../src/core/evidence-squelch/voice-meter.js"
import { dataLike, isVoice } from "../../../../src/core/scanner/analog-trial.js"
import {
	ANALOG_TRIAL_AM_CARRIER_DB,
	ANALOG_TRIAL_DATA_SCORE,
	ANALOG_TRIAL_VOICE_INDEX,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { AnalogTrialStats } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { mulberry32 } from "../audio-tones/synth.js"

const DIR = join(process.cwd(), "tests/mocks/fixtures/evidence-squelch")
const RATE = 8_000
/** 10 ms measurement blocks at 8 kHz, as the live demodulator's level timer notes them. */
const BLOCK_SAMPLES = 80
const FRAME_SAMPLES = 400

// --- Tolerances (each justified; mirrored in design.md "Meter equivalence") -------------
/**
 * Same path, per frame. audioDb and syllabic are float64 on both sides; their deltas are
 * summation-order rounding (measured ≤ 1.5e-14 dB and ≤ 9e-16). Bound 1e-12 (~70x headroom).
 */
const SAME_AUDIO_DB = 1e-12
const SAME_SYLLABIC = 1e-12
/**
 * Same path, cluster per frame: both sides store the discriminator views in binary32 (the
 * analyzer's `disc_lo` / `disc_hi` type), so the histograms are bit-identical (measured 0).
 * Bound 1e-12. Without that rounding in the reference the per-frame delta reached 0.16: one
 * sample crossing a bin edge reseeds the k-means, so cluster is not continuous in its input.
 */
const SAME_CLUSTER = 1e-12

/**
 * Cross path: numeric deltas are printed, not asserted. The analyzer measures audio power on its
 * 48 kHz DC-blocked demod output before DC restore, clamp and the 3.4 kHz FIR decimation, and
 * clusters 48 kHz discriminator samples through 2.4 and 4.8 kHz views; 8 kHz PCM cannot
 * reproduce either, so no bound follows from first principles.
 */
/** The one documented cross-path verdict flip: analyzer data-like, 8 kHz PCM neither. */
const CROSS_FLIP: Readonly<Record<string, "neither">> = {
	"nfm-dmr-4fsk-continuous": "neither",
}

const ManifestSchema = z.record(
	z.string(),
	z.object({
		mode: z.enum(["nfm", "am"]),
		expect: z.enum(["ctcss", "dcs", "voice", "none"]),
		verdict: z.enum(["voice", "data-like", "neither"]),
		overOnsetS: z.number().nonnegative(),
		seed: z.number(),
		knownLimitation: z.boolean().optional(),
		rollingWindowRisk: z.array(z.object({ start: z.number() })).optional(),
	}),
)
const FrameSchema = z.object({
	audioDb: z.number(),
	syllabic: z.number(),
	cluster: z.number(),
})
const StatsSchema = z.object({
	event: z.literal("analysis"),
	frames: z.array(FrameSchema.extend({ carrierDb: z.number() })),
})
const PcmStatsSchema = z.object({
	rate: z.literal(RATE),
	frameSamples: z.literal(FRAME_SAMPLES),
	frames: z.array(FrameSchema),
})

const manifest = ManifestSchema.parse(
	JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")),
)
const names = Object.keys(manifest)

type Frame = z.infer<typeof FrameSchema>
type Verdict = "voice" | "data-like" | "neither"

function audioOf(name: string): Float64Array {
	const buf = readFileSync(join(DIR, `${name}.audio.s16le`))
	const out = new Float64Array(buf.length >> 1)
	for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32_768
	return out
}

function analyzerOf(name: string): z.infer<typeof StatsSchema>["frames"] {
	return StatsSchema.parse(
		JSON.parse(readFileSync(join(DIR, `${name}.stats.json`), "utf8")),
	).frames
}

function referenceOf(name: string): Frame[] {
	return PcmStatsSchema.parse(
		JSON.parse(readFileSync(join(DIR, `${name}.pcmstats.json`), "utf8")),
	).frames
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 === 1
		? (sorted[mid] ?? NaN)
		: ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2
}

function mediansOf(frames: readonly Frame[]): Frame {
	return {
		audioDb: median(frames.map(f => f.audioDb)),
		syllabic: median(frames.map(f => f.syllabic)),
		cluster: median(frames.map(f => f.cluster)),
	}
}

function meterFrames(samples: ArrayLike<number>, gain: number): Frame[] {
	const meter = new VoiceFrameMeter({ gain })
	const frames: Frame[] = []
	for (let i = 0; i < samples.length; i++)
		if (meter.push(samples[i] ?? 0)) {
			const f = meter.frame
			frames.push({
				audioDb: f.audioDb,
				syllabic: f.syllabic,
				cluster: f.cluster,
			})
		}
	return frames
}

function verdictOf(frames: readonly Frame[], mode: "nfm" | "am"): Verdict {
	const stats: AnalogTrialStats = {
		mode,
		frames: frames.map(f => ({ carrierDb: 0, hfNoiseDb: 0, ...f })),
		gapSamples: 0,
		floorDb: 0,
	}
	if (dataLike(stats)) return "data-like"
	return isVoice(stats) ? "voice" : "neither"
}

function maxDelta(a: readonly Frame[], b: readonly Frame[]): Frame {
	const out = { audioDb: 0, syllabic: 0, cluster: 0 }
	for (let i = 0; i < a.length; i++) {
		const x = a[i]
		const y = b[i]
		if (x === undefined || y === undefined) continue
		out.audioDb = Math.max(out.audioDb, Math.abs(x.audioDb - y.audioDb))
		out.syllabic = Math.max(out.syllabic, Math.abs(x.syllabic - y.syllabic))
		out.cluster = Math.max(out.cluster, Math.abs(x.cluster - y.cluster))
	}
	return out
}

function absDelta(a: Frame, b: Frame): Frame {
	return {
		audioDb: Math.abs(a.audioDb - b.audioDb),
		syllabic: Math.abs(a.syllabic - b.syllabic),
		cluster: Math.abs(a.cluster - b.cluster),
	}
}

/**
 * Additional AGC stress transform (informational only): a peak follower with instant attack,
 * 100 ms release, reference 0.4 and gain at most 1 000. It is NOT the Rust fast AGC (5 ms
 * attack, 300 ms decay, max gain 65 535); it only probes how a fast gain stage moves verdicts.
 */
function agcStress(samples: Float64Array): Float64Array {
	const release = Math.exp(-1 / (0.1 * RATE))
	const out = new Float64Array(samples.length)
	let env = 0
	for (let i = 0; i < samples.length; i++) {
		const x = samples[i] ?? 0
		const a = Math.abs(x)
		env = a > env ? a : env * release
		out[i] = x * Math.min(1_000, 0.4 / Math.max(env, 1e-9))
	}
	return out
}

/** 50 µs one-pole de-emphasis at 8 kHz. */
function deemphasis(samples: Float64Array): Float64Array {
	const alpha = 1 - Math.exp(-1 / (RATE * 50e-6))
	const out = new Float64Array(samples.length)
	let y = 0
	for (let i = 0; i < samples.length; i++) {
		y += alpha * ((samples[i] ?? 0) - y)
		out[i] = y
	}
	return out
}

const fmt = (m: Frame): string =>
	`audioDb=${m.audioDb.toFixed(2)} syllabic=${m.syllabic.toFixed(2)} cluster=${m.cluster.toFixed(2)}`

describe("meter equivalence: same path (8 kHz PCM, independent reference)", () => {
	it("manifest holds the 17 fixtures", () => {
		expect(names).toHaveLength(17)
	})

	for (const name of names) {
		const entry = manifest[name]
		if (entry === undefined) continue
		for (const [label, scale, gain] of [
			["gain 2", 1, 2],
			["audio x1.5 into gain 3", 1.5, 3],
		] as const) {
			it(`${name} (${label}): per frame within tolerance, same verdict`, () => {
				const ref = referenceOf(name)
				const audio = audioOf(name).map(x => x * scale)
				const frames = meterFrames(audio, gain)
				expect(frames).toHaveLength(ref.length)
				const d = maxDelta(frames, ref)
				const dm = absDelta(mediansOf(frames), mediansOf(ref))
				console.info(
					`EVIDENCE-SQUELCH SAME: ${name} ${label} frame-max audioDb=${d.audioDb.toExponential(2)} syllabic=${d.syllabic.toExponential(2)} cluster=${d.cluster.toExponential(2)} median cluster=${dm.cluster.toExponential(2)}`,
				)
				// gain 3 with x1.5 input is the gain-2 signal scaled by 1.5 / 1.5 inside the meter:
				// one extra float64 multiply per sample, inside the same bounds.
				expect(d.audioDb).toBeLessThanOrEqual(SAME_AUDIO_DB)
				expect(d.syllabic).toBeLessThanOrEqual(SAME_SYLLABIC)
				expect(d.cluster).toBeLessThanOrEqual(SAME_CLUSTER)
				expect(verdictOf(frames, entry.mode)).toBe(verdictOf(ref, entry.mode))
			})
		}
	}
})

describe("meter equivalence: cross path (analyzer 48 kHz statistics)", () => {
	for (const name of names) {
		const entry = manifest[name]
		if (entry === undefined) continue
		it(`${name}: ${entry.mode === "am" ? "informational (A8)" : "verdict agreement (deltas informational)"}`, () => {
			const want = mediansOf(analyzerOf(name))
			const frames = meterFrames(audioOf(name), 2)
			const got = mediansOf(frames)
			const d = absDelta(got, want)
			const verdict = verdictOf(frames, entry.mode)
			console.info(
				`EVIDENCE-SQUELCH CROSS: ${name} ts{${fmt(got)}} analyzer{${fmt(want)}} delta{${fmt(d)}} verdict ts=${verdict} analyzer=${entry.verdict}`,
			)
			if (entry.mode === "am") return
			const flip = CROSS_FLIP[name]
			expect(verdict).toBe(flip ?? entry.verdict)
		})
	}

	it("AGC stress and de-emphasis verdicts (informational, requirements 5.2 and 8.4)", () => {
		for (const name of names) {
			const entry = manifest[name]
			if (entry === undefined) continue
			const audio = audioOf(name)
			const agc = meterFrames(agcStress(audio), 2)
			const de = meterFrames(deemphasis(audio), 2)
			console.info(
				`EVIDENCE-SQUELCH 5.2: ${name} agc-stress=${verdictOf(agc, entry.mode)} {${fmt(mediansOf(agc))}} deemph=${verdictOf(de, entry.mode)} {${fmt(mediansOf(de))}}`,
			)
		}
		const am = names.filter(n => manifest[n]?.mode === "am")
		const parts = am.map(n => {
			const frames = meterFrames(agcStress(audioOf(n)), 2)
			return `${n} agc=${verdictOf(frames, "am")} ${fmt(mediansOf(frames))}`
		})
		// The "agc" here is the additional AGC stress transform above, not the Rust fast AGC.
		console.info(
			`EVIDENCE-SQUELCH 8.4: (agc = additional AGC stress transform, not the Rust fast AGC) ${parts.join("; ")}`,
		)
		expect(am.length).toBeGreaterThan(0)
	})
})

interface Replay {
	latched: boolean
	atS: number | null
	evidence: string | null
	/** Evidence after the whole over (status renewal), or null when never latched. */
	finalEvidence: string | null
	/** File time at which `evidence` first became each value. */
	changes: { atS: number; evidence: string }[]
}

function pcmOf(samples: ArrayLike<number>): Buffer {
	const pcm = Buffer.alloc(samples.length * 2)
	for (let i = 0; i < samples.length; i++)
		pcm.writeInt16LE(
			Math.max(
				-32_768,
				Math.min(32_767, Math.round((samples[i] ?? 0) * 32_768)),
			),
			i * 2,
		)
	return pcm
}

/**
 * Feeds the golden through the real gate: stage 1 closed before the over onset (`closed()`),
 * open from it, in 10 ms blocks each preceded by `noteBlock(carrier)`.
 * NFM carrier evidence by fixture class: quieted unless the channel is unquieted noise.
 * AM: an explicit approximation of carrier evidence (not the wiring's rule, which uses the
 * live channel power): the analyzer `carrierDb` of the enclosing frame ≥ the pre-onset
 * median + `ANALOG_TRIAL_AM_CARRIER_DB`. AM is ungated under A8, so AM rows are informational.
 */
function replay(name: string, preOpen = false): Replay {
	const entry = manifest[name]
	if (entry === undefined) throw new Error(`no manifest entry ${name}`)
	const audio = audioOf(name)
	const pcm = pcmOf(audio)
	const onset = Math.round(entry.overOnsetS * RATE)
	const frames = analyzerOf(name)
	const floorDb = median(
		frames.slice(0, Math.floor(onset / FRAME_SAMPLES)).map(f => f.carrierDb),
	)
	const unquieted = name === "nfm-noise" || name === "nfm-impulse"
	const gate = new EvidenceGate({ rate: RATE, modulation: entry.mode, gain: 2 })
	// preOpen: stage 1 already open on the unquieted pre-over noise (its power gate or 250 ms
	// hang, src/core/channel-squelch.ts), so those blocks are pushed and noted unquieted.
	if (!preOpen) gate.closed(onset * 2, "s16le")
	const out: Replay = {
		latched: false,
		atS: null,
		evidence: null,
		finalEvidence: null,
		changes: [],
	}
	for (let s = preOpen ? 0 : onset; s < audio.length; s += BLOCK_SAMPLES) {
		const end = Math.min(audio.length, s + BLOCK_SAMPLES)
		let carrier: boolean
		if (s < onset) carrier = false
		else if (entry.mode === "am") {
			const frame = frames[Math.floor(s / FRAME_SAMPLES)]
			carrier =
				frame !== undefined &&
				Number.isFinite(floorDb) &&
				frame.carrierDb >= floorDb + ANALOG_TRIAL_AM_CARRIER_DB
		} else carrier = !unquieted
		gate.noteBlock(carrier)
		const k = gate.push(pcm, "s16le", s * 2, end * 2)
		if (k >= 0 && !out.latched) {
			out.latched = true
			out.atS = k / 2 / RATE
			out.evidence = gate.evidence
		}
		const now = gate.evidence
		const last = out.changes[out.changes.length - 1]
		if (now !== null && last?.evidence !== now)
			out.changes.push({ atS: end / RATE, evidence: now })
	}
	out.finalEvidence = gate.evidence
	return out
}

const show = (r: Replay): string =>
	`latched=${r.latched} at=${r.atS === null ? "-" : r.atS.toFixed(3)} evidence=${r.evidence ?? "-"}`

describe("gate replay", () => {
	for (const name of names) {
		const entry = manifest[name]
		if (entry === undefined) continue
		it(`${name}: ${entry.expect}`, () => {
			const r = replay(name)
			if (entry.rollingWindowRisk !== undefined) {
				console.info(`EVIDENCE-SQUELCH RISK: ${name} ${show(r)}`)
				return
			}
			console.info(
				`EVIDENCE-SQUELCH REPLAY: ${name} ${show(r)} changes=${JSON.stringify(r.changes)}`,
			)
			if (entry.mode === "am") return // A8: AM is ungated; informational
			if (entry.expect === "none") {
				expect(r.latched).toBe(false)
				return
			}
			expect(r.latched).toBe(true)
			expect((r.atS ?? Infinity) - entry.overOnsetS).toBeLessThanOrEqual(1.5)
			if (entry.expect === "ctcss" && r.evidence === "voice") {
				// Low CTCSS tones qualify after the 1 s voice window: the tone must qualify later
				// in the same over and renew the status evidence to "ctcss".
				expect(r.changes.map(c => c.evidence)).toEqual(["voice", "ctcss"])
				expect(r.finalEvidence).toBe("ctcss")
			} else expect(r.evidence).toBe(entry.expect)
		})
	}
})

/** Continuous DMR-like 4FSK in discriminator PCM: rectangular symbols at 4 800 baud. */
function continuous4fsk(
	rate: number,
	seconds: number,
	seed: number,
): Float64Array {
	const rand = mulberry32(seed)
	const levels = [-1_944, -648, 648, 1_944].map(hz => (hz / 5_000) * 0.8)
	const n = Math.round(rate * seconds)
	const out = new Float64Array(n)
	let level = 0
	let next = 0
	for (let i = 0; i < n; i++) {
		if (i >= next) {
			level = levels[Math.floor(rand() * 4)] ?? 0
			next += rate / 4_800
		}
		out[i] = level + 0.002 * (rand() - 0.5)
	}
	return out
}

function driveQuieted(pcm: Buffer, rate: number): boolean {
	const gate = new EvidenceGate({ rate, modulation: "nfm", gain: 2 })
	const block = Math.round(rate / 100) * 2
	for (let s = 0; s < pcm.length; s += block) {
		gate.noteBlock(true)
		if (gate.push(pcm, "s16le", s, Math.min(pcm.length, s + block)) >= 0)
			return true
	}
	return false
}

describe("continuous 4FSK never latches (quieted NFM carrier)", () => {
	it("golden nfm-dmr-4fsk-continuous, stage 1 opening at the onset: rejected by the voice rule (median syllabic < 0.3); see the pre-open known risk below", () => {
		const audio = audioOf("nfm-dmr-4fsk-continuous")
		const onset = Math.round(
			(manifest["nfm-dmr-4fsk-continuous"]?.overOnsetS ?? 0) * RATE,
		)
		// Stage 1 opens at the over onset (the pre-over frames are unquieted noise, closed).
		expect(driveQuieted(pcmOf(audio.subarray(onset)), RATE)).toBe(false)
		// Which rule rejects it, on every full 20-frame window the gate judges:
		const frames = meterFrames(audio.subarray(onset), 2)
		let maxSyllabic = 0
		for (let s = 0; s + 20 <= frames.length; s++) {
			const m = mediansOf(frames.slice(s, s + 20))
			maxSyllabic = Math.max(maxSyllabic, m.syllabic)
			expect(m.syllabic).toBeLessThan(ANALOG_TRIAL_VOICE_INDEX)
		}
		const m = mediansOf(frames)
		console.info(
			`EVIDENCE-SQUELCH 4FSK: golden median cluster=${m.cluster.toFixed(2)} (data-like at ${ANALOG_TRIAL_DATA_SCORE}) max window syllabic=${maxSyllabic.toFixed(2)} (voice at ${ANALOG_TRIAL_VOICE_INDEX})`,
		)
	})

	for (const seed of [1, 2, 3, 4, 5]) {
		it(`synthetic continuous 4FSK at 25 kHz, seed ${seed}: never latches`, () => {
			const rate = 25_000
			const audio = continuous4fsk(rate, 4, seed)
			expect(driveQuieted(pcmOf(audio), rate)).toBe(false)
			// The same symbols synthesised at the meter's 8 kHz rate, to show which rules reject:
			// rectangular levels are data-like (cluster) and not syllabic.
			const at8k = continuous4fsk(RATE, 4, seed)
			const m = mediansOf(meterFrames(at8k, 2))
			console.info(
				`EVIDENCE-SQUELCH 4FSK: synthetic seed ${seed} median cluster=${m.cluster.toFixed(2)} syllabic=${m.syllabic.toFixed(2)}`,
			)
			expect(m.syllabic).toBeLessThan(ANALOG_TRIAL_VOICE_INDEX)
		})
	}
})

/**
 * Known risks (pending decision): with stage 1 already open on the pre-over noise, the first
 * full 20-frame window (frames 0-19) holds 5 unquieted noise frames plus the key-up, with 25
 * unquieted and 75 quieted blocks (quiet fraction 0.75 >= 0.5), and its medians are
 * voice-positive. Gate code and thresholds unchanged; these pin the current behaviour.
 */
const PREOPEN_KNOWN_RISK = new Set(["nfm-dmr-4fsk-continuous", "nfm-clicks"])

describe("stage 1 open on noise before the over (never-open NFM fixtures)", () => {
	for (const name of names) {
		const entry = manifest[name]
		if (entry?.mode !== "nfm" || entry.expect !== "none") continue
		const risk = PREOPEN_KNOWN_RISK.has(name)
		it(`${risk ? "known risk (pending decision): " : ""}${name}: pre-over noise unquieted ${risk ? "latches voice" : "never latches"}`, () => {
			const r = replay(name, true)
			const m = mediansOf(meterFrames(audioOf(name), 2).slice(0, 20))
			console.info(
				`EVIDENCE-SQUELCH PREOPEN: ${name} ${show(r)} first-window{${fmt(m)} syllabic4=${m.syllabic.toFixed(4)}}`,
			)
			if (risk) {
				expect(r.latched).toBe(true)
				expect(r.evidence).toBe("voice")
			} else expect(r.latched).toBe(false)
		})
	}
})
