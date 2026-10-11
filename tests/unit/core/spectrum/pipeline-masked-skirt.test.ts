import { describe, expect, it } from "vitest"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import { BIN_HZ, CENTRE, FS, Harness } from "./pipeline-harness.js"

describe("mask-separated spectral skirts", () => {
	it.each([-1, 1])(
		"keeps one emitter when a rising skirt crosses the DC mask (direction=%s)",
		direction => {
			// A measured monotone skirt has no independent local maximum. Its last
			// unmasked bin is only 49.5 dB below the parent, below the far-skirt cutoff.
			const n = Math.round(0.6 * FS)
			const iq = gaussianNoise(mulberry32(20261011), n, 1e-5)
			const levels = [
				-58, -55, -52, -49.5, -40, -32, -24, -16, -8, -3, -2, -1, 0, -1, -2, -3,
				-12, -20,
			]
			for (const [i, level] of levels.entries())
				addInto(
					iq,
					tone(
						n,
						FS,
						direction * (i - 6) * BIN_HZ,
						0.1 * 10 ** (level / 20),
						i * 2.4,
					),
				)
			const h = new Harness({ format: "FLOAT32LE" })
			h.start({ feed: false })
			h.push(iq, 8192)
			const tracks = new Map(h.tracks().map(t => [t.trackId, t]))
			expect(tracks.size).toBe(1)
			const [parent] = [...tracks.values()]
			expect(parent?.flags.skirt).toBe(true)
			expect(Math.sign((parent?.centreHz ?? CENTRE) - CENTRE)).toBe(direction)
		},
	)
})
