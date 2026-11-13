/**
 * A hold that moves to a neighbour's track mid-visit, through the production composition
 * (runScene): the visit still names its transmission after the track it committed to (the ID's),
 * so the neighbour's end never ends the ID's hold. Three hops, settle 1000 ms (the production
 * value for a network source, config/default.yaml `sweep.settleMs.network`). A decoy voice on hop 0
 * holds the sweep there until it ends, so the ID's hop is landed on just before a 28 s ID keys; a
 * neighbour 25 kHz below the ID and 6 dB weaker talks from 8 s before the ID to 10 s into it. The
 * ID's track is held first (a probe, then a follow): the neighbour's track reaches the scheduler
 * only once the ID's has been held (its reports before that are not passed on, the next report
 * brings it in), so the landing's first hold is the ID's whichever track qualified first, the
 * order the gate scene had (the neighbour, on air at the landing, may otherwise qualify first and be
 * held as the visit's own target, a different case).
 *
 * Deterministic ordering (no event-loop timing). The move is forced: MOVE_AFTER_FOLLOW_MS into
 * the follow of the ID's track, the hold ends and the neighbour's track is held, by the two calls a
 * `record` hold's re-check makes when a neighbour qualified meanwhile (recheckRecording:
 * endHold, then startHold of nextCandidate), which in production hangs on when the neighbour's
 * track qualifies. And the recorder's sessions are listed to its
 * recording check neighbour first, and the ID's own session is left out of that check until one
 * check ran while the hold sat on the neighbour's track. That is the order the defect needs (the
 * recorder had not voiced the ID yet when the hold moved, as under a loaded host): the first voice
 * answer the moved hold reads is the neighbour's. The recorder itself records every session
 * throughout; only what its recording check lists is ordered. A visit that named its transmission
 * after the track the hold sat on then adopted the neighbour's over, and ended the hop at that
 * over's end, 10 s into the ID: the ID split in two files. Synthetic signals only, no wall clock.
 */
import { describe, expect, it } from "vitest"
import type { RecordingActivity } from "../../../../src/core/scanner/scheduler.js"
import { runScene, type Emitter } from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const HOPS = [CENTRE_HZ, CENTRE_HZ + 800_000, CENTRE_HZ + 1_598_000]
const TARGET_HZ = HOPS[1]! + 100_437
/** One 25 kHz channel down: inside the same window, outside the ID's band. */
const NEIGHBOUR_HZ = TARGET_HZ - 25_000
/** On hop 0 only. */
const DECOY_HZ = HOPS[0]! - 200_437
const ID_AMP = 0.25
/** 6 dB under the ID. */
const NEIGHBOUR_AMP = 0.125
const ID_FROM_MS = 30_000
const ID_MS = 28_000
const NEIGHBOUR_LEAD_MS = 8_000
const NEIGHBOUR_TAIL_MS = 10_000
/**
 * The decoy, on air from the scene's first sweep: its voice hold keeps hop 0 until it ends, the
 * sweep leaves about 0.8 s after (the close, a re-check) and lands on hop 1, whose listening
 * starts a 1000 ms settle later, about 0.1 s before the ID keys (28 150 + 800 + 1000 = 29 950).
 */
const DECOY_FROM_MS = 2_000
const DECOY_TO_MS = 28_150
/** sweep.settleMs.network in config/default.yaml. */
const SETTLE_MS = 1_000
/** The ID ends at 58 s; files finalise within a few seconds. */
const DURATION_MS = 64_000
/** On a channel: within half a 12.5 kHz channel of its frequency. */
const SAME_CHANNEL_HZ = 6_250
/** The ID's file from the landing: 28 s less the landing's lag and the recorder's 1 s pre-roll room. */
const WHOLE_ID_S = 25
/**
 * How long the ID's follow runs before the hold is moved: two of its recording checks (250 ms
 * apart, RECORD_RECHECK_MS), so the visit has asked the recorder during its hold of the ID's track.
 */
const MOVE_AFTER_FOLLOW_MS = 500

interface SchedulerInternals {
	visit: {
		hopIndex: number
		voice: string
		voiceId: string | null
		heardVoiceId: string | null
		tracks: Map<string, Track>
	} | null
	hold: { trackId: string; mode: string } | null
	phase: string
	tick(now: number): unknown[]
	onTrack(track: { centreHz: number }, ...rest: unknown[]): unknown[]
	endHold(evidence: boolean): void
	startHold(c: { id: string; t: Track; kind: "confirm" | "follow" }): unknown[]
}
interface Track {
	centreHz: number
	open: boolean
	tried: boolean
	flagged: boolean
	needsConfirm: boolean
}
interface RecorderInternals {
	sessions: Map<string, { targetHz: number }>
	recordingActive(
		sourceId: string,
		at: { readonly stream: number; readonly epoch: number },
	): RecordingActivity
}

const near = (hz: number | undefined, to: number): boolean =>
	hz !== undefined && Math.abs(hz - to) < SAME_CHANNEL_HZ

async function holdMoveScene(): Promise<{
	idFiles: number[]
	movedToNeighbour: boolean
	report: string
}> {
	const emitters: Emitter[] = [
		{
			hz: TARGET_HZ,
			kind: "voice",
			fromMs: ID_FROM_MS,
			toMs: ID_FROM_MS + ID_MS,
			amp: ID_AMP,
		},
		{
			hz: NEIGHBOUR_HZ,
			kind: "voice",
			fromMs: ID_FROM_MS - NEIGHBOUR_LEAD_MS,
			toMs: ID_FROM_MS + NEIGHBOUR_TAIL_MS,
			amp: NEIGHBOUR_AMP,
		},
		{ hz: DECOY_HZ, kind: "voice", fromMs: DECOY_FROM_MS, toMs: DECOY_TO_MS },
	]
	const lines: string[] = []
	let movedToNeighbour = false
	/** Recording checks run while the hold sat on the neighbour's track, the ID still left out. */
	let askedOnNeighbour = 0
	let released = false
	const r = await runScene({
		centreHz: CENTRE_HZ,
		ranges: [RANGE],
		durationMs: DURATION_MS,
		settleMs: SETTLE_MS,
		emitters,
		targets: [
			{
				hz: TARGET_HZ,
				fromMs: ID_FROM_MS,
				toMs: ID_FROM_MS + ID_MS,
				label: "id",
			},
		],
		onWorld: w => {
			const sched = (): SchedulerInternals | undefined =>
				w.scheduler() as unknown as SchedulerInternals | undefined
			const heldHz = (): number | undefined => {
				const s = sched()
				const hold = s?.hold ?? null
				return hold === null
					? undefined
					: s?.visit?.tracks.get(hold.trackId)?.centreHz
			}
			const rec = (
				w.service as unknown as { widebandAnalog: RecorderInternals }
			).widebandAnalog
			// Only the recording check's iteration is ordered; every other pass of the recorder
			// (feeding, finishing) sees the sessions as they are.
			let asking = false
			const values = rec.sessions.values.bind(rec.sessions)
			rec.sessions.values = () => {
				if (!asking) return values()
				const all = [...values()]
				return [
					...all.filter(s => near(s.targetHz, NEIGHBOUR_HZ)),
					...all.filter(
						s =>
							!near(s.targetHz, NEIGHBOUR_HZ) &&
							(released || !near(s.targetHz, TARGET_HZ)),
					),
				].values()
			}
			const answer = rec.recordingActive.bind(rec)
			rec.recordingActive = (sourceId, at) => {
				const onNeighbour = near(heldHz(), NEIGHBOUR_HZ)
				if (onNeighbour) movedToNeighbour = true
				// Listed again from the first check after one ran on the neighbour's track.
				if (askedOnNeighbour > 0) released = true
				asking = true
				try {
					return answer(sourceId, at)
				} finally {
					asking = false
					if (onNeighbour && !released) askedOnNeighbour++
				}
			}
			let patched = false
			let followFrom: number | null = null
			let idHeld = false
			const forceMove = (s: SchedulerInternals): void => {
				const onTrack = s.onTrack.bind(s)
				s.onTrack = (track, ...rest) => {
					if (!idHeld && near(track.centreHz, NEIGHBOUR_HZ)) return []
					return onTrack(track, ...rest)
				}
				const tick = s.tick.bind(s)
				s.tick = now => {
					const out = tick(now)
					const v = s.visit
					const hold = s.hold
					if (
						v !== null &&
						hold !== null &&
						near(v.tracks.get(hold.trackId)?.centreHz, TARGET_HZ)
					)
						idHeld = true
					if (
						movedToNeighbour ||
						v === null ||
						v.hopIndex !== 1 ||
						s.phase !== "hold" ||
						hold?.mode !== "follow" ||
						!near(v.tracks.get(hold.trackId)?.centreHz, TARGET_HZ)
					)
						return out
					followFrom ??= now
					if (now - followFrom < MOVE_AFTER_FOLLOW_MS) return out
					for (const [id, t] of v.tracks) {
						if (
							!t.open ||
							t.tried ||
							t.flagged ||
							!near(t.centreHz, NEIGHBOUR_HZ)
						)
							continue
						s.endHold(false)
						return [
							...out,
							...s.startHold({
								id,
								t,
								kind: t.needsConfirm ? "confirm" : "follow",
							}),
						]
					}
					return out
				}
			}
			let last = ""
			const chunk = w.advance.bind(w)
			w.advance = async ms => {
				for (let t = 0; t < ms; t += 25) {
					const live = sched()
					if (!patched && live !== undefined) {
						forceMove(live)
						patched = true
					}
					await chunk(25)
					const s = sched()
					const v = s?.visit ?? null
					if (v === null || v.hopIndex !== 1) continue
					const hz = heldHz()
					const line = `${s?.hold?.mode ?? "-"} ${hz === undefined ? "-" : Math.round(hz - TARGET_HZ)} ${v.voice} ${v.voiceId ?? "-"} ${v.heardVoiceId ?? "-"}`
					if (line !== last) lines.push(`${w.nowMs()} ${line}`)
					last = line
				}
			}
		},
	})
	expect(r.hops).toEqual(HOPS)
	const idFiles = r.targets[0]?.wavSeconds ?? []
	return {
		idFiles,
		movedToNeighbour,
		report: JSON.stringify({
			idFiles,
			files: r.wavFiles,
			holds: r.holds,
			askedOnNeighbour,
			trace: lines,
		}),
	}
}

describe("a hold that moves to a neighbour's track mid-visit", () => {
	it("names the visit's transmission after the ID's track and records the ID in one file", async () => {
		const { idFiles, movedToNeighbour, report } = await holdMoveScene()
		// The scene exercised the move: the hold sat on the neighbour's track during the ID's visit.
		expect(movedToNeighbour, report).toBe(true)
		// One file of the ID from the landing to its end, not two split at the neighbour's end.
		expect(
			idFiles.filter(s => s >= WHOLE_ID_S),
			report,
		).toHaveLength(1)
	}, 600_000)
})
