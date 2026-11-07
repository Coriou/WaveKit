import { priorsFor } from "../../../../../src/core/scanner/bandplan/index.js"
import { classifySpectral } from "../../../../../src/core/scanner/classify/classifier.js"
import type {
	ScannerClass,
	ScanRange,
} from "../../../../../src/core/scanner/types.js"
import type {
	EngineState,
	TrackSnapshot,
} from "../../../../../src/core/spectrum/types.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	type Iq,
	type Rng,
} from "../../../../mocks/scanner/signals.js"
import {
	BIN_HZ,
	CENTRE,
	FS,
	Harness,
	N,
} from "../../spectrum/pipeline-harness.js"

/**
 * Synthetic emissions for the spectral class confusion matrix, run through the real pipeline
 * (`SpectrumPipeline` at 1 kHz bins and 50 ms blocks, a 12.5 kHz channel plan, as a 2 m band job).
 * No sample here comes from a real capture.
 */

const TWO_PI = 2 * Math.PI
const SIGMA = 0.02
/** On the 12.5 kHz raster from the tuned centre. */
export const OFFSET_HZ = 50_000
const NOISE_BW_HZ = 12_500

/** Complex amplitude for `snrDb` of channel SNR over a 12.5 kHz noise bandwidth. */
const ampFor = (snrDb: number): number =>
	Math.sqrt((SIGMA * SIGMA * NOISE_BW_HZ * 10 ** (snrDb / 10)) / FS)

function fm(
	freq: Float64Array,
	amp: number,
	gate?: Float32Array,
	startPhase = 0,
): Iq {
	const n = freq.length
	const re = new Float32Array(n)
	const im = new Float32Array(n)
	let phase = startPhase
	for (let i = 0; i < n; i++) {
		const a = gate === undefined ? amp : amp * gate[i]!
		re[i] = a * Math.cos(phase)
		im[i] = a * Math.sin(phase)
		phase += (TWO_PI * freq[i]!) / FS
		if (phase > Math.PI) phase -= TWO_PI
		else if (phase < -Math.PI) phase += TWO_PI
	}
	return { re, im }
}

export interface SpeechOptions {
	/** The transmitter's limiter: deviation never passes this. */
	peakDeviationHz?: number
	/** RMS deviation over the voiced parts, as a fraction of the peak: how hard the talker drives it. */
	drive?: number
	ctcssHz?: number
	/** First syllable starts this far in (ms): the visit opens on a bare carrier. */
	leadMs?: number
}

/**
 * Speech-like FM: pitch harmonics (120 to 180 Hz, wandering) under two formants per syllable,
 * pre-emphasised, cut at 3 kHz, with a syllabic envelope (120 to 400 ms syllables, 30 to 200 ms
 * gaps, a 300 to 700 ms phrase gap every 4 to 8 syllables): a bare carrier between syllables.
 * Scaled to `drive` × `peakDeviationHz` RMS over the voiced parts and hard-limited at
 * `peakDeviationHz`, as a radio's mic limiter does.
 */
export function speechFm(
	rng: Rng,
	n: number,
	amp: number,
	opts: SpeechOptions = {},
): Iq {
	const peak = opts.peakDeviationHz ?? 5000
	const drive = opts.drive ?? 0.4
	const audioRate = 16_000
	const step = FS / audioRate
	const len = Math.ceil(n / step) + 2
	const audio = new Float64Array(len)
	let at = Math.round(((opts.leadMs ?? 0) * audioRate) / 1000)
	let phrase = 4 + Math.floor(rng() * 5)
	let f0 = 120 + rng() * 60
	let voicedEnergy = 0
	let voiced = 0
	while (at < len) {
		const syllable = Math.round(((120 + rng() * 280) * audioRate) / 1000)
		const f1 = 300 + rng() * 500
		const f2 = 900 + rng() * 1300
		const level = 0.45 + rng() * 0.55
		const harmonics = Math.floor(3000 / f0)
		const gains = new Float64Array(harmonics + 1)
		for (let k = 1; k <= harmonics; k++) {
			const hz = k * f0
			const formants =
				Math.exp(-(((hz - f1) / 220) ** 2)) +
				0.6 * Math.exp(-(((hz - f2) / 320) ** 2)) +
				0.05
			gains[k] = (formants * Math.min(hz, 1000)) / 1000
		}
		let pitchPhase = rng() * TWO_PI
		const drift = (rng() - 0.5) * 30
		for (let i = 0; i < syllable && at + i < len; i++) {
			const u = i / syllable
			const env = level * Math.sin(Math.PI * u) ** 0.5
			pitchPhase += (TWO_PI * (f0 + drift * u)) / audioRate
			let v = 0
			for (let k = 1; k <= harmonics; k++)
				v += gains[k]! * Math.sin(k * pitchPhase)
			v *= env
			audio[at + i] = v
			voicedEnergy += v * v
			voiced++
		}
		f0 = Math.min(180, Math.max(120, f0 + (rng() - 0.5) * 20))
		at += syllable
		phrase--
		const gapMs = phrase <= 0 ? 300 + rng() * 400 : 30 + rng() * 170
		if (phrase <= 0) phrase = 4 + Math.floor(rng() * 5)
		at += Math.round((gapMs * audioRate) / 1000)
	}
	const rms = voiced > 0 ? Math.sqrt(voicedEnergy / voiced) : 0
	const scale = rms > 0 ? (drive * peak) / rms : 0
	const freq = new Float64Array(n)
	const ctcss = opts.ctcssHz
	for (let i = 0; i < n; i++) {
		const a = Math.floor(i / step)
		const frac = i / step - a
		let v = scale * (audio[a]! * (1 - frac) + audio[a + 1]! * frac)
		v = Math.max(-peak, Math.min(peak, v))
		if (ctcss !== undefined) v += 300 * Math.sin((TWO_PI * ctcss * i) / FS)
		freq[i] = OFFSET_HZ + v
	}
	return fm(freq, amp)
}

/**
 * Random symbols on `levels`, Gaussian frequency pulse of bandwidth-time `bt`, built at 16 samples
 * per symbol and interpolated: FM, as C4FM, GMSK and 2FSK are.
 */
function shapedTrack(
	rng: Rng,
	n: number,
	levels: readonly number[],
	baud: number,
	bt: number,
): Float64Array {
	const sps = 16
	const rate = baud * sps
	const len = Math.ceil((n * rate) / FS) + 2
	const raw = new Float64Array(len)
	const symbols = Math.ceil(len / sps) + 1
	for (let s = 0; s < symbols; s++) {
		const level = levels[Math.floor(rng() * levels.length)]!
		for (let k = s * sps; k < Math.min(len, (s + 1) * sps); k++) raw[k] = level
	}
	const sigma = (Math.sqrt(Math.LN2) / (TWO_PI * bt)) * sps
	const half = Math.ceil(3 * sigma)
	const taps = new Float64Array(2 * half + 1)
	let sum = 0
	for (let k = -half; k <= half; k++) {
		taps[k + half] = Math.exp(-(k * k) / (2 * sigma * sigma))
		sum += taps[k + half]!
	}
	const shaped = new Float64Array(len)
	for (let i = 0; i < len; i++) {
		let v = 0
		for (let k = -half; k <= half; k++)
			v += taps[k + half]! * raw[Math.min(len - 1, Math.max(0, i + k))]!
		shaped[i] = v / sum
	}
	const out = new Float64Array(n)
	for (let i = 0; i < n; i++) {
		const x = (i * rate) / FS
		const a = Math.floor(x)
		const frac = x - a
		out[i] = OFFSET_HZ + shaped[a]! * (1 - frac) + shaped[a + 1]! * frac
	}
	return out
}

/** On `onMs` of every `periodMs`: a TDMA slot. */
function slotGate(n: number, onMs: number, periodMs: number): Float32Array {
	const g = new Float32Array(n)
	const period = (periodMs * FS) / 1000
	const on = (onMs * FS) / 1000
	for (let i = 0; i < n; i++) g[i] = i % period < on ? 1 : 0
	return g
}

function fsk(
	levels: readonly number[],
	baud: number,
	bt: number,
): (rng: Rng, n: number, amp: number) => Iq {
	return (rng, n, amp) => fm(shapedTrack(rng, n, levels, baud, bt), amp)
}

const DMR_LEVELS = [-1944, -648, 648, 1944]

/**
 * `onMs` of data then `offMs` of bare centre carrier at the same amplitude, over and over: a mode's
 * spectrum keyed between two states, not a stationary one and not speech. FM's amplitude holds.
 */
export function keyedData(
	levels: readonly number[],
	baud: number,
	bt: number,
	onMs = 100,
	offMs = 100,
): (rng: Rng, n: number, amp: number) => Iq {
	return (rng, n, amp) => {
		const freq = shapedTrack(rng, n, levels, baud, bt)
		const on = (onMs * FS) / 1000
		const period = ((onMs + offMs) * FS) / 1000
		for (let i = 0; i < n; i++) if (i % period >= on) freq[i] = OFFSET_HZ
		return fm(freq, amp)
	}
}

/** AFSK packets (1200 Bd, 1200/2200 Hz audio, ±3 kHz) with `gapMs` of bare carrier between them. */
function afskFm(rng: Rng, n: number, amp: number, gapMs: number): Iq {
	const freq = new Float64Array(n)
	const sps = FS / 1200
	const gap = (gapMs * FS) / 1000
	const packet = 0.6 * FS
	let phase = 0
	let tone = 1200
	for (let i = 0; i < n; i++) {
		const inGap = gapMs > 0 && i % (packet + gap) >= packet
		if (i % Math.round(sps) === 0 && rng() < 0.5)
			tone = tone === 1200 ? 2200 : 1200
		phase += (TWO_PI * tone) / FS
		freq[i] = OFFSET_HZ + (inGap ? 0 : 3000 * Math.sin(phase))
	}
	return fm(freq, amp)
}

export interface SignalDef {
	readonly name: string
	readonly gen: (rng: Rng, n: number, amp: number) => Iq
}

const bare = (offsetHz: number, driftHzPerS: number): SignalDef["gen"] => {
	return (_rng, n, amp) => {
		const freq = new Float64Array(n)
		for (let i = 0; i < n; i++)
			freq[i] = OFFSET_HZ + offsetHz + (driftHzPerS * i) / FS
		return fm(freq, amp)
	}
}

/**
 * The matrix's signals. Voice varies in loudness because a quiet talker is what reads narrow; the
 * digital modes use their published deviations and symbol rates.
 */
export const SIGNALS: readonly SignalDef[] = [
	{
		name: "voice",
		gen: (rng, n, amp) => speechFm(rng, n, amp),
	},
	{
		name: "voice-narrow",
		gen: (rng, n, amp) => speechFm(rng, n, amp, { peakDeviationHz: 2500 }),
	},
	{
		name: "voice-quiet",
		gen: (rng, n, amp) =>
			speechFm(rng, n, amp, { peakDeviationHz: 2500, drive: 0.2 }),
	},
	{
		name: "voice-ctcss",
		gen: (rng, n, amp) => speechFm(rng, n, amp, { ctcssHz: 88.5 }),
	},
	{
		name: "dmr-slot",
		gen: (rng, n, amp) =>
			fm(shapedTrack(rng, n, DMR_LEVELS, 4800, 3), amp, slotGate(n, 27.5, 60)),
	},
	{ name: "dmr-repeater", gen: fsk(DMR_LEVELS, 4800, 3) },
	{ name: "dpmr", gen: fsk([-1050, -350, 350, 1050], 2400, 3) },
	{ name: "nxdn48", gen: fsk([-800, -267, 267, 800], 2400, 3) },
	{ name: "nxdn96", gen: fsk([-1600, -533, 533, 1600], 4800, 3) },
	{ name: "dstar", gen: fsk([-1200, 1200], 4800, 0.5) },
	{ name: "ysf", gen: fsk([-2700, -900, 900, 2700], 4800, 3) },
	{ name: "p25", gen: fsk([-1800, -600, 600, 1800], 4800, 3) },
	{ name: "pocsag", gen: fsk([-4500, 4500], 1200, 3) },
	{ name: "gmsk-9600", gen: fsk([-2400, 2400], 9600, 0.3) },
	{
		name: "aprs-burst",
		gen: (rng, n, amp) => afskFm(rng, n, amp, 400),
	},
	{ name: "carrier-on-bin", gen: bare(0, 0) },
	{ name: "carrier-off-bin", gen: bare(400, 0) },
	{ name: "carrier-drift", gen: bare(0, 60) },
	{ name: "carrier-fast-drift", gen: bare(0, 500) },
]

export const MATRIX_SNRS_DB = [8, 12, 16, 20, 30] as const

/** The 2 m band's channel plan and rasters (12.5 kHz), over the harness's tuned window. */
function start(h: Harness): void {
	const half = (N / 2) * BIN_HZ
	h.start({
		rasters: [{ spacingHz: 12_500, firstChannelHz: CENTRE }],
		inWindow: false,
	})
	h.send({
		kind: "channel-plan",
		plan: {
			sourceId: "s1",
			defaultWidthHz: 12_500,
			entries: [
				{
					startHz: CENTRE - half,
					endHz: CENTRE + half,
					widthHz: 11_000,
					rasterHz: 12_500,
					firstChannelHz: CENTRE,
					burst: false,
					rangeKey: "r",
				},
			],
		},
	})
}

/** A learned baseband spur line: [first bin, width in bins]. */
export type SeededLine = readonly [number, number]

/** A persisted engine state holding `lines`, as the pipeline loads a learned spur map. */
function engineWith(lines: readonly SeededLine[]): EngineState {
	return {
		version: 1,
		absoluteFloors: [],
		kByRange: [],
		spurs: lines.map(([basebandBin, widthBins]) => ({
			key: `${FS}:m:496:${N}`,
			basebandBin,
			widthBins,
			kind: "baseband" as const,
		})),
	}
}

/** One visit: the signal (absent for `null`: noise only) for `seconds`; its snapshots, in order. */
export function runVisit(
	sig: SignalDef | null,
	snrDb: number,
	seed: number,
	seconds: number,
	integrationMs = 50,
	lines: readonly SeededLine[] = [],
): TrackSnapshot[] {
	const rng = mulberry32(seed)
	const h = new Harness({
		format: "FLOAT32LE",
		integrationMs,
		...(lines.length > 0 ? { persistedEngine: engineWith(lines) } : {}),
	})
	start(h)
	const n = Math.round(seconds * FS)
	const iq = gaussianNoise(rng, n, SIGMA)
	if (sig !== null) addInto(iq, sig.gen(rng, n, ampFor(snrDb)))
	h.push(iq, 8192)
	const target = CENTRE + OFFSET_HZ
	return sig === null
		? h.tracks()
		: h.tracks().filter(t => Math.abs(t.centreHz - target) <= 6250)
}

/** An emission of a scene: its generator, Hz from `OFFSET_HZ`, dB against the scene's SNR. */
export type SceneEmission = readonly [
	gen: (rng: Rng, n: number, amp: number) => Iq,
	offsetHz: number,
	levelDb: number,
]

type Emitter = SceneEmission[0]

/** Key-up and key-down of a time-gated emitter, so an edge does not splatter over the band. */
const GATE_RAMP_S = 0.005

/** `gen`, on air only from `fromS` to `toS` (seconds into the visit), with 5 ms edges. */
export function onAir(gen: Emitter, fromS: number, toS = Infinity): Emitter {
	return (rng, n, amp) => {
		const iq = gen(rng, n, amp)
		for (let i = 0; i < n; i++) {
			const t = i / FS
			const gain = Math.min(
				1,
				Math.max(0, (t - fromS) / GATE_RAMP_S),
				Math.max(0, (toS - t) / GATE_RAMP_S),
			)
			iq.re[i]! *= gain
			iq.im[i]! *= gain
		}
		return iq
	}
}

/** `gen` keyed `onS` on and `offS` off from the start of the visit, with 5 ms edges. */
export function phrases(gen: Emitter, onS: number, offS: number): Emitter {
	return (rng, n, amp) => {
		const iq = gen(rng, n, amp)
		const period = onS + offS
		for (let i = 0; i < n; i++) {
			const t = (i / FS) % period
			const gain = Math.min(
				1,
				t / GATE_RAMP_S,
				Math.max(0, (onS - t) / GATE_RAMP_S),
			)
			iq.re[i]! *= gain
			iq.im[i]! *= gain
		}
		return iq
	}
}

/** Moves `iq` by `hz`, in place. */
function shiftInPlace(iq: Iq, hz: number): void {
	const step = (2 * Math.PI * hz) / FS
	for (let i = 0; i < iq.re.length; i++) {
		const c = Math.cos(step * i)
		const s = Math.sin(step * i)
		const re = iq.re[i]!
		const im = iq.im[i]!
		iq.re[i] = re * c - im * s
		iq.im[i] = re * s + im * c
	}
}

/** One visit of several emissions: the snapshots of every track within 30 kHz of `OFFSET_HZ`. */
export function runScene(
	emissions: readonly SceneEmission[],
	snrDb: number,
	seed: number,
	seconds: number,
	lines: readonly SeededLine[] = [],
): TrackSnapshot[] {
	const rng = mulberry32(seed)
	const h = new Harness({
		format: "FLOAT32LE",
		integrationMs: 50,
		...(lines.length > 0 ? { persistedEngine: engineWith(lines) } : {}),
	})
	start(h)
	const n = Math.round(seconds * FS)
	const iq = gaussianNoise(rng, n, SIGMA)
	for (const [gen, offsetHz, levelDb] of emissions) {
		const e = gen(rng, n, ampFor(snrDb + levelDb))
		shiftInPlace(e, offsetHz)
		addInto(iq, e)
	}
	h.push(iq, 8192)
	const target = CENTRE + OFFSET_HZ
	return h.tracks().filter(t => Math.abs(t.centreHz - target) <= 30_000)
}

/** A 2 m band job's range, as the scanner reads priors and rasters from it. */
const BAND: ScanRange = {
	startHz: CENTRE - (N / 2) * BIN_HZ,
	endHz: CENTRE + (N / 2) * BIN_HZ,
	rasters: [{ spacingHz: 12_500, firstChannelHz: CENTRE }],
	obwHz: [11_000, 16_000],
	protocols: ["analog-fm", "aprs", "dstar", "dmr", "ysf"],
}

export type SnapshotClassifier = (track: TrackSnapshot) => ScannerClass

/** What `ScannerService.classify` does: a piece is at most its channel, then the spectral tier. */
export const productionClass: SnapshotClassifier = track =>
	classifySpectral(track.obwHz > 12_500 ? { ...track, obwHz: 12_500 } : track, {
		priors: priorsFor([BAND], track.centreHz),
		protocols: [],
	}).class

export interface MatrixCell {
	readonly signal: string
	readonly snrDb: number
	/** Class of each snapshot of 20 blocks or more, in order, over the seeds. */
	readonly settled: readonly ScannerClass[]
	/** Each seed's visit reached `analog-fm` on some snapshot, the class the recorder follows. */
	readonly visitsVoiced: number
	readonly visits: number
	/** The classes of every snapshot of 5 blocks or more, counted. */
	readonly classes: Readonly<Partial<Record<ScannerClass, number>>>
}

/** Runs one visit per seed of `signal` at `snrDb` and classes its snapshots with `classify`. */
export function matrixCell(
	signal: SignalDef,
	snrDb: number,
	seeds: readonly number[],
	seconds: number,
	classify: SnapshotClassifier = productionClass,
): MatrixCell {
	const settled: ScannerClass[] = []
	const classes: Partial<Record<ScannerClass, number>> = {}
	let visitsVoiced = 0
	for (const seed of seeds) {
		let voiced = false
		for (const track of runVisit(signal, snrDb, seed + snrDb, seconds)) {
			if (track.blocks < 5) continue
			const cls = classify(track)
			classes[cls] = (classes[cls] ?? 0) + 1
			if (track.blocks >= 20) settled.push(cls)
			if (cls === "analog-fm") voiced = true
		}
		if (voiced) visitsVoiced++
	}
	return {
		signal: signal.name,
		snrDb,
		settled,
		visitsVoiced,
		visits: seeds.length,
		classes,
	}
}
