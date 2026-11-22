import fc from "fast-check"
import { RECORDING_INVENTORY_ID } from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import {
	DV_NAME_DECODER_MAX,
	DV_NAME_MAX,
	DV_NAME_SOURCE_MAX,
	DV_NAME_TALKGROUP_MAX,
	DV_TEMP_WAV,
	dvCallFileName,
	dvTempFileName,
	sanitizeNameField,
	type DvCallNameInfo,
} from "../../../../src/core/dv-recorder/names.js"
import { dsdFmeKeepKey } from "../../../../src/core/recordings/contract.js"
import {
	CALL_WAV,
	callNameFields,
	dvCallDecoderField,
	dvCallDecoderOf,
	dvCallNameField,
} from "../../../../src/core/recordings/names.js"
import {
	DSD_FME_CALL_WAV,
	DSD_FME_TEMP_WAV,
} from "../../../../src/decoders/builtin/call-recordings.js"
import { RECORDINGS_ID_MAX_LENGTH } from "../../../../src/core/recordings/inventory.js"

const T0 = 1_700_000_000_000

describe("dv recorder names", () => {
	it("sanitizes a field to [A-Za-z0-9-], collapsing runs", () => {
		expect(sanitizeNameField("DL1ABC/P", 15, "0")).toBe("DL1ABC-P")
		expect(sanitizeNameField("a__b..c  d", 15, "0")).toBe("a-b-c-d")
		expect(sanitizeNameField("--x--", 15, "0")).toBe("x")
		expect(sanitizeNameField("///", 15, "0")).toBe("0")
		expect(sanitizeNameField(null, 15, "0")).toBe("0")
		expect(sanitizeNameField("abcdef", 3, "0")).toBe("abc")
		expect(sanitizeNameField("abcdef", 3, "0", true)).toBe("def")
		expect(sanitizeNameField("ab-cdef", 3, "0")).toBe("ab")
	})

	it("the TEMP name is the recorder's own, never dsd-fme's or a listed call", () => {
		const t = dvTempFileName(T0, 0xabcd)
		expect(DV_TEMP_WAV.test(t)).toBe(true)
		expect(t.endsWith("_ABCD.wav")).toBe(true)
		expect(DSD_FME_TEMP_WAV.test(t)).toBe(false)
		expect(DSD_FME_CALL_WAV.test(t)).toBe(false)
		expect(DV_TEMP_WAV.test(dvTempFileName(T0, 0x1_0005))).toBe(true)
	})

	it("an unknown call is GROUP with talkgroup and source 0", () => {
		const n = dvCallFileName(T0, 42, "dsd-fme", null)
		expect(n).toMatch(/^\d{8}_\d{6}_00042_dsd-fme_GROUP_TGT_0_SRC_0\.wav$/)
	})

	it("the longest name is 91 characters and its id 100 at n = 9 999", () => {
		const long = "x".repeat(200)
		const n = dvCallFileName(T0, 99_999, "x".repeat(DV_NAME_DECODER_MAX), {
			callType: "private",
			talkgroup: long,
			source: long,
		})
		expect(n.length).toBe(DV_NAME_MAX)
		expect(DV_NAME_MAX).toBe(
			44 + DV_NAME_DECODER_MAX + DV_NAME_TALKGROUP_MAX + DV_NAME_SOURCE_MAX,
		)
		const id = `dsd:9999~${n}`
		expect(id.length).toBe(RECORDINGS_ID_MAX_LENGTH)
		expect(RECORDING_INVENTORY_ID.test(id)).toBe(true)
	})

	// Feature: dv-call-recorder, Property 1: every final name keeps dsd-fme's shape
	// Validates: Requirements Table A names (sanitizing, caps, dsd~ key grammar)
	it("every name is in dsd-fme's shape, listable and keyable, for any field text", () => {
		const text = fc.oneof(
			fc.string({ maxLength: 80 }),
			fc.string({ unit: "grapheme", maxLength: 40 }),
			fc.constantFrom("", "_", "..", "/", " ", "TGT_1_SRC_2", "a_b.c d/e"),
		)
		const info: fc.Arbitrary<DvCallNameInfo | null> = fc.option(
			fc.record({
				callType: fc.constantFrom("group", "private", "unit", null),
				talkgroup: fc.option(text),
				source: fc.option(text),
			}),
		)
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 4_102_444_800_000 }),
				fc.integer({ min: -1_000_000, max: 1_000_000 }),
				text,
				info,
				(ms, rand, decoderId, inf) => {
					const n = dvCallFileName(ms, rand, decoderId, inf)
					expect(n.length).toBeLessThanOrEqual(DV_NAME_MAX)
					expect(DSD_FME_CALL_WAV.test(n)).toBe(true)
					expect(CALL_WAV.test(n)).toBe(true)
					expect(dsdFmeKeepKey(n)).not.toBeNull()
					expect(RECORDING_INVENTORY_ID.test(`dsd:9999~${n}`)).toBe(true)
					expect(DV_TEMP_WAV.test(n)).toBe(false)
					const parts = n.slice(0, -4).split("_")
					expect(parts).toHaveLength(9)
					for (const p of parts) expect(p).toMatch(/^[A-Za-z0-9-]+$/)
					expect(dvCallDecoderField(n)).toBe(dvCallNameField(decoderId))
					expect(dvCallDecoderOf(dvCallDecoderField(n), [decoderId])).toBe(
						decoderId,
					)
					const fields = callNameFields(n)
					expect(fields.callType).toBe(inf?.callType ?? "group")
				},
			),
			{ numRuns: 300 },
		)
	})

	it("the decoder field is the id itself up to 18 [A-Za-z0-9-] characters, else h + 8 base36", () => {
		expect(dvCallNameField("dmr-a")).toBe("dmr-a")
		expect(dvCallNameField("x".repeat(18))).toBe("x".repeat(18))
		const past = dvCallNameField("x".repeat(19))
		expect(past).toMatch(/^h[0-9a-z]{8}$/)
		expect(dvCallNameField("dmr.a")).toMatch(/^h[0-9a-z]{8}$/)
		expect(dvCallNameField("")).toMatch(/^h[0-9a-z]{8}$/)
		// Stable: the same id gives the same field (a pinned value).
		expect(dvCallNameField("x".repeat(19))).toBe(past)
		expect(dvCallNameField("scan-abcdefg-dsdfme-12")).toBe(
			dvCallNameField("scan-abcdefg-dsdfme-12"),
		)
	})

	it("repro: two probe ids sharing an 18-character head get distinct fields and map back", () => {
		const ids = ["scan-abcdefg-dsdfme-12", "scan-abcdefg-dsdfme-13"]
		const [a, b] = ids.map(dvCallNameField)
		expect(a).not.toBe(b)
		for (const id of ids) {
			const n = dvCallFileName(T0, 1, id, null)
			expect(dvCallDecoderOf(dvCallDecoderField(n), ids)).toBe(id)
		}
	})

	it("repro: dmr.a and dmr-a map to their own ids", () => {
		const ids = ["dmr.a", "dmr-a"]
		for (const id of ids) {
			const n = dvCallFileName(T0, 1, id, null)
			expect(dvCallDecoderOf(dvCallDecoderField(n), ids)).toBe(id)
		}
	})

	it("an unknown or ambiguous field maps to no decoder", () => {
		expect(dvCallDecoderOf("dmr-a", ["dmr-b"])).toBeNull()
		expect(dvCallDecoderOf(null, ["dmr-a"])).toBeNull()
		expect(dvCallDecoderOf("dmr-a", [])).toBeNull()
		// A literal id equal to another id's hashed field: two ids, one field.
		const hashed = dvCallNameField("dmr.a")
		expect(dvCallDecoderOf(hashed, ["dmr.a", hashed])).toBeNull()
		// Duplicates of one id are not ambiguity.
		expect(dvCallDecoderOf("dmr-a", ["dmr-a", "dmr-a"])).toBe("dmr-a")
	})
})
