/** `nothing`'s proof: the level over the inner tolerance, the centre `nearbyHz` names, and a gap that recovers. */
import { describe, expect, it } from "vitest"
import {
	IDENTIFY_IQ_FRESH_BLOCKS,
	IDENTIFY_IQ_RECOVER_BLOCKS,
	IDENTIFY_NEARBY_HZ,
	identifyInnerHalfWidthHz,
	identifyInnerLevel,
} from "../../../../src/core/scanner/identify.js"
import {
	TARGET_HZ,
	identifyHarness,
	quietSummaryOf,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync } from "../../../mocks/scanner/probe-fakes.js"

const BLOCK_MS = 50

/** The fake summary: 4 kHz bins from `startHz`, floor −80 dBFS, threshold 6 dB. */
const summaryWith = (offsetsHz: readonly number[]) => {
	const s = quietSummaryOf()
	const bins = [...s.bins]
	for (const off of offsetsHz)
		bins[Math.floor((TARGET_HZ + off - s.startHz) / s.binHz)] = -50
	return { ...s, bins }
}
/** Centre of the summary bin holding `hz`. */
const binCentre = (hz: number) => {
	const s = quietSummaryOf()
	return s.startHz + (Math.floor((hz - s.startHz) / s.binHz) + 0.5) * s.binHz
}

describe("the inner part of the tolerance", () => {
	it("is the tolerance less one bin, never less than half a bin", () => {
		expect(identifyInnerHalfWidthHz(6250, 1000)).toBe(5250)
		expect(identifyInnerHalfWidthHz(6250, 4000)).toBe(2250)
		// at the floor and past it: tolerance − bin = bin / 2 at 1.5 bins
		expect(identifyInnerHalfWidthHz(1500, 1000)).toBe(500)
		expect(identifyInnerHalfWidthHz(1499, 1000)).toBe(500)
		expect(identifyInnerHalfWidthHz(1000, 1000)).toBe(500)
	})

	it("reads bins whose centre is inside it, at it and past it, and always the target's own bin", () => {
		const s = quietSummaryOf()
		// TARGET_HZ's bin is centred 1 kHz above it; the next bin up 5 kHz above it.
		const own = binCentre(TARGET_HZ)
		const next = own + s.binHz
		const bins = [...s.bins]
		bins[Math.floor((next - s.startHz) / s.binHz)] = -50
		const summary = { ...s, bins }
		// inner = tolerance − 4000: the next bin's centre is 5000 Hz off, so it is read from 9000
		expect(identifyInnerLevel(summary, TARGET_HZ, 9000)).toEqual({
			snrDb: 30,
			centreHz: next,
		})
		expect(identifyInnerLevel(summary, TARGET_HZ, 8999)?.snrDb).toBe(0)
		expect(identifyInnerLevel(summary, TARGET_HZ, 1)?.centreHz).toBe(own)
	})
})

describe("signal-nearby through the runner", () => {
	const silent = (bandwidthHz: number) =>
		identifyHarness({
			request: {
				timeoutMs: 1000,
				protocols: ["dmr"],
				target: { frequencyHz: TARGET_HZ, bandwidthHz },
			},
		})
	const finish = async (h: ReturnType<typeof silent>) => {
		await h.runner.start()
		await h.advance(10)
		await h.advance(1000)
		await flushAsync()
		await h.advance(10)
	}

	it("a neighbour's skirt at the tolerance's edge is not a level at the target: nothing", async () => {
		// bandwidthHz 12 500: tolerance 6 250, inner 2 250 with 4 kHz bins; the skirt's bin is 5 kHz off
		const h = silent(12_500)
		h.state.summary = summaryWith([5_000])
		await finish(h)
		expect(h.last()?.verdict).toEqual({ code: "nothing", protocol: "dmr" })
		expect(h.last()?.result?.nearbyHz).toBeUndefined()
		await h.pool.destroy()
	})

	it("a level inside the inner part with no track names its bin", async () => {
		const h = silent(12_500)
		h.state.summary = summaryWith([0])
		await finish(h)
		expect(h.last()?.verdict?.why).toBe("signal-nearby")
		expect(h.last()?.result?.nearbyHz).toBe(binCentre(TARGET_HZ))
		await h.pool.destroy()
	})

	it("a level a wide live track holds names the track's centre, not the bin", async () => {
		const h = silent(12_500)
		h.state.summary = summaryWith([0])
		// Past IDENTIFY_NEARBY_HZ and past the tolerance, so it neither resolves nor is near itself.
		const centreHz = TARGET_HZ + IDENTIFY_NEARBY_HZ + 2_500
		h.tracks.push(viewOf(trackOf({ centreHz, obwHz: 30_000 })))
		await finish(h)
		expect(h.last()?.verdict?.why).toBe("signal-nearby")
		expect(h.last()?.result?.nearbyHz).toBe(centreHz)
		await h.pool.destroy()
	})

	it("a narrow track that does not hold the level is not named", async () => {
		const h = silent(12_500)
		h.state.summary = summaryWith([0])
		h.tracks.push(
			viewOf(trackOf({ centreHz: TARGET_HZ + 40_000, obwHz: 9_000 })),
		)
		await finish(h)
		expect(h.last()?.result?.nearbyHz).toBe(binCentre(TARGET_HZ))
		await h.pool.destroy()
	})
})

describe("an IQ gap recovers once blocks flow again", () => {
	const RECOVER_MS = IDENTIFY_IQ_RECOVER_BLOCKS * BLOCK_MS
	const GAP_MS = IDENTIFY_IQ_FRESH_BLOCKS * BLOCK_MS + 100

	/** Blocks every 50 ms from the start, a silence of GAP_MS ending at `gapAt`, then blocks to the deadline. */
	async function gapEndingAt(timeoutMs: number, beforeDeadlineMs: number) {
		const h = identifyHarness({
			request: { timeoutMs, protocols: ["dmr"] },
		})
		h.state.summary = quietSummaryOf()
		h.state.iqFlowing = false
		await h.runner.start()
		const deadline = (h.record.startedAt ?? 0) + timeoutMs
		const gapAt = deadline - beforeDeadlineMs
		await h.advance(10)
		let endSample = 0
		const block = (at: number) => {
			h.clock.now = at
			endSample += 102_400
			h.runner.onBlock(endSample, false)
		}
		let at = h.clock.now
		for (; at <= gapAt - GAP_MS; at += BLOCK_MS) block(at)
		for (at = gapAt; at <= deadline; at += BLOCK_MS) block(at)
		h.clock.now = deadline
		h.runner.tick(h.clock.now)
		await flushAsync()
		await flushAsync()
		const verdict = h.last()?.verdict
		await h.pool.destroy()
		return verdict
	}

	it("states the rule: 40 block times, 2 000 ms at the default integration", () => {
		expect(IDENTIFY_IQ_RECOVER_BLOCKS).toBe(40)
		expect(RECOVER_MS).toBe(2000)
	})

	it("a transient gap early in a 15 s wait does not withhold nothing", async () => {
		expect(await gapEndingAt(15_000, 12_000)).toEqual({
			code: "nothing",
			protocol: "dmr",
		})
	})

	it("states the bound: blocks for 2 000 ms after the gap recover, 1 950 ms do not", async () => {
		expect((await gapEndingAt(5_000, RECOVER_MS))?.code).toBe("nothing")
		expect(await gapEndingAt(5_000, RECOVER_MS - BLOCK_MS)).toEqual({
			code: "could-not-test",
			why: "no-samples",
			protocol: "dmr",
		})
	})

	it("a gap near the deadline still withholds nothing", async () => {
		expect((await gapEndingAt(15_000, 500))?.why).toBe("no-samples")
	})

	it("a second gap restarts the count", async () => {
		const h = identifyHarness({
			request: { timeoutMs: 10_000, protocols: ["dmr"] },
		})
		h.state.summary = quietSummaryOf()
		await h.runner.start()
		await h.advance(1000)
		h.state.iqFlowing = false
		await h.advance(GAP_MS)
		h.state.iqFlowing = true
		await h.advance(6000)
		h.state.iqFlowing = false
		await h.advance(GAP_MS)
		h.state.iqFlowing = true
		// to the deadline: 1 750 ms of blocks after the second gap, under the 2 000 ms it needs
		await h.advance(10_000 - h.clock.now + (h.record.startedAt ?? 0))
		await flushAsync()
		await h.advance(10)
		expect(h.last()?.verdict?.why).toBe("no-samples")
		await h.pool.destroy()
	})

	/** One block at the default 50 ms integration of the fake 2.048 Msps engine: 102 400 samples. */
	const BLOCK_SAMPLES = 102_400

	/**
	 * Blocks every 50 ms, a silence of GAP_MS, then the block that ends the gap and `after` blocks
	 * ([ms after the previous one, samples it advances]), the last of them at the 5 s deadline.
	 */
	async function gapThen(after: readonly (readonly [number, number])[]) {
		const timeoutMs = 5_000
		const h = identifyHarness({ request: { timeoutMs, protocols: ["dmr"] } })
		h.state.summary = quietSummaryOf()
		h.state.iqFlowing = false
		await h.runner.start()
		const deadline = (h.record.startedAt ?? 0) + timeoutMs
		const gapAt = deadline - after.reduce((sum, [dt]) => sum + dt, 0)
		await h.advance(10)
		let endSample = 0
		const block = (at: number, samples: number) => {
			h.clock.now = at
			endSample += samples
			h.runner.onBlock(endSample, false)
		}
		let at = h.clock.now
		for (; at <= gapAt - GAP_MS; at += BLOCK_MS) block(at, BLOCK_SAMPLES)
		at = gapAt
		block(at, BLOCK_SAMPLES)
		for (const [dt, samples] of after) block((at += dt), samples)
		h.clock.now = deadline
		h.runner.tick(h.clock.now)
		await flushAsync()
		await flushAsync()
		const verdict = h.last()?.verdict
		await h.pool.destroy()
		return verdict
	}
	const blocks = (n: number, dt: number, samples: number) =>
		Array.from({ length: n }, () => [dt, samples] as const)

	it("five blocks 500 ms apart over the last 2 s after a gap are no recovery", async () => {
		// 2 000 ms of time and full sample progress (10 blocks' samples each), but 4 blocks, not 40
		const v = await gapThen(blocks(4, 500, 10 * BLOCK_SAMPLES))
		expect(v?.why).toBe("no-samples")
	})

	it("states the block bound: 40 blocks after the gap recover, 39 do not", async () => {
		expect((await gapThen(blocks(40, BLOCK_MS, BLOCK_SAMPLES)))?.code).toBe(
			"nothing",
		)
		// 39 blocks at 50 ms and one more 100 ms later: 2 000 ms and 40 blocks' samples, 39 blocks
		const short = [
			...blocks(38, BLOCK_MS, BLOCK_SAMPLES),
			[2 * BLOCK_MS, 2 * BLOCK_SAMPLES] as const,
		]
		expect((await gapThen(short))?.why).toBe("no-samples")
	})

	it("states the sample bound: 40 × 102 400 = 4 096 000 samples recover, one fewer does not", async () => {
		const at = blocks(40, BLOCK_MS, BLOCK_SAMPLES)
		expect((await gapThen(at))?.code).toBe("nothing")
		const past = [
			...blocks(39, BLOCK_MS, BLOCK_SAMPLES),
			[BLOCK_MS, BLOCK_SAMPLES - 1] as const,
		]
		expect((await gapThen(past))?.why).toBe("no-samples")
	})

	it("a block later than the fresh bound inside the run restarts it", async () => {
		// 500 ms between blocks is fresh, 501 ms a gap: 40 blocks with one 501 ms step are no recovery
		const fresh = [
			...blocks(20, BLOCK_MS, BLOCK_SAMPLES),
			[IDENTIFY_IQ_FRESH_BLOCKS * BLOCK_MS, BLOCK_SAMPLES] as const,
			...blocks(19, BLOCK_MS, BLOCK_SAMPLES),
		]
		expect((await gapThen(fresh))?.code).toBe("nothing")
		const late = [
			...blocks(20, BLOCK_MS, BLOCK_SAMPLES),
			[IDENTIFY_IQ_FRESH_BLOCKS * BLOCK_MS + 1, BLOCK_SAMPLES] as const,
			...blocks(19, BLOCK_MS, BLOCK_SAMPLES),
		]
		expect((await gapThen(late))?.why).toBe("no-samples")
	})
})
