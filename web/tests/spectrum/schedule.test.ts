import { describe, expect, it } from "vitest"
import {
	RenderScheduler,
	Throttle,
	backoffDelay,
} from "../../src/spectrum/schedule.ts"
import { FakeFrames, FakeTimers } from "./fakes.ts"

describe("RenderScheduler", () => {
	it("coalesces any number of invalidations into one render per frame", () => {
		const frames = new FakeFrames()
		let renders = 0
		const s = new RenderScheduler(
			() => renders++,
			frames.request,
			frames.cancel,
		)
		for (let i = 0; i < 5; i++) s.invalidate()
		expect(frames.count).toBe(1)
		frames.tick()
		expect(renders).toBe(1)
		frames.tick()
		expect(renders).toBe(1)
		s.invalidate()
		frames.tick()
		expect(renders).toBe(2)
	})

	it("does not render after dispose", () => {
		const frames = new FakeFrames()
		let renders = 0
		const s = new RenderScheduler(
			() => renders++,
			frames.request,
			frames.cancel,
		)
		s.invalidate()
		s.dispose()
		frames.tick()
		expect(renders).toBe(0)
	})
})

describe("Throttle (frame meta ≤ 10/s)", () => {
	it("passes the first value, then the latest of each 100 ms window", () => {
		const timers = new FakeTimers()
		const sent: number[] = []
		const t = new Throttle<number>(100, v => sent.push(v), timers)
		// 25 Hz frames for one second.
		for (let i = 0; i < 25; i++) {
			t.push(i)
			timers.advance(40)
		}
		timers.advance(200)
		expect(sent[0]).toBe(0)
		expect(sent.length).toBeLessThanOrEqual(11)
		expect(sent.length).toBeGreaterThanOrEqual(9)
		expect(sent.at(-1)).toBe(24)
		for (let i = 1; i < sent.length; i++)
			expect(sent[i]).toBeGreaterThan(sent[i - 1] as number)
	})

	it("flush sends at once and drops the pending value", () => {
		const timers = new FakeTimers()
		const sent: number[] = []
		const t = new Throttle<number>(100, v => sent.push(v), timers)
		t.push(1)
		t.push(2)
		t.flush(3)
		timers.advance(500)
		expect(sent).toEqual([1, 3])
	})
})

describe("backoffDelay", () => {
	it("doubles from 500 ms and caps at 10 s, with bounded jitter", () => {
		expect(backoffDelay(0, () => 0.5)).toBe(500)
		expect(backoffDelay(1, () => 0.5)).toBe(1000)
		expect(backoffDelay(4, () => 0.5)).toBe(8000)
		expect(backoffDelay(5, () => 0.5)).toBe(10_000)
		expect(backoffDelay(50, () => 0.5)).toBe(10_000)
		expect(backoffDelay(0, () => 0)).toBe(400)
		expect(backoffDelay(0, () => 1)).toBe(600)
	})
})
