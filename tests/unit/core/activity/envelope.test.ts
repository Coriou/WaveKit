import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import {
	createDecodeEnvelope,
	validateDecodeEnvelope,
	withPresentation,
} from "../../../../src/core/activity/envelope.js"
import { parseAcarsdecJson } from "../../../../src/decoders/builtin/acarsdec.js"
import { parseDumpvdl2Json } from "../../../../src/decoders/builtin/dumpvdl2.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"
import type {
	DecodeEnvelopeContext,
	DecodePresentation,
} from "../../../../src/core/activity/types.js"

const producedAt = new Date("2026-10-10T00:00:00.000Z")
const receivedAt = new Date("2026-10-10T00:00:01.000Z")
function output(
	data: unknown,
	type: DecoderOutput["type"] = "message",
): DecoderOutput {
	return { timestamp: new Date(producedAt), decoder: "receiver-1", type, data }
}
function context(eventId = "reception-1"): DecodeEnvelopeContext {
	return { eventId, decoderId: "receiver-1", receivedAt: new Date(receivedAt) }
}
function wire(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value)) as unknown
}
function nested(depth: number): unknown {
	let value: unknown = null
	for (let i = 0; i < depth; i++) value = [value]
	return value
}
function nodes(count: number): unknown[] {
	// One root +16 containers + count-17 scalar positions.
	const scalars = count - 17
	return Array.from({ length: 16 }, (_v, i) =>
		Array.from(
			{ length: Math.min(256, Math.max(0, scalars - i * 256)) },
			() => 0,
		),
	)
}

describe("unmounted decoder event envelope", () => {
	it.each([
		"aircraft",
		"marine",
		"aviation-data",
		"voice",
		"paging",
		"aprs",
		"sensors",
		"mesh",
		"other",
	] as const)("accepts brand category %s", category => {
		const envelope = createDecodeEnvelope(output({}), context(), { category })
		expect(validateDecodeEnvelope(wire(envelope)).category).toBe(category)
	})
	it("preserves explicit entity and position without inference or shared references", () => {
		const position = { lat: 48, lon: 2, altM: 100 }
		const envelope = createDecodeEnvelope(
			output({ lat: 0, icao: "abc123" }),
			context(),
			{ entityKey: "icao:ABC123", position },
		)
		expect(envelope.entityKey).toBe("icao:ABC123")
		position.lat = 0
		expect(envelope.position).toEqual({ lat: 48, lon: 2, altM: 100 })
		expect(validateDecodeEnvelope(wire(envelope))).toEqual(envelope)
		const unknown = createDecodeEnvelope(
			output({ lat: 48, lon: 2, mmsi: 123 }),
			context(),
		)
		expect(unknown.entityKey).toBeNull()
		expect(unknown).not.toHaveProperty("position")
	})
	it("rejects retired categories and malformed entity/position", () => {
		const envelope = createDecodeEnvelope(output({}), context())
		for (const patch of [
			{ category: "pager" },
			{ category: "data" },
			{ entityKey: "icao" },
			{ entityKey: "icao:" },
			{ entityKey: ":value" },
			{ position: { lat: 91, lon: 0 } },
			{ position: { lat: 0, lon: NaN } },
			{ position: { lat: 0 } },
			{ position: { lat: 0, lon: 0, altM: Infinity } },
		])
			expect(() => validateDecodeEnvelope({ ...envelope, ...patch })).toThrow(
				"Invalid decoder event envelope",
			)
	})
	// Feature: decode-envelope, Property 1: Immutable caller identity
	// Validates: Requirements 1.2, 1.3, 1.4
	it("preserves caller identity across equal receptions and changed presentation", () => {
		fc.assert(
			fc.property(
				fc.uuid(),
				fc.uuid(),
				fc.jsonValue({ maxDepth: 3 }),
				(first, second, data) => {
					const a = createDecodeEnvelope(output(data), context(first))
					const b = createDecodeEnvelope(output(data), context(second), {
						title: "Known message",
					})
					expect(a.eventId).toBe(first)
					expect(b.eventId).toBe(second)
					expect(validateDecodeEnvelope(wire(a)).eventId).toBe(first)
					expect(
						createDecodeEnvelope(output({ changed: data }), context(first))
							.eventId,
					).toBe(first)
				},
			),
			{ numRuns: 100 },
		)
	})
	// Feature: decode-envelope, Property 2: Truthful defaults and explicit provenance
	// Validates: Requirements 3.1, 3.2, 3.3, 3.5, 4.1
	it("does not infer RF truth or presentation from arbitrary reported payloads", () => {
		fc.assert(
			fc.property(
				fc.double({ min: 1, max: 1e10, noNaN: true }),
				fc.string(),
				(frequency, source) => {
					const envelope = createDecodeEnvelope(
						output({ frequency, source, protocol: "dmr", offsetHz: 6000 }),
						context(),
					)
					expect(envelope.provenance).toEqual({
						sourceId: null,
						frequency: null,
					})
					expect(envelope).toMatchObject({
						protocol: null,
						title: null,
						category: "other",
						fields: [],
					})
				},
			),
			{ numRuns: 100 },
		)
	})
	it("preserves supplied binding, trust, typed fields and domain refs without sharing objects", () => {
		const supplied = context()
		supplied.decoderType = "dsd-fme"
		supplied.provenance = {
			sourceId: "dongle",
			frequency: { hz: 446_000_000, basis: "probe", tuningTrust: "unverified" },
			jobId: "job-1",
			probeId: "probe-1",
			channelId: "channel-1",
		}
		supplied.refs = {
			callId: "call-1",
			discoveryId: "d_1",
			observationId: "o_1",
		}
		const presentation: DecodePresentation = {
			protocol: "dmr",
			category: "voice",
			title: "Talkgroup 7",
			fields: [
				{ key: "talkgroup", label: "Talkgroup", value: 7 },
				{ key: "encrypted", label: "Encrypted", value: false },
				{ key: "source", label: "Source", value: null },
				{ key: "name", label: "Name", value: "Local" },
			],
		}
		const envelope = createDecodeEnvelope(
			output({ callId: "different" }, "call_start"),
			supplied,
			presentation,
		)
		expect(envelope.provenance).toEqual(supplied.provenance)
		expect(envelope.refs).toEqual(supplied.refs)
		expect(envelope.fields).toEqual(presentation.fields)
		supplied.provenance.frequency!.hz = 1
		supplied.refs.callId = "changed"
		presentation.fields![0]!.value = 99
		expect(envelope.provenance.frequency?.hz).toBe(446_000_000)
		expect(envelope.refs?.callId).toBe("call-1")
		expect(envelope.fields[0]?.value).toBe(7)
		expect(validateDecodeEnvelope(wire(envelope))).toEqual(envelope)
	})
	it("handles real ACARS defaults/undefined and VDL2 unknown frequency without promoting them", () => {
		const acars = parseAcarsdecJson({ text: "Message" })
		const vdl2 = parseDumpvdl2Json({ vdl2: { t: { sec: 1 } } })
		expect(acars).not.toHaveProperty("frequency")
		expect(vdl2?.frequency).toBe(0)
		for (const data of [acars, vdl2]) {
			const envelope = createDecodeEnvelope(output(data), context())
			expect(envelope.provenance.frequency).toBeNull()
			expect(envelope.decodedData).toEqual(wire(data))
			expect(validateDecodeEnvelope(wire(envelope))).toEqual(envelope)
		}
	})
	it.each([
		"aircraft",
		"ship",
		"meshtastic",
		"signal",
		"message",
		"sync",
		"stats",
		"error",
		"call_start",
		"call_end",
	] as const)(
		"keeps %s truthful without scanner-confirmation or source assumptions",
		type => {
			const data = {
				lastSeen: new Date(0),
				received: new Date(1),
				unknown: { model: "custom", frequency: 1090000000 },
				callId: "native-call",
			}
			const envelope = createDecodeEnvelope(output(data, type), context())
			expect(envelope.outputType).toBe(type)
			expect(envelope.decodedData).toEqual(wire(data))
			expect(envelope).not.toHaveProperty("confidence")
			expect(envelope).not.toHaveProperty("refs")
		},
	)
	// Feature: decode-envelope, Property 4: Independent clocks and truthful event type
	// Validates: Requirements 1.1, 2.1, 2.2, 2.3, 4.2
	it("preserves independent clocks in either order and reported payload time separately", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 2e12 }),
				fc.integer({ min: 0, max: 2e12 }),
				(producer, ingress) => {
					const value = output({ reportedAt: new Date(0) }, "sync")
					value.timestamp = new Date(producer)
					const supplied = context()
					supplied.receivedAt = new Date(ingress)
					const envelope = createDecodeEnvelope(value, supplied)
					expect(envelope.producedAt).toBe(value.timestamp.toISOString())
					expect(envelope.receivedAt).toBe(supplied.receivedAt.toISOString())
					expect(envelope.decodedData).toEqual({
						reportedAt: new Date(0).toISOString(),
					})
				},
			),
			{ numRuns: 100 },
		)
	})
	it("keeps exact payload depth/node boundaries identical through create and wire validation", () => {
		for (const data of [nested(16), nodes(4096)]) {
			const envelope = createDecodeEnvelope(output(data), context())
			expect(validateDecodeEnvelope(wire(envelope))).toEqual(envelope)
		}
		const base = createDecodeEnvelope(output(null), context())
		for (const data of [nested(17), nodes(4097)]) {
			expect(() => createDecodeEnvelope(output(data), context())).toThrow(
				"Invalid decoder event envelope",
			)
			expect(() =>
				validateDecodeEnvelope({ ...base, decodedData: data }),
			).toThrow("Invalid decoder event envelope")
		}
	})
	it("counts escaped UTF-8 bytes for the whole envelope including metadata at the exact limit", () => {
		const empty = createDecodeEnvelope(
			output(["x".repeat(32768), "x".repeat(32768), "x".repeat(32768), ""]),
			context(),
		)
		const remaining = 131072 - Buffer.byteLength(JSON.stringify(empty), "utf8")
		const data = [
			"x".repeat(32768),
			"x".repeat(32768),
			"x".repeat(32768),
			"x".repeat(remaining),
		]
		const exact = createDecodeEnvelope(output(data), context())
		expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(131072)
		expect(validateDecodeEnvelope(wire(exact))).toEqual(exact)
		data[3] += "x"
		expect(() => createDecodeEnvelope(output(data), context())).toThrow(
			"Invalid decoder event envelope",
		)
		expect(() =>
			validateDecodeEnvelope({ ...exact, decodedData: data }),
		).toThrow("Invalid decoder event envelope")
	})
	it("rejects nested wire Dates/undefined while construction projects current decoded data", () => {
		const envelope = createDecodeEnvelope(
			output({ time: new Date(0), optional: undefined }),
			context(),
		)
		expect(validateDecodeEnvelope(wire(envelope))).toEqual(envelope)
		for (const decodedData of [
			{ nested: [new Date(0)] },
			{ optional: undefined },
			[undefined],
		])
			expect(() =>
				validateDecodeEnvelope({ ...envelope, decodedData }),
			).toThrow("Invalid decoder event envelope")
	})
	it("rejects conflicting attribution, invalid clocks and unqualified sample context", () => {
		const value = output({})
		expect(() =>
			createDecodeEnvelope(value, { ...context(), decoderId: "other" }),
		).toThrow()
		expect(() =>
			createDecodeEnvelope({ ...value, timestamp: new Date(NaN) }, context()),
		).toThrow()
		expect(() =>
			createDecodeEnvelope(value, { ...context(), receivedAt: new Date(NaN) }),
		).toThrow()
		const envelope = createDecodeEnvelope(value, context())
		for (const patch of [
			{ producedAt: "2026-02-30T00:00:00.000Z" },
			{ receivedAt: "2026-10-10" },
			{ version: 2 },
			{ provenance: { sourceId: null, frequency: null, epoch: 7 } },
		])
			expect(() => validateDecodeEnvelope({ ...envelope, ...patch })).toThrow()
	})
	// Feature: decode-envelope, Property 5: Bounded all-or-nothing validation
	// Validates: Requirements 4.3, 5.3, 5.4, 6.1, 6.2
	it("rejects malformed metadata consistently without input echo", () => {
		fc.assert(
			fc.property(fc.string(), secret => {
				const envelope = createDecodeEnvelope(output({}), context())
				try {
					validateDecodeEnvelope({ ...envelope, version: 9, title: secret })
					expect.fail("accepted version")
				} catch (error) {
					expect(error).toMatchObject({
						code: "DECODE_ENVELOPE_INVALID",
						message: "Invalid decoder event envelope",
					})
					expect(error).toHaveProperty("cause", undefined)
				}
			}),
			{ numRuns: 100 },
		)
	})
	it("validates unique field keys, UTF-8 text limits, scalar values and RF trust", () => {
		const envelope = createDecodeEnvelope(output(null), context())
		const field = { key: "one", label: "One", value: 0 }
		for (const patch of [
			{ fields: [field, field] },
			{
				fields: Array.from({ length: 65 }, (_v, i) => ({
					...field,
					key: String(i),
				})),
			},
			{ fields: [{ ...field, value: {} }] },
			{ fields: [{ ...field, unit: "x".repeat(33) }] },
			{ title: "é".repeat(129) },
			{ protocol: "x".repeat(65) },
			{ decoderId: "é".repeat(65) },
			{ refs: { recordingId: "unknown" } },
			{
				provenance: {
					sourceId: null,
					frequency: { hz: 0, basis: "probe", tuningTrust: "unverified" },
				},
			},
			{ provenance: { sourceId: null, frequency: { hz: 1, basis: "probe" } } },
		])
			expect(() => validateDecodeEnvelope({ ...envelope, ...patch })).toThrow()
		expect(
			validateDecodeEnvelope({ ...envelope, title: "é".repeat(128) }).title,
		).toHaveLength(128)
	})
	it("rejects an explicit null presentation rather than treating it as omission", () => {
		const malformed = null as unknown as DecodePresentation
		expect(() =>
			createDecodeEnvelope(output(null), context(), malformed),
		).toThrow("Invalid decoder event envelope")
	})
	it("does not invoke hostile metadata getters or serializers", () => {
		const getter = vi.fn(() => {
			throw new Error("private payload")
		})
		const supplied = Object.defineProperty(context(), "eventId", {
			get: getter,
		})
		expect(() => createDecodeEnvelope(output(null), supplied)).toThrow(
			"Invalid decoder event envelope",
		)
		const envelope = createDecodeEnvelope(output(null), context())
		Object.defineProperty(envelope.provenance, "sourceId", { get: getter })
		expect(() => validateDecodeEnvelope(envelope)).toThrow(
			"Invalid decoder event envelope",
		)
		expect(getter).not.toHaveBeenCalled()
	})
	it("adds a presentation to a plain envelope exactly as create does", () => {
		const presentations: DecodePresentation[] = [
			{},
			{ category: "aircraft", protocol: "adsb" },
			{
				category: "aprs",
				protocol: "aprs",
				entityKey: "callsign:N0CALL-9",
				title: "N0CALL-9 Position",
				position: { lat: 51.5, lon: -0.1 },
				fields: [
					{ key: "speed", label: "Speed", value: 12, unit: "kn" },
					{ key: "ok", label: "OK", value: true },
				],
			},
		]
		const supplied: DecodeEnvelopeContext = {
			...context(),
			decoderType: "readsb",
			provenance: { sourceId: "rtl", frequency: null },
			refs: { callId: "call-1" },
		}
		for (const presentation of presentations) {
			const source = output({ icao: "abc123", tags: ["a"] }, "aircraft")
			const plain = createDecodeEnvelope(source, supplied)
			const added = withPresentation(plain, presentation)
			const created = createDecodeEnvelope(source, supplied, presentation)
			expect(added).toEqual(created)
			expect(JSON.stringify(added)).toBe(JSON.stringify(created))
		}
	})

	it("rejects a presentation through withPresentation as create does", () => {
		const plain = createDecodeEnvelope(output({}), context())
		expect(() => withPresentation(plain, { entityKey: "no key" })).toThrow()
		expect(() => withPresentation(plain, { title: "bad\u0000title" })).toThrow()
		expect(() =>
			createDecodeEnvelope(output({}), context(), { entityKey: "no key" }),
		).toThrow()
	})
})
