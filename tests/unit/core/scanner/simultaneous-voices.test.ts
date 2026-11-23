/**
 * Simultaneous traffic in one span (`modelled`: synthetic stand-ins for a busy span of
 * walkie-talkie channels with an analog carrier and a digital-voice-like 4FSK burst beside them),
 * through the production scanner composition (simultaneous-voices-scenario.ts). What is recorded
 * and what is missed per voice, at the floor of 2 (no CPU reading), with a calm reading (the
 * budget's cap) and under CPU pressure (back to 2, refused:cpu). The CPU reading is injected:
 * no wall-clock assertion.
 */
// WAVEKIT_REQUIRE_NFM_WASM=1: fail rather than run the JS chain (wideband-recorder-harness.ts).
import "./recorder-dsp-required.js"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingCpuReading } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	defaultPlan,
	disposeScenario,
	feedChunks,
	recordedFiles,
	recorderOf,
	scenarioHarness,
	settleRecorder,
	strayFiles,
	synthesize,
	voiceOutcomes,
	type ScenarioHarness,
} from "./simultaneous-voices-scenario.js"

const harnesses: ScenarioHarness[] = []
afterEach(async () => {
	for (const h of harnesses.splice(0)) await disposeScenario(h)
})

/** Four voices all on the air from 2.5 to 7 s, a carrier and a 4FSK burst through the window. */
const plan = defaultPlan(4)
const chunks = synthesize(plan)

async function run(cpu?: () => RecordingCpuReading | null) {
	const h = scenarioHarness(cpu)
	harnesses.push(h)
	await h.service.start()
	let maxActive = 0
	await feedChunks(h, chunks, () => {
		maxActive = Math.max(maxActive, recorderOf(h).activeOn("rtl"))
	})
	await settleRecorder(h)
	const files = await recordedFiles(h.dir)
	return {
		outcomes: voiceOutcomes(h, plan, files),
		stray: strayFiles(h, plan, files),
		counts: recorderOf(h).diagnostics().counts,
		maxActive,
	}
}

const calm: RecordingCpuReading = {
	label: "calm",
	ownCores: 0.5,
	capacityCores: 8,
	guardPercent: 90,
}

describe("simultaneous FM voices in one span (modelled)", () => {
	it("no CPU reading: the floor of 2 records two voices whole and misses the others (refused:slots)", async () => {
		const r = await run()
		expect(r.outcomes.filter(o => o === "whole")).toHaveLength(2)
		expect(r.outcomes.filter(o => o === "missed")).toHaveLength(2)
		expect(r.maxActive).toBeLessThanOrEqual(2)
		expect(r.counts["refused:slots"]).toBeGreaterThan(0)
		expect(r.counts["refused:cpu"]).toBeUndefined()
		// Neither the carrier nor the 4FSK burst is kept.
		expect(r.stray).toEqual([])
	}, 300_000)

	it("a calm reading: all four voices recorded whole at once, nothing refused for slots, no stray file", async () => {
		const r = await run(() => calm)
		expect(r.outcomes).toEqual(["whole", "whole", "whole", "whole"])
		expect(r.maxActive).toBeGreaterThanOrEqual(4)
		expect(r.maxActive).toBeLessThanOrEqual(6)
		expect(r.counts["refused:slots"]).toBeUndefined()
		expect(r.counts["refused:cpu"]).toBeUndefined()
		expect(r.counts.finalized).toBe(4)
		expect(r.stray).toEqual([])
	}, 300_000)

	it("CPU pressure: back to 2 at once, the others refused:cpu (not slots), the two kept whole", async () => {
		const r = await run(() => ({ ...calm, label: "host-busy" }))
		expect(r.outcomes.filter(o => o === "whole")).toHaveLength(2)
		expect(r.outcomes.filter(o => o === "missed")).toHaveLength(2)
		expect(r.maxActive).toBeLessThanOrEqual(2)
		expect(r.counts["refused:cpu"]).toBeGreaterThan(0)
		expect(r.counts["refused:slots"]).toBeUndefined()
		expect(r.stray).toEqual([])
	}, 300_000)
})
