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
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import {
	EVIDENCE_ONSET_ARM_UNQUIETED_BLOCKS,
	EVIDENCE_ONSET_DISARM_QUIETED_BLOCKS,
	EvidenceGate,
} from "../../../../src/core/evidence-squelch/evidence-gate.js"
import { PreRoll } from "../../../../src/core/evidence-squelch/pre-roll.js"
import {
	EVIDENCE_NARROW_DEVIATION_HZ,
	EVIDENCE_NOTE_DISCARD,
	EVIDENCE_WIDE_DEVIATION_HZ,
} from "../../../../src/core/evidence-squelch/contract.js"
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
/** Noisy stage-1 lead-in bound: 250 ms power-gate lead + 250 ms hang (channel-squelch.ts). */
const LEAD_IN_MAX_MS = 500

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

/**
 * Deviation reference of every gate below (amendment A13, 2026-10-24): 5 000 Hz is the frozen
 * 25 kHz plan; the narrow-plan section at the end reruns the never-open checks at 2 500 Hz.
 */
let gateDeviationHz = EVIDENCE_WIDE_DEVIATION_HZ

function gateOf(rate: number, modulation: "nfm" | "am"): EvidenceGate {
	return new EvidenceGate({
		rate,
		modulation,
		gain: 2,
		deviationHz: gateDeviationHz,
	})
}

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
	const gate = gateOf(RATE, entry.mode)
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

/** Quieted NFM drive; the first `leadBytes` are a noise lead-in noted unquieted. */
function driveQuieted(pcm: Buffer, rate: number, leadBytes = 0): boolean {
	const gate = gateOf(rate, "nfm")
	const block = Math.round(rate / 100) * 2
	for (let s = 0; s < pcm.length; s += block) {
		gate.noteBlock(s >= leadBytes)
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
		// Noisy onset: stage 1 open on the 250 ms pre-over noise, noted unquieted.
		expect(driveQuieted(pcmOf(audio), RATE, onset * 2)).toBe(false)
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
			// Noisy onset: 0-500 ms of unquieted noise (stage 1 open on it) before the symbols.
			const noise = mulberry32(seed + 100)
			for (const leadMs of [10, 40, 250, LEAD_IN_MAX_MS]) {
				const lead = Math.round((rate * leadMs) / 1_000)
				const withLead = new Float64Array(lead + audio.length)
				for (let i = 0; i < lead; i++) withLead[i] = 0.9 * (2 * noise() - 1)
				withLead.set(audio, lead)
				expect(driveQuieted(pcmOf(withLead), rate, lead * 2)).toBe(false)
			}
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
 * Noisy stage-1 lead-in (design amendment 2026-10-23, window reset on carrier onset). Stage 1
 * can be open on unquieted noise before the over through its power gate or its 250 ms hang
 * (src/core/channel-squelch.ts); the bound used here is 250 ms + 250 ms = 500 ms of lead-in.
 * The lead-in is the fixture's own pre-over noise (8 kHz golden, cycled), noted unquieted; the
 * over is noted as the fixture class gives. This mirrors the wiring (live-demodulator.ts):
 * per 10 ms block, the carrier-onset rule (abandon the pre-roll while waiting), noteBlock, then
 * push and the pre-roll tags.
 */

interface LeadInRun {
	/** Latch time after the over onset (s), or null. */
	latchS: number | null
	/** Over-relative index (8 kHz samples) of the first played sample; negative = lead-in noise. */
	playedFrom: number | null
}

/**
 * `leadCarrier(block)` gives the carrier evidence of each lead-in block (default: all
 * unquieted). Lead blocks carry the fixture's pre-over noise (a quieting flicker is a flag
 * flicker on that noise), except blocks where `leadSilent(block)` (a kerchunk: quiet carrier,
 * silence).
 */
function leadInRun(
	name: string,
	leadMs: number,
	leadCarrier: (block: number) => boolean = () => false,
	leadSilent: (block: number) => boolean = () => false,
	/** Carrier evidence of over block `b` (over-relative); default: the fixture class. */
	overCarrier?: (block: number) => boolean,
): LeadInRun {
	const entry = manifest[name]
	if (entry === undefined) throw new Error(`no manifest entry ${name}`)
	const audio = audioOf(name)
	const onset = Math.round(entry.overOnsetS * RATE)
	const lead = Math.round((leadMs * RATE) / 1_000)
	const composed = new Float64Array(lead + audio.length - onset)
	for (let i = 0; i < lead; i++)
		composed[i] = leadSilent(Math.floor(i / BLOCK_SAMPLES))
			? 0
			: (audio[i % onset] ?? 0)
	composed.set(audio.subarray(onset), lead)
	const input = pcmOf(composed)
	const buf = Buffer.from(input)
	const unquieted = name === "nfm-noise" || name === "nfm-impulse"
	const gate = gateOf(RATE, "nfm")
	const preRoll = new PreRoll({ rate: RATE, format: "s16le" })
	let latchS: number | null = null
	for (let s = 0; s < composed.length; s += BLOCK_SAMPLES) {
		const end = Math.min(composed.length, s + BLOCK_SAMPLES)
		const carrier =
			s < lead
				? leadCarrier(Math.floor(s / BLOCK_SAMPLES))
				: overCarrier !== undefined
					? overCarrier(Math.floor((s - lead) / BLOCK_SAMPLES))
					: !unquieted
		// The wiring: the gate flags a noise lead-in; the owner drops the held audio.
		if ((gate.noteBlock(carrier) & EVIDENCE_NOTE_DISCARD) !== 0)
			preRoll.abandon()
		const k = gate.push(buf, "s16le", s * 2, end * 2)
		if (k >= 0) {
			if (latchS === null) latchS = (k / 2 - lead) / RATE
			preRoll.process(buf, s * 2, k, "pending")
			preRoll.latch()
			preRoll.process(buf, k, end * 2, "pass")
		} else
			preRoll.process(
				buf,
				s * 2,
				end * 2,
				gate.state === "open" ? "pass" : "pending",
			)
	}
	let playedFrom: number | null = null
	const n = buf.length >> 1
	let q = 0
	while (q < n && buf.readInt16LE(q * 2) === 0) q++
	const match = 32
	if (q + match <= n)
		for (let p = Math.max(0, q - 1.5 * RATE); p <= q; p++) {
			let same = true
			for (let j = 0; j < match && same; j++)
				same = buf.readInt16LE((q + j) * 2) === input.readInt16LE((p + j) * 2)
			if (same) {
				playedFrom = p - lead
				break
			}
		}
	return { latchS, playedFrom }
}

const neverOpenNfm = names.filter(
	n => manifest[n]?.mode === "nfm" && manifest[n]?.expect === "none",
)

describe("stage 1 open on noise before the over (never-open NFM fixtures)", () => {
	for (const name of neverOpenNfm) {
		it(`${name}: closed with ideal onset and with the 250 ms pre-over noise open`, () => {
			const ideal = replay(name)
			const noisy = replay(name, true)
			console.info(
				`EVIDENCE-SQUELCH PREOPEN: ${name} ideal{${show(ideal)}} noisy{${show(noisy)}}`,
			)
			expect(ideal.latched).toBe(false)
			expect(noisy.latched).toBe(false)
		})
	}

	// Feature: evidence-squelch, Property 3: Bare carrier and data never open
	// Validates: Requirements 1.4
	it("Property 3 (noisy lead-in): no never-open NFM fixture latches after 0-500 ms of noise", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...neverOpenNfm),
				fc.integer({ min: 0, max: LEAD_IN_MAX_MS / 10 }),
				(name, blocks) => leadInRun(name, blocks * 10).latchS === null,
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})

/** Lead-in flicker pattern: unquieted noise with quieted runs of at most DISARM - 1 blocks. */
const flickerArb = fc
	.tuple(
		fc.integer({ min: 1, max: LEAD_IN_MAX_MS / 10 }),
		fc.array(
			fc.tuple(
				fc.integer({ min: 0, max: LEAD_IN_MAX_MS / 10 - 1 }),
				fc.integer({ min: 1, max: EVIDENCE_ONSET_DISARM_QUIETED_BLOCKS - 1 }),
			),
			{ maxLength: 8 },
		),
	)
	.map(([blocks, flickers]) => {
		const quiet = new Set<number>()
		for (const [at, len] of flickers)
			for (let i = at; i < at + len && i < blocks; i++) quiet.add(i)
		// Keep every quieted run under the disarm length (merged flickers can touch).
		let run = 0
		for (let i = 0; i < blocks; i++) {
			if (quiet.has(i)) {
				run += 1
				if (run >= EVIDENCE_ONSET_DISARM_QUIETED_BLOCKS) {
					quiet.delete(i)
					run = 0
				}
			} else run = 0
		}
		// The last lead block stays unquieted, so the over's first block is an onset; a flicker
		// touching the over is the documented limit below.
		quiet.delete(blocks - 1)
		return { blocks, quiet }
	})

describe("lead-in flicker and kerchunks (window-reset revision 2026-10-23)", () => {
	it("250 ms lead-in unquieted except its second block never latches", () => {
		for (const name of ["nfm-dmr-4fsk-continuous", "nfm-clicks"])
			expect(leadInRun(name, 250, b => b === 1).latchS).toBeNull()
	})

	// Feature: evidence-squelch, Property 3: Bare carrier and data never open
	// Validates: Requirements 1.4
	it("Property 3 (flicker): quieted flickers of 1-4 blocks inside a 10-500 ms lead-in never open a never-open NFM fixture", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...neverOpenNfm),
				flickerArb,
				(name, { blocks, quiet }) =>
					leadInRun(name, blocks * 10, b => quiet.has(b)).latchS === null,
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("flicker bound: a 4-block quieted flicker keeps the reset armed; a 5-block one disarms, and noise of >= 5 blocks after it re-arms", () => {
		// At the bound: 20 noise, 4 quieted, 6 noise -> the over still resets the window.
		const at = (b: number): boolean => b >= 20 && b < 24
		// Past the bound: 20 noise, 5 quieted (disarm), 5 noise (re-arm) -> reset at the over.
		const past = (b: number): boolean => b >= 20 && b < 25
		for (const name of neverOpenNfm) {
			expect(leadInRun(name, 300, at).latchS).toBeNull()
			expect(leadInRun(name, 300, past).latchS).toBeNull()
		}
	})

	it("kerchunk -> noise -> over in one episode: never-open stay closed, voice plays from the over", () => {
		// 100 ms kerchunk (quieted, disarms), 200 ms noise (re-arms), then the over.
		const kerchunk = (b: number): boolean => b < 10
		for (const name of neverOpenNfm)
			expect(leadInRun(name, 300, kerchunk, kerchunk).latchS).toBeNull()
		for (const name of ["nfm-voice", "nfm-ctcss-670-voice"]) {
			const r = leadInRun(name, 300, kerchunk, kerchunk)
			expect(r.latchS).toBe(1.0)
			expect(r.playedFrom).toBe(0)
		}
	})

	it("documented limit (pending decision): >= 50 ms quieted inside the noise, then under 50 ms of noise before the over", () => {
		// 20 noise, 5 quieted (disarm), then 1-4 noise blocks before the over: not re-armed (a
		// 1-4 block run is indistinguishable from a fade inside an over), so those blocks and the
		// quieted ones are judged with the over. Pinned so a change is visible.
		const rows: string[] = []
		for (const name of neverOpenNfm)
			for (
				let noise = 1;
				noise < EVIDENCE_ONSET_ARM_UNQUIETED_BLOCKS;
				noise++
			) {
				const q = (b: number): boolean => b >= 20 && b < 25
				const r = leadInRun(name, 250 + noise * 10, q, q)
				if (r.latchS !== null) rows.push(`${name}+${noise}`)
			}
		console.info(
			`EVIDENCE-SQUELCH ARM-LIMIT latches: ${rows.join(" ") || "none"}`,
		)
		expect(rows).toEqual([
			"nfm-dmr-4fsk-continuous+1",
			"nfm-dmr-4fsk-continuous+2",
			"nfm-dmr-4fsk-continuous+3",
			"nfm-dmr-4fsk-continuous+4",
			"nfm-clicks+1",
		])
	})
})

describe("onset preservation: early fades never discard the over (review 2026-10-23)", () => {
	it("nfm-voice, blocks 0-3 quieted, block 4 unquieted, then quieted: plays from over sample 0", () => {
		const r = leadInRun("nfm-voice", 0, undefined, undefined, b => b !== 4)
		// The analysis window resets at 50 ms (latch 1.05 s), but the held audio is kept.
		expect(r.latchS).toBeCloseTo(1.05, 6)
		expect(r.playedFrom).toBe(0)
	})

	for (const name of ["nfm-voice", "nfm-ctcss-670-voice", "nfm-dcs-023n-voice"])
		it(`${name}: flutter (random 10-40 ms dropouts) keeps the over's first sample`, () => {
			for (const seed of [1, 2, 3, 4, 5, 6]) {
				const rand = mulberry32(seed)
				const drop = new Set<number>()
				let b = Math.floor(rand() * 8)
				while (b < 400) {
					const len = 1 + Math.floor(rand() * 4) // 1-4 blocks: under ARM, never discards
					for (let i = 0; i < len; i++) drop.add(b + i)
					b += len + 5 + Math.floor(rand() * 20)
				}
				const r = leadInRun(name, 0, undefined, undefined, x => !drop.has(x))
				expect(r.latchS).not.toBeNull()
				expect(r.latchS ?? Infinity).toBeLessThanOrEqual(1.5)
				expect(r.playedFrom).toBe(0)
			}
		})

	it("documented consequence: a noise lead-in under ARM (10-40 ms) plays before the over", () => {
		for (const leadMs of [10, 20, 30, 40]) {
			const r = leadInRun("nfm-voice", leadMs)
			expect(r.latchS).not.toBeNull()
			expect(r.playedFrom).toBe(-(leadMs * RATE) / 1_000)
		}
		// At ARM (50 ms) the lead-in is discarded: playback starts at the over.
		expect(leadInRun("nfm-voice", 50).playedFrom).toBe(0)
	})
})

describe("flicker touching the over (documented limit, pending decision)", () => {
	it("a quieted flicker on noise right before the over is judged as the over's start", () => {
		// The over starts after a quieted block, so no reset falls on it; the flicker's 10-40 ms
		// of noise audio is in the first window. Pinned per fixture and flicker length.
		const rows: string[] = []
		for (const name of neverOpenNfm)
			for (let len = 1; len < EVIDENCE_ONSET_DISARM_QUIETED_BLOCKS; len++)
				if (leadInRun(name, 250, b => b >= 25 - len).latchS !== null)
					rows.push(`${name}+${len}`)
		console.info(
			`EVIDENCE-SQUELCH FLICKER-AT-ONSET latches: ${rows.join(" ") || "none"}`,
		)
		expect(rows).toEqual([
			"nfm-dmr-4fsk-continuous+2",
			"nfm-dmr-4fsk-continuous+3",
			"nfm-dmr-4fsk-continuous+4",
			"nfm-clicks+1",
		])
	})
})

describe("nfm-clicks alignment sensitivity (documented, pending decision)", () => {
	it("latches voice when only 10 or 60 ms of quiet carrier (silence) precede it, no noise at all", () => {
		// Independent of the window reset: shifting the clicks over by a quiet 10 ms block moves
		// the 50 ms frame edges, and the judge then calls the first window voice. Pinned.
		const rows: number[] = []
		for (let k = 1; k <= 10; k++)
			if (
				leadInRun(
					"nfm-clicks",
					k * 10,
					() => true,
					() => true,
				).latchS !== null
			)
				rows.push(k * 10)
		expect(rows).toEqual([10, 60])
	})
})

describe("exhaustive noisy lead-in sweep", () => {
	it("no never-open NFM fixture latches for any lead-in of 0-500 ms in 10 ms steps", () => {
		const hits: string[] = []
		for (const name of neverOpenNfm)
			for (let ms = 0; ms <= LEAD_IN_MAX_MS; ms += 10)
				if (leadInRun(name, ms).latchS !== null) hits.push(`${name}@${ms}ms`)
		expect(hits).toEqual([])
	}, 120_000)
})

describe("a real over after a noisy lead-in still latches from the over", () => {
	for (const name of ["nfm-voice", "nfm-ctcss-670-voice", "nfm-dcs-023n-voice"])
		for (const leadMs of [0, 50, 250, LEAD_IN_MAX_MS]) {
			it(`${name} after ${leadMs} ms of noise: latch by onset + 1.0 s, pre-roll starts at the over`, () => {
				// Reset at the onset block, empty meter: the 20-frame window (1.0 s) is full at
				// onset + 1.0 s; the pre-roll was abandoned at the onset, so it holds 1.0 s of the
				// over (under its 1.5 s capacity) and plays from the over's first sample.
				const r = leadInRun(name, leadMs)
				console.info(
					`EVIDENCE-SQUELCH LEADIN: ${name} lead=${leadMs}ms latch=${r.latchS?.toFixed(4) ?? "-"}s playedFrom=${r.playedFrom ?? "-"}`,
				)
				expect(r.latchS).not.toBeNull()
				expect(r.latchS ?? Infinity).toBeLessThanOrEqual(1.0)
				expect(r.playedFrom).not.toBeNull()
				expect(r.playedFrom ?? -1).toBeGreaterThanOrEqual(0)
				expect(r.playedFrom ?? Infinity).toBeLessThanOrEqual(RATE * 0.02)
			})
		}
})

/**
 * Amendment A13 (2026-10-24): on a 12.5 kHz channel the meter normalises the ±2.5 kHz plan onto
 * the 5 kHz reference (samples × 2). The never-open NFM fixtures must stay closed there too.
 */
describe("A13 narrow channel plan (2 500 Hz): never-open NFM fixtures stay closed", () => {
	beforeAll(() => {
		gateDeviationHz = EVIDENCE_NARROW_DEVIATION_HZ
	})
	afterAll(() => {
		gateDeviationHz = EVIDENCE_WIDE_DEVIATION_HZ
	})

	for (const name of neverOpenNfm)
		it(`${name}: closed with ideal onset and with the 250 ms pre-over noise open`, () => {
			expect(replay(name).latched).toBe(false)
			expect(replay(name, true).latched).toBe(false)
		})

	it("no never-open NFM fixture latches for any lead-in of 0-500 ms in 10 ms steps", () => {
		const hits: string[] = []
		for (const name of neverOpenNfm)
			for (let ms = 0; ms <= LEAD_IN_MAX_MS; ms += 10)
				if (leadInRun(name, ms).latchS !== null) hits.push(`${name}@${ms}ms`)
		expect(hits).toEqual([])
	}, 120_000)

	// Feature: evidence-squelch, Property 3: Bare carrier and data never open
	// Validates: Requirements 1.4
	it("Property 3 (flicker, narrow plan): quieted flickers of 1-4 blocks inside a 10-500 ms lead-in never open a never-open NFM fixture", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...neverOpenNfm),
				flickerArb,
				(name, { blocks, quiet }) =>
					leadInRun(name, blocks * 10, b => quiet.has(b)).latchS === null,
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	for (const seed of [1, 2, 3, 4, 5])
		it(`synthetic continuous 4FSK at 25 kHz, seed ${seed}: never latches`, () => {
			expect(driveQuieted(pcmOf(continuous4fsk(25_000, 4, seed)), 25_000)).toBe(
				false,
			)
		})

	it("documented limits (pending decision): the residual cases of 1.4 at the narrow plan", () => {
		// Cases (a) and (b) of the known limitation after 1.4 gain one row each at 2 500 Hz
		// (nfm-clicks with 3 blocks), and case (c) gains the 30 and 80 ms alignments: a click is a
		// 2π phase step whatever the channel, so on the narrow plan it is twice as large relative to
		// the channel's deviation. Pinned so a change is visible.
		const clicksAt: number[] = []
		for (let k = 1; k <= 10; k++)
			if (
				leadInRun(
					"nfm-clicks",
					k * 10,
					() => true,
					() => true,
				).latchS !== null
			)
				clicksAt.push(k * 10)
		const armLimit: string[] = []
		const atOnset: string[] = []
		for (const name of neverOpenNfm) {
			for (
				let noise = 1;
				noise < EVIDENCE_ONSET_ARM_UNQUIETED_BLOCKS;
				noise++
			) {
				const q = (b: number): boolean => b >= 20 && b < 25
				if (leadInRun(name, 250 + noise * 10, q, q).latchS !== null)
					armLimit.push(`${name}+${noise}`)
			}
			for (let len = 1; len < EVIDENCE_ONSET_DISARM_QUIETED_BLOCKS; len++)
				if (leadInRun(name, 250, b => b >= 25 - len).latchS !== null)
					atOnset.push(`${name}+${len}`)
		}
		console.info(
			`EVIDENCE-SQUELCH A13 limits: arm=${armLimit.join(" ") || "none"} onset=${atOnset.join(" ") || "none"}`,
		)
		expect(armLimit).toEqual([
			"nfm-dmr-4fsk-continuous+1",
			"nfm-dmr-4fsk-continuous+2",
			"nfm-dmr-4fsk-continuous+3",
			"nfm-dmr-4fsk-continuous+4",
			"nfm-clicks+1",
			"nfm-clicks+3",
		])
		expect(atOnset).toEqual([
			"nfm-dmr-4fsk-continuous+2",
			"nfm-dmr-4fsk-continuous+3",
			"nfm-dmr-4fsk-continuous+4",
			"nfm-clicks+1",
			"nfm-clicks+3",
		])
		console.info(`EVIDENCE-SQUELCH A13 clicks alignment: ${clicksAt.join(" ")}`)
		expect(clicksAt).toEqual([10, 30, 60, 80])
	})

	for (const name of ["nfm-voice", "nfm-ctcss-670-voice", "nfm-dcs-023n-voice"])
		it(`${name} still latches by onset + 1.0 s after 0-500 ms of noise`, () => {
			for (const leadMs of [0, 50, 250, LEAD_IN_MAX_MS]) {
				const r = leadInRun(name, leadMs)
				expect(r.latchS ?? Infinity).toBeLessThanOrEqual(1.0)
				expect(r.playedFrom ?? -1).toBeGreaterThanOrEqual(0)
			}
		})
})
