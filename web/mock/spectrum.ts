/**
 * Synthetic spectrum frames from the mock signals: a jittered noise floor, each signal a shaped
 * hump (flat top, steep skirts), bursty signals only while keyed, and a small DC spike. Shapes are
 * precomputed per (centre, bins); a frame is a noise-table copy plus a max over the active humps.
 */
import type { SpectrumFrameEventData } from "@wavekit/api-types"
import {
	MOCK_SIGNALS,
	NOISE_FLOOR_DBFS,
	SAMPLE_RATE_HZ,
	signalActive,
} from "./data.ts"
import type { MockSignal } from "./data.ts"

export const SPECTRUM_DEFAULT_HZ = 10
export const SPECTRUM_DEFAULT_BINS = 1024
export const SPECTRUM_FFT_SIZE = 8192

interface Hump {
	signal: MockSignal
	first: number
	levels: Float32Array
}

interface Layout {
	startHz: number
	binHz: number
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

function layout(centerHz: number, bins: number): Layout {
	const key = `${centerHz}:${bins}`
	const cached = layouts.get(key)
	if (cached) return cached
	const binHz = SAMPLE_RATE_HZ / bins
	const startHz = centerHz - SAMPLE_RATE_HZ / 2
	const endHz = startHz + SAMPLE_RATE_HZ
	const humps: Hump[] = []
	for (const signal of MOCK_SIGNALS) {
		const half = signal.bwHz / 2
		const reach = half * 3 + binHz
		if (signal.hz + reach < startHz || signal.hz - reach > endHz) continue
		const first = Math.max(0, Math.floor((signal.hz - reach - startHz) / binHz))
		const last = Math.min(
			bins - 1,
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
		startHz,
		binHz,
		humps,
		dcBin: Math.min(bins - 1, Math.floor(bins / 2)),
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
	/** 0..1, picks the noise window; defaults to Math.random(). */
	random?: () => number
}

/** One `spectrum:frame` payload. */
export function synthFrame(input: FrameInput): SpectrumFrameEventData {
	const { bins, centerHz } = input
	const lay = layout(centerHz, bins)
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
		const endHz = lay.startHz + SAMPLE_RATE_HZ
		const lo = Math.max(signal.hz - signal.bwHz / 2, lay.startHz)
		const hi = Math.min(signal.hz + signal.bwHz / 2, endHz)
		if (lo < hi)
			tracks.push({
				startHz: Math.round(lo),
				endHz: Math.round(hi),
				flags: {
					burst: signal.per !== undefined,
					iqImage: false,
					edge: lo === lay.startHz || hi === endHz,
				},
			})
	}
	const bytes = new Uint8Array(bins)
	for (let i = 0; i < bins; i++)
		bytes[i] = encode(levels[i] ?? NOISE_FLOOR_DBFS)
	const frame: SpectrumFrameEventData = {
		sourceId: input.sourceId,
		profile: `${input.hz}:${bins}`,
		epoch: input.epoch,
		tuningTrust: "commanded",
		centerHz,
		sampleRateHz: SAMPLE_RATE_HZ,
		binHz: lay.binHz,
		nativeBinHz: SAMPLE_RATE_HZ / SPECTRUM_FFT_SIZE,
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
	adjusted: ("hz" | "bins")[]
	explicit: boolean
}

/** Normalises `options.spectrum` like the core: hz 0.5–25 snapped to 0.5, bins 128–2048 rounded. */
export function normaliseSpectrumOptions(
	raw: unknown,
): SpectrumSelection | { ok: false; message: string } {
	if (raw === undefined || raw === null)
		return {
			ok: true,
			sourceId: null,
			hz: SPECTRUM_DEFAULT_HZ,
			bins: SPECTRUM_DEFAULT_BINS,
			adjusted: [],
			explicit: false,
		}
	if (typeof raw !== "object" || Array.isArray(raw))
		return { ok: false, message: "options.spectrum must be an object" }
	const o = raw as Record<string, unknown>
	const sourceId = o["sourceId"]
	if (typeof sourceId !== "string" || sourceId.length === 0)
		return { ok: false, message: "options.spectrum.sourceId is required" }
	const adjusted: ("hz" | "bins")[] = []
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
		bins = Math.min(2048, Math.max(128, Math.round(o["bins"])))
		if (bins !== o["bins"]) adjusted.push("bins")
	}
	return { ok: true, sourceId, hz, bins, adjusted, explicit: true }
}
