/**
 * Receiver identity keys (lane RS): built from validated components only, strongest first, and
 * path segments that never leave their namespace directory.
 */
import { join, relative, sep } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	headerModel,
	isReceiverKey,
	parseSdrHostIdentity,
	pathSegment,
	PATH_SEGMENT_MAX_LENGTH,
	RECEIVER_HEADER_FIELD_MAX,
	resolveReceiverIdentity,
	strengthOfKey,
} from "../../../src/core/receiver-identity.js"

const HEADER = { magic: "RTL0", tunerType: 5, gainCount: 29 }
const ID = "0123456789abcdef0123456789abcdef"

describe("resolveReceiverIdentity", () => {
	it("from the rtl_tcp header only: a model key", () => {
		expect(resolveReceiverIdentity(HEADER, null)).toEqual({
			key: "model:5:29",
			strength: "model",
			tunerType: 5,
			gainCount: 29,
		})
	})

	it("the sdr-host receiverId wins over the serial and the model", () => {
		const id = resolveReceiverIdentity(HEADER, {
			receiverId: ID,
			vendor: "0bda",
			product: "2838",
			serial: "00000001",
		})
		expect(id.key).toBe(`sdrhost:${ID}`)
		expect(id.strength).toBe("unit")
		expect(id.serial).toBe("00000001")
	})

	it("vendor, product and serial make a serial key; one missing falls back to the model", () => {
		expect(
			resolveReceiverIdentity(HEADER, {
				vendor: "0bda",
				product: "2838",
				serial: "00000001",
			}).key,
		).toBe("serial:0bda:2838:00000001")
		expect(
			resolveReceiverIdentity(HEADER, { vendor: "0bda", serial: "1" }).key,
		).toBe("model:5:29")
	})

	it("no valid header and no sdr-host: unknown", () => {
		expect(resolveReceiverIdentity(null, null).key).toBe("unknown")
		expect(
			resolveReceiverIdentity({ ...HEADER, magic: "HTTP" }, null).strength,
		).toBe("unknown")
	})

	it(`header fields are bounded at ${RECEIVER_HEADER_FIELD_MAX}: at it a model, past it unknown`, () => {
		expect(
			headerModel({ magic: "RTL0", tunerType: 255, gainCount: 255 }),
		).toEqual({ tunerType: 255, gainCount: 255 })
		expect(headerModel({ magic: "RTL0", tunerType: 256, gainCount: 1 })).toBe(
			null,
		)
		expect(headerModel({ magic: "RTL0", tunerType: 1, gainCount: -1 })).toBe(
			null,
		)
		expect(headerModel({ magic: "RTL0", tunerType: 1.5, gainCount: 1 })).toBe(
			null,
		)
	})
})

describe("parseSdrHostIdentity: malformed fields are dropped, never used", () => {
	it("keeps only a 32-hex receiverId and USB strings of 1 to 32 safe characters", () => {
		expect(
			parseSdrHostIdentity({
				receiverId: ID.toUpperCase(),
				dongle: {
					vendor: "Realtek Semiconductor Corp.",
					product: "../../etc",
					serial: "a".repeat(33),
				},
			}),
		).toEqual({})
		expect(
			parseSdrHostIdentity({
				receiverId: ID,
				dongle: { vendor: "0bda", product: "2838", serial: "a".repeat(32) },
			}),
		).toEqual({
			receiverId: ID,
			vendor: "0bda",
			product: "2838",
			serial: "a".repeat(32),
		})
	})

	it("any non-object body or field type reads as no facts", () => {
		for (const body of [null, 1, "x", [], { dongle: "x" }, { receiverId: 7 }])
			expect(parseSdrHostIdentity(body)).toEqual({})
	})
})

describe("isReceiverKey and strengthOfKey", () => {
	it("accepts what resolve builds and refuses anything else", () => {
		expect(isReceiverKey(`sdrhost:${ID}`)).toBe(true)
		expect(isReceiverKey("serial:0bda:2838:00000001")).toBe(true)
		expect(isReceiverKey("model:5:29")).toBe(true)
		expect(isReceiverKey("unknown")).toBe(false)
		expect(isReceiverKey("model:5:29/..")).toBe(false)
		expect(isReceiverKey(7)).toBe(false)
		expect(strengthOfKey("model:5:29")).toBe("model")
		expect(strengthOfKey(`sdrhost:${ID}`)).toBe("unit")
		expect(strengthOfKey("unknown")).toBe("unknown")
	})
})

describe("pathSegment", () => {
	it("encodes dots so `.` and `..` can never be produced", () => {
		expect(pathSegment(".")).toBe("%2E")
		expect(pathSegment("..")).toBe("%2E%2E")
		expect(pathSegment("a/b")).toBe("a%2Fb")
		expect(pathSegment("model:5:29")).toBe("model%3A5%3A29")
	})

	it(`hashes past ${PATH_SEGMENT_MAX_LENGTH} encoded characters, never at it`, () => {
		expect(pathSegment("a".repeat(PATH_SEGMENT_MAX_LENGTH))).toBe(
			"a".repeat(PATH_SEGMENT_MAX_LENGTH),
		)
		expect(
			pathSegment("a".repeat(PATH_SEGMENT_MAX_LENGTH + 1)).startsWith("%h"),
		).toBe(true)
		expect(pathSegment("").startsWith("%h")).toBe(true)
	})

	// Feature: receiver-identity, Property 1: key sanitizing never escapes the namespace dir
	// Validates: lane RS design 1 (validate every component; encodeURIComponent for paths)
	it("arbitrary sdr-host strings, header values and source ids never leave the namespace dir", () => {
		const root = join(sep, "state", "scanner", "engine", "receivers")
		fc.assert(
			fc.property(
				fc.string({ maxLength: 300 }),
				fc.oneof(fc.string({ maxLength: 64 }), fc.constant(ID)),
				fc.string({ maxLength: 40 }),
				fc.string({ maxLength: 40 }),
				fc.string({ maxLength: 40 }),
				fc.integer({ min: -10, max: 1_000 }),
				fc.integer({ min: -10, max: 1_000 }),
				(
					sourceId,
					receiverId,
					vendor,
					product,
					serial,
					tunerType,
					gainCount,
				) => {
					const facts = parseSdrHostIdentity({
						receiverId,
						dongle: { vendor, product, serial },
					})
					const identity = resolveReceiverIdentity(
						{ magic: "RTL0", tunerType, gainCount },
						facts,
					)
					if (identity.strength !== "unknown")
						expect(isReceiverKey(identity.key)).toBe(true)
					const a = pathSegment(sourceId)
					const b = pathSegment(identity.key)
					for (const seg of [a, b]) {
						expect(seg.length).toBeGreaterThan(0)
						expect(seg.length).toBeLessThanOrEqual(255)
						expect(seg).not.toMatch(/[/\\\0]/)
						expect(seg === "." || seg === "..").toBe(false)
					}
					const dir = join(root, a, b)
					const rel = relative(root, dir)
					expect(rel.split(sep)).toEqual([a, b])
				},
			),
			{ numRuns: 300 },
		)
	})

	it("distinct strings, lone surrogates included, get distinct segments", () => {
		fc.assert(
			fc.property(
				fc.string({ unit: "binary", maxLength: 20 }),
				fc.string({ unit: "binary", maxLength: 20 }),
				(x, y) => {
					// Compared case-folded: a case-insensitive file system must keep them apart too.
					if (x !== y)
						expect(pathSegment(x).toLowerCase()).not.toBe(
							pathSegment(y).toLowerCase(),
						)
				},
			),
			{ numRuns: 300 },
		)
	})

	// Feature: receiver-identity, Property 2: segments stay apart on a case-insensitive file system
	// Validates: lane RS design 1 (one namespace per receiver key)
	it("two strings that differ only in case get segments that differ case-folded", () => {
		expect(pathSegment("serial:Realtek:RTL2838:A1").toLowerCase()).not.toBe(
			pathSegment("serial:realtek:rtl2838:a1").toLowerCase(),
		)
		expect(pathSegment("Ab")).toBe("%41b")
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 40 }),
				fc.nat(),
				(x, seed) => {
					// Flip the case of one letter, when there is one.
					const chars = [...x]
					const letters = chars.flatMap((c, i) =>
						c.toLowerCase() !== c.toUpperCase() ? [i] : [],
					)
					fc.pre(letters.length > 0)
					const at = letters[seed % letters.length]!
					const c = chars[at]!
					chars[at] = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()
					const y = chars.join("")
					fc.pre(y !== x)
					expect(pathSegment(x).toLowerCase()).not.toBe(
						pathSegment(y).toLowerCase(),
					)
				},
			),
			{ numRuns: 300 },
		)
	})
})
