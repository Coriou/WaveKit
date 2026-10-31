import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { WaveKitError } from "../../../src/utils/errors.js"
import {
	MAX_GAIN,
	MAX_QUEUE_BYTES,
	MIN_GAIN,
	PROTOCOL_VERSION,
	encodeRequest,
	encodeObservedRequest,
	parseObservedEventLine,
	parseEventLine,
} from "../../../src/core/channelizer/protocol.js"
import type { ChannelizerRequest } from "../../../src/core/channelizer/protocol.js"

const open = {
	v: 1,
	type: "open",
	id: "ais-g1",
	centerHz: 162e6,
	bandwidthHz: 364_800,
	transitionHz: 9_600,
	outputRateHz: 384_000,
	format: "cu8",
	queueBytes: 192_000,
} as const satisfies ChannelizerRequest

describe("channelizer protocol v1", () => {
	it("encodes validated requests as one line", () => {
		expect(PROTOCOL_VERSION).toBe(1)
		expect(encodeRequest({ v: 1, type: "mark-gap", atInputByte: 10 })).toBe(
			'{"v":1,"type":"mark-gap","atInputByte":10}\n',
		)
		expect(encodeRequest({ v: 1, type: "shutdown" })).toBe(
			'{"v":1,"type":"shutdown"}\n',
		)
		expect(encodeRequest({ v: 1, type: "close", id: "ais-g1" })).toBe(
			'{"v":1,"type":"close","id":"ais-g1"}\n',
		)
		expect(JSON.parse(encodeRequest(open))).toEqual(open)
		expect(() =>
			encodeRequest({ v: 1, type: "close", id: "bad id" } as never),
		).toThrow()
	})

	it("throws a WaveKitError for a request the process would reject", () => {
		const err = (() => {
			try {
				encodeRequest({ v: 1, type: "close", id: "" })
			} catch (e: unknown) {
				return e
			}
			return undefined
		})()
		expect(err).toBeInstanceOf(WaveKitError)
		expect((err as WaveKitError).code).toBe("CHANNELIZER_REQUEST_INVALID")
	})

	it("mirrors the process's open-request checks (Property 1)", () => {
		expect(MAX_QUEUE_BYTES).toBe(64 * 1024 * 1024)
		// protocol.rs MIN_GAIN / MAX_GAIN
		expect([MIN_GAIN, MAX_GAIN]).toEqual([1e-6, 1e6])
		const accepted: ChannelizerRequest[] = [
			open,
			{ ...open, queueBytes: MAX_QUEUE_BYTES },
			{ ...open, queueBytes: 2 },
			{ ...open, format: "cf32", queueBytes: 8 },
			{ ...open, gain: 2.5 },
			{ ...open, gain: MIN_GAIN },
			{ ...open, gain: MAX_GAIN },
			{ ...open, id: "a".repeat(64) },
		]
		for (const req of accepted) expect(() => encodeRequest(req)).not.toThrow()
		const rejected = [
			{ ...open, queueBytes: 0 },
			{ ...open, queueBytes: -5 },
			{ ...open, queueBytes: 1.5 },
			{ ...open, queueBytes: MAX_QUEUE_BYTES + 1 },
			{ ...open, queueBytes: 1 }, // below one cu8 sample
			{ ...open, format: "cf32", queueBytes: 4 }, // below one cf32 sample
			{ ...open, format: "cf32", gain: 2 }, // gain is cu8 only
			{ ...open, gain: 0 },
			{ ...open, gain: -1 },
			// Outside the finite normal f32 range the process keeps gain in.
			{ ...open, gain: 9.9e-7 },
			{ ...open, gain: 1e-39 },
			{ ...open, gain: 1_000_000.0001 },
			{ ...open, gain: 1e39 },
			{ ...open, format: "cs16" },
			{ ...open, outputRateHz: 48_000.5 },
			{ ...open, outputRateHz: -1 },
			{ ...open, centerHz: Number.NaN },
			{ ...open, id: "a".repeat(65) },
			{ ...open, id: "é" },
			{ ...open, extra: 1 },
			{ v: 1, type: "mark-gap", atInputByte: -1 },
			{ v: 1, type: "mark-gap", atInputByte: 1.5 },
			{ v: 1, type: "mark-gap", id: "a" },
			{ v: 1, type: "shutdown", id: "a" },
			{ v: 2, type: "shutdown" },
			{ v: 1, type: "explode" },
		]
		for (const req of rejected)
			expect(() => encodeRequest(req as never), JSON.stringify(req)).toThrow(
				WaveKitError,
			)
	})

	// Feature: core-channelizer, Property 14: Protocol validity
	// Validates: addendum §11, §12.14
	it("parses every well-formed event and rejects malformed lines without throwing", () => {
		const id = fc.stringMatching(/^[A-Za-z0-9._-]{1,64}$/)
		const gen = fc.nat()
		const event = fc.oneof(
			fc.record({
				v: fc.constant(1),
				type: fc.constant("ready"),
				generation: gen,
				pid: fc.integer({ min: 1 }),
			}),
			fc.record({
				v: fc.constant(1),
				type: fc.constant("opened"),
				id,
				generation: gen,
				socket: fc.constant("/tmp/x.sock"),
				outputRateHz: fc.integer({ min: 1 }),
				format: fc.constantFrom("cu8", "cf32"),
				filterTaps: fc.nat(), // PF7: a pass-through channel has 0 taps
				groupDelaySamples: fc.double({ min: 0, max: 1e6, noNaN: true }),
			}),
			fc.record({
				v: fc.constant(1),
				type: fc.constant("rejected"),
				id: fc.string({ maxLength: 64 }), // PF7: echoed verbatim (truncated), "" for undecodable lines
				generation: gen,
				reasonCode: fc.constantFrom(
					"channel-outside-capture",
					"channel-request-invalid",
				),
				detail: fc.string(),
			}),
			fc.record({
				v: fc.constant(1),
				type: fc.constant("discontinuity"),
				id,
				generation: gen,
				sampleIndex: fc.nat(),
				droppedSamples: fc.nat(),
				cause: fc.constantFrom("queue-overflow", "input-gap"),
			}),
			fc.record({
				v: fc.constant(1),
				type: fc.constant("stats"),
				generation: gen,
				inputSamples: fc.nat(),
				channels: fc.array(
					fc.record({
						id,
						outputSamples: fc.nat(),
						queueHighWaterBytes: fc.nat(),
						droppedSamples: fc.nat(),
						saturatedSamples: fc.nat(),
					}),
					{ maxLength: 8 },
				),
			}),
			fc.record({
				v: fc.constant(1),
				type: fc.constant("closed"),
				id,
				generation: gen,
				reason: fc.constantFrom("requested", "client-gone"),
			}),
			fc.record({
				v: fc.constant(1),
				type: fc.constant("input-eof"),
				generation: gen,
				inputSamples: fc.nat(),
				discardedBytes: fc.constantFrom(0, 1),
			}),
			fc.record({
				v: fc.constant(1),
				type: fc.constant("progress"),
				generation: gen,
				inputSamples: fc.nat(),
				inputBytes: fc.nat(),
			}),
		)
		fc.assert(
			fc.property(event, e => {
				const r = parseEventLine(JSON.stringify(e))
				expect(r).toEqual({ ok: true, event: e })
			}),
			{ numRuns: 100 },
		)
		fc.assert(
			fc.property(fc.string(), s => {
				expect(() => parseEventLine(s)).not.toThrow()
			}),
			{ numRuns: 100 },
		)
		expect(
			parseEventLine('{"v":2,"type":"ready","generation":1,"pid":3}').ok,
		).toBe(false)
	})

	it("parses the exact lines native/wavekit-chan/src/runtime.rs emits (serde_json key order, 0.0 floats)", () => {
		const lines = [
			'{"generation":7,"pid":4242,"type":"ready","v":1}',
			'{"filterTaps":312,"format":"cf32","generation":7,"groupDelaySamples":30.5,"id":"a","outputRateHz":48000,"socket":"/tmp/wkc-1-0/a.sock","type":"opened","v":1}',
			'{"filterTaps":0,"format":"cu8","generation":7,"groupDelaySamples":0.0,"id":"full","outputRateHz":2048000,"socket":"/tmp/full.sock","type":"opened","v":1}',
			'{"detail":"invalid JSON: expected value at line 1 column 1","generation":7,"id":"","reasonCode":"channel-request-invalid","type":"rejected","v":1}',
			`{"detail":"id must match [A-Za-z0-9._-]{1,64}","generation":7,"id":"${"x".repeat(60)} !é","reasonCode":"channel-request-invalid","type":"rejected","v":1}`,
			'{"detail":"|Δf|+bw/2+tr=924000 exceeds usable half-span 819200","generation":7,"id":"far","reasonCode":"channel-outside-capture","type":"rejected","v":1}',
			'{"cause":"queue-overflow","droppedSamples":4800,"generation":7,"id":"a","sampleIndex":96000,"type":"discontinuity","v":1}',
			'{"cause":"input-gap","droppedSamples":0,"generation":7,"id":"a","sampleIndex":0,"type":"discontinuity","v":1}',
			'{"channels":[],"generation":7,"inputSamples":0,"type":"stats","v":1}',
			'{"channels":[{"droppedSamples":0,"id":"a","outputSamples":240000,"queueHighWaterBytes":96000,"saturatedSamples":3}],"generation":7,"inputSamples":10240000,"type":"stats","v":1}',
			'{"generation":7,"id":"a","reason":"requested","type":"closed","v":1}',
			'{"generation":7,"id":"a","reason":"client-gone","type":"closed","v":1}',
			'{"discardedBytes":1,"generation":7,"inputSamples":2048000,"type":"input-eof","v":1}',
			// Main-loop liveness after work, at most every 100 ms (`maybe_progress`).
			'{"generation":7,"inputBytes":8192,"inputSamples":4096,"type":"progress","v":1}',
			'{"generation":7,"inputBytes":3,"inputSamples":1,"type":"progress","v":1}',
			'{"generation":7,"inputBytes":0,"inputSamples":0,"type":"progress","v":1}',
		]
		for (const line of lines)
			expect(parseEventLine(line), line).toMatchObject({ ok: true })
	})

	it("rejects events outside the v1 schema", () => {
		const bad = [
			"",
			"null",
			"[1]",
			"5",
			'{"v":1}',
			'{"v":1,"type":"shutdown","generation":1}',
			'{"v":1,"type":"ready","generation":1,"pid":0}',
			'{"v":1,"type":"ready","generation":-1,"pid":3}',
			'{"v":1,"type":"ready","generation":1,"pid":3,"extra":true}',
			'{"v":1,"type":"opened","id":"a","generation":1,"socket":"","outputRateHz":48000,"format":"cf32","filterTaps":1,"groupDelaySamples":1}',
			'{"v":1,"type":"opened","id":"a","generation":1,"socket":"/s","outputRateHz":48000,"format":"cf32","filterTaps":-1,"groupDelaySamples":1}',
			'{"v":1,"type":"opened","id":"a","generation":1,"socket":"/s","outputRateHz":48000,"format":"cf32","filterTaps":1,"groupDelaySamples":null}',
			`{"v":1,"type":"rejected","id":"${"a".repeat(65)}","generation":1,"reasonCode":"channel-request-invalid","detail":""}`,
			'{"v":1,"type":"rejected","id":"a","generation":1,"reasonCode":"channelizer-unavailable","detail":""}',
			'{"v":1,"type":"discontinuity","id":"a","generation":1,"sampleIndex":0,"droppedSamples":0,"cause":"other"}',
			'{"v":1,"type":"closed","id":"bad id","generation":1,"reason":"requested"}',
			'{"v":1,"type":"input-eof","generation":1,"inputSamples":1.5,"discardedBytes":0}',
			'{"v":1,"type":"progress","generation":1}',
			'{"v":1,"type":"progress","generation":1,"inputSamples":-1,"inputBytes":0}',
			'{"v":1,"type":"progress","generation":1,"inputSamples":0}',
			'{"v":1,"type":"progress","generation":1,"inputSamples":0,"inputBytes":-1}',
			'{"v":1,"type":"progress","generation":1,"inputSamples":0,"inputBytes":1.5}',
			'{"v":1,"type":"progress","generation":1,"inputSamples":0,"inputBytes":0,"channels":[]}',
		]
		for (const line of bad) expect(parseEventLine(line).ok, line).toBe(false)
	})
})

describe("private observed protocol compatibility", () => {
	it("keeps ordinary bytes while extending only observed opens", () => {
		const ordinary = encodeRequest(open)
		const observed = JSON.parse(
			encodeObservedRequest(open, "18446744073709551615"),
		) as Record<string, unknown>
		expect(observed).toEqual({
			...open,
			type: "open-observed",
			token: "18446744073709551615",
		})
		expect(encodeRequest(open)).toBe(ordinary)
		for (const token of ["0", "01", "-1", "1.0", "18446744073709551616"])
			expect(() => encodeObservedRequest(open, token)).toThrow(WaveKitError)
	})

	it("uses the same open validation for ordinary and observed requests", () => {
		for (const patch of [
			{ gain: MIN_GAIN },
			{ gain: MAX_GAIN },
			{ queueBytes: 2 },
			{ format: "cf32", queueBytes: 8 },
			{ id: "x".repeat(64) },
		]) {
			const request = { ...open, ...patch } as ChannelizerRequest
			expect(() => encodeRequest(request)).not.toThrow()
			expect(() =>
				encodeObservedRequest(request as typeof open, "1"),
			).not.toThrow()
		}
		for (const patch of [
			{ format: "cf32", gain: 1 },
			{ queueBytes: 1 },
			{ gain: 0 },
			{ centerHz: Infinity },
			{ extra: true },
			{ outputRateHz: 1.5 },
		]) {
			const request = { ...open, ...patch }
			expect(() => encodeRequest(request as never)).toThrow(WaveKitError)
			expect(() => encodeObservedRequest(request as never, "1")).toThrow(
				WaveKitError,
			)
		}
	})

	it("accepts capability only in the private parser and retains ordinary event parity", () => {
		const ordinary = '{"v":1,"type":"ready","generation":1,"pid":42}'
		const observed =
			'{"v":1,"type":"ready","generation":1,"pid":42,"observerCapability":"attempt-disposal-v1"}'
		expect(parseObservedEventLine(ordinary)).toEqual(parseEventLine(ordinary))
		expect(parseEventLine(observed).ok).toBe(false)
		expect(parseObservedEventLine(observed)).toMatchObject({
			ok: true,
			event: { observerCapability: "attempt-disposal-v1" },
		})
		for (const line of [
			observed.replace("attempt-disposal-v1", "unknown"),
			observed.replace('"v":1', '"v":1,"extra":true'),
		])
			expect(parseObservedEventLine(line).ok).toBe(false)
		const rejected =
			'{"v":1,"type":"rejected","generation":1,"id":"a","reasonCode":"channel-request-invalid","detail":"busy"}'
		expect(parseObservedEventLine(rejected)).toEqual(parseEventLine(rejected))
	})
})

it("encodes IQ retunes and accepts retuned and admission refusal replies", () => {
	const request = {
		v: 1,
		type: "retune",
		channelId: "a",
		centerHz: 162e6,
	} as const
	expect(JSON.parse(encodeRequest(request))).toEqual(request)
	for (const event of [
		{ v: 1, generation: 1, type: "retuned", channelId: "a", centerHz: 162e6 },
		{
			v: 1,
			generation: 1,
			type: "refused",
			channelId: "a",
			reason: "admission",
		},
	])
		expect(parseEventLine(JSON.stringify(event))).toEqual({ ok: true, event })
	expect(
		parseEventLine(
			JSON.stringify({
				v: 1,
				generation: 1,
				type: "refused",
				channelId: "a",
				reason: "other",
			}),
		).ok,
	).toBe(false)
})
