import { describe, expect, it } from "vitest"
import {
	observedGate,
	prove,
	type Frame,
	type Sampled,
	type Seen,
} from "./layout-flow.ts"

const seen = (x: number, over: Partial<Seen> = {}): Seen => ({
	x,
	y: 0,
	w: 100,
	h: 40,
	vis: "visible",
	state: "",
	anim: 0,
	td: 0,
	...over,
})

/** The frame before the action, then frames after it; `inWindow` counts only those inside the declared window. */
const sampled = (
	frames: Frame[],
	inWindow: number,
	times?: number[],
): Sampled => ({
	frames,
	times: times ?? frames.map((_, i) => i * 16),
	overlaps: [],
	inWindow,
	at: 0,
})

describe("layout flow: the observed gate", () => {
	// the host painted one frame after the action, and it landed in the 160 ms read tail
	const tailOnly = sampled([{ panel: null }, { panel: seen(10) }], 0)

	it("a still jump whose only post-action frame is in the read tail is observed (and proved)", () => {
		expect(observedGate("jump", true, tailOnly)).toBeNull()
		const p = prove("jump", tailOnly, "panel", { label: "open", still: true })
		expect(p).toEqual({ violations: [], unobserved: null })
	})

	it("a still jump with no frame after the action at all stays unobserved", () => {
		const none = sampled([{ panel: null }], 0)
		expect(observedGate("jump", true, none)).not.toBeNull()
		expect(
			prove("jump", none, "panel", { label: "open", still: true }).unobserved,
		).not.toBeNull()
	})

	it("a non-still jump in the same case is unobserved (infra)", () => {
		expect(observedGate("jump", false, tailOnly)).toMatch(
			/inside the declared window/,
		)
		expect(
			prove("jump", tailOnly, "panel", { label: "slot", still: false })
				.unobserved,
		).toMatch(/inside the declared window/)
	})

	it("an animate cell keeps the window rule", () => {
		expect(observedGate("animate", false, tailOnly)).toMatch(
			/inside the declared window/,
		)
		expect(observedGate("animate", true, tailOnly)).toMatch(
			/inside the declared window/,
		)
		expect(
			observedGate("animate", false, { ...tailOnly, inWindow: 1 }),
		).toBeNull()
	})

	it("a still jump seen only in the tail still fails a real violation (an intermediate frame)", () => {
		const s = sampled(
			[{ panel: seen(0) }, { panel: seen(5) }, { panel: seen(10) }],
			0,
		)
		const p = prove("jump", s, "panel", { label: "open", still: true })
		expect(p.unobserved).toBeNull()
		expect(p.violations.join()).toMatch(/intermediate frame/)
	})
})
