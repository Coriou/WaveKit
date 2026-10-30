// R3: broadband blanking rising while the gain is manual surfaces an additive
// "front end may be overloaded at this gain" hint on the scanner engine status.
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	OVERLOAD_HINT_REASON,
	OverloadHintTracker,
	type OverloadHintInput,
} from "../../../../src/core/scanner/scanner-service.js"
import { FS, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

// 1,024,000 Hz with a 1024-sample hop: 1000 frames/s, so 30 s offers 30,000 frames and the
// 5 % threshold is 1,500 blanked frames.
const HOP = 1024

function input(
	seconds: number,
	blankedFrames: number,
	over: Partial<OverloadHintInput> = {},
): OverloadHintInput {
	return {
		stats: { observedSamples: seconds * FS, blankedFrames },
		sampleRateHz: FS,
		hopSamples: HOP,
		gainMode: "manual",
		gain: 496,
		...over,
	}
}

/** Feeds 5 s stats snapshots from 0 to `seconds`, blanking linearly to `total`. */
function feed(
	t: OverloadHintTracker,
	seconds: number,
	total: number,
	over: Partial<OverloadHintInput> = {},
) {
	let hint = null
	for (let s = 0; s <= seconds; s += 5)
		hint = t.update("rtl", input(s, Math.round((total * s) / seconds), over))
	return hint
}

describe("OverloadHintTracker", () => {
	it("shows the hint at exactly 5 % of frames blanked over 30 s, not one frame under", () => {
		expect(feed(new OverloadHintTracker(), 30, 1_500)).toEqual({
			reason: OVERLOAD_HINT_REASON,
			gain: 496,
			blankedPercent: 5,
		})
		expect(feed(new OverloadHintTracker(), 30, 1_499)).toBeNull()
	})

	it("shows the hint past the threshold", () => {
		expect(feed(new OverloadHintTracker(), 30, 6_000)).toMatchObject({
			blankedPercent: 20,
		})
	})

	it("needs at least 50 blanked frames however few frames were offered", () => {
		// One frame per second: 30 frames in 30 s, so the fraction alone would pass.
		const slow = { hopSamples: FS }
		expect(feed(new OverloadHintTracker(), 30, 49, slow)).toBeNull()
		expect(feed(new OverloadHintTracker(), 30, 50, slow)).not.toBeNull()
	})

	it("needs at least 10 s of samples", () => {
		const t = new OverloadHintTracker()
		expect(t.update("rtl", input(0, 0))).toBeNull()
		expect(t.update("rtl", input(5, 5_000))).toBeNull()
		expect(t.update("rtl", input(10, 10_000))).not.toBeNull()
	})

	it("judges only the last ~30 s: old blanking ages out", () => {
		const t = new OverloadHintTracker()
		for (let s = 0; s <= 30; s += 5) t.update("rtl", input(s, s * 100))
		expect(t.update("rtl", input(30, 3_000))).not.toBeNull()
		// Blanking stops: once the burst is outside the window the hint clears.
		let hint = null
		for (let s = 35; s <= 70; s += 5) hint = t.update("rtl", input(s, 3_000))
		expect(hint).toBeNull()
	})

	it("repeated reads of the same stats snapshot change nothing", () => {
		const t = new OverloadHintTracker()
		feed(t, 30, 3_000)
		for (let i = 0; i < 20; i++)
			expect(t.update("rtl", input(30, 3_000))).not.toBeNull()
	})

	it("fails closed: AGC, unknown mode or gain, missing stats or config", () => {
		for (const over of [
			{ gainMode: "agc" as const },
			{ gainMode: null },
			{ gain: null },
			{ stats: null },
			{ sampleRateHz: null },
			{ hopSamples: null },
			{ hopSamples: 0 },
		])
			expect(feed(new OverloadHintTracker(), 30, 6_000, over)).toBeNull()
	})

	it("a gain change starts a new window", () => {
		const t = new OverloadHintTracker()
		feed(t, 30, 6_000)
		expect(t.update("rtl", input(35, 7_000, { gain: 297 }))).toBeNull()
	})

	it("an AGC interval starts a new window", () => {
		const t = new OverloadHintTracker()
		feed(t, 30, 6_000)
		expect(t.update("rtl", input(35, 7_000, { gainMode: "agc" }))).toBeNull()
		expect(t.update("rtl", input(40, 8_000))).toBeNull()
	})

	it("a counter that goes backwards (restarted pipeline) starts a new window", () => {
		const t = new OverloadHintTracker()
		feed(t, 30, 6_000)
		expect(t.update("rtl", input(1, 10))).toBeNull()
		expect(t.update("rtl", input(5, 20))).toBeNull()
	})
})

describe("ScannerService status overloadHint", () => {
	const harnesses: ReturnType<typeof serviceHarness>[] = []
	afterEach(async () => {
		vi.restoreAllMocks()
		for (const h of harnesses.splice(0)) {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	})

	function harness() {
		const h = serviceHarness({ patch: s => void (s.passive.enabled = false) })
		harnesses.push(h)
		const stats = { observedSamples: 0, blankedFrames: 0 }
		const engine = {
			isRunning: true,
			markerSupported: null,
			config: () => ({ sampleRateHz: FS, fftSize: HOP, overlap: 0 }),
			stats: () => ({
				kByRange: [],
				floorDbfs: -90,
				stuckTestMode: false,
				staleAfterSettle: 0,
				broadbandRfi: null,
				...stats,
			}),
			currentEpoch: () => ({ centreHz: 0, settleMode: null }),
		}
		vi.spyOn(h.service.spectrum, "engine").mockReturnValue(
			engine as unknown as ReturnType<typeof h.service.spectrum.engine>,
		)
		const read = (s: number, blanked: number) => {
			stats.observedSamples = s * FS
			stats.blankedFrames = blanked
			return h.service.status().engines.find(e => e.sourceId === "rtl")
		}
		return { h, read }
	}

	it("surfaces the hint with manual gain and rising blanking, additively", () => {
		const { h, read } = harness()
		h.tuner.states.get("rtl")!.gain = 496
		let engine = read(0, 0)
		for (let s = 5; s <= 30; s += 5) engine = read(s, s * 200)
		expect(engine?.overloadHint).toEqual({
			reason: "front end may be overloaded at this gain",
			gain: 496,
			blankedPercent: 20,
		})
		expect(engine?.blankedFrames).toBe(6_000)
	})

	it("no hint in AGC, with an unknown gain, or when blanking is quiet", () => {
		const { h, read } = harness()
		const state = h.tuner.states.get("rtl")!
		state.gainMode = "agc"
		for (let s = 0; s <= 30; s += 5)
			expect(read(s, s * 200)).not.toHaveProperty("overloadHint")
		state.gainMode = "manual"
		h.tuner.known.get("rtl")!.delete("gain")
		for (let s = 35; s <= 70; s += 5)
			expect(read(s, s * 200)).not.toHaveProperty("overloadHint")
		h.tuner.known.get("rtl")!.add("gain")
		for (let s = 75; s <= 110; s += 5)
			expect(read(s, 14_000 + s)).not.toHaveProperty("overloadHint")
	})
})
