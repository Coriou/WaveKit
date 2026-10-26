/**
 * Synthetic spectrum frames from the mock signals: a jittered noise floor, each signal a shaped
 * hump (flat top, steep skirts), bursty signals only while keyed, and a small DC spike. Shapes are
 * precomputed per (centre, bins); a frame is a noise-table copy plus a max over the active humps.
 */
import type {
	SpectrumFrameEventData,
	SpectrumProfileAdjustment,
} from "@wavekit/api-types"
import {
	MOCK_SIGNALS,
	NOISE_FLOOR_DBFS,
	SAMPLE_RATE_HZ,
	signalActive,
	USABLE_FRACTION,
} from "./data.ts"
import type { MockSignal } from "./data.ts"

export const SPECTRUM_DEFAULT_HZ = 10
/** Core WG1 backfill limits (src/core/spectrum/subscribe-options.ts BACKFILL_LIMITS). */
export const SPECTRUM_BACKFILL_MAX_MS = 10_000
export const SPECTRUM_BACKFILL_MAX_FRAMES = 64
export const SPECTRUM_DEFAULT_BINS = 1024
export const SPECTRUM_FFT_SIZE = 8192
/** Core `scanner.ws.spectrumSummaryBins` default: the engine's per-source summary budget. */
export const SPECTRUM_SUMMARY_BINS = 2048

/** Where a frame's bins sit, as the real core lays them out. */
export interface FrameGeometry {
	startHz: number
	binHz: number
	binCount: number
	/** The engine summary's bin width: track edges sit on this grid. */
	summaryBinHz: number
}

/**
 * Frame geometry like the core's (src/core/spectrum/spectrum-service.ts frame()): a frame covers only
 * the usable share of the capture (USABLE_FRACTION, 80 %: the edges are filter roll-off), from the
 * engine's summary (FFT bins grouped down to SPECTRUM_SUMMARY_BINS), max-reduced by a whole factor to at
 * most `bins` bins. So binCount is usually below the bins asked for (820 for 1024 on a real core).
 */
export function frameGeometry(
	centerHz: number,
	bins: number,
	summaryBins: number = SPECTRUM_SUMMARY_BINS,
	sampleRateHz: number = SAMPLE_RATE_HZ,
): FrameGeometry {
	const nativeBinHz = sampleRateHz / SPECTRUM_FFT_SIZE
	const native = Math.floor((sampleRateHz * USABLE_FRACTION) / nativeBinHz)
	const group = Math.max(1, Math.ceil(native / summaryBins))
	const summaryCount = Math.ceil(native / group)
	const summaryBinHz = nativeBinHz * group
	const factor = Math.max(1, Math.ceil(summaryCount / Math.max(1, bins)))
	return {
		startHz: Math.round(centerHz - (summaryCount * summaryBinHz) / 2),
		binHz: summaryBinHz * factor,
		binCount: Math.ceil(summaryCount / factor),
		summaryBinHz,
	}
}

interface Hump {
	signal: MockSignal
	first: number
	levels: Float32Array
}

interface Layout extends FrameGeometry {
	humps: Hump[]
	dcBin: number
}

const NOISE_SIZE = 65_536
const noise = new Float32Array(NOISE_SIZE)
{
	// Sum of three uniforms: a cheap bell, about ±3 dB.
	let seed = 0x2545f491
	const rand = () => {
		seed ^= seed << 13
		seed ^= seed >>> 17
		seed ^= seed << 5
		return (seed >>> 0) / 0x1_0000_0000
	}
	for (let i = 0; i < NOISE_SIZE; i++)
		noise[i] = (rand() + rand() + rand() - 1.5) * 2.4
}

const layouts = new Map<string, Layout>()

function layout(
	centerHz: number,
	bins: number,
	summaryBins: number,
	sampleRateHz: number,
	extra: readonly MockSignal[],
): Layout {
	const key = `${centerHz}:${bins}:${summaryBins}:${sampleRateHz}:${extra.length}`
	const cached = layouts.get(key)
	if (cached) return cached
	const geometry = frameGeometry(centerHz, bins, summaryBins, sampleRateHz)
	const { startHz, binHz, binCount } = geometry
	const endHz = startHz + binCount * binHz
	const humps: Hump[] = []
	for (const signal of extra.length > 0 ? extra : MOCK_SIGNALS) {
		const half = signal.bwHz / 2
		const reach = half * 3 + binHz
		if (signal.hz + reach < startHz || signal.hz - reach > endHz) continue
		const first = Math.max(0, Math.floor((signal.hz - reach - startHz) / binHz))
		const last = Math.min(
			binCount - 1,
			Math.ceil((signal.hz + reach - startHz) / binHz),
		)
		if (last < first) continue
		const levels = new Float32Array(last - first + 1)
		for (let i = first; i <= last; i++) {
			const centre = startHz + (i + 0.5) * binHz
			// Max-hold over the bin: the bin edge nearest the signal decides.
			const d = Math.max(0, Math.abs(centre - signal.hz) - binHz / 2)
			const x = d / Math.max(half, 1)
			const db = x <= 1 ? -3 * x ** 4 : -3 - 45 * (x - 1)
			levels[i - first] = signal.powerDbfs + db
		}
		humps.push({ signal, first, levels })
	}
	const result: Layout = {
		...geometry,
		humps,
		dcBin: Math.min(
			binCount - 1,
			Math.max(0, Math.floor((centerHz - startHz) / binHz)),
		),
	}
	if (layouts.size > 32) layouts.clear()
	layouts.set(key, result)
	return result
}

/** Byte for a level: dBFS = byte / 2 − 127.5. */
function encode(db: number): number {
	const v = Math.round((db + 127.5) * 2)
	return v < 0 ? 0 : v > 255 ? 255 : v
}

export interface FrameInput {
	sourceId: string
	centerHz: number
	bins: number
	hz: number
	epoch: number
	nowMs: number
	snapshot?: boolean
	/** The engine's summary budget (scanner.ws.spectrumSummaryBins); default SPECTRUM_SUMMARY_BINS. */
	summaryBins?: number
	/** The capture's sample rate (the frame spans its usable 80 %); default SAMPLE_RATE_HZ. */
	sampleRateHz?: number
	/** Signals drawn instead of MOCK_SIGNALS (the retune sweep scenario); default none. */
	signals?: readonly MockSignal[]
	/** 0..1, picks the noise window; defaults to Math.random(). */
	random?: () => number
}

/** One `spectrum:frame` payload. */
export function synthFrame(input: FrameInput): SpectrumFrameEventData {
	const { centerHz } = input
	const sampleRateHz = input.sampleRateHz ?? SAMPLE_RATE_HZ
	const lay = layout(
		centerHz,
		input.bins,
		input.summaryBins ?? SPECTRUM_SUMMARY_BINS,
		sampleRateHz,
		input.signals ?? [],
	)
	const bins = lay.binCount
	const random = input.random ?? Math.random
	const tSec = input.nowMs / 1000
	const levels = new Float32Array(bins)
	const offset = Math.floor(random() * (NOISE_SIZE - bins))
	for (let i = 0; i < bins; i++)
		levels[i] = NOISE_FLOOR_DBFS + (noise[offset + i] ?? 0)
	const dc = levels[lay.dcBin] ?? NOISE_FLOOR_DBFS
	levels[lay.dcBin] = Math.max(dc, NOISE_FLOOR_DBFS + 9)
	const tracks: SpectrumFrameEventData["tracks"] = []
	for (const hump of lay.humps) {
		const { signal } = hump
		if (!signalActive(signal, tSec)) continue
		// Small level wobble per frame so the trace breathes.
		const wobble = (random() - 0.5) * 2
		for (let j = 0; j < hump.levels.length; j++) {
			const i = hump.first + j
			const v = (hump.levels[j] ?? -200) + wobble
			if (v > (levels[i] ?? 0)) levels[i] = v
		}
		// Track edges on the summary bin grid, as the core measures them (so a carrier on a round
		// frequency reads a few hundred Hz off: the grid starts at the frame's startHz).
		const endHz = lay.startHz + bins * lay.binHz
		const grid = lay.summaryBinHz
		const lo = Math.max(
			lay.startHz +
				Math.floor((signal.hz - signal.bwHz / 2 - lay.startHz) / grid) * grid,
			lay.startHz,
		)
		const hi = Math.min(
			lay.startHz +
				Math.ceil((signal.hz + signal.bwHz / 2 - lay.startHz) / grid) * grid,
			endHz,
		)
		if (lo < hi)
			tracks.push({
				startHz: Math.round(lo),
				endHz: Math.round(hi),
				flags: {
					burst: signal.per !== undefined,
					iqImage: false,
					edge: lo === lay.startHz || hi === endHz,
				},
				// WG11: a stable id per emission and the core's surfacing verdict
				trackId: `m${Math.round(signal.hz)}`,
				surfaced: true,
			})
	}
	const bytes = new Uint8Array(bins)
	for (let i = 0; i < bins; i++)
		bytes[i] = encode(levels[i] ?? NOISE_FLOOR_DBFS)
	const frame: SpectrumFrameEventData = {
		sourceId: input.sourceId,
		profile: `${input.hz}:${input.bins}`,
		epoch: input.epoch,
		tuningTrust: "commanded",
		centerHz,
		sampleRateHz,
		binHz: lay.binHz,
		nativeBinHz: sampleRateHz / SPECTRUM_FFT_SIZE,
		startHz: lay.startHz,
		binCount: bins,
		bins: Buffer.from(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength,
		).toString("base64"),
		binEncoding: "u8-halfdb-127.5",
		floorDbfs: NOISE_FLOOR_DBFS,
		thresholdDb: 8,
		tracks,
		masks: { dcHz: centerHz, dcGuardHz: 2000, spurRanges: [] },
		at: new Date(input.nowMs).toISOString(),
	}
	if (input.snapshot) frame.snapshot = true
	return frame
}

export interface SpectrumSelection {
	ok: true
	sourceId: string | null
	hz: number
	bins: number
	adjusted: SpectrumProfileAdjustment[]
	explicit: boolean
	/** Backfill asked for, ms (0 = none), clamped to SPECTRUM_BACKFILL_MAX_MS. */
	backfillMs: number
}

/** Normalises `options.spectrum` like the core: hz 0.5–25 snapped to 0.5, bins 128–`binsMax` rounded. */
export function normaliseSpectrumOptions(
	raw: unknown,
	binsMax = SPECTRUM_SUMMARY_BINS,
): SpectrumSelection | { ok: false; message: string } {
	if (raw === undefined || raw === null)
		return {
			ok: true,
			sourceId: null,
			hz: SPECTRUM_DEFAULT_HZ,
			bins: SPECTRUM_DEFAULT_BINS,
			adjusted: [],
			explicit: false,
			backfillMs: 0,
		}
	if (typeof raw !== "object" || Array.isArray(raw))
		return { ok: false, message: "options.spectrum must be an object" }
	const o = raw as Record<string, unknown>
	const sourceId = o["sourceId"]
	if (typeof sourceId !== "string" || sourceId.length === 0)
		return { ok: false, message: "options.spectrum.sourceId is required" }
	const adjusted: SpectrumProfileAdjustment[] = []
	let hz = SPECTRUM_DEFAULT_HZ
	if (o["hz"] !== undefined) {
		if (typeof o["hz"] !== "number" || !Number.isFinite(o["hz"]))
			return { ok: false, message: "options.spectrum.hz must be a number" }
		hz = Math.min(25, Math.max(0.5, Math.round(o["hz"] * 2) / 2))
		if (hz !== o["hz"]) adjusted.push("hz")
	}
	let bins = SPECTRUM_DEFAULT_BINS
	if (o["bins"] !== undefined) {
		if (typeof o["bins"] !== "number" || !Number.isFinite(o["bins"]))
			return { ok: false, message: "options.spectrum.bins must be a number" }
		bins = Math.min(binsMax, Math.max(128, Math.round(o["bins"])))
		if (bins !== o["bins"]) adjusted.push("bins")
	}
	let backfillMs = 0
	if (o["backfillMs"] !== undefined) {
		if (
			typeof o["backfillMs"] !== "number" ||
			!Number.isFinite(o["backfillMs"])
		)
			return {
				ok: false,
				message: "options.spectrum.backfillMs must be a number",
			}
		backfillMs = Math.min(
			SPECTRUM_BACKFILL_MAX_MS,
			Math.max(0, Math.round(o["backfillMs"])),
		)
		if (backfillMs !== o["backfillMs"]) adjusted.push("backfillMs")
	}
	return {
		ok: true,
		sourceId,
		hz,
		bins,
		adjusted,
		explicit: true,
		backfillMs,
	}
}
