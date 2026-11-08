/**
 * Voice through a repeater's hang, and voice with real pauses, through the production composition
 * (runScene): the carrier never closes under a hang, so only the audio can end a hold across a
 * turnaround. Synthetic voice only; a report's numbers, no wall clock.
 */
import { describe, expect, it } from "vitest"
import {
	ids,
	qso,
	runScene,
	type SceneReport,
	type Span,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const HOPS = [CENTRE_HZ, CENTRE_HZ + 800_000, CENTRE_HZ + 1_598_000]
const SIGNAL_HZ = HOPS[1]! + 100_437
const OTHER_HZ = HOPS[2]! - 300_437
const SETTLE_MS = 1_000
const SIGNAL_HOP = 1
/** L on 3 hops of 1150 ms: 28 000 − 4600 − 5000. */
const L_MS = 18_400
/**
 * Past L a hold falls back at most this long after the last word (VOICE_QUIET_PAST_L_MS): judged
 * audio 1000 ms late, the voiced window's 500 ms tail, the first reading past the limit (1100 at
 * most: an ended quiet reads in 100 ms steps) and the 250 ms re-check.
 */
const FALL_BACK_MS = 1_000 + 500 + 1_100 + 250
/** What the tune and the two 25 ms chunks either side of it add to a hold as the report reads it. */
const READ_MS = 100

const heldOn = (r: SceneReport, hop: number) =>
	r.holds.filter(h => h.hopIndex === hop).map(h => h.ms)

const scene = (
	durationMs: number,
	emitters: Parameters<typeof runScene>[0]["emitters"],
	targets: Parameters<typeof runScene>[0]["targets"],
) =>
	runScene({
		centreHz: CENTRE_HZ,
		ranges: [RANGE],
		settleMs: SETTLE_MS,
		durationMs,
		emitters: emitters ?? [],
		targets,
	})

describe("a QSO through a repeater's hang", () => {
	// A 2 s turnaround under a 2.5 s hang: it reads about 1700 ms of quiet, over the 1000 ms limit
	// past L.
	it("the hold ends at the first turnaround past L, the forced sweep runs, and the next hold follows", async () => {
		const OVER_MS = 8_000
		const talk = qso({
			hz: SIGNAL_HZ,
			fromMs: 2_000,
			toMs: 60_000,
			seed: 1,
			overMs: [OVER_MS, OVER_MS],
			replyMs: [2_000, 2_000],
			hangMs: 2_500,
		})
		// One carrier from the first word to the last: the track never closes.
		expect(talk.emitters).toHaveLength(1)
		const r = await scene(
			65_000,
			talk.emitters,
			talk.overs.map(o => ({ hz: SIGNAL_HZ, ...o })),
		)
		expect(r.hops).toEqual(HOPS)
		const holds = heldOn(r, SIGNAL_HOP)
		expect(holds.length).toBeGreaterThanOrEqual(2)
		// L, then the rest of the over it fell in, then the fall-back; never to hold.maxHoldMs.
		for (const ms of holds)
			expect(ms).toBeLessThanOrEqual(L_MS + OVER_MS + FALL_BACK_MS + READ_MS)
		expect(r.unpaidSweeps).toBe(0)
	}, 300_000)

	// A 1.5 s turnaround under a 1.5 s hang, each reply keyed at the hang's end: one carrier from the
	// first word to the last, and a quiet of 1100 to 1600 ms at each turnaround, all over the 1000 ms
	// limit (VOICE_QUIET_PAST_L_MS), so every hold ends at its first turnaround past L and none runs
	// to `hold.maxHoldMs` with nobody talking. A speaker's pause of 1.4 s or more past L reads the same
	// and is cut too (the split file).
	it("1.5 s turnarounds under a 1.5 s hang: each hold ends at its first turnaround past L, never at hold.maxHoldMs", async () => {
		const OVER_MS = 8_000
		const talk = qso({
			hz: SIGNAL_HZ,
			fromMs: 2_000,
			toMs: 60_000,
			seed: 1,
			overMs: [OVER_MS, OVER_MS],
			replyMs: [1_500, 1_500],
			hangMs: 1_500,
		})
		expect(talk.emitters).toHaveLength(1)
		const r = await scene(
			65_000,
			talk.emitters,
			talk.overs.map(o => ({ hz: SIGNAL_HZ, ...o })),
		)
		expect(r.hops).toEqual(HOPS)
		const holds = heldOn(r, SIGNAL_HOP)
		expect(holds.length).toBeGreaterThanOrEqual(2)
		for (const ms of holds)
			expect(ms).toBeLessThanOrEqual(L_MS + OVER_MS + FALL_BACK_MS + READ_MS)
		expect(r.unpaidSweeps).toBe(0)
	}, 300_000)

	// 2 s turnarounds, as above.
	it("an ID on another hop is reached between holds", async () => {
		const talk = qso({
			hz: SIGNAL_HZ,
			fromMs: 2_000,
			toMs: 60_000,
			seed: 2,
			overMs: [5_000, 12_000],
			replyMs: [2_000, 2_000],
			hangMs: 2_500,
		})
		const other = ids({
			hz: OTHER_HZ,
			fromMs: 20_000,
			everyMs: 35_000,
			count: 1,
		})
		const r = await scene(
			65_000,
			[...talk.emitters, ...other],
			other.map(e => ({
				hz: e.hz,
				fromMs: e.fromMs,
				toMs: e.toMs,
			})),
		)
		for (const t of r.targets) expect(t.heardMs).toBeGreaterThan(0)
		expect(r.unpaidSweeps).toBe(0)
	}, 300_000)
})

describe("one voice with real speech pauses", () => {
	const ID_MS = 28_000
	const FROM_MS = 3_000
	/** A pause at `atMs` into the ID, `ms` long. */
	const pause = (atMs: number, ms: number): Span => ({
		fromMs: FROM_MS + atMs,
		toMs: FROM_MS + atMs + ms,
	})
	const oneId = async (pauses: Span[]) => {
		const emitter = {
			hz: SIGNAL_HZ,
			kind: "voice" as const,
			fromMs: FROM_MS,
			toMs: FROM_MS + ID_MS,
			pauses,
		}
		const r = await scene(
			FROM_MS + ID_MS + 8_000,
			[emitter],
			[{ hz: SIGNAL_HZ, fromMs: emitter.fromMs, toMs: emitter.toMs }],
		)
		return r
	}

	it("pauses under the limit past L, and a longer one before L, stay one file", async () => {
		const r = await oneId([
			pause(6_000, 1_600),
			pause(21_000, 600),
			pause(24_000, 500),
		])
		const [t] = r.targets
		expect(t!.wavSeconds).toHaveLength(1)
		expect(t!.wavSeconds[0]).toBeGreaterThan(ID_MS / 1000 - 6)
		expect(heldOn(r, SIGNAL_HOP)).toHaveLength(1)
	}, 300_000)

	it("a pause of 2 s past L ends the hold: the forced sweep runs and the rest is another file", async () => {
		const r = await oneId([pause(21_000, 2_000)])
		const [t] = r.targets
		const holds = heldOn(r, SIGNAL_HOP)
		expect(holds[0]).toBeLessThan(ID_MS - 3_000)
		expect(t!.wavSeconds.length).toBeGreaterThanOrEqual(1)
		expect(r.unpaidSweeps).toBe(0)
	}, 300_000)
})
