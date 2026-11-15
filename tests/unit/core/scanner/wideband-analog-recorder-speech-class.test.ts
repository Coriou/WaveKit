/**
 * The recorder's second own-audio class, next to the tone (WidebandAnalogRecorder.classBySpeech,
 * docs/SCANNER.md "Own-audio class"): an untoned voiced shadow whose spectrum reads carrier is
 * classed when the file so far reads strong speech (speech-content.ts strongSpeech) on a channel
 * whose analog trials heard voice (recording-verdict.ts trialsVoiceChannel), with no strong prior
 * and no digital spectral class; each file is checked again over the whole file at its finish.
 * Every signal is synthetic; trial counts are illustrative.
 */
import { describe, expect, it } from "vitest"
import {
	trialsVoiceChannel,
	VOICE_CHANNEL_MIN_HEARD,
	VOICE_CHANNEL_MIN_HEARD_PERCENT,
	type VoicePrior,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	SPEECH_STRONG_MIN_PERIODIC_SHARE,
	SPEECH_STRONG_MIN_RANGE_DB,
	SPEECH_WINDOW_FRAMES,
	strongSpeech,
	type SpeechContent,
} from "../../../../src/core/scanner/channel/speech-content.js"
import {
	WIDEBAND_HOLDBACK_MS,
	type WidebandCloseInfo,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

/** A shadow whose spectrum reads `carrier` (no analog-fm class, no digital spectral class). */
const CARRIER: Partial<WidebandTrackInput> = {
	analogFm: false,
	shadowAllowed: true,
	spectralDigital: false,
}
const NOT_ANALOG: WidebandCloseInfo = { analogFm: false, discoveryId: "d_1" }

/** A discovery the spectrum calls carrier, with `decoded` of `attempts` analog trials heard. */
const trials = (decoded: number, attempts: number): VoicePrior => ({
	labels: [],
	class: "carrier",
	analogVoice: () => false,
	analogTrials: () => ({ attempts, decoded }),
})

/** Syllabic speech with no CTCSS tone (classByTone never classes it). */
const low = (prior: VoicePrior | null): Harness =>
	harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		source: { syllables: true, ctcssHz: null },
		decodedLabel: () => null,
		voicePrior: () => prior,
	})

const codes = (h: Harness): string[] =>
	h.rec.diagnostics().recent.map(d => d.code)

/**
 * One over of `seconds` (a snapshot every 25 ms chunk with `extra`, `each` run with the seconds
 * since the onset), closed not analog-fm 600 ms after it, then 3.5 s of quiet.
 */
async function over(
	h: Harness,
	seconds: number,
	extra: Partial<WidebandTrackInput> = CARRIER,
	each?: (at: number) => void,
): Promise<void> {
	await h.feed(1, false)
	const chunk = h.fs / 40
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	for (let i = 0; i < seconds * 40; i++) {
		each?.((h.engine.liveEdge() - onset) / h.fs)
		h.engine.write(h.src.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs)
			h.rec.track(
				input("o", snapshot("o", onset, Math.min(edge, end), LOW), extra),
			)
		await h.pump()
	}
	await h.feed(0.6, false)
	h.rec.closed("o", snapshot("o", onset, end, LOW), null, NOT_ANALOG)
	await h.feed(3.5, false)
	await h.rec.idle()
}

const content = (c: Partial<SpeechContent>): SpeechContent => ({
	frames: SPEECH_WINDOW_FRAMES,
	maxRangeDb: SPEECH_STRONG_MIN_RANGE_DB,
	periodicShare: SPEECH_STRONG_MIN_PERIODIC_SHARE,
	maxBurstFrames: 0,
	...c,
})

describe("strongSpeech bounds", () => {
	// Feature: wideband analog recorder, own-audio class by speech.
	it("3 s (94 frames of 32 ms), 15 dB and a 0.05 periodic share: at each bound strong, just past it not", () => {
		expect(SPEECH_WINDOW_FRAMES).toBe(94)
		expect(SPEECH_STRONG_MIN_RANGE_DB).toBe(15)
		expect(SPEECH_STRONG_MIN_PERIODIC_SHARE).toBe(0.05)
		expect(strongSpeech(content({}))).toBe(true)
		expect(strongSpeech(content({ frames: 93 }))).toBe(false)
		expect(strongSpeech(content({ maxRangeDb: 14.99 }))).toBe(false)
		expect(strongSpeech(content({ periodicShare: 0.0499 }))).toBe(false)
		expect(
			strongSpeech(content({ frames: 0, maxRangeDb: 0, periodicShare: 0 })),
		).toBe(false)
	})
})

describe("trialsVoiceChannel bounds", () => {
	// Feature: wideband analog recorder, own-audio class by speech.
	it("10 heard and 30 % of the attempts: at each bound a voice channel, just past it not", () => {
		expect(VOICE_CHANNEL_MIN_HEARD).toBe(10)
		expect(VOICE_CHANNEL_MIN_HEARD_PERCENT).toBe(30)
		// 10 of 33 = 30.3 %, 30 of 100 = 30 % exactly, 10 of 34 = 29.4 %, 29 of 100 = 29 %.
		expect(trialsVoiceChannel(trials(10, 33))).toBe(true)
		expect(trialsVoiceChannel(trials(30, 100))).toBe(true)
		expect(trialsVoiceChannel(trials(10, 34))).toBe(false)
		expect(trialsVoiceChannel(trials(29, 100))).toBe(false)
		// 9 of 9 = 100 % but under 10 heard.
		expect(trialsVoiceChannel(trials(9, 9))).toBe(false)
		expect(trialsVoiceChannel(trials(10, 10))).toBe(true)
		expect(trialsVoiceChannel(trials(262, 339))).toBe(true)
		expect(trialsVoiceChannel(trials(0, 100))).toBe(false)
		expect(trialsVoiceChannel(trials(7, 81))).toBe(false)
	})

	it("unknown or malformed trial memory is not a voice channel", () => {
		const base = trials(0, 0)
		expect(trialsVoiceChannel(null)).toBe(false)
		const { analogTrials: _none, ...noReader } = base
		expect(trialsVoiceChannel(noReader)).toBe(false)
		expect(trialsVoiceChannel({ ...base, analogTrials: () => null })).toBe(
			false,
		)
		expect(
			trialsVoiceChannel({
				...base,
				analogTrials: () => {
					throw new Error("unreadable")
				},
			}),
		).toBe(false)
		expect(trialsVoiceChannel(trials(Number.NaN, 10))).toBe(false)
		expect(trialsVoiceChannel(trials(20, Number.NaN))).toBe(false)
	})
})

describe("an untoned voice the spectrum reads as a carrier", () => {
	// Feature: wideband analog recorder, own-audio class by speech.
	it("trials 262 of 339 heard: classed by its speech and the whole over kept", async () => {
		const h = low(trials(262, 339))
		await over(h, 8)
		expect(codes(h)).toEqual(["shadow", "voiced", "classed", "finalized"])
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.ops[0]!.frames).toBeGreaterThan(8 * 8000)
		expect(h.tones).toEqual([])
	}, 120_000)

	it("trials 0 of 100 heard: not classed, discarded unclassed as before", async () => {
		const h = low(trials(0, 100))
		await over(h, 8)
		expect(codes(h)).toEqual(["shadow", "voiced", "discarded:unclassed"])
		expect(h.ops).toEqual([])
	}, 120_000)

	it("audio that reads as strong speech (as paging audio does) with trials 7 of 81 heard: not classed", async () => {
		const h = low(trials(7, 81))
		await over(h, 8)
		expect(codes(h)).toEqual(["shadow", "voiced", "discarded:unclassed"])
		expect(h.ops).toEqual([])
	}, 120_000)

	it("a digital spectral class, a strong prior, or no discovery: not classed by speech", async () => {
		const voiceTrials = trials(262, 339)
		const pager: VoicePrior = {
			...voiceTrials,
			labels: [
				{
					protocol: "pocsag",
					confidence: "decoded",
					owner: true,
					at: 1_700_000_000_000,
				},
			],
		}
		for (const [prior, extra] of [
			[voiceTrials, { ...CARRIER, spectralDigital: true }],
			[pager, CARRIER],
			[null, CARRIER],
		] as const) {
			const h = low(prior)
			await over(h, 8, extra)
			expect(codes(h)).not.toContain("classed")
			expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
		}
	}, 300_000)

	it("5 s of speech then a 30 s bare carrier in one over ends as today: voice on air stops as for a snapshot-classed voice, and the same file outcome", async () => {
		// Today's reference: the same audio and prior, classed analog-fm by its snapshots.
		const run = async (extra: Partial<WidebandTrackInput>) => {
			const h = low(trials(262, 339))
			let classedAt: number | null = null
			let lastVoice: number | null = null
			await over(h, 35, extra, at => {
				if (classedAt === null && codes(h).includes("classed")) classedAt = at
				const a = h.rec.recordingActive("rtl", { stream: 1, epoch: 1 })
				if (typeof a === "object" && "voice" in a) lastVoice = at
				if (at >= 5) h.src.setVoice(false)
			})
			return {
				classedAt,
				lastVoice,
				outcomes: h.ops.map(o => [o.cut, o.outcome]),
				codes: codes(h),
			}
		}
		const speech = await run(CARRIER)
		const today = await run({ ...CARRIER, analogFm: true })
		expect(speech.classedAt).not.toBeNull()
		expect(speech.classedAt!).toBeLessThan(5)
		expect(speech.codes).toEqual(["shadow", "voiced", "classed", "finalized"])
		expect(today.codes).toEqual(["started", "voiced", "finalized"])
		// The sweep's hold follows voice on air: it ends within the on-air bound after the last
		// word (1 s holdback + 2 s + a 500 ms window), at the same moment as today's.
		expect(speech.lastVoice).not.toBeNull()
		expect(speech.lastVoice).toBe(today.lastVoice)
		expect(speech.lastVoice!).toBeLessThan(5 + 3.5)
		expect(speech.outcomes).toEqual(today.outcomes)
	}, 300_000)

	it("a 30 s bare carrier alone, on the same voice channel: discarded unvoiced as today", async () => {
		const h = low(trials(262, 339))
		h.src.setVoice(false)
		await over(h, 30)
		expect(codes(h)).toEqual(["shadow", "discarded:unvoiced"])
		expect(h.ops).toEqual([])
	}, 120_000)

	it("classed on 3.5 s of speech, then a 110 s carrier: the whole file no longer reads strong speech, discarded not-speech, nothing kept", async () => {
		// The file so far reads strong speech from 3 s; over 114 s its periodic share falls under
		// 0.05 (the carrier's frames dilute it), so its finish discards it.
		const h = low(trials(262, 339))
		let classedAt: number | null = null
		await over(h, 113.5, CARRIER, at => {
			if (classedAt === null && codes(h).includes("classed")) classedAt = at
			if (at >= 3.5) h.src.setVoice(false)
		})
		expect(classedAt).not.toBeNull()
		// Judged up to WIDEBAND_HOLDBACK_MS behind the air: classed on the speech, seen up to 1 s later.
		expect(classedAt!).toBeLessThan(3.5 + WIDEBAND_HOLDBACK_MS / 1000)
		expect(codes(h)).toEqual([
			"shadow",
			"voiced",
			"classed",
			"discarded:not-speech",
		])
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
	}, 300_000)
})
