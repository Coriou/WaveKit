/** WG11 req 1.3: nxdn48, dpmr and dstar trials on a <= 6.25 kHz raster (identify side). */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	IDENTIFY_DEFAULT_TIMEOUT_MS,
	IDENTIFY_NARROW_DIGITAL_MIN_SCORE,
	identifyScores,
	planIdentifyTrials,
} from "../../../../src/core/scanner/identify.js"
import type { ScannerProtocol } from "../../../../src/core/scanner/types.js"
import { TARGET_HZ, trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { harness } from "./identify-heard-fakes.js"

const NARROW: ScannerProtocol[] = ["nxdn48", "dpmr", "dstar"]
/** A 12.5 kHz analog-looking track (peaked, 11 kHz OBW): no narrow class by width. */
const analogTrack = () => trackOf({ obwHz: 11_000, spectralShape: "peaked" })

describe("narrow digital scores (WG11 1.3)", () => {
	it("an analog-looking track gets the three narrow modes at the 0.3 floor", () => {
		const without = identifyScores(analogTrack(), { priors: {}, protocols: [] })
		expect(without.map(h => h.protocol)).not.toEqual(
			expect.arrayContaining(["nxdn48"]),
		)
		const s = identifyScores(analogTrack(), {
			priors: {},
			protocols: [],
			narrow: true,
		})
		for (const p of NARROW)
			expect(s.find(h => h.protocol === p)?.score).toBe(
				IDENTIFY_NARROW_DIGITAL_MIN_SCORE,
			)
	})

	it("a native fsk4-6k25 track keeps its higher score", () => {
		const s = identifyScores(trackOf({ obwHz: 4000, spectralShape: "flat" }), {
			priors: {},
			protocols: [],
			narrow: true,
		})
		expect(s.find(h => h.protocol === "nxdn48")?.score).toBe(0.5)
	})

	it("an explicit protocol list excludes trials", () => {
		const s = identifyScores(analogTrack(), {
			priors: { dpmr: 0 },
			protocols: ["dmr", "nxdn48"],
			narrow: true,
		})
		expect(s.map(h => h.protocol).sort()).toEqual(["dmr", "nxdn48"])
	})

	it("plan arithmetic: every narrow run starts and ends within the 15 s default", () => {
		const s = identifyScores(analogTrack(), {
			priors: {},
			protocols: [],
			narrow: true,
		})
		const plan = planIdentifyTrials(s, { format: "U8_IQ", channelizer: false })
		expect(plan.runs.map(r => [r.protocols, r.holdMs])).toEqual([
			[["aprs"], 3000],
			[["dpmr"], 2000],
			[["dstar", "dmr", "ysf", "p25p1"], 2000],
			[["nxdn48"], 2000],
			[["pocsag", "flex"], 4000],
			[["nxdn96"], 2000],
		])
		const LATENCY = 400 // ProbePool DEFAULT_START_LATENCY_MS
		let at = 0
		const starts: number[] = []
		for (const r of plan.runs) {
			starts.push(at)
			at += r.holdMs + LATENCY
		}
		expect(starts).toEqual([0, 3400, 5800, 8200, 10_600, 15_000])
		const lastNarrowEnd = 8200 + 2000 + LATENCY
		expect(lastNarrowEnd).toBeLessThan(IDENTIFY_DEFAULT_TIMEOUT_MS)
	})
})

describe("narrow raster dep in the runner (WG11 1.3)", () => {
	async function runningAt(narrowRasterAt?: (hz: number) => boolean) {
		const asked: number[] = []
		const h = harness({
			port: null,
			request: { protocols: [] },
			...(narrowRasterAt
				? {
						narrowRasterAt: (hz: number) => {
							asked.push(hz)
							return narrowRasterAt(hz)
						},
					}
				: {}),
		})
		h.engine.push(1_100_000)
		const planned = h.clock.now + 100
		await h.start(analogTrack())
		const first = new Map<string, number>()
		for (let i = 0; i < 220 && h.record.state === "running"; i++) {
			for (const t of h.last()?.trials ?? [])
				if (t.outcome === "running" && !first.has(t.protocol))
					first.set(t.protocol, h.clock.now - planned)
			await h.advance(100)
		}
		return { h, first, asked }
	}

	it("counted runs: dpmr, dstar and nxdn48 start before 15 s after planning", async () => {
		const { first, asked } = await runningAt(() => true)
		expect(asked).toEqual([TARGET_HZ])
		for (const p of NARROW) {
			expect(first.get(p)).toBeDefined()
			expect(first.get(p)!).toBeLessThan(IDENTIFY_DEFAULT_TIMEOUT_MS)
		}
	})

	it("absent, false or throwing dep: today's plan (no narrow trial)", async () => {
		for (const dep of [
			undefined,
			() => false,
			() => {
				throw new Error("x")
			},
		]) {
			const { h } = await runningAt(dep)
			const planned = h.events.find(e => e.state === "trying")!
			expect(planned.trials.map(t => t.protocol)).not.toEqual(
				expect.arrayContaining(["dpmr"]),
			)
		}
	})

	// Feature: web-gaps-11, Property 3: Narrow modes where the raster says so
	// Validates: Requirements 1.3
	it("property: narrow modes planned iff raster, not explicitly excluded with clamped priors, scored >= 0.3 x prior", () => {
		const protocol = fc.constantFrom<ScannerProtocol>(
			"dmr",
			"nxdn48",
			"dpmr",
			"dstar",
			"pocsag",
			"aprs",
		)
		fc.assert(
			fc.property(
				fc.record({
					obwHz: fc.integer({ min: 500, max: 24_000 }),
					shape: fc.constantFrom("flat" as const, "peaked" as const),
					narrow: fc.boolean(),
					priors: fc.dictionary(protocol, fc.constantFrom(0, 0.5, 1, 2)),
					only: fc.uniqueArray(protocol, { maxLength: 4 }),
				}),
				c => {
					const track = trackOf({ obwHz: c.obwHz, spectralShape: c.shape })
					const ctx = {
						priors: c.priors as Partial<Record<ScannerProtocol, number>>,
						protocols: c.only,
					}
					const base = identifyScores(track, ctx)
					const got = identifyScores(track, { ...ctx, narrow: c.narrow })
					if (!c.narrow) {
						expect(got).toEqual(base)
						return
					}
					for (const p of NARROW) {
						const prior = Math.max(0.001, ctx.priors[p] ?? 1)
						const allowed = c.only.length === 0 || c.only.includes(p)
						const h = got.find(x => x.protocol === p)
						if (!allowed) expect(h).toBeUndefined()
						else {
							expect(h).toBeDefined()
							expect(h!.score).toBeGreaterThanOrEqual(
								Math.min(1, IDENTIFY_NARROW_DIGITAL_MIN_SCORE * prior) - 1e-12,
							)
						}
					}
					// Never a removal of another protocol.
					for (const b of base)
						expect(
							got.find(x => x.protocol === b.protocol)?.score,
						).toBeGreaterThanOrEqual(b.score)
				},
			),
			{ numRuns: 200 },
		)
	})
})
