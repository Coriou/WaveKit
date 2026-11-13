/**
 * A recording is never back-dated before the trusted run of its epoch: its pre-roll reads the
 * engine ring from no earlier than `currentEpoch().trustedFromSample` (the first block the tuning
 * ledger proves since the last unverified one), and a view that reports no run refuses. A file
 * ends where its trusted run ends (a doubt) or changes (re-proven), and nothing joins across runs.
 */
import { describe, expect, it } from "vitest"
import { ANALOG_AUDIO_RATE_HZ } from "../../../../src/core/scanner/channel/fm-audio.js"
import {
	harness,
	input,
	snapshot,
	transmission,
} from "./wideband-recorder-harness.js"

function watchReads(h: ReturnType<typeof harness>): number[] {
	const froms: number[] = []
	const read = h.engine.readRing.bind(h.engine)
	h.engine.readRing = (from: number, to: number) => {
		froms.push(from)
		return read(from, to)
	}
	return froms
}

describe("WidebandAnalogRecorder trust floor", () => {
	it("starts the file no earlier than the trusted run, even inside the pre-roll", async () => {
		const h = harness()
		await h.feed(1, false)
		// The run began 100 ms before the onset; the 300 ms pre-roll would reach before it.
		const trustedFrom = h.engine.liveEdge() - Math.round(0.1 * h.fs)
		const base = h.engine.currentEpoch.bind(h.engine)
		h.engine.currentEpoch = () => ({
			...base(),
			trustedFromSample: trustedFrom,
		})
		const froms = watchReads(h)
		await transmission(h, "o1", 1)
		await h.feed(3, false)
		expect(froms.length).toBeGreaterThan(0)
		expect(Math.min(...froms)).toBe(trustedFrom)
		expect(h.ops).toHaveLength(1)
	}, 60_000)

	it("without the floor the same file starts at the pre-roll (the control)", async () => {
		const h = harness()
		await h.feed(1, false)
		const onset = h.engine.liveEdge()
		const froms = watchReads(h)
		await transmission(h, "o1", 1)
		await h.feed(3, false)
		expect(Math.min(...froms)).toBe(onset - Math.round(0.3 * h.fs))
	}, 60_000)

	it("a trusted label with no trusted run is refused", async () => {
		const refused: string[] = []
		const h = harness({ tuningRefused: id => refused.push(id) })
		await h.feed(1, false)
		const base = h.engine.currentEpoch.bind(h.engine)
		h.engine.currentEpoch = () => ({ ...base(), trustedFromSample: null })
		const froms = watchReads(h)
		await transmission(h, "o1", 1)
		await h.feed(3, false)
		expect(froms).toEqual([])
		expect(h.ops).toHaveLength(0)
		// Each refused snapshot is reported for the source's tuningUnproven count.
		expect(refused.length).toBeGreaterThan(0)
		expect(new Set(refused)).toEqual(new Set(["rtl"]))
	}, 60_000)

	/** Overrides the view's trusted run (`trustedFromSample`) from now on. */
	function runOf(h: ReturnType<typeof harness>, from: number | null) {
		const base = h.engine.currentEpoch.bind(h.engine)
		let run = from
		h.engine.currentEpoch = () => ({ ...base(), trustedFromSample: run })
		return (next: number | null) => {
			run = next
		}
	}

	it("a doubt mid-file ends the file there: no audio after the trusted run ended", async () => {
		const h = harness()
		await h.feed(1, false)
		const setRun = runOf(h, 0)
		const onset = h.engine.liveEdge()
		let dropAt: number | null = null
		await h.feed(3, true, () => {
			const edge = h.engine.liveEdge()
			h.rec.track(input("o1", snapshot("o1", onset, edge)))
			// 1 s into the transmission the tuning is doubted: the run ends.
			if (dropAt === null && edge - onset >= h.fs) {
				dropAt = edge
				setRun(null)
			}
		})
		await h.feed(1, false)
		expect(h.ops).toHaveLength(1)
		const op = h.ops[0]!
		// Ended at the drop (like a retune), not completed at the transmission's end.
		expect(op.cut).toBe("epoch-changed")
		// At most the pre-roll plus the second before the drop (48 kHz audio), never the 3 s.
		expect(op.frames).toBeLessThanOrEqual(Math.ceil((0.3 + 1 + 0.05) * 48_000))
		expect(op.frames).toBeGreaterThan(0)
	}, 60_000)

	it("a doubt shorter than one drain, seen only once re-proven, is cut out: no frame at or past the run's end", async () => {
		// A clock that never moves: every drain catches up to the edge (no turn budget runs out),
		// so the recorder has read past the doubt before the view shows it, whatever the host load.
		const h = harness({ clock: () => 0 })
		await h.feed(1, false)
		// The view: trusted run from 0, later the newest ended run and the run after it.
		const base = h.engine.currentEpoch.bind(h.engine)
		let run: number | null = 0
		let runEnd: { from: number; end: number } | null = null
		h.engine.currentEpoch = () => ({
			...base(),
			trustedFromSample: run,
			runEnd,
		})
		const froms: number[] = []
		let readTo = 0
		const read = h.engine.readRing.bind(h.engine)
		h.engine.readRing = (from: number, to: number) => {
			froms.push(from)
			readTo = Math.max(readTo, to)
			return read(from, to)
		}
		const onset = h.engine.liveEdge()
		// 10 ms long, 20 ms before the edge after at least 1 s of the transmission.
		const doubtLen = Math.round(0.01 * h.fs)
		let doubtAt: number | null = null
		let flipped = false
		let readAtFlip = 0
		await h.feed(3, true, () => {
			const edge = h.engine.liveEdge()
			h.rec.track(input("o1", snapshot("o1", onset, edge)))
			if (doubtAt === null && edge - onset >= h.fs) {
				doubtAt = edge - Math.round(0.02 * h.fs)
				return
			}
			if (doubtAt !== null && !flipped) {
				// The recorder read past the whole doubt before the view shows it (re-proven).
				readAtFlip = readTo
				run = doubtAt + doubtLen
				runEnd = { from: 0, end: doubtAt }
				flipped = true
			}
		})
		const last = h.engine.liveEdge()
		await h.feed(0.6, false)
		// The observation closes: the cut (parked) file is finished with every frame it keeps.
		h.rec.closed("o1", snapshot("o1", onset, last), null)
		await h.feed(1, false)
		expect(flipped).toBe(true)
		const at = doubtAt as unknown as number
		expect(readAtFlip).toBeGreaterThan(at + doubtLen)
		// The file of the old run; the transmission goes on, so a second file may start in the new run.
		expect(h.ops.length).toBeGreaterThanOrEqual(1)
		const op = h.ops[0]!
		expect(op.cut).toBe("epoch-changed")
		// The file's first sample: its pre-roll read (the drain reads on from there contiguously).
		const fileStart = Math.min(...froms)
		expect(op.frames).toBeGreaterThan(0)
		// Nothing at or past the doubt (the old run's end), though the recorder had read past it.
		expect(op.frames).toBeLessThanOrEqual(
			Math.round(((at - fileStart) * ANALOG_AUDIO_RATE_HZ) / h.fs),
		)
	}, 60_000)

	it("a re-proven run (a new trustedFromSample) ends the file, and a later snapshot records in the new run from its start", async () => {
		const h = harness({ budget: 2 })
		await h.feed(1, false)
		const setRun = runOf(h, 0)
		const onset = h.engine.liveEdge()
		await h.feed(1, true, () =>
			h.rec.track(input("o1", snapshot("o1", onset, h.engine.liveEdge()))),
		)
		const reads: number[] = []
		const read = h.engine.readRing.bind(h.engine)
		h.engine.readRing = (from: number, to: number) => {
			reads.push(from)
			return read(from, to)
		}
		// A new run starts here (doubted and re-proven between two drains); a second observation of
		// the same channel, on air since the first onset, arrives before the recorder drains.
		const next = h.engine.liveEdge()
		setRun(next)
		h.rec.track(input("o2", snapshot("o2", onset, h.engine.liveEdge())))
		await h.feed(2, true, () => {
			const edge = h.engine.liveEdge()
			h.rec.track(input("o1", snapshot("o1", onset, edge)))
			h.rec.track(input("o2", snapshot("o2", onset, edge)))
		})
		await h.feed(1, false)
		// o2 did not join the old run's file: it has a file of its own, starting in the new run.
		expect(h.ops.map(o => o.input.observationId)).toEqual(["o1", "o2"])
		expect(h.ops[0]!.cut).toBe("epoch-changed")
		expect(reads.length).toBeGreaterThan(0)
		expect(Math.min(...reads)).toBeGreaterThanOrEqual(next)
	}, 60_000)
})
