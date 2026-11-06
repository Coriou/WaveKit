/**
 * A sweep's listening against its channel gate, through the production composition (see
 * sweep-qualification-harness.ts): a signal already on air when the visit arrives must get its gate's
 * answer and its class in that visit, whatever the gate rule at its frequency.
 */
import { afterEach, describe, expect, it } from "vitest"
import { CHANNEL_GATE_MIN_DURATION_MS } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	qualificationWorld,
	synthWorld,
	type Emitter,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
/** On the middle hop (about 100 kHz from its centre), off the FFT bins. */
const SIGNAL_HZ = CENTRE_HZ + 900_437
/** The hops the range plans, by centre (asserted, so a planner change shows here). */
const HOPS = [CENTRE_HZ, CENTRE_HZ + 800_000, CENTRE_HZ + 1_598_000]
const SIGNAL_HOP = HOPS[1]!
const GATES = [
	{ gate: "non-burst", protocols: undefined },
	{ gate: "burst-capable", protocols: ["ism"] },
] as const

/** Tuner chunk (25 ms) the visit's start and end are read at, either side. */
const CHUNK_MS = 25
const BLOCK_MS = 50
/** 50 ms settle and the 25 ms it takes the tune and its first block to line up with the chunks. */
const ARRIVAL_MS = 50 + 2 * CHUNK_MS + BLOCK_MS
/** minSurfaceBlocks + 1 blocks. */
const EMPTY_LISTEN_MS = 3 * BLOCK_MS
/** A visit of an empty hop, tune to tune. */
const EMPTY_VISIT_MS = ARRIVAL_MS + EMPTY_LISTEN_MS
/** The most a qualification adds for a signal on air at arrival: 8 − 3 blocks. */
const QUALIFY_MS = 5 * BLOCK_MS

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop()
})

async function sweep(
	emitters: Emitter[],
	protocols: readonly string[] | undefined,
	mode: "sweep" | "in-window" = "sweep",
) {
	const w = qualificationWorld({
		centreHz: CENTRE_HZ,
		world: synthWorld(emitters),
	})
	stops.push(() => w.stop())
	await w.service.start()
	const job = await w.service.createJob({
		sourceId: "rtl",
		mode,
		bandplans: [],
		ranges: [{ ...RANGE, ...(protocols ? { protocols: [...protocols] } : {}) }],
		priority: 50,
		takeover: true,
		resume: { autoAfterIdleMs: null },
	} as never)
	if (mode === "sweep") expect(job.plan.hops.map(h => h.centreHz)).toEqual(HOPS)
	return w
}

/** The first visit of the signal's hop that ran past a dwell, and whether its track was held in it. */
function firstHeld(w: Awaited<ReturnType<typeof sweep>>) {
	const held = w.holds.find(
		h => h.trackId !== null && h.centreHz === SIGNAL_HOP,
	)
	const visit =
		held === undefined
			? undefined
			: w.visits.find(
					v =>
						v.centreHz === SIGNAL_HOP &&
						v.atMs <= held.atMs &&
						(v.endMs === null || held.atMs <= v.endMs),
				)
	return { held, visit }
}

const signalTrack = (w: Awaited<ReturnType<typeof sweep>>) =>
	w.tracks.filter(t => Math.abs(t.centreHz - SIGNAL_HZ) < 15_000)

const hopVisits = (w: Awaited<ReturnType<typeof sweep>>, hz: number) =>
	w.visits.filter(v => v.centreHz === hz && v.endMs !== null)

describe("a line at the baseband position of the track the last hop left open", () => {
	const LINE_OFFSET_HZ = 100_437
	/** STALE_MAX_MS (the pipeline's stale discard), 20 blocks of 50 ms, on top of an empty visit. */
	const STALE_DISCARD_MS = 1_000

	const visitAfterWatch = async (offsetHz: number) => {
		const w = await sweep(
			[
				{
					hz: SIGNAL_HOP + LINE_OFFSET_HZ,
					kind: "carrier",
					fromMs: 0,
					toMs: 60_000,
				},
				{ hz: HOPS[2]! + offsetHz, kind: "carrier", fromMs: 0, toMs: 60_000 },
			],
			undefined,
		)
		await w.advance(12_000)
		const [first, ...later] = hopVisits(w, HOPS[2]!)
		return {
			first: first!.endMs! - first!.atMs,
			later: later.map(v => v.endMs! - v.atMs),
		}
	}

	it("reads as stale IQ on its hop's first visit: at most 1 s more, and only once", async () => {
		const { first, later } = await visitAfterWatch(LINE_OFFSET_HZ)
		expect(first).toBeGreaterThan(STALE_DISCARD_MS)
		expect(first).toBeLessThanOrEqual(
			EMPTY_VISIT_MS + STALE_DISCARD_MS + CHUNK_MS,
		)
		expect(later.length).toBeGreaterThan(0)
		for (const ms of later)
			expect(ms).toBeLessThanOrEqual(EMPTY_VISIT_MS + CHUNK_MS)
	}, 120_000)

	it("at any other offset the first visit is an empty visit's length", async () => {
		const { first } = await visitAfterWatch(LINE_OFFSET_HZ + 150_000)
		expect(first).toBeLessThanOrEqual(EMPTY_VISIT_MS + CHUNK_MS)
	}, 120_000)
})

describe.each(GATES)("a sweep over a $gate gate", ({ protocols }) => {
	it("voice on air at arrival is qualified, then held on the same visit until its transmission ends", async () => {
		// Long enough to outlast the 8 s watch: only the voice hold can keep the hop that long.
		const VOICE_MS = 10_500
		const w = await sweep(
			[{ hz: SIGNAL_HZ, kind: "voice", fromMs: 0, toMs: VOICE_MS }],
			protocols,
		)
		await w.advance(VOICE_MS + 1_500)
		const { held, visit } = firstHeld(w)
		expect(held).toBeDefined()
		expect(visit).toBeDefined()
		// Every earlier visit of the hop was short, and held the visit's own first track.
		const events = signalTrack(w).filter(
			t => t.trackId === held!.trackId && t.atMs >= visit!.atMs,
		)
		expect(events[0]?.gate).toBe("pending")
		expect(events.some(e => e.gate === "passed")).toBe(true)
		// The hold reaches the end of the transmission, past the 8 s watch, on one visit.
		const end = visit!.endMs ?? w.nowMs()
		expect(end).toBeGreaterThanOrEqual(VOICE_MS)
		expect(end - visit!.atMs).toBeGreaterThan(8_000)
		// All of it on one visit: no retune from the qualification to the end of the voice.
		expect(
			w.holds
				.filter(h => h.atMs > held!.atMs && h.atMs < VOICE_MS - 500)
				.every(h => h.centreHz === SIGNAL_HOP),
		).toBe(true)
		// Then a full coarse sweep: both other hops before the signal's hop has another visit of note.
		const after = w.visits.filter(v => v.atMs >= end).map(v => v.centreHz)
		expect(after.slice(0, 2)).toContain(HOPS[2])
	}, 120_000)

	it("a carrier on air at arrival is qualified on that visit, bounded, then released", async () => {
		const w = await sweep(
			[{ hz: SIGNAL_HZ, kind: "carrier", fromMs: 0, toMs: 60_000 }],
			protocols,
		)
		await w.advance(11_000)
		const passed = signalTrack(w).find(t => t.gate === "passed")
		expect(passed).toBeDefined()
		const visit = w.visits.find(
			v =>
				v.centreHz === SIGNAL_HOP &&
				v.atMs <= passed!.atMs &&
				v.endMs !== null &&
				passed!.atMs <= v.endMs,
		)
		expect(visit).toBeDefined()
		const { held } = firstHeld(w)
		const later = hopVisits(w, SIGNAL_HOP).filter(v => v.atMs > visit!.endMs!)
		expect(later.length).toBeGreaterThan(0)
		if (protocols === undefined) {
			// A confirm mode exists for its class here: the first hold is a watch of 8 s from its start.
			expect(held).toBeDefined()
			expect(visit!.endMs! - visit!.atMs).toBeLessThanOrEqual(
				8_000 + EMPTY_VISIT_MS + QUALIFY_MS + CHUNK_MS,
			)
			// Carrier evidence: its frequency rests, and its hop keeps the cadence with it on air.
			for (const v of later)
				expect(v.endMs! - v.atMs).toBeLessThanOrEqual(EMPTY_VISIT_MS + CHUNK_MS)
		} else {
			// Nothing to hold in an ISM range: each visit waits for its class, within the bound.
			expect(held).toBeUndefined()
			for (const v of [visit!, ...later])
				expect(v.endMs! - v.atMs).toBeLessThanOrEqual(
					EMPTY_VISIT_MS + QUALIFY_MS + CHUNK_MS,
				)
		}
		// The other hops got their visits after it.
		expect(
			w.visits.some(v => v.centreHz === HOPS[2] && v.atMs > visit!.endMs!),
		).toBe(true)
	}, 120_000)

	it("empty hops keep their cadence next to a qualifying one", async () => {
		const w = await sweep(
			[{ hz: SIGNAL_HZ, kind: "voice", fromMs: 0, toMs: 1_000 }],
			protocols,
		)
		await w.advance(8_000)
		for (const hz of [HOPS[0]!, HOPS[2]!]) {
			const visits = hopVisits(w, hz)
			expect(visits.length).toBeGreaterThan(1)
			for (const v of visits)
				expect(v.endMs! - v.atMs).toBeLessThanOrEqual(EMPTY_VISIT_MS + CHUNK_MS)
		}
	}, 120_000)

	it("an empty band's period is the dwells' alone", async () => {
		const w = await sweep([], protocols)
		await w.advance(3_000)
		const visits = w.visits.filter(v => v.endMs !== null)
		expect(visits.length).toBeGreaterThan(6)
		for (const v of visits)
			expect(v.endMs! - v.atMs).toBeLessThanOrEqual(EMPTY_VISIT_MS + CHUNK_MS)
	}, 120_000)
})

describe("a sweep's gate candidates through the real pipeline", () => {
	it("a tone the gate cannot measure gets no wait: its hop keeps its cadence", async () => {
		// Exactly on an FFT bin the channel reads no finite SNR, so no gate run can start.
		const hz = CENTRE_HZ + 800_000 + 100_000
		const w = await sweep(
			[{ hz, kind: "carrier", fromMs: 0, toMs: 60_000 }],
			undefined,
		)
		await w.advance(3_000)
		const tracks = w.tracks.filter(t => Math.abs(t.centreHz - hz) < 15_000)
		expect(tracks.length).toBeGreaterThan(0)
		expect(tracks.every(t => t.gate !== "passed")).toBe(true)
		for (const v of hopVisits(w, SIGNAL_HOP))
			expect(v.endMs! - v.atMs).toBeLessThanOrEqual(EMPTY_VISIT_MS + CHUNK_MS)
	}, 120_000)

	it("an in-window job is told nothing: no retune, and a track passes at the gate's own pace", async () => {
		const hz = CENTRE_HZ + 100_437
		const w = qualificationWorld({
			centreHz: CENTRE_HZ,
			world: synthWorld([{ hz, kind: "carrier", fromMs: 0, toMs: 60_000 }]),
		})
		stops.push(() => w.stop())
		await w.service.start()
		await w.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			bandplans: [],
			ranges: [{ startHz: CENTRE_HZ - 300_000, endHz: CENTRE_HZ + 300_000 }],
			priority: 50,
			takeover: true,
			resume: { autoAfterIdleMs: null },
		} as never)
		await w.advance(1_500)
		expect(w.scheduler() ?? null).toBeNull()
		expect(
			w.tuner.sent.filter(
				c => c.origin === "scanner" && c.name === "set-frequency",
			),
		).toEqual([])
		const passed = w.tracks.find(
			t => Math.abs(t.centreHz - hz) < 15_000 && t.gate === "passed",
		)
		// 300 ms of the gate at 50 ms blocks.
		expect(passed?.blocks).toBe(CHANNEL_GATE_MIN_DURATION_MS / BLOCK_MS)
	}, 120_000)
})
