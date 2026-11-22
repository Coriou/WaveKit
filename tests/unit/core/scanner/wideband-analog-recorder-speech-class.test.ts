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
	analogTrialsHeard,
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
	WIDEBAND_MAX_FILE_MS,
	WIDEBAND_SPEECH_PRIOR_RETRY_FRAMES,
	WIDEBAND_SPEECH_PRIOR_RETRY_MS,
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
	ownAnalogTrials: () => ({ attempts, decoded }),
})

/** Syllabic speech with no CTCSS tone (classByTone never classes it), or `source`. */
const low = (
	prior: VoicePrior | null | (() => VoicePrior | null),
	source: NonNullable<Parameters<typeof harness>[0]>["source"] = {
		syllables: true,
		ctcssHz: null,
	},
): Harness =>
	harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		source,
		decodedLabel: () => null,
		voicePrior: typeof prior === "function" ? prior : () => prior,
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
	levelFrames: 0,
	maxWindowSpreadDb: 0,
	minWindowP10Dbfs: 0,
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

	it("only the channel's own trials count: co-channel partners' heard trials never class it", () => {
		const own = { attempts: 81, decoded: 7 }
		const partners = Array.from({ length: 8 }, () => ({
			attempts: 81,
			decoded: 7,
		}))
		// The no-voice check's reader adds partners: 7 + 8 × 7 = 63 of 81 (77.8 %).
		const withPartners = analogTrialsHeard(own, partners)
		expect(withPartners).toEqual({ attempts: 81, decoded: 63 })
		const twins: VoicePrior = {
			labels: [],
			class: "carrier",
			analogVoice: () => false,
			analogTrials: () => withPartners,
			ownAnalogTrials: () => analogTrialsHeard(own),
		}
		expect(trialsVoiceChannel(twins)).toBe(false)
		// A 1-attempt owner beside a 10-heard partner is not one either.
		const lone = { attempts: 1, decoded: 0 }
		expect(
			trialsVoiceChannel({
				...twins,
				analogTrials: () =>
					analogTrialsHeard(lone, [{ attempts: 10, decoded: 10 }]),
				ownAnalogTrials: () => analogTrialsHeard(lone),
			}),
		).toBe(false)
		// Only the partner-adding reader present: not a voice channel.
		const { ownAnalogTrials: _own, ...partnersOnly } = twins
		expect(trialsVoiceChannel(partnersOnly)).toBe(false)
		// The owner's own 10 of 33 (30.3 %) still classes, its own syllabic runs included.
		expect(
			trialsVoiceChannel({
				...twins,
				ownAnalogTrials: () =>
					analogTrialsHeard({ attempts: 33, decoded: 8, syllabic: 2 }),
			}),
		).toBe(true)
	})

	it("unknown or malformed trial memory is not a voice channel", () => {
		const base = trials(0, 0)
		expect(trialsVoiceChannel(null)).toBe(false)
		const { ownAnalogTrials: _none, ...noReader } = base
		expect(trialsVoiceChannel(noReader)).toBe(false)
		expect(trialsVoiceChannel({ ...base, ownAnalogTrials: () => null })).toBe(
			false,
		)
		expect(
			trialsVoiceChannel({
				...base,
				ownAnalogTrials: () => {
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

	it("a loud pre-roll burst then a steady tone: a partial window would read 15 dB, the whole windows do not, so not classed", async () => {
		// The file opens on 300 ms of pre-roll (open-squelch noise, about 9 frames: loud in the
		// envelope band), then a steady in-band tone the voice gate passes (periodic, no syllables).
		// A partial window of 16 to 93 frames holds the burst over its 10 % tail and reads well over
		// 15 dB; every whole 3 s window holds it under its 10 % tail. Measured on the meter read at
		// every judging step before the fix: classed at 3.7 s on both tones.
		for (const tone of [
			{ ctcssHz: 600, ctcssDeviationHz: 300 },
			{ ctcssHz: 1000, ctcssDeviationHz: 500 },
		]) {
			const h = low(trials(262, 339), { voice: false, ...tone })
			await over(h, 8)
			expect(codes(h)).toEqual(["shadow", "voiced", "discarded:unclassed"])
			expect(h.ops).toEqual([])
		}
	}, 120_000)

	it("a backed digital class of the owner (two channel-tier digital observations, DigitalClassLedger): not classed by speech", async () => {
		const h = low(trials(262, 339))
		await h.feed(1, false)
		for (let k = 0; k < 2; k++)
			h.rec.track(
				input(`o_dig${k}`, snapshot(`o_dig${k}`, 0, 100, LOW), {
					analogFm: false,
					nonAnalog: true,
					digitalClass: true,
				}),
			)
		await over(h, 8)
		expect(codes(h)).not.toContain("classed")
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
	}, 120_000)

	it("a refused prior is read again every WIDEBAND_SPEECH_PRIOR_RETRY_FRAMES judged frames (1 s), not on every step; a prior that turns favourable classes within 1 s", async () => {
		expect(WIDEBAND_SPEECH_PRIOR_RETRY_MS).toBe(1_000)
		expect(WIDEBAND_SPEECH_PRIOR_RETRY_FRAMES).toBe(8_000)
		let at = 0
		let favourable = false
		const reads: number[] = []
		const prior: VoicePrior = {
			labels: [],
			class: "carrier",
			analogVoice: () => false,
			ownAnalogTrials: () => {
				reads.push(at)
				return favourable
					? { attempts: 339, decoded: 262 }
					: { attempts: 81, decoded: 7 }
			},
		}
		const h = low(prior)
		let classedAt: number | null = null
		await over(h, 12, CARRIER, t => {
			at = t
			if (t >= 8) favourable = true
			if (classedAt === null && codes(h).includes("classed")) classedAt = t
		})
		const before = reads.filter(t => t < 8)
		// Strong speech from about 3.7 s (judged 1 s behind the air): a read at most once a
		// second up to 8 s, not one per 25 ms step (about 170).
		expect(before.length).toBeGreaterThanOrEqual(3)
		expect(before.length).toBeLessThanOrEqual(6)
		// Each wait is exactly 8 000 judged frames (40 steps of 200 frames, 1 s of air): a read
		// at 7 999 frames (39 steps) would be 0.975 s.
		for (let i = 1; i < before.length; i++)
			expect(before[i]! - before[i - 1]!).toBeCloseTo(1, 6)
		expect(classedAt).not.toBeNull()
		expect(classedAt!).toBeGreaterThanOrEqual(8)
		expect(classedAt!).toBeLessThanOrEqual(8 + 1 + 0.05)
		expect(codes(h)).toEqual(["shadow", "voiced", "classed", "finalized"])
	}, 120_000)

	it("roll-over of a session classed by speech: each file is judged on its own at its finish", async () => {
		// Speech for the whole first file and 6 s into the next: both files read strong speech, both kept.
		const kept = low(trials(262, 339))
		await over(kept, WIDEBAND_MAX_FILE_MS / 1000 + 6)
		expect(kept.ops.map(o => [o.cut, o.outcome])).toEqual([
			["duration-limit", "finalized"],
			["completed", "finalized"],
		])
		expect(codes(kept)).toEqual([
			"shadow",
			"voiced",
			"classed",
			"finalized",
			"finalized",
		])
		// Speech runs 2 s into the next file, then a bare carrier for 60 s: the first file is kept;
		// the next one is voiced, but over its own 62 s its periodic share falls under 0.05, so it
		// no longer reads strong speech and is discarded (the first file's speech does not carry).
		const tail = low(trials(262, 339))
		await over(tail, WIDEBAND_MAX_FILE_MS / 1000 + 62, CARRIER, t => {
			if (t >= WIDEBAND_MAX_FILE_MS / 1000 + 2) tail.src.setVoice(false)
		})
		expect(tail.ops.map(o => o.outcome)).toContain("finalized")
		expect(tail.ops[0]!.cut).toBe("duration-limit")
		expect(tail.ops[0]!.outcome).toBe("finalized")
		expect(tail.ops.filter(o => o.outcome === "finalized")).toHaveLength(1)
		expect(codes(tail)).toEqual([
			"shadow",
			"voiced",
			"classed",
			"finalized",
			"discarded:not-speech",
		])
	}, 600_000)
})
