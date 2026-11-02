/**
 * Scanner quality benchmark: seeded synthetic wideband scenes with ground truth. Synthetic only,
 * no captured RF. Signals are generated in chunks (never the whole scene in memory), so a
 * 45 s scene at 2.4 Msps costs a few MB.
 *
 * SNR convention: carrier power over the noise power in max(12.5 kHz, the signal's nominal
 * occupied bandwidth), so a 125 kHz LoRa chirp at 10 dB is as visible on the waterfall as a
 * 12.5 kHz voice carrier at 10 dB.
 */
import type { ScannerProtocol } from "../../../src/core/scanner/types.js"

export type SignalClass =
	| "nfm-voice"
	| "nfm-ptt"
	| "dmr"
	| "pocsag"
	| "ism-ook"
	| "ism-fsk"
	| "afsk1200"
	| "lora"
	| "cw"
	| "gfsk-burst"
	| "carrier"
	| "birdie"
	| "dc"

export const SIGNAL_CLASSES: readonly SignalClass[] = [
	"nfm-voice",
	"nfm-ptt",
	"dmr",
	"pocsag",
	"ism-ook",
	"ism-fsk",
	"afsk1200",
	"lora",
	"cw",
	"gfsk-burst",
	"carrier",
	"birdie",
	"dc",
]

export interface Interval {
	startMs: number
	endMs: number
}

export interface SignalSpec {
	class: SignalClass
	/** Offset from the scene centre (Hz). */
	offsetHz: number
	snrDb: number
	intervals: readonly Interval[]
}

/** One signal's ground truth. */
export interface TruthSignal extends SignalSpec {
	id: string
	centreHz: number
	/** Nominal occupied bandwidth (Hz). */
	bandwidthHz: number
	/** What a working identify should name, or null (carriers, spurs). */
	expectedProtocol: ScannerProtocol | null
	/** True for what must not become a discovery (receiver birdie, DC spike). */
	spurious: boolean
}

export interface SceneSpec {
	name: string
	rateHz: number
	centreHz: number
	durationMs: number
	seed: number
	/** Complex noise standard deviation per I and Q component (full scale 1). */
	noiseSigma: number
	signals: readonly SignalSpec[]
}

export interface Scene extends SceneSpec {
	truth: readonly TruthSignal[]
}

const TWO_PI = 2 * Math.PI

const NOMINAL: Record<
	SignalClass,
	{
		bandwidthHz: number
		protocol: ScannerProtocol | null
		spurious: boolean
	}
> = {
	"nfm-voice": { bandwidthHz: 11_000, protocol: "analog-fm", spurious: false },
	"nfm-ptt": { bandwidthHz: 11_000, protocol: "analog-fm", spurious: false },
	dmr: { bandwidthHz: 9_000, protocol: "dmr", spurious: false },
	pocsag: { bandwidthHz: 11_000, protocol: "pocsag", spurious: false },
	"ism-ook": { bandwidthHz: 12_000, protocol: "ism", spurious: false },
	"ism-fsk": { bandwidthHz: 100_000, protocol: "ism", spurious: false },
	afsk1200: { bandwidthHz: 12_000, protocol: "aprs", spurious: false },
	lora: { bandwidthHz: 125_000, protocol: "lora", spurious: false },
	cw: { bandwidthHz: 200, protocol: null, spurious: false },
	"gfsk-burst": { bandwidthHz: 2_000, protocol: null, spurious: false },
	// A steady unmodulated carrier on air (a clock harmonic radiated by a nearby device): real RF,
	// fixed in frequency, no modulation. Not a receiver artefact, so not spurious; not voice.
	carrier: { bandwidthHz: 100, protocol: null, spurious: false },
	birdie: { bandwidthHz: 100, protocol: null, spurious: true },
	dc: { bandwidthHz: 2_000, protocol: null, spurious: true },
}

export function nominalOf(c: SignalClass): (typeof NOMINAL)[SignalClass] {
	return NOMINAL[c]
}

/** Small, fast, seedable PRNG in [0, 1) (same as tests/mocks/scanner/signals.ts). */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export function buildScene(spec: SceneSpec): Scene {
	const counts = new Map<string, number>()
	const truth = spec.signals.map((s): TruthSignal => {
		const n = NOMINAL[s.class]
		const key = `${s.class}@${s.snrDb}`
		const k = (counts.get(key) ?? 0) + 1
		counts.set(key, k)
		return {
			...s,
			id: `${s.class}-${s.snrDb}dB${k > 1 ? `-${k}` : ""}`,
			centreHz: spec.centreHz + s.offsetHz,
			bandwidthHz: n.bandwidthHz,
			expectedProtocol: n.protocol,
			spurious: n.spurious,
		}
	})
	return { ...spec, truth }
}

/** Complex amplitude for `snrDb` over the noise in max(12.5 kHz, bandwidth). */
export function amplitudeFor(
	snrDb: number,
	bandwidthHz: number,
	sigma: number,
	rateHz: number,
): number {
	const noiseInBand =
		(2 * sigma * sigma * Math.max(12_500, bandwidthHz)) / rateHz
	return Math.sqrt(noiseInBand * 10 ** (snrDb / 10))
}

const repeat = (
	firstMs: number,
	periodMs: number,
	lengthMs: number,
	untilMs: number,
): Interval[] => {
	const out: Interval[] = []
	for (let t = firstMs; t + lengthMs <= untilMs; t += periodMs)
		out.push({ startMs: t, endMs: t + lengthMs })
	return out
}

/** Three repeats of `lengthMs` with 15 ms gaps (an ISM sensor's usual triple send) every period. */
const sensor = (
	firstMs: number,
	periodMs: number,
	lengthMs: number,
	untilMs: number,
): Interval[] =>
	repeat(firstMs, periodMs, 3 * lengthMs + 30, untilMs).flatMap(iv =>
		[0, 1, 2].map(k => ({
			startMs: iv.startMs + k * (lengthMs + 15),
			endMs: iv.startMs + k * (lengthMs + 15) + lengthMs,
		})),
	)

const ALWAYS = (ms: number): Interval[] => [{ startMs: 0, endMs: ms }]

/**
 * Small scene (CI): 1.024 Msps for 12 s centred at 433.55 MHz (ISM 433 with its LPD433 25 kHz
 * channels inside the 70 cm amateur band), one of each common class at a comfortable level plus
 * a weak push-to-talk, a birdie and a DC spike. The OOK sensor sits at 433.92 MHz (+370 kHz),
 * near the usable edge (±409.6 kHz) of this rate.
 */
export function smallScene(seed = 20_261_101): Scene {
	const ms = 12_000
	return buildScene({
		name: "small",
		rateHz: 1_024_000,
		centreHz: 433_550_000,
		durationMs: ms,
		seed,
		noiseSigma: 0.03,
		signals: [
			{
				class: "nfm-voice",
				offsetHz: -250_000,
				snrDb: 20,
				intervals: [{ startMs: 1_000, endMs: 11_000 }],
			},
			{
				class: "nfm-ptt",
				offsetHz: -150_000,
				snrDb: 12,
				intervals: repeat(1_500, 4_500, 2_500, ms),
			},
			{
				class: "dmr",
				offsetHz: -325_000,
				snrDb: 20,
				intervals: [
					{ startMs: 1_500, endMs: 5_000 },
					{ startMs: 7_000, endMs: 10_500 },
				],
			},
			{
				class: "pocsag",
				offsetHz: -100_000,
				snrDb: 20,
				intervals: repeat(3_000, 5_000, 1_500, ms),
			},
			{
				class: "afsk1200",
				offsetHz: 100_000,
				snrDb: 15,
				intervals: repeat(2_000, 4_000, 900, ms),
			},
			{
				class: "ism-ook",
				offsetHz: 370_000,
				snrDb: 20,
				intervals: sensor(4_000, 5_000, 120, ms),
			},
			{
				class: "lora",
				offsetHz: 225_000,
				snrDb: 15,
				intervals: repeat(5_000, 4_000, 250, ms),
			},
			{
				class: "cw",
				offsetHz: -47_000,
				snrDb: 20,
				intervals: [{ startMs: 2_000, endMs: 10_000 }],
			},
			{
				class: "birdie",
				offsetHz: 37_400,
				snrDb: 8,
				intervals: ALWAYS(ms),
			},
			{ class: "dc", offsetHz: 0, snrDb: 25, intervals: ALWAYS(ms) },
		],
	})
}

/**
 * Full scene: 2.4 Msps for 45 s centred in 70 cm with the ISM 433 band above it. Every class at
 * 6, 10 and 20 dB (wideband ones at two levels), staggered on/off so classes do not start in
 * step. An OOK sensor sits at +820 kHz (433.92 MHz, near the usable edge ±960 kHz), LoRa at
 * +675 kHz.
 */
export function fullScene(seed = 20_261_102): Scene {
	const ms = 45_000
	const snrs = [6, 10, 20] as const
	const signals: SignalSpec[] = []
	// Narrow channels on the 12.5 kHz raster, 50 kHz apart, below the ISM band.
	let slot = -900_000
	const narrow = (): number => {
		const at = slot
		slot += 50_000
		return at
	}
	snrs.forEach((snr, i) => {
		const lag = i * 500
		signals.push(
			{
				class: "nfm-voice",
				offsetHz: narrow(),
				snrDb: snr,
				intervals: [{ startMs: 3_000 + lag, endMs: 40_000 + lag }],
			},
			{
				class: "nfm-ptt",
				offsetHz: narrow(),
				snrDb: snr,
				intervals: repeat(5_000 + lag, 12_000, 3_000, ms),
			},
			{
				class: "dmr",
				offsetHz: narrow(),
				snrDb: snr,
				intervals: repeat(4_000 + lag, 15_000, 4_000, ms),
			},
			{
				class: "pocsag",
				offsetHz: narrow(),
				snrDb: snr,
				intervals: repeat(6_000 + lag, 15_000, 1_500, ms),
			},
			{
				class: "afsk1200",
				offsetHz: narrow(),
				snrDb: snr,
				intervals: repeat(9_000 + lag, 15_000, 900, ms),
			},
			{
				class: "cw",
				offsetHz: narrow() + 3_000,
				snrDb: snr,
				intervals: [{ startMs: 11_000 + lag, endMs: 26_000 + lag }],
			},
		)
	})
	// ISM band (433.05 to 434.79 MHz): sensors, FSK and LoRa.
	const ism: [SignalClass, number, number, Interval[]][] = [
		["ism-ook", 820_000, 20, sensor(7_000, 15_000, 120, ms)],
		["ism-ook", 880_000, 10, sensor(7_700, 15_000, 120, ms)],
		["ism-ook", 525_000, 6, sensor(8_300, 15_000, 120, ms)],
		["ism-fsk", 400_000, 20, sensor(8_000, 15_000, 40, ms)],
		["ism-fsk", 125_000, 10, sensor(8_600, 15_000, 40, ms)],
		["lora", 675_000, 20, repeat(10_000, 15_000, 250, ms)],
		["lora", 275_000, 10, repeat(10_600, 15_000, 250, ms)],
	]
	for (const [c, offsetHz, snrDb, intervals] of ism)
		signals.push({ class: c, offsetHz, snrDb, intervals })
	signals.push(
		{ class: "birdie", offsetHz: -37_400, snrDb: 8, intervals: ALWAYS(ms) },
		{ class: "dc", offsetHz: 0, snrDb: 25, intervals: ALWAYS(ms) },
	)
	return buildScene({
		name: "full",
		rateHz: 2_400_000,
		centreHz: 433_100_000,
		durationMs: ms,
		seed,
		noiseSigma: 0.03,
		signals,
	})
}

/**
 * Noise only (false-discovery measurement): `durationMs` of receiver noise and nothing else at
 * 1.024 Msps (433.55 MHz, the small scene's centre) or 2.4 Msps (433.1 MHz, the full scene's).
 * Every discovery it makes is false.
 */
export function noiseScene(
	rateHz: 1_024_000 | 2_400_000,
	durationMs = 120_000,
	seed = 20_261_104,
): Scene {
	return buildScene({
		name: `noise-${rateHz / 1000}k`,
		rateHz,
		centreHz: rateHz === 1_024_000 ? 433_550_000 : 433_100_000,
		durationMs,
		seed,
		noiseSigma: 0.03,
		signals: [],
	})
}

/**
 * Spurs only (false-discovery measurement): the noise scene plus the receiver's own artefacts,
 * a DC spike (25 dB) and three birdies (8, 10 and 12 dB) at fixed offsets, all on for the
 * whole scene. Every discovery it makes is false.
 */
export function spursScene(
	rateHz: 1_024_000 | 2_400_000,
	durationMs = 120_000,
	seed = 20_261_105,
): Scene {
	const always = ALWAYS(durationMs)
	return buildScene({
		...noiseScene(rateHz, durationMs, seed),
		name: `spurs-${rateHz / 1000}k`,
		signals: [
			{ class: "dc", offsetHz: 0, snrDb: 25, intervals: always },
			{ class: "birdie", offsetHz: -37_400, snrDb: 8, intervals: always },
			{ class: "birdie", offsetHz: 128_000, snrDb: 10, intervals: always },
			{ class: "birdie", offsetHz: -256_100, snrDb: 12, intervals: always },
		],
	})
}

/**
 * One narrowband GFSK transmitter (measurement only, ground truth 1 discovery): 40 ms bursts
 * of about 2 kHz occupied bandwidth every 300 ms (±30 ms), each burst at 21 dB ± 3 dB (18 to
 * 24 dB) and ±2 kHz off its nominal carrier, 60 s at 1.024 Msps, +150 kHz from 869.525 MHz.
 */
export function gfskScene(seed = 20_261_106): Scene {
	const ms = 60_000
	const rng = mulberry32(seed ^ 0x5bd1e995)
	const intervals: Interval[] = []
	for (let t = 500; t + 40 <= ms; t += 300) {
		const startMs = Math.round(t + (rng() - 0.5) * 60)
		intervals.push({ startMs, endMs: startMs + 40 })
	}
	return buildScene({
		name: "gfsk",
		rateHz: 1_024_000,
		centreHz: 869_525_000,
		durationMs: ms,
		seed,
		noiseSigma: 0.03,
		signals: [{ class: "gfsk-burst", offsetHz: 150_000, snrDb: 21, intervals }],
	})
}

/**
 * A voice ID on a quiet band (synthetic): one 28 s NFM over with a CTCSS tone at 20 dB, 1 s to
 * 29 s of a 31 s scene at 1.024 Msps centred at 439 MHz (70 cm, no ISM allocation), +150 kHz
 * from centre. Measures onset-to-classification latency of a long analog over.
 */
export function voiceIdScene(seed = 20_261_109, snrDb = 20): Scene {
	return buildScene({
		name: "voice-id",
		rateHz: 1_024_000,
		centreHz: 439_000_000,
		durationMs: 31_000,
		seed,
		noiseSigma: 0.03,
		signals: [
			{
				class: "nfm-voice",
				offsetHz: 150_000,
				snrDb,
				intervals: [{ startMs: 1_000, endMs: 29_000 }],
			},
		],
	})
}

/**
 * Steady unmodulated carriers (clock harmonics) on a quiet band (synthetic): 20 s at 1.024 Msps
 * centred at 439 MHz, carriers at 20, 30 and 40 dB on all the time, a carrier at 20 dB 1 kHz off a
 * bin centre, and one NFM voice over at 20 dB (2 s to 18 s) for contrast. Ground truth: the
 * carriers show as `carrier`, never as FM voice; the voice shows as `analog-fm`.
 */
export function carriersScene(seed = 20_261_110): Scene {
	const ms = 20_000
	return buildScene({
		name: "carriers",
		rateHz: 1_024_000,
		centreHz: 439_000_000,
		durationMs: ms,
		seed,
		noiseSigma: 0.03,
		signals: [
			{
				class: "carrier",
				offsetHz: -300_000,
				snrDb: 20,
				intervals: ALWAYS(ms),
			},
			{
				class: "carrier",
				offsetHz: -175_000,
				snrDb: 30,
				intervals: ALWAYS(ms),
			},
			{ class: "carrier", offsetHz: 62_500, snrDb: 40, intervals: ALWAYS(ms) },
			{ class: "carrier", offsetHz: 250_500, snrDb: 20, intervals: ALWAYS(ms) },
			{
				class: "nfm-voice",
				offsetHz: -50_000,
				snrDb: 20,
				intervals: [{ startMs: 2_000, endMs: 18_000 }],
			},
		],
	})
}

// === streaming generator ===

/**
 * One signal's per-sample instantaneous frequency deviation (Hz from its carrier) and gate gain
 * over local indices [a, b) of a chunk whose first sample is absolute sample `from`. `gain`
 * already holds the on-interval edge ramp; the emitter multiplies its own keying into it.
 */
interface Emitter {
	truth: TruthSignal
	amp: number
	/** Carrier offset in phase-table units per sample. */
	step: number
	/** DC spike: a constant, not an oscillator. */
	dc: boolean
	fill(
		from: number,
		a: number,
		b: number,
		dev: Float64Array,
		gain: Float64Array,
	): void
	phase: number
}

const NOISE_TABLE_BITS = 16
/** 16 384-entry phase table: ≤ 2e-4 rad phase error, spurs near −74 dBc, far below the noise. */
const PHASE_BITS = 14
const PHASE_N = 1 << PHASE_BITS
const COS = new Float64Array(PHASE_N)
const SIN = new Float64Array(PHASE_N)
for (let k = 0; k < PHASE_N; k++) {
	COS[k] = Math.cos((TWO_PI * k) / PHASE_N)
	SIN[k] = Math.sin((TWO_PI * k) / PHASE_N)
}

/** Seeded CU8 scene source: chunk by chunk, identical bytes for the same scene and chunking. */
export class SceneGenerator {
	readonly totalSamples: number
	private readonly emitters: Emitter[]
	private readonly noise: Float32Array
	private noiseState: number
	/** Lead-in and tail noise draw from their own stream, never from the scene's. */
	private leadInState: number
	private position = 0

	constructor(readonly scene: Scene) {
		this.totalSamples = Math.round((scene.durationMs * scene.rateHz) / 1000)
		const rng = mulberry32(scene.seed)
		// A table of 65 536 unit normals indexed by a xorshift stream: Box–Muller once, not per sample.
		this.noise = new Float32Array(1 << NOISE_TABLE_BITS)
		for (let i = 0; i < this.noise.length; i += 2) {
			let u = rng()
			while (u <= 0) u = rng()
			const r = Math.sqrt(-2 * Math.log(u))
			const t = TWO_PI * rng()
			this.noise[i] = r * Math.cos(t)
			this.noise[i + 1] = r * Math.sin(t)
		}
		this.noiseState = (scene.seed ^ 0x9e3779b9) >>> 0 || 1
		this.leadInState = (scene.seed ^ 0x85ebca6b) >>> 0 || 1
		this.emitters = scene.truth.map((t, i) =>
			emitterFor(t, scene, mulberry32(scene.seed + 7919 * (i + 1))),
		)
	}

	get done(): boolean {
		return this.position >= this.totalSamples
	}

	/** The next chunk of at most `n` samples as CU8 bytes, or null at the end. */
	next(n: number): Buffer | null {
		const len = Math.min(n, this.totalSamples - this.position)
		if (len <= 0) return null
		const re = new Float64Array(len)
		const im = new Float64Array(len)
		const dev = new Float64Array(len)
		const gain = new Float64Array(len)
		const fs = this.scene.rateHz
		const from = this.position
		const ramp = fs / 1000
		const devToStep = PHASE_N / fs
		for (const e of this.emitters)
			for (const iv of e.truth.intervals) {
				const startAbs = (iv.startMs * fs) / 1000
				const endAbs = (iv.endMs * fs) / 1000
				const a = Math.max(0, Math.ceil(startAbs) - from)
				const b = Math.min(len, Math.floor(endAbs) - from)
				if (a >= b) continue
				gain.fill(1, a, b)
				dev.fill(0, a, b)
				// 1 ms raised-sine edges (no key clicks), computed only inside the ramps.
				const rampEnd = Math.min(b, Math.ceil(startAbs + ramp) - from)
				for (let i = a; i < rampEnd; i++)
					gain[i] =
						0.5 - 0.5 * Math.cos((Math.PI * (from + i - startAbs)) / ramp)
				const rampStart = Math.max(a, Math.floor(endAbs - ramp) - from)
				for (let i = rampStart; i < b; i++)
					gain[i] =
						gain[i]! *
						(0.5 -
							0.5 * Math.cos((Math.PI * Math.max(0, endAbs - from - i)) / ramp))
				e.fill(from, a, b, dev, gain)
				if (e.dc) {
					for (let i = a; i < b; i++) {
						re[i] = re[i]! + e.amp * 0.8
						im[i] = im[i]! + e.amp * 0.6
					}
					continue
				}
				let ph = e.phase
				const amp = e.amp
				for (let i = a; i < b; i++) {
					ph += e.step + dev[i]! * devToStep
					if (ph >= PHASE_N) ph -= PHASE_N
					else if (ph < 0) ph += PHASE_N
					const k = ph | 0
					const g = amp * gain[i]!
					re[i] = re[i]! + g * COS[k]!
					im[i] = im[i]! + g * SIN[k]!
				}
				e.phase = ph
			}
		const out = Buffer.allocUnsafe(2 * len)
		const sigma = this.scene.noiseSigma
		const mask = (1 << NOISE_TABLE_BITS) - 1
		let x = this.noiseState
		for (let i = 0; i < len; i++) {
			x ^= x << 13
			x ^= x >>> 17
			x ^= x << 5
			x >>>= 0
			const nr = this.noise[x & mask]!
			const ni = this.noise[(x >>> NOISE_TABLE_BITS) & mask]!
			out[2 * i] = cu8(re[i]! + sigma * nr)
			out[2 * i + 1] = cu8(im[i]! + sigma * ni)
		}
		this.noiseState = x
		this.position += len
		return out
	}

	/**
	 * Noise-only chunk (lead-in before scene time 0, tail after the end). Its own xorshift stream:
	 * however much lead-in a run feeds, the scene's bytes stay the same.
	 */
	noiseOnly(n: number): Buffer {
		const out = Buffer.allocUnsafe(2 * n)
		const sigma = this.scene.noiseSigma
		const mask = (1 << NOISE_TABLE_BITS) - 1
		let x = this.leadInState
		for (let i = 0; i < n; i++) {
			x ^= x << 13
			x ^= x >>> 17
			x ^= x << 5
			x >>>= 0
			out[2 * i] = cu8(sigma * this.noise[x & mask]!)
			out[2 * i + 1] = cu8(sigma * this.noise[(x >>> NOISE_TABLE_BITS) & mask]!)
		}
		this.leadInState = x
		return out
	}
}

function cu8(v: number): number {
	const q = v * 127.5 + 128
	return q < 0 ? 0 : q >= 255 ? 255 : q | 0
}

/**
 * Random symbols at `rate` per second from `levels`, held for each symbol: writes the level of
 * every sample in [a, b) into `out`, one fill per symbol (no per-sample division).
 */
function symbolStream(
	rng: () => number,
	fs: number,
	rate: number,
	levels: readonly number[],
): (from: number, a: number, b: number, out: Float64Array) => void {
	let symbol = -1
	let level = 0
	return (from, a, b, out) => {
		let i = a
		while (i < b) {
			const k = Math.floor(((from + i) * rate) / fs)
			if (k !== symbol) {
				symbol = k
				level = levels[Math.floor(rng() * levels.length)]!
			}
			const next = Math.min(
				b,
				Math.max(i + 1, Math.ceil(((k + 1) * fs) / rate) - from),
			)
			out.fill(level, i, next)
			i = next
		}
	}
}

function emitterFor(t: TruthSignal, scene: Scene, rng: () => number): Emitter {
	const fs = scene.rateHz
	const amp = amplitudeFor(t.snrDb, t.bandwidthHz, scene.noiseSigma, fs)
	const base = {
		truth: t,
		amp,
		step: (t.offsetHz * PHASE_N) / fs,
		dc: false,
		phase: Math.floor(rng() * PHASE_N),
	}
	switch (t.class) {
		case "nfm-voice":
		case "nfm-ptt": {
			// Voice stand-in: 8 tones in 300 to 3000 Hz with a 4 Hz syllabic envelope, 1.5 kHz RMS
			// deviation, plus a 300 Hz deviation CTCSS at 88.5 Hz. Audio is computed every 16 samples.
			const tones = Array.from({ length: 8 }, () => ({
				w: TWO_PI * (300 + rng() * 2_700),
				p: rng() * TWO_PI,
			}))
			const toneAmp = 1500 * Math.sqrt(2 / tones.length) * 1.4
			// Audio at about 16 kHz (fs / step), linearly interpolated to fs.
			const step = Math.max(1, Math.floor(fs / 16_000))
			const audioAt = (k: number): number => {
				const sec = (k * step) / fs
				const env = 0.55 + 0.45 * Math.sin(TWO_PI * 4 * sec)
				let v = 0
				for (let j = 0; j < tones.length; j++) {
					const tn = tones[j]!
					v += Math.sin(tn.w * sec + tn.p)
				}
				return env * toneAmp * v + 300 * Math.sin(TWO_PI * 88.5 * sec)
			}
			let k0 = -1
			let y0 = 0
			let y1 = 0
			return {
				...base,
				fill: (from, a, b, dev) => {
					for (let i = a; i < b; i++) {
						const abs = from + i
						const k = Math.floor(abs / step)
						if (k !== k0) {
							y0 = k === k0 + 1 ? y1 : audioAt(k)
							y1 = audioAt(k + 1)
							k0 = k
						}
						dev[i] = y0 + (y1 - y0) * ((abs - k * step) / step)
					}
				},
			}
		}
		case "dmr": {
			// 4FSK at 4800 symbols/s on ±648 / ±1944 Hz, one-pole shaped, TDMA 27.5 ms per 60 ms.
			const alpha = 1 - Math.exp((-TWO_PI * 2_400) / fs)
			// Integer sample counts: a float `%` per sample costs more than the whole synthesis.
			const period = Math.round(0.06 * fs)
			const on = Math.round(0.0275 * fs)
			const edge = Math.max(1, Math.round(0.00025 * fs))
			let shaped = 0
			const symbols = symbolStream(rng, fs, 4800, [-1944, -648, 648, 1944])
			return {
				...base,
				fill: (from, a, b, dev, gain) => {
					symbols(from, a, b, dev)
					for (let i = a; i < b; i++) {
						shaped += alpha * (dev[i]! - shaped)
						dev[i] = shaped
						const u = (from + i) % period
						if (u >= on) gain[i] = 0
						else if (u < edge) gain[i] = (gain[i]! * u) / edge
						else if (u > on - edge) gain[i] = (gain[i]! * (on - u)) / edge
					}
				},
			}
		}
		case "pocsag": {
			const symbols = symbolStream(rng, fs, 1200, [-4500, 4500])
			return { ...base, fill: (from, a, b, dev) => symbols(from, a, b, dev) }
		}
		case "ism-ook": {
			// PWM-ish OOK: 4 kbit/s random keying (the keying is staged in `dev`, then cleared).
			const symbols = symbolStream(rng, fs, 4000, [0, 1])
			return {
				...base,
				fill: (from, a, b, dev, gain) => {
					symbols(from, a, b, dev)
					for (let i = a; i < b; i++) {
						gain[i] = gain[i]! * dev[i]!
						dev[i] = 0
					}
				},
			}
		}
		case "ism-fsk": {
			const symbols = symbolStream(rng, fs, 20_000, [-30_000, 30_000])
			return { ...base, fill: (from, a, b, dev) => symbols(from, a, b, dev) }
		}
		case "afsk1200": {
			// Bell 202 on NFM: 1200 / 2200 Hz audio, phase continuous, 3 kHz deviation.
			const symbols = symbolStream(rng, fs, 1200, [1200, 2200])
			let audioPhase = 0
			const toStep = PHASE_N / fs
			return {
				...base,
				fill: (from, a, b, dev) => {
					symbols(from, a, b, dev)
					for (let i = a; i < b; i++) {
						audioPhase += dev[i]! * toStep
						if (audioPhase >= PHASE_N) audioPhase -= PHASE_N
						dev[i] = 3000 * SIN[audioPhase | 0]!
					}
				},
			}
		}
		case "lora": {
			// SF9 / 125 kHz: 4.096 ms symbols. 8 preamble upchirps, then random-shift data chirps.
			const bw = 125_000
			const chips = 512
			const symbolSamples = (chips / bw) * fs
			let lastSymbol = -1
			let shift = 0
			return {
				...base,
				fill: (from, a, b, dev) => {
					const iv = t.intervals.find(
						x =>
							((from + a) * 1000) / fs >= x.startMs - 1 &&
							((from + a) * 1000) / fs < x.endMs,
					)
					const startAbs = iv ? (iv.startMs * fs) / 1000 : from + a
					for (let i = a; i < b; i++) {
						const pos = (from + i - startAbs) / symbolSamples
						const s = Math.floor(pos)
						if (s !== lastSymbol) {
							lastSymbol = s
							shift = s < 8 ? 0 : Math.floor(rng() * chips) / chips
						}
						dev[i] = -bw / 2 + ((pos - s + shift) % 1) * bw
					}
				},
			}
		}
		case "cw": {
			// Morse-like keying at 20 wpm: 60 ms elements, random dit/dah/gaps.
			const unit = 0.06 * fs
			let element = -1
			let on = 0
			let left = 0
			return {
				...base,
				fill: (from, a, b, _dev, gain) => {
					for (let i = a; i < b; i++) {
						const e = Math.floor((from + i) / unit)
						if (e !== element) {
							element = e
							if (left > 0) left--
							else {
								const r = rng()
								on = on === 1 ? 0 : 1
								left = on === 1 ? (r < 0.5 ? 0 : 2) : r < 0.6 ? 0 : 2
							}
						}
						gain[i] = gain[i]! * on
					}
				},
			}
		}
		case "gfsk-burst": {
			// 1 200 baud, ±600 Hz deviation, one-pole shaped (about 2 kHz occupied). Each burst draws
			// its own carrier offset (±2 kHz) and level (±3 dB) from its start time, so the same
			// scene gives the same bursts however it is chunked.
			const alpha = 1 - Math.exp((-TWO_PI * 900) / fs)
			const symbols = symbolStream(rng, fs, 1_200, [-600, 600])
			let shaped = 0
			return {
				...base,
				fill: (from, a, b, dev, gain) => {
					const at = ((from + a) * 1000) / fs
					const iv = t.intervals.find(x => at >= x.startMs - 1 && at < x.endMs)
					const r = mulberry32(scene.seed + (iv?.startMs ?? 0))
					const jitterHz = (r() * 2 - 1) * 2_000
					const level = 10 ** (((r() * 2 - 1) * 3) / 20)
					symbols(from, a, b, dev)
					for (let i = a; i < b; i++) {
						shaped += alpha * (dev[i]! - shaped)
						dev[i] = shaped + jitterHz
						gain[i] = gain[i]! * level
					}
				},
			}
		}
		case "carrier":
		case "birdie":
			return { ...base, fill: () => undefined }
		case "dc":
			return { ...base, dc: true, fill: () => undefined }
	}
}

// === retuned scenes (the tuner moves; receiver spurs move with it, real RF does not) ===

/** One stretch at one tuned centre, from `fromMs` of the run (its own scene, offsets from that centre). */
export interface RetunedSegment {
	fromMs: number
	centreHz: number
	scene: Scene
}

/** Ground truth of a retuned run: absolute frequencies (a receiver spur has one per centre). */
export interface RetunedTruth {
	id: string
	class: SignalClass
	snrDb: number
	bandwidthHz: number
	/** RF frequencies it shows at (Hz). */
	rfHz: readonly number[]
	/** A receiver artefact: every discovery of it is false. */
	spurious: boolean
}

export interface RetunedScene {
	name: string
	rateHz: number
	durationMs: number
	segments: readonly RetunedSegment[]
	truth: readonly RetunedTruth[]
}

/**
 * LO-locked spur across centres (synthetic): 1.024 Msps, tuned at C1, C1 + 200 kHz and C1 again for
 * 7 s each, then at C1 + 200 kHz until 40 s (3 retunes: a lock needs the line to follow the LO
 * through 3). The dwells are short enough that the third retune (21 s) and its 3 s minimum dwell
 * come before the engine's provisional spur path (a narrow line on in 95 % of 30 s of settled
 * blocks, at one baseband bin across retunes) drops the line before tracking: past that, no
 * sighting reaches the LO-lock rule. A receiver spur at -150 kHz from the tuned centre (20 dB, on
 * all the time) moves with the tuner: C1 - 150 kHz, then C1 + 50 kHz, and back. Each position lies
 * inside the other centre's usable window (±409.6 kHz: C1 - 150 kHz is 350 kHz below
 * C1 + 200 kHz), so each centre sees the other's position empty, which the LO-lock rule needs. Two
 * real emitters stay put: a steady unmodulated carrier at C1 + 150 kHz (20 dB) and an NFM voice
 * carrier with CTCSS at C1 - 100 kHz (20 dB, on from 1 s to 30 s). Ground truth: 2 discoveries, the
 * spur none at the end (its records from the first dwells are retired at the lock).
 */
export function loSpurScene(seed = 20_261_108): RetunedScene {
	const rateHz = 1_024_000
	const c1 = 433_400_000
	const c2 = c1 + 200_000
	const spurOffset = -150_000
	const carrierHz = c1 + 150_000
	const voiceHz = c1 - 100_000
	const plan = [
		{ fromMs: 0, toMs: 7_000, centreHz: c1 },
		{ fromMs: 7_000, toMs: 14_000, centreHz: c2 },
		{ fromMs: 14_000, toMs: 21_000, centreHz: c1 },
		{ fromMs: 21_000, toMs: 40_000, centreHz: c2 },
	]
	const voiceOn = { startMs: 1_000, endMs: 30_000 }
	const segments = plan.map((p, i): RetunedSegment => {
		const ms = p.toMs - p.fromMs
		const local = (iv: Interval): Interval[] => {
			const a = Math.max(iv.startMs, p.fromMs) - p.fromMs
			const b = Math.min(iv.endMs, p.toMs) - p.fromMs
			return a < b ? [{ startMs: a, endMs: b }] : []
		}
		return {
			fromMs: p.fromMs,
			centreHz: p.centreHz,
			scene: buildScene({
				name: `lo-spur-${i + 1}`,
				rateHz,
				centreHz: p.centreHz,
				durationMs: ms,
				seed: seed + i,
				noiseSigma: 0.03,
				signals: [
					{
						class: "birdie",
						offsetHz: spurOffset,
						snrDb: 20,
						intervals: ALWAYS(ms),
					},
					{
						class: "carrier",
						offsetHz: carrierHz - p.centreHz,
						snrDb: 20,
						intervals: ALWAYS(ms),
					},
					{
						class: "nfm-voice",
						offsetHz: voiceHz - p.centreHz,
						snrDb: 20,
						intervals: local(voiceOn),
					},
				],
			}),
		}
	})
	return {
		name: "lo-spur",
		rateHz,
		durationMs: plan.at(-1)!.toMs,
		segments,
		truth: [
			{
				id: "lo-spur-20dB",
				class: "birdie",
				snrDb: 20,
				bandwidthHz: 100,
				rfHz: [c1 + spurOffset, c2 + spurOffset],
				spurious: true,
			},
			{
				id: "carrier-20dB",
				class: "carrier",
				snrDb: 20,
				bandwidthHz: 100,
				rfHz: [carrierHz],
				spurious: false,
			},
			{
				id: "nfm-voice-20dB",
				class: "nfm-voice",
				snrDb: 20,
				bandwidthHz: 11_000,
				rfHz: [voiceHz],
				spurious: false,
			},
		],
	}
}

/** Plays a retuned scene segment by segment and says which centre each moment is tuned to. */
export class RetunedSource {
	readonly rateHz: number
	readonly centreHz: number
	private readonly gens: SceneGenerator[]
	private index = 0

	constructor(readonly scene: RetunedScene) {
		this.rateHz = scene.rateHz
		this.centreHz = scene.segments[0]!.centreHz
		this.gens = scene.segments.map(s => new SceneGenerator(s.scene))
	}

	centreAt(ms: number): number {
		let c = this.scene.segments[0]!.centreHz
		for (const s of this.scene.segments) if (ms >= s.fromMs) c = s.centreHz
		return c
	}

	next(n: number): Buffer | null {
		while (this.index < this.gens.length) {
			const b = this.gens[this.index]!.next(n)
			if (b) return b
			this.index++
		}
		return null
	}

	leadIn(n: number): Buffer {
		return this.gens[0]!.noiseOnly(n)
	}
}
