/**
 * A voice beside a weak steady line, through the production composition (runScene): the line is on
 * air before the voice and stays, and the voice keying up 6 to 10 kHz away joins its track, which
 * then reads wider and centred between them. Keyed within the line's first watch, the voice is
 * heard at the watch's end, so the line earns no carrier evidence and each ID is one file. Keyed
 * after the line earned it (width is no exception), the voice is recorded whole from its landing
 * only because the recorder recorded a voiced, classed session there (verified voice history,
 * VoiceOnAir.recordedHz); a bare voice answer there is held under the carrier rules, its files
 * within L. A wideband signal is still refused: one reading past a 25 kHz channel, and a
 * flat-topped data signal within one. Synthetic signals only; a report's numbers, no wall clock.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	WIDEBAND_KEPT_WIDE_OBW_HZ,
	WidebandAnalogRecorder,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	runScene,
	type Emitter,
	type SceneTarget,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const HOPS = [CENTRE_HZ, CENTRE_HZ + 800_000, CENTRE_HZ + 1_598_000]
const SIGNAL_HZ = HOPS[1]! + 100_437
const SETTLE_MS = 1_000
/**
 * The voice's level; the lines at 0.02 and 0.04 sit 15.9 and 9.9 dB under it (20 log10 of the ratio).
 * A line only 6 dB under this synthetic voice reads, with it, as two FSK tones (the classifier's
 * `fsk2-wide`): not analog FM, a limit of the classifier, not of the recorder.
 */
const VOICE_AMP = 0.125
const ID = { fromMs: 4_000, toMs: 24_000 }
/** A file is the ID less what the sweep had not landed for yet: its first coarse sweep. */
const MISSED_AT_START_S = 4

const scene = (emitters: Emitter[], targets: SceneTarget[]) =>
	runScene({
		centreHz: CENTRE_HZ,
		ranges: [RANGE],
		settleMs: SETTLE_MS,
		durationMs: ID.toMs + 6_000,
		emitters,
		targets,
	})

describe("a voice beside a steady line", () => {
	for (const offsetHz of [6_000, 8_000, 10_000])
		for (const lineAmp of [0.02, 0.04])
			it(`a line ${offsetHz / 1000} kHz away at ${lineAmp}: the ID is one file`, async () => {
				const r = await scene(
					[
						{ hz: SIGNAL_HZ, kind: "voice", ...ID, amp: VOICE_AMP },
						{
							hz: SIGNAL_HZ + offsetHz,
							kind: "carrier",
							fromMs: 0,
							toMs: ID.toMs + 6_000,
							amp: lineAmp,
						},
					],
					[{ hz: SIGNAL_HZ, ...ID }],
				)
				expect(r.hops).toEqual(HOPS)
				const [t] = r.targets
				expect(t!.wavSeconds).toHaveLength(1)
				expect(t!.wavSeconds[0]).toBeGreaterThan(
					(ID.toMs - ID.fromMs) / 1000 - MISSED_AT_START_S,
				)
			}, 300_000)
})

describe("a voice keyed beside a line that already has carrier evidence", () => {
	/** Keyed after the line's first watch (from about 2.3 to 10.3 s) gave it carrier evidence. */
	const LATE_ID = { fromMs: 14_000, toMs: 34_000 }
	/** L on 3 hops of 1150 ms: 28 000 − 4600 − 5000. */
	const L_MS = 18_400
	const WATCH_MS = 8_000
	const WATCH_END_MS = 9_050
	const lateScene = () =>
		runScene({
			centreHz: CENTRE_HZ,
			ranges: [RANGE],
			settleMs: SETTLE_MS,
			durationMs: LATE_ID.toMs + 12_000,
			emitters: [
				{ hz: SIGNAL_HZ, kind: "voice", ...LATE_ID, amp: VOICE_AMP },
				{
					hz: SIGNAL_HZ + 6_000,
					kind: "carrier",
					fromMs: 0,
					toMs: LATE_ID.toMs + 12_000,
					amp: 0.02,
				},
			],
			targets: [{ hz: SIGNAL_HZ, ...LATE_ID }],
		})
	const signalHolds = (r: Awaited<ReturnType<typeof lateScene>>) =>
		r.holds.filter(h => h.hopIndex === 1)

	it("the recorder's voiced session there is voice history: one file, from its landing to the ID's end", async () => {
		const r = await lateScene()
		const holds = signalHolds(r)
		expect(holds[0]!.ms).toBeGreaterThan(WATCH_MS)
		expect(holds[0]!.ms).toBeLessThan(WATCH_END_MS)
		const caught = holds.find(h => h.atMs >= LATE_ID.fromMs)!
		expect(caught.atMs + SETTLE_MS + caught.ms).toBeGreaterThanOrEqual(
			LATE_ID.toMs,
		)
		const [t] = r.targets
		expect(t!.wavSeconds).toHaveLength(1)
		expect(t!.wavSeconds[0]).toBeGreaterThan(
			(LATE_ID.toMs - caught.atMs - SETTLE_MS) / 1000,
		)
	}, 300_000)

	it("with no voice history (a bare voice answer), it is recorded within L: no file and no hold reaches L", async () => {
		const answer = WidebandAnalogRecorder.prototype.recordingActive
		vi.spyOn(
			WidebandAnalogRecorder.prototype,
			"recordingActive",
		).mockImplementation(function (this: WidebandAnalogRecorder, sourceId, at) {
			const a = answer.call(this, sourceId, at)
			// No session frequency: a bare voice answer, a recording that is not voice.
			if (typeof a !== "object") return a
			return "voice" in a ? { voice: a.voice, quietMs: a.quietMs ?? 0 } : true
		})
		const r = await lateScene()
		const [t] = r.targets
		expect(t!.wavSeconds.length).toBeGreaterThan(0)
		for (const s of t!.wavSeconds) expect(s).toBeLessThan(L_MS / 1000)
		for (const h of signalHolds(r).filter(x => x.atMs >= LATE_ID.fromMs))
			expect(h.ms).toBeLessThan(L_MS)
	}, 300_000)
})

/** What the recorder was given about tracks on the signal's channel during the scene. */
function readings(): TrackSnapshot[] {
	const seen: TrackSnapshot[] = []
	const track = WidebandAnalogRecorder.prototype.track
	vi.spyOn(WidebandAnalogRecorder.prototype, "track").mockImplementation(
		function (this: WidebandAnalogRecorder, input) {
			if (Math.abs(input.track.centreHz - SIGNAL_HZ) < 12_500)
				seen.push(input.track)
			track.call(this, input)
		},
	)
	return seen
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("a wideband signal is still refused", () => {
	it("broadcast-like FM, reading past a 25 kHz channel: no file", async () => {
		const seen = readings()
		const r = await scene(
			[
				{
					hz: SIGNAL_HZ,
					kind: "voice",
					...ID,
					amp: VOICE_AMP,
					speech: { deviationScale: 6 },
				},
			],
			[{ hz: SIGNAL_HZ, ...ID }],
		)
		expect(seen.length).toBeGreaterThan(0)
		expect(seen.every(t => t.obwHz > WIDEBAND_KEPT_WIDE_OBW_HZ)).toBe(true)
		expect(r.wavSeconds).toEqual([])
	}, 300_000)

	it("flat-topped data within a channel: no file", async () => {
		const seen = readings()
		const r = await scene(
			[{ hz: SIGNAL_HZ, kind: "data", ...ID, amp: VOICE_AMP }],
			[{ hz: SIGNAL_HZ, ...ID }],
		)
		expect(seen.length).toBeGreaterThan(0)
		expect(
			seen.some(
				t =>
					t.spectralShape === "flat" &&
					t.obwHz > 16_000 &&
					t.obwHz <= WIDEBAND_KEPT_WIDE_OBW_HZ,
			),
		).toBe(true)
		expect(r.wavSeconds).toEqual([])
	}, 300_000)
})
