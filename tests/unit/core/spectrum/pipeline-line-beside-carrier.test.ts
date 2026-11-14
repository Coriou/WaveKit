import { describe, expect, it } from "vitest"
import {
	addInto,
	analogFm,
	gaussianNoise,
	mulberry32,
	toneComb,
} from "../../../mocks/scanner/signals.js"
import { BIN_HZ, CENTRE, FS, Harness, N } from "./pipeline-harness.js"

/**
 * A verified receiver line beside a real carrier. The line, a 9 dB-per-bin tone at bin 183
 * (182 to 184 with its Hann skirt, the persisted candidate), is confirmed under two LO centres
 * 200 bins apart, then seen at CENTRE beside a carrier 24 dB over a 12.5 kHz slot of noise
 * (35 dB in its own bin). The mask lifts only while the carrier sits on the line's footprint 182
 * to 184 with its energy confined there: a carrier at 183 or on the footprint's edge bin 184 lifts
 * it; one at 185, whose skirt bin reaches the footprint but whose peak is past it, and farther
 * keeps it, so the line never becomes a discovery of its own. Before the lift rule read the line's
 * own bins, any carrier within half a 12.5 kHz slot (bins up to 190) lifted it. A 16 kHz-wide FM
 * emission across the line keeps the mask too, and its track is one, joined across the line.
 */
const SIGMA = 0.02
/** Tone-calibrated per-bin noise power at SIGMA (pipeline-artefacts.test.ts). */
const NOISE_BIN_POWER = (SIGMA * SIGMA * 1.5) / N
const LINE_BIN = 183
const LINE_AMP = Math.sqrt(NOISE_BIN_POWER * 10 ** (9 / 10))
const CARRIER_AMP = Math.sqrt((SIGMA * SIGMA * 12_500 * 10 ** (24 / 10)) / FS)
const VISIT_EPOCH = 3
/**
 * A voice's FM band about 16 kHz wide: 4 kHz RMS deviation of 300 Hz to 3 kHz audio puts 99 % of
 * the power within about ±8 kHz (Carson: 2 · (2 · 4 kHz + 3 kHz) − headroom), 23 dB a bin.
 */
const FM_WIDE = { rmsDeviationHz: 4_000, ctcssHz: null }
const hz = (bin: number): number => (bin - N / 2) * BIN_HZ

interface Visit {
	/** The SpurMap mask at the visit's last block, RF ranges. */
	spurs: readonly { startHz: number; endHz: number }[]
	tracks: readonly { centreHz: number; obwHz: number; spur: boolean }[]
}

/** On air at the visit beside the line: a carrier at a bin, or an FM emission centred at one. */
type Air = number | null | { fmBin: number }

function visit(carrierBin: Air): Visit {
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
	const air = (tonesHz: number[], amps: number[]): void => {
		const iq = gaussianNoise(rng, FS, SIGMA)
		h.push(addInto(iq, toneComb(FS, FS, tonesHz, amps, h.sample)), 8192)
	}
	h.start({ centreHz: CENTRE - 100_000, inWindow: false })
	air([hz(LINE_BIN)], [LINE_AMP])
	h.pending({ epoch: 2, centreHz: CENTRE + 100_000, staleMaxMs: 0 })
	air([hz(LINE_BIN)], [LINE_AMP])
	h.pending({ epoch: VISIT_EPOCH, centreHz: CENTRE, staleMaxMs: 0 })
	if (carrierBin === null) air([hz(LINE_BIN)], [LINE_AMP])
	else if (typeof carrierBin === "number")
		air([hz(LINE_BIN), hz(carrierBin)], [LINE_AMP, CARRIER_AMP])
	else {
		const iq = gaussianNoise(rng, FS, SIGMA)
		addInto(iq, toneComb(FS, FS, [hz(LINE_BIN)], [LINE_AMP], h.sample))
		addInto(
			iq,
			analogFm(rng, FS, FS, hz(carrierBin.fmBin), CARRIER_AMP, FM_WIDE),
		)
		h.push(iq, 8192)
	}
	const last = new Map(
		h
			.tracks()
			.filter(t => t.epoch === VISIT_EPOCH)
			.map(t => [t.trackId, t]),
	)
	return {
		spurs: h.pipeline.artefactMasks().spurs,
		tracks: [...last.values()].map(t => ({
			centreHz: t.centreHz - CENTRE,
			obwHz: t.obwHz,
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

/** No track but a spur one within 1.5 bins of the line: the line is no discovery. */
function noLineDiscovery(v: Visit): void {
	const atLine = v.tracks.filter(
		t => Math.abs(t.centreHz - hz(LINE_BIN)) <= 1.5 * BIN_HZ,
	)
	expect(atLine.filter(t => !t.spur)).toEqual([])
}

describe("a verified spur mask beside a carrier", () => {
	it("masks the line with nothing else on air", () => {
		const v = visit(null)
		expect(v.spurs).toEqual(LINE_MASK)
		expect(v.tracks).toEqual([
			expect.objectContaining({ spur: true, obwHz: 3 * BIN_HZ }),
		])
	}, 60_000)

	it("lifts while the carrier sits on the line, up to its footprint's edge bin (the bound)", () => {
		for (const bin of [LINE_BIN, LINE_BIN + 1]) {
			const v = visit(bin)
			expect(v.spurs, `carrier at bin ${bin}`).toEqual([])
			expect(v.tracks.some(t => !t.spur)).toBe(true)
		}
	}, 120_000)

	it("keeps the mask for a carrier whose peak is past the footprint (past the bound), with no line discovery", () => {
		for (const bin of [LINE_BIN + 2, LINE_BIN + 3, LINE_BIN + 4]) {
			const v = visit(bin)
			expect(v.spurs, `carrier at bin ${bin}`).toEqual(LINE_MASK)
			noLineDiscovery(v)
			// the carrier is its own track at its own bin, not merged with the line; at 185 the mask
			// hides its −6 dB skirt bin 184, which pulls its centroid up by under a quarter bin
			const real = v.tracks.filter(t => !t.spur)
			expect(real, `carrier at bin ${bin}`).toEqual([
				{ centreHz: expect.any(Number), obwHz: 3 * BIN_HZ, spur: false },
			])
			expect(Math.abs(real[0]!.centreHz - hz(bin))).toBeLessThan(BIN_HZ / 4)
		}
	}, 120_000)

	it("keeps the mask and the line's own spur track for a carrier within half a slot (bins 189, 190) and past it", () => {
		for (const bin of [LINE_BIN + 6, LINE_BIN + 7, LINE_BIN + 13]) {
			const v = visit(bin)
			expect(v.spurs, `carrier at bin ${bin}`).toEqual(LINE_MASK)
			noLineDiscovery(v)
			expect(
				v.tracks.some(
					t => t.spur && Math.abs(t.centreHz - hz(LINE_BIN)) <= BIN_HZ,
				),
			).toBe(true)
		}
	}, 120_000)

	it("keeps the mask under a 16 kHz-wide FM emission across the line, its track whole", () => {
		for (const fmBin of [LINE_BIN, LINE_BIN + 4, LINE_BIN - 5]) {
			const v = visit({ fmBin })
			expect(v.spurs, `FM at bin ${fmBin}`).toEqual(LINE_MASK)
			const fm = v.tracks.filter(
				t => !t.spur && Math.abs(t.centreHz - hz(fmBin)) <= 10 * BIN_HZ,
			)
			expect(fm, `FM at bin ${fmBin}`).toEqual([
				expect.objectContaining({ obwHz: expect.any(Number) }),
			])
			expect(fm[0]!.obwHz).toBeGreaterThanOrEqual(12 * BIN_HZ)
		}
	}, 180_000)
})
