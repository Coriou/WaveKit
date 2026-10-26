import { describe, expect, it } from "vitest"

import {
	CLEAR_FOR_MS,
	EMPTY_LABEL_GATE,
	HOLD_MS,
	LEAVE_MS,
	MAX_UNKNOWN,
	WEAK_FOR_MS,
	gatedSignals,
	stepLabelGate,
	type LabelGateContext,
	type LabelGateState,
	type SignalLabelsMode,
} from "../../src/plot/label-gate.ts"
import type { Track } from "../../src/plot/maths.ts"

const FLOOR = -70

function track(mhz: number, snrDb: number, widthHz = 10_000): Track {
	const hz = mhz * 1e6
	return {
		startHz: hz - widthHz / 2,
		endHz: hz + widthHz / 2,
		flags: { burst: false, iqImage: false, edge: false },
		peakDb: FLOOR + snrDb,
	}
}

function ctx(
	mode: SignalLabelsMode = "clear",
	named: number[] = [],
	tunedHz: number | null = null,
): LabelGateContext {
	return {
		mode,
		tunedHz,
		isNamed: hz => named.some(n => Math.abs(n * 1e6 - hz) < 3000),
	}
}

/** Feeds the same tracks every 100 ms from `from` to `to`. */
function run(
	state: LabelGateState,
	tracks: (t: number) => Track[],
	from: number,
	to: number,
	c: LabelGateContext,
): LabelGateState {
	let s = state
	for (let t = from; t <= to; t += 100)
		s = stepLabelGate(
			s,
			{
				sourceId: "rtl",
				tracks: tracks(t),
				floorDbfs: FLOOR,
				binHz: 250,
				// one fixed axis wide enough for every track here
				epoch: 1,
				startHz: 0,
				binCount: 8_000_000,
			},
			t,
			c,
		)
	return s
}

const shownMHz = (s: LabelGateState) =>
	gatedSignals(s)
		.filter(g => !g.leaving)
		.map(g => Math.round(g.hz / 1000) / 1000)

describe("label gate", () => {
	it("labels a clear unknown signal only once it has lasted, and never a faint one", () => {
		const tracks = () => [track(446.1, 20), track(446.3, 4)]
		let s = run(EMPTY_LABEL_GATE, tracks, 0, CLEAR_FOR_MS - 200, ctx())
		expect(shownMHz(s)).toEqual([])
		s = run(s, tracks, CLEAR_FOR_MS - 100, CLEAR_FOR_MS + 200, ctx())
		expect(shownMHz(s)).toEqual([446.1])
		// "All" labels the faint one too
		s = run(s, tracks, CLEAR_FOR_MS + 300, CLEAR_FOR_MS + 300, ctx("all"))
		expect(shownMHz(s)).toEqual([446.1, 446.3])
	})

	it("labels named channels at once, and only them in Named", () => {
		const tracks = () => [track(446.00625, 8), track(446.5, 25)]
		let s = run(EMPTY_LABEL_GATE, tracks, 0, 0, ctx("named", [446.00625]))
		expect(shownMHz(s)).toEqual([446.006])
		s = run(s, tracks, 100, 3000, ctx("named", [446.00625]))
		expect(shownMHz(s)).toEqual([446.006])
	})

	it("always labels the tuned signal", () => {
		const s = run(
			EMPTY_LABEL_GATE,
			() => [track(446.2, 2)],
			0,
			0,
			ctx("named", [], 446.2e6),
		)
		expect(shownMHz(s)).toEqual([446.2])
	})

	it("keeps one chip in place while the signal's edges jitter", () => {
		let s = run(EMPTY_LABEL_GATE, () => [track(446.1, 20)], 0, 1500, ctx())
		const [first] = gatedSignals(s)
		s = run(
			s,
			t => [
				track(446.1 + ((t / 100) % 2 ? 0.0005 : -0.0005), 20, 9000 + (t % 300)),
			],
			1600,
			4000,
			ctx(),
		)
		const after = gatedSignals(s)
		expect(after).toHaveLength(1)
		expect(after[0]?.id).toBe(first?.id)
		expect(after[0]?.hz).toBe(first?.hz)
	})

	it("holds a chip through a short dip, drops it once weak for a while, then fades it out", () => {
		let s = run(EMPTY_LABEL_GATE, () => [track(446.1, 20)], 0, 1500, ctx())
		s = run(s, () => [track(446.1, 5)], 1600, 1600 + WEAK_FOR_MS - 200, ctx())
		expect(shownMHz(s)).toEqual([446.1])
		s = run(
			s,
			() => [track(446.1, 5)],
			1600 + WEAK_FOR_MS - 100,
			1600 + WEAK_FOR_MS + 100,
			ctx(),
		)
		expect(shownMHz(s)).toEqual([])
		expect(gatedSignals(s).map(g => g.leaving)).toEqual([true])
		s = run(s, () => [track(446.1, 5)], 3300, 3300 + LEAVE_MS, ctx())
		expect(gatedSignals(s)).toEqual([])
	})

	it("forgets a signal unseen for the hold time", () => {
		let s = run(EMPTY_LABEL_GATE, () => [track(446.1, 20)], 0, 1500, ctx())
		s = run(s, () => [], 1600, 1500 + HOLD_MS, ctx())
		expect(shownMHz(s)).toEqual([446.1])
		s = run(s, () => [], 1600 + HOLD_MS, 1600 + HOLD_MS + LEAVE_MS + 100, ctx())
		expect(gatedSignals(s)).toEqual([])
	})

	it("shows at most a few unknown signals, and a newcomer never pushes one out", () => {
		const many = (n: number, snr: number) =>
			Array.from({ length: n }, (_, i) => track(446 + i * 0.05, snr))
		let s = run(
			EMPTY_LABEL_GATE,
			() => many(MAX_UNKNOWN + 2, 15),
			0,
			1500,
			ctx(),
		)
		const before = shownMHz(s)
		expect(before).toHaveLength(MAX_UNKNOWN)
		s = run(
			s,
			() => [...many(MAX_UNKNOWN + 2, 15), track(447, 40)],
			1600,
			3500,
			ctx(),
		)
		expect(shownMHz(s)).toEqual(before)
	})

	it("ignores IQ images", () => {
		const image = {
			...track(446.1, 30),
			flags: { burst: false, iqImage: true, edge: false },
		}
		const s = run(EMPTY_LABEL_GATE, () => [image], 0, 2000, ctx("all"))
		expect(gatedSignals(s)).toEqual([])
	})

	it("drops spurs", () => {
		const spur = {
			...track(446.1, 30),
			flags: { burst: false, iqImage: false, edge: false, spur: true },
		}
		const s = run(EMPTY_LABEL_GATE, () => [spur], 0, 2000, ctx("all"))
		expect(gatedSignals(s)).toEqual([])
	})

	it("trusts the core's surfacing verdict when it sends one", () => {
		// strong but not through the core's gate: no chip, however long it lasts
		const held =
			(surfaced: boolean, snr = 20) =>
			() => [{ ...track(446.1, snr), trackId: "t1", surfaced }]
		let s = run(EMPTY_LABEL_GATE, held(false), 0, 3000, ctx())
		expect(shownMHz(s)).toEqual([])
		// through the gate: a chip at once, kept while the core says it is real even when it reads faint here
		s = run(s, held(true), 3100, 3100, ctx())
		expect(shownMHz(s)).toEqual([446.1])
		s = run(s, held(true, 3), 3200, 3200 + WEAK_FOR_MS + 500, ctx())
		expect(shownMHz(s)).toEqual([446.1])
	})

	it("follows the core's track id, so two close emissions keep their own chips", () => {
		// the second emission starts right next to the first: by position alone it would be the same signal
		const a = { ...track(446.1, 20), trackId: "a", surfaced: true }
		const b = {
			...track(446.104, 20),
			trackId: "b",
			surfaced: true,
			scanner: {
				discoveryId: "d-7",
				protocol: "dmr" as const,
				confidence: "decoded" as const,
			},
		}
		let s = run(EMPTY_LABEL_GATE, () => [a], 0, 200, ctx())
		const first = gatedSignals(s)[0]?.id
		s = run(s, () => [a, b], 300, 500, ctx())
		const chips = gatedSignals(s).filter(g => !g.leaving)
		expect(chips).toHaveLength(2)
		expect(chips.find(g => g.scanner?.discoveryId === "d-7")?.id).not.toBe(
			first,
		)
		expect(chips.find(g => g.scanner === null)?.id).toBe(first)
	})
})
