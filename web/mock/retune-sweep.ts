// Retune sweep scenario (band view retune correctness, lane WB): WAVEKIT_MOCK_RETUNE_SWEEP=1 (or
// `retuneSweep: true` in buildMockServer) retunes the mock receiver through a multi-band sequence, one
// window every RETUNE_SWEEP_STEP_MS, then parks at 431.078 MHz at 1.024 MS/s. Each window has its own
// steady signals (so the plot labels them) and discoveries (so the discovery row and the band ruler's
// heard strip fill), and a saved frequency sits at 399.502 MHz. After the park only the four parked
// signals may be labelled: no chip, tag or heard mark from an earlier window inside the plot.
//
// Synthetic values only. Type stripping only: no enums, parameter properties or namespaces.
import type { MockSignal } from "./data.ts"
import { bandFixtureDiscoveries, type FixtureSpec } from "./band-fixtures.ts"
import type { Discovery } from "@wavekit/api-types"

export interface RetuneSweepStep {
	hz: number
	sampleRateHz: number
}

const M = (mhz: number) => Math.round(mhz * 1e6)
const FULL = 2_400_000

/** The retune sequence; the last step is where the receiver parks. */
export const RETUNE_SWEEP_STEPS: readonly RetuneSweepStep[] = [
	{ hz: M(1090), sampleRateHz: FULL },
	{ hz: M(131), sampleRateHz: FULL },
	{ hz: M(136), sampleRateHz: FULL },
	{ hz: M(119.7), sampleRateHz: FULL },
	{ hz: M(144.6), sampleRateHz: FULL },
	{ hz: M(98), sampleRateHz: FULL },
	{ hz: M(438.9), sampleRateHz: FULL },
	{ hz: M(446.1), sampleRateHz: FULL },
	{ hz: M(431.1), sampleRateHz: FULL },
	{ hz: M(868.9), sampleRateHz: FULL },
	{ hz: M(162), sampleRateHz: FULL },
	{ hz: M(155), sampleRateHz: FULL },
	{ hz: M(431.078), sampleRateHz: 1_024_000 },
]

export const RETUNE_SWEEP_PARK: RetuneSweepStep = RETUNE_SWEEP_STEPS[
	RETUNE_SWEEP_STEPS.length - 1
] as RetuneSweepStep

/** Time on each window before the next retune, ms. */
export const RETUNE_SWEEP_STEP_MS = 1500

const steady = (
	mhz: number,
	bwHz: number,
	powerDbfs: number,
	kind: MockSignal["kind"] = "voice",
): MockSignal => ({
	hz: M(mhz),
	bwHz,
	powerDbfs,
	kind,
	modulation: kind === "wfm" ? "wfm" : kind === "am" ? "am" : "nfm",
})

/** The four transmissions in the parked window (431.078 MHz ± 410 kHz usable). */
export const RETUNE_SWEEP_PARKED_SIGNALS: readonly MockSignal[] = [
	steady(430.8, 12_500, -62),
	steady(430.97, 12_500, -58),
	steady(431.2, 12_500, -64),
	steady(431.35, 12_500, -60),
]

/** Steady signals in the earlier windows (none inside the parked window). */
export const RETUNE_SWEEP_SIGNALS: readonly MockSignal[] = [
	steady(1089.6, 1_000_000, -70, "burst"),
	steady(130.6, 8_000, -66, "am"),
	steady(131.525, 8_000, -64, "am"),
	steady(136.4, 8_000, -66, "am"),
	steady(120.0, 8_000, -62, "am"),
	steady(119.3, 8_000, -66, "am"),
	steady(144.8, 12_500, -60),
	steady(145.1, 12_500, -64),
	steady(97.398, 180_000, -52, "wfm"),
	steady(98.6, 180_000, -55, "wfm"),
	steady(438.139, 12_500, -60),
	steady(439.4, 12_500, -62),
	steady(445.95, 12_500, -58),
	steady(446.06, 12_500, -60),
	steady(446.6, 12_500, -62),
	steady(868.823, 200_000, -62),
	steady(869.5, 50_000, -64),
	steady(162.328, 25_000, -60),
	steady(161.6, 25_000, -64),
	steady(154.2, 12_500, -60),
	steady(154.975, 12_500, -58),
	steady(155.7, 12_500, -62),
	...RETUNE_SWEEP_PARKED_SIGNALS,
]

const decodedDmr = (id: string, mhz: number, cc: number): FixtureSpec => ({
	id,
	mhz,
	protocol: "dmr",
	family: "digital-voice",
	class: "tdma-ms",
	confidence: "decoded",
	agoMin: 1,
	identity: { kind: "dmr-cc", value: String(cc) },
})

const heard = (id: string, mhz: number): FixtureSpec => ({
	id,
	mhz,
	protocol: "unknown",
	family: "unknown",
	class: "unknown",
	confidence: "activity",
	agoMin: 2,
})

/** Discoveries in the earlier windows: none in the parked view. */
export const RETUNE_SWEEP_DISCOVERY_SPECS: readonly FixtureSpec[] = [
	decodedDmr("rs-dmr-1", 438.139, 1),
	decodedDmr("rs-dmr-2", 445.95, 2),
	decodedDmr("rs-dmr-3", 446.06, 3),
	heard("rs-heard-1", 154.975),
	heard("rs-heard-2", 162.328),
	heard("rs-heard-3", 868.823),
	heard("rs-heard-4", 120.0),
	heard("rs-heard-5", 97.398),
	heard("rs-heard-6", 431.6),
]

/** The scenario's discoveries on `sourceId`, timed against `now`. */
export function retuneSweepDiscoveries(
	sourceId: string,
	now: number,
): Discovery[] {
	return bandFixtureDiscoveries(sourceId, now, RETUNE_SWEEP_DISCOVERY_SPECS)
}

/** A saved frequency far from the parked window: it may show only as an edge marker there. */
export const RETUNE_SWEEP_BOOKMARK = {
	name: "Busy band",
	frequencyHz: 399_502_000,
	mode: "nfm",
	bandwidthHz: 12_500,
	tone: { kind: "none" },
	group: "Fixtures",
} as const
