import fc from "fast-check"
import { describe, expect, it } from "vitest"
import pino from "pino"
import { createDecodeEnvelope } from "../../../../../src/core/activity/envelope.js"
import { createActivityIngress } from "../../../../../src/core/activity/ingress.js"
import {
	FIELD_TEXT_BYTES,
	LONG_TEXT_BYTES,
	MAX_TITLE_BYTES,
	MAX_TITLE_CHARS,
} from "../../../../../src/core/activity/presentation/budget.js"
import { presentDecoderOutput } from "../../../../../src/core/activity/presentation/registry.js"
import { isCoalescibleShape } from "../../../../../src/core/activity/storage/coalesce.js"
import type { DecodeEnvelope } from "../../../../../src/core/activity/types.js"
import type {
	DecoderOutput,
	DecoderOutputType,
} from "../../../../../src/decoders/types.js"
import { decoderOutput, presentationGrowth } from "./measure.js"

const RUNS = 100
const AT = new Date("2026-10-13T00:00:00.000Z")
const TYPES: readonly DecoderOutputType[] = [
	"aircraft",
	"ship",
	"aprs",
	"meshtastic",
	"message",
	"decode",
	"call",
	"call_start",
	"call_end",
	"acars",
	"vdl2",
	"signal",
	"stats",
	"error",
]
const LONG_KEYS = new Set(["message", "comment", "text"])
const NO_POSITION = new Set([
	"meshtastic",
	"signal",
	"call",
	"call_start",
	"call_end",
	"message",
	"decode",
	"acars",
	"vdl2",
])

const scalar = fc.oneof(
	fc.string({ maxLength: 24 }),
	fc.integer({ min: -1_000_000, max: 1_000_000 }),
	fc.boolean(),
	fc.constant(null),
)
const keyArb = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/)
const dataArb = fc.oneof(
	scalar,
	fc.array(scalar, { maxLength: 3 }),
	fc.dictionary(keyArb, scalar, { maxKeys: 5 }),
	fc.dictionary(keyArb, fc.dictionary(keyArb, scalar, { maxKeys: 3 }), {
		maxKeys: 3,
	}),
)

function publish(
	output: DecoderOutput,
	decoderType: string | undefined,
): DecodeEnvelope {
	const published: DecodeEnvelope[] = []
	const ingress = createActivityIngress({
		sink: (_envelope, present) => {
			published.push(present())
		},
		logger: pino({ level: "silent" }),
		now: () => AT,
		randomUUID: () => "evt-property",
	})
	ingress.publish(output.decoder, decoderType, output)
	const envelope = published[0]
	expect(envelope).toBeDefined()
	if (!envelope) throw new Error("ingress dropped a reception")
	return envelope
}

function rest(envelope: DecodeEnvelope): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...envelope }
	for (const key of [
		"protocol",
		"category",
		"entityKey",
		"title",
		"fields",
		"position",
	])
		delete copy[key]
	return copy
}

describe("activity presentation properties", () => {
	// Feature: web-gaps-2, Property 1: Presentation never loses a reception
	// Validates: Requirements 1.1, 1.2, 1.7
	it("never throws and yields the presentation-free envelope plus presentation fields", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...TYPES),
				dataArb,
				fc.option(fc.constantFrom("readsb", "direwolf"), { nil: undefined }),
				(type, data, decoderType) => {
					const output = decoderOutput(type, data)
					expect(() => presentDecoderOutput(output, decoderType)).not.toThrow()
					const context = {
						eventId: "evt-property",
						receivedAt: AT,
						decoderId: output.decoder,
						...(decoderType === undefined ? {} : { decoderType }),
						provenance: { sourceId: null, frequency: null },
					}
					let plain: DecodeEnvelope
					try {
						plain = createDecodeEnvelope(output, context)
					} catch {
						return
					}
					const published = publish(output, decoderType)
					expect(rest(published)).toEqual(rest(plain))
					expect(published.decodedData).toEqual(plain.decodedData)
					const view = presentDecoderOutput(output, decoderType)
					if (view === undefined) expect(published).toEqual(plain)
				},
			),
			{ numRuns: RUNS },
		)
	})

	// Feature: web-gaps-2, Property 2: Entity key canonical form
	// Validates: Requirements 1.3
	it("canonicalises identifiers and drops invalid ones", () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[0-9a-fA-F]{6}$/), hex => {
				const upper = `icao:${hex.toUpperCase()}`
				expect(
					presentDecoderOutput(decoderOutput("aircraft", { icao: hex }), "t")
						?.entityKey,
				).toBe(upper)
				expect(
					presentDecoderOutput(
						decoderOutput("aircraft", { hex: hex.toLowerCase() }),
						"t",
					)?.entityKey,
				).toBe(upper)
				expect(
					presentDecoderOutput(
						decoderOutput("aircraft", { icao: `${hex}~` }),
						"t",
					)?.entityKey,
				).toBeUndefined()
			}),
			{ numRuns: RUNS },
		)
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 999_999_999 }), n => {
				const key = `mmsi:${String(n).padStart(9, "0")}`
				expect(
					presentDecoderOutput(decoderOutput("ship", { mmsi: n }), "t")
						?.entityKey,
				).toBe(key)
				expect(
					presentDecoderOutput(
						decoderOutput("ship", { mmsi: String(n).padStart(9, "0") }),
						"t",
					)?.entityKey,
				).toBe(key)
			}),
			{ numRuns: RUNS },
		)
		fc.assert(
			fc.property(
				fc.stringMatching(/^[A-Z0-9]{1,6}$/),
				fc.option(fc.integer({ min: 1, max: 15 }), { nil: undefined }),
				(base, ssid) => {
					const value = ssid === undefined ? base : `${base}-${ssid}`
					const key = `callsign:${value}`
					const lower = value.toLowerCase()
					expect(
						presentDecoderOutput(
							decoderOutput("aprs", { source: lower, dataType: "Status" }),
							"t",
						)?.entityKey,
					).toBe(key)
					expect(
						presentDecoderOutput(
							decoderOutput("aprs", {
								source: `${lower}-0`,
								dataType: "Status",
							}),
							"t",
						)?.entityKey,
					).toBe(key)
				},
			),
			{ numRuns: RUNS },
		)
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 1_000_000 }), n => {
				const key = `capcode:${String(n)}`
				const padded = String(n).padStart(6, "0")
				expect(
					presentDecoderOutput(
						decoderOutput("message", {
							protocol: "POCSAG1200",
							address: padded,
							message: "m",
						}),
						"t",
					)?.entityKey,
				).toBe(key)
				expect(
					presentDecoderOutput(
						decoderOutput("decode", {
							protocol: "FLEX",
							capcode: n,
							message: "m",
						}),
						"t",
					)?.entityKey,
				).toBe(key)
			}),
			{ numRuns: RUNS },
		)
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 0xffffffff }), from => {
				const key = `node:!${(from >>> 0).toString(16).padStart(8, "0")}`
				expect(
					presentDecoderOutput(
						decoderOutput("meshtastic", { from, portnum: 1 }),
						"t",
					)?.entityKey,
				).toBe(key)
			}),
			{ numRuns: RUNS },
		)
		expect(
			presentDecoderOutput(
				decoderOutput("meshtastic", { from: -1, portnum: 1 }),
				"t",
			)?.entityKey,
		).toBeUndefined()
		expect(
			presentDecoderOutput(
				decoderOutput("meshtastic", { from: 1.5, portnum: 1 }),
				"t",
			)?.entityKey,
		).toBeUndefined()
		expect(
			presentDecoderOutput(
				decoderOutput("meshtastic", { from: 0x1_0000_0000, portnum: 1 }),
				"t",
			)?.entityKey,
		).toBeUndefined()
		expect(
			presentDecoderOutput(
				decoderOutput("call", { protocol: "dmr", talkgroup: -1 }),
				"t",
			)?.entityKey,
		).toBeUndefined()
		expect(
			presentDecoderOutput(decoderOutput("acars", { tail: "n.12:3" }), "t")
				?.entityKey,
		).toBeUndefined()
		expect(
			presentDecoderOutput(decoderOutput("ship", { mmsi: "1234567890" }), "t")
				?.entityKey,
		).toBeUndefined()
	})

	// Feature: web-gaps-2, Property 3: Presentation budget
	// Validates: Requirements 1.4, 1.5, 1.6, 1.8
	it("stays inside the field, title, position and built-row budgets", () => {
		const payload = fc.dictionary(
			fc.constantFrom(
				"icao",
				"hex",
				"callsign",
				"flight",
				"squawk",
				"altitude",
				"alt_baro",
				"gs",
				"track",
				"baro_rate",
				"lat",
				"lon",
				"mmsi",
				"name",
				"messageType",
				"sog",
				"cog",
				"source",
				"dataType",
				"comment",
				"status",
				"message",
				"symbol",
				"course",
				"speed",
				"from",
				"portnum",
				"to",
				"hopLimit",
				"protocol",
				"address",
				"function",
				"text",
				"tail",
				"label",
				"model",
				"id",
				"channel",
				"talkgroup",
				"temperature_C",
			),
			fc.oneof(
				fc.string({ maxLength: 180 }),
				fc.integer({ min: -1_000, max: 1_000_000 }),
				fc.double({ min: -180, max: 180, noNaN: true }),
				fc.boolean(),
				fc.constant(null),
			),
			{ minKeys: 1, maxKeys: 8 },
		)
		fc.assert(
			fc.property(fc.constantFrom(...TYPES), payload, (type, data) => {
				const output = decoderOutput(type, data)
				const view = presentDecoderOutput(output, "measure")
				expect(view?.fields === undefined || view.fields.length <= 6).toBe(true)
				if (typeof view?.title === "string") {
					expect(view.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
					expect(Buffer.byteLength(view.title, "utf8")).toBeLessThanOrEqual(
						MAX_TITLE_BYTES,
					)
				}
				for (const field of view?.fields ?? []) {
					expect(field.label.length).toBeGreaterThan(0)
					expect(field.label.length).toBeLessThanOrEqual(24)
					if (typeof field.value === "string") {
						const cap = LONG_KEYS.has(field.key)
							? LONG_TEXT_BYTES
							: FIELD_TEXT_BYTES
						expect(Buffer.byteLength(field.value, "utf8")).toBeLessThanOrEqual(
							cap,
						)
					}
				}
				if (view?.position) {
					expect(view.position.lat).toBeGreaterThanOrEqual(-90)
					expect(view.position.lat).toBeLessThanOrEqual(90)
					expect(view.position.lon).toBeGreaterThanOrEqual(-180)
					expect(view.position.lon).toBeLessThanOrEqual(180)
					expect(view.position.lat === 0 && view.position.lon === 0).toBe(false)
					expect(view.position).not.toHaveProperty("altM")
				}
				if (NO_POSITION.has(type)) expect(view?.position).toBeUndefined()
				let growth: { growth: number } | undefined
				try {
					growth = presentationGrowth(output)
				} catch {
					growth = undefined
				}
				if (growth) expect(growth.growth).toBeLessThanOrEqual(1_100)
				if (
					growth &&
					typeof data === "object" &&
					data !== null &&
					!Array.isArray(data) &&
					isCoalescibleShape(type, data)
				) {
					expect(view?.fields).toBeUndefined()
					expect(growth.growth).toBeLessThanOrEqual(160)
				}
			}),
			{ numRuns: RUNS },
		)
	})
})
