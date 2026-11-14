/**
 * A follow that lands on a hop while a neighbouring channel of the same window is voiced, through
 * the production composition (runScene): the hold follows the transmission on its own frequency,
 * never a neighbour the recorder may name first. A 28 s ID every 70 s on one hop of three, and
 * 25 kHz above it a weaker neighbour (6 dB down) with two overs per ID: one keyed with the ID and
 * 10 s long, one from 13 s to 21 s into it, so a neighbour's over ends and another starts under
 * the ID's hold. Every transmission a visit remembers while it holds the ID's track
 * (Visit.heardVoiceId, a follow's) or holds by name (Visit.voiceId, a voice hold's, the keep of a
 * hop for its recording included) is looked up in the recorder's own sessions (voiceTx to
 * targetHz), not in the answer: on the ID's channel, never the neighbour's.
 *
 * A landing during a neighbour's over, whatever the hop timing: nothing is on air before each ID,
 * so the sweep visits every hop in turn (3 coarse visits of 1000 ms settle plus a 150 ms dwell:
 * 3450 ms a sweep) and lands on the ID's hop at most 3450 ms after both keyed; its listening then
 * runs at least the 300 ms gate, inside the neighbour's 10 s over (3450 + 300 < 10 000). The ID is
 * the stronger, so the sweep follows it (the strongest candidate). Settle 1000 ms, the production
 * value for a network source (config/default.yaml, `sweep.settleMs.network`; the harness source
 * is rtl_tcp). Measured, not asserted: whether the recorder names the neighbour first at those
 * landings (both keyed together, the ID's session opened first in every run so far), the slot
 * refusals of the ID's observations, and each ID's files. The neighbour named first is pinned
 * deterministically by scheduler-held-voice-band.test.ts. Synthetic signals only; a report's
 * numbers, no wall clock.
 */
import { describe, expect, it } from "vitest"
import type { RecordingActivity } from "../../../../src/core/scanner/scheduler.js"
import {
	ids,
	runScene,
	type Emitter,
	type SceneReport,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const HOPS = [CENTRE_HZ, CENTRE_HZ + 800_000, CENTRE_HZ + 1_598_000]
const TARGET_HZ = HOPS[1]! + 100_437
/** One 25 kHz channel up: inside the same window, outside the target's band. */
const NEIGHBOUR_HZ = TARGET_HZ + 25_000
/** The ID at the harness's default level, the neighbour 6 dB under it. */
const ID_AMP = 0.25
const NEIGHBOUR_AMP = 0.125
/** On a channel: within half a 12.5 kHz channel of its frequency. */
const SAME_CHANNEL_HZ = 6_250
const ID_MS = 28_000
const EVERY_MS = 70_000
const COUNT = 5
const FIRST_MS = 10_000
/** The last ID ends at 10 + 4 × 70 + 28 = 318 s; the scene runs to 380 s. */
const DURATION_MS = 380_000
/** The neighbour's overs, ms from each ID's start. */
const NEIGHBOUR_OVERS = [
	{ fromMs: 0, toMs: 10_000 },
	{ fromMs: 13_000, toMs: 21_000 },
]
/** sweep.settleMs.network in config/default.yaml. */
const SETTLE_MS = 1_000
/** The harness's default settle (sweep-qualification-harness.ts). */
const HARNESS_SETTLE_MS = 50
/**
 * The keyed neighbour: 3 s on, 3 s off, from 6 s before each ID to its end. From -6 s to 28 s
 * that is 34 s: overs at -6, 0, 6, 12, 18 and 24 s (3 s each, the last ends at 27 s, inside the ID).
 */
const KEYED_ON_MS = 3_000
const KEYED_PERIOD_MS = 6_000
const KEYED_LEAD_MS = 6_000
const KEYED_OVERS = Array.from(
	{ length: Math.ceil((KEYED_LEAD_MS + ID_MS) / KEYED_PERIOD_MS) },
	(_, k) => ({
		fromMs: -KEYED_LEAD_MS + k * KEYED_PERIOD_MS,
		toMs: -KEYED_LEAD_MS + k * KEYED_PERIOD_MS + KEYED_ON_MS,
	}),
)

/** The neighbour's overs (ms from each ID's start) for every ID. */
function neighbour(overs: readonly Over[]): Emitter[] {
	return Array.from({ length: COUNT }, (_, i) => {
		const idFrom = FIRST_MS + i * EVERY_MS
		return overs.map(o => ({
			hz: NEIGHBOUR_HZ,
			kind: "voice" as const,
			fromMs: idFrom + o.fromMs,
			toMs: idFrom + o.toMs,
			amp: NEIGHBOUR_AMP,
		}))
	}).flat()
}

interface Over {
	fromMs: number
	toMs: number
}
interface Band {
	centreHz: number
}
interface SchedulerInternals {
	visit: {
		heardVoiceId: string | null
		voiceId: string | null
		tracks: Map<string, Band>
	} | null
	hold: { trackId: string } | null
}
interface TrackInput {
	readonly observationId: string
	readonly track: { readonly centreHz: number }
}
interface ServiceInternals {
	widebandAnalog: {
		sessions: Map<string, { voiceTx: string | null; targetHz: number }>
		recordingActive(
			sourceId: string,
			at: { readonly stream: number; readonly epoch: number },
		): RecordingActivity
		onTrack(input: TrackInput): void
		decisions: { note(code: string, ref: { observationId: string }): void }
	}
}

interface Naming {
	/**
	 * Each transmission a visit remembered or held by name while it held the ID's track, once,
	 * with its session's frequency.
	 */
	adopted: { as: "heard" | "voice"; hz: number | undefined }[]
	/** Adoptions during holds of another track (the neighbour's own: its legitimate hold). */
	adoptedElsewhere: number
	/** Answers to a hold of the target's track naming the neighbour first, nothing remembered yet. */
	neighbourFirst: number
	/** Of those, the distinct visits they came in. */
	neighbourFirstVisits: number
	/** refused:slots notes (every call, repeats included) for observations on the ID's channel. */
	refusedSlots: number
	/** Distinct observations on the ID's channel refused a slot at least once. */
	refusedSlotObservations: number
	/** Per ID: refused:slots notes for observations on the ID's channel during it. */
	refusedSlotsPerId: number[]
	/**
	 * Per ID: visits of its hop whose listening (settle end to leave) overlaps both the ID and one
	 * of the neighbour's overs.
	 */
	landingsInOver: number[]
}

/**
 * Runs the scene, watching every recorder answer the scheduler reads and every chunk: each
 * transmission the visit adopts (heardVoiceId or voiceId) is looked up in the recorder's sessions
 * (voiceTx → targetHz), never in the answer, and every slot refusal of an observation on the ID's
 * channel is counted.
 */
async function neighbourAtLandingScene(scene: {
	overs: readonly Over[]
	settleMs: number
}): Promise<{
	r: SceneReport
	naming: Naming
}> {
	const naming: Naming = {
		adopted: [],
		adoptedElsewhere: 0,
		neighbourFirst: 0,
		neighbourFirstVisits: 0,
		refusedSlots: 0,
		refusedSlotObservations: 0,
		refusedSlotsPerId: Array.from({ length: COUNT }, () => 0),
		landingsInOver: [],
	}
	let visits: readonly {
		atMs: number
		endMs?: number | null
		centreHz: number
	}[] = []
	const hzOf = new Map<string, number>()
	const seen = new Set<string>()
	const firstVisits = new Set<object>()
	const obsHz = new Map<string, number>()
	const refusedObs = new Set<string>()
	const targetIds = ids({
		hz: TARGET_HZ,
		fromMs: FIRST_MS,
		everyMs: EVERY_MS,
		count: COUNT,
		idMs: ID_MS,
		amp: ID_AMP,
	})
	const r = await runScene({
		centreHz: CENTRE_HZ,
		ranges: [RANGE],
		durationMs: DURATION_MS,
		settleMs: scene.settleMs,
		emitters: [...targetIds, ...neighbour(scene.overs)],
		targets: targetIds.map((e, i) => ({
			hz: e.hz,
			fromMs: e.fromMs,
			toMs: e.toMs,
			label: `id${i + 1}`,
		})),
		onWorld: w => {
			visits = w.visits
			const sched = (): SchedulerInternals | undefined =>
				w.scheduler() as unknown as SchedulerInternals | undefined
			const rec = (w.service as unknown as ServiceInternals).widebandAnalog
			const learn = (): void => {
				for (const session of rec.sessions.values())
					if (session.voiceTx !== null)
						hzOf.set(session.voiceTx, session.targetHz)
			}
			const adopt = (): void => {
				const s = sched()
				const v = s?.visit ?? null
				if (v === null) return
				learn()
				const held =
					s?.hold === null || s?.hold === undefined
						? undefined
						: v.tracks.get(s.hold.trackId)
				const onId =
					held !== undefined &&
					Math.abs(held.centreHz - TARGET_HZ) < SAME_CHANNEL_HZ
				for (const [as, id] of [
					["heard", v.heardVoiceId],
					["voice", v.voiceId],
				] as const) {
					if (id === null || seen.has(`${as}:${id}:${onId}`)) continue
					seen.add(`${as}:${id}:${onId}`)
					if (onId) naming.adopted.push({ as, hz: hzOf.get(id) })
					else naming.adoptedElsewhere++
				}
			}
			const answer = rec.recordingActive.bind(rec)
			rec.recordingActive = (sourceId, at) => {
				adopt()
				const a = answer(sourceId, at)
				learn()
				const s = sched()
				const v = s?.visit ?? null
				const track =
					s?.hold === null || s?.hold === undefined
						? undefined
						: v?.tracks.get(s.hold.trackId)
				const firstHz =
					typeof a === "object" && "voice" in a ? hzOf.get(a.voice) : undefined
				if (
					v !== null &&
					v.heardVoiceId === null &&
					v.voiceId === null &&
					track !== undefined &&
					Math.abs(track.centreHz - TARGET_HZ) < SAME_CHANNEL_HZ &&
					firstHz !== undefined &&
					Math.abs(firstHz - NEIGHBOUR_HZ) < SAME_CHANNEL_HZ
				) {
					naming.neighbourFirst++
					firstVisits.add(v)
				}
				return a
			}
			const onTrack = rec.onTrack.bind(rec)
			rec.onTrack = input => {
				obsHz.set(input.observationId, input.track.centreHz)
				onTrack(input)
			}
			const note = rec.decisions.note.bind(rec.decisions)
			rec.decisions.note = (code, ref, ...rest: unknown[]) => {
				const hz = obsHz.get(ref.observationId)
				if (
					code === "refused:slots" &&
					hz !== undefined &&
					Math.abs(hz - TARGET_HZ) < SAME_CHANNEL_HZ
				) {
					naming.refusedSlots++
					refusedObs.add(ref.observationId)
					const k = targetIds.findIndex(
						t => w.nowMs() >= t.fromMs && w.nowMs() < t.toMs + EVERY_MS - ID_MS,
					)
					if (k >= 0) naming.refusedSlotsPerId[k]!++
				}
				;(note as (...a: unknown[]) => void)(code, ref, ...rest)
			}
			const chunk = w.advance.bind(w)
			w.advance = async ms => {
				// One chunk at a time, so each adoption is seen before the hold can change.
				for (let t = 0; t < ms; t += 25) {
					await chunk(25)
					adopt()
				}
			}
		},
	})
	const overlaps = (a: number, b: number, from: number, to: number): boolean =>
		Math.min(b, to) > Math.max(a, from)
	naming.landingsInOver = targetIds.map(
		t =>
			visits.filter(v => {
				const from = v.atMs + scene.settleMs
				const to = v.endMs ?? DURATION_MS
				return (
					v.centreHz === HOPS[1] &&
					overlaps(from, to, t.fromMs, t.toMs) &&
					scene.overs.some(o =>
						overlaps(from, to, t.fromMs + o.fromMs, t.fromMs + o.toMs),
					)
				)
			}).length,
	)
	naming.neighbourFirstVisits = firstVisits.size
	naming.refusedSlotObservations = refusedObs.size
	return { r, naming }
}

describe("a follow landing while a neighbour talks", () => {
	it("remembers and holds by name only the transmission on the ID's channel, never the neighbour's", async () => {
		const { r, naming } = await neighbourAtLandingScene({
			overs: NEIGHBOUR_OVERS,
			settleMs: SETTLE_MS,
		})
		expect(r.hops).toEqual(HOPS)
		const perId = r.targets.map(t => t.wavSeconds)
		const report = JSON.stringify({ perId, naming })
		// Only what holds in every run is asserted. How many landings fall inside a neighbour's over
		// (landingsInOver) and whether any transmission is adopted at all depend on event-loop
		// timing (when the recorder's sessions voice relative to the scheduler's 250 ms asks), so
		// they are reported (`report`), not asserted: a run where none is adopted is no defect.
		// Every transmission adopted lies on the ID's channel (a known frequency within half a
		// 12.5 kHz channel of it), and none near the neighbour.
		expect(
			naming.adopted.filter(
				a =>
					a.hz === undefined || Math.abs(a.hz - TARGET_HZ) >= SAME_CHANNEL_HZ,
			),
			report,
		).toEqual([])
		expect(
			naming.adopted.filter(
				a =>
					a.hz !== undefined && Math.abs(a.hz - NEIGHBOUR_HZ) < SAME_CHANNEL_HZ,
			),
			report,
		).toEqual([])
	}, 600_000)

	/**
	 * The discriminating composition: the neighbour keyed 3 s on, 3 s off from 6 s before each ID
	 * (KEYED_OVERS), 3 hops, 5 IDs, and the harness's default 50 ms settle, used because it puts
	 * landings on the ID's hop inside the neighbour's overs (a short settle lands within 3 s
	 * windows the 1 s production settle steps over), so the recorder names the neighbour first
	 * while the hold is on the ID's track (neighbourFirst counts it). Whether it does depends on
	 * event-loop timing: in some runs the neighbour is never named first, and then the scene cannot
	 * tell a scheduler that adopts the first name it is given from this one. Whole-ID files
	 * and counts are not asserted: the recorder's 2-slot cap (store/analog-operations.ts) refuses
	 * the ID's observations while the neighbour and an earlier session hold both slots, so an ID
	 * may record in part or not at all (refusedSlotsPerId is reported, not asserted). Every
	 * frequency comes from the recorder's own sessions, not from the production formula.
	 */
	it("with a keyed neighbour and landings inside its overs, adopts only the ID's transmissions", async () => {
		const { r, naming } = await neighbourAtLandingScene({
			overs: KEYED_OVERS,
			settleMs: HARNESS_SETTLE_MS,
		})
		expect(r.hops).toEqual(HOPS)
		const perId = r.targets.map(t => t.wavSeconds)
		const report = JSON.stringify({ perId, naming })
		// As above: landings inside the neighbour's overs and the count adopted depend on event-loop
		// timing, so only the frequencies of what was adopted are asserted.
		expect(
			naming.adopted.filter(
				a =>
					a.hz === undefined || Math.abs(a.hz - TARGET_HZ) >= SAME_CHANNEL_HZ,
			),
			report,
		).toEqual([])
		expect(
			naming.adopted.filter(
				a =>
					a.hz !== undefined && Math.abs(a.hz - NEIGHBOUR_HZ) < SAME_CHANNEL_HZ,
			),
			report,
		).toEqual([])
	}, 600_000)
})
