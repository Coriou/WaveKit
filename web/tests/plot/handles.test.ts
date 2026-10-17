import { describe, expect, it } from "vitest"
import {
	EDGE_GRAB_MIN_PX,
	SQUELCH_MIN_PX,
	type HandleInput,
	bandwidthAtHz,
	clampBandwidth,
	clampSquelch,
	handleGeometry,
	handleKey,
	hitTest,
	nudgeBandwidth,
	nudgeSquelch,
	squelchAtY,
	traceYToDb,
	vfoDragHz,
} from "../../src/plot/handles.ts"
import { dbToTraceY } from "../../src/plot/maths.ts"

const NFM = [5000, 25_000, 500, 12_500] as const
const levels = { minDb: -110, maxDb: -10 }

// 1000 px over 200 kHz: 200 Hz per px; a 12.5 kHz band is 62.5 px wide.
const base: HandleInput = {
	view: { startHz: 161_000_000, endHz: 161_200_000 },
	widthPx: 1000,
	traceCss: 200,
	levels,
	vfoHz: 161_100_000,
	bandwidthHz: 12_500,
	edgesAllowed: true,
	vfoAllowed: true,
	squelchDbfs: -60,
}

function seeded(seed: number): () => number {
	let s = seed >>> 0 || 1
	return () => {
		s ^= s << 13
		s ^= s >>> 17
		s ^= s << 5
		return (s >>> 0) / 0x1_0000_0000
	}
}

describe("handleGeometry", () => {
	it("places the passband, its edges and the squelch line", () => {
		const g = handleGeometry(base)
		expect(g.vfo).toEqual({ left: 468.75, right: 531.25, centre: 500 })
		expect(g.edges).toBe(true)
		expect(g.squelch?.y).toBeCloseTo(dbToTraceY(-60, levels, 200), 9)
		// narrower than 180 px: the line keeps its minimum width, centred on the VFO
		expect(g.squelch?.left).toBe(500 - SQUELCH_MIN_PX / 2)
		expect(g.squelch?.right).toBe(500 + SQUELCH_MIN_PX / 2)
	})

	it("offers the edges only once the band is wide enough to grab", () => {
		// full span 2.4 MHz: 12.5 kHz is 5.2 px
		const wide = { startHz: 160_300_000, endHz: 162_700_000 }
		expect(handleGeometry({ ...base, view: wide }).edges).toBe(false)
		// exactly at the threshold
		const span = (12_500 / EDGE_GRAB_MIN_PX) * 1000
		const at = {
			startHz: 161_100_000 - span / 2,
			endHz: 161_100_000 + span / 2,
		}
		expect(handleGeometry({ ...base, view: at }).edges).toBe(true)
		expect(handleGeometry({ ...base, edgesAllowed: false }).edges).toBe(false)
	})

	it("keeps a thin passband at least 7 px wide", () => {
		const wide = { startHz: 160_300_000, endHz: 162_700_000 }
		const g = handleGeometry({ ...base, view: wide })
		expect(g.vfo && g.vfo.right - g.vfo.left).toBe(7)
	})

	it("hides everything without a VFO, and the squelch line with the VFO off screen or squelch off", () => {
		expect(handleGeometry({ ...base, vfoHz: null })).toEqual({
			vfo: null,
			edges: false,
			squelch: null,
		})
		const off = handleGeometry({ ...base, vfoHz: 161_300_000 })
		expect(off.vfo).toBeNull()
		expect(off.squelch).toBeNull()
		expect(handleGeometry({ ...base, squelchDbfs: null }).squelch).toBeNull()
		// half the band still on screen: the passband shows, the line (VFO itself off screen) does not
		const edge = handleGeometry({ ...base, vfoHz: 161_200_000 + 6000 })
		expect(edge.vfo).not.toBeNull()
		expect(edge.squelch).toBeNull()
	})
})

describe("hitTest", () => {
	const g = handleGeometry(base)
	const opts = { traceCss: 200, vfoAllowed: true }
	const sqY = g.squelch?.y ?? 0

	it("finds the edges, the passband and the squelch line", () => {
		expect(hitTest(g, 468, 150, opts)).toBe("edge-left")
		expect(hitTest(g, 535, 150, opts)).toBe("edge-right")
		expect(hitTest(g, 500, 150, opts)).toBe("vfo")
		// the passband runs down through the waterfall
		expect(hitTest(g, 500, 600, opts)).toBe("vfo")
		expect(hitTest(g, 420, sqY + 4, opts)).toBe("squelch")
		expect(hitTest(g, 300, 150, opts)).toBeNull()
		// beyond the line's extent
		expect(hitTest(g, 380, sqY, opts)).toBeNull()
	})

	it("gives the squelch line priority where it crosses the band", () => {
		expect(hitTest(g, 469, sqY, opts)).toBe("squelch")
		expect(hitTest(g, 500, sqY - 5, opts)).toBe("squelch")
		expect(hitTest(g, 500, sqY - 6, opts)).toBe("vfo")
	})

	it("widens the zones for touch", () => {
		expect(hitTest(g, 461, 150, opts)).toBeNull()
		expect(hitTest(g, 461, 150, { ...opts, touch: true })).toBe("edge-left")
		expect(hitTest(g, 300, sqY + 9, { ...opts, touch: true })).toBeNull()
		expect(hitTest(g, 420, sqY + 9, { ...opts, touch: true })).toBe("squelch")
	})

	it("leaves the passband to pan and click when the VFO cannot be dragged (read-only)", () => {
		expect(hitTest(g, 500, 150, { ...opts, vfoAllowed: false })).toBeNull()
	})

	it("ignores the squelch line's y below the trace", () => {
		const low = handleGeometry({ ...base, squelchDbfs: -200 })
		const y = low.squelch?.y ?? 0
		expect(hitTest(low, 420, y, { traceCss: y - 1, vfoAllowed: true })).toBe(
			null,
		)
	})

	it("keeps the middle of the narrowest grabbable band for the VFO", () => {
		// 24 px band: edges at 488 and 512, ±5 px each, the middle 14 px drags the VFO
		const span = (12_500 / 24) * 1000
		const narrow = handleGeometry({
			...base,
			view: { startHz: 161_100_000 - span / 2, endHz: 161_100_000 + span / 2 },
		})
		expect(narrow.edges).toBe(true)
		expect(hitTest(narrow, 492, 150, opts)).toBe("edge-left")
		expect(hitTest(narrow, 508, 150, opts)).toBe("edge-right")
		expect(hitTest(narrow, 494, 150, opts)).toBe("vfo")
		expect(hitTest(narrow, 506, 150, opts)).toBe("vfo")
	})

	it("gives touch wider edge zones on a narrow band, still leaving its middle", () => {
		const span = (12_500 / 24) * 1000
		const narrow = handleGeometry({
			...base,
			view: { startHz: 161_100_000 - span / 2, endHz: 161_100_000 + span / 2 },
		})
		const touch = { ...opts, touch: true }
		expect(hitTest(narrow, 497, 150, touch)).toBe("edge-left")
		expect(hitTest(narrow, 503, 150, touch)).toBe("edge-right")
		expect(hitTest(narrow, 500, 150, touch)).toBe("vfo")
	})
})

describe("squelch y ↔ dB", () => {
	it("traceYToDb inverts dbToTraceY inside the levels (300 seeded runs)", () => {
		const rand = seeded(7)
		for (let i = 0; i < 300; i++) {
			const minDb = -140 + rand() * 60
			const lv = { minDb, maxDb: minDb + 20 + rand() * 100 }
			const traceCss = 72 + rand() * 228
			const db = lv.minDb + rand() * (lv.maxDb - lv.minDb)
			expect(
				traceYToDb(dbToTraceY(db, lv, traceCss), lv, traceCss),
			).toBeCloseTo(db, 6)
		}
	})

	it("clamps outside the trace and the Listen island's range", () => {
		expect(traceYToDb(-50, levels, 200)).toBe(-10)
		expect(traceYToDb(500, levels, 200)).toBe(-110)
		expect(squelchAtY(0, levels, 200)).toBe(-20)
		expect(squelchAtY(dbToTraceY(-73.4, levels, 200), levels, 200)).toBe(-73)
		expect(clampSquelch(-150)).toBe(-120)
		expect(clampSquelch(-5)).toBe(-20)
	})

	it("nudges by 1 dB, or 5 with PageUp/PageDown", () => {
		expect(nudgeSquelch(-60, 1)).toBe(-59)
		expect(nudgeSquelch(-60, -1, true)).toBe(-65)
		expect(nudgeSquelch(-21, 1, true)).toBe(-20)
		// an Auto threshold of −63.5 lands on whole dB
		expect(nudgeSquelch(-63.5, 1)).toBe(-62)
	})
})

describe("bandwidth from an edge", () => {
	it("is twice the distance to the VFO, on the mode's step and inside its limits", () => {
		expect(bandwidthAtHz(161_108_000, 161_100_000, NFM)).toBe(16_000)
		expect(bandwidthAtHz(161_092_000, 161_100_000, NFM)).toBe(16_000)
		expect(bandwidthAtHz(161_106_130, 161_100_000, NFM)).toBe(12_500)
		expect(bandwidthAtHz(161_100_100, 161_100_000, NFM)).toBe(5000)
		expect(bandwidthAtHz(161_200_000, 161_100_000, NFM)).toBe(25_000)
	})

	it("stays inside the limits for any pointer (300 seeded runs)", () => {
		const rand = seeded(11)
		const modes = [
			NFM,
			[50_000, 250_000, 5000, 150_000],
			[100, 1000, 50, 500],
		] as const
		for (let i = 0; i < 300; i++) {
			const range = modes[i % modes.length] ?? NFM
			const bw = bandwidthAtHz(
				100_000_000 + (rand() - 0.5) * 1e6,
				100_000_000,
				range,
			)
			expect(bw).toBeGreaterThanOrEqual(range[0])
			expect(bw).toBeLessThanOrEqual(range[1])
			expect(bw % range[2]).toBe(0)
		}
	})

	it("nudges by one step, or ten", () => {
		expect(nudgeBandwidth(12_500, 1, NFM)).toBe(13_000)
		expect(nudgeBandwidth(12_500, -1, NFM, true)).toBe(7500)
		expect(nudgeBandwidth(24_800, 1, NFM)).toBe(25_000)
		expect(clampBandwidth(12_740, NFM)).toBe(12_500)
	})
})

describe("vfoDragHz", () => {
	it("moves by the dragged distance from where the drag began, on the step", () => {
		// 200 Hz per px: 50 px is 10 kHz, snapped to 12.5 kHz
		expect(vfoDragHz(161_100_000, 50, 1000, 200_000, 12_500)).toBe(161_112_500)
		expect(vfoDragHz(161_100_000, -125, 1000, 200_000, 12_500)).toBe(
			161_075_000,
		)
		expect(vfoDragHz(161_100_000, 0, 1000, 200_000, 12_500)).toBe(161_100_000)
	})
})

describe("handleKey", () => {
	it("maps slider keys and leaves the rest", () => {
		expect(handleKey("ArrowUp")).toEqual({ dir: 1, big: false })
		expect(handleKey("ArrowLeft")).toEqual({ dir: -1, big: false })
		expect(handleKey("PageDown")).toEqual({ dir: -1, big: true })
		expect(handleKey("Enter")).toBeNull()
	})
})
