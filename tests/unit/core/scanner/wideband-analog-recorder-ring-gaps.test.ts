/**
 * The recorder against a ring that keeps several gaps, and its one catch-up grant a turn.
 * Readability is not monotonic: an earlier search bisected [next, target) with single-sample
 * probes, so a probe inside a later gap discarded the readable IQ before it and could end a
 * file source-lost with less than 1 s of IQ actually missing. Every missing span is now a slice
 * the recorder tried and could not read, and one turn's catch-up past the 2 ms budget goes to
 * one session only (the one closest to falling out of the ring).
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_SLICE_MS,
	WIDEBAND_TURN_BUDGET_MS,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	CENTRE,
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
	margin: number
	targetHz: number
	file: {
		startSample: number
		headCut: boolean
		endSample: number | null
		cut: string | null
	} | null
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
const ms = (n: number): number => (n * LOW_FS) / 1000

function low(opts: Parameters<typeof harness>[0] = {}) {
	return harness({ fs: LOW_FS, offset: LOW_OFFSET, ...opts })
}

/** Writes `n` ms of IQ (whole 25 ms chunks) after a gap of `skip` ms, with no recorder turn. */
function write(
	h: ReturnType<typeof low>,
	n: number,
	on: boolean,
	skip = 0,
): void {
	for (let i = 0; i < n / 25; i++)
		h.engine.write(h.src.next(CHUNK, on), i === 0 ? ms(skip) : 0)
}

function report(
	h: ReturnType<typeof low>,
	id: string,
	onset: number,
	hz = CENTRE + LOW_OFFSET,
): void {
	h.rec.track(
		input(
			id,
			snapshot(id, onset, h.engine.liveEdge(), { ...LOW, centreHz: hz }),
			{ discoveryId: `d_${id}` },
		),
	)
}

/** Counts the IQ samples the recorder demodulated (reads longer than one sample). */
function countReads(h: ReturnType<typeof low>): { samples: number } {
	const seen = { samples: 0 }
	const read = h.engine.readRing.bind(h.engine)
	h.engine.readRing = (from: number, to: number) => {
		const r = read(from, to)
		if (r !== null && r.bytes.length > 2) seen.samples += r.bytes.length / 2
		return r
	}
	return seen
}

/** A voiced, admitted recording 2 s long, caught up to the live edge. */
async function voiced(h: ReturnType<typeof low>): Promise<number> {
	await h.feed(0.5, false)
	const onset = h.engine.liveEdge()
	for (let i = 0; i < 2 * 40; i++) {
		write(h, 25, true)
		report(h, "o", onset)
		await h.pump()
	}
	expect(h.ops).toHaveLength(1)
	expect(sessions(h)[0]!.next).toBe(h.engine.liveEdge())
	return onset
}

describe("WidebandAnalogRecorder over a ring with several gaps", () => {
	it("reads the IQ between two interior gaps instead of ending the file source-lost", async () => {
		// next = T, then gaps [T, T + 50 ms) and [T + 1 s, T + 1.9 s), readable between and
		// after: 950 ms of readable IQ lies between the gaps, and no gap reaches 1 s.
		const h = low({ clock: stepClock(1) })
		const onset = await voiced(h)
		const s = sessions(h)[0]!
		const from = s.next
		const reads = countReads(h)
		write(h, 950, true, 50)
		write(h, 100, true, 900)
		expect(h.engine.liveEdge() - from).toBe(ms(2000))
		report(h, "o", onset)
		for (let i = 0; i < 200 && s.next < h.engine.liveEdge(); i++) await h.turn()
		expect(s.next).toBe(h.engine.liveEdge())
		expect(s.file?.endSample).toBeNull()
		// Every readable sample was demodulated: 950 + 100 ms.
		expect(reads.samples).toBe(ms(1050))
		// Two 25 ms slices of the first gap, 36 of the second: each is one reported gap.
		expect(h.ops[0]!.gaps).toBe(2 + 36)
		h.rec.closed("o", snapshot("o", onset, h.engine.liveEdge(), LOW), null)
		await h.feed(4, false)
		await h.pump()
		await h.rec.idle()
		expect(h.ops[0]!.cut).toBe("completed")
		expect(h.ops[0]!.outcome).toBe("finalized")
	}, 60_000)

	it("a range capped by an epoch change keeps the readable IQ between its gaps", async () => {
		const h = low({ clock: stepClock(1) })
		await voiced(h)
		const s = sessions(h)[0]!
		const reads = countReads(h)
		// Gaps [T, T + 50 ms) and [T + 350, T + 850 ms), readable 300 ms and 200 ms, then a
		// retune: the file's range ends at the new epoch's start (T + 1050 ms).
		write(h, 300, true, 50)
		write(h, 200, true, 500)
		const limit = h.engine.liveEdge()
		h.engine.epoch = {
			...h.engine.epoch,
			epoch: 2,
			startSample: limit,
		}
		write(h, 1000, true)
		for (let i = 0; i < 200 && !h.ops[0]!.outcome; i++) {
			await h.turn()
			await h.pump()
		}
		await h.rec.idle()
		expect(s.next).toBe(limit)
		expect(reads.samples).toBe(ms(500))
		expect(h.ops[0]!.gaps).toBe(2 + 20)
		expect(h.ops[0]!.cut).toBe("epoch-changed")
		expect(h.ops[0]!.outcome).toBe("finalized")
	}, 60_000)

	it("an overwritten head starts at the ring's oldest sample even with a gap held after it", async () => {
		// Ring 3 s. Written: [0, 2.5 s) signal, gap [2.5, 3 s), [3, 5.25 s) signal: the ring
		// holds [2.25, 5.25 s), so [2.25, 2.5 s) is readable before the gap. A bisection from
		// the session's 0.2 s start probes inside the gap and starts at 3 s instead.
		const h = low({ clock: stepClock(WIDEBAND_TURN_BUDGET_MS) })
		await h.feed(2.5, true)
		write(h, 2250, true, 500)
		const oldest = h.engine.liveEdge() - 3 * LOW_FS
		expect(h.engine.oldestSample).toBe(oldest)
		expect(oldest).toBe(ms(2250))
		report(h, "o", ms(500))
		const s = sessions(h)[0]!
		await h.turn()
		expect(s.file?.headCut).toBe(true)
		expect(s.file?.startSample).toBe(oldest)
		expect(s.next).toBe(h.engine.liveEdge() - s.maxBacklog)
	}, 60_000)
})

describe("WidebandAnalogRecorder catch-up grant (one a turn)", () => {
	it("gives the turn's catch-up to the session closest to falling out of the ring; the other defers", async () => {
		const h = low({ clock: stepClock(WIDEBAND_TURN_BUDGET_MS) })
		await h.feed(3, true)
		const edge = h.engine.liveEdge()
		// B first (it drains first in the turn), 2.3 s behind; A 2.8 s behind (less headroom).
		report(h, "b", edge - ms(2000), CENTRE + LOW_OFFSET + 25_000)
		report(h, "a", edge - ms(2500))
		const [b, a] = sessions(h)
		expect(b!.targetHz).toBe(CENTRE + LOW_OFFSET + 25_000)
		expect(edge - a!.next).toBe(ms(2800))
		expect(edge - b!.next).toBe(ms(2300))
		await h.turn()
		// A caught up to maxBacklog (775 ms past the first slice, within its 1 s grant).
		expect(edge - a!.next).toBe(a!.maxBacklog)
		// B ran its one budgeted slice and deferred: no second catch-up in the same turn.
		expect(edge - b!.next).toBe(ms(2300) - SLICE)
		// Next turn A is within the bound: the grant goes to B.
		await h.turn()
		expect(edge - b!.next).toBe(b!.maxBacklog)
	}, 60_000)

	it("a full-ring backlog (2 s ring) is caught up in one turn within the grant: one slice plus the margin", async () => {
		// Ring 2 s: margin 1 s, maxBacklog 1 s. A session 2 s behind (the whole ring) runs one
		// budgeted slice, then catches up to maxBacklog: 975 ms, within its 1 s grant.
		const h = low({ clock: stepClock(WIDEBAND_TURN_BUDGET_MS), ringSeconds: 2 })
		await h.feed(2, true)
		const edge = h.engine.liveEdge()
		report(h, "o", edge - ms(1700))
		const s = sessions(h)[0]!
		const reads = countReads(h)
		expect(s.margin).toBe(LOW_FS)
		expect(s.maxBacklog).toBe(LOW_FS)
		expect(edge - s.next).toBe(ms(2000))
		await h.turn()
		expect(edge - s.next).toBe(s.maxBacklog)
		expect(reads.samples).toBe(ms(1000))
		expect(reads.samples).toBeLessThanOrEqual(SLICE + s.margin)
	}, 60_000)
})
