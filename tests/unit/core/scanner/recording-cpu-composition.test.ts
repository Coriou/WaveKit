/**
 * The recording limit's CPU reading through the production composition, not a hand-made one:
 * the real efficiency monitor (its sample tick captured from its injected setInterval, its
 * monotonic clock a fake) feeds the real decoder efficiency gate as src/index.ts composes it
 * (composeDecoderEfficiencyGate stamps each sample with the monitor's clock), and the real
 * wideband analog recorder reads it through the same expression src/index.ts passes as the
 * scanner's `recordingCpu` dep (recording-cpu-wiring.test.ts checks that line). No real timer
 * runs and no wall clock is read: time moves only when the test moves it.
 */
import { describe, expect, it } from "vitest"
import { composeDecoderEfficiencyGate } from "../../../../src/index.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import {
	EFFICIENCY_SAMPLE_MS,
	EFFICIENCY_STALE_MS,
} from "../../../../src/decoders/enablement/contract.js"
import { FS, harness } from "./wideband-recorder-harness.js"

/** The monitor and gate as the core builds them, on a fake clock; one sample per `tick`. */
function composed(reading: {
	hostPercent: number | null
	ownCores: number | null
	capacityCores: number
}) {
	let mono = 0
	let tickFn: (() => void) | null = null
	const monitor = createEfficiencyMonitor({
		sources: () => [],
		branchCounters: () => null,
		cpu: {
			get normalisedPercent() {
				return reading.hostPercent
			},
		},
		ownCpu: {
			sample: () => ({
				ownCores: reading.ownCores,
				capacityCores: reading.capacityCores,
				available: true,
			}),
		},
		cpuGuardPercent: 85,
		now: () => 0,
		monoNow: () => mono,
		onSample: sample => gate.record(sample),
		setInterval: fn => {
			tickFn = fn
			return { cancel: () => undefined }
		},
	})
	const gate = composeDecoderEfficiencyGate(
		{ budgetCores: 1, cpuGuardPercent: 85 },
		monitor,
	)
	monitor.start()
	// The same expression src/index.ts gives the ScannerService (its `recordingCpu` dep).
	const recordingCpu = () => gate.cpuState?.(monitor.monoNow()) ?? null
	return {
		monitor,
		gate,
		recordingCpu,
		advance: (ms: number) => {
			mono += ms
		},
		tick: () => {
			mono += EFFICIENCY_SAMPLE_MS
			expect(tickFn).not.toBeNull()
			tickFn!()
		},
		get mono() {
			return mono
		},
	}
}

describe("the recording CPU reading through the monitor and gate the core composes", () => {
	it("a calm sample raises the source's limit above 2; past EFFICIENCY_STALE_MS it is the floor again", () => {
		// Own 0.5 of 8 cores, host 10 %, guard 85 %: calm, room for many.
		const c = composed({ hostPercent: 10, ownCores: 0.5, capacityCores: 8 })
		const h = harness({ recordingCpu: c.recordingCpu })
		// No sample yet: no reading, the floor.
		expect(h.rec.limitOn("rtl", FS)).toEqual({
			limit: 2,
			cap: 4,
			shrunk: "unknown",
		})
		c.tick()
		const reading = c.recordingCpu()
		expect(reading).toMatchObject({
			label: "calm",
			hostPercent: 10,
			ownCores: 0.5,
			capacityCores: 8,
			guardPercent: 85,
			// Stamped on the monitor's clock: the reading is named by its sample time.
			sampledAt: c.mono,
		})
		expect(h.rec.limitOn("rtl", FS)).toEqual({
			limit: 6,
			cap: 4,
			shrunk: null,
		})
		// At the stale bound the sample is still fresh; just past it, no reading: the floor.
		c.advance(EFFICIENCY_STALE_MS)
		expect(h.rec.limitOn("rtl", FS).limit).toBe(6)
		c.advance(1)
		expect(c.recordingCpu()).toBeNull()
		expect(h.rec.limitOn("rtl", FS)).toEqual({
			limit: 2,
			cap: 4,
			shrunk: "unknown",
		})
		// A new sample makes it calm again.
		c.tick()
		expect(h.rec.limitOn("rtl", FS).limit).toBe(6)
		c.monitor.stop()
	})

	it("a host busy past the guard is pressure through the same path: the floor, refused:cpu", () => {
		const c = composed({ hostPercent: 95, ownCores: 0.5, capacityCores: 8 })
		const h = harness({ recordingCpu: c.recordingCpu })
		c.tick()
		expect(c.recordingCpu()?.label).toBe("host-busy")
		expect(h.rec.limitOn("rtl", FS)).toEqual({
			limit: 2,
			cap: 4,
			shrunk: "pressure",
		})
		c.monitor.stop()
	})

	it("a calm core on a host near its guard leaves no room above 2 (host 84 % of 85 %)", () => {
		const c = composed({ hostPercent: 84, ownCores: 0.5, capacityCores: 8 })
		const h = harness({ recordingCpu: c.recordingCpu })
		c.tick()
		expect(c.recordingCpu()?.label).toBe("calm")
		expect(h.rec.limitOn("rtl", FS).limit).toBe(2)
		c.monitor.stop()
	})
})
