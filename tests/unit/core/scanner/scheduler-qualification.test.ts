/**
 * The dwell against the channel gate: a hop with energy the gate has not answered (a candidate) keeps
 * listening within a bound derived from that gate, and an empty hop pays nothing.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	SweepScheduler,
	type SchedulerAction,
} from "../../../../src/core/scanner/scheduler.js"
import {
	CHANNEL_GATE_BURST_MIN_DURATION_MS as BURST_MS,
	CHANNEL_GATE_K_DB,
	CHANNEL_GATE_MARGIN_DB,
	CHANNEL_GATE_MIN_DURATION_MS as STANDARD_MS,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { channelGateMinDurationMs } from "../../../../src/core/spectrum/channel-gate.js"
import { segment } from "../../../../src/core/spectrum/emissions/segmenter.js"
import { Tracker } from "../../../../src/core/spectrum/emissions/tracker.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const FS = 2_048_000
const B = 102_400 // 50 ms blocks
const MHZ = 1_000_000
const HOP0 = 400 * MHZ
const HOP1 = 402 * MHZ
const HOP2 = 404 * MHZ
const AT = HOP0 + 100_000
/** A 300 ms gate: max(6, 5) + 2 blocks from the track's first block. */
const STANDARD_ANSWER_BLOCKS = 8
/** A 100 ms gate: max(2, 5) + 2 blocks from the track's first block. */
const BURST_ANSWER_BLOCKS = 7
/** minSurfaceBlocks + 1. */
const DWELL_BLOCKS = 3

const candidate = (
	blocks: number,
	over: Partial<TrackSnapshot> = {},
	id = "c",
): TrackSnapshot => ({
	...makeTrack({ id, centreHz: AT, startedAt: 0, blocks }),
	trackId: id,
	gate: "pending",
	channelSnrDb: 10,
	...over,
})
const passed = (blocks: number, id = "c"): TrackSnapshot =>
	candidate(blocks, { gate: "passed" }, id)

function harness(
	spec = makeNormalisedSpec({
		revisit: { share: 0, maxIntervalMs: null },
	}),
	hops = [HOP0, HOP1, HOP2],
) {
	const h = {
		clock: 0,
		sample: 0,
		s: null as unknown as SweepScheduler,
		tuned: [] as number[],
		note(actions: SchedulerAction[]): SchedulerAction[] {
			for (const a of actions) if (a.type === "tune") h.tuned.push(a.centreHz)
			return actions
		},
		/** One block of 50 ms: the tracker's event for it (if any) comes first, as in the pipeline. */
		block(event?: () => void): SchedulerAction[] {
			event?.()
			h.sample += B
			h.clock += 50
			return h.note(h.s.onBlock(h.sample))
		},
		start(): void {
			h.note(h.s.start())
			h.s.onEpochStarted(h.sample)
		},
		/** Empty blocks until the hop is left. */
		toNextHop(): number {
			const was = h.tuned.length
			let blocks = 0
			while (h.tuned.length === was && blocks < 100) {
				h.block()
				blocks++
			}
			h.s.onEpochStarted(h.sample)
			return blocks
		},
	}
	h.s = new SweepScheduler(makeHopPlan(hops), spec, {
		blockSamples: B,
		sampleRateHz: FS,
		now: () => h.clock,
		probeStartMs: 0,
	})
	return h
}

/** A candidate on air from the visit's first block, told at blocks 1, 2 and 5 as the tracker does. */
function onAir(
	h: ReturnType<typeof harness>,
	block: number,
	minMs = STANDARD_MS,
): (() => void) | undefined {
	if (block !== 1 && block !== 2 && block !== 5) return undefined
	return () => h.s.onCandidate(candidate(block), minMs)
}

/** Blocks the visit lasts with a candidate on air that is never answered. */
function unanswered(minMs: number): number {
	const h = harness()
	h.start()
	let block = 0
	while (h.tuned.length === 1 && block < 100) {
		block++
		h.block(onAir(h, block, minMs))
	}
	return block
}

describe("a hop's dwell against its gate", () => {
	it("an empty hop leaves at the dwell: no qualification, no cost", () => {
		const h = harness()
		h.start()
		expect(h.toNextHop()).toBe(DWELL_BLOCKS)
		expect(h.toNextHop()).toBe(DWELL_BLOCKS)
	})

	it("derives the wait from the gate: 8 blocks at a 300 ms gate, 7 at a 100 ms one, and leaves at that block, never past it", () => {
		expect(unanswered(STANDARD_MS)).toBe(STANDARD_ANSWER_BLOCKS)
		expect(unanswered(BURST_MS)).toBe(BURST_ANSWER_BLOCKS)
	})

	it("scales with the block length: a 100 ms block gets 5 + 2 blocks at a 300 ms gate", () => {
		const h = harness()
		h.s.setBlockGeometry(2 * B, FS)
		h.start()
		h.s.onCandidate(candidate(1), STANDARD_MS)
		let blocks = 0
		const was = h.tuned.length
		while (h.tuned.length === was && blocks < 100) {
			blocks++
			h.sample += 2 * B
			h.clock += 100
			if (blocks === 2) h.s.onCandidate(candidate(2), STANDARD_MS)
			h.note(h.s.onBlock(h.sample))
		}
		// max(ceil(300 / 100), 5) + 2.
		expect(blocks).toBe(7)
	})

	it("a candidate first sighted later still gets its own whole answer, bounded by the visit's one wait", () => {
		const h = harness()
		h.start()
		h.block()
		// Opened on block 2: 2 blocks old at the dwell's end (3).
		h.block(() => h.s.onCandidate(candidate(1), STANDARD_MS))
		h.block(() => h.s.onCandidate(candidate(2), STANDARD_MS))
		let blocks = 3
		while (h.tuned.length === 1 && blocks < 100) {
			blocks++
			h.block()
		}
		// 3 + (8 − 2) blocks: the worst case of a visit.
		expect(blocks).toBe(DWELL_BLOCKS + STANDARD_ANSWER_BLOCKS - 2)
	})

	it("a candidate opened after the wait started gets only what is left of it", () => {
		const h = harness()
		h.start()
		let block = 0
		while (h.tuned.length === 1 && block < 100) {
			block++
			h.block(() => {
				onAir(h, block)?.()
				// A new candidate every block from the 4th on must not extend the visit.
				if (block >= 4)
					h.s.onCandidate(
						candidate(2, { centreHz: AT + block * 25_000 }, `n${block}`),
						STANDARD_MS,
					)
			})
		}
		expect(block).toBe(STANDARD_ANSWER_BLOCKS)
	})

	it("a gate refusal releases the hop in that block", () => {
		const h = harness()
		h.start()
		h.block(() => h.s.onCandidate(candidate(1), STANDARD_MS))
		h.block(() => h.s.onCandidate(candidate(2), STANDARD_MS))
		h.block()
		expect(h.tuned).toHaveLength(1)
		h.block(() => h.s.onCandidateClosed(candidate(3, { gate: "below" })))
		expect(h.tuned).toEqual([HOP0, HOP1])
	})

	it("a pass with a class to follow starts the hold on the same visit, not at the bound", () => {
		const h = harness()
		h.start()
		h.block(() => h.s.onCandidate(candidate(1), STANDARD_MS))
		h.block(() => h.s.onCandidate(candidate(2), STANDARD_MS))
		h.block()
		h.block()
		h.block(() => h.s.onCandidate(candidate(5), STANDARD_MS))
		h.block(() => {
			h.s.onTrack(passed(6), false, 0, { followOnAir: true })
		})
		expect(h.tuned).toHaveLength(1)
		expect(h.s.progress().holdingOn).toBe("c")
	})

	it("a burst pass at block 2 waits for the 5th block's class, then holds voice", () => {
		const h = harness()
		h.start()
		h.block(() => h.s.onCandidate(candidate(1), BURST_MS))
		h.block(() => {
			// Too young to read: neither voice nor `voiceLater`.
			h.s.onTrack(passed(2), false, 0)
		})
		h.block()
		h.block()
		expect(h.tuned).toHaveLength(1)
		h.block(() => {
			h.s.onTrack(passed(5), false, 0, { followOnAir: true })
		})
		expect(h.s.progress().holdingOn).toBe("c")
		expect(h.tuned).toHaveLength(1)
	})

	it("a burst pass whose 5th block reads as no voice releases the hop at that block", () => {
		const h = harness()
		h.start()
		h.block(() => h.s.onCandidate(candidate(1), BURST_MS))
		h.block(() => {
			h.s.onTrack(passed(2), false, 0)
		})
		h.block()
		h.block()
		h.block(() => {
			h.s.onTrack(passed(5), false, 0)
		})
		expect(h.tuned).toEqual([HOP0, HOP1])
	})

	it("a parked hop is never left, so it does not wait", () => {
		const h = harness(makeNormalisedSpec(), [HOP0])
		h.start()
		expect(h.s.parked).toBe(true)
		h.block(() => h.s.onCandidate(candidate(1), STANDARD_MS))
		h.block(() => h.s.onCandidate(candidate(2), STANDARD_MS))
		h.block()
		// The third block ends the visit and a new one continues: 1 ended + the current one.
		expect(h.s.hopStats()[0]?.visits).toBe(2)
	})
})

describe("jobs that do not hold", () => {
	// Without the gate's answer no observation exists at all, so they wait for it as well.
	it.each([
		["hold.policy never", { policy: "never" as const, signalsOnly: false }],
		["signals only", { policy: "hold" as const, signalsOnly: true }],
	])(
		"%s waits for the answer and holds nothing",
		(_name, { policy, signalsOnly }) => {
			const h = harness(
				makeNormalisedSpec({
					revisit: { share: 0, maxIntervalMs: null },
					...(signalsOnly ? { signalsOnly } : {}),
					hold: { policy, confirmHoldMs: {}, maxHoldMs: 60_000, hangMs: 0 },
				}),
			)
			h.start()
			let block = 0
			while (h.tuned.length === 1 && block < 100) {
				block++
				h.block(onAir(h, block))
			}
			expect(block).toBe(STANDARD_ANSWER_BLOCKS)
			expect(h.s.progress().holdingOn).toBeNull()
		},
	)
})

describe("what gets no qualification", () => {
	const shortVisit = (over: Partial<TrackSnapshot>): number => {
		const h = harness()
		h.start()
		let block = 0
		while (h.tuned.length === 1 && block < 100) {
			block++
			h.block(() => {
				if (block < 3) h.s.onCandidate(candidate(block, over), STANDARD_MS)
			})
		}
		return block
	}

	it.each([
		["spur", { flags: { ...candidate(1).flags, spur: true } }],
		["image", { flags: { ...candidate(1).flags, iqImage: true } }],
		["truncated", { flags: { ...candidate(1).flags, truncated: true } }],
		["a channel the gate cannot measure", { channelSnrDb: undefined as never }],
		[
			"a channel under the gate's threshold",
			{ channelSnrDb: CHANNEL_GATE_K_DB - 0.1 },
		],
	] as const)("%s", (_name, over) => {
		expect(shortVisit(over)).toBe(DWELL_BLOCKS)
	})

	it("a channel at the gate's threshold does qualify", () => {
		expect(shortVisit({ channelSnrDb: CHANNEL_GATE_K_DB })).toBe(
			STANDARD_ANSWER_BLOCKS,
		)
	})

	it("one block of energy at the dwell's end may be noise: no wait", () => {
		const h = harness()
		h.start()
		h.block()
		h.block()
		h.block(() => h.s.onCandidate(candidate(1), STANDARD_MS))
		expect(h.tuned).toEqual([HOP0, HOP1])
	})
})

describe("rests after a failed qualification", () => {
	/** Under what could pass its gate (gateReachLevelDb): rests bind it. */
	const WEAK_DB = 4
	/** Runs `sweeps` coarse sweeps with the candidate on air on hop 0: the blocks of each hop-0 visit. */
	function visits(sweeps: number, answer: "timeout" | "close"): number[] {
		const h = harness()
		h.start()
		const out: number[] = []
		for (let i = 0; i < sweeps; i++) {
			const was = h.tuned.length
			let block = 0
			while (h.tuned.length === was && block < 100) {
				block++
				h.block(() => {
					// A new track on each visit: the tracker closes the old one with the retune.
					const id = `c${i}`
					if (block === 1 || block === 2 || block === 5)
						h.s.onCandidate(
							candidate(block, { channelSnrDb: WEAK_DB }, id),
							STANDARD_MS,
						)
					if (answer === "close" && block === 6)
						h.s.onCandidateClosed(
							candidate(6, { gate: "below", channelSnrDb: WEAK_DB }, id),
						)
				})
			}
			out.push(block)
			h.s.onEpochStarted(h.sample)
			h.toNextHop()
			h.toNextHop()
		}
		return out
	}

	const W = STANDARD_ANSWER_BLOCKS
	const D = DWELL_BLOCKS

	it("doubles from one sweep up to the cap of four: at most one wait in five sweeps", () => {
		// 1 rest, wait, 2 rests, wait, 4 rests, wait, 4 rests, wait.
		expect(visits(20, "timeout")).toEqual([
			W,
			D,
			W,
			D,
			D,
			W,
			D,
			D,
			D,
			D,
			W,
			D,
			D,
			D,
			D,
			W,
			D,
			D,
			D,
			D,
		])
	})

	it("a refusal rests too, and its visit ended when the gate refused", () => {
		expect(visits(4, "close")).toEqual([6, D, 6, D])
	})

	it("a frequency that failed long ago starts over at one sweep", () => {
		const h = harness()
		h.start()
		const onVisit = (id: string): number => {
			const was = h.tuned.length
			let block = 0
			while (h.tuned.length === was && block < 100) {
				block++
				h.block(() => {
					if (block <= 2)
						h.s.onCandidate(
							candidate(block, { channelSnrDb: WEAK_DB }, id),
							STANDARD_MS,
						)
				})
			}
			h.s.onEpochStarted(h.sample)
			h.toNextHop()
			h.toNextHop()
			return block
		}
		const emptySweep = (): void => {
			h.toNextHop()
			h.toNextHop()
			h.toNextHop()
		}
		expect(onVisit("a")).toBe(STANDARD_ANSWER_BLOCKS - 0)
		emptySweep()
		expect(onVisit("b")).toBe(STANDARD_ANSWER_BLOCKS)
		// Two strikes: two sweeps of rest, then past QUALIFY_STRIKE_MEMORY_SWEEPS (8) of quiet.
		for (let i = 0; i < 2 + 8; i++) emptySweep()
		expect(onVisit("c")).toBe(STANDARD_ANSWER_BLOCKS)
		// One sweep of rest again, not four.
		emptySweep()
		expect(onVisit("d")).toBe(STANDARD_ANSWER_BLOCKS)
	})

	it("a passed candidate that gets no hold rests like a refused one, and a held one owes nothing", () => {
		const run = (follow: boolean): number[] => {
			const h = harness(
				makeNormalisedSpec({
					revisit: { share: 0, maxIntervalMs: null },
					hold: {
						policy: "hold",
						confirmHoldMs: {},
						maxHoldMs: 500,
						hangMs: 0,
					},
				}),
			)
			h.start()
			const out: number[] = []
			for (let i = 0; i < 4; i++) {
				const was = h.tuned.length
				const id = `v${i}`
				let block = 0
				while (h.tuned.length === was && block < 200) {
					block++
					h.block(() => {
						if (block === 1 || block === 2 || block === 5)
							h.s.onCandidate(candidate(block, {}, id), STANDARD_MS)
						if (block === 6)
							h.s.onTrack(passed(6, id), false, 0, { followOnAir: follow })
						if (block === 7 && follow) h.s.onTrackClosed(id)
					})
					h.note(h.s.tick(h.clock))
				}
				out.push(block)
				h.s.onEpochStarted(h.sample)
				h.toNextHop()
				h.toNextHop()
			}
			return out
		}
		// No hold: answered at block 6, then a sweep's rest.
		expect(run(false)).toEqual([6, DWELL_BLOCKS, 6, DWELL_BLOCKS])
		// Held on each visit: never rests.
		const held = run(true)
		expect(held.every(b => b > DWELL_BLOCKS)).toBe(true)
	})
})

describe("carrier evidence and qualification", () => {
	const spec = makeNormalisedSpec({
		revisit: { share: 0, maxIntervalMs: null },
		hold: { policy: "hold", confirmHoldMs: {}, maxHoldMs: 60_000, hangMs: 0 },
	})
	/** A steady candidate on hop 0, passing at block 6 with analog voice: one watch to carrier evidence. */
	function earnCarrier(h: ReturnType<typeof harness>): void {
		h.start()
		for (let block = 1; block <= 6; block++)
			h.block(() => {
				if (block < 6) h.s.onCandidate(candidate(block), STANDARD_MS)
				else h.s.onTrack(passed(6), false, 0, { followOnAir: true })
			})
		expect(h.s.progress().holdingOn).toBe("c")
		// 8 s watch, on air without a break.
		for (let i = 0; i < 165 && h.tuned.length === 1; i++) {
			h.block()
			h.note(h.s.tick(h.clock))
		}
		expect(h.tuned).toEqual([HOP0, HOP1])
		h.s.onEpochStarted(h.sample)
		h.toNextHop()
	}

	it("a resting carrier gets no qualification: its hop leaves at the dwell with it on air", () => {
		const h = harness(spec)
		earnCarrier(h)
		h.toNextHop()
		let block = 0
		const was = h.tuned.length
		while (h.tuned.length === was && block < 100) {
			block++
			h.block(() => {
				if (block <= 2) h.s.onCandidate(candidate(block, {}, "c2"), STANDARD_MS)
			})
		}
		expect(block).toBe(DWELL_BLOCKS)
	})

	it("a carrier heard as a candidate is not missed: it stays known across more visits than FORGET_MISSES", () => {
		const h = harness(spec)
		earnCarrier(h)
		// Its retry is put off for this: visits of a hop with it on air, each short.
		const lengths: number[] = []
		for (let v = 0; v < 12; v++) {
			h.toNextHop()
			const was = h.tuned.length
			let block = 0
			while (h.tuned.length === was && block < 100) {
				block++
				h.block(() => {
					if (block <= 2)
						h.s.onCandidate(candidate(block, {}, `c${v}`), STANDARD_MS)
				})
			}
			lengths.push(block)
			h.s.onEpochStarted(h.sample)
			h.toNextHop()
			h.clock = 0 // never due
		}
		expect(lengths.every(b => b === DWELL_BLOCKS)).toBe(true)
	})

	it("a due retry takes the sweep's one carrier slot through qualification, bounded as any other", () => {
		const h = harness(spec)
		earnCarrier(h)
		h.toNextHop()
		// Past the rest (at most 3 × the 8 s hold).
		h.clock += 24_001
		const was = h.tuned.length
		let block = 0
		while (h.tuned.length === was && block < 100) {
			block++
			h.block(() => {
				if (block <= 2) h.s.onCandidate(candidate(block, {}, "r"), STANDARD_MS)
			})
		}
		expect(block).toBe(STANDARD_ANSWER_BLOCKS)
	})
})

describe("a watch against the voice rule", () => {
	const spec = makeNormalisedSpec({
		revisit: { share: 0, maxIntervalMs: null },
		hold: { policy: "hold", confirmHoldMs: {}, maxHoldMs: 60_000, hangMs: 0 },
	})
	/**
	 * A transmission already on air on the job's first visit (its onset unseen), held to its watch
	 * cap while the recorder answers `answer`: how long the hop is kept.
	 */
	function kept(answer: boolean | { voice: string }): number {
		const h = { clock: 0, sample: 0 }
		const s = new SweepScheduler(makeHopPlan([HOP0, HOP1, HOP2]), spec, {
			blockSamples: B,
			sampleRateHz: FS,
			now: () => h.clock,
			probeStartMs: 0,
			recordingActive: () => answer,
		})
		s.start()
		s.onEpochStarted(0)
		let left = false
		for (let block = 1; block <= 1400 && !left; block++) {
			if (block === 1) s.onTrack(passed(1), false, 0, { followOnAir: true })
			h.sample += B
			h.clock += 50
			const actions = [...s.onBlock(h.sample), ...s.tick(h.clock)]
			left = actions.some(a => a.type === "tune")
		}
		return h.clock
	}

	it("voice on air keeps the hop past the 8 s watch, up to maxHoldMs from the start of the holds", () => {
		const dwellMs = DWELL_BLOCKS * 50
		expect(kept({ voice: "o1" })).toBe(dwellMs + 60_000)
	})

	it("a recording that is not voice ends at the watch: the run is carrier evidence", () => {
		const dwellMs = DWELL_BLOCKS * 50
		expect(kept(true)).toBe(dwellMs + 8_000)
	})

	it("past the watch with no recording at all it ends at the watch too", () => {
		const dwellMs = DWELL_BLOCKS * 50
		expect(kept(false)).toBe(dwellMs + 8_000)
	})
})

describe("fairness of qualification", () => {
	// Feature: sweep-qualification, Property 1: a visit's wait is bounded
	// Validates: Requirements 2 (bounded per visit, whatever the candidates do)
	it("no event order keeps a hop past dwell + (bound − minSurfaceBlocks) blocks without a hold", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						id: fc.integer({ min: 0, max: 5 }),
						blocks: fc.integer({ min: 1, max: 30 }),
						snr: fc.double({ min: -5, max: 30, noNaN: true }),
						burst: fc.boolean(),
						close: fc.boolean(),
					}),
					{ maxLength: 60 },
				),
				events => {
					const h = harness()
					h.start()
					let block = 0
					let i = 0
					while (h.tuned.length === 1 && block < 100) {
						block++
						h.block(() => {
							const e = events[i++]
							if (e === undefined) return
							const t = candidate(
								e.blocks,
								{
									channelSnrDb: e.snr,
									centreHz: AT + e.id * 25_000,
								},
								`t${e.id}`,
							)
							if (e.close) h.s.onCandidateClosed({ ...t, gate: "below" })
							else h.s.onCandidate(t, e.burst ? BURST_MS : STANDARD_MS)
						})
					}
					return block <= DWELL_BLOCKS + STANDARD_ANSWER_BLOCKS - 2
				},
			),
			{ numRuns: 200 },
		)
	})

	/**
	 * A steady analog carrier on hop 0, for `ms` of the job. `gated`: through the gate, a candidate at
	 * blocks 1, 2 and 5, accepted at block 6 if the visit is still there; otherwise accepted at its
	 * first block, as a track reaches the scheduler without a wait. Returns its share of the time in
	 * holds and on its hop, and the longest time between two visits of an empty hop.
	 */
	function steadyCarrier(ms: number, hops: number[], gated: boolean) {
		const spec = makeNormalisedSpec({
			revisit: { share: 0, maxIntervalMs: null },
			hold: { policy: "hold", confirmHoldMs: {}, maxHoldMs: 60_000, hangMs: 0 },
		})
		const h = harness(spec, hops)
		h.start()
		let serial = 0
		let block = 0
		let hop = 0
		let lastEmptyVisit = 0
		let longestGap = 0
		while (h.clock < ms) {
			block++
			const id = `s${serial}`
			const onHop0 = hop === 0
			const b = block
			const actions = h.block(() => {
				if (!onHop0) return
				if (!gated) {
					if (b === 1)
						h.s.onTrack(passed(5, id), false, 0, { followOnAir: true })
					return
				}
				if (b === 1 || b === 2 || b === 5)
					h.s.onCandidate(candidate(b, {}, id), STANDARD_MS)
				if (b === 6) h.s.onTrack(passed(6, id), false, 0, { followOnAir: true })
			})
			const all = [...actions, ...h.note(h.s.tick(h.clock))]
			const tune = all.find(a => a.type === "tune")
			if (tune !== undefined && tune.type === "tune") {
				if (tune.hopIndex === 1) {
					longestGap = Math.max(longestGap, h.clock - lastEmptyVisit)
					lastEmptyVisit = h.clock
				}
				hop = tune.hopIndex
				block = 0
				serial++
				h.s.onEpochStarted(h.sample)
			}
		}
		const stats = h.s.hopStats()
		const total = stats.reduce((sum, x) => sum + x.timeMs, 0)
		return {
			holdShare: (stats[0]?.holdMs ?? 0) / total,
			hopShare: (stats[0]?.timeMs ?? 0) / total,
			longestGap,
		}
	}

	// Measured: the share Fair holds states for a steady carrier (about a third, at most half), with
	// the wait for its gate included, and one 8 s watch at a time between two visits of another hop.
	it("a steady carrier through the gate takes the carrier rules' share and never starves another hop", () => {
		const three = steadyCarrier(600_000, [HOP0, HOP1, HOP2], true)
		const plain = steadyCarrier(600_000, [HOP0, HOP1, HOP2], false)
		// Measured: holds 28.0 % through the gate, 30.0 % without a wait; time on its hop 56.5 % and
		// 53.4 % (the wait costs its hop 3 points, none of it past the carrier rules' share).
		expect(three.holdShare).toBeGreaterThan(0.2)
		expect(three.holdShare).toBeLessThanOrEqual(0.5)
		expect(Math.abs(three.holdShare - plain.holdShare)).toBeLessThan(0.05)
		expect(three.hopShare - plain.hopShare).toBeLessThan(0.05)
		// One 8 s watch and the other hops' dwells (measured 8300 ms; 8150 ms without a wait).
		expect(three.longestGap).toBeLessThanOrEqual(8_000 + 3 * 8 * 50)
	})

	it("the worst-case period: a failing candidate on every hop of a 3-hop plan costs at most its waits, then the rests", () => {
		const h = harness()
		h.start()
		const WORST_WAIT = 5 // 8 − 3 blocks for a signal on air at arrival
		let waits = 0
		const VISITS = 3 * 20
		for (let v = 0; v < VISITS; v++) {
			const was = h.tuned.length
			let block = 0
			while (h.tuned.length === was && block < 100) {
				block++
				h.block(() => {
					if (block <= 2)
						h.s.onCandidate(
							candidate(
								block,
								{
									centreHz: [HOP0, HOP1, HOP2][v % 3]! + 100_000,
									channelSnrDb: 4,
								},
								`v${v}`,
							),
							STANDARD_MS,
						)
				})
			}
			waits += block - DWELL_BLOCKS
			h.s.onEpochStarted(h.sample)
		}
		// 20 sweeps of rests 1, 2, 4, 4: at most 7 waits per hop, each WORST_WAIT blocks.
		expect(waits).toBeLessThanOrEqual(3 * 7 * WORST_WAIT)
		expect(waits).toBeGreaterThan(0)
	})
})

/** The line throughTracker draws: bins 140 to 148 of 256 at 1 kHz, about 16.5 kHz over the hop. */
const TRACKER_LINE_HZ = HOP0 + 16_500

/** The real tracker's gate run over one channel SNR per block, its events fed to the scheduler. */
function throughTracker(
	snrs: readonly number[],
	prepare?: (h: ReturnType<typeof harness>) => void,
) {
	const h = harness()
	const tracker = new Tracker({
		sourceId: "s1",
		binHz: 1000,
		blockMs: 50,
		hangBlocks: 3,
		maxTracks: 4,
		maxTrackBlocks: 100,
		idPrefix: "t",
	})
	tracker.beginEpoch({
		stream: 1,
		epoch: 1,
		centreHz: HOP0,
		tuningTrust: "commanded",
	})
	tracker.setGatePlan(true)
	const N = 256
	const powerDb = new Float32Array(N).fill(-60)
	const floorDb = new Float32Array(N).fill(-60)
	for (let i = 140; i < 149; i++) powerDb[i] = -20
	const on = Uint8Array.from(powerDb, p => (p > -56 ? 1 : 0))
	const reading = (channelSnrDb: number) => ({
		channelSnrDb,
		kDb: CHANNEL_GATE_K_DB,
		marginDb: 3,
		minDurationMs: STANDARD_MS,
		valid: true,
	})
	let passedAt: number | null = null
	let leftAt: number | null = null
	const told: number[] = []
	if (prepare === undefined) h.start()
	else prepare(h)
	for (let i = 0; i < snrs.length && leftAt === null; i++) {
		const actions = h.block(() => {
			const segments = segment(on, powerDb, floorDb, {
				gapBins: 2,
				usableStartBin: 26,
				usableEndBin: 231,
				exclusionEdges: [],
				rasterBinEdges: [],
				skirtDb: 30,
				inWindow: false,
			})
			const events = tracker.block(segments, {
				endSample: (i + 1) * 12_800,
				powerDb,
				floorDb,
				blockFloorDb: -60,
				thresholdDb: 4,
				gap: false,
				overload: false,
			})
			const extra = tracker.publishGate(() => reading(snrs[i]!), events, 0)
			for (const e of [...events, ...extra]) {
				if (e.kind !== "track-open" && e.kind !== "track-update") continue
				if (e.track.gate === "passed") {
					passedAt ??= i + 1
					h.s.onTrack(e.track, false, 0, { followOnAir: true })
				} else {
					told.push(i + 1)
					h.s.onCandidate(e.track, STANDARD_MS)
				}
			}
		})
		if (actions.some(a => a.type === "tune")) leftAt = i + 1
	}
	return {
		passedAt,
		leftAt,
		told,
		holding: h.s.progress().holdingOn !== null,
	}
}

describe("a reading between the tracker's snapshots", () => {
	const K = CHANNEL_GATE_K_DB
	/** Inside the gate's hysteresis: the run stays on, and its reading is under the threshold. */
	const LOW = K - 0.1

	it("a low second reading does not abandon a signal the gate passes at block 7", () => {
		const r = throughTracker([10, LOW, 10, 10, 10, 10, 10, 10])
		expect(r.told).toEqual([1, 2, 5])
		expect(r.passedAt).toBe(7)
		expect(r.leftAt).toBeNull()
		expect(r.holding).toBe(true)
	})

	it("a low fifth reading does not end the wait either", () => {
		const r = throughTracker([10, 10, 10, 10, LOW, 10, 10, 10])
		expect(r.passedAt).toBe(7)
		expect(r.leftAt).toBeNull()
		expect(r.holding).toBe(true)
	})

	it("a first low reading and a second one at the threshold wait as well", () => {
		const r = throughTracker([LOW, K, 10, 10, 10, 10, 10, 10])
		// The run starts with the second block: its sixth strong block is the seventh.
		expect(r.passedAt).toBe(7)
		expect(r.holding).toBe(true)
	})

	it("the bound still holds: a pass at the eighth block is heard, one at the ninth is not", () => {
		const at = throughTracker([10, LOW, 10, 10, 10, 10, LOW, 10, 10])
		expect(at.passedAt).toBe(8)
		expect(at.holding).toBe(true)
		const past = throughTracker([10, LOW, 10, 10, 10, 10, LOW, LOW, 10, 10])
		expect(past.leftAt).toBe(STANDARD_ANSWER_BLOCKS)
		expect(past.passedAt).toBeNull()
	})

	it("two low readings start no wait: what never read as a run costs its hop nothing", () => {
		const r = throughTracker([LOW, LOW, 10, 10, 10, 10, 10, 10, 10])
		expect(r.leftAt).toBe(DWELL_BLOCKS)
	})

	// Feature: sweep-qualification, Property 2: a low reading is not a refusal
	// Validates: Requirements 2 (only the refusal, a close or the bound ends a wait)
	it("a track with a reading at the threshold in its first two blocks is on the visit at any gate pass within the bound", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom(-2, 1.4, 1.5, LOW, K, 6, 10), {
					minLength: 12,
					maxLength: 12,
				}),
				snrs => {
					fc.pre(snrs[0]! >= K || snrs[1]! >= K)
					const r = throughTracker(snrs)
					if (r.passedAt === null || r.passedAt > STANDARD_ANSWER_BLOCKS)
						expect(r.leftAt).toBe(STANDARD_ANSWER_BLOCKS)
					else {
						expect(r.leftAt).toBeNull()
						expect(r.holding).toBe(true)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

/** One visit of the hop the sweep is on: its blocks, `at` telling the tracker's events per block. */
function runVisit(
	h: ReturnType<typeof harness>,
	at: (block: number) => void,
	limit = 100,
): number {
	const was = h.tuned.length
	let block = 0
	while (h.tuned.length === was && block < limit) {
		block++
		const b = block
		h.block(() => at(b))
	}
	if (h.tuned.length !== was) h.s.onEpochStarted(h.sample)
	return block
}

/** Candidate at blocks 1, 2 and 5 at `snrDb`, as the tracker tells it. */
const steady =
	(
		h: ReturnType<typeof harness>,
		snrDb: number,
		id: string,
		minMs = STANDARD_MS,
	) =>
	(block: number): void => {
		if (block === 1 || block === 2 || block === 5)
			h.s.onCandidate(candidate(block, { channelSnrDb: snrDb }, id), minMs)
	}

/** A two-block transient that closes below its gate during the wait, then the two empty hops. */
function failedTransient(
	h: ReturnType<typeof harness>,
	snrDb: number,
	centreHz = AT,
): void {
	h.start()
	const blocks = runVisit(h, block => {
		if (block <= 2)
			h.s.onCandidate(
				candidate(block, { channelSnrDb: snrDb, centreHz }, "t"),
				STANDARD_MS,
			)
		if (block === 4)
			h.s.onCandidateClosed(
				candidate(3, { gate: "below", channelSnrDb: snrDb, centreHz }, "t"),
			)
	})
	expect(blocks).toBe(4)
	h.toNextHop()
	h.toNextHop()
}

describe("a rest binds only what looks like the emission that earned it", () => {
	const TRANSIENT_DB = 4
	/** k + margin − hysteresis under the standard rule: 3 + 3 − 1.5. */
	const REACH_DB = 4.5
	/** k + burst margin − hysteresis: 3 + 6 − 1.5. */
	const BURST_REACH_DB = 7.5
	/** Over a rest earned by a pass with nothing to hold, this is another emission. */
	const STRONGER_DB = CHANNEL_GATE_MARGIN_DB

	it("a strong new signal after a failed transient qualifies on the next visit (standard gate)", () => {
		const h = harness()
		failedTransient(h, TRANSIENT_DB)
		const blocks = runVisit(
			h,
			block => {
				steady(h, 12, "s")(block)
				if (block === 6)
					h.s.onTrack(
						candidate(6, { gate: "passed", channelSnrDb: 12 }, "s"),
						false,
						0,
						{ followOnAir: true },
					)
			},
			6,
		)
		expect(blocks).toBe(6)
		expect(h.s.progress().holdingOn).toBe("s")
	})

	it("a strong new signal passing a burst gate at block 2 after a failed transient gets its class wait", () => {
		const h = harness()
		failedTransient(h, TRANSIENT_DB)
		const blocks = runVisit(
			h,
			block => {
				if (block === 1)
					h.s.onCandidate(candidate(1, { channelSnrDb: 12 }, "s"), BURST_MS)
				if (block === 2)
					h.s.onTrack(
						candidate(2, { gate: "passed", channelSnrDb: 12 }, "s"),
						false,
						0,
					)
				if (block === 5)
					h.s.onTrack(
						candidate(5, { gate: "passed", channelSnrDb: 12 }, "s"),
						false,
						0,
						{ followOnAir: true },
					)
			},
			5,
		)
		expect(blocks).toBe(5)
		expect(h.s.progress().holdingOn).toBe("s")
	})

	it("a pass is an answer no refusal can discard: at the refused level it still gets its class wait", () => {
		const h = harness()
		failedTransient(h, 10)
		const blocks = runVisit(h, block => {
			if (block === 1)
				h.s.onCandidate(candidate(1, { channelSnrDb: 10 }, "s"), BURST_MS)
			if (block === 2 || block === 5)
				h.s.onTrack(
					candidate(block, { gate: "passed", channelSnrDb: 10 }, "s"),
					false,
					0,
				)
		})
		// Up to its fifth block, then nothing to hold.
		expect(blocks).toBe(5)
	})

	it.each([
		["the rest's level", TRANSIENT_DB, DWELL_BLOCKS],
		["just under what could pass", REACH_DB - 0.01, DWELL_BLOCKS],
		["what could pass", REACH_DB, STANDARD_ANSWER_BLOCKS],
	])("a candidate at %s: the bound of the rest", (_name, snrDb, expected) => {
		const h = harness()
		failedTransient(h, TRANSIENT_DB)
		expect(runVisit(h, steady(h, snrDb, "s"))).toBe(expected)
	})

	it("the rest ends: a new call at the transient's own level loses one visit, no more", () => {
		const h = harness()
		failedTransient(h, TRANSIENT_DB)
		expect(runVisit(h, steady(h, TRANSIENT_DB, "s0"))).toBe(DWELL_BLOCKS)
		h.toNextHop()
		h.toNextHop()
		expect(runVisit(h, steady(h, TRANSIENT_DB, "s1"))).toBe(
			STANDARD_ANSWER_BLOCKS,
		)
	})

	/** `levels[i]`: the emitter's reading on sweep i. The waits it costs its hop. */
	function waits(levels: readonly number[]): number {
		const h = harness()
		h.start()
		let total = 0
		levels.forEach((level, i) => {
			const blocks = runVisit(h, steady(h, level, `e${i}`))
			if (blocks > DWELL_BLOCKS) total++
			h.toNextHop()
			h.toNextHop()
		})
		return total
	}

	it("a steady weak emitter with a reading that wanders under what could pass rests as a steady one does", () => {
		const levels = Array.from({ length: 20 }, (_, i) =>
			i % 2 === 0 ? 3 : REACH_DB - 0.01,
		)
		expect(waits(levels)).toBe(5)
	})

	it("a line that could pass but never answers pays its wait on every visit: the wait is its bound", () => {
		expect(waits(Array.from({ length: 20 }, () => REACH_DB))).toBe(20)
	})

	it("a level that falls back after a strong reading rests as the schedule says", () => {
		// Visits 1, 2 (the 30 dB is never rested), then rests of 2 and 4, 4, 4: visits 5, 10, 15, 20.
		expect(waits([3, 30, ...Array.from({ length: 18 }, () => 3)])).toBe(6)
	})

	// Feature: sweep-qualification, Property 3: a rest binds only what cannot pass
	// Validates: Requirements 3 (a steady emitter does not tax each sweep, no call is skipped)
	it("readings too weak to pass cost the rests' waits at most, and each stronger one its own", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: 3, max: 30, noNaN: true }), {
					minLength: 20,
					maxLength: 20,
				}),
				levels => {
					const over = levels.flatMap((l, i) => (l >= REACH_DB ? [i + 1] : []))
					const waited = waitedSweeps(levels)
					for (const sweep of over) expect(waited).toContain(sweep)
					// 20 sweeps of rests 1, 2, 4, 4: 5 waits; a stronger reading only raises the strikes.
					expect(waited.length - over.length).toBeLessThanOrEqual(5)
				},
			),
			{ numRuns: 100 },
		)
	})

	/** `levels[i]`: the emitter's reading on sweep i. The sweeps (1-based) whose visit waited. */
	function waitedSweeps(levels: readonly number[]): number[] {
		const h = harness()
		h.start()
		const out: number[] = []
		levels.forEach((level, i) => {
			if (runVisit(h, steady(h, level, `e${i}`)) > DWELL_BLOCKS) out.push(i + 1)
			h.toNextHop()
			h.toNextHop()
		})
		return out
	}

	describe("a candidate that could pass its gate is never rested", () => {
		/** The weak candidates' visits: rests of 1, then 2 sweeps, ending inside a rest of 4. */
		function weakHistory(h: ReturnType<typeof harness>): number[] {
			h.start()
			const out: number[] = []
			for (let i = 0; i < 6; i++) {
				out.push(runVisit(h, steady(h, TRANSIENT_DB, `w${i}`)))
				h.toNextHop()
				h.toNextHop()
			}
			return out
		}
		const W = STANDARD_ANSWER_BLOCKS
		const D = DWELL_BLOCKS

		it("a call reading 1 dB over the failures, inside their rest of four sweeps, passes and holds", () => {
			const h = harness()
			expect(weakHistory(h)).toEqual([W, D, W, D, D, W])
			const blocks = runVisit(
				h,
				block => {
					steady(h, TRANSIENT_DB + 1, "call")(block)
					if (block === 6)
						h.s.onTrack(
							candidate(6, { gate: "passed", channelSnrDb: 7 }, "call"),
							false,
							0,
							{ followOnAir: true },
						)
				},
				6,
			)
			expect(blocks).toBe(6)
			expect(h.s.progress().holdingOn).toBe("call")
		})

		it("a same-level call on the next visit after a failure at 5 dB passes and holds", () => {
			const h = harness()
			h.start()
			expect(runVisit(h, steady(h, 5, "first"))).toBe(W)
			h.toNextHop()
			h.toNextHop()
			runVisit(
				h,
				block => {
					steady(h, 5, "call")(block)
					if (block === 6)
						h.s.onTrack(
							candidate(6, { gate: "passed", channelSnrDb: 6 }, "call"),
							false,
							0,
							{ followOnAir: true },
						)
				},
				6,
			)
			expect(h.s.progress().holdingOn).toBe("call")
		})

		it.each([
			["under the standard level", STANDARD_MS, REACH_DB - 0.01, D],
			["at the standard level", STANDARD_MS, REACH_DB, W],
			["under the burst level", BURST_MS, BURST_REACH_DB - 0.01, D],
			["at the burst level", BURST_MS, BURST_REACH_DB, BURST_ANSWER_BLOCKS],
		])(
			"a candidate %s: the bound of the rest",
			(_name, minMs, snrDb, expected) => {
				const h = harness()
				weakHistory(h)
				expect(runVisit(h, steady(h, snrDb, "s", minMs))).toBe(expected)
			},
		)

		it("through the real gate: a call that reads 5 dB on its first blocks and 6 dB later passes on a rested frequency", () => {
			const r = throughTracker([5, 5, 5, 5, 5, 6, 6, 6], h =>
				failedTransient(h, TRANSIENT_DB, TRACKER_LINE_HZ),
			)
			expect(r.passedAt).toBe(6)
			expect(r.holding).toBe(true)
		})

		it("through the real gate: a line under the level has no pass to lose, and rests", () => {
			const line = Array.from({ length: 12 }, () => REACH_DB - 0.1)
			const free = throughTracker(line)
			expect(free.passedAt).toBeNull()
			expect(free.leftAt).toBe(STANDARD_ANSWER_BLOCKS)
			const rested = throughTracker(line, h =>
				failedTransient(h, TRANSIENT_DB, TRACKER_LINE_HZ),
			)
			expect(rested.passedAt).toBeNull()
			expect(rested.leftAt).toBe(DWELL_BLOCKS)
		})
	})

	it("[5, 8, fourteen quiet visits] repeats its two waits: an expired history keeps nothing", () => {
		const period = [5, 8, ...Array.from({ length: 14 }, () => 0)]
		expect(waitedSweeps([...period, ...period, ...period])).toEqual([
			1, 2, 17, 18, 33, 34,
		])
	})

	describe("a rest earned by a pass with nothing to hold", () => {
		/** `levels[i]`, 0 for no signal: a standard-gate pass at block 6, not held. Waited sweeps (1-based). */
		function passedSweeps(levels: readonly number[]): number[] {
			const h = harness()
			h.start()
			const out: number[] = []
			levels.forEach((db, i) => {
				const id = `p${i}`
				const blocks = runVisit(h, block => {
					if (db === 0) return
					steady(h, db, id)(block)
					if (block === 6)
						h.s.onTrack(
							candidate(6, { gate: "passed", channelSnrDb: db }, id),
							false,
							0,
						)
				})
				if (blocks > DWELL_BLOCKS) out.push(i + 1)
				h.toNextHop()
				h.toNextHop()
			})
			return out
		}

		it("binds what reads like it, and a margin over it is another transmission", () => {
			expect(passedSweeps([10, 10])).toEqual([1])
			expect(passedSweeps([10, 10 + STRONGER_DB - 0.01])).toEqual([1])
			expect(passedSweeps([10, 10 + STRONGER_DB])).toEqual([1, 2])
		})

		it("one margin's wait per history: the history's expiry starts the levels over", () => {
			const period = [10, 13, ...Array.from({ length: 14 }, () => 0)]
			// Rests of one and two sweeps, then 8 quiet sweeps forget the history.
			expect(passedSweeps([...period, ...period, ...period])).toEqual([
				1, 2, 17, 18, 33, 34,
			])
			// Inside the history the same 10 dB stays bound.
			expect(passedSweeps([10, 13, 0, 10])).toEqual([1, 2])
		})
	})

	it("a hold clears every rest within the lookup's tolerance, across a bin boundary", () => {
		const REST_HZ = 400_099_900
		const CALL_HZ = 400_100_100
		// Either side of a 12.5 kHz bin edge, and the same frequency for a lookup.
		expect(Math.floor(REST_HZ / 12_500)).not.toBe(Math.floor(CALL_HZ / 12_500))
		const h = harness()
		h.start()
		const at = (block: number, snrDb: number, hz: number, id: string): void => {
			if (block === 1 || block === 2 || block === 5)
				h.s.onCandidate(
					candidate(block, { channelSnrDb: snrDb, centreHz: hz }, id),
					STANDARD_MS,
				)
		}
		const toHop0 = (): void => {
			h.toNextHop()
			h.toNextHop()
		}
		// Waits at sweeps 1, 3 and 6: the last failure earned a rest of four sweeps.
		const history = [0, 1, 2, 3, 4, 5].map(i => {
			const blocks = runVisit(h, b => at(b, TRANSIENT_DB, REST_HZ, `r${i}`))
			toHop0()
			return blocks
		})
		expect(history).toEqual([
			STANDARD_ANSWER_BLOCKS,
			DWELL_BLOCKS,
			STANDARD_ANSWER_BLOCKS,
			DWELL_BLOCKS,
			DWELL_BLOCKS,
			STANDARD_ANSWER_BLOCKS,
		])
		const CALL_DB = 12
		runVisit(
			h,
			block => {
				at(block, CALL_DB, CALL_HZ, "call")
				if (block === 6)
					h.s.onTrack(
						candidate(
							6,
							{ gate: "passed", channelSnrDb: CALL_DB, centreHz: CALL_HZ },
							"call",
						),
						false,
						0,
						{ followOnAir: true },
					)
			},
			6,
		)
		expect(h.s.progress().holdingOn).toBe("call")
		// The transmission ends: the hop is left once the hold is over.
		h.note(h.s.onTrackClosed("call"))
		let guard = 0
		const before = h.tuned.length
		while (h.tuned.length === before && guard++ < 400) {
			h.block()
			h.note(h.s.tick(h.clock))
		}
		expect(h.tuned.length).toBeGreaterThan(before)
		h.s.onEpochStarted(h.sample)
		while (h.tuned[h.tuned.length - 1] !== HOP0 && guard++ < 400) h.toNextHop()
		expect(runVisit(h, b => at(b, TRANSIENT_DB, CALL_HZ, "later"))).toBe(
			STANDARD_ANSWER_BLOCKS,
		)
	})

	describe("a steady emitter that passes with nothing to hold", () => {
		/** Passes a burst gate at block 2 on each visit at `level(i)`, no class held: blocks per visit. */
		function burstVisits(
			sweeps: number,
			level: (i: number) => number,
		): number[] {
			const h = harness()
			h.start()
			const out: number[] = []
			for (let i = 0; i < sweeps; i++) {
				const id = `p${i}`
				const db = level(i)
				out.push(
					runVisit(h, block => {
						if (block === 1)
							h.s.onCandidate(candidate(1, { channelSnrDb: db }, id), BURST_MS)
						if (block >= 2 && block <= 5)
							h.s.onTrack(
								candidate(block, { gate: "passed", channelSnrDb: db }, id),
								false,
								0,
							)
					}),
				)
				h.toNextHop()
				h.toNextHop()
			}
			return out
		}
		const C = 5 // its class wait: to the fifth block

		it("keeps its class wait on every visit: a rest takes it from no voice call, at 100 ms each", () => {
			expect(burstVisits(6, () => 12)).toEqual([C, C, C, C, C, C])
		})

		it("a voice call after that carrier gets its class wait and its hold at the carrier's own level", () => {
			const h = harness()
			h.start()
			for (let i = 0; i < 6; i++) {
				const id = `p${i}`
				runVisit(h, block => {
					if (block === 1)
						h.s.onCandidate(candidate(1, { channelSnrDb: 12 }, id), BURST_MS)
					if (block >= 2 && block <= 5)
						h.s.onTrack(
							candidate(block, { gate: "passed", channelSnrDb: 12 }, id),
							false,
							0,
						)
				})
				h.toNextHop()
				h.toNextHop()
			}
			const blocks = runVisit(
				h,
				block => {
					if (block === 1)
						h.s.onCandidate(
							candidate(1, { channelSnrDb: 12 }, "voice"),
							BURST_MS,
						)
					if (block === 2 || block === 5)
						h.s.onTrack(
							candidate(block, { gate: "passed", channelSnrDb: 12 }, "voice"),
							false,
							0,
							{ followOnAir: block === 5 },
						)
				},
				5,
			)
			expect(blocks).toBe(5)
			expect(h.s.progress().holdingOn).toBe("voice")
		})
	})
})

describe("what counts as heard for a carrier's memory", () => {
	const K = CHANNEL_GATE_K_DB
	const spec = makeNormalisedSpec({
		revisit: { share: 0, maxIntervalMs: null },
		hold: { policy: "hold", confirmHoldMs: {}, maxHoldMs: 60_000, hangMs: 0 },
	})
	/** minSurfaceBlocks + 1 s of blocks: a due retry listening for the carrier's gap. */
	const GAP_LISTEN_BLOCKS = 2 + 20

	/** An 8 s watch earns carrier evidence on hop 0; a coarse sweep later its retry is due. */
	function dueRetry(): ReturnType<typeof harness> {
		const h = harness(spec)
		h.start()
		for (let block = 1; block <= 6; block++)
			h.block(() => {
				if (block < 6) h.s.onCandidate(candidate(block), STANDARD_MS)
				else h.s.onTrack(passed(6), false, 0, { followOnAir: true })
			})
		for (let i = 0; i < 165 && h.tuned.length === 1; i++) {
			h.block()
			h.note(h.s.tick(h.clock))
		}
		expect(h.tuned).toEqual([HOP0, HOP1])
		h.s.onEpochStarted(h.sample)
		h.toNextHop()
		h.toNextHop()
		// Past the rest (at most 3 × the 8 s hold).
		h.clock += 24_001
		return h
	}

	it("the control: an empty channel with a due retry listens for the gap", () => {
		const h = dueRetry()
		expect(runVisit(h, () => undefined)).toBe(GAP_LISTEN_BLOCKS)
	})

	it.each([
		["a 0 dB sighting", 2, 2, 0],
		["a reading under the gate's threshold", 2, 2, K - 0.1],
		["one block, however strong", 3, 1, 30],
	])(
		"%s on the empty channel is not heard: the retry still listens for the gap",
		(_name, atBlock, blocks, snrDb) => {
			const h = dueRetry()
			const visit = runVisit(h, block => {
				if (block === atBlock)
					h.s.onCandidate(
						candidate(blocks, { channelSnrDb: snrDb }, "w"),
						STANDARD_MS,
					)
			})
			expect(visit).toBe(GAP_LISTEN_BLOCKS)
		},
	)

	it("a sighting that would qualify is heard: no gap to listen for", () => {
		const h = dueRetry()
		const visit = runVisit(h, block => {
			if (block === 2)
				h.s.onCandidate(candidate(2, { channelSnrDb: K }, "w"), STANDARD_MS)
		})
		expect(visit).toBeLessThan(GAP_LISTEN_BLOCKS)
	})

	it("a low reading after one at the threshold is heard, as the gate's run holds it", () => {
		const h = dueRetry()
		const visit = runVisit(h, block => {
			if (block === 1)
				h.s.onCandidate(candidate(1, { channelSnrDb: 10 }, "w"), STANDARD_MS)
			if (block === 2)
				h.s.onCandidate(
					candidate(2, { channelSnrDb: K - 0.1 }, "w"),
					STANDARD_MS,
				)
		})
		expect(visit).toBeLessThan(GAP_LISTEN_BLOCKS)
	})

	/**
	 * Carrier evidence, then `visits` visits of its hop with `snrDb` sightings (none due). Then a
	 * strong candidate: a resting carrier leaves at the dwell, a forgotten frequency qualifies.
	 */
	function afterSightings(visits: number, snrDb: number): number {
		const h = harness(spec)
		h.start()
		for (let block = 1; block <= 6; block++)
			h.block(() => {
				if (block < 6) h.s.onCandidate(candidate(block), STANDARD_MS)
				else h.s.onTrack(passed(6), false, 0, { followOnAir: true })
			})
		for (let i = 0; i < 165 && h.tuned.length === 1; i++) {
			h.block()
			h.note(h.s.tick(h.clock))
		}
		h.s.onEpochStarted(h.sample)
		h.toNextHop()
		h.toNextHop()
		for (let i = 0; i < visits; i++) {
			runVisit(h, block => {
				if (block <= 2)
					h.s.onCandidate(
						candidate(block, { channelSnrDb: snrDb }, `w${i}`),
						STANDARD_MS,
					)
			})
			h.toNextHop()
			h.toNextHop()
		}
		return runVisit(h, steady(h, 12, "new"))
	}

	it("repeated weak sightings do not keep obsolete carrier evidence: it is forgotten like any miss", () => {
		const FORGET_MISSES = 10
		expect(afterSightings(FORGET_MISSES, 0)).toBe(STANDARD_ANSWER_BLOCKS)
	})

	it("sightings that would qualify do keep it: the carrier still rests", () => {
		const FORGET_MISSES = 10
		expect(afterSightings(FORGET_MISSES, 10)).toBe(DWELL_BLOCKS)
	})
})

describe("channelGateMinDurationMs", () => {
	const burst = { startHz: 100, endHz: 200, burst: true }
	const standard = { startHz: 150, endHz: 300, burst: false }

	it("the standard rule without an entry, the default slot is not burst", () => {
		expect(channelGateMinDurationMs([], 150, 10)).toBe(STANDARD_MS)
		expect(channelGateMinDurationMs([burst], 500, 10)).toBe(STANDARD_MS)
	})

	it("the burst rule only when burst entries alone overlap the track", () => {
		expect(channelGateMinDurationMs([burst], 120, 10)).toBe(BURST_MS)
		expect(channelGateMinDurationMs([burst, standard], 120, 10)).toBe(BURST_MS)
		expect(channelGateMinDurationMs([burst, standard], 170, 10)).toBe(
			STANDARD_MS,
		)
	})

	it("an edge touch is no overlap, one past it is", () => {
		expect(channelGateMinDurationMs([burst], 205, 10)).toBe(STANDARD_MS)
		expect(channelGateMinDurationMs([burst], 204, 10)).toBe(BURST_MS)
	})
})
