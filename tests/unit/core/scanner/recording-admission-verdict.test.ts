/**
 * finishPath's recording admission row (recording-verdict.ts, `FinishInput.admission`,
 * `discarded:noise`): after own tone, a decode of its own signal, known-non-voice and the
 * no-voice check, before a prior-none keep, under every prior strength (so a weak prior never
 * holds noise), never with a joined voice of another transmission, roll-over files included;
 * disabled, null (not measured) or absent: today's path.
 */
import { describe, expect, it } from "vitest"
import {
	finishPath,
	noiseLog,
	priorReading,
	type FinishInput,
	type VoicePrior,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import type { SpeechContent } from "../../../../src/core/scanner/channel/speech-content.js"

const NOW = 1_700_000_000_000
const NOISE = { enabled: true, noise: true } as const

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
/** A spectral digital class alone: a weak (`suspect`) prior. */
const suspect: VoicePrior = {
	labels: [],
	class: "fsk4-12k5",
	analogVoice: () => false,
}
/** A channel whose analog trials ran 600 times and never heard voice. */
const noVoice: VoicePrior = {
	labels: [],
	class: "analog-fm",
	analogVoice: () => false,
	analogTrials: () => ({ attempts: 600, decoded: 0 }),
}
/** A co-channel decode of another discovery joined the file (joinedOtherVoice). */
const joinedOther: Partial<FinishInput> = {
	joinedVoice: true,
	joinedVoiceIds: ["o-other"],
}

describe("finishPath: the recording admission row", () => {
	// Feature: recording-admission, candidate rule RA-2 (finishPath row).
	it("the priors used read as intended", () => {
		expect(priorReading(null, false, NOW).strength).toBe("none")
		expect(priorReading(suspect, false, NOW).strength).toBe("suspect")
	})

	it("noise beats prior-none: discarded:noise (reason noise)", () => {
		expect(finishPath(base)).toMatchObject({
			verdict: "finish",
			reason: "prior-none",
		})
		expect(finishPath({ ...base, admission: NOISE })).toMatchObject({
			verdict: "discarded:noise",
			reason: "noise",
			strength: "none",
		})
	})

	it("noise beats a hold under a suspect prior, and the final keep at its grace's end", () => {
		const held = { ...base, prior: suspect }
		expect(finishPath(held).verdict).toBe("hold")
		expect(finishPath({ ...held, admission: NOISE }).verdict).toBe(
			"discarded:noise",
		)
		expect(finishPath({ ...held, final: true, admission: NOISE }).verdict).toBe(
			"discarded:noise",
		)
	})

	it("own tone beats noise: kept", () => {
		expect(
			finishPath({ ...base, ownTone: true, admission: NOISE }),
		).toMatchObject({ verdict: "finish", reason: "own-tone" })
	})

	it("a decode of its own signal, known-non-voice and no-voice keep their own codes", () => {
		expect(
			finishPath({ ...base, decodedOwn: true, admission: NOISE }).verdict,
		).toBe("discarded:late-non-voice")
		const strong: VoicePrior = {
			labels: [
				{ protocol: "pocsag", confidence: "decoded", owner: true, at: NOW },
			],
			class: "unknown",
			analogVoice: () => false,
		}
		expect(priorReading(strong, false, NOW).strength).toBe("tone-required")
		expect(
			finishPath({
				...base,
				prior: strong,
				snapshotClassed: false,
				admission: NOISE,
			}).verdict,
		).toBe("discarded:known-non-voice")
		expect(
			finishPath({
				...base,
				prior: noVoice,
				speechHeard: false,
				admission: NOISE,
			}),
		).toMatchObject({ verdict: "discarded:not-speech", reason: "no-voice" })
	})

	it("a joined voice of another transmission keeps the file", () => {
		const p = finishPath({ ...base, ...joinedOther, admission: NOISE })
		expect(p.joinedOther).toBe(true)
		expect(p.verdict).toBe("finish")
	})

	it("a classed session's roll-over file is gated too (its own field, not a speech reading)", () => {
		expect(
			finishPath({ ...base, rollOver: true, admission: NOISE }).verdict,
		).toBe("discarded:noise")
		expect(finishPath({ ...base, rollOver: true }).verdict).toBe("finish")
	})

	it("disabled, not measured (null), not noise or absent: today's path", () => {
		for (const admission of [
			{ enabled: false, noise: true },
			{ enabled: true, noise: null },
			{ enabled: true, noise: false },
			undefined,
		]) {
			const input: FinishInput =
				admission === undefined ? base : { ...base, admission }
			expect(finishPath(input)).toMatchObject({
				verdict: "finish",
				reason: "prior-none",
			})
			expect(finishPath({ ...input, prior: suspect }).verdict).toBe("hold")
		}
	})

	it("noiseLog carries ids and measured numbers only", () => {
		const c: SpeechContent = {
			frames: 300,
			maxRangeDb: 3.456,
			periodicShare: 0.01234,
			maxBurstFrames: 1,
			levelFrames: 290,
			maxWindowSpreadDb: 2.3456,
			minWindowP10Dbfs: -12.3456,
		}
		const path = finishPath({ ...base, admission: NOISE })
		expect(
			noiseLog(
				path,
				c,
				{ handle: { operationId: "op_1" } },
				{ discoveryId: "d_1", targetHz: 100_000_000.4 },
			),
		).toEqual({
			operationId: "op_1",
			discoveryId: "d_1",
			frequencyHz: 100_000_000,
			reason: "noise",
			strength: "none",
			levelFrames: 290,
			spreadDb: 2.35,
			p10Dbfs: -12.35,
			periodicShare: 0.012,
			burstFrames: 1,
		})
	})
})
