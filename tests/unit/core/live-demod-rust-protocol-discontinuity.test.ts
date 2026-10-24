/**
 * WG10 req 3.8.1: native `discontinuity` events (a full audio queue dropped output samples).
 */
import { describe, expect, it } from "vitest"
import { parseDemodEventLine } from "../../../src/core/live-demod/rust-protocol.js"

const valid = {
	v: 1,
	type: "discontinuity",
	id: "live-demod",
	generation: 1,
	sampleIndex: 48_000,
	droppedSamples: 480,
	cause: "queue-overflow",
}

describe("rust protocol discontinuity", () => {
	it("parses the native event", () => {
		const parsed = parseDemodEventLine(JSON.stringify(valid))
		expect(parsed).toEqual({ ok: true, event: valid })
	})

	it("parses an input-gap that dropped no output sample", () => {
		const gap = { ...valid, cause: "input-gap", droppedSamples: 0 }
		expect(parseDemodEventLine(JSON.stringify(gap))).toEqual({
			ok: true,
			event: gap,
		})
	})

	it.each([
		["negative index", { ...valid, sampleIndex: -1 }],
		["fractional index", { ...valid, sampleIndex: 1.5 }],
		["negative dropped", { ...valid, droppedSamples: -1 }],
		["string dropped", { ...valid, droppedSamples: "480" }],
		["missing cause", { ...valid, cause: undefined }],
		["cause with a newline", { ...valid, cause: "queue\noverflow" }],
		["cause with markup", { ...valid, cause: "<script>" }],
		["oversize cause", { ...valid, cause: "a".repeat(64) }],
		["extra key", { ...valid, detail: "x" }],
		["bad id", { ...valid, id: "../x" }],
		["unsafe integer", { ...valid, droppedSamples: 2 ** 60 }],
	])("drops a hostile line (%s)", (_name, event) => {
		expect(parseDemodEventLine(JSON.stringify(event))).toEqual({ ok: false })
	})
})
