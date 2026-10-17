// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.3, 9.5
import { describe, expect, it } from "vitest"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import { AcarsdecDecoder } from "../../../src/decoders/builtin/acarsdec.js"
import { AisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import { ReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"
import { DirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"

const DEFAULTS = [136_650_000, 136_700_000, 136_975_000]

function make(options: Record<string, unknown>, top = {}) {
	const config = {
		id: "t",
		type: "dumpvdl2",
		enabled: true,
		...top,
		options,
	} as unknown as DecoderConfig
	return {
		config,
		decoder: new Dumpvdl2Decoder(config, pino({ level: "silent" })),
	}
}

describe("dumpvdl2 band provenance after frequency normalization", () => {
	it("an all-invalid list never gains configured provenance (followCenter)", () => {
		const { decoder } = make({ frequencies: ["garbage"], followCenter: true })
		expect(decoder.getBandDeclaration()).toEqual({})
	})

	it("an all-invalid list is decoder-default without followCenter", () => {
		const { decoder } = make({ frequencies: [Number.NaN, "x"] })
		expect(decoder.getBandDeclaration()).toEqual({
			intrinsic: { targetsHz: DEFAULTS, basis: "decoder-default" },
		})
	})

	it("a mixed list keeps configured provenance with the valid entries only", () => {
		const { decoder } = make({ frequencies: ["garbage", 136_800_000] })
		expect(decoder.getBandDeclaration()).toEqual({
			configured: { targetsHz: [136_800_000], basis: "configured" },
		})
		const follow = make({
			frequencies: ["garbage", 136_800_000],
			followCenter: true,
		})
		expect(follow.decoder.getBandDeclaration()).toEqual({
			configured: {
				targetsHz: [136_800_000],
				basis: "configured",
				followCenter: true,
			},
		})
	})

	it("top-level config.frequencies follows the same rule", () => {
		expect(
			make({}, { frequencies: ["bad"] }).decoder.getBandDeclaration(),
		).toEqual({
			intrinsic: { targetsHz: DEFAULTS, basis: "decoder-default" },
		})
	})

	it("the same holds through an options update", () => {
		const { decoder, config } = make({
			frequencies: [136_800_000],
			followCenter: true,
		})
		expect(decoder.getBandDeclaration().configured?.basis).toBe("configured")
		config.options["frequencies"] = ["garbage"]
		;(decoder as unknown as { onOptionsUpdated(): void }).onOptionsUpdated()
		expect(decoder.getBandDeclaration()).toEqual({})
		config.options["frequencies"] = [Number.NaN, 136_700_000]
		;(decoder as unknown as { onOptionsUpdated(): void }).onOptionsUpdated()
		expect(decoder.getBandDeclaration().configured?.targetsHz).toEqual([
			136_700_000,
		])
	})
})

describe("no option-derived string reaches any log level", () => {
	const MARKER = "MARKER-SECRET-9f3a"
	const cases: [string, new (c: DecoderConfig, l: pino.Logger) => unknown][] = [
		["acarsdec", AcarsdecDecoder],
		["dumpvdl2", Dumpvdl2Decoder],
		["ais-catcher", AisCatcherDecoder],
		["readsb", ReadsbDecoder],
		["direwolf", DirewolfDecoder],
	]
	it.each(cases)("%s construction, update and declarations", (type, Ctor) => {
		const lines: string[] = []
		const logger = pino(
			{ level: "trace" },
			{ write: (l: string) => void lines.push(l) },
		)
		const config = {
			id: "t",
			type,
			enabled: true,
			deviceSerial: MARKER,
			options: {
				rtlTcpHost: MARKER,
				device: MARKER,
				deviceSerial: MARKER,
				spyServerHost: MARKER,
				audioDevice: MARKER,
				callsign: MARKER,
				debugRecordPath: MARKER,
				extraArgs: [MARKER],
				outputFormat: MARKER,
				frequencies: [MARKER, 1e99],
				gain: MARKER,
				ppm: MARKER,
				inputSampleRate: MARKER,
				targetSampleRate: MARKER,
				rtlTcpPort: MARKER,
				outputPort: MARKER,
				kissPort: MARKER,
				agwPort: MARKER,
				sampleRate: MARKER,
			},
		} as unknown as DecoderConfig
		const decoder = new Ctor(config, logger) as Record<string, unknown>
		for (const method of [
			"onOptionsUpdated",
			"getBandDeclaration",
			"getRateRequirements",
		]) {
			try {
				;(decoder[method] as (() => unknown) | undefined)?.call(decoder)
			} catch {
				// Only logging is under test.
			}
		}
		expect(lines.length).toBeGreaterThan(0)
		expect(lines.join("\n")).not.toContain(MARKER)
	})
})
