import { describe, expect, it } from "vitest"
import { withBandBurstPrior } from "../../../../src/core/scanner/band-scan-burst-prior.js"
import {
	bandplansFor,
	priorsFor,
} from "../../../../src/core/scanner/bandplan/index.js"
import {
	classOf,
	classifySpectral,
} from "../../../../src/core/scanner/classify/classifier.js"
import { probeModesFor } from "../../../../src/core/scanner/probes/probe-pool.js"
import type { ScannerProtocol } from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	fsk4Burst,
	gaussianNoise,
	mulberry32,
} from "../../../mocks/scanner/signals.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import { CENTRE, FS, Harness } from "../spectrum/pipeline-harness.js"

/**
 * WG11 req 1.4 (d): a DMR mobile (two-slot TDMA, 30 ms on / 30 ms off, 4FSK at about 9 kHz OBW)
 * through the real spectrum pipeline at the sweep's integration (50 ms blocks, minSurfaceBlocks 2),
 * then the real classifier in the contexts a sweep builds.
 */

const SIGMA = 0.01
const OFFSET_HZ = -40_000
/** A land-mobile frequency inside the built-in 136-174 MHz plan, outside any ISM plan. */
const VHF_HZ = 150_012_500

function dmrTracks(snrDb: number): TrackSnapshot[] {
	const n = Math.round(1.2 * FS)
	const amp = Math.sqrt(10 ** (snrDb / 10) * SIGMA * SIGMA * (12_500 / FS))
	const iq = gaussianNoise(mulberry32(3), n, SIGMA)
	addInto(
		iq,
		fsk4Burst(mulberry32(4), n, FS, OFFSET_HZ, amp, {
			tdma: true,
			tdmaOnMs: 30,
			tdmaPeriodMs: 60,
		}),
	)
	const h = new Harness({ format: "FLOAT32LE", integrationMs: 50 })
	h.start({ feed: false })
	h.push(iq, 8192)
	return h
		.tracks()
		.filter(t => Math.abs(t.centreHz - (CENTRE + OFFSET_HZ)) <= 5000)
}

/** The sweep's live context for a job whose ranges and protocols are empty at the frequency. */
const EMPTY = { priors: {}, protocols: [] as ScannerProtocol[] }
const bandPriors = () =>
	priorsFor(
		bandplansFor("EU").flatMap(b => b.ranges),
		VHF_HZ,
	)
const FIXED = {
	priors: withBandBurstPrior(
		{ ...EMPTY, rangesListProtocols: false },
		bandPriors,
	),
	protocols: [] as ScannerProtocol[],
}

describe("band-scan DMR: spectral class at the sweep's decision (1.4 d)", () => {
	const tracks = dmrTracks(25)
	// Default sweep dwell: settle + (minSurfaceBlocks + 1) blocks; the scheduler decides 3 blocks
	// after the settle, so it has seen only the open (1 block) and first update (2 blocks).
	const atDecision = tracks.filter(t => t.blocks <= 3)
	const later = tracks.filter(t => t.blocks >= 20)

	it("carries no TDMA signature before 300 ms of envelope: never tdma-ms at the decision", () => {
		expect(atDecision.length).toBeGreaterThanOrEqual(2)
		for (const t of atDecision) {
			expect(t.acf30).toBeUndefined()
			expect(t.acf60).toBeUndefined()
			expect(t.obwHz).toBeGreaterThanOrEqual(8000)
			expect(t.obwHz).toBeLessThanOrEqual(11_000)
		}
		// The 1 s update (blocks 20) is the first with the TDMA signature.
		expect(later.length).toBeGreaterThan(0)
		expect(classifySpectral(later[0]!, EMPTY).class).toBe("tdma-ms")
	})

	it("reproduces the gap: with no protocols at the frequency the young track is an ISM burst with no probe mode", () => {
		for (const t of atDecision) {
			const c = classifySpectral(t, EMPTY)
			expect(c.class).toBe("ook-burst")
			expect(c.hypotheses[0]?.protocol).toBe("ism")
			expect(probeModesFor(c.class, [])).toEqual([])
		}
	})

	it("fixed: the band plan's ism prior keeps the young track land mobile and probe-able by dsd-fme auto", () => {
		expect(FIXED.priors.ism).toBe(0.25)
		for (const t of atDecision) {
			const c = classifySpectral(t, FIXED)
			expect(["fsk4-12k5", "analog-fm"]).toContain(c.class)
			const modes = probeModesFor(c.class, [])
			expect(modes[0]?.decoderType).toBe("dsd-fme")
			expect(modes[0]?.options["mode"]).toBe("auto")
			expect(modes[0]?.covers).toContain("dmr")
		}
		// No other hypothesis moves: the band ism prior only gates the burst rule.
		for (const t of later)
			expect(classifySpectral(t, FIXED)).toEqual(classifySpectral(t, EMPTY))
	})
})

describe("withBandBurstPrior", () => {
	const empty = { priors: {}, protocols: [], rangesListProtocols: false }
	const band = (ism: number) => () => ({ ism })

	it("fills ism from the band plan only when the job says nothing at the frequency", () => {
		expect(withBandBurstPrior(empty, band(0.25))).toEqual({ ism: 0.25 })
		expect(
			withBandBurstPrior({ ...empty, rangesListProtocols: true }, band(0.25)),
		).toEqual({})
		expect(
			withBandBurstPrior({ ...empty, protocols: ["dmr"] }, band(0.25)),
		).toEqual({})
		expect(
			withBandBurstPrior({ ...empty, priors: { ism: 1 } }, band(0.25)),
		).toEqual({ ism: 1 })
	})

	it("keeps today's priors when the band plan has no ism prior or a malformed one", () => {
		let calls = 0
		const none = () => {
			calls++
			return {}
		}
		const same = { ...empty, priors: { dmr: 1 } }
		expect(withBandBurstPrior(same, none)).toBe(same.priors)
		expect(calls).toBe(1)
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.5])
			expect(withBandBurstPrior(same, band(bad))).toBe(same.priors)
	})

	it("does not read the band plan when the job decides (no lookup cost)", () => {
		let calls = 0
		const count = () => {
			calls++
			return { ism: 0.25 }
		}
		withBandBurstPrior({ ...empty, rangesListProtocols: true }, count)
		withBandBurstPrior({ ...empty, protocols: ["ism"] }, count)
		withBandBurstPrior({ ...empty, priors: { ism: 0.5 } }, count)
		expect(calls).toBe(0)
	})

	it("burst rule bound: a band ism prior of 1 still allows the burst, one step below does not", () => {
		const young = makeTrack({
			id: "y",
			centreHz: VHF_HZ,
			startedAt: 0,
			blocks: 4,
		})
		const at = withBandBurstPrior(empty, band(1))
		const below = withBandBurstPrior(empty, band(0.999))
		expect(classifySpectral(young, { priors: at, protocols: [] }).class).toBe(
			"ook-burst",
		)
		expect(
			classifySpectral(young, { priors: below, protocols: [] }).class,
		).toBe("fsk4-12k5")
		// BURST_MAX_BLOCKS bound: 4 blocks is a burst, 5 is not (unchanged by 1.4).
		expect(classOf({ ...young, blocks: 5 })).toBe("fsk4-12k5")
	})

	it("built-in plans: no ISM prior in VHF land mobile, ISM kept at 433.92 MHz", () => {
		const ranges = bandplansFor("EU").flatMap(b => b.ranges)
		expect(priorsFor(ranges, VHF_HZ).ism).toBe(0.25)
		const at433 = withBandBurstPrior(empty, () =>
			priorsFor(ranges, 433_920_000),
		)
		expect(at433.ism ?? 1).toBe(1)
		// 135.5 MHz (aviation plan, no ISM listed): no burst either.
		expect(
			withBandBurstPrior(empty, () => priorsFor(ranges, 135_500_000)).ism,
		).toBe(0.25)
		// Outside every plan: the band plan says nothing, priors unchanged, burst allowed.
		expect(priorsFor(ranges, 100_000_000)).toEqual({})
		expect(
			withBandBurstPrior(empty, () => priorsFor(ranges, 100_000_000)),
		).toEqual({})
	})
})
