/**
 * Receiver identity keys: built from validated components only, strongest first, and
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
const UNIT = "fedcba9876543210fedcba9876543210"

describe("resolveReceiverIdentity", () => {
	it("from the rtl_tcp header only: a source-scoped model key", () => {
		expect(resolveReceiverIdentity("rtl", HEADER, null)).toEqual({
			key: "source:rtl|model:5:29",
			strength: "model",
			tunerType: 5,
			gainCount: 29,
		})
		// Two sources never share a weak namespace.
		expect(resolveReceiverIdentity("other", HEADER, null).key).toBe(
			"source:other|model:5:29",
		)
	})

	it("a source id that is not plain is hashed into the key, never used as is", () => {
		const key = resolveReceiverIdentity("a b/../c", HEADER, null).key
		expect(key).toMatch(/^source:~[0-9a-f]{32}\|model:5:29$/)
		expect(isReceiverKey(key)).toBe(true)
		expect(resolveReceiverIdentity("a b/../d", HEADER, null).key).not.toBe(key)
	})

	it("the sdr-host unitId wins over the serial and the model; the receiverId never keys", () => {
		const id = resolveReceiverIdentity("rtl", HEADER, {
			unitId: UNIT,
			receiverId: ID,
			vendor: "0bda",
			product: "2838",
			serial: "SDR4711",
			serialWeak: false,
		})
		expect(id.key).toBe(`unit:${UNIT}`)
		expect(id.strength).toBe("unit")
		expect(id.unitId).toBe(UNIT)
		expect(id.receiverId).toBe(ID)
		// An sdr-host without a unitId (an older one): its receiverId alone is no unit.
		expect(resolveReceiverIdentity("rtl", HEADER, { receiverId: ID })).toEqual(
			expect.objectContaining({
				key: "source:rtl|model:5:29",
				strength: "model",
			}),
		)
	})

	it("a strong serial makes a serial key; a weak one or a missing id falls back to the model", () => {
		expect(
			resolveReceiverIdentity("rtl", HEADER, {
				vendor: "0bda",
				product: "2838",
				serial: "SDR4711",
				serialWeak: false,
			}).key,
		).toBe("serial:0bda:2838:SDR4711")
		for (const facts of [
			{ vendor: "0bda", product: "2838", serial: "00000001" },
			{ vendor: "0bda", product: "2838", serial: "SDR4711", serialWeak: true },
			{ vendor: "0bda", serial: "SDR4711" },
		])
			expect(resolveReceiverIdentity("rtl", HEADER, facts).key).toBe(
				"source:rtl|model:5:29",
			)
	})

	it("no valid header and no sdr-host: unknown", () => {
		expect(resolveReceiverIdentity("rtl", null, null).key).toBe("unknown")
		expect(
			resolveReceiverIdentity("rtl", { ...HEADER, magic: "HTTP" }, null)
				.strength,
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
	it("keeps only 32-hex ids and USB strings of 1 to 32 safe characters", () => {
		expect(
			parseSdrHostIdentity({
				unitId: UNIT.toUpperCase(),
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
				unitId: UNIT,
				receiverId: ID,
				dongle: { vendor: "0bda", product: "2838", serial: "a".repeat(32) },
			}),
		).toEqual({
			unitId: UNIT,
			receiverId: ID,
			vendor: "0bda",
			product: "2838",
			serial: "a".repeat(32),
			serialWeak: false,
		})
	})

	it("prefers the USB vid/pid over the descriptive vendor and product strings", () => {
		expect(
			parseSdrHostIdentity({
				dongle: {
					product: "Realtek RTL2838UHIDIR",
					serial: "SDR4711",
					serialWeak: false,
					usb: { vid: "0bda", pid: "2838", bus: 1, device: 4 },
				},
			}),
		).toEqual({
			vendor: "0bda",
			product: "2838",
			serial: "SDR4711",
			serialWeak: false,
		})
	})

	it("a serial is weak when the sdr-host says so or it is a shared default", () => {
		expect(
			parseSdrHostIdentity({ dongle: { serial: "SDR4711", serialWeak: true } })
				.serialWeak,
		).toBe(true)
		for (const serial of ["00000001", "0", "00000000", "1"])
			expect(
				parseSdrHostIdentity({ dongle: { serial, serialWeak: false } })
					.serialWeak,
			).toBe(true)
		// A malformed flag is ignored: the core's own rule decides.
		expect(
			parseSdrHostIdentity({ dongle: { serial: "SDR4711", serialWeak: "no" } })
				.serialWeak,
		).toBe(false)
	})

	it("any non-object body or field type reads as no facts", () => {
		for (const body of [
			null,
			1,
			"x",
			[],
			{ dongle: "x" },
			{ receiverId: 7 },
			{ unitId: 7 },
		])
			expect(parseSdrHostIdentity(body)).toEqual({})
	})
})

describe("isReceiverKey and strengthOfKey", () => {
	it("accepts what resolve builds and refuses anything else", () => {
		expect(isReceiverKey(`unit:${UNIT}`)).toBe(true)
		expect(isReceiverKey("serial:0bda:2838:SDR4711")).toBe(true)
		expect(isReceiverKey("source:rtl|model:5:29")).toBe(true)
		expect(isReceiverKey(`source:~${"a".repeat(32)}|model:5:29`)).toBe(true)
		// Forms of earlier builds: the process-random sdr-host id and the unscoped model.
		expect(isReceiverKey(`sdrhost:${ID}`)).toBe(false)
		expect(isReceiverKey("model:5:29")).toBe(false)
		expect(isReceiverKey("unknown")).toBe(false)
		expect(isReceiverKey("source:rtl|model:5:29/..")).toBe(false)
		expect(isReceiverKey("source:a/b|model:5:29")).toBe(false)
		expect(isReceiverKey(7)).toBe(false)
		expect(strengthOfKey("source:rtl|model:5:29")).toBe("model")
		expect(strengthOfKey(`unit:${UNIT}`)).toBe("unit")
		expect(strengthOfKey("serial:0bda:2838:SDR4711")).toBe("unit")
		expect(strengthOfKey("unknown")).toBe("unknown")
	})
})

describe("pathSegment", () => {
	it("encodes dots so `.` and `..` can never be produced", () => {
		expect(pathSegment(".")).toBe("%2E")
		expect(pathSegment("..")).toBe("%2E%2E")
		expect(pathSegment("a/b")).toBe("a%2Fb")
		expect(pathSegment("source:rtl|model:5:29")).toBe(
			"source%3Artl%7Cmodel%3A5%3A29",
		)
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
	// Validates: receiver identity design 1 (validate every component; encodeURIComponent for paths)
	it("arbitrary sdr-host strings, header values and source ids never leave the namespace dir", () => {
		const root = join(sep, "state", "scanner", "engine", "receivers")
		fc.assert(
			fc.property(
				fc.string({ maxLength: 300 }),
				fc.oneof(fc.string({ maxLength: 64 }), fc.constant(UNIT)),
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
						unitId: receiverId,
						receiverId,
						dongle: { vendor, product, serial },
					})
					const identity = resolveReceiverIdentity(
						sourceId,
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
	// Validates: receiver identity design 1 (one namespace per receiver key)
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
