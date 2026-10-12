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
			sink: envelope => {
				envelopes.push(envelope)
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
			protocol: null,
			category: "other",
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
		})
	})

	it("omits decoderType when the publisher has none", () => {
		const envelopes: DecodeEnvelope[] = []
		const ingress = createActivityIngress({
			sink: envelope => {
				envelopes.push(envelope)
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
			sink: envelope => {
				envelopes.push(envelope)
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
