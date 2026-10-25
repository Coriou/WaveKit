import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { bandplansFor } from "../../../../../src/core/scanner/bandplan/index.js"
import {
	narrowestPriors as priorsFor,
	withScannerOverlays,
} from "../../../../../src/core/scanner/classify/priors.js"
import {
	classOf,
	classifySpectral,
} from "../../../../../src/core/scanner/classify/classifier.js"
import type {
	ScannerProtocol,
	ScanRange,
} from "../../../../../src/core/scanner/types.js"
import { makeTrack } from "../../../../mocks/scanner/observations.js"

const MHz = (x: number): number => Math.round(x * 1e6)
const EU_RANGES: ScanRange[] = withScannerOverlays(
	bandplansFor("EU").flatMap(p => p.ranges),
)
const SPECIFIC: ScannerProtocol[] = [
	"analog-fm",
	"analog-am",
	"dmr",
	"p25p1",
	"p25p2",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
	"flex",
	"aprs",
	"ism",
]

function order(hz: number, obwHz: number, ranges: ScanRange[]): string[] {
	const track = makeTrack({
		id: "t",
		centreHz: hz,
		startedAt: 0,
		obwHz,
		blocks: 8,
	})
	return classifySpectral(track, {
		priors: priorsFor(ranges, hz),
		protocols: [],
	}).hypotheses.map(h => h.protocol)
}

describe("scanner LPD433 overlay", () => {
	it("lists analog-fm and ism on a 25 kHz raster from 433.075 to 434.775 MHz", () => {
		const lpd = EU_RANGES.find(
			r => r.startHz === MHz(433.075) && r.endHz === MHz(434.775),
		)
		expect(lpd?.protocols).toEqual(["analog-fm", "ism"])
		expect(lpd?.bandplanId).toBe("ism-433")
		const hidden = bandplansFor("EU")
			.filter(p => p.id !== "ism-433")
			.flatMap(p => p.ranges)
		expect(withScannerOverlays(hidden)).toEqual(hidden)
		expect(lpd?.rasters).toEqual([
			{ spacingHz: 25_000, firstChannelHz: MHz(433.075) },
		])
	})
})

describe("trial order inside and outside LPD433", () => {
	it("a fsk4-12k5 track at 434.4 MHz runs analog-fm before dmr despite the 70 cm range", () => {
		const track = makeTrack({
			id: "t",
			centreHz: MHz(434.4),
			startedAt: 0,
			obwHz: 9000,
			blocks: 8,
		})
		expect(classOf(track)).toBe("fsk4-12k5")
		const o = order(MHz(434.4), 9000, EU_RANGES)
		expect(o.indexOf("analog-fm")).toBeLessThan(o.indexOf("dmr"))
		expect(o[0]).toBe("analog-fm")
		const priors = priorsFor(EU_RANGES, MHz(434.4))
		expect(priors.dmr).toBe(0.25)
		expect(priors.ism).toBe(1)
	})
	it("a wideband track at 434.4 MHz ranks analog-fm first and has no dmr", () => {
		const o = order(MHz(434.4), 30_000, EU_RANGES)
		expect(o[0]).toBe("analog-fm")
		expect(o).not.toContain("dmr")
	})
	it("outside LPD433 in the 70 cm band the order is unchanged with analog-fm added", () => {
		expect(order(MHz(438.0125), 9000, EU_RANGES)).toEqual([
			"dmr",
			"ysf",
			"p25p1",
			"analog-fm",
			"nxdn96",
		])
	})
	it("dmr stays first in a range that lists dmr only", () => {
		const ranges: ScanRange[] = [
			{ startHz: MHz(434), endHz: MHz(435), protocols: ["dmr"] },
			{ startHz: MHz(430), endHz: MHz(440), protocols: ["analog-fm"] },
		]
		const o = order(MHz(434.4), 9000, ranges)
		expect(o[0]).toBe("dmr")
		expect(o.indexOf("analog-fm")).toBeGreaterThan(0)
	})
	it("ties in width go to the first range in stack order", () => {
		const a: ScanRange = {
			startHz: MHz(434),
			endHz: MHz(435),
			protocols: ["dmr"],
		}
		const b: ScanRange = {
			startHz: MHz(434),
			endHz: MHz(435),
			protocols: ["ysf"],
		}
		expect(priorsFor([a, b], MHz(434.5)).dmr).toBe(1)
		expect(priorsFor([a, b], MHz(434.5)).ysf).toBe(0.25)
		expect(priorsFor([b, a], MHz(434.5)).ysf).toBe(1)
	})
	it("a narrower range without protocols does not decide", () => {
		const ranges: ScanRange[] = [
			{ startHz: MHz(434.3), endHz: MHz(434.5) },
			{ startHz: MHz(434), endHz: MHz(435), protocols: ["dmr"] },
		]
		expect(priorsFor(ranges, MHz(434.4)).dmr).toBe(1)
	})
})

describe("priorsFor property", () => {
	const arbRange: fc.Arbitrary<ScanRange> = fc
		.record({
			start: fc.integer({ min: 0, max: 1000 }),
			width: fc.integer({ min: 0, max: 1000 }),
			protocols: fc.option(fc.subarray(SPECIFIC), { nil: undefined }),
		})
		.map(r => ({
			startHz: r.start * 1000,
			endHz: (r.start + r.width) * 1000,
			...(r.protocols !== undefined ? { protocols: r.protocols } : {}),
		}))

	// Feature: scanner-redesign, Property 18: Narrowest range orders
	// Validates: Requirements 3.12, decoder-enablement 9.1
	it("equals the priors of the narrowest covering listing range, and no prior is 0", () => {
		fc.assert(
			fc.property(
				fc.array(arbRange, { maxLength: 8 }),
				fc.integer({ min: 0, max: 2_000_000 }),
				(ranges, hz) => {
					const got = priorsFor(ranges, hz)
					let best: ScanRange | undefined
					for (const r of ranges) {
						if (hz < r.startHz || hz > r.endHz) continue
						if ((r.protocols ?? []).length === 0) continue
						if (
							best === undefined ||
							r.endHz - r.startHz < best.endHz - best.startHz
						)
							best = r
					}
					if (best === undefined) {
						expect(got).toEqual({})
						return
					}
					expect(got).toEqual(priorsFor([best], hz))
					for (const p of SPECIFIC)
						expect(got[p]).toBe(best.protocols?.includes(p) ? 1 : 0.25)
					for (const v of Object.values(got)) expect(v).toBeGreaterThan(0)
				},
			),
			{ numRuns: 200 },
		)
	})
})
