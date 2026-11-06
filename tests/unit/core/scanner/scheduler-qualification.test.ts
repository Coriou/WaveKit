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
	CHANNEL_GATE_MIN_DURATION_MS as STANDARD_MS,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { channelGateMinDurationMs } from "../../../../src/core/spectrum/channel-gate.js"
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
						h.s.onCandidate(candidate(block, {}, id), STANDARD_MS)
					if (answer === "close" && block === 6)
						h.s.onCandidateClosed(candidate(6, { gate: "below" }, id))
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
					if (block <= 2) h.s.onCandidate(candidate(block, {}, id), STANDARD_MS)
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
								{ centreHz: [HOP0, HOP1, HOP2][v % 3]! + 100_000 },
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
