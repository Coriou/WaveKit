import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { WaveKitError } from "../../../src/utils/errors.js"
import {
	MAX_QUEUE_BYTES,
	PROTOCOL_VERSION,
	encodeRequest,
	parseEventLine,
} from "../../../src/core/channelizer/protocol.js"
import type { ChannelizerRequest } from "../../../src/core/channelizer/protocol.js"
import { channelisedRatePlan } from "../../../src/core/channelizer/rate-plan.js"

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
		const accepted: ChannelizerRequest[] = [
			open,
			{ ...open, queueBytes: MAX_QUEUE_BYTES },
			{ ...open, queueBytes: 2 },
			{ ...open, format: "cf32", queueBytes: 8 },
			{ ...open, gain: 2.5 },
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
		]
		for (const line of bad) expect(parseEventLine(line).ok, line).toBe(false)
	})

	it("marks a channelised plan as resample at the realised rate", () => {
		const plan = channelisedRatePlan(
			{
				verdict: "best",
				adaptation: "integer-decimation",
				frontendRateHz: 47_627.9,
			},
			{ outputRateHz: 48_000, format: "cf32", groupDelaySamples: 30 },
		)
		expect(plan).toMatchObject({
			verdict: "best",
			adaptation: "resample",
			frontendRateHz: 48_000,
		})
	})
})
