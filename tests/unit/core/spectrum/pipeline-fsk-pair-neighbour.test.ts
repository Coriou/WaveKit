import { describe, expect, it } from "vitest"
import type { ChannelPlan } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
	type Iq,
} from "../../../mocks/scanner/signals.js"
import { BLOCK, CENTRE, FS, Harness } from "./pipeline-harness.js"

// FSK pair fusion must not swallow another emitter: a weak carrier between the two tones of a
// pair (keying up with it, or later inside its established span) keeps its own track and passes
// the gate on its own. Synthetic tones only.

const NYQ = FS / 2
const SIGMA = 0.001
/** Two equal tones 60 kHz apart (inside the 150 kHz ISM pair reach), channel SNR about 34 dB. */
const LEFT = -50_000
const RIGHT = 10_000
const PAIR_AMP = 0.006
/** 15.6 dB under the pair (past `FSK_PAIR_DB`); alone it passes the gate at about 20 dB. */
const WEAK = -20_000
const WEAK_AMP = 0.001

/** One raster-less burst range over the whole span: pairing reach 150 kHz. */
const PLAN: ChannelPlan = {
	sourceId: "s1",
	defaultWidthHz: 25_000,
	entries: [
		{
			startHz: CENTRE - NYQ,
			endHz: CENTRE + NYQ,
			widthHz: 25_000,
			rasterHz: null,
			firstChannelHz: null,
			burst: true,
			rangeKey: "ism",
		},
	],
}

function noise(seed: number, n: number): Iq {
	return gaussianNoise(mulberry32(seed), n, SIGMA)
}

function scene(seed: number, blocks: number, weak: boolean): Iq {
	const n = blocks * BLOCK
	const iq = noise(seed, n)
	addInto(iq, tone(n, FS, LEFT, PAIR_AMP))
	addInto(iq, tone(n, FS, RIGHT, PAIR_AMP))
	if (weak) addInto(iq, tone(n, FS, WEAK, WEAK_AMP))
	return iq
}

function run(push: (h: Harness) => void): TrackSnapshot[] {
	const h = new Harness({ format: "FLOAT32LE" })
	h.start()
	h.send({ kind: "channel-plan", plan: PLAN })
	h.push(noise(1, 12 * BLOCK))
	push(h)
	h.push(noise(9, 20 * BLOCK))
	return h.tracks()
}

const ids = (tracks: TrackSnapshot[]): Set<string> =>
	new Set(tracks.map(t => t.trackId))

/** Tracks centred within 2 kHz of `hz` and no wider than 5 kHz: the weak carrier's own. */
const narrowAt = (tracks: TrackSnapshot[], hz: number): TrackSnapshot[] =>
	tracks.filter(
		t => Math.abs(t.centreHz - (CENTRE + hz)) <= 2_000 && t.obwHz <= 5_000,
	)

describe("FSK pair fusion beside a weak carrier (pipeline)", () => {
	it("a weak carrier keying up between the two tones is its own track and passes the gate", () => {
		const tracks = run(h => h.push(scene(2, 10, true)))
		const weak = narrowAt(tracks, WEAK)
		expect(ids(weak).size).toBe(1)
		expect(weak.some(t => t.gate === "passed")).toBe(true)
		// the pair is still one track spanning both tones
		const pair = tracks.filter(t => t.obwHz >= RIGHT - LEFT)
		expect(ids(pair).size).toBe(1)
	})

	it("a weak carrier appearing inside an established pair's span is its own track and passes the gate", () => {
		const tracks = run(h => {
			h.push(scene(3, 6, false))
			h.push(scene(4, 10, true))
		})
		const weak = narrowAt(tracks, WEAK)
		expect(ids(weak).size).toBe(1)
		expect(weak.some(t => t.gate === "passed")).toBe(true)
		const pair = tracks.filter(t => t.obwHz >= RIGHT - LEFT)
		expect(ids(pair).size).toBe(1)
	})
})
