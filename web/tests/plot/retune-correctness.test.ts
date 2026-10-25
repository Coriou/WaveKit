// Band view retune correctness (lane WB): after a retune or a sample-rate change, no chip of the previous
// window is drawn, and every chip or tag drawn sits inside the view at x = f(frequency).
import type { Discovery } from "@wavekit/api-types"
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { placeDiscoveryTags } from "../../src/plot/discovery-tags.ts"
import {
	EMPTY_LABEL_GATE,
	frameAxisKey,
	gatedSignals,
	resetLabelGate,
	stepLabelGate,
	type LabelGateContext,
	type LabelGateFrame,
	type LabelGateState,
} from "../../src/plot/label-gate.ts"
import type { Track } from "../../src/plot/maths.ts"
import { placeSavedTags } from "../../src/plot/saved-tags.ts"
import { chipX, fadingChips } from "../../src/plot/signal-chips.ts"

const FLOOR = -100
const ALL: LabelGateContext = {
	mode: "all",
	tunedHz: null,
	isNamed: () => false,
}

interface Window {
	centreHz: number
	rateHz: number
	epoch: number
}

function frame(w: Window, mhz: readonly number[]): LabelGateFrame {
	const usable = w.rateHz * 0.8
	const binCount = 820
	const binHz = usable / binCount
	const startHz = Math.round(w.centreHz - usable / 2)
	const tracks: Track[] = mhz.map(m => ({
		startHz: m * 1e6 - 5000,
		endHz: m * 1e6 + 5000,
		flags: { burst: false, iqImage: false, edge: false },
		peakDb: FLOOR + 30,
		surfaced: true,
		trackId: `t${m}`,
	}))
	return {
		sourceId: "src",
		tracks,
		floorDbfs: FLOOR,
		binHz,
		epoch: w.epoch,
		startHz,
		binCount,
	}
}

function spanOf(f: LabelGateFrame): { startHz: number; endHz: number } {
	const start = f.startHz ?? 0
	return { startHz: start, endHz: start + (f.binCount ?? 0) * f.binHz }
}

/** Feeds `f` every 100 ms for `ms`. */
function feed(
	s: LabelGateState,
	f: LabelGateFrame,
	from: number,
	ms: number,
): LabelGateState {
	let out = s
	for (let t = from; t <= from + ms; t += 100)
		out = stepLabelGate(out, f, t, ALL)
	return out
}

const AT_155: Window = { centreHz: 155e6, rateHz: 2.4e6, epoch: 11 }
const AT_466: Window = { centreHz: 466.078e6, rateHz: 1.024e6, epoch: 12 }

describe("label gate across a retune", () => {
	it("drops every chip of the old window at once, without a fading one", () => {
		let s = feed(EMPTY_LABEL_GATE, frame(AT_155, [154.2, 154.975]), 0, 1000)
		expect(gatedSignals(s).filter(g => !g.leaving)).toHaveLength(2)
		s = stepLabelGate(s, frame(AT_466, [465.8, 466.2]), 1100, ALL)
		const hz = gatedSignals(s).map(g => g.hz)
		expect(hz.every(h => h > 465e6 && h < 467e6)).toBe(true)
		expect(gatedSignals(s).some(g => g.leaving)).toBe(false)
	})

	it("treats a retune at the same rate and epoch-less span change as a new window", () => {
		let s = feed(EMPTY_LABEL_GATE, frame(AT_155, [154.975]), 0, 1000)
		s = stepLabelGate(
			s,
			frame({ centreHz: 162e6, rateHz: 2.4e6, epoch: 11 }, [162.328]),
			1100,
			ALL,
		)
		expect(gatedSignals(s).map(g => g.hz)).toEqual([162.328e6])
	})

	it("never follows a track outside the frame's span (a stale track on the payload)", () => {
		const f = frame(AT_466, [466.2])
		const stale = frame(AT_155, [154.975]).tracks[0] as Track
		const s = feed(
			EMPTY_LABEL_GATE,
			{ ...f, tracks: [...f.tracks, stale] },
			0,
			1000,
		)
		expect(gatedSignals(s).map(g => g.hz)).toEqual([466.2e6])
	})

	it("keeps ids unique across a reset, so a new chip never takes an old chip's key", () => {
		const s = feed(EMPTY_LABEL_GATE, frame(AT_155, [154.2, 154.975]), 0, 1000)
		const old = new Set(gatedSignals(s).map(g => g.id))
		const r = feed(resetLabelGate(s), frame(AT_466, [465.8, 466.2]), 2000, 1000)
		expect(gatedSignals(r).some(g => old.has(g.id))).toBe(false)
		expect(r.axis).toBe(frameAxisKey(frame(AT_466, [])))
	})

	it("still fades a chip whose signal ends within one window", () => {
		let s = feed(EMPTY_LABEL_GATE, frame(AT_466, [465.8, 466.2]), 0, 1000)
		s = feed(s, frame(AT_466, [466.2]), 1100, 1600)
		expect(gatedSignals(s).find(g => g.hz === 465.8e6)?.leaving).toBe(true)
	})
})

describe("fading chips", () => {
	const view = { startHz: 465.67e6, endHz: 466.49e6 }
	const W = 1000

	it("places a leaving chip at its frequency in this view, not at its stored x", () => {
		const last = new Map([[7, { x: 487, hz: 154.975e6, top: 40 }]])
		const out = fadingChips([{ id: 7, hz: 466.2e6 }], last, view, W)
		expect(out).toHaveLength(1)
		expect(out[0]?.x).toBeCloseTo(chipX(466.2e6, view, W) ?? -1, 6)
	})

	it("does not draw a leaving chip from another band", () => {
		const last = new Map([[7, { x: 487, hz: 154.975e6, top: 40 }]])
		expect(fadingChips([{ id: 7, hz: 154.975e6 }], last, view, W)).toEqual([])
	})
})

// ── Properties ──────────────────────────────────────────────────────────────────────────────

const windowArb = fc.record({
	centreHz: fc.integer({ min: 30_000_000, max: 1_700_000_000 }),
	rateHz: fc.constantFrom(1_024_000, 1_920_000, 2_048_000, 2_400_000),
	epoch: fc.integer({ min: 1, max: 1_000_000 }),
})

function signalsIn(w: Window, offsets: readonly number[]): number[] {
	return offsets.map(o => (w.centreHz + o * w.rateHz * 0.35) / 1e6)
}

describe("retune correctness properties", () => {
	it("no chip of the previous window survives a retune or rate change", () => {
		// Feature: band-view-retune-correctness, Property 1: old-window chips vanish at once
		// Validates: Requirements WB.2
		fc.assert(
			fc.property(
				fc.array(windowArb, { minLength: 2, maxLength: 6 }),
				fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
					minLength: 1,
					maxLength: 6,
				}),
				(windows, offsets) => {
					let s = EMPTY_LABEL_GATE
					let t = 0
					let prev: string | null = null
					for (const w of windows) {
						const f = frame(w, signalsIn(w, offsets))
						const key = frameAxisKey(f)
						s = feed(s, f, t, 1200)
						t += 1300
						if (key === prev) continue
						prev = key
						const span = spanOf(f)
						for (const g of gatedSignals(s)) {
							expect(g.hz).toBeGreaterThanOrEqual(span.startHz)
							expect(g.hz).toBeLessThanOrEqual(span.endHz)
						}
					}
				},
			),
			{ numRuns: 150 },
		)
	})

	it("every followed signal lies inside the newest frame's span", () => {
		// Feature: band-view-retune-correctness, Property 2: chips only inside the capture
		// Validates: Requirements WB.1, WB.2
		fc.assert(
			fc.property(
				windowArb,
				windowArb,
				fc.array(fc.double({ min: -2, max: 2, noNaN: true }), {
					maxLength: 8,
				}),
				(a, b, offsets) => {
					let s = feed(
						EMPTY_LABEL_GATE,
						frame(a, signalsIn(a, offsets)),
						0,
						1500,
					)
					// the second frame also carries the first window's tracks (a stale payload)
					const fb = frame(b, signalsIn(b, offsets))
					const stale = frame(a, signalsIn(a, offsets)).tracks
					s = stepLabelGate(
						s,
						{ ...fb, tracks: [...fb.tracks, ...stale] },
						1600,
						ALL,
					)
					const span = spanOf(fb)
					for (const g of gatedSignals(s))
						expect(g.hz >= span.startHz && g.hz <= span.endHz).toBe(true)
				},
			),
			{ numRuns: 150 },
		)
	})

	it("a fading chip is drawn only in view, at x = f(hz) within 1 px", () => {
		// Feature: band-view-retune-correctness, Property 3: place by absolute frequency
		// Validates: Requirements WB.1, WB.3
		fc.assert(
			fc.property(
				windowArb,
				fc.integer({ min: 200, max: 3000 }),
				fc.array(
					fc.record({
						hz: fc.integer({ min: 20_000_000, max: 1_800_000_000 }),
						x: fc.double({ min: -5000, max: 5000, noNaN: true }),
					}),
					{ maxLength: 20 },
				),
				(w, widthPx, chips) => {
					const view = {
						startHz: w.centreHz - w.rateHz * 0.4,
						endHz: w.centreHz + w.rateHz * 0.4,
					}
					const last = new Map(
						chips.map((c, i) => [i, { x: c.x, hz: c.hz, top: 30 }]),
					)
					const out = fadingChips(
						chips.map((c, i) => ({ id: i, hz: c.hz })),
						last,
						view,
						widthPx,
					)
					for (const c of out) {
						expect(c.hz >= view.startHz && c.hz <= view.endHz).toBe(true)
						const want =
							((c.hz - view.startHz) / (view.endHz - view.startHz)) * widthPx
						expect(Math.abs(c.x - want)).toBeLessThanOrEqual(1)
					}
					const inView = chips.filter(
						c => c.hz >= view.startHz && c.hz <= view.endHz,
					).length
					expect(out).toHaveLength(inView)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("saved and discovery tags outside the view are never placed in the plot", () => {
		// Feature: band-view-retune-correctness, Property 4: out-of-view tags stay out
		// Validates: Requirements WB.1, WB.4
		fc.assert(
			fc.property(
				windowArb,
				fc.array(fc.integer({ min: 20_000_000, max: 1_800_000_000 }), {
					maxLength: 30,
				}),
				(w, freqs) => {
					const view = {
						startHz: w.centreHz - w.rateHz * 0.4,
						endHz: w.centreHz + w.rateHz * 0.4,
					}
					const saved = placeSavedTags(
						freqs.map((hz, i) => ({
							id: `s${i}`,
							name: `S${i}`,
							frequencyHz: hz,
						})),
						view,
						{ widthPx: 1200, showLabels: true },
					)
					for (const t of saved)
						expect(t.hz >= view.startHz && t.hz <= view.endHz).toBe(true)
					const discs = placeDiscoveryTags(
						freqs.map((hz, i) => discovery(`d${i}`, hz)),
						view,
						{ widthPx: 1200, activeNow: new Set(), now: Date.now() },
					)
					for (const t of discs)
						for (const m of t.members)
							expect(
								m.frequencyHz >= view.startHz && m.frequencyHz <= view.endHz,
							).toBe(true)
				},
			),
			{ numRuns: 150 },
		)
	})
})

function discovery(id: string, hz: number): Discovery {
	return {
		id,
		frequencyHz: hz,
		frequencyKey: `r:${hz}`,
		measuredOffsetHz: 0,
		bandwidthHz: 12_500,
		protocol: "unknown",
		family: "unknown",
		class: "unknown",
		confidence: "activity",
		encrypted: false,
		coChannel: [],
		firstSeenAt: new Date(0).toISOString(),
		lastSeenAt: new Date().toISOString(),
		observationCount: 1,
		airtimeMs: 100,
		signal: { best: stats, last: stats },
		metadata: {
			talkgroups: [],
			sources: [],
			slots: [],
			callsigns: [],
			capcodes: [],
			ismModels: [],
		},
		sourceIds: ["src"],
		jobIds: [],
		tuningTrust: "commanded",
		evidence: { recordings: 0, psd: true, iq: false },
	}
}

const stats = { peakDbfs: -60, meanDbfs: -64, snrDb: 30, floorDbfs: -100 }
