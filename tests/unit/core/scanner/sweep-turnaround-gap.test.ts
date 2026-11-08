/**
 * The 1 s that tells a turnaround from a flap is a gap on air, through the production composition
 * (sweep-qualification-harness.ts): the engine closes a track about 500 ms after it went quiet and a
 * reopening surfaces up to 350 ms after it came back, and neither delay may count in or out of the
 * gap. Synthetic voice only; the world's clock is samples fed, no wall clock.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
	qualificationWorld,
	synthWorld,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
/** No protocols: a non-burst gate, which passes a reopening about 350 ms after it came back. */
const RANGE = { startHz: 445_700_000, endHz: 447_500_000 }
const SIGNAL_HZ = 447_000_437
const SIGNAL_HOP_HZ = 446_900_000
const SETTLE_MS = 1_000
const FIRST_OVER_MS = { fromMs: 2_000, toMs: 8_000 }

interface MemoryView {
	centreHz: number
	evidence: string
	flaps: boolean
	voiced: boolean
}

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop()
})

async function turnaround(gapMs: number, phaseMs = 0, durationMs = 11_000) {
	const off = FIRST_OVER_MS.toMs + phaseMs
	const w = qualificationWorld({
		centreHz: CENTRE_HZ,
		world: synthWorld([
			{
				hz: SIGNAL_HZ,
				kind: "voice",
				fromMs: FIRST_OVER_MS.fromMs,
				toMs: off,
			},
			{ hz: SIGNAL_HZ, kind: "voice", fromMs: off + gapMs, toMs: 30_000 },
		]),
		patch: s => {
			s.sweep.settleMs.local = SETTLE_MS
			s.sweep.settleMs.network = SETTLE_MS
		},
	})
	stops.push(() => w.stop())
	await w.service.start()
	await w.service.createJob({
		sourceId: "rtl",
		mode: "sweep",
		bandplans: [],
		ranges: [RANGE],
		priority: 50,
		takeover: true,
		resume: { autoAfterIdleMs: null },
	} as never)
	await w.advance(durationMs)
	const memory = (w.scheduler() as unknown as { memory: MemoryView[] }).memory
	const entry = memory.find(m => Math.abs(m.centreHz - SIGNAL_HZ) < 12_500)
	return { w, entry }
}

describe("a turnaround is read on air", () => {
	for (const [gapMs, reading] of [
		[600, "a flap"],
		[900, "a flap"],
		[1_000, "traffic"],
		[1_031, "traffic"],
	] as const)
		for (const phaseMs of [0, 30])
			it(`a gap of ${gapMs} ms, ending an over ${phaseMs} ms later, is ${reading}`, async () => {
				const { entry } = await turnaround(gapMs, phaseMs)
				expect(entry?.evidence).toBe(
					reading === "a flap" ? "carrier" : "traffic",
				)
				expect(entry?.flaps).toBe(reading === "a flap")
			}, 60_000)

	/** Visits of the voice's hop from the second over on: start and end of each. */
	const laterVisits = (w: Awaited<ReturnType<typeof turnaround>>["w"]) =>
		w.visits.filter(v => v.centreHz === SIGNAL_HOP_HZ && v.atMs > 9_500)

	it("a 1,031 ms turnaround keeps the hop for the voice that follows it", async () => {
		const { w, entry } = await turnaround(1_031, 0, 30_000)
		expect(entry?.evidence).toBe("traffic")
		// One visit from the first over's first hold to past the end of the scene.
		expect(laterVisits(w)).toEqual([])
		expect(w.visits.at(-1)?.centreHz).toBe(SIGNAL_HOP_HZ)
		expect(w.visits.at(-1)?.endMs).toBeNull()
	}, 60_000)

	// The first over was recorded voiced: verified voice history, which carrier evidence never caps,
	// so the flap's evidence does not cut the voice that follows it (as a 1,031 ms turnaround's does
	// not, above).
	it("a 900 ms gap is a flap, but on a frequency whose voice was recorded the hop is kept for the voice that follows it", async () => {
		const { w, entry } = await turnaround(900, 0, 30_000)
		expect(entry?.flaps).toBe(true)
		expect(entry?.evidence).toBe("carrier")
		expect(entry?.voiced).toBe(true)
		expect(laterVisits(w)).toEqual([])
		expect(w.visits.at(-1)?.centreHz).toBe(SIGNAL_HOP_HZ)
		expect(w.visits.at(-1)?.endMs).toBeNull()
	}, 60_000)
})
