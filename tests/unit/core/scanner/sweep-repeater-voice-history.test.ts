/**
 * Carrier evidence never caps a frequency with verified voice history, through the production
 * composition (runScene): a repeater whose idle carrier earned carrier evidence (watched on air
 * without a break, then faded) and then sends a 29 s ID has the ID recorded as one whole WAV, the
 * hop held to its end in a sweep, on the first catch since the evidence: the recorder's voiced,
 * classed session there is the history (VoiceOnAir.recordedHz). Without it (the same answers with
 * the session's frequency removed: a bare voice answer) the carrier rules cut it. Synthetic signals
 * only; a report's numbers, no wall clock.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidebandAnalogRecorder } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { runScene, type SceneReport } from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const HOPS = [CENTRE_HZ, CENTRE_HZ + 800_000, CENTRE_HZ + 1_598_000]
const SIGNAL_HZ = HOPS[1]! + 100_437
const SIGNAL_HOP = 1
const SETTLE_MS = 1_000
/** A carrier watch (CARRIER_WATCH_MS) and its gap: a hold this long gave carrier evidence. */
const WATCH_MS = 8_000
const WATCH_END_MS = 9_050
/** The idle carrier, on air from the start (its onset unseen), then gone. */
const IDLE = { fromMs: 0, toMs: 12_000 }
/** The ID, 29 s, keyed after the carrier faded. */
const ID = { fromMs: 20_000, toMs: 49_000 }
/** L on 3 hops of 1150 ms: 28 000 − 4600 − 5000. */
const L_MS = 18_400
/**
 * A voice hold falls back at most this long after the last word (VOICE_QUIET_PAST_L_MS), and the
 * report reads the tune and the two chunks around it.
 */
const FALL_BACK_MS = 1_000 + 500 + 1_100 + 250 + 100

const scene = () =>
	runScene({
		centreHz: CENTRE_HZ,
		ranges: [RANGE],
		settleMs: SETTLE_MS,
		durationMs: ID.toMs + 9_000,
		emitters: [
			{ hz: SIGNAL_HZ, kind: "carrier", ...IDLE, amp: 0.125 },
			{ hz: SIGNAL_HZ, kind: "voice", ...ID, amp: 0.125 },
		],
		targets: [{ hz: SIGNAL_HZ, ...ID }],
	})

const holdsOn = (r: SceneReport) =>
	r.holds.filter(h => h.hopIndex === SIGNAL_HOP)

afterEach(() => {
	vi.restoreAllMocks()
})

describe("a repeater that earned carrier evidence, then a 29 s ID", () => {
	it("the ID is one whole WAV, its hop held to the ID's end", async () => {
		const r = await scene()
		expect(r.hops).toEqual(HOPS)
		const holds = holdsOn(r)
		// The idle carrier's watch: carrier evidence before the ID.
		expect(holds[0]!.ms).toBeGreaterThan(WATCH_MS)
		expect(holds[0]!.ms).toBeLessThan(WATCH_END_MS)
		// The hold that caught the ID listened from its landing past the ID's end.
		const caught = holds.find(h => h.atMs >= IDLE.toMs)!
		const heardTo = caught.atMs + SETTLE_MS + caught.ms
		expect(caught.atMs).toBeLessThan(ID.fromMs + 2_000)
		expect(heardTo).toBeGreaterThanOrEqual(ID.toMs)
		expect(heardTo).toBeLessThanOrEqual(ID.toMs + FALL_BACK_MS)
		const [t] = r.targets
		expect(t!.wavSeconds).toHaveLength(1)
		expect(t!.wavSeconds[0]).toBeGreaterThan(
			(ID.toMs - caught.atMs - SETTLE_MS) / 1000,
		)
		expect(r.unpaidSweeps).toBe(0)
	}, 300_000)

	it("a bare voice answer (no recorded session named) is no history: the carrier rules cut the ID", async () => {
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
		const r = await scene()
		const [t] = r.targets
		expect(t!.wavSeconds.length).toBeGreaterThan(1)
		for (const s of t!.wavSeconds) expect(s).toBeLessThan(L_MS / 1000)
		for (const h of holdsOn(r).filter(x => x.atMs >= IDLE.toMs))
			expect(h.ms).toBeLessThan(L_MS)
	}, 300_000)
})
