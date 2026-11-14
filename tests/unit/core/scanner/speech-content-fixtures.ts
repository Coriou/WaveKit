/**
 * Synthetic signals for the speech-content measure (speech-content.ts): phase-continuous FM of a
 * deviation waveform at an offset inside a 96 kS/s CU8 stream, with Gaussian IQ noise set by a
 * carrier-to-noise ratio in a 12.5 kHz channel, demodulated by WidebandNfmChain to the recorder's
 * 8 kHz audio. Deterministic (mulberry32). Nothing here is a recording of a real signal.
 *
 * Waveforms (deviation in Hz at time t s):
 * - speech: 4 Hz syllables E(t) = (1 − cos 2π·4t) / 2; two syllables in three voiced (harmonics
 *   1 to 24 of a 105 to 145 Hz pitch gliding per syllable, a formant-like weighting peaking near
 *   500 and 1 500 Hz), the third unvoiced (noise); 2 400 Hz peak (`peakHz`), the envelope at full
 *   depth (`depth` d: E′ = 1 − d·(1 + cos 2π·4t) / 2). `pauses`: "short", 300 ms of
 *   silence every 1.7 s; "long", 1.2 s of speech then 2.5 s of silence; "none", no pause.
 * - fsk: random symbols at `baud` over `levelsHz`; `tdma` keys it 30 ms on, 30 ms off (a DMR
 *   mobile's slot), the carrier staying on.
 * - tone: a sine at `hz`, 2 400 Hz peak.
 * - silent: no modulation (an unmodulated carrier).
 * A source with `carrier: false` sends noise only (an open squelch).
 */
import { mulberry32 } from "../../../mocks/scanner/signals.js"
import { WidebandNfmChain } from "../../../../src/core/scanner/channel/wideband-nfm.js"

export const CONTENT_FS = 96_000
export const CONTENT_OFFSET_HZ = 20_000
const TWO_PI = 2 * Math.PI

interface SpeechWave {
	readonly kind: "speech"
	readonly pauses: "short" | "long" | "none"
	/** Peak deviation (Hz); default 2 400. A quiet talker or a low-deviation radio: 1 000 to 1 500. */
	readonly peakHz?: number
	/**
	 * Syllable envelope depth (0..1); default 1. The envelope swings from 1 − depth to 1: a
	 * compressed or shallow talker, 0.3 to 0.5.
	 */
	readonly depth?: number
	/**
	 * A single word: speech only from `wordAtS` for `wordS` seconds (0.3 to 0.5), an unmodulated
	 * carrier before and after it (the carrier tail before the squelch closes).
	 */
	readonly wordAtS?: number
	readonly wordS?: number
	/**
	 * Sparse speech: speech only inside these [start s, length s] words, an unmodulated carrier
	 * between them ("uh… yes… ok" on a quiet carrier).
	 */
	readonly words?: readonly (readonly [number, number])[]
}
interface FskWave {
	readonly kind: "fsk"
	readonly baud: number
	readonly levelsHz: readonly number[]
	readonly tdma?: boolean
}
export type Waveform =
	| SpeechWave
	| FskWave
	| { readonly kind: "tone"; readonly hz: number }
	| { readonly kind: "silent" }

export interface ContentSignal {
	readonly waveform: Waveform
	/** Carrier-to-noise ratio in 12.5 kHz (dB). */
	readonly cnrDb: number
	/** Default true; false: noise only. */
	readonly carrier?: boolean
	readonly seed?: number
}

const AMP = 0.4

/** The pitch (Hz) and voicing of syllable `k` of a speech waveform. */
function syllable(k: number): { pitch: number; voiced: boolean } {
	return { pitch: 105 + ((k * 37) % 41), voiced: k % 3 !== 2 }
}

function formant(hz: number): number {
	const peak = (f: number, w: number): number =>
		Math.exp(-(((hz - f) / w) ** 2))
	return 0.15 + peak(500, 300) + 0.6 * peak(1_500, 500)
}

/** Deviation sources: one call per input sample, in order. */
function deviation(w: Waveform, fs: number, rng: () => number): () => number {
	let n = 0
	let symbol = -1
	let level = 0
	return () => {
		const t = n++ / fs
		switch (w.kind) {
			case "silent":
				return 0
			case "tone":
				return 2_400 * Math.sin(TWO_PI * w.hz * t)
			case "fsk": {
				const s = Math.floor(t * w.baud)
				if (s !== symbol) {
					symbol = s
					level = w.levelsHz[Math.floor(rng() * w.levelsHz.length)] ?? 0
				}
				return w.tdma === true && t % 0.06 >= 0.03 ? 0 : level
			}
			case "speech": {
				if (
					w.wordS !== undefined &&
					(t < (w.wordAtS ?? 0) || t >= (w.wordAtS ?? 0) + w.wordS)
				)
					return 0
				if (
					w.words !== undefined &&
					!w.words.some(([at, len]) => t >= at && t < at + len)
				)
					return 0
				const quiet =
					w.pauses === "short"
						? t % 1.7 > 1.4
						: w.pauses === "long"
							? t % 3.7 > 1.2
							: false
				if (quiet) return 0
				const depth = w.depth ?? 1
				const peak = (w.peakHz ?? 2_400) / 2_400
				const e = peak * (1 - (depth * (1 + Math.cos(TWO_PI * 4 * t))) / 2)
				const s = syllable(Math.floor(t * 4))
				if (!s.voiced) return 1_600 * e * (2 * rng() - 1)
				let v = 0
				let norm = 0
				for (let h = 1; h <= 24; h++) {
					const f = s.pitch * h * (1 + 0.04 * ((t * 4) % 1))
					if (f > 3_400) break
					const a = formant(f)
					v += a * Math.sin(TWO_PI * f * t)
					norm += a
				}
				return (2_400 * e * v) / Math.max(1, norm / 2)
			}
		}
	}
}

/** `seconds` of `signal` as the recorder's 8 kHz audio (WidebandNfmChain, JS path). */
export function contentAudio(
	signal: ContentSignal,
	seconds: number,
): Int16Array {
	const fs = CONTENT_FS
	const rng = mulberry32(signal.seed ?? 5)
	const noise = mulberry32((signal.seed ?? 5) + 1)
	const sigma = AMP / Math.sqrt(2 * (12_500 / fs) * 10 ** (signal.cnrDb / 10))
	const dev = deviation(signal.waveform, fs, rng)
	const chain = new WidebandNfmChain({
		inputRateHz: fs,
		offsetHz: CONTENT_OFFSET_HZ,
	})
	const gauss = (): number => {
		// Box–Muller.
		const u = Math.max(1e-12, noise())
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * noise())
	}
	const parts: Int16Array[] = []
	let phase = 0
	const total = Math.round(seconds * fs)
	const slice = 9_600
	for (let at = 0; at < total; at += slice) {
		const n = Math.min(slice, total - at)
		const cu8 = new Uint8Array(2 * n)
		for (let i = 0; i < n; i++) {
			let re = sigma * gauss()
			let im = sigma * gauss()
			if (signal.carrier !== false) {
				phase = (phase + (TWO_PI * (CONTENT_OFFSET_HZ + dev())) / fs) % TWO_PI
				re += AMP * Math.cos(phase)
				im += AMP * Math.sin(phase)
			}
			cu8[2 * i] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * re)))
			cu8[2 * i + 1] = Math.max(
				0,
				Math.min(255, Math.round(127.5 + 127.5 * im)),
			)
		}
		parts.push(chain.process(cu8))
	}
	const out = new Int16Array(parts.reduce((s, p) => s + p.length, 0))
	let o = 0
	for (const p of parts) {
		out.set(p, o)
		o += p.length
	}
	return out
}

/** The named synthetic cases the tests and the bench share (cnrDb 30 unless named). */
export const CONTENT_CASES: readonly {
	readonly name: string
	readonly signal: ContentSignal
	readonly speech: boolean
	/** Not speech, but the measure keeps it (a disclosed limit of speech-content.ts). */
	readonly kept?: boolean
}[] = [
	{
		name: "speech",
		signal: { waveform: { kind: "speech", pauses: "short" }, cnrDb: 30 },
		speech: true,
	},
	{
		name: "speech-no-pause",
		signal: { waveform: { kind: "speech", pauses: "none" }, cnrDb: 30 },
		speech: true,
	},
	{
		name: "speech-long-pauses",
		signal: { waveform: { kind: "speech", pauses: "long" }, cnrDb: 30 },
		speech: true,
	},
	{
		name: "speech-cnr-12",
		signal: { waveform: { kind: "speech", pauses: "short" }, cnrDb: 12 },
		speech: true,
	},
	{
		name: "speech-cnr-9",
		signal: { waveform: { kind: "speech", pauses: "short" }, cnrDb: 9 },
		speech: true,
	},
	{
		name: "speech-no-pause-cnr-9",
		signal: { waveform: { kind: "speech", pauses: "none" }, cnrDb: 9 },
		speech: true,
	},
	{
		name: "dmr-4fsk",
		signal: {
			waveform: {
				kind: "fsk",
				baud: 4_800,
				levelsHz: [-1_944, -648, 648, 1_944],
			},
			cnrDb: 30,
		},
		speech: false,
	},
	{
		name: "dmr-tdma",
		signal: {
			waveform: {
				kind: "fsk",
				baud: 4_800,
				levelsHz: [-1_944, -648, 648, 1_944],
				tdma: true,
			},
			cnrDb: 30,
		},
		speech: false,
		kept: true,
	},
	{
		name: "pager-2fsk-1200",
		signal: {
			waveform: { kind: "fsk", baud: 1_200, levelsHz: [-4_500, 4_500] },
			cnrDb: 30,
		},
		speech: false,
	},
	{
		name: "pager-2fsk-512",
		signal: {
			waveform: { kind: "fsk", baud: 512, levelsHz: [-4_500, 4_500] },
			cnrDb: 30,
		},
		speech: false,
		kept: true,
	},
	{
		name: "gmsk-like-4800",
		signal: {
			waveform: { kind: "fsk", baud: 4_800, levelsHz: [-1_200, 1_200] },
			cnrDb: 30,
		},
		speech: false,
	},
	{
		name: "noise-open-squelch",
		signal: { waveform: { kind: "silent" }, cnrDb: 30, carrier: false },
		speech: false,
	},
]

/**
 * Hard speech (M3): low deviation (1 000 or 1 500 Hz peak), a shallow syllable envelope (30 or
 * 50 % depth), no pauses, and their combinations, each at a CNR of 5, 6, 8 and 10 dB: all speech.
 */
export const HARD_SPEECH_WAVES: readonly (readonly [
	string,
	Omit<SpeechWave, "kind">,
])[] = [
	["lowdev-1000", { pauses: "short", peakHz: 1_000 }],
	["lowdev-1500", { pauses: "short", peakHz: 1_500 }],
	["shallow-30", { pauses: "short", depth: 0.3 }],
	["shallow-50", { pauses: "short", depth: 0.5 }],
	["continuous", { pauses: "none" }],
	[
		"lowdev-1000-shallow-30-continuous",
		{ pauses: "none", peakHz: 1_000, depth: 0.3 },
	],
	[
		"lowdev-1500-shallow-50-continuous",
		{ pauses: "none", peakHz: 1_500, depth: 0.5 },
	],
]

export const HARD_SPEECH_CASES: readonly {
	readonly name: string
	readonly signal: ContentSignal
}[] = HARD_SPEECH_WAVES.flatMap(([name, w]) =>
	[5, 6, 8, 10].map(cnrDb => ({
		name: `${name}-cnr-${cnrDb}`,
		signal: { waveform: { kind: "speech" as const, ...w }, cnrDb },
	})),
)
