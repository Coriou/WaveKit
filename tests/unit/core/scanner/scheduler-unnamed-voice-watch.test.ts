/**
 * An unbroken watch is no carrier evidence while voice is on air in the window, named after the
 * hold or not (keepForRecording): a 28 s ID caught mid-way (its onset unseen, so an 8 s watch,
 * CARRIER_WATCH_MS) whose own session was refused a slot while a neighbour 12.5 kHz up holds both,
 * so the recorder answers only the neighbour's voice. That voice names no voice hold (holdVoiceOf),
 * and the hop may still be left at the watch's end: under the long-hold lock another hop's long hold
 * set, or at the cap of what L has left. Either way the ID's frequency earns no carrier evidence,
 * which would refuse it voice holds after (recordedTrack). With no voice on air anywhere, the
 * watch is carrier evidence as before. The scheduler alone; the clock is the sample count.
 */
import { describe, expect, it } from "vitest"
import {
	type RecordingActivity,
	type SchedulerAction,
	SweepScheduler,
	type VoiceOnAir,
} from "../../../../src/core/scanner/scheduler.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const ID_HZ = 150_100_000
/** The next 12.5 kHz channel: outside the ID's band (max(4500, 2000) + 3000 = 7500 Hz). */
const NEIGHBOUR_HZ = ID_HZ + 12_500
const WATCH_MS = 8_000
/** The dwell's end, where the watch starts: the epoch at 0, 150 ms of listening after the settle. */
const HELD_AT = 150
/** L on 2 hops of 1150 ms (docs/SCANNER.md, Fair holds): 28 000 − 3450 − 5000. */
const L2 = 19_550

const neighbour: VoiceOnAir = {
	voice: "n",
	quietMs: 0,
	targetHz: NEIGHBOUR_HZ,
}

interface Memory {
	centreHz: number
	evidence: string
}
interface Internals {
	memory: Memory[]
	longHoldLock: number
	lockHop: number | null
	hops: { waitMs: number }[]
	hold: { watch: boolean; cap: number } | null
}

type Exit = "lock" | "cap"

/**
 * 2 hops; track "a" on the ID's frequency, analog voice on air since before the landing (no full
 * visit missed it: onset unseen), so the dwell starts an 8 s watch at HELD_AT. `exit` arranges the
 * keep's early exit at the watch's end: "lock", the long-hold lock set by hop 1's long hold; "cap",
 * hop 1 waited L − 5000 ms already, so L has 5000 ms left (< the 8 s watch).
 */
function watch(exit: Exit, recording: (ms: number) => RecordingActivity) {
	let clock = 0
	const s = new SweepScheduler(
		makeHopPlan([150_000_000, 150_800_000], 409_600),
		makeNormalisedSpec({
			dwellMs: 1_150,
			settleMs: 1_000,
			revisit: { share: 0, maxIntervalMs: null },
		}),
		{
			blockSamples: 50,
			sampleRateHz: 1000,
			now: () => clock,
			probeStartMs: 300,
			recordingActive: () => recording(clock),
		},
	)
	const internals = s as unknown as Internals
	const sighting: TrackSnapshot = {
		...makeTrack({ id: "a", centreHz: ID_HZ, startedAt: 0, blocks: 8 }),
		trackId: "a",
	}
	const tunes = (a: SchedulerAction[]): boolean =>
		a.some(x => x.type === "tune")
	s.start()
	s.onEpochStarted(0)
	if (exit === "lock") {
		internals.longHoldLock = 1
		internals.lockHop = 1
	} else internals.hops[1]!.waitMs = L2 - 5_000
	s.onTrack(sighting, false, 0, { followOnAir: true })
	for (let e = 50; e <= HELD_AT; e += 50) {
		clock = e
		if (tunes(s.onBlock(e))) throw new Error("left at the dwell")
	}
	const hold = internals.hold
	if (hold === null) throw new Error("no watch")
	expect(hold.watch).toBe(true)
	expect(hold.cap).toBe(HELD_AT + WATCH_MS)
	let leftAt: number | null = null
	for (clock = HELD_AT + 50; clock <= 30_000; clock += 50) {
		s.onBlock(clock)
		if (tunes(s.tick(clock))) {
			leftAt = clock
			break
		}
	}
	const m = internals.memory.find(x => Math.abs(x.centreHz - ID_HZ) < 1_000)
	return { leftAt, evidence: m?.evidence }
}

describe("an unbroken watch with voice on air that names no voice hold", () => {
	for (const exit of ["lock", "cap"] as const) {
		const how =
			exit === "lock"
				? "under the long-hold lock"
				: "at the cap of what L has left (5000 ms < 8000)"

		it(`left ${how}: no carrier evidence on the ID's frequency`, () => {
			const r = watch(exit, () => neighbour)
			// Left at the watch's end, not kept for the recording.
			expect(r.leftAt).toBe(HELD_AT + WATCH_MS)
			expect(r.evidence).not.toBe("carrier")
		})

		it(`left ${how} with the neighbour listed beside a quiet session: still no carrier evidence`, () => {
			const r = watch(exit, () => ({
				...neighbour,
				transmissions: { n: neighbour, q: "quiet" },
			}))
			expect(r.leftAt).toBe(HELD_AT + WATCH_MS)
			expect(r.evidence).not.toBe("carrier")
		})

		it(`control, left ${how} with no voice on air anywhere (a recording that is not voice): carrier evidence as before`, () => {
			const r = watch(exit, () => true)
			expect(r.leftAt).toBe(HELD_AT + WATCH_MS)
			expect(r.evidence).toBe("carrier")
		})

		it(`control, left ${how} with nothing recorded: carrier evidence as before`, () => {
			const r = watch(exit, () => false)
			expect(r.leftAt).toBe(HELD_AT + WATCH_MS)
			expect(r.evidence).toBe("carrier")
		})
	}
})
