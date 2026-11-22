/**
 * The recording admission reading (speech-content.ts admissionNoise, candidate rule RA-2) on
 * modelled (synthetic) signals through WidebandNfmChain (speech-content-fixtures.ts): open-squelch
 * noise and FM-demodulated 4FSK and GMSK-like data at 4, 8 and 120 s read as noise; speech-like
 * syllables on a quieted carrier are kept with a floor well under the bound, with or without a
 * CTCSS tone; a 2 s word inside or at the tail of 118 s of noise keeps the file. The spliced
 * files join separate chain runs (noise, word, noise) at frame-aligned cuts. A known limit is
 * frozen too: hard speech under the FM threshold (5 dB CNR) reads as noise. Nothing here is a
 * recording of a real signal.
 *
 * The real chain is slow (seconds per signal), so each signal is run once and shared, and each
 * run first yields to the event loop so the worker's RPC to the runner is never starved.
 */
import { describe, expect, it } from "vitest"
import {
	ADMISSION_MAX_SPREAD_DB,
	ADMISSION_MIN_FLOOR_DBFS,
	admissionNoise,
	SPEECH_FRAME_SAMPLES,
	SpeechContentMeter,
	type SpeechContent,
} from "../../../../src/core/scanner/channel/speech-content.js"
import {
	contentAudio,
	HARD_SPEECH_CASES,
	type ContentSignal,
} from "./speech-content-fixtures.js"

const yieldToLoop = (): Promise<void> =>
	new Promise(resolve => {
		setImmediate(resolve)
	})

function measure(pcm: Int16Array, chunk = 4_000): SpeechContent {
	const m = new SpeechContentMeter()
	for (let at = 0; at < pcm.length; at += chunk)
		m.push(pcm.subarray(at, at + chunk))
	return m.result()
}

const audio = new Map<string, Int16Array>()
async function chainAudio(
	signal: ContentSignal,
	seconds: number,
): Promise<Int16Array> {
	const key = JSON.stringify([signal, seconds])
	const hit = audio.get(key)
	if (hit !== undefined) return hit
	await yieldToLoop()
	const pcm = contentAudio(signal, seconds)
	audio.set(key, pcm)
	return pcm
}

const NOISE: ContentSignal = {
	waveform: { kind: "silent" },
	cnrDb: 30,
	carrier: false,
}
const FSK4: ContentSignal = {
	waveform: { kind: "fsk", baud: 4_800, levelsHz: [-1_944, -648, 648, 1_944] },
	cnrDb: 30,
}
const GMSK: ContentSignal = {
	waveform: { kind: "fsk", baud: 4_800, levelsHz: [-1_200, 1_200] },
	cnrDb: 30,
}
const SPEECH: ContentSignal = {
	waveform: { kind: "speech", pauses: "short" },
	cnrDb: 30,
}

/** Samples of `s` seconds at 8 kHz, cut to whole 32 ms frames. */
const at = (s: number): number =>
	Math.floor((s * 8_000) / SPEECH_FRAME_SAMPLES) * SPEECH_FRAME_SAMPLES

describe("admission through the NFM chain (modelled signals)", () => {
	// Feature: recording-admission, candidate rule RA-2 (provisional bounds).
	for (const [name, signal] of [
		["open-squelch noise", NOISE],
		["4FSK at 4 800 Bd", FSK4],
		["GMSK-like 2FSK at 4 800 Bd", GMSK],
	] as const)
		for (const seconds of [4, 8, 120])
			it(`${name}, ${seconds} s: noise`, async () => {
				const c = measure(await chainAudio(signal, seconds))
				expect(c.levelFrames).toBeGreaterThanOrEqual(94)
				expect(c.minWindowP10Dbfs).toBeGreaterThan(ADMISSION_MIN_FLOOR_DBFS + 5)
				expect(c.maxWindowSpreadDb).toBeLessThan(ADMISSION_MAX_SPREAD_DB - 3)
				expect(admissionNoise(c)).toBe(true)
			}, 300_000)

	for (const cnrDb of [12, 30])
		it(`speech-like syllables on a quieted carrier (CNR ${cnrDb} dB): kept, p10 at least 8 dB under the floor`, async () => {
			const c = measure(await chainAudio({ ...SPEECH, cnrDb }, 8))
			expect(c.minWindowP10Dbfs).toBeLessThan(ADMISSION_MIN_FLOOR_DBFS - 8)
			expect(admissionNoise(c)).toBe(false)
		}, 120_000)

	it("speech with a 250 Hz CTCSS tone: kept, the tone does not lift the floor", async () => {
		const c = measure(await chainAudio({ ...SPEECH, ctcssHz: 250 }, 8))
		expect(c.minWindowP10Dbfs).toBeLessThan(ADMISSION_MIN_FLOOR_DBFS - 8)
		expect(admissionNoise(c)).toBe(false)
	}, 120_000)

	it("KNOWN LIMIT: hard speech at 5 dB CNR (1 000 Hz peak, 30 % depth, no pauses) reads as noise", async () => {
		// Frozen so a threshold change that moves it shows here; such a file is discarded only on a
		// channel without proven analog voice (recording-verdict.ts finishPath).
		const hard = HARD_SPEECH_CASES.find(
			c => c.name === "lowdev-1000-shallow-30-continuous-cnr-5",
		)
		expect(hard).toBeDefined()
		const c = measure(await chainAudio(hard!.signal, 4))
		expect(c.levelFrames).toBeGreaterThanOrEqual(94)
		expect(admissionNoise(c)).toBe(true)
	}, 120_000)

	it("118 s of noise with a 2 s word in the middle: kept", async () => {
		const noise = await chainAudio(NOISE, 120)
		const word = (await chainAudio(SPEECH, 2)).subarray(0, at(2))
		const pcm = new Int16Array(noise.length)
		pcm.set(noise.subarray(0, at(59)))
		pcm.set(word, at(59))
		pcm.set(noise.subarray(at(61), noise.length), at(61))
		const c = measure(pcm)
		expect(c.minWindowP10Dbfs).toBeLessThan(ADMISSION_MIN_FLOOR_DBFS)
		expect(admissionNoise(c)).toBe(false)
	}, 300_000)

	it("118 s of noise with a 2 s word at the tail: kept", async () => {
		const noise = await chainAudio(NOISE, 120)
		const word = (await chainAudio(SPEECH, 2)).subarray(0, at(2))
		const pcm = new Int16Array(at(118) + word.length)
		pcm.set(noise.subarray(0, at(118)))
		pcm.set(word, at(118))
		const c = measure(pcm)
		expect(c.minWindowP10Dbfs).toBeLessThan(ADMISSION_MIN_FLOOR_DBFS)
		expect(admissionNoise(c)).toBe(false)
	}, 300_000)
})
