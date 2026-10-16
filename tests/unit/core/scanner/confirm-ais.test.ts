import { describe, expect, it } from "vitest"
import { createInterpreterState } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import type { DecoderOutputLike } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import { interpretAis } from "../../../../src/core/scanner/probes/confirm/ais.js"
import { nearTarget } from "../../../../src/core/scanner/probes/confirm/ambient-decode.js"

const T0 = Date.UTC(2026, 9, 16, 12)
const A = 161_975_000
const B = 162_025_000
const ctx = { targetsHz: [A, B] }
const st = (epoch = 1) =>
	createInterpreterState({ epoch, origin: "ambient", decoderId: "ais" })
const ship = (data: unknown, at: number | Date = T0): DecoderOutputLike => ({
	type: "ship",
	data,
	timestamp: at instanceof Date ? at : new Date(at),
})

describe("interpretAis", () => {
	it("channel A maps to 161.975 MHz, evidence without identity on first decode", () => {
		const r = interpretAis(ship({ mmsi: "235000001", channel: "A" }), st(), ctx)
		expect(r).toEqual([
			{
				crcClean: true,
				at: T0,
				epoch: 1,
				origin: "ambient",
				decoderId: "ais",
				protocol: "ais",
				metadata: {},
				hz: A,
			},
		])
	})
	it("identity on the second clean decode and later ones", () => {
		const s = st()
		const d = ship({ mmsi: "235000001", channel: "B" })
		expect(interpretAis(d, s, ctx)[0]?.identity).toBeUndefined()
		expect(interpretAis(d, s, ctx)[0]).toMatchObject({
			hz: B,
			identity: { kind: "ais-mmsi", value: "235000001" },
		})
		expect(interpretAis(d, s, ctx)[0]?.identity?.value).toBe("235000001")
	})
	it("a new state (epoch change) resets acceptance", () => {
		const s = st(1)
		const d = ship({ mmsi: "235000001", channel: "A" })
		interpretAis(d, s, ctx)
		interpretAis(d, s, ctx)
		expect(interpretAis(d, st(2), ctx)[0]?.identity).toBeUndefined()
	})
	it("no channel is no evidence", () => {
		expect(interpretAis(ship({ mmsi: "235000001" }), st(), ctx)).toEqual([])
	})
	it("unknown channel is no evidence", () => {
		expect(
			interpretAis(ship({ mmsi: "235000001", channel: "C" }), st(), ctx),
		).toEqual([])
		expect(
			interpretAis(ship({ mmsi: "235000001", channel: 1 }), st(), ctx),
		).toEqual([])
	})
	it("channel not among targets is dropped", () => {
		expect(
			interpretAis(ship({ mmsi: "235000001", channel: "B" }), st(), {
				targetsHz: [A],
			}),
		).toEqual([])
	})
	it("wrong output type is no evidence", () => {
		expect(
			interpretAis(
				{ type: "acars", data: { channel: "A" }, timestamp: new Date(T0) },
				st(),
				ctx,
			),
		).toEqual([])
	})
	it("malformed data is no evidence and never throws", () => {
		for (const data of [null, undefined, 1, "x", [], [{ channel: "A" }]])
			expect(interpretAis(ship(data), st(), ctx)).toEqual([])
	})
	it("invalid timestamp is no evidence", () => {
		expect(
			interpretAis(
				ship({ mmsi: "235000001", channel: "A" }, new Date(Number.NaN)),
				st(),
				ctx,
			),
		).toEqual([])
		expect(
			interpretAis(
				{
					type: "ship",
					data: { channel: "A" },
					timestamp: "x" as unknown as Date,
				},
				st(),
				ctx,
			),
		).toEqual([])
	})
	it("invalid MMSI values give evidence without identity", () => {
		const s = st()
		for (const mmsi of [
			"12345678",
			"1234567890",
			"23500000x",
			"x".repeat(100_000),
			-1,
			1.5,
			1e9,
			null,
			{},
		]) {
			const d = ship({ mmsi, channel: "A" })
			interpretAis(d, s, ctx)
			const r = interpretAis(d, s, ctx)
			expect(r).toHaveLength(1)
			expect(r[0]?.identity).toBeUndefined()
		}
	})
	it("integer MMSI is rendered as 9 zero-padded digits", () => {
		const s = st()
		const d = ship({ mmsi: 2_350_001, channel: "A" })
		interpretAis(d, s, ctx)
		expect(interpretAis(d, s, ctx)[0]?.identity?.value).toBe("002350001")
	})
})

describe("nearTarget", () => {
	it("bounds at 1 kHz inclusive", () => {
		expect(nearTarget(A + 1000, [A])).toBe(true)
		expect(nearTarget(A - 1000, [A])).toBe(true)
		expect(nearTarget(A + 1500, [A])).toBe(false)
		expect(nearTarget(Number.NaN, [A])).toBe(false)
		expect(nearTarget(Number.POSITIVE_INFINITY, [A])).toBe(false)
		expect(nearTarget(A, [])).toBe(false)
	})
})
