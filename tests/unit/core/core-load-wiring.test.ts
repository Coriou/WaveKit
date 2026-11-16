import { describe, expect, it, vi } from "vitest"
import pino from "pino"
import { composeLinkBurst } from "../../../src/core/link-burst/compose.js"
import {
	createLinkAdvisor,
	linkAdvisorEvidence,
} from "../../../src/core/link-advisory.js"
import {
	CORE_BUSY_ELU,
	CORE_BUSY_LOOP_DELAY_MS,
	coreBusy,
	createCoreLoadSignal,
} from "../../../src/core/core-load.js"

// The process's event-loop evidence, faked at the node:perf_hooks boundary so the production
// loop meter (built by composeLinkBurst) reads it.
const loop = vi.hoisted(() => ({
	utilisation: 0,
	clock: 0,
	histogram: {
		max: 0,
		count: 1,
		percentile: () => 0,
		reset: () => undefined,
		enable: () => undefined,
		disable: () => undefined,
	},
}))
vi.mock("node:perf_hooks", () => ({
	monitorEventLoopDelay: () => loop.histogram,
	performance: {
		now: () => loop.clock,
		eventLoopUtilization: () => ({
			active: loop.utilisation * loop.clock,
			idle: (1 - loop.utilisation) * loop.clock,
		}),
	},
}))

const RATE = 2_400_000
const SHORT = RATE * 2 * 0.98
const input = { sourceId: "s", host: "source.invalid", sampleRateHz: RATE }

/**
 * Runs 20 s of the production link-burst composition on one clock: chunks every 10 ms into the
 * source's ingest recorder (none during `gap`), the efficiency monitor's 2 s loop-meter reads,
 * and a short received rate, then classifies with the advisor wired as src/index.ts wires it.
 */
function run(opts: {
	utilisation: number
	loopDelayMs: number
	gap?: { from: number; to: number }
	wired?: boolean
}) {
	loop.utilisation = opts.utilisation
	loop.histogram.max = opts.loopDelayMs * 1e6
	loop.clock = 0
	const composed = composeLinkBurst({
		log: pino({ level: "silent" }),
		monoNow: () => loop.clock,
	})
	const recorder = composed.factories.createRecorder("s")
	recorder.configure(RATE, 2)
	const advisor = createLinkAdvisor({
		now: () => loop.clock,
		monoNow: () => loop.clock,
		...(opts.wired === false
			? {}
			: linkAdvisorEvidence({
					coreLoad: composed.coreLoad,
					recorderOf: id => (id === "s" ? recorder : null),
					monoNow: composed.factories.monoNow,
				})),
	})
	try {
		for (let t = 0; t <= 20_000; t += 10) {
			loop.clock = t
			const inGap = opts.gap && t > opts.gap.from && t < opts.gap.to
			if (!inGap) recorder.observeChunk(RATE * 2 * 0.01, t)
			if (t % 2000 === 0) composed.loopMeter.takeInterval()
			if (t >= 10_000 && t % 5000 === 0) advisor.observe("s", SHORT, RATE, t)
		}
		return advisor.classify(input, null)
	} finally {
		composed.dispose()
	}
}

describe("core load signal through the production link-burst composition", () => {
	it("a saturated loop on a dropping network source reads core-busy", () => {
		const advisory = run({ utilisation: 0.95, loopDelayMs: 5 })
		expect(advisory.level).toBe("dropping")
		expect(advisory.lossReason).toBe("core-busy")
	})

	it("a long loop stall reads core-busy below the utilisation bound", () => {
		const advisory = run({ utilisation: 0.8, loopDelayMs: 250 })
		expect(advisory.lossReason).toBe("core-busy")
	})

	it("a quiet loop with an arrival gap reads source", () => {
		const advisory = run({
			utilisation: 0.3,
			loopDelayMs: 5,
			gap: { from: 14_000, to: 15_000 },
		})
		expect(advisory.level).toBe("dropping")
		expect(advisory.lossReason).toBe("source")
	})

	it("an ambiguous loop is decided by the recorder's arrival gap", () => {
		const evidence = { utilisation: 0.8, loopDelayMs: 100 }
		expect(run(evidence).lossReason).toBe("unknown")
		expect(
			run({ ...evidence, gap: { from: 14_000, to: 15_000 } }).lossReason,
		).toBe("source")
	})

	it("without the evidence wired the same saturated loop reads unknown", () => {
		expect(
			run({ utilisation: 0.95, loopDelayMs: 5, wired: false }).lossReason,
		).toBe("unknown")
	})

	it("the composed signal reads the meter's utilisation and worst delay", () => {
		loop.utilisation = 0.5
		loop.histogram.max = 30e6
		loop.clock = 0
		const composed = composeLinkBurst({
			log: pino({ level: "silent" }),
			monoNow: () => loop.clock,
		})
		try {
			composed.loopMeter.takeInterval()
			loop.clock = 4000
			composed.loopMeter.takeInterval()
			const reading = composed.coreLoad.read(0)
			expect(reading.elu).toBeCloseTo(0.5)
			expect(reading.loopDelayMaxMs).toBe(30)
			expect(coreBusy(reading)).toBe(false)
		} finally {
			composed.dispose()
		}
	})
})

describe("coreBusy and an unreadable meter", () => {
	it("applies the busy thresholds and treats missing evidence as not busy", () => {
		expect(coreBusy({ elu: CORE_BUSY_ELU, loopDelayMaxMs: null })).toBe(true)
		expect(
			coreBusy({ elu: null, loopDelayMaxMs: CORE_BUSY_LOOP_DELAY_MS }),
		).toBe(true)
		expect(coreBusy({ elu: 0.89, loopDelayMaxMs: 199 })).toBe(false)
		expect(coreBusy({ elu: null, loopDelayMaxMs: null })).toBe(false)
		expect(coreBusy({ elu: Number.NaN, loopDelayMaxMs: -1 })).toBe(false)
	})

	it("reads nulls when the meter throws or answers out of range", () => {
		const throwing = createCoreLoadSignal({
			loopMeter: {
				utilizationSince: () => {
					throw new Error("gone")
				},
				maxSince: () => Number.POSITIVE_INFINITY,
			},
		})
		expect(throwing.read(0)).toEqual({ elu: null, loopDelayMaxMs: null })
		const outOfRange = createCoreLoadSignal({
			loopMeter: { utilizationSince: () => 1.5, maxSince: () => -3 },
		})
		expect(outOfRange.read(0)).toEqual({ elu: null, loopDelayMaxMs: null })
	})
})
