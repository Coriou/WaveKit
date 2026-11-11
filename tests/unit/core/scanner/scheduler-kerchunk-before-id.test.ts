/**
 * One transmission, then the sweep, and a kerchunk before an ID costs the ID at most one landing.
 * A repeater keys up briefly (a carrier the scheduler watches), then IDs 400 ms after it drops. The
 * watch leaves the hop barred from a voice hold on its next landing (an overdue revisit after one
 * other hop): that landing's follow hears the ID and leaves with it on air. It recorded none of
 * the ID and owes no sweep for it, so the hop's next landing holds the ID to its end rather than
 * being voice-locked again and only probing. Through the deterministic sweep simulator; an earlier
 * ID on the frequency gave it voiced history.
 */
import { describe, expect, it } from "vitest"
import {
	simulateSweep,
	type SimSignal,
} from "../../../../src/core/scanner/plan/sweep-sim.js"
import type { RecordingActivity } from "../../../../src/core/scanner/scheduler.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"

const MHZ = 1_000_000
const HALF_SPAN_HZ = 409_600
const SETTLE_MS = 1_000
const BLOCK_MS = 50
const DWELL_MS = SETTLE_MS + 3 * BLOCK_MS
const HOPS = 3
const plan = makeHopPlan(
	Array.from({ length: HOPS }, (_, i) => 150 * MHZ + i * 800_000),
	HALF_SPAN_HZ,
)
/** An overdue revisit comes back to a hop after one other hop's visit. */
const spec = makeNormalisedSpec({
	dwellMs: DWELL_MS,
	settleMs: SETTLE_MS,
	revisit: { share: 0.3, maxIntervalMs: 2_000 },
})
const LAST = HOPS - 1
const HZ = plan.hops[LAST]!.centreHz + 100_000
const ID_MS = 29_000
/** The earlier ID that gave the frequency its voiced history. */
const FIRST_FROM = 36_000
const KERCHUNK_MS = 5_000
const KERCHUNK_GAP_MS = 400
const VOICE_ANSWER_MS = 1_500

const transmission = (startMs: number, endMs: number): SimSignal => ({
	centreHz: HZ,
	startMs,
	endMs,
	snrDb: 21,
	needsConfirm: true,
	confirmHoldMs: 1_800,
	followOnAir: true,
})

/**
 * The scene with the kerchunk from `kerchunkFrom`: its 0.5 s on / 0.4 s off bursts read as one
 * track (the tracker's hang joins them). The recorder voices an ID 1.5 s after the landing; a
 * visit tuned before an ID started records none of it (its session was the kerchunk's).
 */
function run(kerchunkFrom: number) {
	const idFrom = kerchunkFrom + KERCHUNK_MS + KERCHUNK_GAP_MS
	const id = transmission(idFrom, idFrom + ID_MS)
	let tunedHop: number | null = null
	let landedAt = 0
	const recorder = (c: number, hop: number | null): RecordingActivity => {
		if (hop !== tunedHop) {
			tunedHop = hop
			landedAt = c
		}
		if (hop !== LAST) return false
		const from = c < kerchunkFrom ? FIRST_FROM : idFrom
		if (c < from || c >= from + ID_MS || landedAt < from) return false
		if (c < landedAt + VOICE_ANSWER_MS) return "judging"
		return { voice: "id", quietMs: 0, recordedHz: HZ, targetHz: HZ }
	}
	const r = simulateSweep(plan, spec, {
		settleMs: SETTLE_MS,
		blockMs: BLOCK_MS,
		minSurfaceBlocks: 2,
		probeStartMs: 300,
		durationMs: id.endMs + 20_000,
		signals: [
			transmission(FIRST_FROM, FIRST_FROM + ID_MS),
			transmission(kerchunkFrom, kerchunkFrom + KERCHUNK_MS),
			id,
		],
		recordingActive: recorder,
	})
	const on = r.visits.filter(
		v =>
			v.hopIndex === LAST && v.leftAtMs > id.startMs && v.tunedAtMs < id.endMs,
	)
	// The kerchunk's watch, on air when the ID keys up, then the hop's landings on the ID.
	const watch = on.find(v => v.tunedAtMs < id.startMs)
	const landings = on.filter(v => v.tunedAtMs >= id.startMs)
	return { id, watch, landings }
}

describe("a kerchunk before an ID", () => {
	// Before the fix the barred landing owed the sweep for the ID it heard: the next coarse landing
	// was voice-locked and probed only (1150 ms), and the ID's longest visit was 16.1 to 16.35 s.
	it.each([69_700, 69_800, 69_900, 70_000])(
		"kerchunk from %i ms: the barred landing after the watch costs the ID one landing, the next holds it to its end",
		kerchunkFrom => {
			const { id, watch, landings } = run(kerchunkFrom)
			// The kerchunk was watched past the dwell.
			expect(watch).toBeDefined()
			expect(watch!.leftAtMs - watch!.tunedAtMs).toBeGreaterThan(DWELL_MS)
			expect(landings).toHaveLength(2)
			const barred = landings[0]!
			const held = landings[1]!
			// The barred landing heard the ID and left with it on air.
			expect(barred.tunedAtMs).toBeGreaterThan(id.startMs)
			expect(barred.leftAtMs).toBeLessThan(id.endMs)
			// The next landing holds the ID to its end: 18 s and more of it after the settle.
			expect(held.leftAtMs).toBeGreaterThanOrEqual(id.endMs)
			expect(held.leftAtMs - held.tunedAtMs - SETTLE_MS).toBeGreaterThanOrEqual(
				18_000,
			)
		},
	)
})
