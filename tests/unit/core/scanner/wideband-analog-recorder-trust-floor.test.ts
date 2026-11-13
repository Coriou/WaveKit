/**
 * A recording is never back-dated before the trusted run of its epoch: its pre-roll reads the
 * engine ring from no earlier than `currentEpoch().trustedFromSample` (the first block the tuning
 * ledger proves since the last unverified one), and a view that reports no run refuses.
 */
import { describe, expect, it } from "vitest"
import { harness, transmission } from "./wideband-recorder-harness.js"

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
		const h = harness()
		await h.feed(1, false)
		const base = h.engine.currentEpoch.bind(h.engine)
		h.engine.currentEpoch = () => ({ ...base(), trustedFromSample: null })
		const froms = watchReads(h)
		await transmission(h, "o1", 1)
		await h.feed(3, false)
		expect(froms).toEqual([])
		expect(h.ops).toHaveLength(0)
	}, 60_000)
})
