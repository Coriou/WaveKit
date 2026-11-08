/**
 * "Record whole voice" (the user's policy for sweeps): a recording with voice on air keeps its hop
 * until that transmission ends, up to `hold.maxHoldMs`, then a full coarse sweep runs before the
 * hop gets another voice hold. Measured with the deterministic sweep simulator on a busy-band
 * scene: a QSO (overs 5 to 30 s, turnarounds 1 to 3 s) on hop 0, 28 s IDs on the last hop, 900 s,
 * 3 and 7 hops, seeds 1 to 4, the QSO from 0 s and from 60 s. The recorder is voiced 1.5 s into a
 * transmission (class + voice gate).
 *
 * Recorder models compared:
 * - none: no recorder (the scheduler's own follows only);
 * - true: a recorder that only reports a recording: a voiced session answers true from 1.5 s into
 *   an over until 2 s after it (the recorder's hangMs), kept within L;
 * - voice: this policy: voice on air (named by its over) from 1.5 s into an over until its squelch
 *   closes, false after.
 * The same QSO through a repeater is modelled apart (repeater hang, below).
 *
 * The accepted cost (the user's decision): while someone talks on one hop, a short ID on another
 * hop can start and end unseen. The numbers are asserted so a change shows here.
 */
import { describe, expect, it } from "vitest"
import {
	simulateSweep,
	type SimResult,
	type SimSignal,
} from "../../../../src/core/scanner/plan/sweep-sim.js"
import type { RecordingActivity } from "../../../../src/core/scanner/scheduler.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"

const MHZ = 1_000_000
const HALF_SPAN_HZ = 409_600
const centres = (n: number): number[] =>
	Array.from({ length: n }, (_, i) => 150 * MHZ + i * 800_000)
const SETTLE_MS = 1_000
const BLOCK_MS = 50
const DWELL_MS = SETTLE_MS + 3 * BLOCK_MS
const RUN_MS = 900_000
/** Class (analog-fm) and the voice gate: the recorder is voiced this long into a transmission. */
const VOICED_AFTER_MS = 1_500
/** The recorder's hangMs: a session stays open this long after a transmission. */
const HANG_MS = 2_000
const spec = makeNormalisedSpec({ dwellMs: DWELL_MS, settleMs: SETTLE_MS })
const sim = {
	settleMs: SETTLE_MS,
	blockMs: BLOCK_MS,
	minSurfaceBlocks: 2,
	probeStartMs: 300,
}

const voice = (
	hz: number,
	startMs: number,
	durationMs = 28_000,
): SimSignal => ({
	centreHz: hz,
	startMs,
	endMs: startMs + durationMs,
	snrDb: 21,
	needsConfirm: true,
	confirmHoldMs: 1_800,
	followOnAir: true,
})

/** xorshift32 (seed 0 → 1). */
function rng(seed: number): () => number {
	let s = seed >>> 0 || 1
	return () => {
		s ^= s << 13
		s >>>= 0
		s ^= s >>> 17
		s ^= s << 5
		s >>>= 0
		return s / 2 ** 32
	}
}

/** A QSO: overs of 5 to 30 s, turnarounds of 1 to 3 s, from `fromMs` to RUN_MS. */
function qso(hz: number, fromMs: number, seed: number): SimSignal[] {
	const r = rng(seed)
	const out: SimSignal[] = []
	let t = fromMs
	while (t < RUN_MS) {
		const on = Math.round(5_000 + r() * 25_000)
		const end = Math.min(RUN_MS, t + on)
		out.push(voice(hz, t, end - t))
		t = end + Math.round(1_000 + r() * 2_000)
	}
	return out
}

/** ID starts: from 30 s every 43 s + seed s, up to 870 s. */
function idStarts(seed: number): number[] {
	const out: number[] = []
	for (let t = 30_000; t < RUN_MS - 30_000; t += 15_000 + 28_000 + seed * 1_000)
		out.push(t)
	return out
}

type Model = "none" | "true" | "voice"

type Recorder = (clockMs: number, hopIndex: number | null) => RecordingActivity

function recorder(
	model: Model,
	signals: readonly SimSignal[],
	inHop: (hop: number | null, hz: number) => boolean,
): Recorder | undefined {
	if (model === "none") return undefined
	if (model === "voice")
		return (c, hop) => {
			const k = signals.findIndex(
				s =>
					inHop(hop, s.centreHz) &&
					c >= s.startMs + VOICED_AFTER_MS &&
					c < s.endMs,
			)
			return k < 0 ? false : { voice: `tx-${k}` }
		}
	return (c, hop) =>
		signals.some(
			s =>
				inHop(hop, s.centreHz) &&
				c >= s.startMs + VOICED_AFTER_MS &&
				c < s.endMs + HANG_MS,
		)
}

interface SceneStats {
	ids: number
	missed: number
	/** IDs heard at least 25 s. */
	heardWhole: number
	/** Σ ms heard of the QSO over the eight runs. */
	qsoMs: number
}

function scene(hops: number, model: Model): SceneStats {
	const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
	const inHop = (hop: number | null, hz: number): boolean =>
		hop !== null &&
		hz >= plan.hops[hop]!.covered.startHz &&
		hz <= plan.hops[hop]!.covered.endHz
	const out: SceneStats = { ids: 0, missed: 0, heardWhole: 0, qsoMs: 0 }
	for (const seed of [1, 2, 3, 4])
		for (const fromMs of [0, 60_000]) {
			const talk = qso(plan.hops[0]!.centreHz + 100_000, fromMs, seed)
			const idHz = plan.hops[hops - 1]!.centreHz + 100_000
			const ids = idStarts(seed).map(ms => voice(idHz, ms))
			const signals = [...talk, ...ids]
			const rec = recorder(model, signals, inHop)
			const r: SimResult = simulateSweep(plan, spec, {
				...sim,
				durationMs: RUN_MS,
				signals,
				...(rec ? { recordingActive: rec } : {}),
			})
			ids.forEach((_, k) => {
				out.ids++
				if (r.detectedAtMs[talk.length + k] === null) out.missed++
				if ((r.heardMs[talk.length + k] ?? 0) >= 25_000) out.heardWhole++
			})
			for (let k = 0; k < talk.length; k++) out.qsoMs += r.heardMs[k] ?? 0
		}
	return out
}

/** A visit kept past its dwell (a follow or a recording hold), not a plain sweep visit. */
const kept = (v: { tunedAtMs: number; leftAtMs: number }): boolean =>
	v.leftAtMs - v.tunedAtMs > 2 * DWELL_MS

/** A lone 28 s ID on the last hop starting at `startMs`, recorded under `model`. */
function isolated(hops: number, startMs: number, model: Model) {
	const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
	const inHop = (hop: number | null, hz: number): boolean =>
		hop !== null &&
		hz >= plan.hops[hop]!.covered.startHz &&
		hz <= plan.hops[hop]!.covered.endHz
	const id = voice(plan.hops[hops - 1]!.centreHz + 100_000, startMs)
	const rec = recorder(model, [id], inHop)
	const r = simulateSweep(plan, spec, {
		...sim,
		durationMs: startMs + 60_000,
		signals: [id],
		...(rec ? { recordingActive: rec } : {}),
	})
	return {
		heardMs: r.heardMs[0] ?? 0,
		// Kept from its detection to its end: left within one 250 ms re-check and a block of it.
		heldToEnd: r.visits.some(
			v =>
				v.hopIndex === hops - 1 &&
				kept(v) &&
				v.leftAtMs >= id.endMs &&
				v.leftAtMs <= id.endMs + 250 + BLOCK_MS,
		),
	}
}

describe("record whole voice: the busy-band scene (900 s, 152 IDs over 8 runs per plan)", () => {
	// Measured with this simulator. "true" is a recorder that reports a recording without voice
	// (that scheduler path keeps L). A recorder answering voice for its whole session (every over
	// and hang of it, one name) measured on the same scene: 3 hops 41 of 152 IDs missed, QSO
	// 3 877 550 ms, 21 IDs heard ≥ 25 s; 7 hops 23 missed, 3 125 550 ms, 7 heard ≥ 25 s.
	// One transmission, then the sweep: a follow of the QSO asks the recorder too, so the end of the
	// over it heard ends the hold, and the next over is held only when the sweep is back (before, a
	// follow ran on into the next over within L, which then got a voice hold of its own: 3 hops 12
	// of 152 IDs missed, 27 heard ≥ 25 s, QSO 3 369 700 ms; 7 hops 1, 23 and 2 663 500 ms). Each
	// hop's voice hold is its own: an ID caught during the sweep forced after an over is kept whole
	// too (heard ≥ 25 s: 45 and 42, none with the "true" recorder). The cost: the QSO is heard 20 %
	// less than with the "true" recorder on 3 hops and 13 % less on 7 hops (less than with no
	// recorder, whose follows run on into the next over within L).
	const table: [number, Model, number, number, number][] = [
		// hops, model, IDs missed, IDs heard ≥ 25 s, QSO heard (Σ ms over the eight runs)
		[3, "none", 0, 0, 3_373_050],
		[3, "true", 0, 0, 3_399_600],
		[3, "voice", 0, 45, 2_721_100],
		[7, "none", 0, 0, 2_373_750],
		[7, "true", 0, 0, 2_453_750],
		[7, "voice", 0, 42, 2_128_350],
	]
	for (const [hops, model, missed, whole, qsoMs] of table)
		it(`${hops} hops, recorder ${model}: ${missed} of 152 other-hop IDs missed, ${whole} heard ≥ 25 s, QSO heard ${qsoMs} ms`, () => {
			expect(scene(hops, model)).toEqual({
				ids: 152,
				missed,
				heardWhole: whole,
				qsoMs,
			})
		})
})

/**
 * The busy-band QSO through a repeater whose carrier hangs `hangMs` after each over: overs closer
 * than the hang share one carrier, so the recorder's track stays open and the whole span is one
 * transmission (one name). Voice is on air from 1.5 s into an over until VOICE_TAIL_MS after it
 * (the 2 s voice window on audio judged 1 s late, plus part of the last 500 ms window), never
 * past the carrier; true while the carrier hangs without voice; false once it drops. The IDs on
 * the last hop are recorded as in the busy-band scene (model "voice").
 *
 * What the sweep's own tracks see (`view`): "overs", a track per over (the carrier's level
 * changes at each turnaround, as on a repeater heard weaker than its users); "carrier", one track
 * per carrier, which the scheduler's carrier rules also bound.
 */
const VOICE_TAIL_MS = 3_250

function repeated(overs: readonly SimSignal[], hangMs: number): SimSignal[][] {
	const carriers: SimSignal[][] = []
	for (const o of overs) {
		const last = carriers.at(-1)
		if (last !== undefined && o.startMs < last.at(-1)!.endMs + hangMs)
			last.push(o)
		else carriers.push([o])
	}
	return carriers
}

function repeaterScene(
	hops: number,
	hangMs: number,
	view: "overs" | "carrier",
) {
	const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
	const inHop = (hop: number | null, hz: number): boolean =>
		hop !== null &&
		hz >= plan.hops[hop]!.covered.startHz &&
		hz <= plan.hops[hop]!.covered.endHz
	const out = { ids: 0, missed: 0, heardWhole: 0, longestHop0Ms: 0 }
	for (const seed of [1, 2, 3, 4])
		for (const fromMs of [0, 60_000]) {
			const hz = plan.hops[0]!.centreHz + 100_000
			const overs = qso(hz, fromMs, seed)
			const groups = repeated(overs, hangMs)
			const carriers = groups.map(g =>
				voice(hz, g[0]!.startMs, g.at(-1)!.endMs + hangMs - g[0]!.startMs),
			)
			const idHz = plan.hops[hops - 1]!.centreHz + 100_000
			const ids = idStarts(seed).map(ms => voice(idHz, ms))
			const idRecorder = recorder("voice", ids, inHop)!
			const rec: Recorder = (c, hop) => {
				if (!inHop(hop, hz)) return idRecorder(c, hop)
				const k = carriers.findIndex(t => c >= t.startMs && c < t.endMs)
				if (k < 0) return false
				const g = groups[k]!
				if (c < g[0]!.startMs + VOICED_AFTER_MS) return false
				const voiced = g.some(
					o => c >= o.startMs + VOICED_AFTER_MS && c < o.endMs + VOICE_TAIL_MS,
				)
				return voiced ? { voice: `carrier-${k}` } : true
			}
			const talk = view === "overs" ? overs : carriers
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: RUN_MS,
				signals: [...talk, ...ids],
				recordingActive: rec,
			})
			ids.forEach((_, k) => {
				out.ids++
				if (r.detectedAtMs[talk.length + k] === null) out.missed++
				if ((r.heardMs[talk.length + k] ?? 0) >= 25_000) out.heardWhole++
			})
			for (const v of r.visits)
				if (v.hopIndex === 0)
					out.longestHop0Ms = Math.max(
						out.longestHop0Ms,
						v.leftAtMs - v.tunedAtMs,
					)
		}
	return out
}

describe("record whole voice: the busy-band QSO through a repeater (repeater hang)", () => {
	// The known cost: a repeater's hang carrier keeps the over's track open across turnarounds
	// shorter than the hang, and voice stays on air VOICE_TAIL_MS past the last word, so a
	// turnaround under about 1.75 s is never seen and the hold runs across overs up to
	// hold.maxHoldMs (60 s). More IDs on another hop are missed than on simplex (none of 152 on 3
	// or 7 hops). Measured with this simulator; asserted so a change shows here. A track per
	// carrier: a watch whose run is speech marks no carrier, so a repeater on air from the job's
	// start stays callable and its voice is held. With a 3 s hang most turnarounds never close the
	// carrier, and the hop holds again as soon as the sweep is back, so about as many IDs are missed
	// as with a track per over (the user's rule: a voice hold per transmission).
	const table: [number, number, "overs" | "carrier", number, number, number][] =
		[
			// hops, hang (ms), sweep view, IDs missed, IDs heard ≥ 25 s, longest hop-0 visit (ms)
			[3, 1_500, "overs", 15, 33, 61_150],
			[3, 3_000, "overs", 34, 13, 61_150],
			[7, 1_500, "overs", 14, 39, 61_150],
			[7, 3_000, "overs", 38, 23, 61_150],
			// Before follows asked the recorder (one transmission, then the sweep), per row: 26 and
			// 30, 32 and 15, 24 and 25, 38 and 26; a track per carrier 10 and 81, 36 and 33, 8 and 81,
			// 41 and 22.
			[3, 1_500, "carrier", 5, 94, 61_150],
			[3, 3_000, "carrier", 35, 33, 61_150],
			[7, 1_500, "carrier", 8, 70, 61_150],
			[7, 3_000, "carrier", 41, 22, 61_150],
		]
	for (const [hops, hangMs, view, missed, whole, longest] of table)
		it(`${hops} hops, ${hangMs} ms hang, a track per ${view === "overs" ? "over" : "carrier"}: ${missed} of 152 other-hop IDs missed, ${whole} heard ≥ 25 s, the longest hop-0 visit ${longest} ms`, () => {
			expect(repeaterScene(hops, hangMs, view)).toEqual({
				ids: 152,
				missed,
				heardWhole: whole,
				longestHop0Ms: longest,
			})
		})
})

describe("record whole voice: an isolated 28 s ID (starts 20 to 40 s every 500 ms, 41 runs)", () => {
	// Kept to its end from its detection under "voice"; how much of it is heard depends on how
	// late the sweep comes back to its hop (up to one sweep on 3 hops, more on 7). Measured.
	const pinned: [number, number, number][] = [
		// hops, runs heard ≥ 25 s, least heard (ms)
		[3, 38, 24_700],
		[7, 19, 20_400],
	]
	for (const [hops, whole, least] of pinned)
		it(`${hops} hops: every run held to the ID's end, ${whole} of 41 heard ≥ 25 s, the least heard ${least} ms (true: none heard ≥ 25 s)`, () => {
			let heardWhole = 0
			let min = Number.POSITIVE_INFINITY
			let plainWhole = 0
			for (let t = 20_000; t <= 40_000; t += 500) {
				const x = isolated(hops, t, "voice")
				expect(x.heldToEnd).toBe(true)
				if (x.heardMs >= 25_000) heardWhole++
				min = Math.min(min, x.heardMs)
				if (isolated(hops, t, "true").heardMs >= 25_000) plainWhole++
			}
			expect(heardWhole).toBe(whole)
			expect(min).toBe(least)
			expect(plainWhole).toBe(0)
		})
})

describe("record whole voice: the scheduler", () => {
	const plan3 = makeHopPlan(centres(3), HALF_SPAN_HZ)
	const hz0 = plan3.hops[0]!.centreHz + 100_000
	const inHop0 = (hop: number | null, hz: number): boolean =>
		hop === 0 &&
		hz >= plan3.hops[0]!.covered.startHz &&
		hz <= plan3.hops[0]!.covered.endHz

	it("a carrier after the voice: the hop is left at the first re-check once the voice is gone past L, not at maxHoldMs", () => {
		// One transmission on hop 0 from 5 s to 125 s: voice to 35 s, then a keyed carrier with no
		// voice (the recorder answers true). L on 3 hops is 18 400 ms from the visit's first hold.
		const tx = voice(hz0, 5_000, 120_000)
		const r = simulateSweep(plan3, spec, {
			...sim,
			durationMs: 130_000,
			signals: [tx],
			recordingActive: (c, hop) =>
				!inHop0(hop, hz0) || c < tx.startMs + VOICED_AFTER_MS || c >= tx.endMs
					? false
					: c < 35_000
						? { voice: "tx" }
						: true,
		})
		const first = r.visits.find(v => v.hopIndex === 0 && kept(v))!
		expect(first.leftAtMs).toBeGreaterThanOrEqual(35_000)
		expect(first.leftAtMs).toBeLessThanOrEqual(35_000 + 250 + BLOCK_MS)
		// The carrier is never kept past L again: no later visit of hop 0 runs past L + a dwell.
		for (const v of r.visits.filter(x => x.hopIndex === 0 && x !== first))
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(DWELL_MS + 18_400)
	})

	it("a QSO turnaround: the voice hold ends at the over's squelch close, then every hop is visited before the next over gets a voice hold", () => {
		// Overs of 40 s with 2 s turnarounds on hop 0: [5, 45), [47, 87), [89, 129) s.
		const overs = [5_000, 47_000, 89_000].map(t => voice(hz0, t, 40_000))
		const r = simulateSweep(plan3, spec, {
			...sim,
			durationMs: 140_000,
			signals: overs,
			recordingActive: (c, hop) => {
				const k = overs.findIndex(
					o =>
						inHop0(hop, o.centreHz) &&
						c >= o.startMs + VOICED_AFTER_MS &&
						c < o.endMs,
				)
				return k < 0 ? false : { voice: `over-${k}` }
			},
		})
		const zero = r.visits.filter(v => v.hopIndex === 0)
		// The voice holds (kept to their over's end): every over, each its own transmission. Each is
		// caught when the forced coarse sweep comes back to the hop, 2 to 3 s into the over.
		const voiceHolds = zero.filter(
			v =>
				kept(v) &&
				overs.some(
					o => v.leftAtMs >= o.endMs && v.leftAtMs <= o.endMs + 250 + BLOCK_MS,
				),
		)
		expect(voiceHolds.map(v => v.leftAtMs)).toEqual([45_050, 87_000, 129_200])
		// Between the two, hops 1 and 2 each get a coarse visit.
		const between = r.visits.filter(
			v =>
				v.tunedAtMs >= voiceHolds[0]!.leftAtMs &&
				v.leftAtMs <= voiceHolds[1]!.tunedAtMs,
		)
		expect(new Set(between.map(v => v.hopIndex))).toEqual(new Set([1, 2]))
		// Right after the first voice hold, hop 0 is not kept until hops 1 and 2 were visited.
		const after = r.visits.filter(v => v.tunedAtMs >= 45_050)
		const firstKept = after.findIndex(v => v.hopIndex === 0 && kept(v))
		const before = new Set(after.slice(0, firstKept).map(v => v.hopIndex))
		expect(before.has(1) && before.has(2)).toBe(true)
	})

	it("a watch elsewhere holds the long-hold lock: a transmission caught meanwhile is still kept to its end", () => {
		const hz1 = plan3.hops[1]!.centreHz + 100_000
		const hz2 = plan3.hops[2]!.centreHz + 100_000
		// Something unknown on hop 2 from the start: an 8 s watch, longer than a coarse sweep, sets the
		// lock. The ID starts during that watch, so the sweep comes back to it while the lock holds.
		const other = voice(hz2, 0, 130_000)
		const id = voice(hz1, 9_000, 28_000)
		const r = simulateSweep(plan3, spec, {
			...sim,
			durationMs: 60_000,
			signals: [other, id],
			recordingActive: (c, hop) =>
				hop === 1 && c >= id.startMs + VOICED_AFTER_MS && c < id.endMs
					? { voice: "id" }
					: false,
		})
		const watch = r.visits.find(v => v.hopIndex === 2 && kept(v))!
		expect(watch.leftAtMs).toBeGreaterThan(id.startMs)
		const caught = r.visits.find(
			v => v.hopIndex === 1 && v.leftAtMs > watch.leftAtMs,
		)!
		expect(caught.leftAtMs).toBeGreaterThanOrEqual(id.endMs)
		expect(caught.leftAtMs).toBeLessThanOrEqual(id.endMs + 250 + BLOCK_MS)
	})

	it("a recording that voices after the keep gets the transmission's voice hold, not L", () => {
		// The recorder answers true at the end of the watch (a pause in the speech, its window spent),
		// voice again after it. L on 3 hops is 18 400 ms from the visit's first hold.
		const tx = voice(hz0, 5_000, 50_000)
		const pausedFrom = tx.startMs + 8_000
		const r = simulateSweep(plan3, spec, {
			...sim,
			durationMs: 70_000,
			signals: [tx],
			recordingActive: (c, hop) => {
				if (
					!inHop0(hop, hz0) ||
					c < tx.startMs + VOICED_AFTER_MS ||
					c >= tx.endMs
				)
					return false
				return c >= pausedFrom && c < pausedFrom + 5_000
					? true
					: { voice: "tx" }
			},
		})
		const first = r.visits.find(v => v.hopIndex === 0 && kept(v))!
		expect(first.leftAtMs).toBeGreaterThanOrEqual(tx.endMs)
		expect(first.leftAtMs).toBeLessThanOrEqual(tx.endMs + 250 + BLOCK_MS)
	})

	it("no activity revisit comes back during the sweep a voice hold forces", () => {
		const plan = makeHopPlan(centres(7), HALF_SPAN_HZ)
		// Longer than the first watch, so the recording gets its voice hold.
		const tx = voice(plan.hops[0]!.centreHz + 100_000, 5_000, 25_000)
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 50_000,
			signals: [tx],
			recordingActive: (c, hop) =>
				hop === 0 && c >= tx.startMs + VOICED_AFTER_MS && c < tx.endMs
					? { voice: "tx" }
					: false,
		})
		const held = r.visits.find(v => v.hopIndex === 0 && kept(v))!
		const after = r.visits.filter(v => v.tunedAtMs >= held.leftAtMs).slice(0, 6)
		expect(after.map(v => v.hopIndex).sort()).toEqual([1, 2, 3, 4, 5, 6])
	})
})
