import { describe, expect, it } from "vitest"
import { createInterpreterState } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import type { DecoderOutputLike } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import { interpretMeshtastic } from "../../../../src/core/scanner/probes/confirm/meshtastic.js"

const T0 = Date.UTC(2026, 9, 16, 12)
const F = 869_525_000
const ctx = { targetsHz: [F] }
const st = (epoch = 1) =>
	createInterpreterState({ epoch, origin: "ambient", decoderId: "mesh" })
const msg = (data: unknown): DecoderOutputLike => ({
	type: "meshtastic",
	data,
	timestamp: new Date(T0),
})
const ok = (p: Record<string, unknown> = {}) =>
	msg({ from: 0xdeadbeef, frequency: F, payloadB64: "aGk=", ...p })

describe("interpretMeshtastic", () => {
	it("clean evidence; identity !%08x on the second", () => {
		const s = st()
		expect(interpretMeshtastic(ok(), s, ctx)).toEqual([
			{
				crcClean: true,
				at: T0,
				epoch: 1,
				origin: "ambient",
				decoderId: "mesh",
				protocol: "lora",
				metadata: {},
				hz: F,
			},
		])
		expect(interpretMeshtastic(ok(), s, ctx)[0]?.identity).toEqual({
			kind: "lora-node",
			value: "!deadbeef",
		})
	})
	it("pads small node ids", () => {
		const s = st()
		interpretMeshtastic(ok({ from: 0x1f }), s, ctx)
		expect(
			interpretMeshtastic(ok({ from: 0x1f }), s, ctx)[0]?.identity?.value,
		).toBe("!0000001f")
	})
	it('viaMqtt present and not exactly false is no evidence ("true", 1, null)', () => {
		for (const viaMqtt of ["true", 1, null]) {
			const s = st()
			expect(interpretMeshtastic(ok({ viaMqtt }), s, ctx)).toEqual([])
			expect(interpretMeshtastic(ok({ viaMqtt }), s, ctx)).toEqual([])
		}
		expect(interpretMeshtastic(ok({ viaMqtt: false }), st(), ctx)).toHaveLength(
			1,
		)
	})

	it("viaMqtt is no evidence at all", () => {
		const s = st()
		expect(interpretMeshtastic(ok({ viaMqtt: true }), s, ctx)).toEqual([])
		expect(interpretMeshtastic(ok({ viaMqtt: true }), s, ctx)).toEqual([])
		expect(
			interpretMeshtastic(ok({ viaMqtt: false }), s, ctx)[0]?.identity,
		).toBeUndefined()
	})
	it("missing or invalid frequency is no evidence", () => {
		for (const frequency of [undefined, 0, Number.NaN, -1, "869"])
			expect(interpretMeshtastic(ok({ frequency }), st(), ctx)).toEqual([])
	})
	it("1.5 kHz off target is dropped, 1.0 kHz kept", () => {
		expect(interpretMeshtastic(ok({ frequency: F + 1500 }), st(), ctx)).toEqual(
			[],
		)
		expect(
			interpretMeshtastic(ok({ frequency: F + 1000 }), st(), ctx),
		).toHaveLength(1)
	})
	it("invalid node ids give evidence without identity", () => {
		for (const from of [-1, 0x100000000, 1.5, "deadbeef", null, Number.NaN]) {
			const s = st()
			interpretMeshtastic(ok({ from }), s, ctx)
			const r = interpretMeshtastic(ok({ from }), s, ctx)
			expect(r).toHaveLength(1)
			expect(r[0]?.identity).toBeUndefined()
		}
	})
	it("malformed data or wrong type is no evidence", () => {
		for (const data of [null, 1, "x", []])
			expect(interpretMeshtastic(msg(data), st(), ctx)).toEqual([])
		expect(
			interpretMeshtastic(
				{
					type: "lora",
					data: { frequency: F, from: 1 },
					timestamp: new Date(T0),
				},
				st(),
				ctx,
			),
		).toEqual([])
	})
	it("epoch change resets", () => {
		const s = st(1)
		interpretMeshtastic(ok(), s, ctx)
		interpretMeshtastic(ok(), s, ctx)
		expect(interpretMeshtastic(ok(), st(2), ctx)[0]?.identity).toBeUndefined()
	})
})
