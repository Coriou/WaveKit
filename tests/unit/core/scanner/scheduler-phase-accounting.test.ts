// tests/unit/core/scanner/scheduler-phase-accounting.test.ts
/**
 * Per-hop phases of a visit (hopPhaseStats): they sum to timeMs at any moment, none goes negative,
 * and the accounting changes no action. Clock in ms, 1000 samples/s, so a sample is a ms.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	type HopPhaseStat,
	type SchedulerAction,
	SweepScheduler,
} from "../../../../src/core/scanner/scheduler.js"
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
const BLOCK = 50
/** spec.dwellMs less spec.settleMs: 150 ms of samples, three blocks. */
const SETTLE_PLANNED = 35
const DWELL_PLANNED = 185
const baseSpec = makeNormalisedSpec({
	dwellMs: DWELL_PLANNED,
	settleMs: SETTLE_PLANNED,
})
const track = (id: string, hz: number, blocks = 8): TrackSnapshot => ({
	...makeTrack({ id, centreHz: hz, startedAt: 0 }),
	trackId: id,
	blocks,
})
const HZ_A = 149.9 * MHZ

function scene(
	opts: {
		hops?: number
		policy?: "confirm" | "hold" | "never"
		recording?: () => boolean
	} = {},
) {
	let clock = 0
	const spec = makeNormalisedSpec({
		dwellMs: DWELL_PLANNED,
		settleMs: SETTLE_PLANNED,
		revisit: { share: 0, maxIntervalMs: null },
		hold: { ...baseSpec.hold, policy: opts.policy ?? "confirm" },
	})
	const s = new SweepScheduler(
		makeHopPlan(centres(opts.hops ?? 2), HALF_SPAN_HZ),
		spec,
		{
			blockSamples: BLOCK,
			sampleRateHz: 1000,
			now: () => clock,
			probeStartMs: 300,
			...(opts.recording ? { recordingActive: opts.recording } : {}),
		},
	)
	return {
		s,
		spec,
		at(ms: number) {
			clock = ms
		},
		now: () => clock,
	}
}

function expectAddsUp(stats: readonly HopPhaseStat[]): void {
	for (const h of stats) {
		for (const ms of [
			h.measuredSettleMs,
			h.measuredStaleMs,
			h.measuredDwellMs,
			h.measuredQualifyMs,
			h.holdMs,
			h.overheadMs,
		])
			expect(ms).toBeGreaterThanOrEqual(0)
		expect(
			h.measuredSettleMs +
				h.measuredStaleMs +
				h.measuredDwellMs +
				h.measuredQualifyMs +
				h.holdMs +
				h.overheadMs,
		).toBe(h.timeMs)
	}
}

describe("hop phases", () => {
	it("does not count a recording check's time in both the dwell and the hold", () => {
		let during = (): void => undefined
		const { s, at, now } = scene({
			recording: () => {
				during()
				return true
			},
		})
		during = () => at(now() + 10)
		s.start()
		s.noteTuneStarted(0)
		s.noteTuneAnswered(0)
		s.onEpochStarted(0)
		s.onTrack(track("a", HZ_A), false, 0)
		for (const [sample, wall] of [
			[50, 50],
			[100, 100],
			[150, 140],
		] as const) {
			at(wall)
			s.onBlock(sample)
		}
		const hop = s.hopPhaseStats()[0]
		expect(hop).toMatchObject({ timeMs: 150, holdMs: 10 })
		expect(hop?.measuredDwellMs).toBe(140)
		expectAddsUp(s.hopPhaseStats())
	})

	it("splits one visit into tune latency, settle and dwell", () => {
		const { s, at } = scene()
		s.start()
		at(5)
		s.noteTuneStarted(0)
		at(7)
		s.noteTuneAnswered(0)
		expectAddsUp(s.hopPhaseStats())
		at(1_007)
		s.onEpochStarted(1_007)
		expect(s.hopPhaseStats()[0]).toMatchObject({
			measuredSettleMs: 1_000,
			overheadMs: 7,
		})
		at(1_057)
		s.onBlock(1_057)
		at(1_107)
		s.onBlock(1_107)
		// Mid visit: the dwell heard so far.
		expect(s.hopPhaseStats()[0]).toMatchObject({
			timeMs: 1_107,
			measuredDwellMs: 100,
		})
		at(1_157)
		s.onBlock(1_157)
		const [hop0, hop1] = s.hopPhaseStats()
		expect(hop0).toEqual({
			hopIndex: 0,
			visits: 1,
			timeMs: 1_157,
			holdMs: 0,
			lastVisitAgeMs: 0,
			measuredSettleMs: 1_000,
			measuredStaleMs: 0,
			measuredDwellMs: 150,
			measuredQualifyMs: 0,
			overheadMs: 7,
		})
		expect(hop1).toMatchObject({ visits: 1, timeMs: 0 })
	})

	it("counts tune to epoch as settle when the epoch opens before the tune's answer", () => {
		const { s, at } = scene()
		s.start()
		s.noteTuneStarted(0)
		at(900)
		s.onEpochStarted(900)
		// The answer comes late: the dwell keeps running.
		at(910)
		s.noteTuneAnswered(0)
		at(950)
		s.onBlock(950)
		expect(s.hopPhaseStats()[0]).toMatchObject({
			measuredSettleMs: 900,
			measuredDwellMs: 50,
			overheadMs: 0,
		})
	})

	it("counts wall time past the heard blocks as overhead, not dwell", () => {
		const { s, at } = scene()
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		// The first block ends the settle: all before its own 50 ms was the epoch's wait.
		at(1_400)
		s.onBlock(1_050)
		expect(s.hopPhaseStats()[0]).toMatchObject({
			measuredSettleMs: 1_350,
			measuredDwellMs: 50,
		})
		// The dwell's other 100 ms of samples take 600 ms of wall clock: a late stream.
		at(1_800)
		s.onBlock(1_100)
		at(2_000)
		s.onBlock(1_150)
		const [hop] = s.hopPhaseStats()
		expect(hop).toMatchObject({
			timeMs: 2_000,
			measuredSettleMs: 1_350,
			measuredDwellMs: 150,
			overheadMs: 500,
		})
		expectAddsUp(s.hopPhaseStats())
	})

	it("counts a backlog's blocks at the wall time they took", () => {
		const { s, at } = scene()
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		at(1_020)
		s.onBlock(1_050)
		s.onBlock(1_100)
		s.onBlock(1_150)
		expect(s.hopPhaseStats()[0]).toMatchObject({
			timeMs: 1_020,
			measuredDwellMs: 20,
			overheadMs: 0,
		})
	})

	it("counts discarded stale blocks at most at their length, the rest as settle", () => {
		const { s, at } = scene()
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		at(1_050)
		s.onStale(1)
		expect(s.hopPhaseStats()[0]).toMatchObject({ measuredStaleMs: 50 })
		// At the bound: a block's wall time. Past it: the excess is no stale IQ.
		at(1_130)
		s.onStale(1)
		const [hop] = s.hopPhaseStats()
		expect(hop).toMatchObject({
			timeMs: 1_130,
			measuredStaleMs: 100,
			measuredSettleMs: 1_030,
			overheadMs: 0,
		})
		// The dwell still hears its full length after them.
		at(1_180)
		s.onBlock(1_050)
		at(1_230)
		s.onBlock(1_100)
		at(1_280)
		s.onBlock(1_150)
		at(1_330)
		s.onBlock(1_200)
		at(1_380)
		expect(s.onBlock(1_250).some(a => a.type === "tune")).toBe(true)
		const [ended] = s.hopPhaseStats()
		expect(ended).toMatchObject({
			visits: 1,
			measuredStaleMs: 100,
			measuredDwellMs: 250,
		})
		expectAddsUp(s.hopPhaseStats())
	})

	it("counts a wait for a young track's class as qualification, not dwell", () => {
		const { s, at } = scene({ policy: "hold" })
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		s.onTrack(track("a", HZ_A, 2), false, 0, { voiceLater: true })
		for (const end of [1_050, 1_100, 1_150]) {
			at(end)
			expect(s.onBlock(end)).toEqual([])
		}
		expect(s.hopPhaseStats()[0]).toMatchObject({
			measuredDwellMs: 150,
			measuredQualifyMs: 0,
		})
		// 5 blocks for its class, it has 2: three more.
		for (const end of [1_200, 1_250]) {
			at(end)
			expect(s.onBlock(end)).toEqual([])
		}
		at(1_300)
		s.onBlock(1_300)
		const [hop] = s.hopPhaseStats()
		expect(hop).toMatchObject({
			visits: 1,
			measuredDwellMs: 150,
			measuredQualifyMs: 150,
		})
		expectAddsUp(s.hopPhaseStats())
	})

	it("adds up at and across a hold, whose time stays the existing holdMs", () => {
		const { s, at } = scene()
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		s.onTrack(track("a", HZ_A), true, 1_000)
		at(1_050)
		s.onBlock(1_050)
		at(1_100)
		s.onBlock(1_100)
		at(1_150)
		expect(s.onBlock(1_150).map(a => a.type)).toEqual(["start-probe"])
		at(1_650)
		s.tick(1_650)
		const during = s.hopPhaseStats()
		expectAddsUp(during)
		expect(during[0]).toMatchObject({
			holdMs: 500,
			measuredDwellMs: 150,
			measuredSettleMs: 1_000,
			overheadMs: 0,
		})
		// Blocks heard in the hold are hold, not dwell.
		at(1_700)
		s.onBlock(1_200)
		expect(s.hopPhaseStats()[0]!.measuredDwellMs).toBe(150)
		at(2_450)
		s.tick(2_450)
		const after = s.hopPhaseStats()
		expect(after[0]).toMatchObject({
			visits: 1,
			timeMs: 2_450,
			holdMs: 1_300,
			overheadMs: 0,
		})
		expectAddsUp(after)
	})

	it("excludes a pause during the dwell from every phase; the re-send settles again", () => {
		const { s, at } = scene()
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		at(1_050)
		s.onBlock(1_050)
		at(1_060)
		s.setAccountingActive(false)
		const frozen = s.hopPhaseStats()
		expectAddsUp(frozen)
		at(9_000)
		expect(s.hopPhaseStats()[0]).toMatchObject({
			timeMs: frozen[0]!.timeMs,
			measuredDwellMs: 50,
			overheadMs: 10,
		})
		s.setAccountingActive(true)
		at(9_002)
		s.noteTuneStarted(0)
		at(9_004)
		s.noteTuneAnswered(0)
		expect(s.hopPhaseStats()[0]).toMatchObject({ timeMs: 1_064 })
		at(10_004)
		s.onEpochStarted(50)
		const [hop] = s.hopPhaseStats()
		expect(hop).toMatchObject({
			timeMs: 2_064,
			measuredSettleMs: 2_000,
			measuredDwellMs: 50,
			overheadMs: 14,
		})
		expectAddsUp(s.hopPhaseStats())
	})

	it("excludes a pause during a hold; a restart keeps what was held", () => {
		const { s, at } = scene()
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		s.onTrack(track("a", HZ_A), true, 1_000)
		at(1_050)
		s.onBlock(1_050)
		at(1_100)
		s.onBlock(1_100)
		at(1_150)
		s.onBlock(1_150)
		at(1_400)
		s.tick(1_400)
		at(1_450)
		s.setAccountingActive(false)
		at(5_000)
		expect(s.hopPhaseStats()[0]).toMatchObject({ timeMs: 1_450, holdMs: 300 })
		expectAddsUp(s.hopPhaseStats())
		s.setAccountingActive(true)
		s.noteTuneStarted(0)
		at(5_010)
		s.noteTuneAnswered(0)
		at(5_500)
		s.onEpochStarted(10)
		const [hop] = s.hopPhaseStats()
		expect(hop).toMatchObject({
			timeMs: 1_950,
			holdMs: 300,
			measuredSettleMs: 1_490,
			measuredDwellMs: 150,
			overheadMs: 10,
		})
		expectAddsUp(s.hopPhaseStats())
	})

	it("does not count a restart's re-send twice while a hold's clock runs", () => {
		const { s, at } = scene()
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		s.onTrack(track("a", HZ_A), true, 1_000)
		at(1_050)
		s.onBlock(1_050)
		at(1_100)
		s.onBlock(1_100)
		at(1_150)
		s.onBlock(1_150)
		// No pause: an untracked retune re-sends the hop mid-hold. The hold counts to the last tick.
		at(1_300)
		s.tick(1_300)
		s.noteTuneStarted(0)
		at(1_310)
		s.noteTuneAnswered(0)
		expectAddsUp(s.hopPhaseStats())
		at(1_400)
		s.tick(1_400)
		at(1_500)
		s.onEpochStarted(10)
		const [hop] = s.hopPhaseStats()
		expect(hop).toMatchObject({
			timeMs: 1_500,
			holdMs: 250,
			// Last tick to the restart: no phase of its own.
			overheadMs: 100,
		})
		expectAddsUp(s.hopPhaseStats())
	})

	it("counts nothing for a visit that started during a pause until the pause ends", () => {
		const { s, spec, at } = scene({ hops: 1 })
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		expect(s.parked).toBe(true)
		at(1_100)
		s.setAccountingActive(false)
		at(2_000)
		// The plan moves during the pause: the parked hop leaves for a new one, with a fresh account.
		s.replan(makeHopPlan([160 * MHZ], HALF_SPAN_HZ), spec)
		expect(s.hopPhaseStats()[0]).toMatchObject({ visits: 1, timeMs: 0 })
		expectAddsUp(s.hopPhaseStats())
		at(3_000)
		s.setAccountingActive(true)
		expect(s.hopPhaseStats()[0]).toMatchObject({ timeMs: 0 })
		at(3_010)
		s.noteTuneStarted(0)
		s.noteTuneAnswered(0)
		at(3_100)
		expect(s.hopPhaseStats()[0]).toMatchObject({
			timeMs: 100,
			measuredSettleMs: 90,
			overheadMs: 10,
		})
		expectAddsUp(s.hopPhaseStats())
	})

	it("keeps a parked hop's visits adding up: a continued visit has no settle", () => {
		const { s, spec, at } = scene({ hops: 1 })
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		let end = 1_000
		for (let i = 0; i < 20; i++) {
			end += BLOCK
			at(end)
			s.onBlock(end)
			expectAddsUp(s.hopPhaseStats())
		}
		expect(s.hopPhaseStats()[0]).toMatchObject({
			measuredSettleMs: 1_000,
			measuredDwellMs: 1_000,
			timeMs: 2_000,
			overheadMs: 0,
		})
		// A replan that keeps the park leaves the totals alone.
		s.replan(makeHopPlan(centres(1), HALF_SPAN_HZ), spec)
		expect(s.hopPhaseStats()[0]).toMatchObject({ timeMs: 2_000 })
	})

	it("counts a stale block in a dwell after the blocks it heard, the excess as overhead", () => {
		const { s, at } = scene()
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		at(1_050)
		s.onBlock(1_050)
		at(1_180)
		s.onStale(1)
		expect(s.hopPhaseStats()[0]).toMatchObject({
			measuredDwellMs: 50,
			measuredStaleMs: 50,
			overheadMs: 80,
		})
		expectAddsUp(s.hopPhaseStats())
	})

	it("settles a timer epoch announced ahead of its first settled sample until the first block", () => {
		const { s, at } = scene()
		s.start()
		s.noteTuneStarted(0)
		s.noteTuneAnswered(0)
		// Announced at once, its first settled block 1000 ms later.
		s.onEpochStarted(1_000)
		at(1_050)
		s.onBlock(1_050)
		expect(s.hopPhaseStats()[0]).toMatchObject({
			timeMs: 1_050,
			measuredSettleMs: 1_000,
			measuredDwellMs: 50,
			overheadMs: 0,
		})
	})

	it("carries a hop's phases across a replan once, as it carries timeMs", () => {
		const { s, spec, at } = scene()
		s.start()
		s.noteTuneAnswered(0)
		at(1_000)
		s.onEpochStarted(1_000)
		// Two new hops map to the old hop 0: only one takes its totals over.
		const old = centres(2)
		s.replan(
			makeHopPlan([old[0]!, old[0]! + 1_000, old[1]!], HALF_SPAN_HZ),
			spec,
		)
		at(1_050)
		s.onBlock(1_050)
		at(1_100)
		s.onBlock(1_100)
		at(1_150)
		s.onBlock(1_150)
		const stats = s.hopPhaseStats()
		expect(stats).toHaveLength(3)
		expectAddsUp(stats)
		const ofOld = stats.filter(h => h.hopIndex < 2)
		expect(ofOld.reduce((n, h) => n + h.measuredSettleMs, 0)).toBe(1_000)
		expect(ofOld.reduce((n, h) => n + h.measuredDwellMs, 0)).toBe(150)
		expect(ofOld.reduce((n, h) => n + h.timeMs, 0)).toBe(1_150)
		// The other mapped copy starts from its own zero.
		expect(ofOld.filter(h => h.timeMs > 0)).toHaveLength(1)
	})

	type Step =
		| { op: "wait"; ms: number }
		| { op: "block" | "stale" | "tick" | "epoch" | "skip" | "closeA" }
		| { op: "toHold" }
		| { op: "track"; confirm: boolean; voice: boolean; blocks: number }
		| { op: "pause" | "resume" | "tuneStart" | "tuneAnswer" }
		| { op: "replan"; hops: number }
		| { op: "confirmed"; follow: boolean }
	const stepArb: fc.Arbitrary<Step> = fc.oneof(
		{
			weight: 8,
			arbitrary: fc.record({
				op: fc.constant("wait" as const),
				ms: fc.integer({ min: 0, max: 400 }),
			}),
		},
		{ weight: 8, arbitrary: fc.constant({ op: "block" as const }) },
		{ weight: 3, arbitrary: fc.constant({ op: "toHold" as const }) },
		{ weight: 1, arbitrary: fc.constant({ op: "stale" as const }) },
		{ weight: 3, arbitrary: fc.constant({ op: "tick" as const }) },
		{ weight: 2, arbitrary: fc.constant({ op: "epoch" as const }) },
		{ weight: 1, arbitrary: fc.constant({ op: "skip" as const }) },
		{ weight: 1, arbitrary: fc.constant({ op: "closeA" as const }) },
		{
			weight: 2,
			arbitrary: fc.record({
				op: fc.constant("track" as const),
				confirm: fc.boolean(),
				voice: fc.boolean(),
				blocks: fc.integer({ min: 1, max: 9 }),
			}),
		},
		{ weight: 1, arbitrary: fc.constant({ op: "pause" as const }) },
		{ weight: 1, arbitrary: fc.constant({ op: "resume" as const }) },
		{ weight: 2, arbitrary: fc.constant({ op: "tuneStart" as const }) },
		{ weight: 2, arbitrary: fc.constant({ op: "tuneAnswer" as const }) },
		{
			weight: 1,
			arbitrary: fc.record({
				op: fc.constant("replan" as const),
				hops: fc.integer({ min: 1, max: 4 }),
			}),
		},
		{
			weight: 1,
			arbitrary: fc.record({
				op: fc.constant("confirmed" as const),
				follow: fc.boolean(),
			}),
		},
	)

	/**
	 * What the job runner sends only while driving (onBlock, onStale, onEpochStarted, tick, the skipped
	 * tune). A pause keeps the rest: a track's close, a confirmation, a replan can still arrive.
	 */
	const DRIVEN = new Set<Step["op"]>([
		"block",
		"toHold",
		"stale",
		"tick",
		"epoch",
		"skip",
	])

	/** Runs the steps, sending the accounting calls and reads only with `account`. */
	function run(
		steps: readonly Step[],
		policy: "confirm" | "hold",
		recording: boolean,
		account: boolean,
	) {
		const { s, spec, at, now } = scene({
			hops: 3,
			policy,
			...(recording ? { recording: () => true } : {}),
		})
		const log: SchedulerAction[] = [...s.start()]
		let sample = 0
		const hopNow = (): number => s.progress().hopIndex
		let paused = false
		for (const step of steps) {
			if (paused && DRIVEN.has(step.op)) continue
			switch (step.op) {
				case "wait":
					at(now() + step.ms)
					break
				case "block":
					sample += BLOCK
					log.push(...s.onBlock(sample))
					break
				case "toHold":
					// A whole dwell with a track to confirm: random steps alone rarely reach a hold.
					log.push(...s.onEpochStarted(sample))
					log.push(...s.onTrack(track("a", HZ_A), true, 500))
					for (let i = 0; i < 3; i++) {
						at(now() + BLOCK)
						sample += BLOCK
						log.push(...s.onBlock(sample))
					}
					break
				case "stale":
					s.onStale(1)
					break
				case "tick":
					log.push(...s.tick(now()))
					break
				case "epoch":
					log.push(...s.onEpochStarted(sample))
					break
				case "skip":
					log.push(...s.onTuneSkipped())
					break
				case "closeA":
					log.push(...s.onTrackClosed("a"))
					break
				case "track":
					log.push(
						...s.onTrack(track("a", HZ_A, step.blocks), step.confirm, 500, {
							voiceLater: step.voice,
						}),
					)
					break
				case "pause":
					paused = true
					s.setAccountingActive(false)
					break
				case "resume":
					paused = false
					s.setAccountingActive(true)
					break
				case "tuneStart":
					if (account) s.noteTuneStarted(hopNow())
					break
				case "tuneAnswer":
					if (account) s.noteTuneAnswered(hopNow())
					break
				case "replan":
					log.push(
						...s.replan(makeHopPlan(centres(step.hops), HALF_SPAN_HZ), spec),
					)
					break
				case "confirmed":
					log.push(...s.onConfirmed("a", step.follow))
					break
			}
			if (account) expectAddsUp(s.hopPhaseStats())
		}
		return { log, stats: s.hopStats() }
	}

	const sceneArb = fc.record({
		steps: fc.array(stepArb, { maxLength: 150 }),
		policy: fc.constantFrom<"confirm" | "hold">("confirm", "hold"),
		recording: fc.boolean(),
	})

	it("adds up after any sequence of holds, pauses, restarts and replans", () => {
		fc.assert(
			fc.property(sceneArb, ({ steps, policy, recording }) => {
				run(steps, policy, recording, true)
			}),
			{ numRuns: 300 },
		)
	})

	it("changes no action and no existing total", () => {
		fc.assert(
			fc.property(sceneArb, ({ steps, policy, recording }) => {
				const read = run(steps, policy, recording, true)
				const silent = run(steps, policy, recording, false)
				expect(read.log).toEqual(silent.log)
				expect(read.stats).toEqual(silent.stats)
			}),
			{ numRuns: 300 },
		)
	})
})
