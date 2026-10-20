// tests/unit/core/scanner/scheduler-parking.property.test.ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { SweepScheduler } from "../../../../src/core/scanner/scheduler.js"
import type { SchedulerAction } from "../../../../src/core/scanner/scheduler.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const FS = 2_048_000
const B = 102_400 // 50 ms blocks
const MHZ = 1_000_000

type Ev =
	| { t: "block"; ms: number }
	| { t: "track"; id: number; confirm: boolean }
	| { t: "close"; id: number }
	| { t: "confirm"; id: number; follow: boolean }
	| { t: "tick"; ms: number }
	| { t: "edit"; halfSpan: number; signalsOnly: boolean }

const evArb: fc.Arbitrary<Ev> = fc.oneof(
	{
		arbitrary: fc.record({
			t: fc.constant("block" as const),
			ms: fc.integer({ min: 0, max: 120 }),
		}),
		weight: 8,
	},
	fc.record({
		t: fc.constant("track" as const),
		id: fc.integer({ min: 0, max: 4 }),
		confirm: fc.boolean(),
	}),
	fc.record({
		t: fc.constant("close" as const),
		id: fc.integer({ min: 0, max: 4 }),
	}),
	fc.record({
		t: fc.constant("confirm" as const),
		id: fc.integer({ min: 0, max: 4 }),
		follow: fc.boolean(),
	}),
	fc.record({
		t: fc.constant("tick" as const),
		ms: fc.integer({ min: 0, max: 3_000 }),
	}),
	fc.record({
		t: fc.constant("edit" as const),
		halfSpan: fc.integer({ min: 400_000, max: 1_000_000 }),
		signalsOnly: fc.boolean(),
	}),
)

const track = (id: number, centreHz: number): TrackSnapshot => ({
	...makeTrack({ id: `t${id}`, centreHz, startedAt: 0 }),
	trackId: `t${id}`,
})

describe("SweepScheduler parking properties", () => {
	// Feature: scanner-redesign, Property 3: A fitting window stays tuned
	// Validates: Requirements 1.1, 1.3, 1.4
	it("one-hop plans tune once and count floor(elapsed / dwellMs) sweeps; multi-hop never re-tunes the visited hop", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 400, max: 470 }),
				fc.integer({ min: 100, max: 1_500 }),
				fc.constantFrom<"hold" | "confirm" | "never">(
					"hold",
					"confirm",
					"never",
				),
				fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
				fc.array(evArb, { minLength: 1, maxLength: 150 }),
				(centreMhz, dwellMs, policy, afterSweeps, events) => {
					const centre = centreMhz * MHZ + 100_000
					let clock = 0
					let sample = 0
					const spec = (signalsOnly = false) =>
						makeNormalisedSpec({
							dwellMs,
							revisit: { share: 0.3, maxIntervalMs: null },
							hold: {
								policy,
								confirmHoldMs: { "tdma-ms": 1_800 },
								maxHoldMs: 5_000,
								hangMs: 500,
							},
							stop: { afterSweeps, afterMs: null, onFirstDecoded: false },
							...(signalsOnly ? { signalsOnly } : {}),
						})
					const s = new SweepScheduler(makeHopPlan([centre]), spec(), {
						blockSamples: B,
						sampleRateHz: FS,
						now: () => clock,
						probeStartMs: 300,
					})
					const all: SchedulerAction[] = [...s.start()]
					all.push(...s.onEpochStarted(sample))
					const parkedAt = clock
					expect(s.parked).toBe(true)
					for (const ev of events) {
						const out: SchedulerAction[] = []
						switch (ev.t) {
							case "block":
								clock += ev.ms
								sample += B
								out.push(...s.tick(clock), ...s.onBlock(sample))
								break
							case "track":
								out.push(...s.onTrack(track(ev.id, centre), ev.confirm, 800))
								break
							case "close":
								out.push(...s.onTrackClosed(`t${ev.id}`))
								break
							case "confirm":
								out.push(...s.onConfirmed(`t${ev.id}`, ev.follow))
								break
							case "tick":
								clock += ev.ms
								out.push(...s.tick(clock))
								break
							case "edit":
								out.push(
									...s.replan(
										makeHopPlan([centre], ev.halfSpan),
										spec(ev.signalsOnly),
									),
								)
								break
						}
						all.push(...out)
						const sweeps = all.filter(a => a.type === "sweep-complete").length
						const due = Math.floor((clock - parkedAt) / dwellMs)
						// never ahead of the elapsed dwell; exact whenever a count is emitted
						expect(sweeps).toBeLessThanOrEqual(due)
						if (out.some(a => a.type === "sweep-complete"))
							expect(sweeps).toBe(due)
						expect(s.parked).toBe(true)
						expect(s.progress().sweepPeriodMs).toBeNull()
						expect(s.progress().hopCount).toBe(1)
					}
					expect(all.filter(a => a.type === "tune")).toHaveLength(1)
					// sweep indices are consecutive from 0 (afterSweeps sees each one)
					all
						.filter(a => a.type === "sweep-complete")
						.forEach((a, i) =>
							expect(a).toEqual({ type: "sweep-complete", sweepIndex: i }),
						)
				},
			),
			{ numRuns: 100 },
		)

		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 3 }), {
					minLength: 2,
					maxLength: 6,
				}),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.option(fc.integer({ min: 100, max: 3_000 }), { nil: null }),
				fc.array(evArb, { minLength: 1, maxLength: 200 }),
				(slots, share, maxIntervalMs, events) => {
					// a small set of centres: twins are allowed (a replan can map onto the same window)
					const centres = slots.map(k => 446_100_000 + k * 2 * MHZ)
					let clock = 0
					let sample = 0
					const s = new SweepScheduler(
						makeHopPlan(centres),
						makeNormalisedSpec({
							dwellMs: 200,
							revisit: { share, maxIntervalMs },
							hold: {
								policy: "confirm",
								confirmHoldMs: { "tdma-ms": 800 },
								maxHoldMs: 3_000,
								hangMs: 500,
							},
						}),
						{
							blockSamples: B,
							sampleRateHz: FS,
							now: () => clock,
							probeStartMs: 300,
						},
					)
					let visiting: number | null = null
					let out = s.start()
					for (const ev of [...events, ...events]) {
						for (const a of out)
							if (a.type === "tune") {
								expect(a.centreHz).not.toBe(visiting)
								visiting = a.centreHz
							}
						if (out.some(a => a.type === "tune")) s.onEpochStarted(sample)
						out = []
						const at = visiting ?? centres[0]!
						if (ev.t === "block" || ev.t === "tick") {
							clock += ev.t === "block" ? ev.ms : Math.min(ev.ms, 500)
							sample += B
							out = [...s.tick(clock), ...s.onBlock(sample)]
						} else if (ev.t === "track")
							out = s.onTrack(track(ev.id, at), ev.confirm, 800)
						else if (ev.t === "close") out = s.onTrackClosed(`t${ev.id}`)
						else if (ev.t === "confirm")
							out = s.onConfirmed(`t${ev.id}`, ev.follow)
						expect(s.parked).toBe(false)
					}
					for (const a of out)
						if (a.type === "tune") expect(a.centreHz).not.toBe(visiting)
				},
			),
			{ numRuns: 100 },
		)
	})
})
