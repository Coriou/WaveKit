/**
 * The recorder on a slow event loop: a turn that delivers more IQ than one 25 ms slice must not
 * make a session fall out of the engine ring. Before the per-turn budget, a session classed 2 s
 * after onset (2.3 s behind the live edge with the pre-roll, in a 3 s ring) demodulated 25 ms a
 * turn, overran the ring before its voice gate passed, and its retry crawled through the lost IQ
 * a slice a turn: a long transmission left no file at all.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_DEFAULT_RING_SECONDS,
	WIDEBAND_RING_MARGIN_MS,
	WIDEBAND_SLICE_MS,
	WIDEBAND_TURN_BUDGET_MS,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

interface SessionView {
	next: number
	maxBacklog: number
	file: { startSample: number; headCut: boolean } | null
}

function sessions(h: ReturnType<typeof harness>): SessionView[] {
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

const SLICE = (WIDEBAND_SLICE_MS * LOW_FS) / 1000
/** One 25 ms engine write at LOW_FS. */
const CHUNK = LOW_FS / 40

function low(opts: Parameters<typeof harness>[0] = {}) {
	return harness({ fs: LOW_FS, offset: LOW_OFFSET, ...opts })
}

/** Writes `chunks` 25 ms chunks with no recorder turn in between. */
function write(h: ReturnType<typeof low>, chunks: number, on: boolean): void {
	for (let i = 0; i < chunks; i++) h.engine.write(h.src.next(CHUNK, on))
}

/** A voiced track open from `onset` (analog-fm), reported at the live edge. */
function report(h: ReturnType<typeof low>, id: string, onset: number): void {
	h.rec.track(
		input(id, snapshot(id, onset, h.engine.liveEdge(), LOW), {
			discoveryId: "d_1",
		}),
	)
}

describe("WidebandAnalogRecorder on a congested event loop", () => {
	it("records the whole of a 28 s transmission classed 2 s late when each turn delivers 200 ms of IQ", async () => {
		// Each turn delivers 8 chunks (200 ms) and the budget allows two slices (50 ms): the
		// session falls behind until its backlog reaches the ring margin, then catches up there.
		const h = low({ clock: stepClock(1) })
		await h.feed(1, false)
		const onset = h.engine.liveEdge()
		const end = onset + 28 * LOW_FS
		const perTurn = 8
		const turns = async (
			seconds: number,
			on: boolean,
			each?: () => void,
		): Promise<void> => {
			for (let i = 0; i < Math.round((seconds * 40) / perTurn); i++) {
				write(h, perTurn, on)
				each?.()
				await h.turn()
			}
		}
		await turns(28, true, () => {
			const edge = h.engine.liveEdge()
			if (edge - onset < 0.1 * LOW_FS) return
			const track = snapshot("id", onset, Math.min(edge, end), LOW)
			// The first snapshots carry a definite other class (no shadow), as a burst-like
			// onset does; analog FM arrives 2 s after the onset.
			h.rec.track(
				edge - onset < 2 * LOW_FS
					? input("id", track, { analogFm: false, nonAnalog: true })
					: input("id", track),
			)
		})
		await turns(0.6, false)
		h.rec.closed("id", snapshot("id", onset, end, LOW), null)
		await turns(4, false)
		await h.pump()
		await h.rec.idle()
		expect(h.warnings).toEqual([])
		expect(h.ops).toHaveLength(1)
		const op = h.ops[0]!
		expect(op.outcome).toBe("finalized")
		expect(op.cut).toBe("completed")
		expect(op.gaps).toBe(0)
		// Pre-roll 300 ms + 28 s + hang 2 s at 8 frames per ms.
		expect(
			Math.abs(op.frames - 8 * (300 + 28_000 + 2_000)),
		).toBeLessThanOrEqual(8 * 30)
	}, 120_000)

	it(`one turn demodulates slices for ${WIDEBAND_TURN_BUDGET_MS} ms: two slices at 1 ms each, one at 3 ms`, async () => {
		for (const [step, slices] of [
			[1, 2],
			[3, 1],
		] as const) {
			const h = low({ clock: stepClock(step) })
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			write(h, 1, true)
			report(h, "o", onset)
			await h.pump()
			const s = sessions(h)[0]!
			expect(s.next).toBe(h.engine.liveEdge())
			// Four slices behind, far under the ring margin: the budget alone bounds the turn.
			write(h, 4, true)
			report(h, "o", onset)
			const before = s.next
			await h.turn()
			expect(s.next - before).toBe(slices * SLICE)
		}
	}, 60_000)

	it(`keeps the backlog within the ring less ${WIDEBAND_RING_MARGIN_MS} ms (at most half the ring)`, async () => {
		const ring = WIDEBAND_DEFAULT_RING_SECONDS * LOW_FS
		const maxBacklog = ring - (WIDEBAND_RING_MARGIN_MS * LOW_FS) / 1000
		// A clock that spends the budget on every slice: past one slice, only the margin rule
		// keeps a turn going.
		const h = low({ clock: stepClock(WIDEBAND_TURN_BUDGET_MS) })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		write(h, 1, true)
		report(h, "o", onset)
		await h.pump()
		const s = sessions(h)[0]!
		expect(s.maxBacklog).toBe(maxBacklog)
		// At the bound: a backlog of exactly maxBacklog after the first slice is not caught up.
		write(h, maxBacklog / CHUNK + 1, true)
		report(h, "o", onset)
		await h.turn()
		expect(h.engine.liveEdge() - s.next).toBe(maxBacklog)
		// Past it: three more slices behind are demodulated in one turn, back to maxBacklog.
		write(h, 4, true)
		report(h, "o", onset)
		await h.turn()
		expect(h.engine.liveEdge() - s.next).toBe(maxBacklog)
		// A ring of 1 s keeps half of it (500 ms) as the margin, not 1000 ms.
		const small = low({ clock: stepClock(1), ringSeconds: 1 })
		await small.feed(0.5, false)
		const o2 = small.engine.liveEdge()
		write(small, 1, true)
		report(small, "p", o2)
		await small.pump()
		expect(sessions(small)[0]!.maxBacklog).toBe(LOW_FS / 2)
	}, 60_000)

	it("a session whose start fell out of the ring jumps to the oldest readable sample in one turn", async () => {
		const h = low({ clock: stepClock(WIDEBAND_TURN_BUDGET_MS) })
		await h.feed(5, true)
		// The onset is 5 s back, the ring holds 3 s: the pre-roll and the first 2 s are gone.
		const onset = h.engine.liveEdge() - 5 * LOW_FS
		report(h, "o", onset)
		const s = sessions(h)[0]!
		const oldest = h.engine.liveEdge() - 3 * LOW_FS
		await h.turn()
		expect(s.file?.headCut).toBe(true)
		expect(s.file?.startSample).toBe(oldest)
		// The turn went on demodulating from there until the backlog was back within the ring
		// margin, instead of skipping one slice of missing IQ a turn.
		expect(s.next).toBe(h.engine.liveEdge() - s.maxBacklog)
	}, 60_000)

	it("a recording overrun by more than the 1 s silence bound ends cut (source-lost)", async () => {
		const h = low({ clock: stepClock(1) })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		for (let i = 0; i < 2 * 40; i++) {
			write(h, 1, true)
			report(h, "o", onset)
			await h.pump()
		}
		expect(h.ops).toHaveLength(1)
		// 4.5 s with no recorder turn: 1.5 s of the session's unread IQ is overwritten.
		write(h, 4.5 * 40, true)
		report(h, "o", onset)
		await h.turn()
		await h.pump()
		await h.rec.idle()
		expect(h.ops[0]!.cut).toBe("source-lost")
		expect(h.ops[0]!.outcome).toBe("finalized")
	}, 60_000)
})
