import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import { projectDecodedData } from "../../../../src/core/activity/projection.js"
import { WaveKitError } from "../../../../src/utils/errors.js"

function rejected(input: unknown): void {
	expect(() => projectDecodedData(input)).toThrow(WaveKitError)
	expect(() => projectDecodedData(input)).toThrow(
		"Invalid decoder event envelope",
	)
}

describe("complete decoded JSON projection", () => {
	// Feature: decode-envelope, Property 3: Complete detached JSON projection
	// Validates: Requirements 5.1, 5.2, 5.5
	it("round-trips bounded JSON without retaining references", () => {
		fc.assert(
			fc.property(fc.jsonValue({ maxDepth: 4 }), input => {
				const output = projectDecodedData(input)
				expect(JSON.stringify(output)).toBe(JSON.stringify(input))
				if (input !== null && typeof input === "object")
					expect(output).not.toBe(input)
			}),
			{ numRuns: 100 },
		)
	})
	it("projects real optional members, Date values, undefined positions and holes", () => {
		const date = new Date("2026-10-10T00:00:00.000Z")
		const input = {
			received: date,
			ack: undefined,
			items: [undefined, , date, -0],
		}
		const output = projectDecodedData(input)
		expect(output).toEqual({
			received: date.toISOString(),
			items: [null, null, date.toISOString(), 0],
		})
		input.received.setUTCFullYear(2030)
		input.items.push(3)
		expect(JSON.stringify(output)).not.toContain("2030")
		expect((output as { items: unknown[] }).items).toHaveLength(4)
	})
	it("keeps array indexed data even when nonenumerable, including nested undefined", () => {
		const array: unknown[] = [1, [2]]
		Object.defineProperty(array, "0", { value: 7, enumerable: false })
		Object.defineProperty(array[1], "0", {
			value: undefined,
			enumerable: false,
		})
		expect(projectDecodedData(array)).toEqual([7, [null]])
		expect(JSON.stringify(projectDecodedData(array))).toBe(
			JSON.stringify(array),
		)
	})
	it("clones a shared subtree independently and keeps prototype-shaped keys inert", () => {
		const shared = { number: 1 }
		const input: unknown = JSON.parse(
			'{"__proto__":{"polluted":true},"constructor":"data","prototype":7,"toJSON":"literal"}',
		)
		const output = projectDecodedData(input)
		expect(JSON.stringify(output)).toBe(JSON.stringify(input))
		expect(Object.getPrototypeOf(output)).toBeNull()
		expect(Object.hasOwn(output as object, "__proto__")).toBe(true)
		const copies = projectDecodedData([shared, shared]) as Array<{
			number: number
		}>
		copies[0]!.number = 9
		expect(copies[1]!.number).toBe(1)
		expect(shared.number).toBe(1)
	})
	it("rejects getters, serializers and Proxy traps without calling them", () => {
		const getter = vi.fn(() => "private payload")
		const serializer = vi.fn(() => "private payload")
		const object = Object.defineProperty({}, "hidden", { get: getter })
		const array = Object.defineProperty([1], "0", {
			get: getter,
			enumerable: false,
		})
		const proxy = new Proxy({}, { ownKeys: getter })
		for (const input of [object, array, { toJSON: serializer }, proxy])
			rejected(input)
		expect(getter).not.toHaveBeenCalled()
		expect(serializer).not.toHaveBeenCalled()
	})
	it("rejects cycles, invalid primitives and extra Date fields", () => {
		const cycle: Record<string, unknown> = {}
		cycle["self"] = cycle
		const date = new Date(0)
		Object.defineProperty(date, "packet", { value: 7 })
		for (const input of [
			cycle,
			date,
			new Date(NaN),
			NaN,
			Infinity,
			undefined,
			1n,
			Symbol("value"),
			() => 1,
			new Map(),
			/x/,
		])
			rejected(input)
	})
	it("bounds physical descriptor inspection, array positions and payload keys", () => {
		const object: Record<string, unknown> = {}
		for (let i = 0; i < 256; i++)
			Object.defineProperty(object, String(i), { value: i })
		expect(projectDecodedData(object)).toEqual({})
		Object.defineProperty(object, "extra", { value: 1 })
		rejected(object)
		expect(projectDecodedData(new Array(256))).toHaveLength(256)
		rejected(new Array(257))
		const array = Object.defineProperty([], "extra", { value: 1 })
		rejected(array)
		expect(projectDecodedData({ ["é".repeat(128)]: 1 })).toBeDefined()
		rejected({ ["é".repeat(129)]: 1 })
	})
	it("counts UTF-8 and JSON escaping before returning a complete projection", () => {
		expect(projectDecodedData("é".repeat(16384))).toBeDefined()
		rejected("é".repeat(16385))
		const escapeHeavy = ["\u0000".repeat(32768)]
		rejected(escapeHeavy)
		const exact = [
			"a".repeat(32768),
			"b".repeat(32768),
			"c".repeat(32768),
			"d".repeat(32755),
		]
		expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(131072)
		expect(projectDecodedData(exact)).toEqual(exact)
		exact[3] += "x"
		rejected(exact)
	})
	it("returns generic errors without values, property names or reflected causes", () => {
		const secret = "private payload"
		const input = Object.defineProperty({}, secret, {
			get: () => {
				throw new Error(secret)
			},
		})
		try {
			projectDecodedData(input)
			expect.fail("accepted getter")
		} catch (error) {
			expect(error).toMatchObject({
				code: "DECODE_ENVELOPE_INVALID",
				message: "Invalid decoder event envelope",
			})
			expect(String(error)).not.toContain(secret)
			expect(JSON.stringify(error)).not.toContain(secret)
			expect(error).toHaveProperty("cause", undefined)
		}
	})
})
