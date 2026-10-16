import { describe, expect, it } from "vitest"
import { CTCSS_HZ } from "../../../../src/core/audio-tones/ctcss.js"
import { DcsDecoder } from "../../../../src/core/audio-tones/dcs.js"
import {
	ctcssTone,
	DCS_RATE_HZ,
	dcsAudio,
	dtmfAudio,
	mixInto,
	pinkNoise,
	speechLike,
	whiteNoise,
} from "./dcs-synth.js"

/**
 * No-DCS false-alarm corpora, generated from seeds in 6 s segments. The default run is 120 s per
 * corpus (10 minutes total); WAVEKIT_DCS_LONG=1 runs 600 s per corpus (50 minutes total).
 * One decoder per corpus runs continuously; result() is polled every 0.5 s and a confirmed
 * reading is counted and the decoder reset.
 */
const LONG = process.env["WAVEKIT_DCS_LONG"] === "1"
const SECONDS_PER_CORPUS = LONG ? 600 : 120
const SEGMENT_SECONDS = 6
const BENCH = process.env["WAVEKIT_DCS_BENCH"] === "1"

type Corpus = (segment: number, seconds: number) => Float64Array

const CORPORA: Record<string, Corpus> = {
	"speech-like": (s, seconds) => {
		const level = 0.1 + ((s * 37) % 10) / 10
		const audio = speechLike({ seconds, seed: 10_000 + s, amplitude: level })
		return mixInto(
			audio,
			pinkNoise({ seconds, seed: 20_000 + s, std: level / 10 }),
		)
	},
	white: (s, seconds) =>
		whiteNoise({ seconds, seed: 30_000 + s, std: 0.05 + (s % 5) * 0.1 }),
	pink: (s, seconds) =>
		pinkNoise({ seconds, seed: 40_000 + s, std: 0.05 + (s % 5) * 0.1 }),
	"ctcss-only": (s, seconds) => {
		const hz = CTCSS_HZ[s % CTCSS_HZ.length] ?? 67
		const audio = ctcssTone({ hz, seconds, seed: 50_000 + s, amplitude: 0.15 })
		return mixInto(audio, whiteNoise({ seconds, seed: 60_000 + s, std: 0.01 }))
	},
	"dtmf-only": (s, seconds) =>
		mixInto(
			dtmfAudio({ seconds, seed: 70_000 + s }),
			whiteNoise({ seconds, seed: 80_000 + s, std: 0.01 }),
		),
}

function falseAlarms(corpus: Corpus, seconds: number): number {
	const decoder = new DcsDecoder()
	const poll = DCS_RATE_HZ / 2
	let hits = 0
	let since = 0
	for (let s = 0; s * SEGMENT_SECONDS < seconds; s++) {
		const audio = corpus(s, SEGMENT_SECONDS)
		for (let i = 0; i < audio.length; i++) {
			decoder.pushSample(audio[i] ?? 0)
			if (++since < poll) continue
			since = 0
			if (decoder.result() === null) continue
			hits += 1
			decoder.reset()
		}
	}
	if (decoder.result() !== null) hits += 1
	return hits
}

describe(`DCS false alarms (${SECONDS_PER_CORPUS} s per corpus)`, () => {
	for (const [name, corpus] of Object.entries(CORPORA)) {
		it(
			`${name}: no code`,
			() => {
				const hits = falseAlarms(corpus, SECONDS_PER_CORPUS)
				process.stderr.write(
					`DCS_FALSE_ALARMS ${JSON.stringify({ corpus: name, seconds: SECONDS_PER_CORPUS, hits })}\n`,
				)
				expect(hits).toBe(0)
			},
			LONG ? 600_000 : 10_000,
		)
	}
})

/** Boxcar-then-pick decimation 48 kHz → 8 kHz (benchmark input only). */
function decimate6(x: Float64Array): Float64Array {
	const out = new Float64Array(Math.floor(x.length / 6))
	for (let i = 0; i < out.length; i++) {
		let sum = 0
		for (let k = 0; k < 6; k++) sum += x[i * 6 + k] ?? 0
		out[i] = sum / 6
	}
	return out
}

describe.skipIf(!BENCH)("DCS benchmark (WAVEKIT_DCS_BENCH=1)", () => {
	it("60 s of 48 kHz audio decimated to 8 kHz, DCS stage alone, median of 3", () => {
		const rate = 48_000
		const seconds = 60
		const audio = dcsAudio({
			code: 0o23,
			seconds,
			seed: 9,
			rate,
			amplitude: 0.12,
		})
		mixInto(audio, speechLike({ seconds, seed: 9, rate, amplitude: 0.5 }))
		mixInto(audio, whiteNoise({ seconds, seed: 9, rate, std: 0.02 }))
		const pcm = decimate6(audio)
		const runs: number[] = []
		let reading = ""
		for (let r = 0; r < 3; r++) {
			const decoder = new DcsDecoder()
			const start = process.cpuUsage()
			for (let i = 0; i < pcm.length; i++) decoder.pushSample(pcm[i] ?? 0)
			const used = process.cpuUsage(start)
			runs.push((used.user + used.system) / 1_000)
			reading = JSON.stringify(decoder.result())
		}
		runs.sort((a, b) => a - b)
		const median = runs[1] ?? 0
		process.stderr.write(
			`DCS_BENCH ${JSON.stringify({ runsMs: runs, medianMs: median, msPerAudioSecond: median / seconds, reading })}\n`,
		)
		expect(reading).toBe(JSON.stringify({ code: "023", polarity: "normal" }))
	}, 120_000)
})
