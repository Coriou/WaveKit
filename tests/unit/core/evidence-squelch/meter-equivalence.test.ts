/**
 * Meter equivalence (requirements 5.1, 5.2, 8.4; plan Task FX.2): the TypeScript
 * `VoiceFrameMeter` against the IQ analyzer goldens of `scripts/evidence-squelch/`, and a
 * replay of every golden through the real `EvidenceGate`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { EvidenceGate } from "../../../../src/core/evidence-squelch/evidence-gate.js"
import { VoiceFrameMeter } from "../../../../src/core/evidence-squelch/voice-meter.js"
import { dataLike, isVoice } from "../../../../src/core/scanner/analog-trial.js"
import { ANALOG_TRIAL_AM_CARRIER_DB } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	AnalogTrialFrame,
	AnalogTrialStats,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"

const DIR = join(process.cwd(), "tests/mocks/fixtures/evidence-squelch")
const RATE = 8_000
/** 10 ms measurement blocks at 8 kHz, as the live demodulator's level timer notes them. */
const BLOCK_SAMPLES = 80
const FRAME_SAMPLES = 400

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
const StatsSchema = z.object({
	event: z.literal("analysis"),
	frames: z.array(
		z.object({
			carrierDb: z.number(),
			hfNoiseDb: z.number(),
			audioDb: z.number(),
			syllabic: z.number(),
			cluster: z.number(),
		}),
	),
})

const manifest = ManifestSchema.parse(
	JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")),
)
const names = Object.keys(manifest)

function audioOf(name: string): Float64Array {
	const buf = readFileSync(join(DIR, `${name}.audio.s16le`))
	const out = new Float64Array(buf.length >> 1)
	for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32_768
	return out
}

function statsOf(name: string): AnalogTrialFrame[] {
	return StatsSchema.parse(
		JSON.parse(readFileSync(join(DIR, `${name}.stats.json`), "utf8")),
	).frames
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 === 1
		? (sorted[mid] ?? NaN)
		: ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2
}

interface Medians {
	audioDb: number
	syllabic: number
	cluster: number
}

function mediansOf(frames: readonly Medians[]): Medians {
	return {
		audioDb: median(frames.map(f => f.audioDb)),
		syllabic: median(frames.map(f => f.syllabic)),
		cluster: median(frames.map(f => f.cluster)),
	}
}

function meterFrames(samples: ArrayLike<number>, gain: number): Medians[] {
	const meter = new VoiceFrameMeter({ gain })
	const frames: Medians[] = []
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

function verdictOf(
	frames: readonly Medians[],
	mode: "nfm" | "am",
): "voice" | "data-like" | "neither" {
	const stats: AnalogTrialStats = {
		mode,
		frames: frames.map(f => ({ carrierDb: 0, hfNoiseDb: 0, ...f })),
		gapSamples: 0,
		floorDb: 0,
	}
	if (dataLike(stats)) return "data-like"
	return isVoice(stats) ? "voice" : "neither"
}

function scaled(samples: Float64Array, k: number): Float64Array {
	return samples.map(x => x * k)
}

/** Fast AGC (peak follower: instant attack, 100 ms release, reference 0.4, gain at most 1 000). */
function fastAgc(samples: Float64Array): Float64Array {
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

const fmt = (m: Medians): string =>
	`audioDb=${m.audioDb.toFixed(2)} syllabic=${m.syllabic.toFixed(2)} cluster=${m.cluster.toFixed(2)}`

function checkTolerances(name: string, got: Medians, want: Medians): void {
	expect(
		Math.abs(got.audioDb - want.audioDb),
		`${name} audioDb`,
	).toBeLessThanOrEqual(1.5)
	expect(
		Math.abs(got.syllabic - want.syllabic),
		`${name} syllabic`,
	).toBeLessThanOrEqual(0.1)
	expect(
		Math.abs(got.cluster - want.cluster),
		`${name} cluster`,
	).toBeLessThanOrEqual(0.15)
	expect(got.cluster >= 0.6, `${name} cluster side of 0.6`).toBe(
		want.cluster >= 0.6,
	)
}

describe("meter equivalence", () => {
	it("manifest holds the 17 fixtures", () => {
		expect(names).toHaveLength(17)
	})

	for (const name of names) {
		const entry = manifest[name]
		if (entry === undefined) continue
		it(`${name}: medians and verdict match the analyzer`, () => {
			const want = mediansOf(statsOf(name))
			const frames = meterFrames(audioOf(name), 2)
			expect(frames).toHaveLength(80)
			const got = mediansOf(frames)
			console.info(
				`EVIDENCE-SQUELCH FX.2: ${name} ts{${fmt(got)}} analyzer{${fmt(want)}}`,
			)
			checkTolerances(name, got, want)
			expect(verdictOf(frames, entry.mode)).toBe(entry.verdict)
		})

		it(`${name}: audio x1.5 into gain 3 meets the same tolerances`, () => {
			const want = mediansOf(statsOf(name))
			const frames = meterFrames(scaled(audioOf(name), 1.5), 3)
			checkTolerances(name, mediansOf(frames), want)
			expect(verdictOf(frames, entry.mode)).toBe(entry.verdict)
		})
	}

	it("AGC and de-emphasis verdicts (informational, requirements 5.2 and 8.4)", () => {
		for (const name of names) {
			const entry = manifest[name]
			if (entry === undefined) continue
			const audio = audioOf(name)
			const agc = meterFrames(fastAgc(audio), 2)
			const de = meterFrames(deemphasis(audio), 2)
			console.info(
				`EVIDENCE-SQUELCH 5.2: ${name} agc=${verdictOf(agc, entry.mode)} {${fmt(mediansOf(agc))}} deemph=${verdictOf(de, entry.mode)} {${fmt(mediansOf(de))}}`,
			)
		}
		const am = names.filter(n => manifest[n]?.mode === "am")
		const parts = am.map(n => {
			const frames = meterFrames(fastAgc(audioOf(n)), 2)
			return `${n} agc=${verdictOf(frames, "am")} ${fmt(mediansOf(frames))}`
		})
		console.info(`EVIDENCE-SQUELCH 8.4: ${parts.join("; ")}`)
		expect(am.length).toBeGreaterThan(0)
	})
})

interface Replay {
	latched: boolean
	atS: number | null
	evidence: string | null
}

/**
 * Feeds the golden through the real gate: stage 1 closed before the over onset (`closed()`),
 * open from it, in 10 ms blocks each preceded by `noteBlock(carrier)`.
 * Carrier evidence: NFM by fixture class (quieted unless the channel is unquieted noise);
 * AM by the wiring's rule, block power ≥ floor + `ANALOG_TRIAL_AM_CARRIER_DB`, taken from the
 * analyzer's `carrierDb` of the enclosing frame against the pre-onset floor.
 */
function replay(name: string): Replay {
	const entry = manifest[name]
	if (entry === undefined) throw new Error(`no manifest entry ${name}`)
	const audio = audioOf(name)
	const pcm = Buffer.alloc(audio.length * 2)
	for (let i = 0; i < audio.length; i++)
		pcm.writeInt16LE(
			Math.max(-32_768, Math.min(32_767, Math.round((audio[i] ?? 0) * 32_768))),
			i * 2,
		)
	const onset = Math.round(entry.overOnsetS * RATE)
	const frames = statsOf(name)
	const floorDb = median(
		frames.slice(0, Math.floor(onset / FRAME_SAMPLES)).map(f => f.carrierDb),
	)
	const unquieted = name === "nfm-noise" || name === "nfm-impulse"
	const gate = new EvidenceGate({ rate: RATE, modulation: entry.mode, gain: 2 })
	gate.closed(onset * 2, "s16le")
	for (let s = onset; s < audio.length; s += BLOCK_SAMPLES) {
		const end = Math.min(audio.length, s + BLOCK_SAMPLES)
		let carrier: boolean
		if (entry.mode === "am") {
			const frame = frames[Math.floor(s / FRAME_SAMPLES)]
			carrier =
				frame !== undefined &&
				Number.isFinite(floorDb) &&
				frame.carrierDb >= floorDb + ANALOG_TRIAL_AM_CARRIER_DB
		} else carrier = !unquieted
		gate.noteBlock(carrier)
		const k = gate.push(pcm, "s16le", s * 2, end * 2)
		if (k >= 0)
			return { latched: true, atS: k / 2 / RATE, evidence: gate.evidence }
	}
	return { latched: false, atS: null, evidence: null }
}

describe("gate replay", () => {
	for (const name of names) {
		const entry = manifest[name]
		if (entry === undefined) continue
		it(`${name}: ${entry.expect}`, () => {
			const r = replay(name)
			if (entry.rollingWindowRisk !== undefined) {
				console.info(
					`EVIDENCE-SQUELCH RISK: ${name} latched=${r.latched} at=${r.atS === null ? "-" : r.atS.toFixed(3)} evidence=${r.evidence ?? "-"}`,
				)
				return
			}
			console.info(
				`EVIDENCE-SQUELCH REPLAY: ${name} latched=${r.latched} at=${r.atS === null ? "-" : r.atS.toFixed(3)} evidence=${r.evidence ?? "-"}`,
			)
			if (entry.expect === "none") {
				expect(r.latched).toBe(false)
			} else {
				expect(r.latched).toBe(true)
				expect(r.evidence).toBe(entry.expect)
			}
		})
	}
})
