import { describe, expect, it } from "vitest"
import { buildResolvedBandPlan } from "../../mock/data.ts"
import {
	DEFAULT_STEP_HZ,
	FIT_VIEW,
	MIN_SPAN_HZ,
	accumulateWheel,
	dbTicks,
	dbToTraceY,
	describeTracks,
	edgeMargin,
	followHz,
	freqTicks,
	groupColour,
	holdTracks,
	keyAction,
	lanePieces,
	offsetKeeping,
	panBy,
	pinchFactor,
	placeLabels,
	resolveView,
	snapToStep,
	snapToTrack,
	stepHz,
	tuneAction,
	tuningStep,
	viewOf,
	wheelPixels,
	wheelZoomFactor,
	zoomAt,
	zoomLabel,
	type Track,
} from "../../src/plot/maths.ts"

const capture = { startHz: 160_300_000, endHz: 162_700_000 } // 2.4 MHz around 161.5
const plan = buildResolvedBandPlan()
const track = (startHz: number, endHz: number, burst = false): Track => ({
	startHz,
	endHz,
	flags: { burst, iqImage: false, edge: false },
})
const noMods = { shift: false, ctrl: false, meta: false, alt: false }

describe("view state", () => {
	it("fit shows the whole capture", () => {
		expect(resolveView(FIT_VIEW, capture)).toEqual(capture)
	})

	it("zooms around the anchor and round-trips through viewOf", () => {
		const v = zoomAt(FIT_VIEW, capture, 0.25, 4)
		const shown = resolveView(v, capture)
		expect(shown.endHz - shown.startHz).toBeCloseTo(600_000, 3)
		// The frequency under x = 0.25 stays there.
		const anchor = capture.startHz + 0.25 * 2_400_000
		expect(shown.startHz + 0.25 * (shown.endHz - shown.startHz)).toBeCloseTo(
			anchor,
			3,
		)
		expect(viewOf(shown, capture)).toEqual(v)
	})

	it("never zooms below the minimum span nor out past the capture", () => {
		const deep = resolveView(zoomAt(FIT_VIEW, capture, 0.5, 1e6), capture)
		expect(deep.endHz - deep.startHz).toBeCloseTo(MIN_SPAN_HZ, 3)
		expect(
			zoomAt(zoomAt(FIT_VIEW, capture, 0.5, 4), capture, 0.5, 0.01),
		).toEqual(FIT_VIEW)
	})

	it("is relative to the capture, so a retune keeps the zoom", () => {
		const v = zoomAt(FIT_VIEW, capture, 0.5, 2)
		const moved = { startHz: capture.startHz + 1e6, endHz: capture.endHz + 1e6 }
		const a = resolveView(v, capture)
		const b = resolveView(v, moved)
		expect(b.startHz - a.startHz).toBeCloseTo(1e6, 3)
	})

	it("pans inside the capture and reports what the edge stopped", () => {
		const v = zoomAt(FIT_VIEW, capture, 0.5, 4) // 600 kHz in the middle
		const { view, overflowHz } = panBy(v, capture, 1_000_000)
		expect(resolveView(view, capture).endHz).toBe(capture.endHz)
		expect(overflowHz).toBeCloseTo(100_000, 3)
		expect(panBy(v, capture, 100_000).overflowHz).toBeCloseTo(0, 6)
	})

	it("follows a frequency that leaves the view", () => {
		const v = zoomAt(FIT_VIEW, capture, 0.5, 8)
		expect(followHz(v, capture, 161_500_000)).toBe(v)
		const f = resolveView(followHz(v, capture, 160_500_000), capture)
		expect(160_500_000).toBeGreaterThanOrEqual(f.startHz)
		expect(160_500_000).toBeLessThanOrEqual(f.endHz)
	})

	it("zoomLabel reads Fit, one decimal under 10×, whole numbers above", () => {
		expect(zoomLabel(capture, capture)).toBe("Fit")
		expect(zoomLabel({ startHz: 0, endHz: 1_000_000 }, capture)).toBe("2.4×")
		expect(zoomLabel({ startHz: 0, endHz: 100_000 }, capture)).toBe("24×")
	})

	// Seeded random sequences (fast-check is not a web dependency): 300 runs of up to 20 operations.
	it("any zoom/pan sequence stays inside the capture and above the minimum span", () => {
		let seed = 0x9e3779b9
		const rand = () => {
			seed ^= seed << 13
			seed ^= seed >>> 17
			seed ^= seed << 5
			return (seed >>> 0) / 0x1_0000_0000
		}
		for (let run = 0; run < 300; run++) {
			let v = FIT_VIEW
			const n = Math.floor(rand() * 20)
			for (let i = 0; i < n; i++)
				v =
					rand() < 0.5
						? zoomAt(v, capture, rand(), 0.05 + rand() * 20)
						: panBy(v, capture, (rand() - 0.5) * 1e7).view
			const s = resolveView(v, capture)
			expect(s.startHz).toBeGreaterThanOrEqual(capture.startHz - 1e-3)
			expect(s.endHz).toBeLessThanOrEqual(capture.endHz + 1e-3)
			expect(s.endHz - s.startHz).toBeGreaterThanOrEqual(MIN_SPAN_HZ - 1e-3)
		}
	})
})

describe("axes", () => {
	it("frequency ticks use a round step, about one per 120 px", () => {
		const ticks = freqTicks(capture, 1200)
		expect(ticks[0]?.hz).toBe(160_500_000)
		expect(ticks[0]?.text).toBe("160.5")
		const step = (ticks[1]?.hz ?? 0) - (ticks[0]?.hz ?? 0)
		expect(step).toBe(250_000)
		expect(ticks.length).toBeLessThanOrEqual(10)
		for (const t of ticks) {
			expect(t.x).toBeGreaterThanOrEqual(0)
			expect(t.x).toBeLessThanOrEqual(1)
		}
		const narrow = freqTicks({ startHz: 161_140_000, endHz: 161_160_000 }, 800)
		expect(narrow[0]?.text).toBe("161.140")
		expect(freqTicks(capture, 0)).toEqual([])
	})

	it("dB ticks follow the renderer's mapping and keep clear of the edges", () => {
		const levels = { minDb: -120, maxDb: -20 }
		expect(dbToTraceY(-20, levels, 300)).toBeCloseTo(1.5, 6)
		expect(dbToTraceY(-120, levels, 300)).toBeCloseTo(299, 6)
		const ticks = dbTicks(levels, 300)
		expect(ticks.map(t => t.db)).toEqual([-40, -60, -80, -100])
		expect(ticks[0]?.text).toBe("−40")
		expect(dbTicks(levels, 120).map(t => t.db)).toEqual([-30, -60, -90])
		expect(dbTicks(levels, 600).map(t => t.db)).toHaveLength(9)
		expect(dbTicks(levels, 30)).toEqual([])
	})
})

describe("tuning", () => {
	it("snaps a click to the signal under it or within a few px of its centre", () => {
		const tracks = [
			track(161_143_750, 161_156_250),
			track(160_440_000, 160_460_000),
		]
		// 1000 px over 2.4 MHz: 2.4 kHz per px, 8 px ≈ 19.2 kHz.
		expect(snapToTrack(161_160_000, tracks, capture, 1000)).toBe(161_150_000)
		expect(snapToTrack(161_175_000, tracks, capture, 1000)).toBe(161_150_000)
		expect(snapToTrack(161_200_000, tracks, capture, 1000)).toBeNull()
		expect(snapToTrack(160_455_000, tracks, capture, 1000)).toBe(160_450_000)
		// Zoomed in, the same click is too far.
		const zoomed = { startHz: 161_100_000, endHz: 161_200_000 }
		expect(snapToTrack(161_175_000, tracks, zoomed, 1000)).toBeNull()
	})

	it("steps on the raster", () => {
		expect(snapToStep(161_151_000, 12_500)).toBe(161_150_000)
		expect(stepHz(161_150_000, 12_500, 1)).toBe(161_162_500)
		expect(stepHz(161_151_000, 12_500, -1)).toBe(161_137_500)
		expect(snapToStep(100, 0)).toBe(0)
	})

	it("moves the channel inside the capture, recentres outside it", () => {
		const margin = edgeMargin(capture, 12_500)
		expect(margin).toBe(48_000)
		expect(tuneAction(161_150_000, 161_500_000, capture, margin)).toEqual({
			kind: "offset",
			offsetHz: -350_000,
		})
		expect(tuneAction(162_690_000, 161_500_000, capture, margin)).toEqual({
			kind: "retune",
			centreHz: 162_690_000,
		})
		expect(tuneAction(156_800_000, 161_500_000, capture, margin).kind).toBe(
			"retune",
		)
	})

	it("keeps the channel after a hardware move when the new capture holds it", () => {
		expect(offsetKeeping(161_150_000, 161_600_000, 2_400_000, 48_000)).toBe(
			-450_000,
		)
		expect(
			offsetKeeping(161_150_000, 163_000_000, 2_400_000, 48_000),
		).toBeNull()
	})

	it("takes the step of the narrowest band naming one", () => {
		expect(tuningStep(plan, 446_006_250)).toBe(12_500) // PMR446
		expect(tuningStep(plan, 120_000_000)).toBe(8_330) // Airband
		expect(tuningStep(plan, 95_000_000)).toBe(100_000) // FM broadcast
		expect(tuningStep(plan, 50_000_000)).toBe(DEFAULT_STEP_HZ)
		expect(tuningStep(null, 161_000_000)).toBe(DEFAULT_STEP_HZ)
	})
})

describe("wheel, pinch, keys", () => {
	it("accumulates wheel travel into single steps (scroll up = up in frequency)", () => {
		let acc = 0
		let r = accumulateWheel(acc, -30)
		expect(r.steps).toBe(0)
		acc = r.acc
		r = accumulateWheel(acc, -30)
		expect(r.steps).toBe(1)
		expect(r.acc).toBe(0)
		// A mouse notch is one step, however large its delta.
		expect(accumulateWheel(0, 120)).toEqual({ steps: -1, acc: 0 })
		expect(wheelPixels(3, 1)).toBe(48)
		expect(wheelPixels(1, 2, 600)).toBe(600)
	})

	it("zooms in on wheel up and pinch out", () => {
		expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
		expect(wheelZoomFactor(100)).toBeLessThan(1)
		expect(wheelZoomFactor(-100) * wheelZoomFactor(100)).toBeCloseTo(1, 12)
		expect(pinchFactor(100, 150)).toBe(1.5)
		expect(pinchFactor(0, 150)).toBe(1)
	})

	it("maps keys", () => {
		expect(keyAction("ArrowRight", noMods)).toEqual({
			type: "step",
			dir: 1,
			times: 1,
		})
		expect(keyAction("ArrowDown", noMods)).toEqual({
			type: "step",
			dir: -1,
			times: 1,
		})
		expect(keyAction("PageUp", noMods)).toEqual({
			type: "step",
			dir: 1,
			times: 10,
		})
		expect(keyAction("ArrowLeft", { ...noMods, shift: true })).toEqual({
			type: "pan",
			fraction: -0.1,
		})
		expect(keyAction("+", noMods)).toEqual({ type: "zoom", factor: 2 })
		expect(keyAction("-", noMods)).toEqual({ type: "zoom", factor: 0.5 })
		expect(keyAction("0", noMods)).toEqual({ type: "fit" })
		expect(keyAction("ArrowRight", { ...noMods, ctrl: true })).toBeNull()
		expect(keyAction("a", noMods)).toBeNull()
	})
})

describe("band lanes", () => {
	it("cuts nested bands so the narrower one sits over its parent", () => {
		const span = { startHz: 155_000_000, endHz: 158_000_000 }
		const pieces = lanePieces(plan, span, 1200)
		const marine = pieces.filter(p => p.key.startsWith("builtin-fr/marine#"))
		const harbour = pieces.filter(p => p.key.startsWith("operator/harbour#"))
		expect(harbour).toHaveLength(1)
		// Marine VHF shows either side of Harbour channels, not under it.
		expect(marine.length).toBeGreaterThanOrEqual(2)
		const h = harbour[0]
		if (!h) throw new Error("no harbour piece")
		for (const m of marine) {
			const overlap =
				Math.min(m.left + m.width, h.left + h.width) - Math.max(m.left, h.left)
			expect(overlap).toBeLessThanOrEqual(1e-9)
		}
		expect(h.colour).toBe("var(--wk-grp-marine)")
		// Every piece lies inside the view.
		for (const p of pieces) {
			expect(p.left).toBeGreaterThanOrEqual(-1e-9)
			expect(p.left + p.width).toBeLessThanOrEqual(1 + 1e-9)
		}
		// Each band names itself at most once.
		const named = pieces.filter(p => p.showLabel).map(p => p.label)
		expect(new Set(named).size).toBe(named.length)
	})

	it("hides a name that does not fit", () => {
		const pieces = lanePieces(
			plan,
			{ startHz: 445_000_000, endHz: 447_000_000 },
			120,
		)
		expect(pieces.every(p => !p.showLabel || p.labelMax >= 0)).toBe(true)
		const pmr = pieces.find(p => p.label === "PMR446")
		expect(pmr?.showLabel).toBe(false)
	})

	it("maps display groups to the --wk-grp tokens", () => {
		expect(groupColour("ism-srd")).toBe("var(--wk-grp-srd)")
		expect(groupColour("personal-radio")).toBe("var(--wk-grp-personal)")
		expect(groupColour("land-mobile")).toBe("var(--wk-grp-landmobile)")
		expect(lanePieces(null, capture, 1000)).toEqual([])
	})
})

describe("signal labels", () => {
	it("names a track by its plan channel, else the band mode", () => {
		const [ch16, other, none] = describeTracks(
			[
				track(156_793_750, 156_806_250),
				track(161_143_750, 161_156_250, true),
				track(50_000_000, 50_010_000),
			],
			plan,
		)
		expect(ch16?.label).toMatch(/16/)
		expect(other?.label).toBe("NFM")
		expect(other?.burst).toBe(true)
		expect(other?.sub).toBe("161.150")
		expect(none?.label).toBe("Signal")
	})

	it("holds a bursty track between bursts, then lets it go", () => {
		let held = holdTracks([], [track(1, 2)], 0, 1000)
		held = holdTracks(held, [track(5, 6)], 500, 1000)
		expect(held.map(h => h.track.startHz)).toEqual([1, 5])
		held = holdTracks(held, [], 1200, 1000)
		expect(held.map(h => h.track.startHz)).toEqual([5])
		// A fresh track replaces the held one it overlaps.
		held = holdTracks(held, [track(5, 7)], 1300, 1000)
		expect(held.map(h => h.track.endHz)).toEqual([7])
	})

	it("places chips without overlap: tuned first, then rows, then compact, then drops", () => {
		const view = { startHz: 0, endHz: 1000 }
		const sig = (hz: number, label: string, widthHz = 10) => ({
			hz,
			widthHz,
			label,
			sub: "161.150",
			burst: false,
		})
		const signals = [
			sig(500, "A", 8),
			sig(505, "Tuned", 2),
			sig(510, "B", 7),
			sig(515, "C", 6),
			sig(520, "D", 5),
			sig(525, "E", 4),
			sig(530, "F", 3),
		]
		const placed = placeLabels(signals, view, {
			widthPx: 1000,
			traceCss: 300,
			tunedHz: 505,
		})
		expect(placed[0]?.label).toBe("Tuned")
		expect(placed[0]?.tuned).toBe(true)
		expect(placed[0]?.top).toBe(8)
		const rects = placed.map(p => {
			const w = 40 + p.label.length * 7.4 + (p.sub ? 6 + p.sub.length * 6.6 : 0)
			return [p.x - w / 2, p.top, p.x + w / 2, p.top + 28] as const
		})
		for (let i = 0; i < rects.length; i++)
			for (let j = i + 1; j < rects.length; j++) {
				const a = rects[i]
				const b = rects[j]
				if (!a || !b) continue
				const clash = a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
				expect(clash).toBe(false)
			}
		expect(placed.length).toBeLessThan(signals.length)
		// Outside the view: never placed.
		expect(
			placeLabels([sig(2000, "X")], view, {
				widthPx: 1000,
				traceCss: 300,
				tunedHz: null,
			}),
		).toEqual([])
	})
})
