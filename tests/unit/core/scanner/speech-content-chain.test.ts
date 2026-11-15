/**
 * The speech-content measure (speech-content.ts) on synthetic audio through WidebandNfmChain
 * (speech-content-fixtures.ts): speech-like audio, with and without pauses and down to a CNR of
 * 5 dB, is never clearly not speech; FM-demodulated 4FSK, 2FSK, GMSK-like data, an unmodulated
 * carrier and open-squelch noise are; tones are kept by design; a single word or sparse speech on
 * a quiet carrier is never clear noise (its burst), while data and noise stay clear noise.
 *
 * The real chain is slow (seconds per signal), so each signal is run once and its measurement
 * shared by every assertion on it, and each run first yields to the event loop so the worker's
 * RPC to the runner is never starved.
 */
import { describe, expect, it } from "vitest"
import {
	clearlyNoise,
	clearlyNotSpeech,
	SPEECH_FRAME_SAMPLES,
	SPEECH_NOISE_MAX_BURST_FRAMES,
	SPEECH_NOISE_MIN_FRAMES,
	SPEECH_NO_VOICE_LONG_MIN_RANGE_DB,
	SPEECH_NOT_SPEECH_MAX_PERIODIC_SHARE,
	SPEECH_STEADY_MAX_RANGE_DB,
	SpeechContentMeter,
	speechHeard,
	type SpeechContent,
} from "../../../../src/core/scanner/channel/speech-content.js"
import {
	CONTENT_CASES,
	HARD_SPEECH_CASES,
	contentAudio,
	type ContentSignal,
} from "./speech-content-fixtures.js"

const SECONDS = 8

function measure(pcm: Int16Array, chunk = 4_000): SpeechContent {
	const m = new SpeechContentMeter()
	for (let at = 0; at < pcm.length; at += chunk)
		m.push(pcm.subarray(at, at + chunk))
	return m.result()
}

const yieldToLoop = (): Promise<void> =>
	new Promise(resolve => {
		setImmediate(resolve)
	})

/** One chain run per (signal, seconds), shared by every test that measures it. */
const measured = new Map<string, SpeechContent>()
async function measureSignal(
	signal: ContentSignal,
	seconds: number,
): Promise<SpeechContent> {
	const key = JSON.stringify([signal, seconds])
	const hit = measured.get(key)
	if (hit !== undefined) return hit
	await yieldToLoop()
	const r = measure(contentAudio(signal, seconds))
	measured.set(key, r)
	return r
}

describe("speech-content: synthetic signals through the NFM chain", () => {
	// Synthetic validation table of the speech content check (not from a spec).
	for (const c of CONTENT_CASES)
		it(`${c.name}: ${c.speech ? "speech (kept)" : c.kept === true ? "not speech, kept (a disclosed limit)" : "clearly not speech"}`, async () => {
			const r = await measureSignal(c.signal, SECONDS)
			expect(r.frames).toBe(
				Math.floor((SECONDS * 8_000) / SPEECH_FRAME_SAMPLES),
			)
			expect(clearlyNotSpeech(r)).toBe(!c.speech && c.kept !== true)
			if (c.kept === true) return
			if (c.speech)
				// Margin: speech stays well clear of the steady bound.
				expect(r.maxRangeDb).toBeGreaterThan(SPEECH_STEADY_MAX_RANGE_DB + 3)
			else expect(r.maxRangeDb).toBeLessThan(SPEECH_STEADY_MAX_RANGE_DB - 4)
		}, 60_000)

	for (const pauses of ["short", "none"] as const)
		it(`speech at a CNR of 5 dB (${pauses} pauses) is kept`, async () => {
			const r = await measureSignal(
				{ waveform: { kind: "speech", pauses }, cnrDb: 5 },
				SECONDS,
			)
			expect(clearlyNotSpeech(r)).toBe(false)
			expect(r.maxRangeDb).toBeGreaterThan(SPEECH_STEADY_MAX_RANGE_DB + 2)
		}, 60_000)

	// Hard speech (low deviation, shallow syllables, no pauses).
	for (const c of HARD_SPEECH_CASES)
		it(`hard speech ${c.name}: kept, with a margin over the steady bound`, async () => {
			const r = await measureSignal(c.signal, SECONDS)
			expect(clearlyNotSpeech(r)).toBe(false)
			// The hardest synthetic talkers sit 1.4 dB over the bound at 8 s (1.66 dB at the bench's 12 s).
			expect(r.maxRangeDb).toBeGreaterThan(SPEECH_STEADY_MAX_RANGE_DB + 1.25)
			// A long file of a no-voice channel: heard by range alone, with 1.5 dB over its 8 dB bound.
			expect(r.frames).toBeGreaterThanOrEqual(SPEECH_NOISE_MIN_FRAMES)
			expect(r.maxRangeDb).toBeGreaterThan(
				SPEECH_NO_VOICE_LONG_MIN_RANGE_DB + 1.5,
			)
			expect(speechHeard(r)).toBe(true)
		}, 60_000)

	// A long (8 s) file of a no-voice channel (speechHeard's SPEECH_NO_VOICE_LONG_MIN_RANGE_DB):
	// speech is heard, unpitched data and noise are not; 2FSK and TDMA are kept (disclosed).
	for (const c of CONTENT_CASES)
		it(`${c.name} (8 s): speechHeard ${String(c.speech || c.kept === true || c.name === "pager-2fsk-1200")}`, async () => {
			const r = await measureSignal(c.signal, SECONDS)
			expect(r.frames).toBeGreaterThanOrEqual(SPEECH_NOISE_MIN_FRAMES)
			expect(speechHeard(r)).toBe(
				c.speech || c.kept === true || c.name === "pager-2fsk-1200",
			)
		}, 60_000)

	it("a steady tone is kept (periodic), and so is a speech burst after 6 s of data", async () => {
		const tone = await measureSignal(
			{ waveform: { kind: "tone", hz: 1_000 }, cnrDb: 30 },
			SECONDS,
		)
		expect(tone.maxRangeDb).toBeLessThan(SPEECH_STEADY_MAX_RANGE_DB)
		expect(tone.periodicShare).toBeGreaterThan(
			SPEECH_NOT_SPEECH_MAX_PERIODIC_SHARE,
		)
		expect(clearlyNotSpeech(tone)).toBe(false)
		const data: ContentSignal = {
			waveform: {
				kind: "fsk",
				baud: 4_800,
				levelsHz: [-1_944, -648, 648, 1_944],
			},
			cnrDb: 30,
		}
		const speech: ContentSignal = {
			waveform: { kind: "speech", pauses: "short" },
			cnrDb: 30,
		}
		await yieldToLoop()
		const a = contentAudio(data, 6)
		await yieldToLoop()
		const b = contentAudio(speech, 3)
		const both = new Int16Array(a.length + b.length)
		both.set(a)
		both.set(b, a.length)
		expect(clearlyNotSpeech(measure(a))).toBe(true)
		expect(clearlyNotSpeech(measure(both))).toBe(false)
	}, 60_000)
})

describe("speech-content: the burst veto on the NFM chain (clearlyNoise only)", () => {
	// Synthetic words on a quiet carrier the range and periodic bounds alone call noise (the bench's
	// `--burst` table): each is kept by its burst.
	for (const cnrDb of [10, 20])
		for (const wordS of [0.3, 0.4, 0.5])
			it(`a ${wordS} s word in 8 s of quiet carrier at a CNR of ${cnrDb} dB is never clear noise`, async () => {
				const r = await measureSignal(
					{
						waveform: { kind: "speech", pauses: "none", wordAtS: 4, wordS },
						cnrDb,
					},
					8,
				)
				expect(r.frames).toBeGreaterThanOrEqual(SPEECH_NOISE_MIN_FRAMES)
				expect(r.maxBurstFrames).toBeGreaterThanOrEqual(
					SPEECH_NOISE_MAX_BURST_FRAMES + 1,
				)
				expect(clearlyNoise(r)).toBe(false)
			}, 60_000)

	it("sparse speech (four 0.3 to 0.4 s words over 10 s) at a CNR of 10 dB is never clear noise", async () => {
		const r = await measureSignal(
			{
				waveform: {
					kind: "speech",
					pauses: "none",
					words: [
						[1, 0.35],
						[4, 0.3],
						[7.5, 0.4],
						[10.6, 0.3],
					],
				},
				cnrDb: 10,
			},
			12,
		)
		expect(r.maxBurstFrames).toBeGreaterThanOrEqual(
			SPEECH_NOISE_MAX_BURST_FRAMES + 1,
		)
		expect(clearlyNoise(r)).toBe(false)
	}, 60_000)

	// Data and noise the strict bounds catch stay caught: no burst.
	for (const c of CONTENT_CASES.filter(
		c => !c.speech && c.kept !== true && c.name !== "pager-2fsk-1200",
	))
		it(`${c.name}: still clear noise (no burst)`, async () => {
			const r = await measureSignal(c.signal, 8)
			expect(r.maxBurstFrames).toBeLessThan(SPEECH_NOISE_MAX_BURST_FRAMES)
			expect(clearlyNoise(r)).toBe(true)
		}, 60_000)

	it("an unmodulated carrier at a CNR of 10 dB: still clear noise", async () => {
		const r = await measureSignal(
			{ waveform: { kind: "silent" }, cnrDb: 10 },
			8,
		)
		expect(r.maxBurstFrames).toBeLessThan(SPEECH_NOISE_MAX_BURST_FRAMES)
		expect(clearlyNoise(r)).toBe(true)
	}, 60_000)
})

describe("speechHeard: a short file of a no-voice channel must show speech (any length)", () => {
	// Feature: recording-verdict, channels whose trials never heard voice (docs/SCANNER.md).
	/** The first `seconds` of one 3 s chain run of `signal` (an over starts with its voice). */
	async function heard(
		signal: ContentSignal,
		seconds: number,
	): Promise<boolean> {
		const pcm = await pcmOf(signal)
		const n =
			Math.round((seconds * 8_000) / SPEECH_FRAME_SAMPLES) *
			SPEECH_FRAME_SAMPLES
		return speechHeard(measure(pcm.subarray(0, n)))
	}
	const runs = new Map<string, Int16Array>()
	async function pcmOf(signal: ContentSignal): Promise<Int16Array> {
		const key = JSON.stringify(signal)
		const hit = runs.get(key)
		if (hit !== undefined) return hit
		await yieldToLoop()
		const pcm = contentAudio(signal, 3)
		runs.set(key, pcm)
		return pcm
	}
	it("hard speech (HARD_SPEECH_CASES, CNR 5 to 10 dB): heard at 1.5 and 3 s", async () => {
		for (const c of HARD_SPEECH_CASES)
			for (const seconds of [1.5, 3])
				expect(await heard(c.signal, seconds), `${c.name} ${seconds} s`).toBe(
					true,
				)
	}, 600_000)
	it("plain speech at a CNR of 5 dB or more: heard from 1 s", async () => {
		for (const cnrDb of [5, 6, 10, 30])
			for (const pauses of ["short", "none"] as const)
				for (const seconds of [1, 2, 3])
					expect(
						await heard(
							{ waveform: { kind: "speech", pauses }, cnrDb },
							seconds,
						),
						`${pauses} ${cnrDb} dB ${seconds} s`,
					).toBe(true)
	}, 600_000)
	it("a single 0.3 to 0.5 s word on a quiet carrier, and sparse words: heard by their burst", async () => {
		for (const cnrDb of [6, 10, 20, 30]) {
			for (const wordS of [0.3, 0.5])
				expect(
					await heard(
						{
							waveform: { kind: "speech", pauses: "none", wordAtS: 0.3, wordS },
							cnrDb,
						},
						2,
					),
					`word ${wordS} s ${cnrDb} dB`,
				).toBe(true)
			expect(
				await heard(
					{
						waveform: {
							kind: "speech",
							pauses: "none",
							words: [
								[0.2, 0.3],
								[1.2, 0.4],
								[2.2, 0.35],
							],
						},
						cnrDb,
					},
					3,
				),
				`sparse ${cnrDb} dB`,
			).toBe(true)
		}
	}, 600_000)
	it("open-squelch noise, an unmodulated carrier and 4FSK: not heard (1.5 and 3 s)", async () => {
		const quiet: [string, ContentSignal][] = [
			...[3, 9, 11].map(
				seed =>
					[
						`noise seed ${seed}`,
						{
							waveform: { kind: "silent" },
							cnrDb: 30,
							carrier: false,
							seed,
						},
					] as [string, ContentSignal],
			),
			["carrier 10 dB", { waveform: { kind: "silent" }, cnrDb: 10 }],
			["carrier 30 dB", { waveform: { kind: "silent" }, cnrDb: 30 }],
			[
				"4FSK 20 dB",
				{
					waveform: {
						kind: "fsk",
						baud: 4_800,
						levelsHz: [-1_944, -648, 648, 1_944],
					},
					cnrDb: 20,
				},
			],
		]
		for (const [name, signal] of quiet)
			for (const seconds of [1.5, 3])
				expect(await heard(signal, seconds), `${name} ${seconds} s`).toBe(false)
	}, 600_000)
	it("under 16 frames (0.512 s): nothing measured, not heard", () => {
		const m = new SpeechContentMeter()
		m.push(new Int16Array(15 * SPEECH_FRAME_SAMPLES))
		expect(speechHeard(m.result())).toBe(false)
	})
})
