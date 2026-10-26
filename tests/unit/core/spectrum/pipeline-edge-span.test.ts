import { describe, expect, it } from "vitest"
import type { ChannelPlan } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ObservationInput } from "../../../../src/core/scanner/types.js"
import {
	DETECTION_USABLE_FRACTION,
	USABLE_FRACTION,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { counterIds } from "../../../mocks/scanner/observations.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	ookBursts,
	tone,
	type Iq,
} from "../../../mocks/scanner/signals.js"
import { BLOCK, CENTRE, FS, Harness } from "./pipeline-harness.js"

// Tracks between 0.8 and 0.95 of Nyquist: seen, flagged `edge`, held to the same gate.

const NYQ = FS / 2
const SIGMA = 0.001
const OOK_AT = Math.round(0.93 * NYQ) // 119 040 Hz at 256 kS/s
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0)

function harness(usableFraction = DETECTION_USABLE_FRACTION): Harness {
	return new Harness({
		format: "FLOAT32LE",
		usableFraction,
		edgeFraction: USABLE_FRACTION,
	})
}

function noise(seed: number, n: number): Iq {
	return gaussianNoise(mulberry32(seed), n, SIGMA)
}

const near = (tracks: TrackSnapshot[], hz: number, tol = 3_000) =>
	tracks.filter(t => Math.abs(t.centreHz - (CENTRE + hz)) <= tol)

/** One slot of `widthHz` centred on `offsetHz`, burst or not. */
function planAt(
	offsetHz: number,
	widthHz: number,
	burst: boolean,
): ChannelPlan {
	return {
		sourceId: "s1",
		defaultWidthHz: widthHz,
		entries: [
			{
				startHz: CENTRE - NYQ,
				endHz: CENTRE + NYQ,
				widthHz,
				rasterHz: 2 * NYQ,
				firstChannelHz: CENTRE + offsetHz,
				burst,
				rangeKey: burst ? "ism" : "nfm",
			},
		],
	}
}

/** The last snapshot of each track, as the scanner ingests it at close. */
function lastOfEach(tracks: TrackSnapshot[]): TrackSnapshot[] {
	const last = new Map<string, TrackSnapshot>()
	for (const t of tracks) last.set(t.trackId, t)
	return [...last.values()]
}

function observation(track: TrackSnapshot, i: number): ObservationInput {
	return {
		id: `o${i}`,
		sourceId: "s1",
		jobIds: ["job-1"],
		track,
		classification: {
			class: "ook-burst",
			hypotheses: [],
			tier: "spectral",
		},
		startedAt: T0 + i,
		endedAt: T0 + i + 200,
		endReason: "quiet",
		singleBlockSurfacingAllowed: false,
	}
}

describe("detection span past the usable span", () => {
	it("an OOK burst at 0.93 of Nyquist passes the burst gate and becomes one discovery, flagged edge", () => {
		const h = harness()
		h.start()
		h.send({ kind: "channel-plan", plan: planAt(OOK_AT, 25_000, true) })
		h.push(noise(1, 12 * BLOCK))
		const n = Math.round(0.15 * FS)
		const burst = addInto(
			noise(2, n),
			ookBursts(mulberry32(3), n, FS, OOK_AT, 0.05, {
				bursts: [{ startMs: 0, durationMs: 150 }],
			}),
		)
		h.push(burst)
		h.push(noise(4, 20 * BLOCK))
		const at = near(h.tracks(), OOK_AT)
		expect(at.length).toBeGreaterThan(0)
		expect(at.every(t => t.flags.edge && !t.flags.iqImage)).toBe(true)
		expect(at.some(t => t.gate === "passed")).toBe(true)

		const store = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => T0,
			newId: counterIds(),
		})
		lastOfEach(at)
			.filter(t => t.gate === "passed")
			.forEach((t, i) => store.ingest(observation(t, i)))
		const snap = store.snapshot()
		expect(snap.discoveries).toHaveLength(1)
		expect(snap.discoveries[0]!.class).toBe("unknown")
		expect(snap.discoveries[0]!.confidence).toBe("activity")
		expect(snap.observations.length).toBeGreaterThan(0)
		expect(snap.observations.every(o => o.flags.edge)).toBe(true)
	})

	it("the same burst stays invisible with the old 0.8 detection span", () => {
		const h = harness(USABLE_FRACTION)
		h.start()
		h.push(noise(1, 12 * BLOCK))
		const n = Math.round(0.15 * FS)
		h.push(
			addInto(
				noise(2, n),
				ookBursts(mulberry32(3), n, FS, OOK_AT, 0.05, {
					bursts: [{ startMs: 0, durationMs: 150 }],
				}),
			),
		)
		h.push(noise(4, 20 * BLOCK))
		expect(near(h.tracks(), OOK_AT)).toHaveLength(0)
	})

	it("bounds: a tone inside 0.8 is not edge, inside 0.95 is edge, past 0.95 is not seen", () => {
		const n = 12 * BLOCK
		const run = (hz: number) => {
			const h = harness()
			h.start()
			h.push(addInto(noise(9, n), tone(n, FS, hz, 0.01)))
			return near(h.tracks(), hz, 2_000)
		}
		// The exact bin bounds are pinned in segmenter-edge-band.test.ts; here whole tones.
		const inner = run(-0.7 * NYQ)
		expect(inner.length).toBeGreaterThan(0)
		expect(inner.every(t => !t.flags.edge)).toBe(true)
		for (const hz of [0.85 * NYQ, -0.9 * NYQ, 0.94 * NYQ]) {
			const t = run(hz)
			expect(t.length, `${hz}`).toBeGreaterThan(0)
			expect(
				t.every(x => x.flags.edge),
				`${hz}`,
			).toBe(true)
		}
		expect(run(0.99 * NYQ)).toHaveLength(0)
		expect(run(-0.99 * NYQ)).toHaveLength(0)
	})

	it("an image of a strong signal near the opposite edge stays flagged and never becomes a discovery", () => {
		const n = 12 * BLOCK
		for (const x of [-0.9 * NYQ, 0.92 * NYQ]) {
			const h = harness()
			h.start()
			h.send({ kind: "channel-plan", plan: planAt(-x, 25_000, true) })
			const strong = tone(n, FS, x, 0.5)
			const g = 10 ** (-30 / 20)
			const image: Iq = {
				re: strong.re.map(v => v * g),
				im: strong.im.map(v => -v * g),
			}
			h.push(addInto(addInto(noise(11, n), strong), image))
			const images = near(h.tracks(), -x, 1_500)
			expect(images.length, `${x}`).toBeGreaterThan(0)
			expect(
				images.every(t => t.flags.iqImage && t.flags.edge),
				`${x}`,
			).toBe(true)
			expect(near(h.tracks(), x, 1_500).every(t => !t.flags.iqImage)).toBe(true)
			// The store refuses every image snapshot, gated or not: no record.
			const store = new DiscoveryStore({
				maxDiscoveries: 100,
				now: () => T0,
				newId: counterIds(),
			})
			lastOfEach(images).forEach((t, i) => store.ingest(observation(t, i)))
			expect(store.snapshot().discoveries, `${x}`).toHaveLength(0)
		}
	})

	it("a weak, short edge track does not pass the gate", () => {
		const hz = Math.round(0.9 * NYQ)
		const h = harness()
		h.start()
		h.send({ kind: "channel-plan", plan: planAt(hz, 12_500, false) })
		h.push(noise(21, 12 * BLOCK))
		const n = Math.round(0.15 * FS)
		// About 7 dB over the floor in one bin: seen, but short of the 300 ms run.
		h.push(addInto(noise(22, n), tone(n, FS, hz, 0.0045)))
		h.push(noise(23, 20 * BLOCK))
		const at = near(h.tracks(), hz)
		expect(at.length).toBeGreaterThan(0)
		expect(at.every(t => t.flags.edge)).toBe(true)
		expect(at.some(t => t.gate === "passed")).toBe(false)
	})
})
