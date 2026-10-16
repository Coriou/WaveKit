/**
 * WG8 req 5.2: resolves `scanner.ws.spectrumBinsCap` once at startup. Imports nothing but
 * `@wavekit/api-types` so `src/index.ts` can call it without loading the spectrum engine.
 * Never logs and never throws: any bench failure answers the floor with source "fallback".
 */
import {
	SPECTRUM_BINS_BUDGET,
	SPECTRUM_BINS_CAP_FLOOR,
	type SpectrumBinsCapSetting,
	type SpectrumBinsCapView,
} from "@wavekit/api-types"

export type BinsCostSample = {
	bins: number
	summaryBytesPerSecond: number
	cloneMsPerSecond: number
	profileMsPerSecond: number
}
export type BinsCapMeasurer = (
	bins: number,
	summaryHz: number,
) => BinsCostSample
export type SpectrumBinsCapResult = SpectrumBinsCapView & {
	measurements: readonly BinsCostSample[]
	wallMs: number
}

/** 1000 / `scanner.detection.integrationMs` default (50 ms, `src/config.ts`) = 20 summaries/s. */
const DEFAULT_SUMMARY_HZ = 1000 / 50
/** "auto" candidates, descending; the first that passes wins. The floor is never measured. */
const AUTO_CANDIDATES = [8192, 4096] as const
/** Default measurer: one-time JIT warm-up summaries at the floor size, then per candidate untimed and timed summaries. */
export const DEFAULT_MEASURER_JIT_WARMUP = 64
export const DEFAULT_MEASURER_WARMUP = 2
export const DEFAULT_MEASURER_ITERATIONS = 16

/** Thrown inside the default measurer when the bench wall budget is reached. */
class BenchOvertime extends Error {}

/** Median of per-summary times: robust to one-off preemption or GC pauses on a loaded host. */
function median(xs: Float64Array): number {
	const s = xs.slice().sort()
	const mid = s.length >> 1
	return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function passes(s: BinsCostSample): boolean {
	const b = SPECTRUM_BINS_BUDGET
	return (
		s.summaryBytesPerSecond * b.margin <= b.summaryBytesPerSecond &&
		s.cloneMsPerSecond * b.margin <= b.cloneMsPerSecond &&
		s.profileMsPerSecond * b.margin <= b.profileMsPerSecond
	)
}

function valid(s: unknown, bins: number): s is BinsCostSample {
	if (typeof s !== "object" || s === null) return false
	const r = s as Record<string, unknown>
	if (r["bins"] !== bins) return false
	for (const k of [
		"summaryBytesPerSecond",
		"cloneMsPerSecond",
		"profileMsPerSecond",
	]) {
		const v = r[k]
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return false
	}
	return true
}

/** Worker side: int16 half-dB encode of one summary into `wire`. */
function encodeInt16(
	src: Float64Array,
	wire: Int16Array,
	jitter: number,
): void {
	for (let i = 0; i < src.length; i++) {
		const v = Math.round(src[i]! * 2 + jitter)
		wire[i] = Math.min(32767, Math.max(-32768, v))
	}
}

/** Service side, one profile at summary size: `reduceMaxHold` (factor 1) then `encodeBins`. */
function profileWork(
	view: Int16Array,
	held: Float32Array,
	u8: Uint8Array,
): number {
	for (let i = 0; i < view.length; i++)
		held[i] = Math.max(-Infinity, view[i]! / 2)
	for (let i = 0; i < held.length; i++) {
		const v = Math.round((held[i]! + 127.5) * 2)
		u8[i] = Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : 0
	}
	return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64")
		.length
}

/** One summary through the hot path; returns [transfer ms, profile ms] via `out`. */
function oneSummary(
	now: () => number,
	b: {
		src: Float64Array
		wire: Int16Array
		held: Float32Array
		u8: Uint8Array
	},
	jitter: number,
	out: Float64Array,
): number {
	const t0 = now()
	encodeInt16(b.src, b.wire, jitter)
	const cloned = structuredClone(b.wire.buffer)
	const t1 = now()
	const sink = profileWork(new Int16Array(cloned), b.held, b.u8)
	const t2 = now()
	out[0] = t1 - t0
	out[1] = t2 - t1
	return sink + cloned.byteLength
}

function buffers(bins: number): {
	src: Float64Array
	wire: Int16Array
	held: Float32Array
	u8: Uint8Array
} {
	const src = new Float64Array(bins)
	for (let i = 0; i < bins; i++)
		src[i] = -100 + 40 * Math.sin(i * 0.013) + (i % 7) * 0.5
	return {
		src,
		wire: new Int16Array(bins),
		held: new Float32Array(bins),
		u8: new Uint8Array(bins),
	}
}

/**
 * Self-contained equivalent of the summary hot path: the worker's int16 half-dB encode and the
 * `structuredClone` of the transfer buffer (charged together to the clone budget), and the
 * service's per-profile work at summary size (`reduceMaxHold` + `encodeBins`). Before the first
 * candidate it warms the kernels once at the floor size (cheap; V8 needs tens of passes to tier
 * up, and the running service is always warm), then per candidate runs
 * `DEFAULT_MEASURER_WARMUP` untimed and `DEFAULT_MEASURER_ITERATIONS` timed summaries and takes
 * the median. Buffers are allocated once per candidate. The clock is checked before every
 * summary; past `deadline` it throws `BenchOvertime`, which the resolver turns into fallback.
 */
function defaultMeasurer(now: () => number, deadline: number): BinsCapMeasurer {
	let warmed = false
	const times = new Float64Array(2)
	let sink = 0
	const run = (
		b: ReturnType<typeof buffers>,
		count: number,
		record?: (k: number) => void,
	): void => {
		for (let k = 0; k < count; k++) {
			if (now() > deadline) throw new BenchOvertime()
			sink += oneSummary(now, b, k & 1, times)
			record?.(k)
		}
	}
	return (bins, summaryHz) => {
		if (!warmed) {
			run(buffers(SPECTRUM_BINS_CAP_FLOOR), DEFAULT_MEASURER_JIT_WARMUP)
			warmed = true
		}
		const b = buffers(bins)
		const n = DEFAULT_MEASURER_ITERATIONS
		const transferMs = new Float64Array(n)
		const profileMs = new Float64Array(n)
		run(b, DEFAULT_MEASURER_WARMUP)
		run(b, n, k => {
			transferMs[k] = times[0]!
			profileMs[k] = times[1]!
		})
		// `sink` keeps the work observable; it is always positive here.
		const bytes = sink > 0 ? bins * 2 * summaryHz : Number.NaN
		return {
			bins,
			summaryBytesPerSecond: bytes,
			cloneMsPerSecond: median(transferMs) * summaryHz,
			profileMsPerSecond: median(profileMs) * summaryHz,
		}
	}
}

export function resolveSpectrumBinsCap(
	setting: SpectrumBinsCapSetting,
	options?: { measure?: BinsCapMeasurer; now?: () => number },
): SpectrumBinsCapResult {
	if (setting !== "auto")
		return {
			setting,
			cap: setting,
			source: "config",
			measurements: [],
			wallMs: 0,
		}
	const measurements: BinsCostSample[] = []
	let start = 0
	let wallMs = 0
	const fallback = (): SpectrumBinsCapResult => ({
		setting,
		cap: SPECTRUM_BINS_CAP_FLOOR,
		source: "fallback",
		measurements,
		wallMs,
	})
	try {
		const now = options?.now ?? (() => performance.now())
		start = now()
		const measure =
			options?.measure ??
			defaultMeasurer(now, start + SPECTRUM_BINS_BUDGET.benchWallMs)
		for (const bins of AUTO_CANDIDATES) {
			const sample: unknown = measure(bins, DEFAULT_SUMMARY_HZ)
			wallMs = now() - start
			if (!Number.isFinite(wallMs) || wallMs > SPECTRUM_BINS_BUDGET.benchWallMs)
				return fallback()
			if (!valid(sample, bins)) return fallback()
			measurements.push({
				bins: sample.bins,
				summaryBytesPerSecond: sample.summaryBytesPerSecond,
				cloneMsPerSecond: sample.cloneMsPerSecond,
				profileMsPerSecond: sample.profileMsPerSecond,
			})
			if (passes(sample))
				return { setting, cap: bins, source: "measured", measurements, wallMs }
		}
		return {
			setting,
			cap: SPECTRUM_BINS_CAP_FLOOR,
			source: "measured",
			measurements,
			wallMs,
		}
	} catch {
		return fallback()
	}
}
