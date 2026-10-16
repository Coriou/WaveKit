import { describe, expect, it } from "vitest"
import { createInterpreterState } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import type { DecoderOutputLike } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import { interpretAcars } from "../../../../src/core/scanner/probes/confirm/acars.js"

const T0 = Date.UTC(2026, 9, 16, 12)
const F1 = 131_550_000
const F2 = 131_725_000
const st = (epoch = 1) =>
	createInterpreterState({ epoch, origin: "ambient", decoderId: "acars" })
const msg = (data: unknown): DecoderOutputLike => ({
	type: "acars",
	data,
	timestamp: new Date(T0),
})
const ok = (p: Record<string, unknown> = {}) =>
	msg({ frequency: F1, error: 0, tail: ".G-ABCD", text: "secret", ...p })

describe("interpretAcars", () => {
	it("clean decode is evidence; identity on the second", () => {
		const s = st()
		const first = interpretAcars(ok(), s, { targetsHz: [F1, F2] })
		expect(first).toEqual([
			{
				crcClean: true,
				at: T0,
				epoch: 1,
				origin: "ambient",
				decoderId: "acars",
				protocol: "acars",
				metadata: {},
				hz: F1,
			},
		])
		expect(
			interpretAcars(ok(), s, { targetsHz: [F1, F2] })[0]?.identity,
		).toEqual({ kind: "acars-reg", value: "G-ABCD" })
	})
	it("error > 0 is evidence, not clean, never accepted", () => {
		const s = st()
		for (let i = 0; i < 10; i++) {
			const r = interpretAcars(ok({ error: 2 }), s, { targetsHz: [F1] })
			expect(r).toHaveLength(1)
			expect(r[0]?.crcClean).toBe(false)
			expect(r[0]?.identity).toBeUndefined()
		}
		expect(s.match.isAccepted("acars:reg", "G-ABCD")).toBe(false)
		// a single clean decode afterwards still has no identity
		expect(
			interpretAcars(ok(), s, { targetsHz: [F1] })[0]?.identity,
		).toBeUndefined()
	})
	it("missing or non-number error is not clean", () => {
		expect(
			interpretAcars(ok({ error: undefined }), st(), { targetsHz: [F1] })[0]
				?.crcClean,
		).toBe(false)
		expect(
			interpretAcars(ok({ error: "0" }), st(), { targetsHz: [F1] })[0]
				?.crcClean,
		).toBe(false)
	})
	it("no frequency with two targets is no evidence", () => {
		expect(
			interpretAcars(ok({ frequency: undefined }), st(), {
				targetsHz: [F1, F2],
			}),
		).toEqual([])
	})
	it("no frequency with one target uses that target", () => {
		expect(
			interpretAcars(ok({ frequency: undefined }), st(), { targetsHz: [F2] })[0]
				?.hz,
		).toBe(F2)
	})
	it("non-finite, zero or string frequency is no evidence", () => {
		for (const frequency of [Number.NaN, 0, -5, "131.55", null])
			expect(
				interpretAcars(ok({ frequency }), st(), { targetsHz: [F1] }),
			).toEqual([])
	})
	it("1.5 kHz off target is dropped, 1.0 kHz kept", () => {
		expect(
			interpretAcars(ok({ frequency: F1 + 1500 }), st(), { targetsHz: [F1] }),
		).toEqual([])
		expect(
			interpretAcars(ok({ frequency: F1 + 1000 }), st(), { targetsHz: [F1] }),
		).toHaveLength(1)
	})
	it("invalid tails give evidence without identity", () => {
		for (const tail of [
			"",
			"...",
			"TOOLONG123",
			"G ABCD",
			"G_ABC",
			"x".repeat(1_000_000),
			42,
			null,
		]) {
			const s = st()
			interpretAcars(ok({ tail }), s, { targetsHz: [F1] })
			const r = interpretAcars(ok({ tail }), s, { targetsHz: [F1] })
			expect(r).toHaveLength(1)
			expect(r[0]?.identity).toBeUndefined()
		}
	})
	it("tail is trimmed and upper-cased", () => {
		const s = st()
		interpretAcars(ok({ tail: " ..n123ab " }), s, { targetsHz: [F1] })
		expect(
			interpretAcars(ok({ tail: "N123AB" }), s, { targetsHz: [F1] })[0]
				?.identity?.value,
		).toBe("N123AB")
	})
	it("malformed data or wrong type is no evidence", () => {
		for (const data of [null, 1, "x", []])
			expect(interpretAcars(msg(data), st(), { targetsHz: [F1] })).toEqual([])
		expect(
			interpretAcars(
				{
					type: "vdl2",
					data: { frequency: F1, error: 0 },
					timestamp: new Date(T0),
				},
				st(),
				{ targetsHz: [F1] },
			),
		).toEqual([])
	})
	it("epoch change resets", () => {
		const s = st(1)
		interpretAcars(ok(), s, { targetsHz: [F1] })
		interpretAcars(ok(), s, { targetsHz: [F1] })
		expect(
			interpretAcars(ok(), st(2), { targetsHz: [F1] })[0]?.identity,
		).toBeUndefined()
	})
})
