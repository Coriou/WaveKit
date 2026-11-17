import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ACTIVITY_MAX_OBSERVED } from "../../../src/decoders/enablement/activity-contract.js"
import {
	observedActivitySchemas,
	parseObservedCentres,
	parseObservedChannels,
} from "../../../src/decoders/manager.js"

afterEach(() => {
	vi.restoreAllMocks()
})

/** The schema path alone: what the manager returned before the guards. */
function byChannelsSchema(value: unknown): number[] | null {
	if (!Array.isArray(value) || value.length > ACTIVITY_MAX_OBSERVED) return null
	const parsed = observedActivitySchemas.channels.safeParse(value)
	return parsed.success ? parsed.data : null
}
function byCentresSchema(value: unknown) {
	if (!Array.isArray(value) || value.length > ACTIVITY_MAX_OBSERVED) return null
	const parsed = observedActivitySchemas.centres.safeParse(value)
	return parsed.success ? parsed.data : null
}

/** Same answer, same members in the same order, same numbers (Object.is). */
function same(a: unknown, b: unknown) {
	expect(a).toEqual(b)
	expect(JSON.stringify(a)).toBe(JSON.stringify(b))
}

const goodHz = fc.integer({ min: 1, max: 2_000_000_000 })
const anyHz = fc.oneof(
	goodHz,
	fc.constantFrom(0, -0, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 53),
	fc.double(),
	fc.constantFrom("1", null, undefined, true, {}, [], 10n),
)
const anyCentre = fc.oneof(
	fc.record({ actualHz: goodHz, candidateHz: goodHz }),
	fc.record({ candidateHz: goodHz, actualHz: goodHz }),
	fc.record({ actualHz: anyHz, candidateHz: anyHz }),
	fc.record(
		{ actualHz: goodHz, candidateHz: goodHz, extra: fc.anything() },
		{ requiredKeys: ["actualHz", "candidateHz"] },
	),
	fc.record({ actualHz: goodHz }),
	anyHz,
)

describe("observed channels guard", () => {
	it("returns what the schema path returns for any list", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.array(goodHz, { maxLength: 40 }),
					fc.array(anyHz, { maxLength: 40 }),
					fc.anything(),
				),
				value => same(parseObservedChannels(value), byChannelsSchema(value)),
			),
			{ numRuns: 300 },
		)
	})

	it.each([
		ACTIVITY_MAX_OBSERVED - 1,
		ACTIVITY_MAX_OBSERVED,
		ACTIVITY_MAX_OBSERVED + 1,
	])(
		"agrees at %i entries (bound 512), without a parse when well-formed",
		length => {
			const spy = vi.spyOn(observedActivitySchemas.channels, "safeParse")
			const value = Array.from({ length }, (_, i) => 100_000_000 + i)
			const guarded = parseObservedChannels(value)
			expect(spy).not.toHaveBeenCalled()
			same(guarded, byChannelsSchema(value))
			if (length > ACTIVITY_MAX_OBSERVED) expect(guarded).toBeNull()
			else expect(guarded).toHaveLength(length)
			// A new array, never the port's own.
			if (guarded) expect(guarded).not.toBe(value)
		},
	)

	it("hands accessors, proxies, holes, extra members and subclasses to the schema", () => {
		const spy = vi.spyOn(observedActivitySchemas.channels, "safeParse")
		const accessor = [1, 2]
		Object.defineProperty(accessor, 1, { get: () => 3, enumerable: true })
		const extra = Object.assign([1, 2], { note: 1 })
		const holes = [1, , 3]
		class Hz extends Array<number> {}
		const sub = Hz.from([1, 2])
		const proxy = new Proxy([1, 2], {})
		for (const value of [accessor, extra, holes, sub, proxy]) {
			same(parseObservedChannels(value), byChannelsSchema(value))
		}
		expect(spy).toHaveBeenCalledTimes(5 * 2)
	})

	it("rejects all or nothing", () => {
		expect(parseObservedChannels([1, 2, 0])).toBeNull()
		expect(parseObservedChannels([1, -0])).toBeNull()
		expect(parseObservedChannels([1, NaN])).toBeNull()
		expect(parseObservedChannels("1")).toBeNull()
	})
})

describe("observed centres guard", () => {
	it("returns what the schema path returns for any list", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.array(fc.record({ actualHz: goodHz, candidateHz: goodHz }), {
						maxLength: 30,
					}),
					fc.array(anyCentre, { maxLength: 30 }),
					fc.anything(),
				),
				value => same(parseObservedCentres(value), byCentresSchema(value)),
			),
			{ numRuns: 300 },
		)
	})

	it.each([
		ACTIVITY_MAX_OBSERVED - 1,
		ACTIVITY_MAX_OBSERVED,
		ACTIVITY_MAX_OBSERVED + 1,
	])(
		"agrees at %i entries (bound 512), without a parse when well-formed",
		length => {
			const spy = vi.spyOn(observedActivitySchemas.centres, "safeParse")
			const value = Array.from({ length }, (_, i) => ({
				actualHz: 100_000_000 + i,
				candidateHz: 100_000_000 + i - (i % 3),
			}))
			const guarded = parseObservedCentres(value)
			expect(spy).not.toHaveBeenCalled()
			same(guarded, byCentresSchema(value))
			if (length > ACTIVITY_MAX_OBSERVED) expect(guarded).toBeNull()
			else expect(guarded).toHaveLength(length)
			if (guarded) expect(guarded[0]).not.toBe(value[0])
		},
	)

	it("hands unknown members, accessors, proxies and other prototypes to the schema", () => {
		const spy = vi.spyOn(observedActivitySchemas.centres, "safeParse")
		const accessor = { actualHz: 1, candidateHz: 1 }
		Object.defineProperty(accessor, "candidateHz", {
			get: () => 2,
			enumerable: true,
		})
		class Centre {
			actualHz = 1
			candidateHz = 1
		}
		const nullProto = Object.assign(Object.create(null) as object, {
			actualHz: 1,
			candidateHz: 1,
		})
		const symbol = { actualHz: 1, candidateHz: 1, [Symbol("x")]: 1 }
		const cases: unknown[] = [
			[{ actualHz: 1, candidateHz: 1, extra: true }],
			[accessor],
			[new Centre()],
			[new Proxy({ actualHz: 1, candidateHz: 1 }, {})],
			[symbol],
			[{ actualHz: 1 }],
		]
		for (const value of cases)
			same(parseObservedCentres(value), byCentresSchema(value))
		expect(spy).toHaveBeenCalledTimes(cases.length * 2)
		// A null prototype is plain: no parse, same answer.
		spy.mockClear()
		same(parseObservedCentres([nullProto]), byCentresSchema([nullProto]))
		expect(spy).toHaveBeenCalledTimes(1)
	})

	it("keeps the schema's member order and rejects all or nothing", () => {
		const reversed = [{ candidateHz: 2, actualHz: 1 }]
		expect(JSON.stringify(parseObservedCentres(reversed))).toBe(
			'[{"actualHz":1,"candidateHz":2}]',
		)
		expect(
			parseObservedCentres([
				{ actualHz: 1, candidateHz: 1 },
				{ actualHz: 1, candidateHz: 0 },
			]),
		).toBeNull()
	})
})
