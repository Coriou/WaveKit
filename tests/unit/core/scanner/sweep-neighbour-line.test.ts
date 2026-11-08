/**
 * A voice beside a weak steady line, through the production composition (runScene): the line is on
 * air before the voice and stays, and the voice keying up 6 to 10 kHz away joins its track, which
 * then reads wider and centred between them. Each ID is still one file. A wideband signal is still
 * refused: one reading past a 25 kHz channel, and a flat-topped data signal within one. Synthetic
 * signals only; a report's numbers, no wall clock.
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
