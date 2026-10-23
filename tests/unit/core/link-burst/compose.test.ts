import { expect, it, vi } from "vitest"
import pino from "pino"
import { composeLinkBurst } from "../../../../src/core/link-burst/compose.js"

const histogram = vi.hoisted(() => ({
	max: 12_000_000,
	count: 1,
	percentile: vi.fn(() => 10_000_000),
	reset: vi.fn(),
	enable: vi.fn(),
	disable: vi.fn(),
}))
vi.mock("node:perf_hooks", () => ({ monitorEventLoopDelay: () => histogram }))

it("composes recorder, absorber and a disposable loop meter on one clock", () => {
	const log = pino({ level: "silent" })
	const composed = composeLinkBurst({ log, monoNow: () => 123 })
	const delivered: Buffer[] = []
	const recorder = composed.factories.createRecorder("s")
	recorder.configure(2_048_000, 2)
	const absorber = composed.factories.createAbsorber("s", {
		log,
		recorder,
		monoNow: () => 0,
		frameBytes: 2,
		fanout: {
			distribute: chunk => delivered.push(chunk),
			congestedBranchIds: out => out.clear(),
			activeBranchIds: out => out.clear(),
			on() {},
			off() {},
		},
	})
	try {
		absorber.configure(1024)
		const chunk = Buffer.alloc(16)
		absorber.ingest(chunk)
		expect(delivered).toEqual([chunk])
		expect(delivered[0]).toBe(chunk)
		expect(composed.factories.monoNow()).toBe(123)
		const interval = composed.loopMeter.takeInterval()
		expect(interval).toEqual({ maxMs: 12, p99Ms: 10 })
		expect(histogram.enable).toHaveBeenCalledOnce()
		const report = composed.loopMeter.report(123)
		expect(report).toEqual({
			last: interval,
			maxMs10m: 12,
			p99MaxMs10m: 10,
			intervals10m: 1,
		})
		expect(composed.loopMeter.report(123)).toEqual(report)
		expect(histogram.reset).toHaveBeenCalledOnce()
		composed.dispose()
		composed.dispose()
		expect(composed.loopMeter.takeInterval()).toBeNull()
		expect(histogram.disable).toHaveBeenCalledOnce()
	} finally {
		absorber.dispose()
		composed.dispose()
	}
})
