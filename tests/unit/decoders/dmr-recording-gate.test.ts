import { describe, expect, it } from "vitest"

import {
	DMR_RECORDING_LINK_ENABLED,
	dsdFmeCallProtocol,
	dsdFmeCallRecordable,
	protocolRecordable,
} from "../../../src/decoders/builtin/call-recordings.js"

describe("DMR recording gate", () => {
	it("is off: DMR recordings are not linked, listed or written", () => {
		expect(DMR_RECORDING_LINK_ENABLED).toBe(false)
	})

	it.each([
		"p25",
		"P25",
		"p25p1",
		"p25p2",
		"nxdn",
		"NXDN",
		"nxdn48",
		"nxdn96",
		"ysf",
		"YSF",
		"dstar",
		"DSTAR",
		"D-STAR",
		"d-star",
		"dpmr",
		"dPMR",
		"DPMR",
		"provoice",
		"edacs",
		"m17",
	])("admits the non-DMR label %s", label => {
		expect(protocolRecordable(label)).toBe(true)
	})

	it.each([
		"dmr",
		"DMR",
		" Dmr ",
		"Tier III",
		"TRBO",
		"DMR BS",
		"dmr_bs",
		"MotoTRBO",
		"dmr-tier3",
		"dmrplus",
		"",
		"analog",
		"unknown",
		"p25x",
	])("refuses %j while the flag is off", label => {
		expect(protocolRecordable(label)).toBe(false)
	})

	it("refuses an unknown (null) protocol", () => {
		expect(protocolRecordable(null)).toBe(false)
	})

	it("reads the system prefix dsd-fme writes into its call file names", () => {
		const at = "20261016_120000_01234"
		expect(dsdFmeCallProtocol(`${at}_DMR_CC_1_GROUP_TGT_9_SRC_2.wav`)).toBe(
			"DMR",
		)
		expect(dsdFmeCallProtocol(`${at}_P25_1A3_GROUP_TGT_9_SRC_2.wav`)).toBe(
			"P25",
		)
		expect(dsdFmeCallProtocol(`${at}_NXDN_RAN_1_PRIVATE_TGT_9_SRC_2.wav`)).toBe(
			"NXDN",
		)
		expect(dsdFmeCallProtocol(`${at}_YSF_GROUP_TGT_A_SRC_B.wav`)).toBe("YSF")
		expect(dsdFmeCallProtocol(`${at}__GROUP_TGT_9_SRC_2.wav`)).toBeNull()
		expect(dsdFmeCallProtocol("TEMP_20261016_120000_0A1B.wav")).toBeNull()
	})

	it("admits a dsd-fme call file only when its name says a recordable protocol without a positive clear rule", () => {
		const at = "20261016_120000_01234"
		expect(dsdFmeCallRecordable(`${at}_DMR_CC_1_GROUP_TGT_9_SRC_2.wav`)).toBe(
			false,
		)
		expect(dsdFmeCallRecordable(`${at}_DMR_GROUP_TGT_9_SRC_2.wav`)).toBe(false)
		expect(dsdFmeCallRecordable(`${at}__GROUP_TGT_9_SRC_2.wav`)).toBe(false)
		expect(dsdFmeCallRecordable(`${at}_1_GROUP_TGT_9_SRC_2.wav`)).toBe(false)
		expect(dsdFmeCallRecordable(`${at}_TRBO_GROUP_TGT_9_SRC_2.wav`)).toBe(false)
		// A P25, NXDN, dPMR or ProVoice (EDACS) call is clear only on its own print, which its
		// file does not carry: never listed, served or linked.
		for (const system of [
			"P25_1A3",
			"P25_CC_1A3",
			"NXDN_RAN_1",
			"NXDN48_RAN_1",
			"DPMR_CC_0",
			"EDACS_1",
			"PROVOICE_1",
		])
			expect(
				dsdFmeCallRecordable(`${at}_${system}_GROUP_TGT_9_SRC_2.wav`),
				system,
			).toBe(false)
		expect(dsdFmeCallRecordable(`${at}_DSTAR_GROUP_TGT_A_SRC_B.wav`)).toBe(true)
		expect(dsdFmeCallRecordable(`${at}_YSF_GROUP_TGT_A_SRC_B.wav`)).toBe(true)
		expect(dsdFmeCallRecordable(`${at}_M17_GROUP_TGT_A_SRC_B.wav`)).toBe(true)
	})
})
