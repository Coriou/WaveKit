/**
 * WG11 lane TR: a seeded synthetic block sequence for the frame-track goldens and property 10.
 * Tracks with and without a tracker association (maxTracks), short bursts, a spur comb, an IQ
 * image and an epoch change, driven through the real SpectrumPipeline.
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

/** The rich run: tones, an image pair, bursts, a 7-tooth comb (spur lines) and an epoch change. */
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
	const toothBins = Array.from(
		{ length: 7 },
		(_, k) => N / 2 + (k - 3) * 22 + 7,
	)
	const teethHz = toothBins.map(b => (b - N / 2 + 0.1) * BIN_HZ)
	const teeth = toneComb(
		total,
		FS,
		teethHz,
		teethHz.map(() => toneAmp(22)),
	)
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
	for (const p of [teeth, strong, image, steady, bursts]) addInto(iq, p)
	for (let at = 0; at < total; at += CHUNK) {
		const len = Math.min(CHUNK, total - at)
		h.push(
			{ re: iq.re.subarray(at, at + len), im: iq.im.subarray(at, at + len) },
			8192,
		)
	}
	// Epoch change: a commanded retune (timer settle, zero allowance), then 0.6 s more.
	h.pending({ epoch: 2, centreHz: CENTRE + 1e6 })
	const after = Math.round(0.6 * FS)
	const iq2 = gaussianNoise(mulberry32(seed + 1), after, SIGMA)
	addInto(iq2, tone(after, FS, 33_300, EMISSION_AMP))
	addInto(iq2, ookAt(seed + 2, after, -45_100, [210, 400]))
	h.push(iq2, 8192)
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
