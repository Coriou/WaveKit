import { describe, expect, it } from "vitest"
import { FIT_VIEW } from "../../src/plot/maths.ts"
import { GAP_CSS, plotLayout } from "../../src/plot/layout.ts"
import {
	EMPTY_CONTEXT,
	FOLLOW_RETUNE_MS,
	FREE_RELEASE_MS,
	PlotController,
	type PlotActions,
	type PlotContext,
	type PlotTimers,
} from "../../src/plot/plot-store.ts"

const capture = { startHz: 160_300_000, endHz: 162_700_000 }
const context: PlotContext = {
	...EMPTY_CONTEXT,
	sourceId: "rtl0",
	capture,
	centreHz: 161_500_000,
	sampleRateHz: 2_400_000,
	tunedHz: 161_150_000,
	bandwidthHz: 12_500,
	stepHz: 12_500,
	tracks: [
		{
			startHz: 160_443_750,
			endHz: 160_456_250,
			flags: { burst: true, iqImage: false, edge: false },
		},
		{
			startHz: 160_619_500,
			endHz: 160_630_500,
			flags: { burst: false, iqImage: false, edge: false },
		},
	],
}

function setup(ctx: PlotContext = context) {
	const calls: string[] = []
	let release: () => void = () => undefined
	const actions: PlotActions = {
		retune: (hz, id) => {
			calls.push(`retune ${id} ${hz}`)
			return Promise.resolve()
		},
		setOffset: offset => {
			calls.push(`offset ${offset}`)
			return new Promise<void>(resolve => {
				release = resolve
			})
		},
	}
	const c = new PlotController(actions)
	c.setContext(ctx)
	return { c, calls, release: () => release() }
}

function fakeTimers(): PlotTimers & { advance(ms: number): void } {
	let now = 0
	let jobs: { at: number; fn: () => void; id: number }[] = []
	let ids = 0
	return {
		now: () => now,
		setTimeout: (fn, ms) => {
			const id = ++ids
			jobs.push({ at: now + ms, fn, id })
			return id
		},
		clearTimeout: handle => {
			jobs = jobs.filter(j => j.id !== handle)
		},
		advance(ms) {
			now += ms
			for (;;) {
				const due = jobs.filter(j => j.at <= now).sort((a, b) => a.at - b.at)[0]
				if (!due) return
				jobs = jobs.filter(j => j !== due)
				due.fn()
			}
		},
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A controller whose retunes and offsets answer at once, with a settable capture. */
function setupFollowing(timers: PlotTimers) {
	const calls: string[] = []
	const c = new PlotController(
		{
			retune: (hz, id) => {
				calls.push(`retune ${id} ${hz}`)
				return Promise.resolve()
			},
			setOffset: offset => {
				calls.push(`offset ${offset}`)
				return Promise.resolve()
			},
		},
		undefined,
		timers,
	)
	c.setContext(context)
	const ctx = (cap: { startHz: number; endHz: number }) =>
		c.setContext({
			...context,
			capture: cap,
			centreHz: (cap.startHz + cap.endHz) / 2,
		})
	return { c, calls, ctx }
}

describe("PlotController", () => {
	it("a click inside the capture moves the live-audio channel, snapping to the signal", async () => {
		const { c, calls, release } = setup()
		// 1000 px: the signal at 160.625 is at x ≈ 0.135; click 5 px off.
		const x = (160_625_000 - capture.startHz) / 2_400_000 + 5 / 1000
		const done = c.clickAt(x, 1000)
		expect(calls).toEqual(["offset -875000"])
		// The VFO shows the request until the core answers.
		expect(c.vfoHz()).toBe(160_625_000)
		release()
		await done
		expect(c.store.get().pendingHz).toBeNull()
		expect(c.vfoHz()).toBe(161_150_000)
	})

	it("a signal outside the core's usable 80 % recentres instead (identify would refuse it)", async () => {
		const { c, calls } = setup()
		const x = (160_450_000 - capture.startHz) / 2_400_000
		const done = c.clickAt(x, 1000)
		await Promise.resolve()
		await Promise.resolve()
		expect(calls).toEqual(["retune rtl0 160450000", "offset 0"])
		expect(c.vfoHz()).toBe(160_450_000)
		c.setContext({ ...context, tunedHz: 160_450_000 })
		void done
	})

	it("a click on empty spectrum snaps to the step raster", () => {
		const { c, calls } = setup()
		void c.clickAt((161_904_000 - capture.startHz) / 2_400_000, 1000)
		expect(calls).toEqual([`offset ${161_900_000 - 161_500_000}`])
	})

	it("tuning outside the capture recentres the hardware and zeroes the offset", async () => {
		const { c, calls, release } = setup()
		const done = c.tuneTo(156_800_000)
		await Promise.resolve()
		await Promise.resolve()
		expect(calls).toEqual(["retune rtl0 156800000", "offset 0"])
		release()
		await done
	})

	it("while a sweep has the receiver, a click inside the capture recentres (the scan pauses)", async () => {
		const { c, calls } = setup({ ...context, scanHasReceiver: true })
		const done = c.clickAt((161_900_000 - capture.startHz) / 2_400_000, 1000)
		await Promise.resolve()
		await Promise.resolve()
		expect(calls).toEqual(["retune rtl0 161900000", "offset 0"])
		void done
	})

	it("wheel notches step from the pending frequency, so fast scrolling accumulates", () => {
		const { c, calls } = setup()
		void c.wheelStep(-100) // a notch: one step up
		void c.wheelStep(-20) // trackpad travel accumulates
		void c.wheelStep(-20)
		expect(calls).toEqual([
			`offset ${161_162_500 - 161_500_000}`,
			`offset ${161_175_000 - 161_500_000}`,
		])
	})

	it("zoom and fit change only the view", () => {
		const { c, calls } = setup()
		c.zoom(0.5, 2)
		expect(c.visibleSpan()?.endHz).toBeCloseTo(162_100_000, 3)
		c.zoomCentred(2)
		// Around the VFO (161.150), which stays on screen.
		const v = c.visibleSpan()
		expect(v && 161_150_000 >= v.startHz && 161_150_000 <= v.endHz).toBe(true)
		c.fit()
		expect(c.store.get().view).toEqual(FIT_VIEW)
		expect(calls).toEqual([])
	})

	it("zoomed in, a drag inside the capture only pans", async () => {
		const { c, calls } = setup()
		c.zoom(0.5, 4) // 600 kHz in the middle
		c.beginPan()
		c.dragPan(-500, 1000) // half a view right: 300 kHz, still inside
		expect(c.visibleSpan()?.startHz).toBeCloseTo(161_500_000, 3)
		await c.endPan()
		expect(calls).toEqual([])
		expect(c.store.get().free).toBeNull()
		expect(c.visibleSpan()?.startHz).toBeCloseTo(161_500_000, 3)
	})

	it("past the capture the picture slides at once and the receiver follows during the drag", async () => {
		const timers = fakeTimers()
		const { c, calls, ctx } = setupFollowing(timers)
		c.beginPan()
		// At Fit, drag left by a quarter of the plot: 600 kHz up.
		c.dragPan(-250, 1000)
		expect(c.visibleSpan()).toEqual({
			startHz: capture.startHz + 600_000,
			endHz: capture.endHz + 600_000,
		})
		await flush()
		expect(calls[0]).toBe("retune rtl0 162100000")
		// The live channel keeps its frequency while the new capture holds it.
		expect(calls[1]).toBe(`offset ${161_150_000 - 162_100_000}`)
		// More drag before FOLLOW_RETUNE_MS: queued, latest wins.
		c.dragPan(-300, 1000)
		c.dragPan(-400, 1000)
		await flush()
		expect(calls.length).toBe(2)
		timers.advance(FOLLOW_RETUNE_MS)
		await flush()
		expect(calls[2]).toBe("retune rtl0 162460000")
		const done = c.endPan()
		await done
		// Frames at the new centre arrive: the slid view becomes a view of the capture again.
		expect(c.store.get().free).not.toBeNull()
		ctx({
			startHz: capture.startHz + 960_000,
			endHz: capture.endHz + 960_000,
		})
		c.captureChanged()
		expect(c.store.get().free).toBeNull()
		expect(c.store.get().view).toEqual(FIT_VIEW)
	})

	it("a drag that ends sends the last target at once", async () => {
		const timers = fakeTimers()
		const { c, calls } = setupFollowing(timers)
		c.beginPan()
		c.dragPan(-250, 1000)
		await flush()
		c.dragPan(-500, 1000)
		await c.endPan()
		expect(calls.filter(x => x.startsWith("retune"))).toEqual([
			"retune rtl0 162100000",
			"retune rtl0 162700000",
		])
	})

	it("a refused retune snaps the picture back and stops following", async () => {
		const timers = fakeTimers()
		const calls: string[] = []
		const c = new PlotController(
			{
				retune: hz => {
					calls.push(`retune ${hz}`)
					return Promise.reject(new Error("scanner holds the receiver"))
				},
				setOffset: () => Promise.resolve(),
			},
			undefined,
			timers,
		)
		c.setContext(context)
		c.beginPan()
		c.dragPan(-250, 1000)
		await flush()
		expect(c.store.get().free).toBeNull()
		c.dragPan(-400, 1000)
		timers.advance(1000)
		await c.endPan()
		expect(calls).toEqual(["retune 162100000"])
	})

	it("a slid view gives up waiting for frames after FREE_RELEASE_MS", async () => {
		const timers = fakeTimers()
		const { c } = setupFollowing(timers)
		c.beginPan()
		c.dragPan(-250, 1000)
		await c.endPan()
		expect(c.store.get().free).not.toBeNull()
		timers.advance(FREE_RELEASE_MS)
		expect(c.store.get().free).toBeNull()
	})

	it("the horizontal wheel slides past the capture too", async () => {
		const timers = fakeTimers()
		const { c, calls } = setupFollowing(timers)
		c.panFraction(0.5)
		expect(c.visibleSpan()?.startHz).toBe(capture.startHz + 1_200_000)
		await flush()
		expect(calls[0]).toBe("retune rtl0 162700000")
	})

	it("a small drag never retunes", async () => {
		const { c, calls } = setup()
		c.zoom(0.5, 4)
		c.beginPan()
		c.dragPan(50, 1000)
		await c.endPan()
		expect(calls).toEqual([])
	})

	it("does nothing before the first frame", async () => {
		const { c, calls } = setup(EMPTY_CONTEXT)
		await c.clickAt(0.5, 1000)
		await c.step(1)
		c.zoom(0.5, 2)
		expect(calls).toEqual([])
		expect(c.visibleSpan()).toBeNull()
	})

	it("keys step, pan, zoom and fit", () => {
		const { c, calls } = setup()
		expect(c.key({ type: "step", dir: 1, times: 10 })).toBe(true)
		expect(calls).toEqual([`offset ${161_275_000 - 161_500_000}`])
		c.key({ type: "step", dir: -1, times: 1 })
		expect(calls[1]).toBe(`offset ${161_262_500 - 161_500_000}`)
		c.key({ type: "zoom", factor: 2 })
		const before = c.visibleSpan()
		c.key({ type: "pan", fraction: -0.1 })
		expect((c.visibleSpan()?.startHz ?? 0) < (before?.startHz ?? 0)).toBe(true)
		c.key({ type: "fit" })
		expect(c.store.get().view).toEqual(FIT_VIEW)
	})
})

describe("plotLayout", () => {
	it("gives the trace about 40 %, capped at 300 px, and leaves the axis gap and some waterfall", () => {
		expect(plotLayout(1000).traceCss).toBe(300)
		expect(plotLayout(500).traceCss).toBe(200)
		const short = plotLayout(160)
		expect(short.traceCss + GAP_CSS).toBeLessThanOrEqual(160 - 40)
		expect(plotLayout(1000).splitRatio).toBeCloseTo(0.3, 6)
		expect(plotLayout(0).traceCss).toBe(0)
	})
})
