import { describe, expect, it } from "vitest"
import { keptSummaryOf } from "../../../../src/core/recordings/kept-summary.js"
import type { RecordingKeepTotalsSource } from "../../../../src/core/recordings/contract.js"

const src = (
	state: "loading" | "ready" | "failed",
	totals: { recordings: number; bytes: number } | null,
): RecordingKeepTotalsSource => ({ state: () => state, totals: () => totals })

describe("keptSummaryOf (WG10 req 1.8)", () => {
	it("is null without a source", () => {
		expect(keptSummaryOf(null)).toBeNull()
	})
	it("ready carries counts and both bounds", () => {
		expect(keptSummaryOf(src("ready", { recordings: 3, bytes: 99 }))).toEqual({
			state: "ready",
			recordings: 3,
			bytes: 99,
			maxRecordings: 2000,
			maxBytes: expect.any(Number),
		})
	})
	it("loading and failed carry no counts", () => {
		expect(keptSummaryOf(src("loading", { recordings: 1, bytes: 1 }))).toEqual({
			state: "loading",
		})
		expect(keptSummaryOf(src("failed", null))).toEqual({ state: "failed" })
	})
	it("ready without or with malformed totals is not trusted", () => {
		expect(keptSummaryOf(src("ready", null))).toEqual({ state: "loading" })
		expect(keptSummaryOf(src("ready", { recordings: -1, bytes: 0 }))).toEqual({
			state: "loading",
		})
		expect(
			keptSummaryOf(src("ready", { recordings: 1, bytes: Number.NaN })),
		).toEqual({ state: "loading" })
	})
	it("a throwing source is failed", () => {
		expect(
			keptSummaryOf({
				state: () => {
					throw new Error("x")
				},
				totals: () => null,
			}),
		).toEqual({ state: "failed" })
	})
})
