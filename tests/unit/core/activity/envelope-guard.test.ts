import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createDecodeEnvelope,
	createDecodeEnvelopeBySchema,
	guardPresentation,
	presentationSchemaForTests,
	withPresentation,
} from "../../../../src/core/activity/envelope.js"
import { projectJson } from "../../../../src/core/activity/projection.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"
import type {
	DecodeEnvelopeContext,
	DecodePresentation,
} from "../../../../src/core/activity/types.js"

const RECEIVED = new Date("2026-11-06T10:00:00.000Z")
const output = (over: Record<string, unknown> = {}): DecoderOutput =>
	({
		timestamp: new Date("2026-11-06T09:59:59.500Z"),
		decoder: "adsb",
		type: "aircraft",
		data: { icao: "abc123", altitude: 3000 },
		...over,
	}) as DecoderOutput
const context = (over: Record<string, unknown> = {}): DecodeEnvelopeContext =>
	({
		eventId: "evt-1",
		receivedAt: RECEIVED,
		decoderId: "adsb",
		decoderType: "readsb",
		provenance: {
			sourceId: "rtl",
			frequency: {
				hz: 1_000_000_000,
				basis: "channel",
				tuningTrust: "commanded",
			},
			channelId: "c1",
		},
		refs: { callId: "call-1" },
		...over,
	}) as DecodeEnvelopeContext
const presentation = (over: Record<string, unknown> = {}): DecodePresentation =>
	({
		entityKey: "aircraft:abc123",
		position: { lat: 48.5, lon: 2.25, altM: 900 },
		protocol: "adsb",
		category: "aircraft",
		title: "ABC123",
		fields: [
			{ key: "alt", label: "Altitude", value: 3000, unit: "ft" },
			{ key: "sq", label: "Squawk", value: "7000" },
			{ key: "gnd", label: "On ground", value: false },
			{ key: "none", label: "None", value: null },
		],
		...over,
	}) as DecodePresentation

type Outcome = { json: string } | { threw: string }
function outcome(fn: () => unknown): Outcome {
	try {
		return { json: JSON.stringify(fn()) }
	} catch (error) {
		return { threw: (error as { code?: string }).code ?? "unknown" }
	}
}
function expectSame(
	o: DecoderOutput,
	c: DecodeEnvelopeContext,
	p?: DecodePresentation,
): Outcome {
	const guarded = outcome(() => createDecodeEnvelope(o, c, p))
	const schema = outcome(() => createDecodeEnvelopeBySchema(o, c, p))
	expect(guarded).toEqual(schema)
	return guarded
}

const proxied = <T extends object>(v: T): T => new Proxy(v, {})
const withGetter = (key: string, value: unknown): object =>
	Object.defineProperty({ sourceId: null, frequency: null }, key, {
		get: () => value,
		enumerable: true,
	})

describe("createDecodeEnvelope guards against the schemas", () => {
	afterEach(() => vi.restoreAllMocks())

	// Feature: spectrum-main-thread, Property 2: guarded envelope equals the schema envelope byte for byte
	// Validates: docs/PERFORMANCE.md rule on structural guards
	it("same bytes or the same refusal for generated and mutated inputs", () => {
		const text = fc.oneof(
			fc.string({ maxLength: 40 }),
			fc.constantFrom(
				"",
				"a",
				"a\u0001b",
				"\u009f",
				"é".repeat(70),
				"x".repeat(128),
				"x".repeat(129),
				"€".repeat(42),
				"€".repeat(43),
			),
		)
		const num = fc.oneof(
			fc.double(),
			fc.constantFrom(
				-0,
				0,
				90,
				90.5,
				-90,
				180,
				180.5,
				Number.MAX_SAFE_INTEGER,
			),
			fc.constantFrom(Number.NaN, Infinity, -Infinity),
		)
		const anything = fc.oneof(
			text,
			num,
			fc.boolean(),
			fc.constant(null),
			fc.constant(undefined),
			fc.array(fc.integer(), { maxLength: 2 }),
			fc.dictionary(fc.string({ maxLength: 4 }), fc.integer(), { maxKeys: 2 }),
		)
		const maybe = <T>(a: fc.Arbitrary<T>, odds = 40) =>
			fc.oneof(
				{ arbitrary: a, weight: odds },
				{ arbitrary: anything as fc.Arbitrary<unknown>, weight: 1 },
			)
		const opt = <T>(a: fc.Arbitrary<T>) =>
			fc.option(maybe(a), { nil: undefined })
		const id = fc.oneof(
			{ arbitrary: fc.stringMatching(/^[a-z0-9-]{1,12}$/), weight: 40 },
			{ arbitrary: text, weight: 1 },
		)
		const field = fc.record(
			{
				key: maybe(id),
				label: maybe(id),
				value: maybe(
					fc.oneof(text, fc.double(), fc.boolean(), fc.constant(null)),
				),
				unit: opt(id),
			},
			{ requiredKeys: ["key", "label", "value"] },
		)
		const generated = fc.record({
			decoder: maybe(fc.constant("adsb")),
			decoderId: maybe(fc.constant("adsb")),
			eventId: maybe(id),
			type: maybe(id),
			decoderType: opt(id),
			provenance: opt(
				fc.record(
					{
						sourceId: maybe(fc.oneof(id, fc.constant(null))),
						frequency: maybe(
							fc.oneof(
								fc.constant(null),
								fc.record({
									hz: maybe(fc.double({ min: 1, max: 2e9, noNaN: true })),
									basis: maybe(fc.constantFrom("channel", "probe", "x")),
									tuningTrust: maybe(
										fc.constantFrom("commanded", "relay", "unverified", "y"),
									),
								}),
							),
						),
						jobId: opt(id),
						probeId: opt(id),
						channelId: opt(id),
					},
					{ requiredKeys: ["sourceId", "frequency"] },
				),
			),
			refs: opt(
				fc.record(
					{ callId: opt(id), discoveryId: opt(id), observationId: opt(id) },
					{ requiredKeys: [] },
				),
			),
			presentation: fc.option(
				fc.record(
					{
						entityKey: opt(
							fc.oneof(
								fc.constantFrom("aircraft:abc", "a:b:c", "Bad:x", "a:"),
								fc.constant(null),
							),
						),
						position: opt(
							fc.record(
								{ lat: maybe(num), lon: maybe(num), altM: opt(num) },
								{ requiredKeys: ["lat", "lon"] },
							),
						),
						protocol: opt(fc.oneof(id, fc.constant(null))),
						category: opt(fc.constantFrom("aircraft", "other", "nope")),
						title: opt(fc.oneof(id, fc.constant(null))),
						fields: opt(fc.array(maybe(field), { maxLength: 4 })),
						extra: opt(fc.constant("x")),
					},
					{ requiredKeys: [] },
				),
				{ nil: undefined },
			),
		})
		let accepted = 0
		fc.assert(
			fc.property(generated, g => {
				const got = expectSame(
					output({ decoder: g.decoder, type: g.type }),
					context({
						eventId: g.eventId,
						decoderId: g.decoderId,
						decoderType: g.decoderType,
						provenance: g.provenance,
						refs: g.refs,
					}),
					g.presentation as DecodePresentation | undefined,
				)
				if ("json" in got) accepted++
			}),
			{ numRuns: 1000 },
		)
		expect(accepted).toBeGreaterThan(20)
	})

	// Feature: spectrum-main-thread, Property 3: a presentation the guard accepts, the schema accepts with the same value
	// Validates: docs/PERFORMANCE.md rule on structural guards
	it("guardPresentation accepts only what presentationSchema accepts", () => {
		fc.assert(
			fc.property(
				fc.record(
					{
						entityKey: fc.oneof(
							fc.constant(null),
							fc.constantFrom("a:b", "a:b:c", "1:x"),
							fc.string({ maxLength: 8 }),
						),
						protocol: fc.oneof(fc.string({ maxLength: 70 }), fc.constant(null)),
						category: fc.constantFrom("aircraft", "bad"),
						title: fc.oneof(fc.string({ maxLength: 260 }), fc.integer()),
						position: fc.record({
							lat: fc.double({ min: -100, max: 100 }),
							lon: fc.double({ min: -200, max: 200 }),
						}),
						fields: fc.array(
							fc.record({
								key: fc.constantFrom("a", "b", "c", ""),
								label: fc.string({ maxLength: 8 }),
								value: fc.oneof(fc.string({ maxLength: 8 }), fc.double()),
							}),
							{ maxLength: 3 },
						),
					},
					{ requiredKeys: [] },
				),
				input => {
					const guarded = guardPresentation(input)
					if (guarded === undefined) return
					const parsed = presentationSchemaForTests.safeParse(
						projectJson(input, false, true),
					)
					expect(parsed.success).toBe(true)
					if (parsed.success)
						expect(JSON.stringify(sorted(guarded))).toBe(
							JSON.stringify(sorted(parsed.data)),
						)
				},
			),
			{ numRuns: 500 },
		)
	})

	it("the normal decoder path never reaches Zod", () => {
		const spy = vi.spyOn(presentationSchemaForTests, "safeParse")
		createDecodeEnvelope(output(), context(), presentation())
		withPresentation(createDecodeEnvelope(output(), context()), presentation())
		expect(spy).not.toHaveBeenCalled()
		// the same inputs through the schema path do call it: the spy is on the live object
		createDecodeEnvelopeBySchema(output(), context(), presentation())
		expect(spy).toHaveBeenCalled()
	})

	it("member order, and so the stored bytes, match the schema", () => {
		const got = expectSame(output(), context(), presentation())
		expect("json" in got).toBe(true)
		const parsed = JSON.parse((got as { json: string }).json) as Record<
			string,
			unknown
		>
		expect(Object.keys(parsed)).toEqual([
			"version",
			"eventId",
			"producedAt",
			"receivedAt",
			"decoderId",
			"decoderType",
			"outputType",
			"protocol",
			"category",
			"entityKey",
			"position",
			"title",
			"fields",
			"provenance",
			"refs",
			"decodedData",
		])
	})

	it("withPresentation equals create with the same presentation", () => {
		for (const p of [
			presentation(),
			presentation({ fields: [] }),
			{ category: "other" } as DecodePresentation,
		]) {
			const plain = createDecodeEnvelope(output(), context())
			expect(JSON.stringify(withPresentation(plain, p))).toBe(
				JSON.stringify(createDecodeEnvelopeBySchema(output(), context(), p)),
			)
		}
	})

	describe("bounds, at and past each", () => {
		const cases: [
			string,
			() => [DecoderOutput, DecodeEnvelopeContext, DecodePresentation?],
			boolean,
		][] = [
			[
				"id 128 bytes",
				() => [output(), context({ eventId: "x".repeat(128) })],
				true,
			],
			[
				"id 129 bytes",
				() => [output(), context({ eventId: "x".repeat(129) })],
				false,
			],
			[
				"id 42 × 3 bytes + 2",
				() => [output(), context({ eventId: "€".repeat(42) + "xx" })],
				true,
			],
			[
				"id 43 × 3 bytes",
				() => [output(), context({ eventId: "€".repeat(43) })],
				false,
			],
			["empty id", () => [output(), context({ eventId: "" })], false],
			[
				"control character",
				() => [output(), context({ eventId: "a\u0007" })],
				false,
			],
			[
				"C1 control character",
				() => [output(), context({ eventId: "a\u0085" })],
				false,
			],
			[
				"type 64 bytes",
				() => [output({ type: "t".repeat(64) }), context()],
				true,
			],
			[
				"type 65 bytes",
				() => [output({ type: "t".repeat(65) }), context()],
				false,
			],
			[
				"decoder differs from decoderId",
				() => [output({ decoder: "other" }), context()],
				false,
			],
			[
				"hz at MAX_SAFE_INTEGER",
				() => [
					output(),
					context({
						provenance: {
							sourceId: null,
							frequency: {
								hz: Number.MAX_SAFE_INTEGER,
								basis: "probe",
								tuningTrust: "relay",
							},
						},
					}),
				],
				true,
			],
			[
				"hz past MAX_SAFE_INTEGER",
				() => [
					output(),
					context({
						provenance: {
							sourceId: null,
							frequency: {
								hz: Number.MAX_SAFE_INTEGER + 2,
								basis: "probe",
								tuningTrust: "relay",
							},
						},
					}),
				],
				false,
			],
			[
				"hz 0",
				() => [
					output(),
					context({
						provenance: {
							sourceId: null,
							frequency: { hz: 0, basis: "probe", tuningTrust: "relay" },
						},
					}),
				],
				false,
			],
			[
				"unknown provenance member",
				() => [
					output(),
					context({ provenance: { sourceId: null, frequency: null, x: 1 } }),
				],
				false,
			],
			[
				"missing frequency",
				() => [output(), context({ provenance: { sourceId: null } })],
				false,
			],
			[
				"lat 90",
				() => [
					output(),
					context(),
					presentation({ position: { lat: 90, lon: 0 } }),
				],
				true,
			],
			[
				"lat past 90",
				() => [
					output(),
					context(),
					presentation({ position: { lat: 90.0001, lon: 0 } }),
				],
				false,
			],
			[
				"lon -180",
				() => [
					output(),
					context(),
					presentation({ position: { lat: 0, lon: -180 } }),
				],
				true,
			],
			[
				"lon past -180",
				() => [
					output(),
					context(),
					presentation({ position: { lat: 0, lon: -180.5 } }),
				],
				false,
			],
			[
				"title 256",
				() => [output(), context(), presentation({ title: "t".repeat(256) })],
				true,
			],
			[
				"title 257",
				() => [output(), context(), presentation({ title: "t".repeat(257) })],
				false,
			],
			[
				"64 fields",
				() => [
					output(),
					context(),
					presentation({
						fields: Array.from({ length: 64 }, (_, i) => ({
							key: `k${i}`,
							label: "l",
							value: i,
						})),
					}),
				],
				true,
			],
			[
				"65 fields",
				() => [
					output(),
					context(),
					presentation({
						fields: Array.from({ length: 65 }, (_, i) => ({
							key: `k${i}`,
							label: "l",
							value: i,
						})),
					}),
				],
				false,
			],
			[
				"duplicate field keys",
				() => [
					output(),
					context(),
					presentation({
						fields: [
							{ key: "a", label: "l", value: 1 },
							{ key: "a", label: "l", value: 2 },
						],
					}),
				],
				false,
			],
			[
				"field string 32768",
				() => [
					output(),
					context(),
					presentation({
						fields: [{ key: "a", label: "l", value: "v".repeat(32768) }],
					}),
				],
				true,
			],
			[
				"field string 32769",
				() => [
					output(),
					context(),
					presentation({
						fields: [{ key: "a", label: "l", value: "v".repeat(32769) }],
					}),
				],
				false,
			],
			[
				"field NaN",
				() => [
					output(),
					context(),
					presentation({
						fields: [{ key: "a", label: "l", value: Number.NaN }],
					}),
				],
				false,
			],
			[
				"over the envelope size",
				() => [
					output(),
					context(),
					presentation({
						fields: Array.from({ length: 10 }, (_, i) => ({
							key: `k${i}`,
							label: "l",
							value: "v".repeat(32768),
						})),
					}),
				],
				false,
			],
			[
				"entity key without colon",
				() => [output(), context(), presentation({ entityKey: "abc" })],
				false,
			],
			[
				"entity key null",
				() => [output(), context(), presentation({ entityKey: null })],
				true,
			],
			[
				"year 0",
				() => [
					output({ timestamp: new Date("0000-01-01T00:00:00.000Z") }),
					context(),
				],
				true,
			],
			[
				"year 9999",
				() => [
					output({ timestamp: new Date("9999-12-31T23:59:59.999Z") }),
					context(),
				],
				true,
			],
			[
				"year 10000",
				() => [
					output({ timestamp: new Date("+010000-01-01T00:00:00.000Z") }),
					context(),
				],
				false,
			],
			[
				"year -1",
				() => [
					output({ timestamp: new Date("-000001-01-01T00:00:00.000Z") }),
					context(),
				],
				false,
			],
			[
				"invalid Date",
				() => [output({ timestamp: new Date(Number.NaN) }), context()],
				false,
			],
			[
				"string timestamp",
				() => [output({ timestamp: "2026-11-06T09:59:59.500Z" }), context()],
				false,
			],
		]
		for (const [name, make, ok] of cases) {
			it(name, () => {
				const [o, c, p] = make()
				const got = expectSame(o, c, p)
				expect("json" in got).toBe(ok)
			})
		}
	})

	describe("untrusted shapes fail safe, as they do through the schemas", () => {
		const shapes: [
			string,
			() => [DecoderOutput, DecodeEnvelopeContext, DecodePresentation?],
		][] = [
			[
				"a Proxy provenance",
				() => [
					output(),
					context({ provenance: proxied({ sourceId: null, frequency: null }) }),
				],
			],
			[
				"an accessor member",
				() => [output(), context({ provenance: withGetter("jobId", "x") })],
			],
			[
				"a class instance",
				() => [
					output(),
					context({
						refs: new (class R {
							callId = "a"
						})(),
					}),
				],
			],
			[
				"a symbol key",
				() => [output(), context({ refs: { [Symbol("s")]: 1 } })],
			],
			[
				"a non-enumerable member",
				() => [
					output(),
					context({
						refs: Object.defineProperty({}, "callId", {
							value: "a",
							enumerable: false,
						}),
					}),
				],
			],
			[
				"an own toJSON",
				() => [output(), context({ refs: { toJSON: () => ({}) } })],
			],
			[
				"a null-prototype object",
				() => [
					output(),
					context({
						refs: Object.assign(Object.create(null) as object, { callId: "a" }),
					}),
				],
			],
			[
				"an undefined nested member",
				() => [output(), context({ refs: { callId: undefined } })],
			],
			[
				"-0 in a position",
				() => [
					output(),
					context(),
					presentation({ position: { lat: -0, lon: 0 } }),
				],
			],
			[
				"-0 in a field",
				() => [
					output(),
					context(),
					presentation({ fields: [{ key: "a", label: "l", value: -0 }] }),
				],
			],
			[
				"a sparse fields array",
				() => [
					output(),
					context(),
					presentation({ fields: [, { key: "a", label: "l", value: 1 }] }),
				],
			],
			[
				"a fields array with an extra member",
				() => [
					output(),
					context(),
					presentation({ fields: Object.assign([], { x: 1 }) }),
				],
			],
			[
				"a Proxy fields array",
				() => [output(), context(), presentation({ fields: proxied([]) })],
			],
			[
				"a Proxy presentation",
				() => [
					output(),
					context(),
					proxied({ title: "a" }) as DecodePresentation,
				],
			],
			[
				"a Date subclass",
				() => [
					output({ timestamp: new (class D extends Date {})(0) }),
					context(),
				],
			],
			[
				"a Date with an own member",
				() => [
					output({ timestamp: Object.assign(new Date(0), { x: 1 }) }),
					context(),
				],
			],
			["an extra producer member", () => [output({ extra: 1 }), context()]],
			["an extra context member", () => [output(), context({ extra: 1 })]],
		]
		for (const [name, make] of shapes) {
			it(name, () => {
				const [o, c, p] = make()
				expectSame(o, c, p)
			})
		}
	})
})

/** Key-sorted copy: a parsed presentation's member order is not significant, assemble picks by name. */
function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted)
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map(k => [k, sorted((value as Record<string, unknown>)[k])]),
		)
	return value
}
