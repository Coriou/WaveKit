/**
 * WG11 lane TR: a seeded synthetic block sequence for the frame-track goldens and property 10.
 * Tracks with and without a tracker association (maxTracks), short bursts, a receiver comb, an IQ
 * image and two epoch changes, driven through the real SpectrumPipeline.
 */
import { createHash } from "node:crypto"
import type {
	BlockSummary,
	PipelineConfig,
	PipelineEvent,
} from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	ookBursts,
	tone,
	toneComb,
	zerosIq,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import { BIN_HZ, CENTRE, FS, Harness, N } from "./pipeline-harness.js"

const SIGMA = 0.005
const NOISE_BIN_POWER = (SIGMA * SIGMA * 1.5) / N
const toneAmp = (perBinSnrDb: number): number =>
	Math.sqrt(NOISE_BIN_POWER * 10 ** (perBinSnrDb / 10))
/** 20 dB in 12.5 kHz (the pipeline tests' SNR convention). */
const EMISSION_AMP = Math.sqrt((SIGMA * SIGMA * 12_500 * 100) / FS)
const CHUNK = FS / 4

export interface Scenario {
	harness: Harness
	summaries: BlockSummary[]
}

/** Called after every pipeline input with that input's events (≤ 1 block per input: chunks < BLOCK). */
export type Observe = (h: Harness, events: PipelineEvent[]) => void

function observed(h: Harness, observe: Observe | undefined): Harness {
	if (!observe) return h
	const send = h.send.bind(h)
	h.send = input => {
		const events = send(input)
		observe(h, events)
		return events
	}
	return h
}

function ookAt(seed: number, n: number, offsetHz: number, ms: number[]): Iq {
	return ookBursts(mulberry32(seed), n, FS, offsetHz, EMISSION_AMP * 4, {
		bursts: ms.map(startMs => ({ startMs, durationMs: 5 })),
	})
}

/**
 * The receiver comb: lines at fixed baseband bins (spacing 10, the teeth under the emitters'
 * slots missing), present under every centre. 10 dB per bin over the noise puts a line's
 * 12.5 kHz slot level near +3.3 dB ((13 + 1.5 × 10) / 13 with the Hann skirt), under the
 * 6 dB bound, and each tooth is ≥ 7 bins (half a 13-bin slot + its skirt) from every emitter,
 * so its slot stays quiet. Verified at the close of epoch 2 (two credited centres 1 MHz apart),
 * it masks in epoch 3.
 */
export const COMB_BINS = [36, 46, 56, 136, 146, 216] as const
const COMB_PER_BIN_SNR_DB = 10
/** Epoch 2 and 3: a stale discard (≤ 1 s, STALE_MAX_MS) of the comb, then 0.6 s accepted. */
const LATER_EPOCH_S = 1.6

/** A tooth's baseband offset: 0.1 bin off centre, so its Hann skirt is uneven as a real line's. */
const combHz = (bin: number): number => (bin - N / 2 + 0.1) * BIN_HZ

function comb(n: number, at: number): Iq {
	const hz = COMB_BINS.map(combHz)
	return toneComb(
		n,
		FS,
		hz,
		hz.map(() => toneAmp(COMB_PER_BIN_SNR_DB)),
		at,
	)
}

/**
 * The rich run: tones, an image pair, bursts, a receiver comb (spur lines) and three epochs.
 * Epoch 2 (1 MHz up) and epoch 3 (2 MHz up) are commanded retunes: their first blocks are
 * stale-discarded while the previous centre's comb tracks sit at the same baseband bins.
 */
export function richScenario(
	seed = 20_261_017,
	over: Partial<PipelineConfig> = {},
	observe?: Observe,
): Scenario {
	const h = observed(
		new Harness(
			{ format: "FLOAT32LE", ...over },
			{ provisionalWindowMs: 1_000 },
		),
		observe,
	)
	h.start()
	const total = Math.round(2.5 * FS)
	const rng = mulberry32(seed)
	const strong = tone(total, FS, 60_500, EMISSION_AMP * 30)
	const image = tone(total, FS, -60_500, EMISSION_AMP * 30 * 10 ** (-30 / 20))
	const steady = zerosIq(total)
	addInto(
		steady,
		tone(total - FS / 5, FS, 33_300, EMISSION_AMP),
		Math.round(FS / 5),
	)
	const bursts = ookAt(seed, total, -33_300, [700, 1_310, 1_930])
	const iq = gaussianNoise(rng, total, SIGMA)
	for (const p of [comb(total, 0), strong, image, steady, bursts])
		addInto(iq, p)
	for (let at = 0; at < total; at += CHUNK) {
		const len = Math.min(CHUNK, total - at)
		h.push(
			{ re: iq.re.subarray(at, at + len), im: iq.im.subarray(at, at + len) },
			8192,
		)
	}
	// Epoch 2: a commanded retune (timer settle, zero allowance).
	const after = Math.round(LATER_EPOCH_S * FS)
	h.pending({ epoch: 2, centreHz: CENTRE + 1e6 })
	const iq2 = gaussianNoise(mulberry32(seed + 1), after, SIGMA)
	addInto(iq2, comb(after, total))
	addInto(iq2, tone(after, FS, 33_300, EMISSION_AMP))
	addInto(iq2, ookAt(seed + 2, after, -45_100, [1_210, 1_400]))
	h.push(iq2, 8192)
	// Epoch 3: the comb is verified after the first accepted block and masks from the next, so
	// its open tracks turn spur tracks; bursts on a tooth while those tracks hang join them.
	h.pending({ epoch: 3, centreHz: CENTRE + 2e6 })
	const iq3 = gaussianNoise(mulberry32(seed + 3), after, SIGMA)
	addInto(iq3, comb(after, total + after))
	addInto(iq3, tone(after, FS, 62_500, EMISSION_AMP))
	addInto(iq3, ookAt(seed + 4, after, combHz(146), [1_160, 1_310]))
	h.push(iq3, 8192)
	return { harness: h, summaries: h.of("block-summary").map(e => e.summary) }
}

/** maxTracks 1 with two emitters: the weaker one's segments are never associated. */
export function untrackedScenario(seed = 7_771, observe?: Observe): Scenario {
	const h = observed(
		new Harness({ format: "FLOAT32LE", maxTracks: 1 }),
		observe,
	)
	h.start()
	const total = Math.round(1.2 * FS)
	const iq = gaussianNoise(mulberry32(seed), total, SIGMA)
	addInto(iq, tone(total, FS, 25_100, EMISSION_AMP * 3))
	addInto(iq, tone(total, FS, -51_700, EMISSION_AMP))
	h.push(iq, 8192)
	return { harness: h, summaries: h.of("block-summary").map(e => e.summary) }
}

const WG11_TRACK_FIELDS = [
	"trackId",
	"snrDb",
	"peakDbfs",
	"blocks",
	"ageMs",
	"surfaced",
	"trackerId",
	"scanner",
] as const

/** A deep copy of `value` with every WG11 frame-track field removed (key order otherwise kept). */
export function stripTrackFields<T>(value: T): T {
	const copy = JSON.parse(JSON.stringify(value)) as unknown
	const visit = (v: unknown): void => {
		if (Array.isArray(v)) {
			for (const x of v) visit(x)
			return
		}
		if (typeof v !== "object" || v === null) return
		const o = v as Record<string, unknown>
		const tracks = o["tracks"]
		if (Array.isArray(tracks))
			for (const t of tracks as Record<string, unknown>[]) {
				for (const k of WG11_TRACK_FIELDS) delete t[k]
				const flags = t["flags"] as Record<string, unknown> | undefined
				if (flags) delete flags["spur"]
			}
		for (const x of Object.values(o)) visit(x)
	}
	visit(copy)
	return copy as T
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}
