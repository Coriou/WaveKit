/**
 * WidebandAnalogRecorder ring urgency while a retune is held (pendingRetuneSample): the ring
 * overwrites relative to the live edge, so a session already behind when the hop is commanded
 * is measured from the live edge (its ring backlog), not from the command position it may read
 * to. Measured to the command, a session 1.5 s behind looked 1.5 s behind for the whole hold,
 * never earned the catch-up grant, and lost the old tuning's tail once the ring passed it.
 * Also: a hold cap and a trusted-run end seen in the same drain end the file at the earlier.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_SLICE_MS,
	WIDEBAND_TURN_BUDGET_MS,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	CENTRE,
	FS,
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

interface SessionView {
	next: number
	maxBacklog: number
	limit: number
	file: { startSample: number; endSample: number | null } | null
}

function sessions(h: Harness): SessionView[] {
	return [
		...(
			h.rec as unknown as { sessions: Map<string, SessionView> }
		).sessions.values(),
	]
}

/** A clock that advances `step` ms on every read: the budget check is deterministic. */
function stepClock(step: number): () => number {
	let t = 0
	return () => (t += step)
}

/** The recorder's audio rate (ANALOG_AUDIO_RATE_HZ). */
const AUDIO = 8000
const SLICE = (WIDEBAND_SLICE_MS * LOW_FS) / 1000
const CHUNK = LOW_FS / 40
const ms = (n: number): number => (n * LOW_FS) / 1000
/** The FakeEngine's default 3 s ring, and it less the 1 s margin. */
const RING = ms(3000)
const MAX_BACKLOG = ms(2000)

/** Writes `n` ms of IQ (whole 25 ms chunks) with no recorder turn. */
function write(h: Harness, n: number, on: boolean): void {
	for (let i = 0; i < n / 25; i++) h.engine.write(h.src.next(CHUNK, on))
}

function report(h: Harness, id: string, onset: number, hz: number): void {
	h.rec.track(
		input(
			id,
			snapshot(id, onset, h.engine.liveEdge(), { ...LOW, centreHz: hz }),
		),
	)
}

/** A retune commanded now (pending on the current epoch); returns its command sample. */
function command(h: Harness): number {
	const at = h.engine.liveEdge()
	h.engine.epoch = {
		...h.engine.epoch,
		pendingRetuneSample: at,
	} as typeof h.engine.epoch
	return at
}

/** The commanded retune's epoch starts now (its settled start). */
function start(h: Harness, commandAt: number): number {
	const at = h.engine.liveEdge()
	h.engine.epoch = {
		...h.engine.epoch,
		epoch: h.engine.epoch.epoch + 1,
		startSample: at,
		pendingRetuneSample: null,
		retunedFromSample: commandAt,
	} as typeof h.engine.epoch
	return at
}

describe("WidebandAnalogRecorder ring backlog while a retune is held", () => {
	it("a session 1.5 s behind at the command gets the catch-up grant over a less-behind one and keeps the old tuning's tail", async () => {
		// One budgeted slice (25 ms) a turn, 200 ms of IQ a turn: only the grant keeps up.
		const h = harness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			clock: stepClock(WIDEBAND_TURN_BUDGET_MS),
		})
		await h.feed(3, true)
		const edge0 = h.engine.liveEdge()
		const hzA = CENTRE + LOW_OFFSET
		const hzB = CENTRE + LOW_OFFSET + 25_000
		// B first (it drains first in every turn), 1.0 s behind; A 1.5 s behind (pre-roll
		// 300 ms each). Both under maxBacklog (2 s) at the command.
		const onsetB = edge0 - ms(700)
		const onsetA = edge0 - ms(1200)
		report(h, "b", onsetB, hzB)
		report(h, "a", onsetA, hzA)
		const [b, a] = sessions(h)
		expect(edge0 - a!.next).toBe(ms(1500))
		expect(edge0 - b!.next).toBe(ms(1000))
		const fileStartA = a!.next
		const at = command(h)
		expect(at).toBe(edge0)
		// Held 1.6 s (8 turns of 200 ms): A's ring backlog passes maxBacklog in the third turn,
		// though its readable backlog (to the command) never does.
		let caughtUp = false
		for (let turn = 0; turn < 8; turn++) {
			write(h, 200, true)
			report(h, "b", onsetB, hzB)
			report(h, "a", onsetA, hzA)
			const beforeA = a!.next
			const beforeB = b!.next
			await h.turn()
			const live = h.engine.liveEdge()
			// Never past the 3 s ring: nothing either still reads was overwritten. (One grant a
			// turn: once both are past maxBacklog they take it in turn, the other defers.)
			expect(live - a!.next).toBeLessThanOrEqual(RING)
			expect(live - b!.next).toBeLessThanOrEqual(RING)
			expect(a!.next).toBeLessThanOrEqual(at)
			if (a!.next - beforeA > SLICE) {
				// A holds the turn's grant (least headroom); B ran its one budgeted slice.
				caughtUp = true
				expect(live - a!.next).toBe(MAX_BACKLOG)
				expect(b!.next - beforeB).toBe(SLICE)
			}
		}
		expect(caughtUp).toBe(true)
		// Its reported backlog is the ring backlog: exactly maxBacklog (2000 ms).
		const diag = h.rec.diagnostics().sessions.find(x => x.observationId === "a")
		expect(diag?.backlogMs).toBe(2000)
		// The hop starts: A's file ends at the command and reads every sample up to it.
		start(h, at)
		for (
			let i = 0;
			i < 40 && !h.ops.find(o => o.input.observationId === "a")?.outcome;
			i++
		) {
			write(h, 200, true)
			await h.turn()
			await h.pump()
		}
		await h.rec.idle()
		expect(a!.next).toBe(at)
		const opA = h.ops.find(o => o.input.observationId === "a")!
		expect(opA.outcome).toBe("finalized")
		expect(opA.cut).toBe("epoch-changed")
		// No gap or silence: the old tuning's final samples were demodulated, not overwritten.
		expect(opA.gaps).toBe(0)
		const expected = Math.round(((at - fileStartA) * AUDIO) / LOW_FS)
		expect(opA.frames).toBeLessThanOrEqual(expected)
		expect(opA.frames).toBeGreaterThanOrEqual(expected - 8 * 60)
	}, 120_000)

	it("a hold cap and a trusted-run end in the same drain end the file at the earlier (the run's end)", async () => {
		const h = harness()
		const trust: {
			trustedFromSample: number | null
			runEnd: { from: number; end: number } | null
		} = { trustedFromSample: 0, runEnd: null }
		const base = h.engine.currentEpoch.bind(h.engine)
		h.engine.currentEpoch = () => ({ ...base(), ...trust })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(2, true, () => {
			const edge = h.engine.liveEdge()
			if (edge - onset >= 0.1 * FS)
				h.rec.track(input("o", snapshot("o", onset, edge)))
		})
		const at = command(h)
		// Held exactly maxBacklog (3 s ring − 1 s margin): still open.
		await h.feed(2, true, () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
		)
		expect(h.engine.liveEdge() - at).toBe(2 * FS)
		await h.pump()
		const s = sessions(h)[0]!
		expect(s.limit).toBe(Number.POSITIVE_INFINITY)
		expect(s.next).toBe(at)
		// One drain sees both: one sample past the cap, and the trusted run ended 0.5 s before
		// the command (a doubt).
		const doubtAt = at - Math.round(0.5 * FS)
		trust.trustedFromSample = null
		trust.runEnd = { from: 0, end: doubtAt }
		h.engine.write(new Uint8Array([127, 127]))
		for (let i = 0; i < 4; i++) await h.pump()
		expect(s.limit).toBe(doubtAt)
		expect(s.file?.endSample ?? doubtAt).toBe(doubtAt)
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
		const op = h.ops[0]!
		expect(op.cut).toBe("epoch-changed")
		const fileStart = onset - Math.round(0.3 * FS)
		// Ended at the run's end, not at the command 0.5 s later.
		expect(op.frames).toBeLessThanOrEqual(
			Math.round(((doubtAt - fileStart) * AUDIO) / FS),
		)
	}, 120_000)
})
