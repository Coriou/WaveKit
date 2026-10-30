/**
 * A/B of the release `wavekit-chan` demod against a pure-JS reference.
 *
 * csdr is not installed on this Mac (`command -v csdr` is empty), so this file
 * does not shell out to csdr. The reference is shift, a Hamming windowed-sinc
 * decimator to 48 kHz, then an atan2 discriminator or an AM envelope. A csdr
 * A/B on the same signals is part of Main's live test plan.
 *
 * Skip reason when the binary is absent: the release binary
 * native/wavekit-chan/target/release/wavekit-chan is missing. Build it with
 * `cargo build --release --locked --offline --manifest-path native/wavekit-chan/Cargo.toml`,
 * or point WAVEKIT_CHAN_AB_BINARY at a built one.
 *
 * Tolerances: normalised correlation with the reference at the best lag
 * within MAX_LAG_S, at least 0.98 for NFM and 0.95 for AM. WFM has no Rust
 * demod: the default engine resolves it to the csdr chain, asserted below
 * without the binary.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Socket } from "node:net"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { LiveDemodConfigSchema, type SourceCaps } from "../../../src/config.js"
import { rustEngineRequested } from "../../../src/core/live-demod/rust-run.js"
import { selectEngine } from "../../../src/core/live-demod/select-engine.js"
import { ToneDetector } from "../../../src/core/audio-tones/tone-detector.js"
import { RustEngine } from "../../../src/core/live-demod/rust-engine.js"
import { createLogger } from "../../../src/utils/logger.js"
import { dcsAudio } from "./audio-tones/dcs-synth.js"
import { FmChannelSynth } from "./fm-synth.js"

const RATE = 2_048_000
const AUDIO_RATE = 48_000
const SECONDS = 1.6
const SAMPLES = Math.round(RATE * SECONDS)
const DEVIATION_HZ = 5_000
const SKIP_S = 0.1
const MAX_LAG_S = 0.2
// Each case synthesizes 1.6 × 2,048,000 = 3,276,800 IQ samples, performs
// ~60 M FIR operations and ~45 M correlation products in JS, plus a child run.
// At eight contending workers, 8 × 5 s CPU + 10 s child/IO allowance < 60 s.
const AB_TIMEOUT_MS = 60_000

const binary =
	process.env["WAVEKIT_CHAN_AB_BINARY"] ??
	join(process.cwd(), "native/wavekit-chan/target/release/wavekit-chan")
const binaryMissing = !existsSync(binary)

const stage1Taps = designLowpass(63, 20_000 / RATE)
const stage2Taps = designLowpass(31, 16_000 / 256_000)

describe.skipIf(binaryMissing)(
	binaryMissing
		? "rust demod A/B skipped: release binary native/wavekit-chan/target/release/wavekit-chan is absent; build with cargo build --release --locked --offline --manifest-path native/wavekit-chan/Cargo.toml"
		: "rust demod A/B against a pure-JS reference (csdr is not on macOS)",
	() => {
		const engines: RustEngine[] = []

		afterEach(async () => {
			for (const engine of engines) await engine.stop()
			engines.length = 0
		})

		for (const tone of [67, 100, 250.3]) {
			it(
				`NFM CTCSS ${tone} Hz correlates and is identified`,
				async () => {
					const cu8 = synthCtcss(tone)
					const rust = await rustAudio(engines, cu8, "nfm")
					const reference = referenceDemod(cu8, "nfm")
					const score = bestNormalizedCorrelation(rust, reference)
					expect(
						score.corr,
						`normalised correlation ${score.corr} at lag ${score.lag} samples (rust ${rust.length}, reference ${reference.length} samples)`,
					).toBeGreaterThanOrEqual(0.98)
					const detected = detect(rust)
					expect(detected.ctcssHz).toBe(tone)
				},
				AB_TIMEOUT_MS,
			)
		}

		it(
			"NFM DCS 023 correlates and is identified",
			async () => {
				const cu8 = synthDcs()
				const rust = await rustAudio(engines, cu8, "nfm")
				const reference = referenceDemod(cu8, "nfm")
				const score = bestNormalizedCorrelation(rust, reference)
				expect(
					score.corr,
					`normalised correlation ${score.corr} at lag ${score.lag} samples`,
				).toBeGreaterThanOrEqual(0.98)
				expect(detect(rust).dcs).toEqual({ code: "023", polarity: "normal" })
			},
			AB_TIMEOUT_MS,
		)

		it(
			"AM 1 kHz m=0.5 correlates",
			async () => {
				const cu8 = synthAm()
				const rust = await rustAudio(engines, cu8, "am")
				const reference = referenceDemod(cu8, "am")
				const score = bestNormalizedCorrelation(rust, reference)
				expect(
					score.corr,
					`normalised correlation ${score.corr} at lag ${score.lag} samples`,
				).toBeGreaterThanOrEqual(0.95)
			},
			AB_TIMEOUT_MS,
		)
	},
)

describe("default engine per modulation (no binary needed)", () => {
	const probe = { available: true, protocol: 3 }
	const caps = { format: "U8_IQ" }
	for (const [modulation, bandwidth] of [
		["nfm", 12_500],
		["am", 10_000],
		["wfm", 200_000],
	] as const) {
		it(`an omitted engine runs ${modulation} on csdr without a fallback`, () => {
			const config = LiveDemodConfigSchema.parse({ modulation, bandwidth })
			expect(config.engine).toBeUndefined()
			expect(rustEngineRequested(config)).toBe(false)
			expect(
				selectEngine({
					config: { engine: config.engine, modulation, bandwidth },
					caps,
					probe,
				}),
			).toEqual({ engine: "csdr" })
		})
	}

	for (const [modulation, bandwidth, expected] of [
		["nfm", 12_500, { engine: "rust" }],
		["am", 10_000, { engine: "rust" }],
		["wfm", 200_000, { engine: "csdr", fallback: "modulation-unsupported" }],
	] as const) {
		it(`engine rust runs ${modulation} on ${expected.engine}`, () => {
			const config = LiveDemodConfigSchema.parse({
				engine: "rust",
				modulation,
				bandwidth,
			})
			expect(rustEngineRequested(config)).toBe(true)
			expect(
				selectEngine({
					config: { engine: "rust", modulation, bandwidth },
					caps,
					probe,
				}),
			).toEqual(expected)
		})
	}

	it("engine csdr stays csdr for every modulation", () => {
		const config = LiveDemodConfigSchema.parse({ engine: "csdr" })
		expect(rustEngineRequested(config)).toBe(false)
	})
})

async function rustAudio(
	engines: RustEngine[],
	cu8: Buffer,
	modulation: "nfm" | "am",
): Promise<Float32Array> {
	const input = new PassThrough()
	const chunks: Buffer[] = []
	const engine = new RustEngine({
		binaryPath: binary,
		logger: createLogger({ level: "fatal" }),
		probeTimeoutMs: 2000,
		openTimeoutMs: 2000,
		stopKillMs: 2000,
	})
	engines.push(engine)
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: RATE,
		format: "U8_IQ",
		centerFreq: 100_000_000,
		exclusive: false,
	}
	const started = await engine.start({
		config: LiveDemodConfigSchema.parse({
			engine: "rust",
			modulation,
			bandwidth: 12500,
			squelch: 0,
			gain: 2,
			deEmphasis: false,
			lowPass: 0,
			highPass: 0,
			audioFormat: "f32le",
		}),
		caps,
		input,
		squelch: { mode: "off" },
		handlers: {
			onAudio: chunk => chunks.push(Buffer.from(chunk)),
			onGate: () => undefined,
			onMetrics: () => undefined,
			onDown: () => undefined,
		},
	})
	if (!started.ok) {
		throw new Error(`rust engine did not open: ${JSON.stringify(started)}`)
	}
	const child = engine.childProcess
	const exited = new Promise<void>(resolve => {
		if (!child || child.exitCode !== null || child.signalCode !== null) {
			resolve()
			return
		}
		child.once("exit", () => resolve())
	})
	// The audio socket closes after the process has written its last sample. Waiting for the close
	// (not for a quiet spell) keeps a loaded host from truncating the audio.
	const audioSocket = (engine as unknown as { audio: Socket | null }).audio
	const audioClosed = new Promise<void>(resolve => {
		if (!audioSocket || audioSocket.destroyed) {
			resolve()
			return
		}
		audioSocket.once("close", () => resolve())
	})
	input.end(cu8)
	await exited
	// The per-test deadline reports a missing close as a failure. A raced sleep
	// silently accepted truncated audio and left a live timer behind on success.
	await audioClosed
	const audio = Buffer.concat(chunks)
	const n = Math.floor(audio.length / 4)
	const copy = Buffer.from(audio.subarray(0, n * 4))
	return new Float32Array(copy.buffer, copy.byteOffset, n)
}

function detect(audio: Float32Array): ReturnType<ToneDetector["result"]> {
	const bytes = Buffer.allocUnsafe(audio.length * 4)
	for (let i = 0; i < audio.length; i++)
		bytes.writeFloatLE(audio[i] ?? 0, i * 4)
	const detector = new ToneDetector()
	detector.push(bytes, { rate: AUDIO_RATE, format: "f32le" })
	return detector.result()
}

function synthCtcss(hz: number): Buffer {
	const synth = new FmChannelSynth({
		sampleRate: RATE,
		bandwidthHz: 12_500,
		seed: 1,
		cnrDb: null,
		deviationHz: 2500,
		offsetHz: 0,
		phase: 0,
		audio: "silence",
		ctcssHz: hz,
		ctcssDeviationHz: 300,
		blockMs: 50,
	})
	const cu8 = Buffer.allocUnsafe(SAMPLES * 2)
	let at = 0
	while (at < SAMPLES) {
		const block = synth.next()
		const n = Math.min(synth.blockSamples, SAMPLES - at)
		for (let s = 0; s < n; s++) {
			const dst = at + s
			cu8[dst * 2] = toCu8(block.readFloatLE(s * 8))
			cu8[dst * 2 + 1] = toCu8(block.readFloatLE(s * 8 + 4))
		}
		at += n
	}
	return cu8
}

/** DCS 023, normal polarity, linearly upsampled from the 8 kHz synth and FM'd. */
function synthDcs(): Buffer {
	const audio = dcsAudio({
		code: Number.parseInt("023", 8),
		seconds: SECONDS,
		seed: 7,
		amplitude: 0.5,
		rate: 8_000,
	})
	const cu8 = Buffer.allocUnsafe(SAMPLES * 2)
	const deviationHz = 2_000
	let phase = 0
	const dPhase = (2 * Math.PI) / RATE
	for (let n = 0; n < SAMPLES; n++) {
		const pos = n / 256
		const i0 = Math.floor(pos)
		const frac = pos - i0
		const a = audio[i0] ?? 0
		const b = audio[Math.min(audio.length - 1, i0 + 1)] ?? a
		phase += dPhase * deviationHz * (a + (b - a) * frac)
		if (phase > Math.PI) phase -= 2 * Math.PI
		else if (phase < -Math.PI) phase += 2 * Math.PI
		cu8[n * 2] = toCu8(Math.cos(phase))
		cu8[n * 2 + 1] = toCu8(Math.sin(phase))
	}
	return cu8
}

/** Carrier at DC, I = 0.6 * (1 + 0.5 cos), Q = 0. Peak 0.9 fits in cu8. */
function synthAm(): Buffer {
	const cu8 = Buffer.allocUnsafe(SAMPLES * 2)
	const w = (2 * Math.PI * 1_000) / RATE
	for (let n = 0; n < SAMPLES; n++) {
		const env = 0.6 * (1 + 0.5 * Math.cos(w * n))
		cu8[n * 2] = toCu8(env)
		cu8[n * 2 + 1] = toCu8(0)
	}
	return cu8
}

/** csdr `convert -i float -o char` with gain 1: floor(x * 127.5 + 128), saturated. */
function toCu8(x: number): number {
	const v = Math.floor(x * 127.5 + 128)
	if (v <= 0) return 0
	if (v >= 255) return 255
	return v
}

/**
 * Pure-JS reference: cu8 → float, shift (identity at 0 Hz), two Hamming
 * windowed-sinc decimators (÷8, ÷4) then a windowed-sinc resample 64 kHz →
 * 48 kHz, then the Rust NFM discriminator or the AM envelope, then the same
 * one-pole DC block (R = 0.998).
 */
function referenceDemod(cu8: Buffer, modulation: "nfm" | "am"): Float32Array {
	const iq = cu8ToIq(cu8)
	shiftToDc(iq.i, iq.q, 0, RATE)
	const s1 = decimateIq(iq.i, iq.q, 8, stage1Taps)
	const s2 = decimateIq(s1.i, s1.q, 4, stage2Taps)
	const at48 = resampleIq(s2.i, s2.q, 64_000, AUDIO_RATE, 31)
	if (modulation === "am") return dcBlock(envelope(at48.i, at48.q))
	return dcBlock(discriminate(at48.i, at48.q))
}

function cu8ToIq(cu8: Buffer): { i: Float32Array; q: Float32Array } {
	const n = cu8.length >> 1
	const i = new Float32Array(n)
	const q = new Float32Array(n)
	for (let k = 0; k < n; k++) {
		i[k] = (cu8[k * 2] ?? 0) / 127.5 - 1
		q[k] = (cu8[k * 2 + 1] ?? 0) / 127.5 - 1
	}
	return { i, q }
}

/** Mix by e^{-j 2π offset n / rate}. A zero offset is the phasor 1+0j. */
function shiftToDc(
	i: Float32Array,
	q: Float32Array,
	offsetHz: number,
	rate: number,
): void {
	if (offsetHz === 0) return
	const step = (-2 * Math.PI * offsetHz) / rate
	let re = 1
	let im = 0
	const c = Math.cos(step)
	const s = Math.sin(step)
	for (let n = 0; n < i.length; n++) {
		const x = i[n] ?? 0
		const y = q[n] ?? 0
		i[n] = x * re - y * im
		q[n] = x * im + y * re
		const nr = re * c - im * s
		im = re * s + im * c
		re = nr
	}
}

/** Hamming windowed-sinc low-pass. `cutoffCycles` is Hz / sample rate. DC gain 1. */
function designLowpass(taps: number, cutoffCycles: number): Float64Array {
	const h = new Float64Array(taps)
	const mid = (taps - 1) / 2
	let sum = 0
	for (let k = 0; k < taps; k++) {
		const x = k - mid
		const sinc =
			x === 0
				? 2 * cutoffCycles
				: Math.sin(2 * Math.PI * cutoffCycles * x) / (Math.PI * x)
		const w =
			taps > 1 ? 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (taps - 1)) : 1
		const v = sinc * w
		h[k] = v
		sum += v
	}
	if (sum !== 0) {
		for (let k = 0; k < taps; k++) h[k] = (h[k] ?? 0) / sum
	}
	return h
}

function decimateIq(
	i: Float32Array,
	q: Float32Array,
	factor: number,
	h: Float64Array,
): { i: Float32Array; q: Float32Array } {
	const taps = h.length
	const nOut = Math.floor((i.length - taps) / factor) + 1
	const oi = new Float32Array(Math.max(0, nOut))
	const oq = new Float32Array(Math.max(0, nOut))
	for (let n = 0; n < oi.length; n++) {
		const base = n * factor
		let accI = 0
		let accQ = 0
		for (let k = 0; k < taps; k++) {
			const c = h[k] ?? 0
			accI += c * (i[base + k] ?? 0)
			accQ += c * (q[base + k] ?? 0)
		}
		oi[n] = accI
		oq[n] = accQ
	}
	return { i: oi, q: oq }
}

function resampleIq(
	i: Float32Array,
	q: Float32Array,
	inRate: number,
	outRate: number,
	taps: number,
): { i: Float32Array; q: Float32Array } {
	const nOut = Math.round((i.length * outRate) / inRate)
	const oi = new Float32Array(nOut)
	const oq = new Float32Array(nOut)
	const ratio = inRate / outRate
	const fc = 0.5 * Math.min(1, outRate / inRate)
	const half = (taps - 1) >> 1
	const window = new Float64Array(taps)
	for (let k = 0; k < taps; k++) {
		window[k] =
			taps > 1 ? 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (taps - 1)) : 1
	}
	for (let n = 0; n < nOut; n++) {
		const pos = n * ratio
		const center = Math.floor(pos)
		const frac = pos - center
		let accI = 0
		let accQ = 0
		let norm = 0
		for (let k = -half; k <= half; k++) {
			const idx = center + k
			const t = k - frac
			const sinc = t === 0 ? 1 : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t)
			const c = sinc * (window[k + half] ?? 0)
			norm += c
			if (idx >= 0 && idx < i.length) {
				accI += c * (i[idx] ?? 0)
				accQ += c * (q[idx] ?? 0)
			}
		}
		const g = norm === 0 ? 0 : 1 / norm
		oi[n] = accI * g
		oq[n] = accQ * g
	}
	return { i: oi, q: oq }
}

/** Rust NFM: atan2(x[n] · conj(x[n−1])) scaled so deviation_hz is 0.8. */
function discriminate(i: Float32Array, q: Float32Array): Float32Array {
	const scale = (0.8 * AUDIO_RATE) / (2 * Math.PI * DEVIATION_HZ)
	const n = Math.min(i.length, q.length)
	const y = new Float32Array(n)
	let prevRe = 0
	let prevIm = 0
	for (let k = 0; k < n; k++) {
		const re = i[k] ?? 0
		const im = q[k] ?? 0
		const prodRe = re * prevRe + im * prevIm
		const prodIm = im * prevRe - re * prevIm
		y[k] = Math.atan2(prodIm, prodRe) * scale
		prevRe = re
		prevIm = im
	}
	return y
}

function envelope(i: Float32Array, q: Float32Array): Float32Array {
	const n = Math.min(i.length, q.length)
	const y = new Float32Array(n)
	for (let k = 0; k < n; k++) y[k] = Math.hypot(i[k] ?? 0, q[k] ?? 0)
	return y
}

/** csdr / Rust DC block: y[n] = x[n] − x[n−1] + 0.998 y[n−1]. */
function dcBlock(x: Float32Array): Float32Array {
	const y = new Float32Array(x.length)
	let x1 = 0
	let y1 = 0
	for (let n = 0; n < x.length; n++) {
		const s = x[n] ?? 0
		const o = s - x1 + 0.998 * y1
		x1 = Number.isFinite(s) ? s : 0
		y1 = Number.isFinite(o) ? o : 0
		y[n] = y1
	}
	return y
}

/**
 * Mean-centred Pearson correlation on the overlap. Best lag is the one with
 * the highest signed correlation. A pure tone also has an anti-phase lobe of
 * about −1 a half period away; maximising the signed value keeps the in-phase
 * lobe, so an inverted non-periodic waveform (DCS) still fails 0.98.
 */
function bestNormalizedCorrelation(
	rust: Float32Array,
	reference: Float32Array,
): { corr: number; lag: number } {
	const skip = Math.round(SKIP_S * AUDIO_RATE)
	const a = center(rust.subarray(Math.min(skip, rust.length)))
	const b = center(reference.subarray(Math.min(skip, reference.length)))
	if (a.length < AUDIO_RATE || b.length < AUDIO_RATE) {
		throw new Error(
			`audio too short for correlation: rust ${a.length}, reference ${b.length}`,
		)
	}
	const maxLag = Math.round(MAX_LAG_S * AUDIO_RATE)
	const coarse = 16
	let best = Number.NEGATIVE_INFINITY
	let bestLag = 0
	for (let lag = -maxLag; lag <= maxLag; lag += coarse) {
		const corr = pearson(a, b, lag, 2)
		if (corr > best) {
			best = corr
			bestLag = lag
		}
	}
	const lo = Math.max(-maxLag, bestLag - coarse)
	const hi = Math.min(maxLag, bestLag + coarse)
	for (let lag = lo; lag <= hi; lag++) {
		const corr = pearson(a, b, lag, 1)
		if (corr > best) {
			best = corr
			bestLag = lag
		}
	}
	return { corr: best, lag: bestLag }
}

function center(x: Float32Array): Float64Array {
	let mean = 0
	for (let i = 0; i < x.length; i++) mean += x[i] ?? 0
	mean = x.length === 0 ? 0 : mean / x.length
	const y = new Float64Array(x.length)
	for (let i = 0; i < x.length; i++) y[i] = (x[i] ?? 0) - mean
	return y
}

function pearson(
	a: Float64Array,
	b: Float64Array,
	lag: number,
	stride: number,
): number {
	const a0 = lag > 0 ? lag : 0
	const b0 = lag > 0 ? 0 : -lag
	const n = Math.min(a.length - a0, b.length - b0)
	if (n < 1_000) return 0
	let dot = 0
	let ea = 0
	let eb = 0
	for (let i = 0; i < n; i += stride) {
		const x = a[a0 + i] ?? 0
		const y = b[b0 + i] ?? 0
		dot += x * y
		ea += x * x
		eb += y * y
	}
	if (ea <= 0 || eb <= 0) return 0
	return dot / Math.sqrt(ea * eb)
}
