import { describe, expect, it } from "vitest"
import { FIT_VIEW, resolveView } from "../../src/plot/maths.ts"
import { GAP_CSS, plotLayout } from "../../src/plot/layout.ts"
import {
	EMPTY_CONTEXT,
	PlotController,
	type PlotActions,
	type PlotContext,
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

	it("dragging pans; past the capture edge it retunes and keeps the channel", async () => {
		const { c, calls, release } = setup()
		c.zoom(0.5, 4) // 600 kHz in the middle
		c.beginPan()
		c.dragPan(-2000, 1000) // two view widths right: 1.2 MHz, 300 kHz past the edge
		const shown = c.visibleSpan()
		expect(shown?.endHz).toBe(capture.endHz)
		const done = c.endPan()
		await Promise.resolve()
		expect(calls[0]).toBe("retune rtl0 161800000")
		await Promise.resolve()
		expect(calls[1]).toBe(`offset ${161_150_000 - 161_800_000}`)
		release()
		await done
		// After the hardware move the view shows what was dragged to.
		const moved = {
			startHz: capture.startHz + 300_000,
			endHz: capture.endHz + 300_000,
		}
		const after = resolveView(c.store.get().view, moved)
		expect(after.startHz).toBeCloseTo(162_400_000, 3)
		expect(after.endHz).toBeCloseTo(163_000_000, 3)
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
