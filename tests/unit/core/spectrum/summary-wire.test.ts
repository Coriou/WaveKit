import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { SPECTRUM_SUMMARY_BINS_MAX } from "@wavekit/api-types"
import {
	decodeEventsFromWire,
	wireEventProblem,
	decodeSummaryBins,
	encodeEventsForWire,
	encodeSummaryBins,
} from "../../../../src/core/spectrum/summary-wire.js"
import {
	PipelineConfigSchema,
	WorkerToMainSchema,
} from "../../../../src/core/spectrum/worker-protocol.js"
import { InlinePipelineHost } from "../../../../src/core/spectrum/pipeline-host.js"
import { buildPipelineConfig } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	BlockSummary,
	PipelineEvent,
} from "../../../../src/core/spectrum/types.js"
import {
	gaussianNoise,
	mulberry32,
	packCu8,
} from "../../../mocks/scanner/signals.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

function summary(bins: number[]): BlockSummary {
	return {
		sourceId: "rtl",
		stream: 0,
		epoch: 1,
		endSample: 1024,
		centreHz: 100e6,
		sampleRateHz: 2.048e6,
		binHz: 250,
		startHz: 99e6,
		bins,
		floorDbfs: -90,
		thresholdDb: 6,
		tracks: [],
		masks: { dcHz: 100e6, dcGuardHz: 1000, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	} as BlockSummary
}

/** Worker post → structured clone with transfer → host validate + decode. */
function roundTrip(events: PipelineEvent[]): PipelineEvent[] {
	const transfer: ArrayBuffer[] = []
	encodeEventsForWire(events, transfer)
	const cloned: unknown = structuredClone(
		{ type: "events", events },
		{ transfer },
	)
	for (const b of transfer) expect(b.byteLength).toBe(0)
	const parsed = WorkerToMainSchema.safeParse(cloned)
	if (!parsed.success) throw parsed.error
	if (parsed.data.type !== "events") throw new Error("not events")
	decodeEventsFromWire(parsed.data.events)
	return parsed.data.events
}

const value = fc.oneof(
	{
		weight: 8,
		arbitrary: fc.integer({ min: -32768, max: 32767 }).map(i => i / 2),
	},
	{
		weight: 2,
		arbitrary: fc.constantFrom(
			Infinity,
			-Infinity,
			NaN,
			-0,
			0,
			16383.5,
			-16384,
			16384,
			-16384.5,
			0.25,
			-120.3,
		),
	},
	{ weight: 1, arbitrary: fc.double() },
)

describe("summary wire codec", () => {
	// Feature: web-gaps-8, Property 11: Lossless wire
	// Validates: Requirements 5.1
	it("host bins are Object.is-equal to worker bins for random summaries", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.array(value, { minLength: 1, maxLength: 64 }),
					fc.array(value, {
						minLength: 1,
						maxLength: SPECTRUM_SUMMARY_BINS_MAX,
					}),
					// Mostly-exact long summaries so the int16 path is exercised at length.
					fc
						.array(fc.integer({ min: -32768, max: 32767 }), {
							minLength: 1,
							maxLength: SPECTRUM_SUMMARY_BINS_MAX,
						})
						.map(a => a.map(i => i / 2)),
				),
				bins => {
					const expected = bins.slice()
					const out = roundTrip([
						{ kind: "block-summary", summary: summary(bins) },
					])
					expect(out).toHaveLength(1)
					const ev = out[0]!
					expect(Object.keys(ev).sort()).toEqual(["kind", "summary"])
					if (ev.kind !== "block-summary") throw new Error("kind")
					const got = ev.summary.bins
					expect(got.length).toBe(expected.length)
					for (let i = 0; i < expected.length; i++)
						if (!Object.is(got[i], expected[i]))
							throw new Error(`bin ${i}: ${got[i]} vs ${expected[i]}`)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("encodes exactly the 0.5 dB grid in int16 range and refuses the rest", () => {
		expect(Array.from(encodeSummaryBins([16383.5, -16384, 0, -0.5])!)).toEqual([
			32767, -32768, 0, -1,
		])
		for (const bad of [16384, -16384.5, NaN, Infinity, -Infinity, 0.25, -0])
			expect(encodeSummaryBins([1, bad])).toBeNull()
		expect(encodeSummaryBins([])).toBeNull()
		expect(decodeSummaryBins(Int16Array.of(-181, 0, 3))).toEqual([
			-90.5, 0, 1.5,
		])
	})

	it("-0 from today's rounding (Math.round(-0.2*2)/2) falls back to number[]", () => {
		const m = Math.round(-0.2 * 2) / 2
		expect(Object.is(m, -0)).toBe(true)
		const out = roundTrip([
			{ kind: "block-summary", summary: summary([-50, m]) },
		])
		const ev = out[0]!
		if (ev.kind !== "block-summary") throw new Error("kind")
		expect(Object.is(ev.summary.bins[1], -0)).toBe(true)
	})

	it("non-summary events pass through untouched", () => {
		const events = [{ kind: "stats" } as unknown as PipelineEvent]
		const transfer: ArrayBuffer[] = []
		encodeEventsForWire(events, transfer)
		expect(transfer).toHaveLength(0)
		expect(events[0]).toEqual({ kind: "stats" })
	})
})

describe("host boundary refuses malformed wire summaries", () => {
	function wire(over: Record<string, unknown>): unknown {
		return {
			type: "events",
			events: [
				{
					kind: "block-summary",
					summary: summary([]),
					binsEncoding: "i16-half-db",
					binsI16: new Int16Array(4),
					binCount: 4,
					...over,
				},
			],
		}
	}

	it("accepts a well-formed wire summary", () => {
		expect(WorkerToMainSchema.safeParse(wire({})).success).toBe(true)
	})

	it.each([
		["unknown flag", { binsEncoding: "f16" }],
		["missing flag", { binsEncoding: undefined }],
		["length mismatch", { binCount: 5 }],
		["zero count", { binsI16: new Int16Array(0), binCount: 0 }],
		[
			"over the cap",
			{
				binsI16: new Int16Array(SPECTRUM_SUMMARY_BINS_MAX + 1),
				binCount: SPECTRUM_SUMMARY_BINS_MAX + 1,
			},
		],
		["Uint16Array", { binsI16: new Uint16Array(4) }],
		["Float32Array", { binsI16: new Float32Array(4) }],
		["number[]", { binsI16: [0, 0, 0, 0] }],
		["non-empty bins", { summary: summary([1, 2, 3, 4]) }],
		["wire on non-summary", { kind: "stats" }],
	])("refuses %s", (_name, over) => {
		expect(WorkerToMainSchema.safeParse(wire(over)).success).toBe(false)
	})

	it("refuses a bare wire field without a flag", () => {
		const msg = {
			type: "events",
			events: [{ kind: "block-summary", summary: summary([]), binCount: 1 }],
		}
		expect(WorkerToMainSchema.safeParse(msg).success).toBe(false)
	})
})

describe("wire decode and problems (review fixes)", () => {
	it("decode strips the wire fields in place on the same event object", () => {
		const ev: PipelineEvent = {
			kind: "block-summary",
			summary: summary([-1, 0.5, 2]),
		}
		const events = [ev]
		encodeEventsForWire(events, [])
		decodeEventsFromWire(events)
		expect(events[0]).toBe(ev)
		expect(Object.keys(ev).sort()).toEqual(["kind", "summary"])
		expect(ev.kind === "block-summary" && ev.summary.bins).toEqual([-1, 0.5, 2])
	})

	it("problem messages never echo a hostile encoding or count", () => {
		const hostile = "<script>evil-ENCODING-1234</script>"
		const base = {
			kind: "block-summary",
			summary: summary([]),
			binsEncoding: "i16-half-db",
			binsI16: new Int16Array(4),
			binCount: 4,
		}
		const enc = wireEventProblem({ ...base, binsEncoding: hostile }, 8192)
		expect(enc).toBe("unknown wire bins encoding")
		expect(enc).not.toContain("evil")
		const count = wireEventProblem(
			{ ...base, binCount: { toString: () => hostile } },
			8192,
		)
		expect(count).toBe("invalid wire bin count")
		expect(count).not.toContain("evil")
		const huge = wireEventProblem({ ...base, binCount: 1234567 }, 8192)
		expect(huge).not.toContain("1234567")
		const mismatch = wireEventProblem({ ...base, binCount: 5 }, 8192)
		expect(mismatch).toBe("wire bins length does not match binCount")
	})
})

describe("protocol summary cap", () => {
	const base = buildPipelineConfig(
		"rtl",
		"U8_IQ",
		1_024_000,
		testSettings(),
		{
			fftSize: null,
			integrationMs: null,
			thresholdDb: null,
			sensitivity: null,
		},
		undefined,
		2048,
	)
	it("accepts spectrumBins up to SPECTRUM_SUMMARY_BINS_MAX and refuses one more", () => {
		expect(SPECTRUM_SUMMARY_BINS_MAX).toBe(8192)
		expect(
			PipelineConfigSchema.safeParse({ ...base, spectrumBins: 8192 }).success,
		).toBe(true)
		expect(
			PipelineConfigSchema.safeParse({ ...base, spectrumBins: 8193 }).success,
		).toBe(false)
	})
})

describe("inline host", () => {
	it("keeps number[] bins and no wire fields", () => {
		const fs = 1_024_000
		const cfg = buildPipelineConfig(
			"rtl",
			"U8_IQ",
			fs,
			testSettings(),
			{
				fftSize: null,
				integrationMs: null,
				thresholdDb: null,
				sensitivity: null,
			},
			undefined,
			2048,
		)
		const events: PipelineEvent[] = []
		const host = new InlinePipelineHost(cfg, {
			events: evs => events.push(...evs),
			buffer: () => undefined,
			error: err => {
				throw err
			},
		})
		host.send({ kind: "spectrum-feed", enabled: true })
		host.send({
			kind: "new-stream",
			stream: 0,
			centreHz: 446_100_000,
			sampleRateHz: fs,
			gainKey: "m:296",
			tuningTrust: "commanded",
		})
		const iq = gaussianNoise(mulberry32(7), fs / 2, 0.05)
		host.send({ kind: "bytes", startSample: 0, bytes: packCu8(iq.re, iq.im) })
		const summaries = events.filter(e => e.kind === "block-summary")
		expect(summaries.length).toBeGreaterThan(0)
		for (const ev of summaries) {
			expect(Object.keys(ev).sort()).toEqual(["kind", "summary"])
			if (ev.kind !== "block-summary") continue
			expect(Array.isArray(ev.summary.bins)).toBe(true)
			expect(ev.summary.bins.length).toBeGreaterThan(0)
		}
		void host.close()
	})
})
