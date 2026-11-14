import { describe, expect, it } from "vitest"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	toneComb,
} from "../../../mocks/scanner/signals.js"
import { BIN_HZ, CENTRE, FS, Harness, N } from "./pipeline-harness.js"

/**
 * A short burst beside a held, verified receiver line. The line, a 9 dB-per-bin tone at bin 183
 * (182 to 184 with its Hann skirt, the persisted candidate), is confirmed under two LO centres
 * 200 bins apart, then held at CENTRE: the pipeline drops what lies wholly on its footprint and
 * one bin of skirt either side (181 to 185, `lineMask`). The short (burst) detector masks only the
 * footprint, so a burst whose peak falls on the skirt bin 185 (a voice's wandering skirt, an 8 ms
 * tone at bin 184.6 here) is a one-bin short-path piece there. Before bursts were held to the
 * line rule that piece opened a track of its own, which the spur flag then marked. A burst
 * three bins past the skirt, at bin 188, is no line: it opens its track.
 */
const SIGMA = 0.02
/** Tone-calibrated per-bin noise power at SIGMA (pipeline-artefacts.test.ts). */
const NOISE_BIN_POWER = (SIGMA * SIGMA * 1.5) / N
const LINE_BIN = 183
const LINE_AMP = Math.sqrt(NOISE_BIN_POWER * 10 ** (9 / 10))
const VISIT_EPOCH = 3
const VISIT_S = 4
/**
 * One burst every 0.5 s, 8 over the visit (80 blocks), 8 ms each: under BURST_MAX_ON_MS (15 ms),
 * so the short path reads it as a burst; 0.21 s into each half second, inside one 50 ms block.
 */
const BURST_MS = 8
const BURSTS = 8
const hz = (bin: number): number => (bin - N / 2) * BIN_HZ

interface Visit {
	spurs: readonly { startHz: number; endHz: number }[]
	/** Each visit track's last snapshot: its centre in bins, blocks on, spur flag. */
	tracks: readonly { bin: number; blocks: number; spur: boolean }[]
}

/** The visit: the held line, and a burst tone at `burstBin`, `burstDb` per bin over the noise. */
function visit(burstBin: number, burstDb: number): Visit {
	const h = new Harness({
		format: "FLOAT32LE",
		integrationMs: 50,
		persistedEngine: {
			version: 1,
			absoluteFloors: [],
			kByRange: [],
			spurs: [
				{
					key: `${FS}:m:496:${N}`,
					basebandBin: LINE_BIN - 1,
					widthBins: 3,
					kind: "baseband",
				},
			],
		},
	})
	const rng = mulberry32(7)
	const line = (): void => {
		const iq = gaussianNoise(rng, FS, SIGMA)
		h.push(
			addInto(iq, toneComb(FS, FS, [hz(LINE_BIN)], [LINE_AMP], h.sample)),
			8192,
		)
	}
	h.start({ centreHz: CENTRE - 100_000, inWindow: false })
	line()
	h.pending({ epoch: 2, centreHz: CENTRE + 100_000, staleMaxMs: 0 })
	line()
	h.pending({ epoch: VISIT_EPOCH, centreHz: CENTRE, staleMaxMs: 0 })
	const n = VISIT_S * FS
	const iq = gaussianNoise(rng, n, SIGMA)
	addInto(iq, toneComb(n, FS, [hz(LINE_BIN)], [LINE_AMP], h.sample))
	const len = Math.round((BURST_MS / 1000) * FS)
	const amp = Math.sqrt(NOISE_BIN_POWER * 10 ** (burstDb / 10))
	for (let k = 0; k < BURSTS; k++) {
		const at = Math.round((k * 0.5 + 0.21) * FS)
		const b = toneComb(len, FS, [hz(burstBin)], [amp], h.sample + at)
		for (let i = 0; i < len; i++) {
			iq.re[at + i] = iq.re[at + i]! + b.re[i]!
			iq.im[at + i] = iq.im[at + i]! + b.im[i]!
		}
	}
	h.push(iq, 8192)
	const last = new Map(
		h
			.tracks()
			.filter(t => t.epoch === VISIT_EPOCH)
			.map(t => [t.trackId, t]),
	)
	return {
		spurs: h.pipeline.artefactMasks().spurs,
		tracks: [...last.values()].map(t => ({
			bin: (t.centreHz - CENTRE) / BIN_HZ + N / 2,
			blocks: t.blocks,
			spur: t.flags.spur,
		})),
	}
}

/** The line's footprint, bins 182 to 184, as the mask lists it. */
const LINE_MASK = [
	{
		startHz: CENTRE + hz(LINE_BIN - 1) - BIN_HZ / 2,
		endHz: CENTRE + hz(LINE_BIN + 2) - BIN_HZ / 2,
		origin: "baseband",
	},
]

describe("a short burst beside a held spur mask", () => {
	it.each([12, 16])(
		"a %d dB burst peaking on the line's skirt bin opens no track over 80 blocks",
		burstDb => {
			const v = visit(LINE_BIN + 1.6, burstDb)
			expect(v.spurs).toEqual(LINE_MASK)
			// Past the footprint's last bin (184): nothing, spur or not, opened there.
			expect(v.tracks.filter(t => t.bin > LINE_BIN + 1.5)).toEqual([])
		},
		60_000,
	)

	it.each([12, 16])(
		"a %d dB burst three bins past the line's skirt opens its own real track",
		burstDb => {
			const v = visit(LINE_BIN + 5, burstDb)
			expect(v.spurs).toEqual(LINE_MASK)
			const own = v.tracks.filter(t => Math.abs(t.bin - (LINE_BIN + 5)) < 0.5)
			expect(own).toHaveLength(1)
			expect(own[0]!.spur).toBe(false)
			// Snapshots come at blocks 1, 2, 5 and 20: one track over the 8 one-block bursts reaches 5.
			expect(own[0]!.blocks).toBeGreaterThanOrEqual(5)
		},
		60_000,
	)
})
