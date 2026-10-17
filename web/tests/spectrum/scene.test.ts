import { describe, expect, it } from "vitest"
import { DEFAULT_LAYOUT, type RowAxis } from "../../src/spectrum/protocol.ts"
import { SpectrumScene } from "../../src/spectrum/scene.ts"
import { FakeRenderer } from "./fakes.ts"

const axis: RowAxis = {
	sourceId: "rtl",
	epoch: 1,
	profile: "25:2048",
	binHz: 1000,
	startHz: 1e8,
	binCount: 4,
}

function setup(peakHold = false) {
	const renderer = new FakeRenderer()
	let invalidations = 0
	let now = 0
	const scene = new SpectrumScene(renderer, {
		depth: 3,
		texWidth: 8,
		layout: { ...DEFAULT_LAYOUT, peakHold, splitRatio: 0.25 },
		levels: { minDb: -120, maxDb: -20 },
		size: { widthCss: 100, heightCss: 200, dpr: 2 },
		invalidate: () => invalidations++,
		now: () => now,
	})
	return {
		renderer,
		scene,
		invalidations: () => invalidations,
		tick: (ms: number) => (now += ms),
	}
}

describe("SpectrumScene", () => {
	it("sizes the drawing buffer in device px", () => {
		expect(setup().renderer.size).toEqual([200, 400])
	})

	it("uploads each row once into the next ring slot and points `newest` at it", () => {
		const { renderer, scene } = setup()
		for (let i = 0; i < 4; i++)
			scene.addRow(axis, Uint8Array.from([i, 0, 0, 0]), 4)
		expect(renderer.rows.map(r => r.index)).toEqual([0, 1, 2, 0])
		const p = scene.drawParams()
		expect(p.newest).toBe(0)
		expect(p.filled).toBe(3)
		expect(p.tracePx).toBe(100)
		expect(p.rows).toBe(3)
		expect(p.map.limit).toBe(4 / 8)
	})

	it("restarts the ring when the axis changes", () => {
		const { scene } = setup()
		scene.addRow(axis, new Uint8Array(4), 4)
		scene.addRow(axis, new Uint8Array(4), 4)
		expect(scene.addRow({ ...axis, startHz: 2e8 }, new Uint8Array(4), 4)).toBe(
			"axis",
		)
		expect(scene.drawParams().filled).toBe(1)
		expect(scene.drawParams().newest).toBe(0)
	})

	it("view and level changes only invalidate (no row re-upload)", () => {
		const { renderer, scene, invalidations } = setup()
		scene.addRow(axis, new Uint8Array(4), 4)
		const before = invalidations()
		scene.setView({ startHz: 1e8 + 1000, endHz: 1e8 + 3000 })
		scene.setLevels({ minDb: -100, maxDb: -40 })
		expect(invalidations()).toBe(before + 2)
		expect(renderer.rows.length).toBe(1)
		const m = scene.drawParams().map
		expect(m.offset).toBeCloseTo(1 / 8, 12)
		expect(m.scale).toBeCloseTo(2 / 8, 12)
	})

	it("peak hold decays by peakDecayDbPerSec over the real interval", () => {
		const { renderer, scene, tick } = setup(true)
		scene.addRow(axis, Uint8Array.from([100, 100, 100, 100]), 4)
		tick(1000)
		scene.addRow(axis, Uint8Array.from([0, 0, 0, 0]), 4)
		// 3 dB/s → 6 bytes after one second.
		expect(renderer.peaks.at(-1)).toEqual([94, 94, 94, 94])
	})

	it("draws the trace from a smoothed row (0.35 of each new row)", () => {
		const { renderer, scene } = setup()
		scene.addRow(axis, Uint8Array.from([100, 100, 100, 100]), 4)
		expect(renderer.traces.at(-1)).toEqual([100, 100, 100, 100])
		scene.addRow(axis, Uint8Array.from([0, 200, 100, 100]), 4)
		expect(renderer.traces.at(-1)).toEqual([65, 135, 100, 100])
		// A new axis starts the average over.
		scene.addRow({ ...axis, startHz: 2e8 }, Uint8Array.from([7, 7, 7, 7]), 4)
		expect(renderer.traces.at(-1)).toEqual([7, 7, 7, 7])
	})
})
