/**
 * Zoom sustained workload benchmark: pure helpers (web-gaps-9 §4, lane ZM).
 * Measurement only: imports the pure spectrum and scanner DSP helpers by
 * relative path and copies `reduceMaxHold` instead of importing the spectrum
 * service.
 */
import { ChannelDecimator } from "../../src/core/scanner/evidence/iq-decimate.js"
import { Fft, hannWindow } from "../../src/core/spectrum/fft.js"

export type Variant = "fft" | "ddc"

export interface BenchOptions {
	fs: number[]
	fft: number[]
	rate: number[]
	slices: number[]
	variant: Variant[]
	durationS: number
	gapS: number
	spanHz: number
	seed: number
	detector: boolean
	smoke: boolean
	out: string | null
}

/** Viewed-slice-spectrum budgets used as the pass rule. */
export const BUDGETS = {
	incrementalCorePerSource: 0.1,
	incrementalCoreTotal: 0.2,
	eventLoopP99IncreaseMs: 2,
	missedDeadlines: 0,
	/** RSS high-water growth allowed in the second half of a cell. */
	rssGrowthBytes: 16 * 1024 * 1024,
} as const

export const DEADLINE_MS = 250
export const CHUNK_MS = 50
export const OUTPUT_BINS = 2048
export const DETECTOR_FFT = 2048
const MIN_POW2 = 2048
const MAX_POW2 = 262_144

function isPow2InRange(n: number): boolean {
	return (
		Number.isInteger(n) && n >= MIN_POW2 && n <= MAX_POW2 && (n & (n - 1)) === 0
	)
}

function shown(raw: string): string {
	return raw.length > 24 ? `${raw.slice(0, 24)}...` : raw
}

function parseNumberList(
	flag: string,
	raw: string,
	pow2Range: boolean,
): number[] {
	const out: number[] = []
	for (const part of raw.split(",")) {
		const range = /^(\d+)\.\.(\d+)$/.exec(part.trim())
		if (range) {
			const lo = Number(range[1])
			const hi = Number(range[2])
			if (!pow2Range || !isPow2InRange(lo) || !isPow2InRange(hi) || lo > hi) {
				throw new Error(
					`${flag}: range "${shown(part)}" must be powers of two lo..hi`,
				)
			}
			for (let v = lo; v <= hi; v *= 2) out.push(v)
			continue
		}
		const v = Number(part.trim())
		if (part.trim() === "" || !Number.isFinite(v)) {
			throw new Error(`${flag}: "${shown(part)}" is not a number`)
		}
		out.push(v)
	}
	return [...new Set(out)]
}

function checkAll(
	flag: string,
	values: number[],
	ok: (v: number) => boolean,
	rule: string,
): void {
	for (const v of values) {
		if (!ok(v)) throw new Error(`${flag}: ${shown(String(v))} ${rule}`)
	}
}

/**
 * Flags: --fs, --fft, --rate, --slices (comma lists; --fft also lo..hi
 * powers of two), --variant fft,ddc, --duration s, --gap s, --span-hz,
 * --seed, --no-detector, --smoke, --out dir. Throws on bad input.
 */
export function parseArgs(argv: readonly string[]): BenchOptions {
	const smoke = argv.includes("--smoke")
	const o: BenchOptions = smoke
		? {
				fs: [2_048_000],
				fft: [8192],
				rate: [5],
				slices: [1],
				variant: ["fft"],
				durationS: 3,
				gapS: 0.5,
				spanHz: 128_000,
				seed: 1,
				detector: true,
				smoke,
				out: null,
			}
		: {
				fs: [2_048_000, 2_400_000],
				fft: parseNumberList("--fft", "2048..262144", true),
				rate: [1, 5, 10, 25],
				slices: [1, 2, 4, 8],
				variant: ["fft"],
				durationS: 60,
				gapS: 2,
				spanHz: 128_000,
				seed: 1,
				detector: true,
				smoke,
				out: null,
			}
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!
		if (flag === "--smoke") continue
		if (flag === "--no-detector") {
			o.detector = false
			continue
		}
		const value = argv[i + 1]
		if (value === undefined) throw new Error(`${shown(flag)}: missing value`)
		i++
		switch (flag) {
			case "--fs":
				o.fs = parseNumberList(flag, value, false)
				checkAll(
					flag,
					o.fs,
					v => Number.isInteger(v) && v >= 250_000 && v <= 3_200_000,
					"must be an integer rate 250000..3200000",
				)
				break
			case "--fft":
				o.fft = parseNumberList(flag, value, true)
				checkAll(
					flag,
					o.fft,
					isPow2InRange,
					"must be a power of two 2048..262144",
				)
				break
			case "--rate":
				o.rate = parseNumberList(flag, value, false)
				checkAll(flag, o.rate, v => v >= 1 && v <= 25, "must be 1..25")
				break
			case "--slices":
				o.slices = parseNumberList(flag, value, false)
				checkAll(
					flag,
					o.slices,
					v => Number.isInteger(v) && v >= 1 && v <= 8,
					"must be an integer 1..8",
				)
				break
			case "--variant": {
				const vs = value.split(",").map(s => s.trim())
				for (const v of vs) {
					if (v !== "fft" && v !== "ddc") {
						throw new Error(`--variant: "${shown(v)}" must be fft or ddc`)
					}
				}
				o.variant = [...new Set(vs)] as Variant[]
				break
			}
			case "--duration":
			case "--gap":
			case "--span-hz":
			case "--seed": {
				const v = Number(value)
				if (!Number.isFinite(v)) {
					throw new Error(`${flag}: "${shown(value)}" is not a number`)
				}
				if (flag === "--duration") {
					if (v <= 0) throw new Error("--duration must be > 0")
					o.durationS = v
				} else if (flag === "--gap") {
					if (v < 0) throw new Error("--gap must be >= 0")
					o.gapS = v
				} else if (flag === "--span-hz") {
					if (v < 1000) throw new Error("--span-hz must be >= 1000")
					o.spanHz = v
				} else {
					o.seed = Math.trunc(v)
				}
				break
			}
			case "--out":
				o.out = value
				break
			default:
				throw new Error(`unknown flag ${shown(flag)}`)
		}
	}
	if (smoke && o.durationS > 5) o.durationS = 5
	for (const fs of o.fs) {
		if (o.spanHz > fs) throw new Error("--span-hz must not exceed --fs")
	}
	return o
}

/** Seeded PRNG in [0, 1) (copied from tests/mocks/scanner/signals.ts). */
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

/** Tone frequencies: integer Hz, so a whole-second buffer loops without a phase jump. */
export const TONE_A_HZ = 100_000
export const TONE_B_HZ = TONE_A_HZ + 250

/**
 * Seeded CU8: complex Gaussian noise σ = 0.05 per component plus two tones
 * (amplitude 0.3 each) 250 Hz apart, full scale |z| = 1.
 */
export function makeCu8Signal(
	seed: number,
	fs: number,
	seconds: number,
): Uint8Array {
	const n = Math.round(fs * seconds)
	const rng = mulberry32(seed)
	const out = new Uint8Array(2 * n)
	const wa = (2 * Math.PI * TONE_A_HZ) / fs
	const wb = (2 * Math.PI * TONE_B_HZ) / fs
	const gauss = (): number => {
		let u = rng()
		while (u <= 0) u = rng()
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
	}
	for (let i = 0; i < n; i++) {
		const re = 0.3 * Math.cos(wa * i) + 0.3 * Math.cos(wb * i) + 0.05 * gauss()
		const im = 0.3 * Math.sin(wa * i) + 0.3 * Math.sin(wb * i) + 0.05 * gauss()
		out[2 * i] = Math.min(255, Math.max(0, Math.round(re * 127.5 + 127.5)))
		out[2 * i + 1] = Math.min(255, Math.max(0, Math.round(im * 127.5 + 127.5)))
	}
	return out
}

/**
 * Nearest-rank percentile of an ascending array: the value at 1-based rank
 * ceil(p/100 · n), clamped to [1, n]; p = 0 gives the minimum. NaN when empty.
 */
export function percentile(sorted: ArrayLike<number>, p: number): number {
	const n = sorted.length
	if (n === 0) return Number.NaN
	const pc = Math.min(100, Math.max(0, p))
	const rank = Math.min(n, Math.max(1, Math.ceil((pc / 100) * n)))
	return sorted[rank - 1]!
}

/** Copied from src/core/spectrum/spectrum-service.ts (do not import the service). */
export function reduceMaxHold(
	bins: ArrayLike<number>,
	maxBins: number,
): { bins: Float32Array; factor: number } {
	const factor = Math.max(1, Math.ceil(bins.length / Math.max(1, maxBins)))
	const out = new Float32Array(Math.ceil(bins.length / factor))
	for (let i = 0; i < out.length; i++) {
		let m = -Infinity
		const end = Math.min(bins.length, (i + 1) * factor)
		for (let j = i * factor; j < end; j++) m = Math.max(m, bins[j]!)
		out[i] = m
	}
	return { bins: out, factor }
}

/**
 * Shifted-bin range [start, end) for a slice centred at offsetHz with spanHz
 * in an N-point FFT at fs (shifted index i is offset (i − N/2)·fs/N). Clamped
 * to the band; at least one bin.
 */
export function sliceBins(
	n: number,
	fs: number,
	offsetHz: number,
	spanHz: number,
): { start: number; end: number } {
	const count = Math.min(n, Math.max(1, Math.round((spanHz * n) / fs)))
	const centre = Math.round(n / 2 + (offsetHz * n) / fs)
	let start = centre - Math.floor(count / 2)
	start = Math.min(n - count, Math.max(0, start))
	return { start, end: start + count }
}

/** Slice centre offsets spread over the inner half of the band, slice 0 on the tones. */
export function sliceOffsets(count: number, fs: number): number[] {
	const out: number[] = [TONE_A_HZ]
	for (let i = 1; i < count; i++) out.push(-fs / 4 + (i * fs) / (2 * count))
	return out
}

/** Ring of the latest `capacity` CU8 samples (2 bytes each). */
export class Cu8Ring {
	readonly capacity: number
	private readonly buf: Uint8Array
	private write = 0
	filled = 0

	constructor(capacity: number) {
		this.capacity = capacity
		this.buf = new Uint8Array(2 * capacity)
	}

	push(cu8: Uint8Array): void {
		const bytes = this.buf.length
		let src = cu8
		if (src.length > bytes) src = src.subarray(src.length - bytes)
		const first = Math.min(src.length, bytes - this.write)
		this.buf.set(src.subarray(0, first), this.write)
		if (first < src.length) this.buf.set(src.subarray(first), 0)
		this.write = (this.write + src.length) % bytes
		this.filled = Math.min(this.capacity, this.filled + (src.length >> 1))
	}

	/** Latest `capacity` contiguous samples, oldest first, windowed, into re/im. */
	copyWindowed(window: Float32Array, re: Float32Array, im: Float32Array): void {
		const bytes = this.buf.length
		let r = this.write
		const buf = this.buf
		for (let i = 0; i < this.capacity; i++) {
			const w = window[i]!
			re[i] = ((buf[r]! - 127.5) / 127.5) * w
			im[i] = ((buf[r + 1]! - 127.5) / 127.5) * w
			r += 2
			if (r >= bytes) r = 0
		}
	}
}

/**
 * One viewed slice: copy the latest N contiguous samples, Hann window, FFT N,
 * shifted power (dB) over the slice bins only, max-hold to OUTPUT_BINS. The
 * ddc variant first shifts and decimates (ChannelDecimator) every full-rate
 * sample to the slice span, then FFTs N decimated samples.
 */
export class ZoomSlice {
	readonly n: number
	readonly bins: { start: number; end: number }
	private readonly ring: Cu8Ring
	private readonly fft: Fft
	private readonly window: Float32Array
	private readonly re: Float32Array
	private readonly im: Float32Array
	private readonly power: Float32Array
	private readonly ddc: ChannelDecimator | null

	constructor(opts: {
		n: number
		fs: number
		offsetHz: number
		spanHz: number
		variant: Variant
	}) {
		this.n = opts.n
		this.ring = new Cu8Ring(opts.n)
		this.fft = new Fft(opts.n)
		this.window = hannWindow(opts.n)
		this.re = new Float32Array(opts.n)
		this.im = new Float32Array(opts.n)
		if (opts.variant === "ddc") {
			this.ddc = new ChannelDecimator({
				inputRateHz: opts.fs,
				offsetHz: opts.offsetHz,
				targetRateHz: opts.spanHz,
			})
			const rate = this.ddc.plan.outputRateHz
			this.bins = sliceBins(opts.n, rate, 0, Math.min(rate, opts.spanHz))
		} else {
			this.ddc = null
			this.bins = sliceBins(opts.n, opts.fs, opts.offsetHz, opts.spanHz)
		}
		this.power = new Float32Array(this.bins.end - this.bins.start)
	}

	/** Feed one chunk of full-rate CU8 (the ddc variant mixes and filters it here). */
	feed(cu8: Uint8Array): void {
		this.ring.push(this.ddc ? this.ddc.push(cu8) : cu8)
	}

	transform(): Float32Array {
		this.ring.copyWindowed(this.window, this.re, this.im)
		this.fft.transform(this.re, this.im)
		const n = this.n
		const half = n >> 1
		const scale = 1 / ((n / 2) * (n / 2))
		const { start, end } = this.bins
		for (let s = start; s < end; s++) {
			const k = s < half ? s + half : s - half
			const r = this.re[k]!
			const i = this.im[k]!
			const p = (r * r + i * i) * scale
			this.power[s - start] = p > 0 ? Math.max(-200, 10 * Math.log10(p)) : -200
		}
		return reduceMaxHold(this.power, OUTPUT_BINS).bins
	}
}

/** Detector proxy: a 2048-point Hann FFT over every non-overlapping frame, power accumulated. */
export class DetectorProxy {
	private readonly fft = new Fft(DETECTOR_FFT)
	private readonly window = hannWindow(DETECTOR_FFT)
	private readonly re = new Float32Array(DETECTOR_FFT)
	private readonly im = new Float32Array(DETECTOR_FFT)
	readonly acc = new Float64Array(DETECTOR_FFT)
	private carry = new Uint8Array(0)
	frames = 0

	feed(cu8: Uint8Array): void {
		let data = cu8
		if (this.carry.length > 0) {
			data = new Uint8Array(this.carry.length + cu8.length)
			data.set(this.carry)
			data.set(cu8, this.carry.length)
		}
		const frameBytes = 2 * DETECTOR_FFT
		let off = 0
		const half = DETECTOR_FFT >> 1
		for (; off + frameBytes <= data.length; off += frameBytes) {
			for (let i = 0; i < DETECTOR_FFT; i++) {
				const w = this.window[i]!
				this.re[i] = ((data[off + 2 * i]! - 127.5) / 127.5) * w
				this.im[i] = ((data[off + 2 * i + 1]! - 127.5) / 127.5) * w
			}
			this.fft.transform(this.re, this.im)
			for (let k = 0; k < DETECTOR_FFT; k++) {
				const r = this.re[k]!
				const i = this.im[k]!
				const s = k < half ? k + half : k - half
				this.acc[s] = this.acc[s]! + r * r + i * i
			}
			this.frames++
		}
		this.carry = data.slice(off)
	}
}

export interface CellMetrics {
	incrementalCore: number
	eventLoopP99IncreaseMs: number
	missedDeadlines: number
	rssGrowthBytes: number
}

/**
 * Pass rule (viewed-slice-spectrum budgets). One source per cell, so all
 * slices together are the per-source cost and also the total.
 */
export function evaluateCell(m: CellMetrics): {
	pass: boolean
	reasons: string[]
} {
	const reasons: string[] = []
	if (!(m.incrementalCore <= BUDGETS.incrementalCorePerSource)) {
		reasons.push(
			`incremental core ${m.incrementalCore.toFixed(4)} > ${BUDGETS.incrementalCorePerSource} per source`,
		)
	}
	if (!(m.incrementalCore <= BUDGETS.incrementalCoreTotal)) {
		reasons.push(
			`incremental core ${m.incrementalCore.toFixed(4)} > ${BUDGETS.incrementalCoreTotal} total`,
		)
	}
	if (!(m.eventLoopP99IncreaseMs <= BUDGETS.eventLoopP99IncreaseMs)) {
		reasons.push(
			`event-loop p99 +${m.eventLoopP99IncreaseMs.toFixed(3)} ms > ${BUDGETS.eventLoopP99IncreaseMs} ms`,
		)
	}
	if (m.missedDeadlines !== BUDGETS.missedDeadlines) {
		reasons.push(`${m.missedDeadlines} missed ${DEADLINE_MS} ms deadlines`)
	}
	if (!(m.rssGrowthBytes <= BUDGETS.rssGrowthBytes)) {
		reasons.push(
			`RSS grew ${(m.rssGrowthBytes / 1048576).toFixed(1)} MiB in the second half`,
		)
	}
	return { pass: reasons.length === 0, reasons }
}
