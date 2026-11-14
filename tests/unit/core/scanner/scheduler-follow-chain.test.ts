/**
 * One transmission, then the sweep: a follow of analog voice on a traffic frequency asks the
 * recorder as a voice hold does, so the end of the voiced transmission it heard ends the follow
 * and owes every other hop its coarse visit before any reply gets a voice hold. Through the
 * scheduler alone; the driver feeds one 50 ms block per step and the clock is the sample count.
 */
import { describe, expect, it } from "vitest"
import {
	type RecordingActivity,
	type SchedulerAction,
	SweepScheduler,
} from "../../../../src/core/scanner/scheduler.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const MHZ = 1_000_000
const HALF_SPAN_HZ = 409_600
const STEP_HZ = 800_000
const BASE_HZ = 150 * MHZ
const SETTLE_MS = 1_000
const BLOCK_MS = 50
const DWELL_MS = SETTLE_MS + 3 * BLOCK_MS
const RECHECK_MS = 250

/** Hop `n`'s signal frequency. */
const hopHz = (n: number): number => BASE_HZ + n * STEP_HZ + 100_437

/** A track on air from sample `from` to `last` (1 sample per ms: the clock is the sample count). */
const sighting = (
	id: string,
	hz: number,
	from: number,
	last: number,
): TrackSnapshot => ({
	...makeTrack({ id, centreHz: hz, startedAt: 0, blocks: 8 }),
	trackId: id,
	startSample: from,
	lastSample: last,
})

interface Visit {
	hop: number
	tunedAt: number
	leftAt: number | null
}

/**
 * The scene, in ms from the landing of hop 0's second visit (its first visit proves the frequency
 * traffic by a decode): a first over voiced from the landing to 6 s, its squelch seen closed 500 ms
 * later, 1.05 s of silence, then a reply until 30 s (seen 350 ms after it keys up), joined by the
 * recorder's hang into the same session.
 */
const OVER_END = 6_000
const CLOSE_SEEN = OVER_END + 500
const REPLY_FROM = OVER_END + 1_050
const REPLY_SEEN = REPLY_FROM + 350
/** The reply's own voice, judged 1 s late in a 500 ms window. */
const REPLY_VOICED = REPLY_FROM + 1_500
const REPLY_END = 30_000
/** L on 3 hops of 1150 ms (docs/SCANNER.md, Fair holds): 28 000 − 4600 − 5000. */
const L3 = 18_400

/**
 * Drives the scene. `session`: the recorder has a session on the frequency (it names the
 * transmissions); without one it answers false throughout the first over, and records the reply
 * alone (its own session, voiced from REPLY_VOICED).
 */
function chain(session: boolean) {
	let clock = 0
	let hop = 0
	let settleAt: number | null = null
	let landing: number | null = null
	const plan = makeHopPlan(
		[0, 1, 2].map(i => BASE_HZ + i * STEP_HZ),
		HALF_SPAN_HZ,
	)
	const visits: Visit[] = []
	const visitOf = (h: number): number => visits.filter(v => v.hop === h).length
	const rel = (): number => (landing === null ? -Infinity : clock - landing)
	const at = (ms: number): number => landing! + ms
	const answer = (): RecordingActivity => {
		if (hop !== 0 || landing === null) return false
		const ms = rel()
		if (visitOf(0) > 2)
			// A later visit of hop 0: a new epoch, a new session of the reply.
			return ms < REPLY_END
				? { voice: "c", quietMs: 0, targetHz: hopHz(0) }
				: false
		if (ms < CLOSE_SEEN)
			return session
				? ms < 1_500
					? "judging"
					: { voice: "a", quietMs: 0, targetHz: hopHz(0) }
				: false
		if (ms < REPLY_SEEN) return false
		if (ms < REPLY_VOICED)
			return session
				? { recording: true, voiceEnded: true, targetHz: hopHz(0) }
				: "judging"
		return ms < REPLY_END
			? { voice: "b", quietMs: 0, targetHz: hopHz(0) }
			: false
	}
	const s = new SweepScheduler(
		plan,
		makeNormalisedSpec({ dwellMs: DWELL_MS, settleMs: SETTLE_MS }),
		{
			blockSamples: BLOCK_MS,
			sampleRateHz: 1000,
			now: () => clock,
			probeStartMs: 0,
			minSurfaceBlocks: 2,
			recordingActive: answer,
		},
	)
	const apply = (next: SchedulerAction[]): void => {
		for (const a of next) {
			if (a.type !== "tune") continue
			const last = visits.at(-1)
			if (last !== undefined) last.leftAt = clock
			visits.push({ hop: a.hopIndex, tunedAt: clock, leftAt: null })
			hop = a.hopIndex
			settleAt = clock + SETTLE_MS
		}
	}
	let closed = false
	/** The track on air on hop 0 now, reported every block: [id, first sample]. */
	let onAir: [string, number] | null = null
	const report = (): void => {
		if (onAir !== null)
			s.onTrack(sighting(onAir[0], hopHz(0), onAir[1], clock), false, 0, {
				followOnAir: true,
			})
	}
	const land = (): void => {
		onAir = null
		if (hop !== 0) return
		const visit = visitOf(0)
		if (visit === 1)
			s.onTrack(sighting("t1", hopHz(0), clock, clock), true, 1_000, {
				followOnAir: true,
			})
		if (visit === 2) {
			landing = clock
			onAir = ["q", clock - 2_000]
		}
		if (visit > 2 && rel() < REPLY_END) onAir = [`r${visit}`, at(REPLY_FROM)]
		report()
	}
	/** Track events of the scene on hop 0. */
	const during = (): void => {
		if (hop !== 0 || landing === null) return
		if (visitOf(0) === 2) {
			if (!closed && rel() >= OVER_END && onAir?.[0] === "q") {
				report()
				onAir = null
			}
			if (!closed && rel() >= CLOSE_SEEN) {
				closed = true
				apply(s.onTrackClosed("q"))
			}
			if (onAir === null && rel() >= REPLY_SEEN && rel() < REPLY_END)
				onAir = ["r", at(REPLY_FROM)]
		}
		if (onAir !== null && rel() >= REPLY_END && onAir[0] !== "q") {
			apply(s.onTrackClosed(onAir[0]))
			onAir = null
		}
		report()
	}
	apply(s.start())
	const step = (): void => {
		if (settleAt !== null) {
			if (clock >= settleAt) {
				settleAt = null
				apply(s.onEpochStarted(clock))
				land()
			} else clock = settleAt
			return
		}
		clock += BLOCK_MS
		apply(s.onBlock(clock))
		during()
		apply(s.tick(clock))
	}
	const runUntil = (done: () => boolean, limitMs = 200_000): void => {
		while (!done()) {
			if (clock > limitMs) throw new Error("the sweep never got there")
			step()
		}
	}
	// A decode in the first visit proves hop 0's frequency traffic.
	runUntil(() => s.progress().holdingOn === "t1")
	apply(s.onConfirmed("t1", false))
	runUntil(() => landing !== null && rel() >= REPLY_END + 2_000)
	/** Ms hop `h` listened (tune plus settle to leave) within [fromMs, toMs) of the scene. */
	const listened = (h: number, span: { fromMs: number; toMs: number }) =>
		visits
			.filter(v => v.hop === h)
			.reduce((sum, v) => {
				const from = Math.max(v.tunedAt + SETTLE_MS, at(span.fromMs))
				const to = Math.min(v.leftAt ?? clock, at(span.toMs))
				return sum + Math.max(0, to - from)
			}, 0)
	const held = visits.filter(v => v.hop === 0)[1]!
	return { visits, held, at, listened }
}

describe("a follow of traffic that hears the voiced over end", () => {
	/** Every other hop is visited after `held` and before hop 0's next visit, which is returned. */
	const sweptAfter = (visits: Visit[], held: Visit): Visit => {
		const i = visits.indexOf(held)
		const back = visits.findIndex((v, j) => j > i && v.hop === 0)
		expect(back).toBeGreaterThan(i)
		expect(new Set(visits.slice(i + 1, back).map(v => v.hop))).toEqual(
			new Set([1, 2]),
		)
		return visits[back]!
	}

	// Before the fix the follow never asked the recorder: it ran to L (the first question 18.55 s
	// after the landing), then the reply got a voice hold of its own, and hop 0 stayed 31.05 s
	// (settle included) while hops 1 and 2 waited.
	it("with a recorder session: the follow ends at the reply's voiceEnded, the sweep runs, then the reply is held on the hop's next visit", () => {
		const { visits, held, at, listened } = chain(true)
		// Left at the first re-check after the reply joined the session: 7.5 s after the landing.
		expect(held.leftAt).not.toBeNull()
		expect(held.leftAt!).toBeLessThanOrEqual(
			at(REPLY_SEEN) + RECHECK_MS + BLOCK_MS,
		)
		const next = sweptAfter(visits, held)
		// Hops 1 and 2 listen in the time the chain took from them.
		expect(listened(1, { fromMs: REPLY_SEEN, toMs: 18_550 })).toBeGreaterThan(0)
		expect(listened(2, { fromMs: REPLY_SEEN, toMs: 18_550 })).toBeGreaterThan(0)
		// The reply is a transmission of its own: caught on the next visit and held to its end.
		expect(next.tunedAt).toBeLessThan(at(REPLY_END))
		expect(next.leftAt!).toBeGreaterThanOrEqual(at(REPLY_END))
	})

	it("with no recorder session: the follow runs on within L, and the squelch close owes the sweep before the reply gets a voice hold", () => {
		const { visits, held, at } = chain(false)
		expect(held.leftAt).not.toBeNull()
		// Within the follow's own bound (L from the start of the holds, after the 150 ms dwell),
		// never on into a voice hold of the reply.
		expect(held.leftAt! - held.tunedAt).toBeLessThanOrEqual(
			SETTLE_MS + 3 * BLOCK_MS + L3 + BLOCK_MS,
		)
		const next = sweptAfter(visits, held)
		expect(next.tunedAt).toBeLessThan(at(REPLY_END))
	})
})
