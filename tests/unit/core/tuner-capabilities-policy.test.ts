import { describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import {
	TunerController,
	TUNER_REST_COMMAND_POLICY,
} from "../../../src/core/tuner-controller.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { prepareReceiverPolicy } from "../../../src/core/tuner-capabilities/rtl-tcp.js"
import { createLogger } from "../../../src/utils/logger.js"

function controller() {
	const transport = {
		assertTunerCommandActive: () => {},
		writeToSource: vi.fn((_id: string, _buffer: Buffer) => true),
		isRtlTcpSource: () => true,
		updateSourceCaps: vi.fn(),
		setTuningCaps: vi.fn(),
	}
	const tuner = new TunerController(
		createLogger({ level: "fatal" }),
		transport as unknown as SourceManager,
	)
	tuner.initializeSource("test", {
		kind: "iq",
		format: "U8_IQ",
		sampleRate: 2400000,
		exclusive: false,
	})
	return { tuner, transport }
}
describe("shared admitted tuner REST policy", () => {
	it("has exactly fifteen deeply immutable rows with independently pinned opcodes/units/rules", () => {
		expect(
			TUNER_REST_COMMAND_POLICY.map(row => [
				row.id,
				row.unit,
				row.opcode,
				row.rule.kind,
			]),
		).toEqual([
			["frequency", "Hz", 1, "integer-range"],
			["sampleRate", "Hz", 2, "integer-ranges"],
			["gainMode", "enum", 3, "enum"],
			["gain", "tenthsDb", 4, "integer-range"],
			["ppm", "ppm", 5, "integer-range"],
			["ifGain", "rawInteger", 6, "integer-range"],
			["testMode", "boolean", 7, "boolean"],
			["agcMode", "boolean", 8, "boolean"],
			["directSampling", "enum", 9, "enum"],
			["offsetTuning", "boolean", 10, "boolean"],
			["rtlXtal", "Hz", 11, "integer-range"],
			["tunerXtal", "Hz", 12, "integer-range"],
			["gainIndex", "index", 13, "integer-range"],
			["biasTee", "boolean", 14, "boolean"],
			["tunerIfGain", "stageRawPair", 15, "uint16-pair"],
		])
		expect(prepareReceiverPolicy(TUNER_REST_COMMAND_POLICY)).not.toBeNull()
		expect(Object.isFrozen(TUNER_REST_COMMAND_POLICY)).toBe(true)
		for (const row of TUNER_REST_COMMAND_POLICY) {
			expect(Object.isFrozen(row)).toBe(true)
			expect(Object.isFrozen(row.rule)).toBe(true)
			if (row.rule.kind === "enum")
				expect(Object.isFrozen(row.rule.values)).toBe(true)
			if (row.rule.kind === "integer-ranges") {
				expect(Object.isFrozen(row.rule.ranges)).toBe(true)
				for (const range of row.rule.ranges)
					expect(Object.isFrozen(range)).toBe(true)
			}
		}
	})
	it.each([
		["frequency", 24000000, 1900000000, 1],
		["gain", 0, 500, 4],
		["ppm", -500, 500, 5],
		["ifGain", 0, 0xffffffff, 6],
		["rtlXtal", 0, 0xffffffff, 11],
		["tunerXtal", 0, 0xffffffff, 12],
		["gainIndex", 0, 0xffffffff, 13],
	] as const)(
		"%s policy agrees with actual numeric setter boundary validation",
		async (id, min, max, opcode) => {
			const { tuner, transport } = controller()
			const setters = {
				frequency: (n: number) => tuner.setFrequency("test", n),
				gain: (n: number) => tuner.setGain("test", n),
				ppm: (n: number) => tuner.setPpm("test", n),
				ifGain: (n: number) => tuner.setIfGain("test", n),
				rtlXtal: (n: number) => tuner.setRtlXtal("test", n),
				tunerXtal: (n: number) => tuner.setTunerXtal("test", n),
				gainIndex: (n: number) => tuner.setTunerGainIndex("test", n),
			}
			expect(TUNER_REST_COMMAND_POLICY[opcode - 1]?.rule).toEqual({
				kind: "integer-range",
				min,
				max,
			})
			for (const value of [min, max]) {
				await setters[id](value)
				expect(
					transport.writeToSource.mock.calls.at(-1)?.[1]?.readUInt8(0),
				).toBe(opcode)
			}
			const count = transport.writeToSource.mock.calls.length
			for (const value of [min - 1, max + 1, min + 0.5, NaN, Infinity])
				await expect(setters[id](value)).rejects.toMatchObject({
					code: "TUNER_VALIDATION_ERROR",
				})
			expect(transport.writeToSource).toHaveBeenCalledTimes(count)
		},
	)
	// Feature: receiver-capabilities, Property 3: Authority separation
	// Validates: Requirements 1.2, 1.5
	it("sample-rate policy matches existing accepted ranges and rejects their gap", async () => {
		const { tuner, transport } = controller()
		expect(TUNER_REST_COMMAND_POLICY[1].rule).toEqual({
			kind: "integer-ranges",
			ranges: [
				{ min: 225001, max: 300000 },
				{ min: 900001, max: 3200000 },
			],
		})
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 225000, max: 3200001 }),
				async value => {
					const allowed =
						(value >= 225001 && value <= 300000) ||
						(value >= 900001 && value <= 3200000)
					const count = transport.writeToSource.mock.calls.length
					if (allowed) {
						await tuner.setSampleRate("test", value)
						expect(transport.writeToSource).toHaveBeenCalledTimes(count + 1)
					} else {
						await expect(
							tuner.setSampleRate("test", value),
						).rejects.toMatchObject({ code: "TUNER_VALIDATION_ERROR" })
						expect(transport.writeToSource).toHaveBeenCalledTimes(count)
					}
				},
			),
			{ numRuns: 100 },
		)
		for (const value of [225001, 300000, 900001, 3200000])
			await tuner.setSampleRate("test", value)
		for (const value of [225000, 300001, 900000, 3200001, 225001.5])
			await expect(tuner.setSampleRate("test", value)).rejects.toMatchObject({
				code: "TUNER_VALIDATION_ERROR",
			})
	})
	it("uint16 pair retains unsigned raw stage/gain boundaries and packed opcode15", async () => {
		const { tuner, transport } = controller()
		for (const stage of [0, 65535])
			for (const gain of [0, 65535]) {
				await tuner.setTunerIfGain("test", stage, gain)
				const bytes = transport.writeToSource.mock.calls.at(-1)?.[1]
				expect(bytes?.readUInt8(0)).toBe(15)
				expect(bytes?.readUInt32BE(1)).toBe(((stage << 16) | gain) >>> 0)
			}
		for (const [stage, gain] of [
			[-1, 0],
			[65536, 0],
			[0, -1],
			[0, 65536],
			[0.5, 1],
			[1, 0.5],
		])
			await expect(
				tuner.setTunerIfGain("test", stage!, gain!),
			).rejects.toMatchObject({ code: "TUNER_VALIDATION_ERROR" })
	})
})
