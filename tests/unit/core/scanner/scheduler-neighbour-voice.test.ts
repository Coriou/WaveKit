/**
 * One transmission, then the sweep, judged by that transmission alone: a hold on a voiced
 * transmission ends when that transmission ends, never because another channel of the window is
 * voiced. The recorder names the first voiced session of the window (an older one first), so with
 * a neighbouring channel voiced the answer names the neighbour; it then lists every voiced
 * transmission still on air (Transmissions), and the scheduler judges the one it heard by its own
 * entry. Through the deterministic sweep simulator: a 28 s ID on the last hop of 3, a neighbouring
 * channel of the same window voiced in four 3 s overs during it, the recorder voiced 1.5 s into
 * each transmission.
 */
import { describe, expect, it } from "vitest"
import {
	simulateSweep,
	type SimSignal,
} from "../../../../src/core/scanner/plan/sweep-sim.js"
import type {
	RecordingActivity,
	VoiceOnAir,
} from "../../../../src/core/scanner/scheduler.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"

const MHZ = 1_000_000
const HALF_SPAN_HZ = 409_600
const SETTLE_MS = 1_000
const BLOCK_MS = 50
const DWELL_MS = SETTLE_MS + 3 * BLOCK_MS
const RECHECK_MS = 250
const VOICED_AFTER_MS = 1_500
const HOPS = 3
const plan = makeHopPlan(
	Array.from({ length: HOPS }, (_, i) => 150 * MHZ + i * 800_000),
	HALF_SPAN_HZ,
)
const spec = makeNormalisedSpec({ dwellMs: DWELL_MS, settleMs: SETTLE_MS })
const LAST = HOPS - 1
const ID_FROM = 30_000
const ID_MS = 28_000
const id: SimSignal = {
	centreHz: plan.hops[LAST]!.centreHz + 100_000,
	startMs: ID_FROM,
	endMs: ID_FROM + ID_MS,
	snrDb: 21,
	needsConfirm: true,
	confirmHoldMs: 1_800,
	followOnAir: true,
}
/** The neighbour's overs, ms from the ID's start: 3-6, 9-12, 15-18 and 21-24 s. */
const NEIGHBOUR = [3_000, 9_000, 15_000, 21_000].map(from => ({
	from: ID_FROM + from,
	to: ID_FROM + from + 3_000,
}))

/** The neighbour's channel: 25 kHz up, in the same window. */
const NEIGHBOUR_HZ = id.centreHz + 25_000

/**
 * The real recorder's answer for the last hop's window: the neighbour's session (opened earlier)
 * first, then the ID's, each with its session's frequency (VoiceOnAir.targetHz); each voiced from 1.5 s into its transmission until it ends. `list`: the
 * answer lists the window's voiced transmissions when there are two (the recorder's own rule).
 */
function recorder(list: boolean, idEndMs = id.endMs) {
	return (c: number, hop: number | null): RecordingActivity => {
		if (hop !== LAST) return false
		const voiced: VoiceOnAir[] = []
		NEIGHBOUR.forEach((o, k) => {
			if (c >= o.from && c < o.to)
				voiced.push({ voice: `n${k}`, quietMs: 0, targetHz: NEIGHBOUR_HZ })
		})
		if (c >= id.startMs + VOICED_AFTER_MS && c < idEndMs)
			voiced.push({ voice: "id", quietMs: 0, targetHz: id.centreHz })
		const first = voiced[0]
		if (first === undefined) return false
		if (!list || voiced.length < 2) return first
		return {
			...first,
			transmissions: Object.fromEntries(voiced.map(v => [v.voice, v])),
		}
	}
}

function run(list: boolean, signal = id) {
	const r = simulateSweep(plan, spec, {
		settleMs: SETTLE_MS,
		blockMs: BLOCK_MS,
		minSurfaceBlocks: 2,
		probeStartMs: 300,
		durationMs: ID_FROM + 60_000,
		signals: [signal],
		recordingActive: recorder(list, signal.endMs),
	})
	const held = r.visits.filter(
		v =>
			v.hopIndex === LAST &&
			v.leftAtMs > signal.startMs &&
			v.tunedAtMs < signal.endMs,
	)
	return { r, heardMs: r.heardMs[0] ?? 0, held }
}

describe("a neighbouring channel's voice is no end of the transmission a hold heard", () => {
	it("a 28 s ID with the neighbour voiced 4 times during it is held to its end, in one visit", () => {
		const { heardMs, held } = run(true)
		// One visit from the ID's detection to its end (left within a re-check and a block of it).
		const last = held.at(-1)!
		expect(last.tunedAtMs).toBeLessThan(NEIGHBOUR[0]!.from)
		expect(last.leftAtMs).toBeGreaterThanOrEqual(id.endMs)
		expect(last.leftAtMs).toBeLessThanOrEqual(id.endMs + RECHECK_MS + BLOCK_MS)
		// No leave at a neighbour's over: the ID is heard from its catch to its end.
		for (const o of NEIGHBOUR)
			expect(
				held.some(v => v.leftAtMs > o.from && v.leftAtMs < o.to + RECHECK_MS),
			).toBe(false)
		expect(heardMs).toBeGreaterThanOrEqual(26_000)
	})

	// The answer as it read before the recorder listed transmissions: the neighbour's name alone
	// read as a turnaround, and the hold left at each of its overs (the ID heard about half).
	it("without the list the neighbour's name reads as a turnaround: the hold leaves at its first over", () => {
		const { heardMs, held } = run(false)
		const o = NEIGHBOUR[0]!
		expect(
			held.some(
				v =>
					v.leftAtMs >= o.from + RECHECK_MS / 5 &&
					v.leftAtMs <= o.from + RECHECK_MS + BLOCK_MS,
			),
		).toBe(true)
		expect(heardMs).toBeLessThan(20_000)
	})

	it("the ID really ending (8 s, during the neighbour's second over) still ends the hold, and the sweep runs before the hop's next visit", () => {
		const short: SimSignal = { ...id, endMs: ID_FROM + 10_000 }
		const { r, held } = run(true, short)
		const visit = held.at(-1)!
		// Left at the first re-check after the ID's end, though the neighbour is still voiced.
		expect(visit.leftAtMs).toBeGreaterThanOrEqual(short.endMs)
		expect(visit.leftAtMs).toBeLessThanOrEqual(
			short.endMs + RECHECK_MS + BLOCK_MS,
		)
		const i = r.visits.indexOf(visit)
		const back = r.visits.findIndex((v, j) => j > i && v.hopIndex === LAST)
		expect(back).toBeGreaterThan(i)
		expect(new Set(r.visits.slice(i + 1, back).map(v => v.hopIndex))).toEqual(
			new Set([0, 1]),
		)
	})
})
