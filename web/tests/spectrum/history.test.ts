import type { SpectrumProfileEventData } from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import {
	PeakHold,
	WaterfallHistory,
	axisResetReason,
	profileAckKeepsRows,
	profileEventResets,
} from "../../src/spectrum/history.ts"
import type { RowAxis } from "../../src/spectrum/protocol.ts"

const axis: RowAxis = {
	sourceId: "rtl",
	epoch: 3,
	profile: "25:2048",
	binHz: 1000,
	startHz: 445_000_000,
	binCount: 2048,
}

function profile(
	over: Partial<SpectrumProfileEventData>,
): SpectrumProfileEventData {
	return {
		selection: "source",
		sourceId: "rtl",
		profile: { key: "25:2048", hz: 25, bins: 2048 },
		effectiveHz: 20,
		outcome: "exact",
		adjusted: [],
		...over,
	}
}

describe("history reset rule", () => {
	it("keeps rows of the same axis", () => {
		expect(axisResetReason(null, axis)).toBeNull()
		expect(axisResetReason(axis, { ...axis })).toBeNull()
	})

	it("keeps rows across a new epoch on the same frequency axis", () => {
		expect(axisResetReason(axis, { ...axis, epoch: 4 })).toBeNull()
		expect(axisResetReason(axis, { ...axis, epoch: 0 })).toBeNull()
	})

	it("resets on sourceId, profile, binHz, startHz and binCount changes", () => {
		expect(axisResetReason(axis, { ...axis, sourceId: "pi" })).toBe("source")
		expect(axisResetReason(axis, { ...axis, profile: "10:512" })).toBe("axis")
		expect(axisResetReason(axis, { ...axis, binHz: 2000 })).toBe("axis")
		expect(axisResetReason(axis, { ...axis, startHz: 445_000_001 })).toBe(
			"axis",
		)
		expect(axisResetReason(axis, { ...axis, binCount: 1024 })).toBe("axis")
	})

	it("an ack serving the held source and profile again keeps the rows", () => {
		expect(profileAckKeepsRows(profile({}), axis)).toBe(true)
		expect(profileAckKeepsRows(profile({ outcome: "nearest" }), axis)).toBe(
			true,
		)
		expect(
			profileAckKeepsRows(
				profile({ outcome: "rejected", profile: null }),
				axis,
			),
		).toBe(true)
		expect(profileAckKeepsRows(profile({}), null)).toBe(false)
		expect(
			profileAckKeepsRows(
				profile({ profile: { key: "10:512", hz: 10, bins: 512 } }),
				axis,
			),
		).toBe(false)
		expect(profileAckKeepsRows(profile({ sourceId: "pi" }), axis)).toBe(false)
		expect(profileAckKeepsRows(profile({ selection: "default" }), axis)).toBe(
			false,
		)
		expect(profileAckKeepsRows(profile({ outcome: "removed" }), axis)).toBe(
			false,
		)
	})

	it("every spectrum:profile resets, except a default-selection removal of another source", () => {
		expect(profileEventResets(profile({}), "rtl")).toBe(true)
		expect(profileEventResets(profile({ outcome: "rejected" }), "rtl")).toBe(
			true,
		)
		expect(
			profileEventResets(
				profile({
					outcome: "removed",
					selection: "none",
					removedSourceId: "rtl",
				}),
				"rtl",
			),
		).toBe(true)
		expect(
			profileEventResets(
				profile({
					outcome: "removed",
					selection: "default",
					removedSourceId: "pi",
				}),
				"rtl",
			),
		).toBe(false)
		expect(
			profileEventResets(
				profile({
					outcome: "removed",
					selection: "default",
					removedSourceId: "rtl",
				}),
				"rtl",
			),
		).toBe(true)
	})
})

describe("WaterfallHistory", () => {
	it("is a ring: newest first, oldest dropped at depth", () => {
		const h = new WaterfallHistory(3, 4)
		for (let i = 1; i <= 4; i++) {
			expect(h.begin(axis)).toBeNull()
			h.slot().fill(i)
			h.commit()
		}
		expect(h.filled).toBe(3)
		expect(h.row(0)?.[0]).toBe(4)
		expect(h.row(1)?.[0]).toBe(3)
		expect(h.row(2)?.[0]).toBe(2)
		expect(h.row(3)).toBeNull()
	})

	it("decodes into stable slots (no per-frame allocation)", () => {
		const h = new WaterfallHistory(2, 4)
		h.begin(axis)
		const a = h.slot()
		h.commit()
		const b = h.slot()
		h.commit()
		expect(h.slot()).toBe(a)
		expect(a.buffer).toBe(b.buffer)
		expect(a.buffer).toBe(h.data.buffer)
	})

	it("clears itself when a row of another axis begins", () => {
		const h = new WaterfallHistory(4, 4)
		h.begin(axis)
		h.commit()
		h.begin(axis)
		h.commit()
		expect(h.begin({ ...axis, epoch: 9 })).toBeNull()
		expect(h.filled).toBe(2)
		expect(h.axis?.epoch).toBe(9)
		expect(h.begin({ ...axis, epoch: 9, startHz: 446_000_000 })).toBe("axis")
		expect(h.filled).toBe(0)
	})
})

describe("PeakHold", () => {
	it("holds the maximum and decays toward new rows", () => {
		const p = new PeakHold(3)
		p.update(Uint8Array.from([10, 50, 30]), 3, 0)
		p.update(Uint8Array.from([20, 40, 30]), 3, 0)
		expect(Array.from(p.bytes)).toEqual([20, 50, 30])
		p.update(Uint8Array.from([0, 0, 0]), 3, 5)
		expect(Array.from(p.bytes)).toEqual([15, 45, 25])
		p.reset()
		p.update(Uint8Array.from([1, 2, 3]), 3, 100)
		expect(Array.from(p.bytes)).toEqual([1, 2, 3])
	})
})
