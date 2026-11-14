/**
 * A never-voiced line on a frequency known as traffic, followed (not watched) to its cap, showed no
 * voice of its own: a commitment it took from a neighbour's voice is tentative from that cap on
 * (ranToCap, endHold), and the keep names the neighbour's voice for its own track (voiceOwnTrack),
 * so a lone ID beside the line is held whole. Before the cap the commitment stays firm.
 *
 * Two hops of 1150 ms, settle 1000 ms, ticks every 50 ms. Sweep 1, hop 0: line "a" (analog voice)
 * closes 2 s into the visit, reopens 1.2 s later (a heard gap: traffic) and closes again at 4 s; a
 * quiet sweep follows. At the landing (hop 0's third visit) "a" is on again and stays on, never
 * voicing; the ID keys `idAt` from the landing, its own track "b" qualifying 300 ms later, the
 * recorder answering "judging" 3 s then voice, 28 s in all.
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

const TARGET_HZ = 150_100_000
const ID_MS = 28_000
/** The recorder answers "judging" this long after the ID's track opens, then voice. */
const JUDGING_MS = 3_000
/** The ID's track qualifies this long after it keys. */
const B_LAG_MS = 300
/** A voice hold's end is seen at its next re-check (RECORD_RECHECK_MS). */
const RECHECK_MS = 250
/**
 * The ID held whole: from its track's qualifying (or the landing, for an ID keyed before it) to its
 * end, less one re-check (28 000 − 300 − 250 = 27 450 ms for an ID keyed at the landing or later).
 */
const wholeMs = (idAt: number): number =>
	idAt + ID_MS - Math.max(0, idAt + B_LAG_MS) - RECHECK_MS

interface HoldState {
	trackId: string
	mode: string
	watch: boolean
	cap: number
	from: number
	decoded: boolean
}
interface Internals {
	hold: HoldState | null
	visit: {
		voiceTrackId: string | null
		voiceTentative: boolean
		voiceTrackVoiced: boolean
	} | null
	ranToCap(hold: HoldState, t: { open: boolean }, now: number): boolean
}

function scheduler(clock: () => number, recording: () => RecordingActivity) {
	return new SweepScheduler(
		makeHopPlan([150_000_000, 150_800_000], 409_600),
		makeNormalisedSpec({
			dwellMs: 1_150,
			settleMs: 1_000,
			revisit: { share: 0, maxIntervalMs: null },
		}),
		{
			blockSamples: 50,
			sampleRateHz: 1000,
			now: clock,
			probeStartMs: 300,
			recordingActive: recording,
		},
	)
}

function run(offsetHz: number, idAt: number) {
	const lineHz = TARGET_HZ + offsetHz
	const id = { voice: "id", quietMs: 0, targetHz: TARGET_HZ }
	const listing = { ...id, transmissions: { id } }
	let clock = 0
	let landing: number | null = null
	let visit0 = 0
	let visitStart = 0
	let hop = 0
	let settleAt: number | null = null
	/** Clock hop 0's current epoch started, null while away. */
	let on0Since: number | null = 0
	let bOpen = false
	let bAt: number | null = null
	const rel = (): number => (landing === null ? -1 : clock - landing)
	const idTo = idAt + ID_MS
	const recording = (): RecordingActivity => {
		if (on0Since === null || !bOpen || bAt === null || rel() >= idTo)
			return false
		return clock - bAt < JUDGING_MS ? "judging" : listing
	}
	const s = scheduler(() => clock, recording)
	const internals = s as unknown as Internals
	const sighting = (trackId: string, centreHz: number, snrDb: number) =>
		({
			...makeTrack({
				id: trackId,
				centreHz,
				startedAt: clock,
				blocks: 8,
				snrDb,
			}),
			trackId,
			obwHz: 11_000,
		}) as TrackSnapshot
	const stays: [number, number][] = []
	const apply = (actions: SchedulerAction[]): void => {
		for (const a of actions) {
			if (a.type !== "tune") continue
			if (hop === 0 && on0Since !== null && landing !== null)
				stays.push([on0Since - landing, clock - landing])
			hop = a.hopIndex
			on0Since = null
			bOpen = false
			bAt = null
			settleAt = clock + 1_000
		}
	}
	let aSeq = 0
	const addA = (): void =>
		apply(
			s.onTrack(sighting(`a${aSeq++}`, lineHz, 25), false, 0, {
				followOnAir: true,
			}),
		)
	const addB = (): void => {
		bOpen = true
		bAt = clock
		apply(
			s.onTrack(sighting(`b${clock}`, TARGET_HZ, 15), false, 0, {
				followOnAir: true,
			}),
		)
	}
	s.start()
	apply(s.onEpochStarted(0))
	visit0 = 1
	addA()
	/** The landing's follow of the line (watch false), its cap and the commitment's states around it. */
	let follow: HoldState | null = null
	let firmBeforeCap = false
	let tentativeAt: number | null = null
	for (clock = 50; clock <= 200_000; clock += 50) {
		if (landing !== null && rel() > idTo + 4_000) break
		if (settleAt !== null) {
			if (clock < settleAt) continue
			settleAt = null
			apply(s.onEpochStarted(clock))
			if (hop === 0) {
				visit0++
				visitStart = clock
				on0Since = clock
				if (visit0 === 3) landing = clock
				if (landing !== null) {
					addA()
					if (rel() >= idAt + B_LAG_MS && rel() < idTo) addB()
				}
			}
			continue
		}
		if (visit0 === 1 && hop === 0) {
			const p = clock - visitStart
			if (p === 2_000) apply(s.onTrackClosed(`a${aSeq - 1}`))
			if (p === 3_200) addA()
			if (p === 4_000) apply(s.onTrackClosed(`a${aSeq - 1}`))
		}
		if (hop === 0 && on0Since !== null && landing !== null) {
			if (!bOpen && rel() >= idAt + B_LAG_MS && rel() < idTo) addB()
			if (bOpen && rel() >= idTo) {
				bOpen = false
				apply(s.onTrackClosed(`b${bAt ?? 0}`))
			}
		}
		apply(s.onBlock(clock))
		apply(s.tick(clock))
		if (landing === null) continue
		const h = internals.hold
		const v = internals.visit
		if (
			h !== null &&
			h.trackId.startsWith("a") &&
			h.mode === "follow" &&
			!h.watch
		) {
			follow ??= { ...h }
			if (
				clock < h.cap &&
				v?.voiceTrackId === h.trackId &&
				!v.voiceTentative &&
				!v.voiceTrackVoiced
			)
				firmBeforeCap = true
		}
		if (
			tentativeAt === null &&
			follow !== null &&
			v !== null &&
			(v.voiceTentative || v.voiceTrackId?.startsWith("b") === true)
		)
			tentativeAt = clock
	}
	let wholeMs = 0
	for (const [a, b] of stays)
		wholeMs = Math.max(
			wholeMs,
			Math.min(b, idTo) - Math.max(a, idAt + B_LAG_MS),
		)
	return { wholeMs, follow, firmBeforeCap, tentativeAt }
}

describe("a never-voiced line on traffic followed to its cap (ranToCap)", () => {
	describe("the rule at and past the cap", () => {
		const s = scheduler(
			() => 0,
			() => false,
		) as unknown as Internals
		const follow = (over: Partial<HoldState> = {}): HoldState => ({
			trackId: "a",
			mode: "follow",
			watch: false,
			cap: 20_000,
			from: 1_000,
			decoded: false,
			...over,
		})
		const open = { open: true }

		it("a follow reaches its cap: un-voiced at the cap and past it, not one ms before", () => {
			expect(s.ranToCap(follow(), open, 19_999)).toBe(false)
			expect(s.ranToCap(follow(), open, 20_000)).toBe(true)
			expect(s.ranToCap(follow(), open, 20_001)).toBe(true)
		})

		it("a watch at its cap, whatever its length, as before", () => {
			const watch = follow({ watch: true, cap: 1_000 })
			expect(s.ranToCap(watch, open, 999)).toBe(false)
			expect(s.ranToCap(watch, open, 1_000)).toBe(true)
		})

		it("a follow capped at its own start (the probe only) shows nothing", () => {
			expect(s.ranToCap(follow({ cap: 1_000 }), open, 1_000)).toBe(false)
		})

		it("a confirm probe, a record keep, a decoded hold or a closed track show nothing", () => {
			expect(s.ranToCap(follow({ mode: "confirm" }), open, 20_000)).toBe(false)
			expect(s.ranToCap(follow({ mode: "record" }), open, 20_000)).toBe(false)
			expect(s.ranToCap(follow({ decoded: true }), open, 20_000)).toBe(false)
			expect(s.ranToCap(follow(), { open: false }, 20_000)).toBe(false)
		})

		it("a hang of the follow at its cap shows none", () => {
			expect(s.ranToCap(follow({ mode: "hang" }), open, 20_000)).toBe(true)
		})
	})

	for (const offsetHz of [-25_000, -12_500])
		for (const idAt of [-6_000, 0, 3_000, 6_000])
			it(`the line ${offsetHz / 1000} kHz away, the ID keyed ${idAt / 1000} s from the landing: the commitment firm before the follow's cap, tentative at it, and the ID held whole`, () => {
				const r = run(offsetHz, idAt)
				expect(r.wholeMs, JSON.stringify(r)).toBeGreaterThanOrEqual(
					wholeMs(idAt),
				)
				if (idAt < 0) return
				// The ID keyed after the line's follow started: the line was held first and committed
				// to firmly by the ID's voice, until the follow's cap.
				expect(r.follow, JSON.stringify(r)).not.toBeNull()
				expect(r.firmBeforeCap, JSON.stringify(r)).toBe(true)
				expect(r.tentativeAt, JSON.stringify(r)).not.toBeNull()
				expect(r.tentativeAt!).toBeGreaterThanOrEqual(r.follow!.cap)
			})
})
