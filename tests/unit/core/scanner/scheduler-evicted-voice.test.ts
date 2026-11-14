/**
 * One transmission, then the sweep, whatever the recorder does with its slots: a voiced
 * transmission whose recorder session gave its slot up to another candidate (an eviction) while
 * its track stays open is still on air. The recorder lists it "unrecorded" (Transmissions) until
 * its track closes, and the scheduler holds it as a recording that is not voice: within L, never to
 * `hold.maxHoldMs` (no file is made of it). Its close ends the hold; a hold cut at L leaves it still
 * on air. Either way the sweep runs before the hop's next visit. Through the deterministic sweep simulator: an ID on the last hop of 3, a neighbouring
 * channel of the same window voiced from 3 s into it, the ID's session evicted 6 s in.
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
const MAX_HOLD_MS = 60_000
const plan = makeHopPlan(
	Array.from({ length: HOPS }, (_, i) => 150 * MHZ + i * 800_000),
	HALF_SPAN_HZ,
)
const spec = makeNormalisedSpec({ dwellMs: DWELL_MS, settleMs: SETTLE_MS })
const LAST = HOPS - 1
const ID_FROM = 30_000
const NEIGHBOUR_FROM = ID_FROM + 3_000
const EVICT_AT = ID_FROM + 6_000
const ID_HZ = plan.hops[LAST]!.centreHz + 100_000
const signal = (ms: number): SimSignal => ({
	centreHz: ID_HZ,
	startMs: ID_FROM,
	endMs: ID_FROM + ms,
	snrDb: 21,
	needsConfirm: true,
	confirmHoldMs: 1_800,
	followOnAir: true,
})

/**
 * The real recorder's answer for the last hop's window: the ID's session voiced 1.5 s in, the
 * neighbour's ("x", opened later) voiced from NEIGHBOUR_FROM to the end of the run. From
 * EVICT_AT the ID's session is evicted: no session answers for it any more. `list`: the answer
 * lists the ID "unrecorded" until its track closes (the recorder's rule); without it the answer
 * is the neighbour's own, as it read before.
 */
function recorder(list: boolean, idEndMs: number) {
	return (c: number, hop: number | null): RecordingActivity => {
		if (hop !== LAST) return false
		const voiced: VoiceOnAir[] = []
		const idOn = c >= ID_FROM + VOICED_AFTER_MS && c < idEndMs
		// Each with its session's frequency (VoiceOnAir.targetHz); the neighbour 25 kHz up.
		if (idOn && c < EVICT_AT)
			voiced.push({ voice: "id", quietMs: 0, targetHz: ID_HZ })
		if (c >= NEIGHBOUR_FROM)
			voiced.push({ voice: "x", quietMs: 0, targetHz: ID_HZ + 25_000 })
		const unrecorded = idOn && c >= EVICT_AT && list
		const first = voiced[0]
		if (first === undefined)
			return unrecorded
				? { recording: true, bare: false, transmissions: { id: "unrecorded" } }
				: false
		if (voiced.length < 2 && !unrecorded) return first
		return {
			...first,
			transmissions: {
				...Object.fromEntries(voiced.map(v => [v.voice, v])),
				...(unrecorded ? { id: "unrecorded" as const } : {}),
			},
		}
	}
}

function run(list: boolean, idMs: number) {
	const id = signal(idMs)
	const r = simulateSweep(plan, spec, {
		settleMs: SETTLE_MS,
		blockMs: BLOCK_MS,
		minSurfaceBlocks: 2,
		probeStartMs: 300,
		durationMs: ID_FROM + 100_000,
		signals: [id],
		recordingActive: recorder(list, id.endMs),
	})
	const held = r.visits.filter(
		v =>
			v.hopIndex === LAST && v.leftAtMs > id.startMs && v.tunedAtMs < id.endMs,
	)
	return { r, id, heardMs: r.heardMs[0] ?? 0, held }
}

/** The visit after `visit` on hop LAST, and the hops visited between them. */
function sweepAfter(
	r: ReturnType<typeof simulateSweep>,
	visit: (typeof r.visits)[0],
) {
	const i = r.visits.indexOf(visit)
	const back = r.visits.findIndex((v, j) => j > i && v.hopIndex === LAST)
	return {
		back,
		i,
		between: new Set(r.visits.slice(i + 1, back).map(v => v.hopIndex)),
	}
}

describe("an evicted voiced session is no end of its transmission", () => {
	// An evicted transmission is still on air but no file is made of it: it is held like any
	// recording that is not voice, within L, never to hold.maxHoldMs (one transmission, then the
	// sweep, and a hold only for what is being recorded).
	it("a 28 s ID evicted 6 s in, a neighbour voiced: not ended at the eviction, held within L, then the sweep", () => {
		const { r, held, id } = run(true, 28_000)
		const visit = held.find(v => v.tunedAtMs < EVICT_AT)!
		expect(visit.leftAtMs).toBeGreaterThan(EVICT_AT + 2 * RECHECK_MS)
		expect(visit.leftAtMs).toBeLessThan(id.endMs)
		expect(visit.leftAtMs).toBeLessThan(visit.tunedAtMs + MAX_HOLD_MS)
		const { back, i, between } = sweepAfter(r, visit)
		expect(back).toBeGreaterThan(i)
		expect(between).toEqual(new Set([0, 1]))
	})

	// The answer as it read before the recorder listed evicted transmissions: the neighbour's own
	// answer, whose name read as the ID's turnaround, and the hold left at the eviction.
	it("without the list the eviction reads as the ID's end: the hold leaves within a re-check of it", () => {
		const { held, id } = run(false, 28_000)
		const visit = held.find(v => v.tunedAtMs < EVICT_AT)!
		expect(visit.leftAtMs).toBeGreaterThanOrEqual(EVICT_AT)
		expect(visit.leftAtMs).toBeLessThanOrEqual(EVICT_AT + RECHECK_MS + BLOCK_MS)
		expect(visit.leftAtMs).toBeLessThan(id.endMs)
	})

	it("the evicted ID really ending (12 s in, the neighbour still voiced) ends the hold, and the sweep runs before the hop's next visit", () => {
		const { r, held, id } = run(true, 12_000)
		const visit = held.at(-1)!
		expect(visit.leftAtMs).toBeGreaterThanOrEqual(id.endMs)
		expect(visit.leftAtMs).toBeLessThanOrEqual(id.endMs + RECHECK_MS + BLOCK_MS)
		const { back, i, between } = sweepAfter(r, visit)
		expect(back).toBeGreaterThan(i)
		expect(between).toEqual(new Set([0, 1]))
	})

	it("an evicted ID longer than hold.maxHoldMs is left within L, long before that bound, and the sweep runs before the hop's next visit", () => {
		expect(spec.hold.maxHoldMs).toBe(MAX_HOLD_MS)
		const { r, held, id } = run(true, 90_000)
		const visit = held.find(v => v.tunedAtMs < EVICT_AT)!
		expect(visit.leftAtMs).toBeGreaterThan(EVICT_AT + 2 * RECHECK_MS)
		expect(visit.leftAtMs).toBeLessThan(visit.tunedAtMs + MAX_HOLD_MS)
		expect(visit.leftAtMs).toBeLessThan(id.endMs)
		const { back, i, between } = sweepAfter(r, visit)
		expect(back).toBeGreaterThan(i)
		expect(between).toEqual(new Set([0, 1]))
	})
})
