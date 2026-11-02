import { describe, expect, it } from "vitest"
import { createChannelGate } from "../../../../src/core/spectrum/channel-gate.js"
import {
	CHANNEL_GATE_BURST_MIN_DURATION_MS,
	CHANNEL_GATE_MIN_DURATION_MS,
	type ChannelPlan,
	type ChannelPlanEntry,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"

// Scanner quality benchmark, defect A: a burst range (ISM 433) overlapped by non-burst ranges
// (70 cm, UHF land mobile). A track inside it reads the standard rule from the non-burst slots;
// `burstCovered` says burst slots alone cover it, so the tracker may pass it by the burst rule.

const TUNE = 433_400_000
const BIN_HZ = 1_000
const BINS = 1024

const entry = (
	startHz: number,
	endHz: number,
	burst: boolean,
	rasterHz: number | null,
): ChannelPlanEntry => ({
	startHz,
	endHz,
	widthHz: 12_500,
	rasterHz,
	firstChannelHz: rasterHz === null ? null : startHz,
	burst,
	rangeKey: `${startHz}:${endHz}`,
})

/** Land mobile over the whole window (12.5 kHz raster) and a raster-less burst range inside it. */
const ISM_LO = 433_050_000
const ISM_HI = 433_800_000
function gate(withIsm = true) {
	const g = createChannelGate({
		binHz: BIN_HZ,
		blockMs: 50,
		centreHz: TUNE,
		bins: BINS,
	})
	const plan: ChannelPlan = {
		sourceId: "src",
		defaultWidthHz: 12_500,
		entries: [
			entry(432_800_000, 434_000_000, false, 12_500),
			...(withIsm ? [entry(ISM_LO, ISM_HI, true, null)] : []),
		],
	}
	g.setPlan(plan)
	return g
}

describe("channel gate burst coverage", () => {
	it("a wide track inside the burst range is burst-covered under the standard rule", () => {
		const r = gate().gateOf(433_500_000, 85_000)
		expect(r.minDurationMs).toBe(CHANNEL_GATE_MIN_DURATION_MS)
		expect(r.burstCovered).toBe(true)
	})

	it("a narrow track inside it is covered too", () => {
		const r = gate().gateOf(433_500_000, 8_000)
		// either its own slot is burst, or burst slots cover it
		expect(
			r.minDurationMs === CHANNEL_GATE_BURST_MIN_DURATION_MS ||
				r.burstCovered === true,
		).toBe(true)
	})

	it("no burst range, or a track reaching past the burst range's edge: not covered", () => {
		expect(gate(false).gateOf(433_500_000, 85_000).burstCovered).toBe(false)
		// 433.05 MHz edge: a track from 433.00 to 433.10 MHz sticks out of the burst slots
		expect(gate().gateOf(433_050_000, 100_000).burstCovered).toBe(false)
		// well outside the burst range
		expect(gate().gateOf(432_900_000, 20_000).burstCovered).toBe(false)
	})

	it("a reused reading object does not keep a stale coverage", () => {
		const g = gate()
		const out = g.gateOf(433_500_000, 85_000)
		expect(out.burstCovered).toBe(true)
		g.gateInto(432_900_000, 20_000, out)
		expect(out.burstCovered).toBe(false)
		g.gateInto(Number.NaN, 20_000, out)
		expect(out.burstCovered).toBe(false)
	})
})
