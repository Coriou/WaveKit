/**
 * A continuous signal on a channel whose analog trials never heard voice (recording-verdict.ts
 * noVoiceChannel) rolls over every WIDEBAND_MAX_FILE_MS: each roll-over file gets the same speech
 * check as the first one there (finishPath `rollOver`), so a noise carrier is not kept one file at
 * a time once its first file failed, while a continuous voice (with or without CTCSS) keeps every
 * file. Off a no-voice channel a classed session's roll-over file is kept as before.
 */
import { describe, expect, it } from "vitest"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import { WIDEBAND_MAX_FILE_MS } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"
import { FskSource } from "./wideband-nfm-fixtures.js"

type Harness = ReturnType<typeof harness>

const LOW = { centreHz: 100_000_000 + LOW_OFFSET }
/** Three minutes: one full file and a roll-over of 60 s. */
const SCENE_S = 180

const codes = (h: Harness): string[] =>
	h.rec.diagnostics().recent.map(d => d.code)

const analogFm: VoicePrior = {
	labels: [],
	class: "analog-fm",
	analogVoice: () => false,
}
/** The live shape: hundreds of analog trials, none heard, no analog proof. */
const noVoice: VoicePrior = {
	...analogFm,
	analogTrials: () => ({ attempts: 600, decoded: 0 }),
}

const low = (prior: VoicePrior, ctcssHz: number | null = null): Harness =>
	harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		source: { ctcssHz, syllables: true },
		decodedLabel: () => null,
		voicePrior: () => prior,
	})

/** `seconds` of one continuous over by `id` (classed analog-fm by its snapshots), then quiet. */
async function voiceScene(h: Harness, seconds: number): Promise<void> {
	await h.feed(1, false)
	const chunk = h.fs / 40
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	for (let i = 0; i < seconds * 40; i++) {
		h.engine.write(h.src.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs)
			h.rec.track(input("o", snapshot("o", onset, Math.min(edge, end), LOW)))
		await h.pump()
	}
	await h.feed(0.6, false)
	h.rec.closed("o", snapshot("o", onset, end, LOW), null, {
		analogFm: true,
		discoveryId: "d_1",
	})
	await h.feed(3.5, false)
}

/**
 * `seconds` of a continuous 4FSK carrier (it passes the voice gate and measures as no speech:
 * what a no-voice channel's noise looks like to the check), tracked as one analog-fm over.
 */
async function noiseScene(h: Harness, seconds: number): Promise<void> {
	const fsk = new FskSource({
		fs: h.fs,
		offsetHz: LOW_OFFSET,
		levelsHz: [-1_944, -648, 648, 1_944],
	})
	const chunk = h.fs / 40
	let onset = 0
	let end = 0
	const data = async (n: number, track: boolean): Promise<void> => {
		for (let i = 0; i < n; i++) {
			h.engine.write(fsk.next(chunk, true))
			const edge = h.engine.liveEdge()
			if (track && edge - onset >= 0.1 * h.fs)
				h.rec.track(input("o", snapshot("o", onset, Math.min(edge, end), LOW)))
			await h.pump()
		}
	}
	await data(40, false)
	onset = h.engine.liveEdge()
	end = onset + seconds * h.fs
	await data(seconds * 40, true)
	await data(24, false)
	h.rec.closed("o", snapshot("o", onset, end, LOW), null, {
		analogFm: true,
		discoveryId: "d_1",
	})
	await data(140, false)
}

describe("a no-voice channel's continuous signal past the file length limit", () => {
	// Feature: recording-verdict, channels whose trials never heard voice (docs/SCANNER.md).
	it("the file length limit is 120 s (the live roll-over files: 3 750 frames of 32 ms)", () => {
		expect(WIDEBAND_MAX_FILE_MS).toBe(120_000)
	})

	it("3 minutes of continuous noise: no file kept, the first and its roll-over both discarded not-speech", async () => {
		const h = low(noVoice)
		await noiseScene(h, SCENE_S)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
		expect(
			codes(h).filter(c => c === "discarded:not-speech").length,
		).toBeGreaterThanOrEqual(2)
	}, 300_000)

	it("FROZEN: 3 minutes of continuous voice (syllables, pauses, no CTCSS): every file kept", async () => {
		const h = low(noVoice)
		await voiceScene(h, SCENE_S)
		await h.rec.idle()
		expect(h.ops.map(o => [o.cut, o.outcome])).toEqual([
			["duration-limit", "finalized"],
			["completed", "finalized"],
		])
		expect(codes(h)).not.toContain("discarded:not-speech")
	}, 300_000)

	it("FROZEN: the same voice over a CTCSS tone: every file kept", async () => {
		const h = low(noVoice, 88.5)
		await voiceScene(h, SCENE_S)
		await h.rec.idle()
		expect(h.ops.map(o => [o.cut, o.outcome])).toEqual([
			["duration-limit", "finalized"],
			["completed", "finalized"],
		])
	}, 300_000)

	it("FROZEN: continuous voice on a channel that is not no-voice: unchanged, every file kept", async () => {
		const h = low(analogFm)
		await voiceScene(h, SCENE_S)
		await h.rec.idle()
		expect(h.ops.map(o => [o.cut, o.outcome])).toEqual([
			["duration-limit", "finalized"],
			["completed", "finalized"],
		])
	}, 300_000)

	it("off a no-voice channel the noise carrier's roll-over is not content-checked: kept as its classed session", async () => {
		const h = low(analogFm)
		await noiseScene(h, SCENE_S)
		await h.rec.idle()
		expect(h.ops.map(o => [o.cut, o.outcome])).toEqual([
			["duration-limit", "finalized"],
			["completed", "finalized"],
		])
	}, 300_000)
})
