/**
 * A sweep kept for a voiced analog recording (scheduler RecordingActivity VoiceOnAir: voice on air
 * in the current transmission, named by the recorder): the hold may run until that transmission ends, up to
 * `hold.maxHoldMs`, not L, so a 28 s ID is recorded whole ("record whole voice"); a full coarse
 * sweep follows before the hop gets another voice hold. A recording that
 * is not voice (true) keeps L; no recording (a carrier or unvoiced signal: the recorder answers
 * false) and a recording only of frequencies with carrier evidence never keep the hop.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	type RecordingActivity,
	type SchedulerAction,
	SweepScheduler,
} from "../../../../src/core/scanner/scheduler.js"
import { simulateSweep } from "../../../../src/core/scanner/plan/sweep-sim.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const MHZ = 1_000_000
const HALF_SPAN_HZ = 409_600
const centres = (n: number): number[] =>
	Array.from({ length: n }, (_, i) => 150 * MHZ + i * 800_000)
const SETTLE_MS = 1_000
const BLOCK_MS = 50
const DWELL_MS = SETTLE_MS + 3 * BLOCK_MS
const PROBE_START_MS = 300
const HZ = 149.9 * MHZ
/** L on 2 hops (docs/SCANNER.md, Fair holds): 28 000 − 3450 − 5000. */
const L2 = 19_550
/** L on 3 hops: 28 000 − 4600 − 5000. */
const L3 = 18_400

const sighting = (id: string, hz = HZ): TrackSnapshot => ({
	...makeTrack({ id, centreHz: hz, startedAt: 0 }),
	trackId: id,
})
const tunes = (a: SchedulerAction[]): boolean => a.some(x => x.type === "tune")
/**
 * The recorder's answer: voice on air in transmission `id` (VoiceOnAir), from a session on `hz`
 * (VoiceOnAir.targetHz: the held track's frequency names its own transmission).
 */
const voice = (id = "a", hz = HZ): RecordingActivity => ({
	voice: id,
	targetHz: hz,
})
const VOICE = voice()

/**
 * 2 hops of DWELL_MS; one track "a" (neither probed nor followed) on hop 0; returns at the end of
 * hop 0's dwell (clock 150), where the hop is left or kept for the recording.
 */
function make(recording: () => RecordingActivity, maxHoldMs = 60_000) {
	let clock = 0
	const s = new SweepScheduler(
		makeHopPlan(centres(2), HALF_SPAN_HZ),
		makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			revisit: { share: 0, maxIntervalMs: null },
			hold: {
				...makeNormalisedSpec({}).hold,
				maxHoldMs,
			},
		}),
		{
			blockSamples: 50,
			sampleRateHz: 1000,
			now: () => clock,
			probeStartMs: PROBE_START_MS,
			recordingActive: recording,
		},
	)
	s.start()
	s.onEpochStarted(0)
	s.onTrack(sighting("a"), false, 0)
	const decided: SchedulerAction[] = []
	for (let e = 50; e <= 150; e += 50) {
		clock = e
		decided.push(...s.onBlock(e))
	}
	return {
		s,
		decided,
		tick: (ms: number) => {
			clock = ms
			return s.tick(ms)
		},
	}
}

/** Clock of the first tune at or after `from`, ticking every 50 ms up to `until`. */
function leftAt(
	tick: (ms: number) => SchedulerAction[],
	from: number,
	until: number,
): number | null {
	for (let ms = from; ms <= until; ms += 50) if (tunes(tick(ms))) return ms
	return null
}

describe("a hop kept for a voiced analog recording", () => {
	it("runs past L (2 hops: 150 + 19 550 = 19 700) up to hold.maxHoldMs (150 + 60 000 = 60 150): kept at 60 149, left at 60 150", () => {
		const { s, decided, tick } = make(() => VOICE)
		expect(tunes(decided)).toBe(false)
		expect(s.progress().holdingOn).toBe("a")
		expect(leftAt(tick, 200, 150 + L2)).toBeNull()
		expect(leftAt(tick, 150 + L2 + 50, 60_100)).toBeNull()
		expect(tunes(tick(60_149))).toBe(false)
		const left = tick(60_150)
		expect(tunes(left)).toBe(true)
		expect(left.some(x => x.type === "stop-probes")).toBe(true)
	})

	it("a shorter hold.maxHoldMs bounds it (30 000: kept at 30 149, left at 30 150)", () => {
		const { tick } = make(() => VOICE, 30_000)
		expect(leftAt(tick, 200, 30_100)).toBeNull()
		expect(tunes(tick(30_149))).toBe(false)
		expect(tunes(tick(30_150))).toBe(true)
	})

	it("is left at the first re-check that finds the recording ended (a 28 s ID ending at 28 150: left at 28 150 + 250 at most)", () => {
		let clock = 0
		const h = make(() => (clock < 28_150 ? VOICE : false))
		const tick = (ms: number) => {
			clock = ms
			return h.tick(ms)
		}
		const at = leftAt(tick, 200, 70_000)
		expect(at).not.toBeNull()
		expect(at!).toBeGreaterThanOrEqual(28_150)
		expect(at!).toBeLessThanOrEqual(28_150 + 250)
	})

	it("a recording that is not voice (true) still ends at L (19 700)", () => {
		const { tick } = make(() => true)
		expect(leftAt(tick, 200, 70_000)).toBe(150 + L2)
	})

	it("a voice hold whose recording stops being voice (true) falls back to L (19 700): kept before 19 700, left by the next re-check", () => {
		let clock = 0
		const h = make(() => (clock < 10_000 ? VOICE : true))
		const tick = (ms: number) => {
			clock = ms
			return h.tick(ms)
		}
		const at = leftAt(tick, 200, 70_000)
		expect(at).not.toBeNull()
		expect(at!).toBeGreaterThanOrEqual(150 + L2)
		expect(at!).toBeLessThanOrEqual(150 + L2 + 250)
	})

	it("no recording (a carrier or an unvoiced signal: the recorder answers false) never keeps the hop", () => {
		const { s, decided } = make(() => false)
		expect(tunes(decided)).toBe(true)
		expect(s.progress().holdingOn).toBeNull()
	})

	it("a voiced recording only of a frequency with carrier evidence never keeps the hop", () => {
		let clock = 0
		const s = new SweepScheduler(
			makeHopPlan(centres(2), HALF_SPAN_HZ),
			makeNormalisedSpec({
				dwellMs: DWELL_MS,
				settleMs: SETTLE_MS,
				revisit: { share: 0, maxIntervalMs: null },
			}),
			{
				blockSamples: 50,
				sampleRateHz: 1000,
				now: () => clock,
				probeStartMs: PROBE_START_MS,
				recordingActive: () => VOICE,
			},
		)
		s.start()
		s.onEpochStarted(0)
		s.onTrack(sighting("c"), false, 0, { followOnAir: true })
		const memory = (
			s as unknown as { memory: { centreHz: number; evidence: string }[] }
		).memory.find(m => m.centreHz === HZ)!
		memory.evidence = "carrier"
		// The carrier hold on "c" runs from the dwell end (150) to 2450, then the hop is left.
		let tunedAt: number | null = null
		for (let ms = 50; ms <= 70_000 && tunedAt === null; ms += 50) {
			clock = ms
			if (tunes([...s.tick(ms), ...s.onBlock(ms)])) tunedAt = ms
		}
		expect(tunedAt).toBe(2_450)
	})
})

describe("a voiced recording hold in a sweep", () => {
	// Feature: scanner record whole voice, Property 1: a voiced analog recording keeps its hop at most hold.maxHoldMs
	// from the start of the visit's holds; past one coarse sweep it locks the next long follow, so
	// every other hop is visited before that hop is kept again; a recording that is not voice keeps L
	// (at most 19 550 ms on 2 to 7 hops).
	// Validates: sweep record hold, fair holds (the stated exception)
	it("holds at most maxHoldMs and every other hop is visited before the hop is kept again", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 7 }),
				fc.integer({ min: 20_000, max: 60_000 }),
				fc.integer({ min: 5_000, max: 40_000 }),
				fc.integer({ min: 10_000, max: 70_000 }),
				fc.boolean(),
				(hops, maxHoldMs, startMs, lengthMs, voiced) => {
					const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
					const spec = makeNormalisedSpec({
						dwellMs: DWELL_MS,
						settleMs: SETTLE_MS,
						revisit: { share: 0, maxIntervalMs: null },
						hold: { ...makeNormalisedSpec({}).hold, maxHoldMs },
					})
					const answer: RecordingActivity = voiced ? VOICE : true
					const r = simulateSweep(plan, spec, {
						settleMs: SETTLE_MS,
						blockMs: BLOCK_MS,
						minSurfaceBlocks: 2,
						probeStartMs: PROBE_START_MS,
						durationMs: 200_000,
						signals: [],
						recordingActive: (ms, hop) =>
							hop === 0 && ms >= startMs && ms < startMs + lengthMs
								? answer
								: false,
					})
					const bound = voiced ? maxHoldMs : Math.min(maxHoldMs, L2)
					const kept = r.visits.filter(
						v => v.leftAtMs - v.tunedAtMs > DWELL_MS + BLOCK_MS,
					)
					for (const v of kept) {
						expect(v.hopIndex).toBe(0)
						expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
							DWELL_MS + bound + BLOCK_MS,
						)
					}
					// After a visit kept past one coarse sweep, hop 0 is kept again only after every
					// other hop's visit.
					const sweepMs = hops * DWELL_MS
					for (let k = 0; k < kept.length - 1; k++) {
						if (kept[k]!.leftAtMs - kept[k]!.tunedAtMs - DWELL_MS <= sweepMs)
							continue
						const between = r.visits.filter(
							v =>
								v.tunedAtMs >= kept[k]!.leftAtMs &&
								v.leftAtMs <= kept[k + 1]!.tunedAtMs,
						)
						const seen = new Set(between.map(v => v.hopIndex))
						for (let h = 1; h < hops; h++) expect(seen.has(h)).toBe(true)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("a 28 s voiced recording on 3 hops is held whole (heard from its first kept visit to its end), a non-voice one is cut at L (18 400)", () => {
		const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
		const spec = makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			revisit: { share: 0, maxIntervalMs: null },
		})
		const run = (answer: RecordingActivity) =>
			simulateSweep(plan, spec, {
				settleMs: SETTLE_MS,
				blockMs: BLOCK_MS,
				minSurfaceBlocks: 2,
				probeStartMs: PROBE_START_MS,
				durationMs: 120_000,
				signals: [],
				recordingActive: (ms, hop) =>
					hop === 0 && ms >= 20_000 && ms < 48_000 ? answer : false,
			})
		const firstKept = (r: ReturnType<typeof run>) =>
			r.visits.find(
				v => v.hopIndex === 0 && v.leftAtMs - v.tunedAtMs > 2 * DWELL_MS,
			)!
		const voiced = firstKept(run(VOICE))
		expect(voiced.leftAtMs).toBeGreaterThanOrEqual(48_000)
		expect(voiced.leftAtMs).toBeLessThanOrEqual(48_000 + 250 + BLOCK_MS)
		const plain = firstKept(run(true))
		expect(plain.leftAtMs - plain.tunedAtMs).toBe(DWELL_MS + L3)
	})
})

describe("record whole voice: a spent voice hold forces a full coarse sweep", () => {
	const spec2 = makeNormalisedSpec({
		dwellMs: DWELL_MS,
		settleMs: SETTLE_MS,
		revisit: { share: 0, maxIntervalMs: null },
	})
	const run = (
		recording: (ms: number, hop: number | null) => RecordingActivity,
	) =>
		simulateSweep(makeHopPlan(centres(2), HALF_SPAN_HZ), spec2, {
			settleMs: SETTLE_MS,
			blockMs: BLOCK_MS,
			minSurfaceBlocks: 2,
			probeStartMs: PROBE_START_MS,
			durationMs: 12_000,
			signals: [],
			recordingActive: recording,
		})

	it("a voice hold shorter than one sweep (1150 to 1650 ms) still forces the sweep: hop 1 is visited, then hop 0's next coarse visit holds the next over", () => {
		// Voice on air on hop 0 from 1100 to 1650 ms (one short over), then again from 2800 ms on
		// (the next over of the QSO). The first hold ends at the re-check that finds it gone
		// (1650 ms); hop 1 is visited, which is the whole sweep on 2 hops; hop 0's next coarse visit
		// (2800 ms) keeps the hop for the new transmission.
		const r = run((ms, hop) =>
			hop === 0 && ((ms >= 1_100 && ms < 1_650) || ms >= 2_800) ? VOICE : false,
		)
		const zero = r.visits.filter(v => v.hopIndex === 0)
		expect(zero[0]).toMatchObject({ tunedAtMs: 0, leftAtMs: 1_650 })
		expect(r.visits[1]!.hopIndex).toBe(1)
		expect(zero[1]!.tunedAtMs).toBe(2_800)
		expect(zero[1]!.leftAtMs - zero[1]!.tunedAtMs).toBeGreaterThan(2 * DWELL_MS)
	})

	it("voice, then a carrier with no voice (true), then voice again in the same visit: the hold is spent and keeps L only (2 hops: left at 150 + 19 550 = 19 700)", () => {
		let clock = 0
		const h = make(() => (clock < 5_000 ? VOICE : clock < 8_000 ? true : VOICE))
		const tick = (ms: number) => {
			clock = ms
			return h.tick(ms)
		}
		const at = leftAt(tick, 200, 70_000)
		expect(at).not.toBeNull()
		expect(at!).toBeGreaterThanOrEqual(150 + L2)
		expect(at!).toBeLessThanOrEqual(150 + L2 + 250)
	})

	it("voice past L, then a carrier with no voice (true): left at the first re-check after the voice is gone (30 000 to 30 250 ms), not at hold.maxHoldMs (60 150)", () => {
		let clock = 0
		const h = make(() => (clock < 30_000 ? VOICE : true))
		const tick = (ms: number) => {
			clock = ms
			return h.tick(ms)
		}
		const at = leftAt(tick, 200, 70_000)
		expect(at).not.toBeNull()
		expect(at!).toBeGreaterThanOrEqual(30_000)
		expect(at!).toBeLessThanOrEqual(30_250)
	})
})

describe("record whole voice: the voice hold ends with its transmission whatever hold runs", () => {
	/**
	 * A voice hold on "a" from 150 ms; an unrelated track "b" on hop 0 needing a 5000 ms confirm
	 * is seen at 300 ms, so the 400 ms re-check starts its probe (to 400 + 300 + 5000 = 5700 ms).
	 * "a" closes at 2000 ms (the recorder answers false from then) and "a2" opens on the same
	 * frequency at 4000 ms, voiced from 5500 ms (the recorder names it "a2"). The close and
	 * turnaround fall inside b's probe; the voice hold is still spent there, so the hop keeps
	 * only L (150 + 19 550 = 19 700) and hop 1 gets its coarse visit before hop 0 is kept again.
	 * `stalled`: the event loop stalls from 1950 to 5600 ms (no tick, block or track event runs;
	 * the close and a2's sighting are delivered at 5600), so the scheduler never sees the false
	 * answers, only "a2" named after the stall.
	 */
	function drive(trackSampled: boolean, stalled = false) {
		let clock = 0
		let hop = 0
		const asked: { at: number; answer: RecordingActivity }[] = []
		const recording = (): RecordingActivity => {
			const answer: RecordingActivity =
				hop !== 0
					? false
					: clock < 2_000
						? voice("a")
						: clock >= 5_500
							? voice("a2")
							: false
			asked.push({ at: clock, answer })
			return answer
		}
		const h = make(recording)
		const s = h.s
		const visits: { hop: number; tunedAt: number; leftAt: number | null }[] = [
			{ hop: 0, tunedAt: 0, leftAt: null },
		]
		let settleAt: number | null = null
		const apply = (a: SchedulerAction[]) => {
			for (const x of a)
				if (x.type === "tune") {
					visits[visits.length - 1]!.leftAt = clock
					hop = x.hopIndex
					visits.push({ hop, tunedAt: clock, leftAt: null })
					settleAt = clock + SETTLE_MS
				}
		}
		for (let ms = 200; ms <= 40_000; ms += 50) {
			if (stalled && ms > 1_950 && ms < 5_600) continue
			clock = ms
			if (settleAt !== null) {
				if (ms < settleAt) {
					apply(s.tick(ms))
					continue
				}
				settleAt = null
				apply(s.onEpochStarted(ms))
				// Hop 0's open tracks show again on its later visits.
				if (hop === 0 && ms >= 4_000) {
					apply(s.onTrack(sighting("a2"), false, 0))
					apply(s.onTrack(sighting("b", HZ + 200_000), true, 5_000))
				}
				continue
			}
			if (hop === 0 && ms === 300)
				apply(s.onTrack(sighting("b", HZ + 200_000), true, 5_000))
			const closeAt = stalled ? 5_600 : 2_000
			if (hop === 0 && ms === closeAt && trackSampled)
				apply(s.onTrackClosed("a"))
			if (hop === 0 && ms === (stalled ? 5_600 : 4_000))
				apply(s.onTrack(sighting("a2"), false, 0))
			apply(s.onBlock(ms))
			apply(s.tick(ms))
		}
		return { visits, asked }
	}

	const expectSweepAfter = (visits: ReturnType<typeof drive>["visits"]) => {
		const first = visits[0]!
		expect(first.leftAt).not.toBeNull()
		expect(first.leftAt!).toBeLessThanOrEqual(150 + L2)
		// The coarse sweep runs: hop 1 next, and only then may hop 0 hold its next transmission.
		expect(visits[1]!.hop).toBe(1)
		const nextZero = visits.findIndex((v, i) => i > 0 && v.hop === 0)
		expect(nextZero).toBeGreaterThan(1)
	}

	for (const closeSeen of [true, false])
		it(`record → b's probe → "a" closes → "a2" voiced: left by L (19 700), hop 1 visited before hop 0 is kept again (close ${closeSeen ? "seen" : "not seen"} by the scheduler)`, () => {
			const { visits, asked } = drive(closeSeen)
			// The recorder was asked during the probe, so its false answers (2000 to 5500 ms) were seen.
			expect(asked.some(a => a.at >= 2_000 && a.at < 5_500)).toBe(true)
			expectSweepAfter(visits)
		})

	for (const closeSeen of [true, false])
		it(`the same turnaround hidden by an event-loop stall (1950 to 5600 ms): "a2" named after the stall ends the hold; left by L (19 700), hop 1 visited before hop 0 is kept again (close ${closeSeen ? "seen" : "not seen"})`, () => {
			const { visits, asked } = drive(closeSeen, true)
			expect(asked.some(a => a.at > 1_950 && a.at < 5_600)).toBe(false)
			expect(asked.some(a => a.at >= 5_600 && a.answer !== false)).toBe(true)
			expectSweepAfter(visits)
		})

	/** Ticks every 50 ms from 200 to `from`, skips to `to` (a stall), then to the hop's leave. */
	function stallOnce(
		recording: () => RecordingActivity,
		from: number,
		to: number,
	) {
		const h = make(recording)
		for (let ms = 200; ms <= from; ms += 50)
			expect(tunes(h.tick(ms))).toBe(false)
		return leftAt(h.tick, to, 70_000)
	}

	it("an event-loop stall over 500 ms (600 ms) during one over keeps the voice hold: left at hold.maxHoldMs (60 150)", () => {
		expect(stallOnce(() => VOICE, 5_000, 5_600)).toBe(60_150)
	})

	it("a 2 s event-loop stall during one over keeps the voice hold: left at hold.maxHoldMs (60 150)", () => {
		expect(stallOnce(() => VOICE, 5_000, 7_000)).toBe(60_150)
	})

	it("a stall across which the voiced transmission changes (a turnaround, a then b) spends the voice hold: L only (19 700 to 19 950)", () => {
		let clock = 0
		const h = make(() => voice(clock < 6_000 ? "a" : "b"))
		for (let ms = 200; ms <= 5_000; ms += 50) {
			clock = ms
			expect(tunes(h.tick(ms))).toBe(false)
		}
		let at: number | null = null
		for (let ms = 7_000; ms <= 70_000 && at === null; ms += 50) {
			clock = ms
			if (tunes(h.tick(ms))) at = ms
		}
		expect(at).not.toBeNull()
		expect(at!).toBeGreaterThanOrEqual(150 + L2)
		expect(at!).toBeLessThanOrEqual(150 + L2 + 250)
	})
})
