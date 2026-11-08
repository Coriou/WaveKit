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

async function turnaround(
	gapMs: number,
	phaseMs = 0,
	durationMs = 11_000,
	over: { fromMs: number; toMs: number } = FIRST_OVER_MS,
) {
	const off = over.toMs + phaseMs
	const w = qualificationWorld({
		centreHz: CENTRE_HZ,
		world: synthWorld([
			{
				hz: SIGNAL_HZ,
				kind: "voice",
				fromMs: over.fromMs,
				toMs: off,
			},
			{
				hz: SIGNAL_HZ,
				kind: "voice",
				fromMs: off + gapMs,
				toMs: Math.max(30_000, off + 20_000),
			},
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

	// The follow of the first over asks the recorder: once the reply, keyed 1,031 ms after the over,
	// joins the recorder's session by its hang, the over's transmission has ended, so the follow ends
	// and the hop owes its coarse sweep; the reply is held on the hop's next visit. (Before, the follow
	// never asked, ran on into the reply, and the reply got a voice hold of its own on the same visit.)
	it("a 1,031 ms turnaround: the sweep runs after the over, and the reply is held on the hop's next visit", async () => {
		const gapMs = 1_031
		const { w, entry } = await turnaround(gapMs, 0, 30_000)
		expect(entry?.evidence).toBe("traffic")
		const held = w.visits.find(v => v.centreHz === SIGNAL_HOP_HZ)!
		// Left once the reply surfaced (up to 350 ms after it keyed up) at the next 250 ms re-check,
		// the gap classed first.
		expect(held.endMs).not.toBeNull()
		expect(held.endMs!).toBeGreaterThanOrEqual(FIRST_OVER_MS.toMs + gapMs)
		expect(held.endMs!).toBeLessThanOrEqual(
			FIRST_OVER_MS.toMs + gapMs + 350 + 250 + 50,
		)
		expect(sweptAfter(w, held)).toEqual(otherHops(w))
		// The reply is caught on the next visit and held to past the end of the scene.
		const next = laterVisits(w)
		expect(next).toHaveLength(1)
		expect(next[0]!.atMs).toBeLessThan(30_000)
		expect(next[0]!.endMs).toBeNull()
	}, 60_000)

	/** Every hop of the plan is visited between the end of `held` and the signal hop's next visit. */
	const sweptAfter = (
		w: Awaited<ReturnType<typeof turnaround>>["w"],
		held: { endMs: number | null },
	) => {
		const i = w.visits.indexOf(held as (typeof w.visits)[number])
		const back = w.visits.findIndex(
			(v, j) => j > i && v.centreHz === SIGNAL_HOP_HZ,
		)
		const between = w.visits.slice(i + 1, back === -1 ? undefined : back)
		return new Set(between.map(v => v.centreHz))
	}
	const otherHops = (w: Awaited<ReturnType<typeof turnaround>>["w"]) =>
		new Set(w.visits.map(v => v.centreHz).filter(hz => hz !== SIGNAL_HOP_HZ))

	// The first over was recorded voiced (verified voice history), then its squelch closed and the
	// reply opened 900 ms later, joined into the recorder's session by its hang: the over's
	// transmission ended, so the hop owes its coarse sweep whatever its history, and the reply is
	// not held across the turnaround (history only lifts the carrier cap on a recording of the
	// voiced transmission itself).
	it("a 900 ms gap after a recorded over: the sweep runs after the over, not on into the reply", async () => {
		const { w, entry } = await turnaround(900, 0, 30_000)
		expect(entry?.flaps).toBe(true)
		expect(entry?.evidence).toBe("carrier")
		expect(entry?.voiced).toBe(true)
		const held = w.visits.find(v => v.centreHz === SIGNAL_HOP_HZ)!
		// Left within the turnaround's close and reopening (the over ends at 8 s, the reply at 8.9 s
		// surfaces up to 350 ms later), not held on into the reply.
		expect(held.endMs).not.toBeNull()
		expect(held.endMs!).toBeGreaterThanOrEqual(FIRST_OVER_MS.toMs)
		expect(held.endMs!).toBeLessThanOrEqual(FIRST_OVER_MS.toMs + 1_500)
		expect(sweptAfter(w, held)).toEqual(otherHops(w))
		expect(laterVisits(w).length).toBeGreaterThanOrEqual(4)
	}, 60_000)

	// An over longer than L is held as voice (the recorder answered it, so the frequency has its
	// verified voice history before the turnaround), then its squelch closes: its voice hold ends
	// there, and the forced coarse sweep runs before the hop is held again, whether the reply comes
	// 1,031 ms later (a turnaround) or 900 ms later (a flap).
	for (const gapMs of [1_031, 900])
		it(`a ${gapMs} ms turnaround after a voice-held over with voice history: the sweep runs after the over`, async () => {
			const over = { fromMs: 2_000, toMs: 24_000 }
			const { w, entry } = await turnaround(gapMs, 0, 32_000, over)
			expect(entry?.voiced).toBe(true)
			// Left at the close, before the reopening: the gap is not classed on this visit.
			expect(entry?.evidence).toBe("unknown")
			const held = w.visits.find(v => v.centreHz === SIGNAL_HOP_HZ)!
			// Held past L for the over's voice, left at its squelch close: the hold falls back at most
			// 2.85 s after the last word, before the reply is on air for long.
			expect(held.endMs).not.toBeNull()
			expect(held.endMs!).toBeGreaterThanOrEqual(over.toMs)
			expect(held.endMs!).toBeLessThanOrEqual(over.toMs + 2_850)
			expect(sweptAfter(w, held)).toEqual(otherHops(w))
		}, 90_000)
})
