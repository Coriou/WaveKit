import { describe, expect, it } from "vitest"
import pino from "pino"
import { createDecodeEnvelope } from "../../../../../src/core/activity/envelope.js"
import { createActivityIngress } from "../../../../../src/core/activity/ingress.js"
import { MAX_ENVELOPE_BYTES } from "../../../../../src/core/activity/projection.js"
import { presentDecoderOutput } from "../../../../../src/core/activity/presentation/registry.js"
import { parseStoredSummary } from "../../../../../src/core/activity/storage/row.js"
import type {
	DecodeEnvelope,
	DecodeEnvelopeContext,
} from "../../../../../src/core/activity/types.js"
import type { DecoderOutput } from "../../../../../src/decoders/types.js"
import { decoderOutput } from "./measure.js"

const RECEIVED = new Date("2026-10-13T00:00:00.000Z")

function context(output: DecoderOutput): DecodeEnvelopeContext {
	return {
		eventId: "evt-failure",
		receivedAt: RECEIVED,
		decoderId: output.decoder,
		decoderType: "measure",
		provenance: { sourceId: null, frequency: null },
	}
}

function byteSize(
	output: DecoderOutput,
	presented: boolean,
): number | undefined {
	try {
		const view = presented ? presentDecoderOutput(output, "measure") : undefined
		const envelope =
			view === undefined
				? createDecodeEnvelope(output, context(output))
				: createDecodeEnvelope(output, context(output), view)
		return Buffer.byteLength(JSON.stringify(envelope), "utf8")
	} catch {
		return undefined
	}
}

function padded(tail: number): DecoderOutput {
	return decoderOutput("aircraft", {
		icao: "abcdef",
		p0: "x".repeat(32_768),
		p1: "x".repeat(32_768),
		p2: "x".repeat(32_768),
		p3: "y".repeat(tail),
	})
}

/** Pad until the plain envelope fits and the presented one does not. */
function oversizeAircraft(): DecoderOutput {
	const small = decoderOutput("aircraft", { icao: "abcdef" })
	const plainSmall = byteSize(small, false)
	const presentedSmall = byteSize(small, true)
	expect(plainSmall).toBeTypeOf("number")
	expect(presentedSmall).toBeTypeOf("number")
	expect(presentedSmall! - plainSmall!).toBeGreaterThan(0)
	let lo = 0
	let hi = 32_768
	let bestPlain: number | undefined
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const plain = byteSize(padded(mid), false)
		if (plain === undefined) hi = mid - 1
		else {
			bestPlain = mid
			lo = mid + 1
		}
	}
	if (bestPlain === undefined)
		throw new Error("no aircraft payload fits under the envelope cap")
	for (let tail = bestPlain; tail >= Math.max(0, bestPlain - 800); tail--) {
		const output = padded(tail)
		if (
			byteSize(output, false) !== undefined &&
			byteSize(output, true) === undefined
		)
			return output
	}
	throw new Error(
		`presentation did not cross ${MAX_ENVELOPE_BYTES} at tail ${bestPlain} (plain ${byteSize(padded(bestPlain), false)}, presented ${byteSize(padded(bestPlain), true)})`,
	)
}

describe("activity presentation failure paths", () => {
	it("stores a reception when the presentation makes the envelope too big", () => {
		const output = oversizeAircraft()
		const published: DecodeEnvelope[] = []
		const ingress = createActivityIngress({
			sink: envelope => {
				published.push(envelope)
			},
			logger: pino({ level: "silent" }),
			now: () => RECEIVED,
			randomUUID: () => "evt-failure",
		})
		ingress.publish(output.decoder, "measure", output)
		expect(published).toHaveLength(1)
		const plain = createDecodeEnvelope(output, {
			...context(output),
			decoderType: "measure",
		})
		expect(published[0]).toEqual(plain)
		expect(ingress.counters()).toEqual({
			published: 1,
			buildFailures: 0,
			sinkFailures: 0,
			presentationFailures: 1,
		})
	})

	it("does not throw when a payload getter throws, and the envelope still rejects it", () => {
		const data: Record<string, unknown> = {}
		let reads = 0
		Object.defineProperty(data, "icao", {
			enumerable: true,
			get() {
				reads++
				throw new Error("getter")
			},
		})
		const output = decoderOutput("aircraft", data)
		expect(presentDecoderOutput(output, "readsb")).toBeUndefined()
		expect(reads).toBeGreaterThan(0)
		const published: DecodeEnvelope[] = []
		const ingress = createActivityIngress({
			sink: envelope => {
				published.push(envelope)
			},
			logger: pino({ level: "silent" }),
			now: () => RECEIVED,
			randomUUID: () => "evt-getter",
		})
		expect(() =>
			ingress.publish(output.decoder, "readsb", output),
		).not.toThrow()
		expect(published).toHaveLength(0)
		expect(ingress.counters().buildFailures).toBe(1)
		expect(ingress.counters().presentationFailures).toBe(0)
	})

	it("publishes an unknown output type with no presentation", () => {
		const output = decoderOutput("stats", { messages: 1 })
		expect(presentDecoderOutput(output, "readsb")).toBeUndefined()
		const published: DecodeEnvelope[] = []
		const ingress = createActivityIngress({
			sink: envelope => {
				published.push(envelope)
			},
			logger: pino({ level: "silent" }),
			now: () => RECEIVED,
			randomUUID: () => "evt-stats",
		})
		ingress.publish(output.decoder, "readsb", output)
		expect(published[0]).toMatchObject({
			category: "other",
			protocol: null,
			entityKey: null,
			title: null,
			fields: [],
			decodedData: { messages: 1 },
		})
		expect(ingress.counters().presentationFailures).toBe(0)
	})

	it("parses a pre-WG2 summary and leaves a stored invalid key as text", () => {
		const base = {
			eventId: "pre-wg2",
			kind: "decoder-reception",
			producedAt: "2026-10-01T00:00:00.000Z",
			receivedAt: "2026-10-01T00:00:00.000Z",
			decoderId: "adsb-1",
			sourceId: null,
			protocol: null,
			category: "other",
			frequencyHz: null,
			title: null,
			fields: [],
		}
		const stored = parseStoredSummary({
			seq: "4",
			event_id: "pre-wg2",
			kind: "decoder-reception",
			summary_json: JSON.stringify({ ...base, entityKey: null }),
			record_json: "{}",
		})
		expect(stored.category).toBe("other")
		expect(stored.entityKey).toBeNull()
		expect(stored.commitSeq).toBe("4")
		const invalid = parseStoredSummary({
			seq: "5",
			event_id: "pre-wg2",
			kind: "decoder-reception",
			summary_json: JSON.stringify({
				...base,
				entityKey: "not a key",
				position: { lat: "north", lon: 1 },
			}),
			record_json: "{}",
		})
		expect(invalid.entityKey).toBe("not a key")
		expect(invalid.position).toBeUndefined()
	})
})
