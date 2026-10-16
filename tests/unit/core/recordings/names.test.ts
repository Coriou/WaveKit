import { describe, expect, it } from "vitest"
import {
	CALL_WAV,
	SCANNER_DISCOVERY_ID,
	SCANNER_RECORDING_ID,
	callNameFields,
	startedAtLocalFromName,
} from "../../../../src/core/recordings/names.js"
import {
	DISCOVERY_ID,
	RECORDING_ID,
} from "../../../../src/core/scanner/store/evidence-store.js"

describe("recording name patterns", () => {
	it("pins the scanner patterns to the evidence store's", () => {
		expect(SCANNER_RECORDING_ID.source).toBe(RECORDING_ID.source)
		expect(SCANNER_RECORDING_ID.flags).toBe(RECORDING_ID.flags)
		expect(SCANNER_DISCOVERY_ID.source).toBe(DISCOVERY_ID.source)
		expect(SCANNER_DISCOVERY_ID.flags).toBe(DISCOVERY_ID.flags)
	})

	it("pins CALL_WAV to the evidence store's (unexported there, literal copy)", () => {
		// Literal copy of CALL_WAV in src/core/scanner/store/evidence-store.ts.
		const evidenceCallWav =
			/^(\d{8})_(\d{6})_\d{5}_.+_(?:GROUP|PRIVATE|UNIT)_TGT_([^_]+)_SRC_([^_.]+)\.wav$/
		expect(CALL_WAV.source).toBe(evidenceCallWav.source)
		expect(CALL_WAV.flags).toBe(evidenceCallWav.flags)
	})

	it("accepts only real calendar date-times", () => {
		expect(startedAtLocalFromName("20261016_123456_00001_x")).toBe(
			"2026-10-16T12:34:56",
		)
		expect(startedAtLocalFromName("20240229_000000_x")).toBe(
			"2024-02-29T00:00:00",
		)
		for (const bad of [
			"20261316_120000_x", // month 13
			"20260230_120000_x", // Feb 30
			"20250229_120000_x", // not a leap year
			"20261016_240000_x", // hour 24
			"20261016_126000_x", // minute 60
			"20261016_120060_x", // second 60
			"20260001_120000_x", // month 0
			"20261000_120000_x", // day 0
			"00001016_120000_x", // year 0
			"2026101_1200000_x",
			"x20261016_120000_",
		])
			expect(startedAtLocalFromName(bad)).toBeNull()
	})

	it("derives call fields from dsd-fme names only", () => {
		expect(
			callNameFields("20261016_120000_01234_1_GROUP_TGT_100_SRC_2001.wav"),
		).toEqual({
			startedAtLocal: "2026-10-16T12:00:00",
			callType: "group",
			talkgroup: "100",
			source: "2001",
		})
		expect(
			callNameFields("20261016_120000_01234_BEE00_PRIVATE_TGT_7_SRC_8.wav")
				.callType,
		).toBe("private")
		expect(
			callNameFields("20261016_120000_01234_1_UNIT_TGT_7_SRC_8.wav").callType,
		).toBe("unit")
		const nonDigits = callNameFields(
			"20261016_120000_01234_1_GROUP_TGT_ab-1_SRC_12345678901.wav",
		)
		expect(nonDigits.talkgroup).toBeNull()
		expect(nonDigits.source).toBeNull()
		expect(nonDigits.callType).toBe("group")
		expect(callNameFields("call-1.wav")).toEqual({
			startedAtLocal: null,
			callType: null,
			talkgroup: null,
			source: null,
		})
		expect(
			callNameFields("20261016_120000_01234_1_OTHER_TGT_1_SRC_2.wav").callType,
		).toBeNull()
	})
})
