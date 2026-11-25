/**
 * The recording admission on a channel with proven analog voice (recording-verdict.ts finishPath)
 * and its evidence budget (noise-evidence.ts NoiseEvidenceBudget): a noise file whose periodic
 * share is under SPEECH_NOISE_MAX_PERIODIC_SHARE (0.10) is discarded, except
 * NOISE_EVIDENCE_PER_HOUR (2) per discovery per rolling hour kept as `noise-evidence`; a share at
 * or over 0.10 is kept as before (`prior-none`); a joined voice of another transmission still
 * keeps it; a channel without proven voice is unchanged. Only there is a file of 47 to 93 level
 * frames judged on its partial window (ADMISSION_PROVEN_VOICE); elsewhere it stays unmeasured, so
 * weak voice of 1.6 and 2.5 s is kept. The proven-channel rule applies only on a discovery that
 * made DISCOVERY_NOISE_GATE (15) or more noise-read files in the hour before the file
 * (DiscoveryNoiseRate; `base` is such a discovery unless a test says otherwise); there a file kept
 * only by its quieted run or quieted share spends the budget too. All readings and signals are
 * modelled.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	finishPath,
	noiseRateCounts,
	noiseRateLog,
	noiseRuleJudges,
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
	DISCOVERY_NOISE_GATE,
	DISCOVERY_NOISE_LATCH_MS,
	DiscoveryNoiseRate,
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
	// A discovery at the noise gate: the proven-channel rule applies (DISCOVERY_NOISE_GATE).
	discoveryNoiseReads: DISCOVERY_NOISE_GATE,
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

describe("finishPath: decoded tone and carrier quieting on a proven-voice channel", () => {
	const quieted = (
		share: number,
		quieting: {
			quietedPeriodicShare: number | null
			quietedRun: boolean
		} | null,
	) => ({ enabled: true, noise: true, periodicShare: share, quieting }) as const

	it("a decoded CTCSS or DCS tone is never discarded as noise, on any channel and with any budget", () => {
		for (const prior of [proven, unproven, null])
			for (const room of [true, false])
				expect(
					finishPath({
						...base,
						prior,
						decodedTone: true,
						admission: noise(0.01),
						noiseEvidence: room,
					}),
				).toMatchObject({ verdict: "finish", reason: "prior-none" })
	})

	it("on a gated discovery a file kept only by its quieted run spends the budget; under the gate it is kept", () => {
		for (const q of [0, 0.05, null])
			for (const room of [true, false]) {
				const at = (reads: number) =>
					finishPath({
						...base,
						prior: proven,
						admission: quieted(0.01, {
							quietedPeriodicShare: q,
							quietedRun: true,
						}),
						noiseEvidence: room,
						discoveryNoiseReads: reads,
					}).reason
				expect(at(DISCOVERY_NOISE_GATE)).toBe(room ? "noise-evidence" : "noise")
				expect(at(DISCOVERY_NOISE_GATE - 1)).toBe("prior-none")
			}
	})

	it("on a gated discovery either share under 0.10 judges it: a file kept only by its quieted share spends the budget", () => {
		const at = (whole: number, q: number) =>
			finishPath({
				...base,
				prior: proven,
				admission: quieted(whole, {
					quietedPeriodicShare: q,
					quietedRun: false,
				}),
			}).reason
		// Pitched quieted frames over a whole-file share under 0.10: judged (the emitter reads so too).
		expect(at(0.02, 0.1)).toBe("noise")
		expect(at(0.02, 0.3)).toBe("noise")
		// A whole-file share over 0.10 with unpitched quieted frames: judged.
		expect(at(0.2, 0.099)).toBe("noise")
		// Both pitched: kept.
		expect(at(0.2, 0.1)).toBe("prior-none")
	})

	it("no quieted share (under 16 quieted frames) or no quieting reading: the whole file's share stands", () => {
		for (const quieting of [
			{ quietedPeriodicShare: null, quietedRun: false },
			null,
		]) {
			expect(
				finishPath({
					...base,
					prior: proven,
					admission: quieted(0.05, quieting),
				}).reason,
			).toBe("noise")
			expect(
				finishPath({
					...base,
					prior: proven,
					admission: quieted(0.2, quieting),
				}).reason,
			).toBe("prior-none")
		}
	})

	it("off a proven channel the quieting never decides", () => {
		for (const prior of [null, unproven])
			expect(
				finishPath({
					...base,
					prior,
					admission: quieted(0.01, {
						quietedPeriodicShare: 0.9,
						quietedRun: true,
					}),
				}).verdict,
			).toBe("discarded:noise")
	})

	// Feature: noise-recordings, Property 3: tone and the noise gate keep a proven channel's file
	// Validates: Requirements 1
	it("property: on a proven channel a file is discarded or demoted only with no tone, its discovery at the gate and a share under 0.10", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.boolean(),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.option(fc.double({ min: 0, max: 1, noNaN: true })),
				fc.boolean(),
				fc.boolean(),
				fc.integer({ min: 0, max: 40 }),
				(tone, run, whole, q, room, withQuieting, reads) => {
					const admission = quieted(
						whole,
						withQuieting ? { quietedPeriodicShare: q, quietedRun: run } : null,
					)
					const p = finishPath({
						...base,
						prior: proven,
						decodedTone: tone,
						admission,
						noiseEvidence: room,
						discoveryNoiseReads: reads,
					})
					const shareUnder =
						whole < SPEECH_NOISE_MAX_PERIODIC_SHARE ||
						(withQuieting && q !== null && q < SPEECH_NOISE_MAX_PERIODIC_SHARE)
					expect(noiseRuleJudges(admission, tone)).toBe(!tone && shareUnder)
					const caught = !tone && reads >= DISCOVERY_NOISE_GATE && shareUnder
					expect(p.reason).toBe(
						!caught ? "prior-none" : room ? "noise-evidence" : "noise",
					)
				},
			),
			{ numRuns: 300 },
		)
	})
})

describe("the discovery noise-rate gate (DiscoveryNoiseRate, DISCOVERY_NOISE_GATE)", () => {
	const judged = noise(0.01)

	it("states its bound: 15 noise reads in the hour before the file, the budget's window and map bound", () => {
		expect(DISCOVERY_NOISE_GATE).toBe(15)
		expect(NOISE_EVIDENCE_WINDOW_MS).toBe(3_600_000)
		expect(NOISE_EVIDENCE_MAX_DISCOVERIES).toBe(TRIAL_MEMORY_MAX_DISCOVERIES)
	})

	it("finishPath at 14, 15 and 16 reads before the file: kept under the gate, judged at and past it", () => {
		const at = (reads: number | undefined, room: boolean) =>
			finishPath({
				...base,
				prior: proven,
				admission: judged,
				noiseEvidence: room,
				...(reads === undefined ? {} : { discoveryNoiseReads: reads }),
			}).reason
		for (const room of [true, false]) {
			expect(at(14, room)).toBe("prior-none")
			expect(at(15, room)).toBe(room ? "noise-evidence" : "noise")
			expect(at(16, room)).toBe(room ? "noise-evidence" : "noise")
			expect(at(0, room)).toBe("prior-none")
		}
		// Absent: 0, never gated.
		const { discoveryNoiseReads: _gate, ...ungated } = base
		expect(
			finishPath({ ...ungated, prior: proven, admission: judged }).reason,
		).toBe("prior-none")
	})

	it("the gate never touches a channel without proven voice: noise is discarded at any rate", () => {
		for (const prior of [null, unproven])
			for (const reads of [0, 14, 15])
				expect(
					finishPath({
						...base,
						prior,
						admission: judged,
						discoveryNoiseReads: reads,
					}).verdict,
				).toBe("discarded:noise")
	})

	it("a decoded tone is exempt at any rate, and a tone file is never a noise read", () => {
		for (const reads of [0, 15, 40])
			expect(
				finishPath({
					...base,
					prior: proven,
					decodedTone: true,
					admission: judged,
					discoveryNoiseReads: reads,
				}).reason,
			).toBe("prior-none")
		expect(noiseRuleJudges(judged, true)).toBe(false)
		expect(noiseRuleJudges(judged, false)).toBe(true)
	})

	it("noise reads: admission noise (the partial window when given) with a share under 0.10; not when disabled, not noise or both shares pitched", () => {
		expect(noiseRuleJudges(undefined, false)).toBe(false)
		expect(
			noiseRuleJudges(
				{ enabled: false, noise: true, periodicShare: 0.01 },
				false,
			),
		).toBe(false)
		expect(
			noiseRuleJudges(
				{ enabled: true, noise: false, periodicShare: 0.01 },
				false,
			),
		).toBe(false)
		expect(
			noiseRuleJudges(
				{ enabled: true, noise: null, periodicShare: 0.01 },
				false,
			),
		).toBe(false)
		expect(noiseRuleJudges(noise(0.2), false)).toBe(false)
		expect(noiseRuleJudges(noise(null), false)).toBe(false)
		expect(
			noiseRuleJudges(
				{ enabled: true, noise: null, partialNoise: true, periodicShare: 0.05 },
				false,
			),
		).toBe(true)
		expect(
			noiseRuleJudges(
				{
					enabled: true,
					noise: true,
					partialNoise: false,
					periodicShare: 0.05,
				},
				false,
			),
		).toBe(false)
		expect(
			noiseRuleJudges(
				{
					enabled: true,
					noise: true,
					periodicShare: 0.2,
					quieting: { quietedPeriodicShare: 0.05, quietedRun: true },
				},
				false,
			),
		).toBe(true)
	})

	it("counts the reads before a file: 14, 15 and 16 notes read 14, 15 and 16; the stored list stays at 16 (gate + 1)", () => {
		const rate = new DiscoveryNoiseRate()
		for (let i = 0; i < 14; i++) rate.note("d", NOW + i)
		expect(rate.before("d", NOW + 100)).toBe(14)
		rate.note("d", NOW + 14)
		expect(rate.before("d", NOW + 100)).toBe(15)
		rate.note("d", NOW + 15)
		expect(rate.before("d", NOW + 100)).toBe(16)
		for (let i = 16; i < 100; i++) rate.note("d", NOW + i)
		expect(rate.stored("d")).toBe(DISCOVERY_NOISE_GATE + 1)
		expect(rate.before("d", NOW + 200)).toBe(DISCOVERY_NOISE_GATE + 1)
		// Other discoveries and none: their own counts, nothing for null.
		expect(rate.before("other", NOW)).toBe(0)
		rate.note(null, NOW)
		expect(rate.before(null, NOW)).toBe(0)
		expect(rate.size).toBe(1)
	})

	it("reads expire after the hour: counted while now − at is under 3 600 000 ms, the entry dropped when all expired", () => {
		const rate = new DiscoveryNoiseRate()
		for (let i = 0; i < 15; i++) rate.note("d", NOW)
		rate.note("d", NOW + 10_000)
		expect(rate.before("d", NOW + HOUR - 1)).toBe(16)
		expect(rate.before("d", NOW + HOUR)).toBe(1)
		expect(rate.before("d", NOW + HOUR + 10_000)).toBe(0)
		// d reached the gate: its entry stays for the latch, its times dropped.
		expect(rate.size).toBe(1)
		expect(rate.stored("d")).toBe(0)
		expect(rate.latched("d", NOW + HOUR + 10_000)).toBe(true)
		// An unlatched discovery's entry goes when its times expired.
		const open = new DiscoveryNoiseRate()
		for (let i = 0; i < DISCOVERY_NOISE_GATE - 1; i++) open.note("d", NOW)
		expect(open.before("d", NOW + HOUR)).toBe(0)
		expect(open.size).toBe(0)
		// Another discovery's note drops an expired entry too.
		open.note("a", NOW)
		open.note("b", NOW + HOUR)
		expect(open.size).toBe(1)
	})

	it("the discovery map stays at its cap (at and past it): the least recently noted goes", () => {
		const rate = new DiscoveryNoiseRate(DISCOVERY_NOISE_GATE, 3)
		for (const id of ["a", "b", "c"]) rate.note(id, NOW)
		expect(rate.size).toBe(3)
		rate.note("a", NOW + 1) // a moves newest
		rate.note("d", NOW + 2)
		expect(rate.size).toBe(3)
		expect(rate.before("b", NOW + 3)).toBe(0)
		expect(rate.before("a", NOW + 3)).toBe(2)
		const full = new DiscoveryNoiseRate()
		for (let i = 0; i <= NOISE_EVIDENCE_MAX_DISCOVERIES; i++)
			full.note(`d${i}`, NOW + i)
		expect(full.size).toBe(NOISE_EVIDENCE_MAX_DISCOVERIES)
		expect(full.before("d0", NOW + 5_000)).toBe(0)
	})

	it("on a gated discovery, quieted-run and quieted-share files spend the budget in turn: 2 kept as evidence, the 3rd discarded", () => {
		const budget = new NoiseEvidenceBudget()
		const files = [
			{ quietedPeriodicShare: 0.05, quietedRun: true },
			{ quietedPeriodicShare: 0.4, quietedRun: false },
			{ quietedPeriodicShare: null, quietedRun: true },
		]
		const reasons = files.map((quieting, i) => {
			const p = finishPath({
				...base,
				prior: proven,
				admission: {
					enabled: true,
					noise: true,
					periodicShare: 0.03,
					quieting,
				},
				noiseEvidence: budget.room("d", NOW + i),
			})
			if (p.reason === "noise-evidence") budget.spend("d", NOW + i)
			return p.reason
		})
		expect(reasons).toEqual(["noise-evidence", "noise-evidence", "noise"])
	})

	// Feature: noise-recordings, Property 4: the noise-rate count is the live reads, capped at gate + 1
	// Validates: Requirements 1
	it("property: before() is min(reads of the discovery in the hour before now, gate + 1) and the store stays bounded", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						d: fc.constantFrom("a", "b", "c"),
						dt: fc.integer({ min: 0, max: 900_000 }),
					}),
					{ maxLength: 60 },
				),
				events => {
					const rate = new DiscoveryNoiseRate()
					const model = new Map<string, number[]>()
					let now = NOW
					for (const e of events) {
						now += e.dt
						const live = (model.get(e.d) ?? []).filter(at => now - at < HOUR)
						expect(rate.before(e.d, now)).toBe(
							Math.min(live.length, DISCOVERY_NOISE_GATE + 1),
						)
						rate.note(e.d, now)
						model.set(e.d, [...live, now])
						expect(rate.stored(e.d)).toBeLessThanOrEqual(
							DISCOVERY_NOISE_GATE + 1,
						)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("the noise gate latch (DiscoveryNoiseRate.latched, DISCOVERY_NOISE_LATCH_MS)", () => {
	const MIN = 60_000
	const DAY = DISCOVERY_NOISE_LATCH_MS
	/** `n` judged reads of `d` a minute apart from `from`; returns the last read's time. */
	const reach = (
		rate: DiscoveryNoiseRate,
		d: string,
		from: number,
		n: number,
	) => {
		for (let i = 0; i < n; i++) rate.note(d, from + i * MIN)
		return from + (n - 1) * MIN
	}

	it("states its bound: 24 h", () => {
		expect(DISCOVERY_NOISE_LATCH_MS).toBe(86_400_000)
	})

	it("closes on the read that brings the rolling hour to 15, not before", () => {
		const rate = new DiscoveryNoiseRate()
		const at14 = reach(rate, "d", NOW, DISCOVERY_NOISE_GATE - 1)
		expect(rate.latched("d", at14 + 1)).toBe(false)
		rate.note("d", at14 + MIN)
		expect(rate.latched("d", at14 + MIN + 1)).toBe(true)
		// Reads spread so no rolling hour holds 15 never latch (12 an hour at most).
		const spread = new DiscoveryNoiseRate()
		for (let i = 0; i < 40; i++) spread.note("v", NOW + i * 5 * MIN)
		expect(spread.latched("v", NOW + 40 * 5 * MIN)).toBe(false)
		expect(rate.latched(null, NOW)).toBe(false)
	})

	it("holds at 23 h 59 min with a low rate and opens at 24 h after the gate was last reached", () => {
		const rate = new DiscoveryNoiseRate()
		const reached = reach(rate, "d", NOW, DISCOVERY_NOISE_GATE)
		// A low rate while closed: one read every 2 h never brings the hour back to 15.
		for (
			let t = reached + 2 * HOUR;
			t < reached + DAY - 2 * MIN;
			t += 2 * HOUR
		) {
			expect(rate.before("d", t)).toBeLessThan(DISCOVERY_NOISE_GATE)
			expect(rate.latched("d", t)).toBe(true)
			rate.note("d", t)
		}
		expect(rate.latched("d", reached + DAY - MIN)).toBe(true)
		expect(rate.latched("d", reached + DAY - 1)).toBe(true)
		expect(rate.latched("d", reached + DAY)).toBe(false)
		// finishPath: latched with a low count is judged, the same file unlatched is kept.
		const judged = {
			...base,
			prior: proven,
			admission: noise(0.01),
			discoveryNoiseReads: 1,
		}
		expect(finishPath({ ...judged, discoveryNoiseLatched: true }).reason).toBe(
			"noise",
		)
		expect(
			finishPath({
				...judged,
				discoveryNoiseLatched: true,
				noiseEvidence: true,
			}).reason,
		).toBe("noise-evidence")
		expect(finishPath({ ...judged, discoveryNoiseLatched: false }).reason).toBe(
			"prior-none",
		)
		expect(finishPath(judged).reason).toBe("prior-none")
		// The latch never touches a decoded tone.
		expect(
			finishPath({ ...judged, decodedTone: true, discoveryNoiseLatched: true })
				.reason,
		).toBe("prior-none")
	})

	it("refreshes only when the rolling hour reaches 15 again", () => {
		const rate = new DiscoveryNoiseRate()
		const first = reach(rate, "d", NOW, DISCOVERY_NOISE_GATE)
		// 14 reads in an hour, 12 h later: no refresh.
		reach(rate, "d", first + 12 * HOUR, DISCOVERY_NOISE_GATE - 1)
		expect(rate.latched("d", first + DAY - 1)).toBe(true)
		expect(rate.latched("d", first + DAY)).toBe(false)
		// 15 again at 20 h: closed until 24 h after that read.
		const again = new DiscoveryNoiseRate()
		reach(again, "d", NOW, DISCOVERY_NOISE_GATE)
		const second = reach(again, "d", first + 20 * HOUR, DISCOVERY_NOISE_GATE)
		expect(again.latched("d", first + DAY)).toBe(true)
		expect(again.latched("d", second + DAY - 1)).toBe(true)
		expect(again.latched("d", second + DAY)).toBe(false)
	})

	it("keeps a latched entry past its hour, drops it once the latch expired, and the map stays at its cap", () => {
		const rate = new DiscoveryNoiseRate(DISCOVERY_NOISE_GATE, 3)
		const reached = reach(rate, "a", NOW, DISCOVERY_NOISE_GATE)
		rate.note("b", reached + 2 * HOUR)
		expect(rate.size).toBe(2)
		expect(rate.stored("a")).toBe(0)
		rate.note("c", reached + DAY)
		// a's latch expired and its times are past the hour; b is unlatched, its time expired.
		expect(rate.size).toBe(1)
		expect(rate.latched("a", reached + DAY)).toBe(false)
		// Latched entries count against the cap: the least recently noted goes, latched or not.
		const full = new DiscoveryNoiseRate(DISCOVERY_NOISE_GATE, 3)
		for (const id of ["x", "y", "z"]) reach(full, id, NOW, DISCOVERY_NOISE_GATE)
		full.note("w", NOW + HOUR)
		expect(full.size).toBe(3)
		expect(full.latched("x", NOW + HOUR)).toBe(false)
		expect(full.latched("y", NOW + HOUR)).toBe(true)
		const big = new DiscoveryNoiseRate()
		for (let i = 0; i <= NOISE_EVIDENCE_MAX_DISCOVERIES; i++)
			reach(big, `d${i}`, NOW + i, DISCOVERY_NOISE_GATE)
		expect(big.size).toBe(NOISE_EVIDENCE_MAX_DISCOVERIES)
		expect(big.latched("d0", NOW + HOUR)).toBe(false)
		expect(big.latched("d1", NOW + HOUR)).toBe(true)
	})

	// Feature: noise-recordings, Property 5: the gate latch is closed for 24 h after the last judged read that reached the gate
	// Validates: Requirements 1
	it("property: latched() holds exactly while under 24 h passed since the last note that left 15 or more reads in its rolling hour", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						d: fc.constantFrom("a", "b"),
						dt: fc.oneof(
							fc.integer({ min: 0, max: 5 * MIN }),
							fc.integer({ min: 0, max: 30 * HOUR }),
						),
						judged: fc.boolean(),
					}),
					{ maxLength: 120 },
				),
				events => {
					const rate = new DiscoveryNoiseRate()
					const reads = new Map<string, number[]>()
					const reached = new Map<string, number>()
					let now = NOW
					for (const e of events) {
						now += e.dt
						const live = (reads.get(e.d) ?? []).filter(at => now - at < HOUR)
						const last = reached.get(e.d)
						expect(rate.before(e.d, now)).toBe(
							Math.min(live.length, DISCOVERY_NOISE_GATE + 1),
						)
						expect(rate.latched(e.d, now)).toBe(
							last !== undefined && now - last < DAY,
						)
						if (!e.judged) continue
						rate.note(e.d, now)
						reads.set(e.d, [...live, now])
						if (live.length + 1 >= DISCOVERY_NOISE_GATE) reached.set(e.d, now)
						expect(rate.stored(e.d)).toBeLessThanOrEqual(
							DISCOVERY_NOISE_GATE + 1,
						)
						expect(rate.size).toBeLessThanOrEqual(2)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("what counts in the noise-read rate (FinishPath.noiseCounted, noiseRateCounts)", () => {
	const q = (
		quietedPeriodicShare: number | null,
		quietedRun: boolean,
		periodicShare = 0.01,
	) =>
		({
			enabled: true,
			noise: true,
			periodicShare,
			quieting: { quietedPeriodicShare, quietedRun },
		}) as const

	it("a voice-like file (quieted share at or over 0.10, or a quieted run) is not counted; its verdict is unchanged", () => {
		for (const reads of [0, DISCOVERY_NOISE_GATE])
			for (const room of [true, false]) {
				const at = (admission: FinishInput["admission"]) =>
					finishPath({
						...base,
						prior: proven,
						admission,
						noiseEvidence: room,
						discoveryNoiseReads: reads,
					})
				const gated = reads >= DISCOVERY_NOISE_GATE
				const judged = gated
					? room
						? "noise-evidence"
						: "noise"
					: "prior-none"
				for (const [admission, counted] of [
					[q(0.1, false), false],
					[q(0.4, false), false],
					[q(0.05, true), false],
					[q(null, true), false],
					[q(0.099, false), true],
					[q(null, false), true],
					[noise(0.01), true],
				] as const) {
					const p = at(admission)
					expect(p.reason).toBe(judged)
					expect(p.noiseCounted).toBe(counted)
				}
			}
		expect(noiseRateCounts(q(0.1, false))).toBe(false)
		expect(noiseRateCounts(q(0.0999, false))).toBe(true)
		expect(noiseRateCounts(q(null, true))).toBe(false)
		expect(noiseRateCounts(noise(0.01))).toBe(true)
		expect(noiseRateCounts({ ...noise(0.01), quieting: null })).toBe(true)
	})

	it("counted only where the proven-channel rule judges: not off a proven channel, with a joined voice, a decoded tone, own tone, an own decode, or both shares pitched", () => {
		const judged = noise(0.01)
		expect(
			finishPath({ ...base, prior: proven, admission: judged }).noiseCounted,
		).toBe(true)
		const not: FinishInput[] = [
			{ ...base, prior: unproven, admission: judged },
			{ ...base, prior: null, admission: judged },
			{ ...base, prior: proven, joinedVoice: true, admission: judged },
			{ ...base, prior: proven, decodedTone: true, admission: judged },
			{ ...base, prior: proven, ownTone: true, admission: judged },
			{ ...base, prior: proven, decodedOwn: true, admission: judged },
			{ ...base, prior: proven, admission: q(0.2, false, 0.2) },
			{ ...base, prior: proven, admission: { ...judged, enabled: false } },
			{ ...base, prior: proven, admission: { ...judged, noise: false } },
			{ ...base, prior: proven },
		]
		for (const input of not) expect(finishPath(input).noiseCounted).toBe(false)
	})

	// Feature: noise-recordings, Property 6: a file counts exactly when the proven-channel rule judges it and it is not voice-like
	// Validates: Requirements 1
	it("property: noiseCounted is proven ∧ no joined voice ∧ no tone ∧ noiseRuleJudges ∧ noiseRateCounts, and never changes the verdict", () => {
		fc.assert(
			fc.property(
				fc.record({
					proven: fc.boolean(),
					joined: fc.boolean(),
					tone: fc.boolean(),
					noise: fc.boolean(),
					whole: fc.option(fc.double({ min: 0, max: 1, noNaN: true })),
					qShare: fc.option(fc.double({ min: 0, max: 1, noNaN: true })),
					run: fc.boolean(),
					reads: fc.integer({ min: 0, max: 20 }),
					latched: fc.boolean(),
					room: fc.boolean(),
				}),
				r => {
					const admission = {
						enabled: true,
						noise: r.noise,
						periodicShare: r.whole,
						quieting: { quietedPeriodicShare: r.qShare, quietedRun: r.run },
					}
					const input: FinishInput = {
						...base,
						prior: r.proven ? proven : unproven,
						joinedVoice: r.joined,
						decodedTone: r.tone,
						admission,
						discoveryNoiseReads: r.reads,
						discoveryNoiseLatched: r.latched,
						noiseEvidence: r.room,
					}
					const p = finishPath(input)
					expect(p.noiseCounted).toBe(
						r.proven &&
							!r.joined &&
							!r.tone &&
							noiseRuleJudges(admission, false) &&
							noiseRateCounts(admission),
					)
					// The same input without the quieting run or share flags reads the same verdict
					// whenever the rule judged it: counting never moves a verdict.
					const unquieted = finishPath({
						...input,
						admission: {
							...admission,
							quieting: { quietedPeriodicShare: r.qShare, quietedRun: false },
						},
					})
					expect(unquieted.reason).toBe(p.reason)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("noiseRateLog: the count before the file and the latch, numbers and booleans only", () => {
		expect(
			noiseRateLog({ noiseReadsBefore: 15, noiseLatchedBefore: true }),
		).toEqual({
			discoveryNoiseReads: 15,
			latched: true,
		})
		expect(
			noiseRateLog({ noiseReadsBefore: null, noiseLatchedBefore: false }),
		).toEqual({
			discoveryNoiseReads: null,
			latched: false,
		})
	})
})

describe("the noise-rate map bound keeps latched discoveries (DiscoveryNoiseRate)", () => {
	const reach = (rate: DiscoveryNoiseRate, d: string, from: number) => {
		for (let i = 0; i < DISCOVERY_NOISE_GATE; i++) rate.note(d, from + i)
	}

	it("past the cap the least recently noted unlatched entry goes first, even when it is newer than latched ones", () => {
		const rate = new DiscoveryNoiseRate(DISCOVERY_NOISE_GATE, 3)
		reach(rate, "x", NOW) // latched, oldest
		rate.note("y", NOW + 100) // unlatched
		reach(rate, "z", NOW + 200) // latched
		rate.note("w", NOW + 300)
		expect(rate.size).toBe(3)
		expect(rate.before("y", NOW + 400)).toBe(0)
		expect(rate.latched("x", NOW + 400)).toBe(true)
		expect(rate.latched("z", NOW + 400)).toBe(true)
		expect(rate.before("w", NOW + 400)).toBe(1)
	})

	it("an entry whose latch expired is no longer kept; a newer unlatched entry goes before older latched ones; all latched: the least recently noted goes, never the one just noted", () => {
		const rate = new DiscoveryNoiseRate(DISCOVERY_NOISE_GATE, 3)
		reach(rate, "old", NOW)
		const later = NOW + DISCOVERY_NOISE_LATCH_MS - HOUR
		reach(rate, "a", later)
		reach(rate, "b", later + 100)
		const t = NOW + DISCOVERY_NOISE_LATCH_MS + 100
		// "old"'s latch expired (its times long gone): dropped, a and b still latched.
		rate.note("c", t)
		expect(rate.size).toBe(3)
		expect(rate.latched("old", t)).toBe(false)
		expect(rate.latched("a", t)).toBe(true)
		expect(rate.latched("b", t)).toBe(true)
		// The new "d" evicts c (the least recently noted unlatched), not the older latched a.
		rate.note("d", t + 1)
		expect(rate.size).toBe(3)
		expect(rate.before("c", t + 2)).toBe(0)
		expect(rate.latched("a", t + 2)).toBe(true)
		expect(rate.before("d", t + 2)).toBe(1)
		// All others latched: "d" stays, the least recently noted latched one ("a") goes.
		const full = new DiscoveryNoiseRate(DISCOVERY_NOISE_GATE, 2)
		reach(full, "p", NOW)
		reach(full, "q", NOW + 100)
		full.note("r", NOW + 200)
		expect(full.size).toBe(2)
		expect(full.latched("p", NOW + 300)).toBe(false)
		expect(full.latched("q", NOW + 300)).toBe(true)
		expect(full.before("r", NOW + 300)).toBe(1)
	})

	// Feature: noise-recordings, Property 7: past the cap a latched discovery is forgotten only when every other entry is latched
	// Validates: Requirements 1
	it("property: the map stays at its cap and a latched discovery is dropped only while no other entry is unlatched", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						d: fc.constantFrom("a", "b", "c", "d", "e"),
						burst: fc.boolean(),
						dt: fc.integer({ min: 0, max: 2 * HOUR }),
					}),
					{ maxLength: 40 },
				),
				events => {
					const rate = new DiscoveryNoiseRate(DISCOVERY_NOISE_GATE, 3)
					let now = NOW
					for (const e of events) {
						now += e.dt
						const latchedBefore = ["a", "b", "c", "d", "e"].filter(
							id => id !== e.d && rate.latched(id, now),
						)
						const n = e.burst ? DISCOVERY_NOISE_GATE : 1
						for (let i = 0; i < n; i++) rate.note(e.d, now + i)
						now += n
						expect(rate.size).toBeLessThanOrEqual(3)
						const lost = latchedBefore.filter(id => !rate.latched(id, now))
						// One note drops at most one entry; a latched one only when all others were latched.
						if (lost.length > 0)
							expect(latchedBefore.length).toBeGreaterThanOrEqual(2)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
