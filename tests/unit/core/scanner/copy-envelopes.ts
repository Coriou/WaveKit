/**
 * MODELLED frame-level envelopes for the copy-detection unit tests (no audio, no chain): a seeded
 * speech-like band level per 32 ms frame (syllables of 3 to 11 frames at 60 to 75 dB, pauses of
 * 0 to 19 frames near 33 dB, about 70 % of syllables voiced), and a "heard again" copy of one
 * (another gain, independent per-frame noise, a few voicing flips). Nothing here is a recording.
 */
import { mulberry32 } from "../../../mocks/scanner/signals.js"
import {
	COPY_MAX_FRAMES,
	envelopeByte,
	type CopyEnvelope,
} from "../../../../src/core/scanner/channel/copy-fingerprint.js"
import type { CopyFingerprint } from "../../../../src/core/scanner/channel/copy-detector.js"
import type {
	IntermodEvidence,
	RasterFit,
} from "../../../../src/core/scanner/channel/copy-intermod.js"

/** A made-up input rate: 96 kS/s, 3 072 input samples per frame. */
export const ENV_RATE = 96_000
export const ENV_SPF = 3_072

function gauss(rng: () => number): number {
	const u = Math.max(1e-12, rng())
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

/** A voice's band level per frame (dB) and voicing, `frames` long. */
export function frameVoice(
	seed: number,
	frames: number,
): { level: Float64Array; voiced: Uint8Array } {
	const rng = mulberry32(seed)
	const level = new Float64Array(frames)
	const voiced = new Uint8Array(frames)
	let k = 0
	while (k < frames) {
		const len = 3 + Math.floor(rng() * 9)
		const v = 60 + rng() * 15
		const isVoiced = rng() < 0.7
		for (let i = 0; i < len && k < frames; i++, k++) {
			level[k] = v - (4 * Math.abs(i - len / 2)) / len + 0.8 * gauss(rng)
			voiced[k] = isVoiced ? 1 : 0
		}
		const pause = Math.floor(rng() * 20)
		for (let i = 0; i < pause && k < frames; i++, k++) {
			level[k] = 33 + 0.7 * gauss(rng)
			voiced[k] = 0
		}
	}
	return { level, voiced }
}

/** The envelope of levels (bytes) and voicing (bits); `exclude` frames read 0. */
export function envelopeFrom(
	level: Float64Array,
	voiced: Uint8Array,
	exclude: (k: number) => boolean = () => false,
): CopyEnvelope {
	const frames = Math.min(level.length, COPY_MAX_FRAMES)
	const env = new Uint8Array(COPY_MAX_FRAMES)
	const bits = new Uint8Array(Math.ceil(COPY_MAX_FRAMES / 8))
	for (let k = 0; k < frames; k++) {
		env[k] = exclude(k) ? 0 : envelopeByte(level[k]!)
		if (voiced[k] === 1) bits[k >> 3] = bits[k >> 3]! | (1 << (k & 7))
	}
	return { env, voiced: bits, frames }
}

/** A copy of a voice: `gainDb` lower, independent noise of `noiseDb` rms, 5 % voicing flips. */
export function heardAgain(
	voice: { level: Float64Array; voiced: Uint8Array },
	seed: number,
	gainDb = -20,
	noiseDb = 1.5,
): { level: Float64Array; voiced: Uint8Array } {
	const rng = mulberry32(seed)
	const level = new Float64Array(voice.level.length)
	const voiced = new Uint8Array(voice.level.length)
	for (let k = 0; k < level.length; k++) {
		level[k] = Math.max(1, voice.level[k]! + gainDb + noiseDb * gauss(rng))
		voiced[k] = rng() < 0.05 ? 1 - voice.voiced[k]! : voice.voiced[k]!
	}
	return { level, voiced }
}

/** Frames [from, from + n) of a voice. */
export function slice(
	voice: { level: Float64Array; voiced: Uint8Array },
	from: number,
	n: number,
): { level: Float64Array; voiced: Uint8Array } {
	return {
		level: voice.level.slice(from, from + n),
		voiced: voice.voiced.slice(from, from + n),
	}
}

let nextOp = 0
/** A made-up operation id (uuid shape). */
export function opId(): string {
	nextOp++
	return `00000000-0000-4000-8000-${nextOp.toString(16).padStart(12, "0")}`
}

/** A fingerprint of `voice` placed at frame `atFrame` of the shared clock. */
export function fingerprint(
	voice: { level: Float64Array; voiced: Uint8Array },
	o: {
		atFrame?: number
		snrDb?: number
		hz?: number
		raster?: RasterFit
		intermod?: IntermodEvidence | null
		operationId?: string
		sourceId?: string
		epoch?: number
	} = {},
): CopyFingerprint {
	const e = envelopeFrom(voice.level, voice.voiced)
	return {
		...e,
		operationId: o.operationId ?? opId(),
		sourceId: o.sourceId ?? "src-a",
		epoch: o.epoch ?? 1,
		rateHz: ENV_RATE,
		hz: o.hz ?? 1_000_000,
		snrDb: o.snrDb ?? 30,
		raster: o.raster ?? "on",
		intermod: o.intermod ?? null,
		startSample: (o.atFrame ?? 0) * ENV_SPF,
		samplesPerFrame: ENV_SPF,
	}
}

export const IM3: IntermodEvidence = {
	rule: "2f1-f2",
	parents: [{ hz: 1_050_000 }, { hz: 1_100_000 }],
}
