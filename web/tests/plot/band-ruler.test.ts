import { describe, expect, it } from "vitest"
import type { ResolvedBandPlanView } from "@wavekit/api-types"

import {
	RULER_LEVELS,
	clampLevel,
	followCentre,
	rulerBands,
	rulerMarks,
	rulerSpan,
	rulerTicks,
	rulerXToHz,
} from "../../src/plot/band-ruler.ts"
import { TUNER_RANGE } from "../../src/features/tuner/frequency.ts"

const CAPTURE = 1_920_000

describe("band ruler", () => {
	it("spans a few captures around the centre, up to the whole tuner range", () => {
		const near = rulerSpan(161_500_000, CAPTURE, 0)
		expect(near.endHz - near.startHz).toBe(CAPTURE * (RULER_LEVELS[0] ?? 0))
		expect((near.startHz + near.endHz) / 2).toBe(161_500_000)
		const full = rulerSpan(161_500_000, CAPTURE, RULER_LEVELS.length - 1)
		expect(full).toEqual({
			startHz: TUNER_RANGE.minHz,
			endHz: TUNER_RANGE.maxHz,
		})
		expect(clampLevel(-3)).toBe(0)
		expect(clampLevel(99)).toBe(RULER_LEVELS.length - 1)
	})

	it("stays inside the tuner range at its edges", () => {
		const low = rulerSpan(25_000_000, CAPTURE, 1)
		expect(low.startHz).toBe(TUNER_RANGE.minHz)
		const high = rulerSpan(1_899_000_000, CAPTURE, 1)
		expect(high.endHz).toBe(TUNER_RANGE.maxHz)
	})

	it("holds still while the view stays in its middle, recentres when it nears an edge", () => {
		const centre = 161_500_000
		const inside = { startHz: 162_000_000, endHz: 163_920_000 }
		expect(followCentre(centre, inside, CAPTURE, 0)).toBe(centre)
		const nearEdge = { startHz: 167_000_000, endHz: 168_920_000 }
		expect(followCentre(centre, nearEdge, CAPTURE, 0)).toBe(167_960_000)
		expect(followCentre(null, inside, CAPTURE, 0)).toBe(162_960_000)
	})

	it("maps x to Hz, clamped to the ruler", () => {
		const span = { startHz: 100e6, endHz: 200e6 }
		expect(rulerXToHz(0.25, span)).toBe(125e6)
		expect(rulerXToHz(-1, span)).toBe(100e6)
		expect(rulerXToHz(2, span)).toBe(200e6)
	})

	it("draws band segments widest first, at least a pixel wide", () => {
		const plan = {
			bands: [
				band("marine", "Marine VHF", 156e6, 162.025e6, null, "marine"),
				band("ais", "AIS", 161.95e6, 162.05e6, "marine", "marine"),
				band("far", "Far", 400e6, 410e6, null, "other"),
			],
		} as unknown as ResolvedBandPlanView
		const span = { startHz: 150e6, endHz: 170e6 }
		const out = rulerBands(plan, span, 1000)
		expect(out.map(b => b.key)).toEqual(["p/marine#0", "p/ais#0"])
		expect(out[0]?.left).toBeCloseTo(0.3, 9)
		expect(out[1]?.width).toBeCloseTo(0.005, 9)
		expect(out[1]?.depth).toBe(1)
		const tiny = rulerBands(plan, { startHz: 0, endHz: 2e9 }, 100)
		expect(tiny.every(b => b.width >= 1 / 100)).toBe(true)
	})

	it("keeps one mark per pixel column and drops marks outside", () => {
		const span = { startHz: 0, endHz: 1000 }
		const marks = rulerMarks(
			[
				{ key: "a", hz: 100, title: "a" },
				{ key: "b", hz: 100.4, title: "b" },
				{ key: "c", hz: 500, title: "c" },
				{ key: "d", hz: 2000, title: "d" },
			],
			span,
			100,
		)
		expect(marks.map(m => m.key)).toEqual(["a", "c"])
	})

	it("labels round MHz", () => {
		const ticks = rulerTicks({ startHz: 150e6, endHz: 170e6 }, 1400)
		expect(ticks.length).toBeGreaterThanOrEqual(5)
		expect(ticks.every(t => Number.isInteger(t.hz / 1e6))).toBe(true)
		expect(ticks[0]?.text).toBe(String(ticks[0]!.hz / 1e6))
	})
})

function band(
	id: string,
	name: string,
	startHz: number,
	endHz: number,
	parentId: string | null,
	group: string,
) {
	return {
		key: `p/${id}`,
		packId: "p",
		band: { id, name, startHz, endHz, parentId, group },
		segments: [{ startHz, endHz }],
	}
}
