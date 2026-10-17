import { describe, expect, it } from "vitest"
import { createInterpreterState } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import type { DecoderOutputLike } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import { interpretVdl2 } from "../../../../src/core/scanner/probes/confirm/vdl2.js"

const T0 = Date.UTC(2026, 9, 16, 12)
const F = 136_975_000
const ctx = { targetsHz: [F, 136_725_000] }
const st = (epoch = 1) =>
	createInterpreterState({ epoch, origin: "ambient", decoderId: "vdl2" })
const msg = (data: unknown): DecoderOutputLike => ({
	type: "vdl2",
	data,
	timestamp: new Date(T0),
})
const ok = (p: Record<string, unknown> = {}) =>
	msg({ frequency: F, fromaddr: "4ca1b2", msgType: "acars", ...p })

describe("interpretVdl2", () => {
	it("clean evidence; identity on the second decode", () => {
		const s = st()
		expect(interpretVdl2(ok(), s, ctx)).toEqual([
			{
				crcClean: true,
				at: T0,
				epoch: 1,
				origin: "ambient",
				decoderId: "vdl2",
				protocol: "vdl2",
				metadata: {},
				hz: F,
			},
		])
		expect(interpretVdl2(ok(), s, ctx)[0]?.identity).toEqual({
			kind: "vdl2-addr",
			value: "4CA1B2",
		})
	})
	it("falls back to icao, accepts integer addresses", () => {
		const s = st()
		interpretVdl2(ok({ fromaddr: undefined, icao: 0xabc }), s, ctx)
		expect(
			interpretVdl2(ok({ fromaddr: "bad", icao: "000ABC" }), s, ctx)[0]
				?.identity?.value,
		).toBe("000ABC")
	})
	it("frequency 0, NaN, negative, missing or string is no evidence", () => {
		for (const frequency of [
			0,
			Number.NaN,
			-F,
			undefined,
			Number.POSITIVE_INFINITY,
			"136.975",
		])
			expect(interpretVdl2(ok({ frequency }), st(), ctx)).toEqual([])
	})
	it("1.5 kHz off target is dropped, 1.0 kHz kept", () => {
		expect(interpretVdl2(ok({ frequency: F - 1500 }), st(), ctx)).toEqual([])
		expect(interpretVdl2(ok({ frequency: F - 1000 }), st(), ctx)).toHaveLength(
			1,
		)
	})
	it("invalid addresses give evidence without identity", () => {
		for (const fromaddr of [
			"4CA1B",
			"4CA1B2X",
			"GGGGGG",
			"f".repeat(500_000),
			0x1000000,
			-1,
			1.5,
			null,
		]) {
			const s = st()
			interpretVdl2(ok({ fromaddr }), s, ctx)
			const r = interpretVdl2(ok({ fromaddr }), s, ctx)
			expect(r).toHaveLength(1)
			expect(r[0]?.identity).toBeUndefined()
		}
	})
	it("malformed data or wrong type is no evidence", () => {
		for (const data of [null, 1, "x", []])
			expect(interpretVdl2(msg(data), st(), ctx)).toEqual([])
		expect(
			interpretVdl2(
				{ type: "acars", data: { frequency: F }, timestamp: new Date(T0) },
				st(),
				ctx,
			),
		).toEqual([])
	})
	it("epoch change resets", () => {
		const s = st(1)
		interpretVdl2(ok(), s, ctx)
		interpretVdl2(ok(), s, ctx)
		expect(interpretVdl2(ok(), st(2), ctx)[0]?.identity).toBeUndefined()
	})
})
