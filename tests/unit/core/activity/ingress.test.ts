import { Writable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import pino, { type Logger } from "pino"
import { createActivityIngress } from "../../../../src/core/activity/ingress.js"
import type { DecodeEnvelope } from "../../../../src/core/activity/types.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"

const producedAt = new Date("2026-10-12T00:00:00.000Z")

function output(
	data: unknown = { icao: "abc123" },
	decoder = "adsb-1",
): DecoderOutput {
	return {
		timestamp: new Date(producedAt),
		decoder,
		type: "aircraft",
		data,
	}
}

function captureLogger(): {
	logger: Logger
	lines: Array<Record<string, unknown>>
} {
	const lines: Array<Record<string, unknown>> = []
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			for (const line of chunk.toString().split("\n")) {
				if (line.trim() !== "")
					lines.push(JSON.parse(line) as Record<string, unknown>)
			}
			callback()
		},
	})
	return { logger: pino({ level: "warn" }, stream), lines }
}

describe("activity ingress", () => {
	it("publishes one envelope with a single id, clock and null provenance", () => {
		const receivedAt = new Date("2026-10-12T00:00:01.000Z")
		const envelopes: DecodeEnvelope[] = []
		let ids = 0
		let clocks = 0
		const ingress = createActivityIngress({
			sink: (_envelope, present) => {
				envelopes.push(present())
			},
			logger: captureLogger().logger,
			now: () => {
				clocks++
				return new Date(receivedAt)
			},
			randomUUID: () => {
				ids++
				return "evt-1"
			},
		})

		ingress.publish(
			"adsb-1",
			"readsb",
			output({ frequency: 1090e6, sourceId: "rtl" }),
		)

		expect(ids).toBe(1)
		expect(clocks).toBe(1)
		expect(envelopes).toHaveLength(1)
		expect(envelopes[0]).toMatchObject({
			version: 1,
			eventId: "evt-1",
			producedAt: producedAt.toISOString(),
			receivedAt: receivedAt.toISOString(),
			decoderId: "adsb-1",
			decoderType: "readsb",
			outputType: "aircraft",
			protocol: "adsb",
			category: "aircraft",
			entityKey: null,
			title: null,
			fields: [],
			provenance: { sourceId: null, frequency: null },
			decodedData: { frequency: 1090e6, sourceId: "rtl" },
		})
		expect(envelopes[0]).not.toHaveProperty("refs")
		expect(ingress.counters()).toEqual({
			published: 1,
			buildFailures: 0,
			sinkFailures: 0,
			presentationFailures: 0,
			provenanceFailures: 0,
		})
	})

	it("omits decoderType when the publisher has none", () => {
		const envelopes: DecodeEnvelope[] = []
		const ingress = createActivityIngress({
			sink: (_envelope, present) => {
				envelopes.push(present())
			},
			logger: captureLogger().logger,
			now: () => new Date("2026-10-12T00:00:01.000Z"),
			randomUUID: () => "evt-2",
		})
		ingress.publish("adsb-1", undefined, output())
		expect(envelopes[0]?.decoderId).toBe("adsb-1")
		expect(envelopes[0]).not.toHaveProperty("decoderType")
	})

	it("uses crypto.randomUUID and the current clock by default", () => {
		const before = Date.now()
		const envelopes: DecodeEnvelope[] = []
		const ingress = createActivityIngress({
			sink: (_envelope, present) => {
				envelopes.push(present())
			},
			logger: captureLogger().logger,
		})
		ingress.publish("adsb-1", "readsb", output())
		const envelope = envelopes[0]
		expect(envelope?.eventId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		)
		expect(Date.parse(envelope?.receivedAt ?? "")).toBeGreaterThanOrEqual(
			before,
		)
		expect(Date.parse(envelope?.receivedAt ?? "")).toBeLessThanOrEqual(
			Date.now(),
		)
	})

	it("counts envelope build failures and does not call the sink", () => {
		const sink = vi.fn()
		const { logger, lines } = captureLogger()
		const ingress = createActivityIngress({
			sink,
			logger,
			now: () => new Date("2026-10-12T00:00:01.000Z"),
			randomUUID: () => "evt-bad",
		})
		expect(() =>
			ingress.publish("other-decoder", "readsb", output()),
		).not.toThrow()
		expect(sink).not.toHaveBeenCalled()
		expect(ingress.counters()).toEqual({
			published: 0,
			buildFailures: 1,
			sinkFailures: 0,
			// A reception that cannot be built is never presented (1.7):
			// only the presentation-free build failure counts.
			presentationFailures: 0,
			provenanceFailures: 0,
		})
		expect(lines).toHaveLength(1)
		expect(lines[0]).toMatchObject({
			component: "ActivityIngress",
			decoderId: "other-decoder",
			failure: "build",
		})
	})

	it("counts sink failures, allocates the id once and does not rethrow", () => {
		let ids = 0
		let clocks = 0
		const ingress = createActivityIngress({
			sink: () => {
				throw new Error("store full")
			},
			logger: captureLogger().logger,
			now: () => {
				clocks++
				return new Date("2026-10-12T00:00:01.000Z")
			},
			randomUUID: () => {
				ids++
				return `evt-${ids}`
			},
		})
		expect(() => ingress.publish("adsb-1", "readsb", output())).not.toThrow()
		expect(ids).toBe(1)
		expect(clocks).toBe(1)
		expect(ingress.counters()).toEqual({
			published: 0,
			buildFailures: 0,
			sinkFailures: 1,
			presentationFailures: 0,
			provenanceFailures: 0,
		})
		ingress.publish("adsb-1", "readsb", output())
		expect(ids).toBe(2)
		expect(ingress.counters().sinkFailures).toBe(2)
	})

	it("logs a decoder at most once per minute across failure kinds", () => {
		let at = Date.parse("2026-10-12T00:00:00.000Z")
		const { logger, lines } = captureLogger()
		const ingress = createActivityIngress({
			sink: () => {
				throw new Error("store full")
			},
			logger,
			now: () => new Date(at),
			randomUUID: () => "evt-1",
		})
		ingress.publish("adsb-1", "readsb", output())
		at += 1_000
		ingress.publish("adsb-1", "readsb", output({}, "mismatch"))
		at += 1_000
		ingress.publish("other-decoder", "readsb", output({}, "other-decoder"))
		expect(lines.map(line => line["decoderId"])).toEqual([
			"adsb-1",
			"other-decoder",
		])
		expect(lines.map(line => line["failure"])).toEqual(["sink", "sink"])
		at = Date.parse("2026-10-12T00:00:00.000Z") + 60_000
		ingress.publish("adsb-1", "readsb", output())
		expect(lines.map(line => line["decoderId"])).toEqual([
			"adsb-1",
			"other-decoder",
			"adsb-1",
		])
		expect(ingress.counters()).toMatchObject({
			buildFailures: 1,
			sinkFailures: 3,
		})
	})

	it("still counts when the logger throws", () => {
		const logger = {
			child() {
				return this
			},
			warn() {
				throw new Error("log broke")
			},
		} as unknown as Logger
		const ingress = createActivityIngress({
			sink: () => {
				throw new Error("store full")
			},
			logger,
			now: () => new Date("2026-10-12T00:00:01.000Z"),
			randomUUID: () => "evt-1",
		})
		expect(() => ingress.publish("adsb-1", "readsb", output())).not.toThrow()
		expect(ingress.counters().sinkFailures).toBe(1)
	})
})

describe("activity ingress provenance (WG3 req 5)", () => {
	function acars(frequency: unknown): DecoderOutput {
		return {
			timestamp: new Date(producedAt),
			decoder: "acars-1",
			type: "acars",
			data: { frequency, text: "HELLO", tail: ".N123" },
		}
	}

	function run(
		lookup: Parameters<typeof createActivityIngress>[0]["resolveProvenance"],
		out: DecoderOutput,
		decoderType = "acarsdec",
	) {
		const plain: DecodeEnvelope[] = []
		const presented: DecodeEnvelope[] = []
		const ingress = createActivityIngress({
			sink: (envelope, present) => {
				plain.push(envelope)
				presented.push(present())
			},
			logger: captureLogger().logger,
			...(lookup === undefined ? {} : { resolveProvenance: lookup }),
		})
		ingress.publish(out.decoder, decoderType, out)
		return { plain, presented, counters: ingress.counters() }
	}

	const binding = {
		sourceId: "rtl-0",
		targetFrequenciesHz: [131_550_000],
		tuningTrust: "unverified" as const,
	}

	it("sets source and payload frequency without changing decodedData or presentation", () => {
		const baseline = run(null, acars(131_725_000))
		const { presented, counters } = run(() => binding, acars(131_725_000))
		expect(presented[0]?.provenance).toEqual({
			sourceId: "rtl-0",
			frequency: {
				hz: 131_725_000,
				basis: "channel",
				tuningTrust: "unverified",
			},
		})
		expect(presented[0]?.decodedData).toEqual(
			baseline.presented[0]?.decodedData,
		)
		expect(presented[0]?.title).toEqual(baseline.presented[0]?.title)
		expect(presented[0]?.fields).toEqual(baseline.presented[0]?.fields)
		expect(counters.provenanceFailures).toBe(0)
	})

	it("without a lookup keeps the payload frequency with a null source", () => {
		const { presented } = run(undefined, acars(131_550_000))
		expect(presented[0]?.provenance).toEqual({
			sourceId: null,
			frequency: {
				hz: 131_550_000,
				basis: "channel",
				tuningTrust: "unverified",
			},
		})
	})

	it("a multi-target binding without payload frequency gives null frequency", () => {
		const { presented } = run(
			() => ({ ...binding, targetFrequenciesHz: [1, 2] }),
			acars(undefined),
		)
		expect(presented[0]?.provenance).toEqual({
			sourceId: "rtl-0",
			frequency: null,
		})
	})

	it("a throwing lookup keeps the reception with null provenance and counts it", () => {
		const { presented, counters } = run(() => {
			throw new Error("boom")
		}, acars(131_550_000))
		expect(presented).toHaveLength(1)
		expect(presented[0]?.provenance).toEqual({
			sourceId: null,
			frequency: null,
		})
		expect(counters).toMatchObject({
			published: 1,
			buildFailures: 0,
			provenanceFailures: 1,
		})
	})

	it("a throwing lookup on a reception that fails to build counts only the build failure", () => {
		const out: DecoderOutput = {
			...acars(131_550_000),
			timestamp: new Date(Number.NaN),
		}
		const { plain, counters } = run(() => {
			throw new Error("boom")
		}, out)
		expect(plain).toHaveLength(0)
		expect(counters).toMatchObject({
			published: 0,
			buildFailures: 1,
			provenanceFailures: 0,
		})
	})

	it("an envelope rejected because of provenance is rebuilt with null provenance", () => {
		const { presented, counters } = run(
			() => ({ ...binding, sourceId: "x".repeat(129) }),
			acars(131_550_000),
		)
		expect(presented[0]?.provenance).toEqual({
			sourceId: null,
			frequency: null,
		})
		expect(counters).toMatchObject({
			published: 1,
			buildFailures: 0,
			provenanceFailures: 1,
		})
	})

	it("a throwing payload getter is guarded and counted once", () => {
		const data = { text: "x" }
		Object.defineProperty(data, "frequency", {
			enumerable: false,
			get() {
				throw new Error("getter")
			},
		})
		const { presented, counters } = run(() => binding, {
			...acars(0),
			data,
		})
		// Provenance must not add a throw. Its failure counts only when the
		// reception is kept; a reception the builder drops is a build failure.
		expect(presented).toHaveLength(counters.published)
		expect(counters.published + counters.buildFailures).toBe(1)
		expect(counters.provenanceFailures).toBe(counters.published)
	})

	it("only a failed rebuild counts as a build failure", () => {
		const { plain, counters } = run(
			() => binding,
			acars(Number.NaN),
			"acarsdec",
		)
		// decodedData with NaN may or may not build; either way nothing is double-counted.
		expect(counters.buildFailures + counters.published).toBe(1)
		expect(plain.length).toBe(counters.published)
	})

	it("a build failing for another reason is not a provenance failure", () => {
		const { counters } = run(() => binding, {
			...acars(131_550_000),
			timestamp: new Date(Number.NaN),
		})
		expect(counters).toMatchObject({ published: 0, buildFailures: 1 })
		expect(counters.provenanceFailures).toBe(0)
	})
})
