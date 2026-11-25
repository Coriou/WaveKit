/**
 * The recording admission on a channel with proven analog voice (recording-verdict.ts finishPath)
 * and its evidence budget (noise-evidence.ts NoiseEvidenceBudget): a noise file whose periodic
 * share is under SPEECH_NOISE_MAX_PERIODIC_SHARE (0.10) is discarded, except
 * NOISE_EVIDENCE_PER_HOUR (2) per discovery per rolling hour kept as `noise-evidence`; a share at
 * or over 0.10 is kept as before (`prior-none`); a joined voice of another transmission still
 * keeps it; a channel without proven voice is unchanged. Only there is a file of 47 to 93 level
 * frames judged on its partial window (ADMISSION_PROVEN_VOICE); elsewhere it stays unmeasured, so
 * weak voice of 1.6 and 2.5 s is kept. All readings and signals are modelled.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	finishPath,
	type FinishInput,
	type VoicePrior,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	ADMISSION_DEFAULTS,
	ADMISSION_MIN_FRAMES,
	ADMISSION_PROVEN_VOICE,
	ADMISSION_PROVEN_VOICE_MIN_FRAMES,
	admissionNoise,
	SPEECH_NOISE_MAX_PERIODIC_SHARE,
	SpeechContentMeter,
	type SpeechContent,
} from "../../../../src/core/scanner/channel/speech-content.js"
import { contentAudio, type ContentSignal } from "./speech-content-fixtures.js"
import {
	NOISE_EVIDENCE_MAX_DISCOVERIES,
	NOISE_EVIDENCE_PER_HOUR,
	NOISE_EVIDENCE_WINDOW_MS,
	NoiseEvidenceBudget,
} from "../../../../src/core/scanner/channel/noise-evidence.js"
import { TRIAL_MEMORY_MAX_DISCOVERIES } from "../../../../src/core/scanner/trial-memory.js"

const NOW = 1_700_000_000_000
const HOUR = NOISE_EVIDENCE_WINDOW_MS

const base: FinishInput = {
	prior: null,
	backedClass: false,
	ownTone: false,
	snapshotClassed: true,
	decodedOwn: false,
	joinedVoice: false,
	notSpeech: false,
	clearNoise: false,
	speechHeard: true,
	final: false,
	now: NOW,
}
/** A channel whose analog trials heard voice (one real CTCSS user, modelled). */
const proven: VoicePrior = {
	labels: [],
	class: "analog-fm",
	analogVoice: () => true,
}
const unproven: VoicePrior = {
	labels: [],
	class: "analog-fm",
	analogVoice: () => false,
}
const noise = (periodicShare: number | null) =>
	({ enabled: true, noise: true, periodicShare }) as const

describe("finishPath: noise on a channel with proven analog voice", () => {
	// Feature: noise-recordings, Property 1: proven-voice noise rule
	// Validates: Requirements 1
	it("the bound is the speech noise periodic share, 0.10", () => {
		expect(SPEECH_NOISE_MAX_PERIODIC_SHARE).toBe(0.1)
	})

	it("noise with a periodic share under 0.10 is discarded:noise (reason noise)", () => {
		for (const share of [0, 0.05, 0.099])
			expect(
				finishPath({ ...base, prior: proven, admission: noise(share) }),
			).toMatchObject({
				verdict: "discarded:noise",
				reason: "noise",
				strength: "none",
			})
	})

	it("a periodic share at or over 0.10 is kept (prior-none), as is a share not given", () => {
		for (const share of [0.1, 0.101, 0.14, null])
			expect(
				finishPath({ ...base, prior: proven, admission: noise(share) }),
			).toMatchObject({ verdict: "finish", reason: "prior-none" })
		expect(
			finishPath({
				...base,
				prior: proven,
				admission: { enabled: true, noise: true },
			}),
		).toMatchObject({ verdict: "finish", reason: "prior-none" })
	})

	it("with evidence room it is kept as noise-evidence; with none discarded", () => {
		const input = { ...base, prior: proven, admission: noise(0.05) }
		expect(finishPath({ ...input, noiseEvidence: true })).toMatchObject({
			verdict: "finish",
			reason: "noise-evidence",
		})
		expect(finishPath({ ...input, noiseEvidence: false }).verdict).toBe(
			"discarded:noise",
		)
	})

	it("a joined voice of another transmission still keeps it (prior-none)", () => {
		const p = finishPath({
			...base,
			prior: proven,
			joinedVoice: true,
			joinedVoiceIds: ["o-other"],
			admission: noise(0.01),
		})
		expect(p).toMatchObject({ verdict: "finish", reason: "prior-none" })
		expect(p.joinedOther).toBe(true)
	})

	it("own tone and a decode of its own signal keep their earlier rows", () => {
		expect(
			finishPath({
				...base,
				prior: proven,
				ownTone: true,
				admission: noise(0.01),
			}).reason,
		).toBe("own-tone")
		expect(
			finishPath({
				...base,
				prior: proven,
				decodedOwn: true,
				admission: noise(0.01),
			}).verdict,
		).toBe("discarded:late-non-voice")
	})

	it("not noise, not measured or disabled: kept as before", () => {
		for (const admission of [
			{ enabled: true, noise: false, periodicShare: 0.01 },
			{ enabled: true, noise: null, periodicShare: 0.01 },
			{ enabled: false, noise: true, periodicShare: 0.01 },
		])
			expect(finishPath({ ...base, prior: proven, admission }).reason).toBe(
				"prior-none",
			)
	})

	it("a channel without proven voice is unchanged: noise is discarded whatever its periodic share or budget", () => {
		for (const prior of [null, unproven])
			for (const share of [0.01, 0.2, null])
				for (const room of [true, false])
					expect(
						finishPath({
							...base,
							prior,
							admission: noise(share),
							noiseEvidence: room,
						}),
					).toMatchObject({ verdict: "discarded:noise", reason: "noise" })
	})

	it("property: on a proven channel the verdict is fixed by noise, share, budget and joined voice", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.boolean(),
				fc.boolean(),
				(isNoise, share, room, joined) => {
					const p = finishPath({
						...base,
						prior: proven,
						admission: { enabled: true, noise: isNoise, periodicShare: share },
						noiseEvidence: room,
						...(joined
							? { joinedVoice: true, joinedVoiceIds: ["o-other"] }
							: {}),
					})
					const caught =
						isNoise && !joined && share < SPEECH_NOISE_MAX_PERIODIC_SHARE
					const want = !caught
						? "prior-none"
						: room
							? "noise-evidence"
							: "noise"
					expect(p.reason).toBe(want)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("NoiseEvidenceBudget", () => {
	// Feature: noise-recordings, Property 2: evidence budget
	// Validates: Requirements 1
	it("states its bounds: 2 per hour, 3 600 000 ms, the trial memory's 2 048 discoveries", () => {
		expect(NOISE_EVIDENCE_PER_HOUR).toBe(2)
		expect(NOISE_EVIDENCE_WINDOW_MS).toBe(3_600_000)
		expect(NOISE_EVIDENCE_MAX_DISCOVERIES).toBe(TRIAL_MEMORY_MAX_DISCOVERIES)
		expect(NOISE_EVIDENCE_MAX_DISCOVERIES).toBe(2048)
	})

	it("1st and 2nd in an hour kept, the 3rd not; after the hour kept again (at and past the bound)", () => {
		const b = new NoiseEvidenceBudget()
		const t0 = 5_000
		expect(b.room("d", t0)).toBe(true)
		b.spend("d", t0)
		expect(b.room("d", t0 + 10)).toBe(true)
		b.spend("d", t0 + 10)
		expect(b.room("d", t0 + 20)).toBe(false)
		b.spend("d", t0 + 20) // no room: nothing noted
		// One ms short of the hour after the first keep: both still count.
		expect(b.room("d", t0 + HOUR - 1)).toBe(false)
		// Exactly the hour: the first keep leaves the window, one slot frees.
		expect(b.room("d", t0 + HOUR)).toBe(true)
		b.spend("d", t0 + HOUR)
		expect(b.room("d", t0 + HOUR + 1)).toBe(false)
		// Past the second keep's hour: one slot again.
		expect(b.room("d", t0 + 10 + HOUR)).toBe(true)
	})

	it("budgets are per discovery; a file with no discovery uses none (no room)", () => {
		const b = new NoiseEvidenceBudget()
		b.spend("a", 0)
		b.spend("a", 1)
		expect(b.room("a", 2)).toBe(false)
		expect(b.room("b", 2)).toBe(true)
		expect(b.room(null, 2)).toBe(false)
		b.spend(null, 2)
		expect(b.size).toBe(1)
	})

	it("entries older than the hour are evicted", () => {
		const b = new NoiseEvidenceBudget()
		b.spend("a", 0)
		b.spend("b", 100)
		expect(b.size).toBe(2)
		b.spend("c", HOUR) // a expired (exactly the hour), b not
		expect(b.size).toBe(2)
		b.spend("c", HOUR + 100) // b expired
		expect(b.size).toBe(1)
	})

	it("the discovery map stays at its cap (at and past it): the least recently spent goes", () => {
		const cap = 4
		const b = new NoiseEvidenceBudget(2, cap)
		// Each discovery spends its whole budget: d0 first, d3 last.
		for (let i = 0; i < cap; i++) {
			b.spend(`d${i}`, 2 * i)
			b.spend(`d${i}`, 2 * i + 1)
		}
		expect(b.size).toBe(cap)
		for (let i = 0; i < cap; i++) expect(b.room(`d${i}`, 10)).toBe(false)
		b.spend("new", 11) // past the cap: d0 (least recently spent) goes
		expect(b.size).toBe(cap)
		expect(b.room("d0", 12)).toBe(true) // forgotten: a fresh budget
		expect(b.room("d1", 12)).toBe(false)
	})

	it("property: keeps per discovery in any hour never exceed 2", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						d: fc.constantFrom("a", "b", "c"),
						dt: fc.integer({ min: 0, max: HOUR / 4 }),
					}),
					{ maxLength: 60 },
				),
				events => {
					const b = new NoiseEvidenceBudget()
					const kept: { d: string; at: number }[] = []
					let now = 0
					for (const e of events) {
						now += e.dt
						if (b.room(e.d, now)) {
							b.spend(e.d, now)
							kept.push({ d: e.d, at: now })
						}
					}
					for (const k of kept) {
						const inHour = kept.filter(
							o => o.d === k.d && o.at <= k.at && k.at - o.at < HOUR,
						)
						expect(inHour.length).toBeLessThanOrEqual(NOISE_EVIDENCE_PER_HOUR)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("finishPath: the partial-window floor (47 to 93 frames) only on a proven-voice channel", () => {
	// Feature: noise-recordings, Property 2: partial-window floor scope
	// Validates: Requirements 2
	it("states the floors: 94 frames everywhere, 47 on a proven-voice channel", () => {
		expect(ADMISSION_MIN_FRAMES).toBe(94)
		expect(ADMISSION_PROVEN_VOICE_MIN_FRAMES).toBe(47)
		expect(ADMISSION_PROVEN_VOICE).toEqual({
			...ADMISSION_DEFAULTS,
			minFrames: 47,
		})
		expect(Object.isFrozen(ADMISSION_PROVEN_VOICE)).toBe(true)
	})

	it("a short file read as noise only at the partial floor: kept without proven voice, discarded on a proven channel", () => {
		const admission = {
			enabled: true,
			noise: null,
			partialNoise: true,
			periodicShare: 0.02,
		} as const
		for (const prior of [null, unproven])
			expect(finishPath({ ...base, prior, admission }).reason).toBe(
				"prior-none",
			)
		expect(finishPath({ ...base, prior: proven, admission })).toMatchObject({
			verdict: "discarded:noise",
			reason: "noise",
		})
		expect(
			finishPath({ ...base, prior: proven, admission, noiseEvidence: true })
				.reason,
		).toBe("noise-evidence")
		// Pitched (share 0.10 or more): kept on the proven channel too.
		expect(
			finishPath({
				...base,
				prior: proven,
				admission: { ...admission, periodicShare: 0.1 },
			}).reason,
		).toBe("prior-none")
	})

	it("on a proven channel the partial reading wins over the whole-window one", () => {
		expect(
			finishPath({
				...base,
				prior: proven,
				admission: {
					enabled: true,
					noise: true,
					partialNoise: false,
					periodicShare: 0.02,
				},
			}).reason,
		).toBe("prior-none")
	})

	it("property: off a proven channel partialNoise never decides", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(true, false, null),
				fc.constantFrom(true, false, null),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.constantFrom(null, unproven),
				(isNoise, partial, share, prior) => {
					const p = finishPath({
						...base,
						prior,
						admission: {
							enabled: true,
							noise: isNoise,
							partialNoise: partial,
							periodicShare: share,
						},
					})
					expect(p.reason).toBe(isNoise === true ? "noise" : "prior-none")
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("the partial-window floor through the NFM chain (modelled signals)", () => {
	const yieldToLoop = (): Promise<void> =>
		new Promise(resolve => {
			setImmediate(resolve)
		})
	async function measured(signal: ContentSignal, seconds: number) {
		await yieldToLoop()
		const m = new SpeechContentMeter()
		const pcm = contentAudio(signal, seconds)
		for (let at = 0; at < pcm.length; at += 4_000)
			m.push(pcm.subarray(at, at + 4_000))
		return m.result()
	}
	const admissionOf = (c: SpeechContent) => ({
		enabled: true,
		noise: admissionNoise(c),
		partialNoise: admissionNoise(c, ADMISSION_PROVEN_VOICE),
		periodicShare: c.periodicShare,
	})
	for (const seconds of [1.6, 2.5]) {
		it(`weak NFM voice at a 9 dB CNR, ${seconds} s, no prior: unmeasured at the 94-frame floor and kept`, async () => {
			const c = await measured(
				{ waveform: { kind: "speech", pauses: "short" }, cnrDb: 9 },
				seconds,
			)
			expect(c.levelFrames).toBeGreaterThanOrEqual(47)
			expect(c.levelFrames).toBeLessThan(94)
			expect(admissionNoise(c)).toBeNull()
			const p = finishPath({ ...base, prior: null, admission: admissionOf(c) })
			expect(p).toMatchObject({ verdict: "finish", reason: "prior-none" })
		}, 120_000)

		it(`open-squelch noise, ${seconds} s, on a proven-voice channel: discarded:noise on its partial window`, async () => {
			const c = await measured(
				{ waveform: { kind: "silent" }, cnrDb: 30, carrier: false },
				seconds,
			)
			expect(c.levelFrames).toBeGreaterThanOrEqual(47)
			expect(c.levelFrames).toBeLessThan(94)
			expect(admissionNoise(c)).toBeNull()
			expect(admissionNoise(c, ADMISSION_PROVEN_VOICE)).toBe(true)
			const p = finishPath({
				...base,
				prior: proven,
				admission: admissionOf(c),
			})
			expect(p).toMatchObject({ verdict: "discarded:noise", reason: "noise" })
			// The same file without proven voice stays unmeasured: kept.
			expect(
				finishPath({ ...base, prior: null, admission: admissionOf(c) }).reason,
			).toBe("prior-none")
		}, 120_000)
	}
})
