/**
 * A follow that lands on a hop while a neighbouring channel of the same window is already voiced,
 * through the production composition (runScene): the hold follows the transmission on its own
 * frequency (the held track's band), never the neighbour named first by the recorder. A 28 s ID
 * every 70 s on one hop of three, and 25 kHz up a neighbour talking 3 s on, 3 s off from 6 s
 * before each ID to its end, so it is voiced at landings. The visit remembers (Visit.heardVoiceId)
 * only a transmission whose frequency lies in the held track's band, so the neighbour's overs are
 * no end of the ID's hold. The harness's settle (50 ms, runScene's default):
 * the sweep lands while the neighbour talks, so the recorder names the neighbour first (with a
 * 1000 ms settle the landings of this scene fall in its off phase). Synthetic signals only; a
 * report's numbers, no wall clock.
 */
import { describe, expect, it } from "vitest"
import type { RecordingActivity } from "../../../../src/core/scanner/scheduler.js"
import { HELD_VOICE_TOLERANCE_HZ } from "../../../../src/core/scanner/scheduler.js"
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
const ID_MS = 28_000
const EVERY_MS = 70_000
const COUNT = 5
const FIRST_MS = 10_000
/** The last ID ends at 10 + 4 × 70 + 28 = 318 s; the scene runs to 380 s. */
const DURATION_MS = 380_000
const NEIGHBOUR_LEAD_MS = 6_000
const NEIGHBOUR_ON_MS = 3_000
const NEIGHBOUR_OFF_MS = 3_000
/** An ID recorded whole from its catch: one WAV of at least 25 s of its 28. */
const WHOLE_ID_S = 25

/** The neighbour's overs: 3 s on, 3 s off, from 6 s before each ID to its end. */
function neighbour(): Emitter[] {
	const out: Emitter[] = []
	for (let i = 0; i < COUNT; i++) {
		const idFrom = FIRST_MS + i * EVERY_MS
		for (
			let t = idFrom - NEIGHBOUR_LEAD_MS;
			t < idFrom + ID_MS;
			t += NEIGHBOUR_ON_MS + NEIGHBOUR_OFF_MS
		)
			out.push({
				hz: NEIGHBOUR_HZ,
				kind: "voice",
				fromMs: t,
				toMs: t + NEIGHBOUR_ON_MS,
			})
	}
	return out
}

interface Band {
	centreHz: number
	obwHz: number
}
interface SchedulerInternals {
	visit: {
		heardVoiceId: string | null
		tracks: Map<string, Band>
	} | null
	hold: { trackId: string } | null
}
interface ServiceInternals {
	widebandAnalog: {
		sessions: Map<string, { voiceTx: string | null; targetHz: number }>
		recordingActive(
			sourceId: string,
			at: { readonly stream: number; readonly epoch: number },
		): RecordingActivity
	}
}

/** What the production scheduler remembered (Visit.heardVoiceId) against the held track's band. */
interface Naming {
	/** Transmissions remembered, each with whether its frequency lay in the held track's band. */
	adopted: { hz: number | undefined; inBand: boolean }[]
	/** Answers to a follow on the target's track naming the neighbour first, nothing remembered yet. */
	neighbourFirst: number
}

/**
 * Runs the scene and watches every recorder answer the scheduler reads: the frequency of each
 * voiced transmission it names or lists (VoiceOnAir.targetHz), and, at the next answer or chunk,
 * whether the visit then remembered one and where it lay against the track held at that answer.
 */
async function neighbourAtLandingScene(): Promise<{
	r: SceneReport
	naming: Naming
}> {
	const naming: Naming = { adopted: [], neighbourFirst: 0 }
	const hzOf = new Map<string, number | undefined>()
	let last: {
		visit: SchedulerInternals["visit"]
		band: Band | null
	} | null = null
	const targetIds = ids({
		hz: TARGET_HZ,
		fromMs: FIRST_MS,
		everyMs: EVERY_MS,
		count: COUNT,
		idMs: ID_MS,
	})
	const r = await runScene({
		centreHz: CENTRE_HZ,
		ranges: [RANGE],
		durationMs: DURATION_MS,
		emitters: [...targetIds, ...neighbour()],
		targets: targetIds.map((e, i) => ({
			hz: e.hz,
			fromMs: e.fromMs,
			toMs: e.toMs,
			label: `id${i + 1}`,
		})),
		onWorld: w => {
			const sched = (): SchedulerInternals | undefined =>
				w.scheduler() as unknown as SchedulerInternals | undefined
			// The answer before this one left the visit remembering a transmission: where it lay.
			const check = (): void => {
				const v = sched()?.visit ?? null
				if (last === null || v === null || v !== last.visit) return
				if (v.heardVoiceId === null || last.band === null) return
				const hz = hzOf.get(v.heardVoiceId)
				naming.adopted.push({
					hz,
					inBand:
						hz !== undefined &&
						Math.abs(hz - last.band.centreHz) <=
							last.band.obwHz / 2 + HELD_VOICE_TOLERANCE_HZ,
				})
				last = null
			}
			const rec = (w.service as unknown as ServiceInternals).widebandAnalog
			const answer = rec.recordingActive.bind(rec)
			rec.recordingActive = (sourceId, at) => {
				check()
				const a = answer(sourceId, at)
				const s = sched()
				const v = s?.visit ?? null
				const track =
					s?.hold === null || s?.hold === undefined
						? undefined
						: v?.tracks.get(s.hold.trackId)
				// Each named transmission's frequency from the recorder's own session (its `targetHz`),
				// not from the answer, so the check reads the same whatever the answer carries.
				for (const session of rec.sessions.values())
					if (session.voiceTx !== null)
						hzOf.set(session.voiceTx, session.targetHz)
				const firstHz =
					typeof a === "object" && "voice" in a ? hzOf.get(a.voice) : undefined
				if (
					v?.heardVoiceId === null &&
					track !== undefined &&
					Math.abs(track.centreHz - TARGET_HZ) < 12_500 &&
					firstHz !== undefined &&
					Math.abs(firstHz - NEIGHBOUR_HZ) < 12_500
				)
					naming.neighbourFirst++
				last =
					v !== null && v.heardVoiceId === null
						? {
								visit: v,
								band:
									track === undefined
										? null
										: { centreHz: track.centreHz, obwHz: track.obwHz },
							}
						: null
				return a
			}
			const chunk = w.advance.bind(w)
			w.advance = async ms => {
				// One chunk at a time, so each adoption is checked before the hold can change.
				for (let t = 0; t < ms; t += 25) {
					await chunk(25)
					check()
				}
			}
		},
	})
	return { r, naming }
}

describe("a follow landing while a neighbour talks", () => {
	it("remembers only the transmission on the held track's frequency, and records IDs whole", async () => {
		const { r, naming } = await neighbourAtLandingScene()
		expect(r.hops).toEqual(HOPS)
		const perId = r.targets.map(t => t.wavSeconds)
		const report = JSON.stringify({ perId, naming })
		// The scene exercises the defect: follows of the ID's track while the neighbour is named first.
		expect(naming.neighbourFirst, report).toBeGreaterThan(0)
		expect(naming.adopted.length, report).toBeGreaterThan(0)
		// Every transmission a hold remembered lies on its held track's frequency, never the neighbour.
		expect(
			naming.adopted.filter(a => !a.inBand),
			report,
		).toEqual([])
		// Measured, four runs: 1, 3, 2 and 4 of the 5 IDs one WAV of at least 25 s (before this rule,
		// three runs: 1, 3 and 0). Most IDs still split are lost to the two recordings per source
		// (MAX_ACTIVE_ANALOG_PER_SOURCE): the neighbour's consecutive overs hold both while the ID's
		// observation is refused:slots, and the store's timing makes the count vary run to run.
		const whole = perId.filter(s => s.length === 1 && s[0]! >= WHOLE_ID_S)
		expect(whole.length, report).toBeGreaterThanOrEqual(1)
	}, 1_800_000)
})
