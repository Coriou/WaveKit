import { describe, expect, it } from "vitest"
import { untrackedRetuneAlarm } from "../../../../src/core/spectrum/retune-alarm.js"
import type {
	PersistentFeature,
	SegmentRange,
} from "../../../../src/core/spectrum/retune-alarm.js"

const F: PersistentFeature[] = [100_000, 200_000, 300_000, 400_000].map(
	rfHz => ({ rfHz, widthHz: 2000, marginDb: 20 }),
)
const seg = (hz: number, half = 1000): SegmentRange => ({
	startHz: hz - half,
	endHz: hz + half,
	centreHz: hz,
})
const all = { toleranceHz: 1000, visible: () => true }

describe("untrackedRetuneAlarm", () => {
	it("ignores weak flicker and a strong unkey in a sparse strong scene", () => {
		const weak = F.slice(0, 3).map(f => ({ ...f, marginDb: 1 }))
		expect(untrackedRetuneAlarm(weak, [seg(weak[0]!.rfHz)], all)).toBeNull()
		expect(
			untrackedRetuneAlarm([...weak.slice(0, 2), F[3]!], [], all),
		).toBeNull()
	})
	it("requires the full strength margin, including at the boundary", () => {
		const features = F.slice(0, 3).map(f => ({ ...f, marginDb: 10 }))
		expect(untrackedRetuneAlarm(features, [], all)).toEqual({ deltaHz: null })
		features[0]!.marginDb = 9.99
		expect(untrackedRetuneAlarm(features, [], all)).toBeNull()
	})
	it("stays quiet while the features are where they were", () => {
		expect(
			untrackedRetuneAlarm(
				F,
				F.map(f => seg(f.rfHz)),
				all,
			),
		).toBeNull()
	})
	it("reports a common shift with its Δ", () => {
		const r = untrackedRetuneAlarm(
			F,
			F.map(f => seg(f.rfHz + 25_000 + (f.rfHz % 300))),
			all,
		)
		expect(r).not.toBeNull()
		expect(Math.abs((r?.deltaHz ?? 0) - 25_000)).toBeLessThanOrEqual(300)
	})
	it("raises a Δ-less alarm when ≥ 60 % vanish without a common shift", () => {
		expect(untrackedRetuneAlarm(F, [seg(400_000)], all)).toEqual({
			deltaHz: null,
		})
	})
	it("ignores one or two of four features switching off", () => {
		expect(
			untrackedRetuneAlarm(
				F,
				F.slice(1).map(f => seg(f.rfHz)),
				all,
			),
		).toBeNull()
		expect(
			untrackedRetuneAlarm(
				F,
				F.slice(2).map(f => seg(f.rfHz)),
				all,
			),
		).toBeNull()
	})
	it("never arms with fewer than 3 visible features", () => {
		expect(untrackedRetuneAlarm(F.slice(0, 2), [], all)).toBeNull()
		const twoVisible = {
			toleranceHz: 1000,
			visible: (hz: number) => hz < 250_000,
		}
		expect(untrackedRetuneAlarm(F, [], twoVisible)).toBeNull()
	})
	it("treats a shift within 1 RBW as no change", () => {
		expect(
			untrackedRetuneAlarm(
				F,
				F.map(f => seg(f.rfHz + 800)),
				all,
			),
		).toBeNull()
	})
	it("counts shift support only over features whose shifted position is visible", () => {
		const view = { toleranceHz: 1000, visible: (hz: number) => hz <= 430_000 }
		const r = untrackedRetuneAlarm(
			F,
			F.slice(0, 3).map(f => seg(f.rfHz + 50_000)),
			view,
		)
		expect(r?.deltaHz).toBe(50_000)
	})
})
